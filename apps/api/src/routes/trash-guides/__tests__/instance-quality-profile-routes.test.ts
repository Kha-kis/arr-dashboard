import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
} from "../../../lib/trash-guides/deployment-target.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import registerInstanceQualityProfileRoutes from "../instance-quality-profile-routes.js";

const userId = "user-1";
const instance = {
	id: "instance-1",
	userId,
	service: "RADARR",
	baseUrl: "http://radarr:7878",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 2,
};

describe("instance quality profile score writes", () => {
	let app: FastifyInstance;
	const updateProfile = vi.fn();
	const findServiceInstances = vi.fn();
	const upsertOverride = vi.fn();
	const updateOverrides = vi.fn();
	const getProfile = vi.fn();
	const findMappings = vi.fn();
	const findOverrides = vi.fn();
	const deleteOverrides = vi.fn();
	const getCustomFormats = vi.fn();

	beforeEach(async () => {
		vi.resetAllMocks();
		const beforeProfile = {
			id: 4,
			name: "Any",
			formatItems: [{ format: 7, score: 100 }],
		};
		const afterProfile = {
			...beforeProfile,
			formatItems: [{ format: 7, score: -10000 }],
		};
		getProfile
			.mockReset()
			.mockResolvedValueOnce(beforeProfile)
			.mockResolvedValueOnce(beforeProfile)
			.mockResolvedValueOnce(beforeProfile)
			.mockResolvedValueOnce(afterProfile);
		const transactionClient = {
			instanceQualityProfileOverride: { updateMany: updateOverrides },
		};
		const prisma = {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: findServiceInstances.mockResolvedValue([instance]),
			},
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue({ templateId: "template-1" }),
				findMany: findMappings.mockResolvedValue([
					{
						templateId: "template-1",
						instanceId: instance.id,
						qualityProfileId: 4,
						connectionGeneration: instance.connectionGeneration,
						connectionStateToken: createDeploymentConnectionStateToken(instance),
						managedCustomFormatsCaptured: true,
						managedCustomFormats: JSON.stringify([
							{
								trashId: "trash-7",
								name: "Reject",
								resourceId: 7,
								stateToken: "state-token",
								profileId: 4,
								appliedScore: 100,
							},
						]),
						template: {
							configData: JSON.stringify({
								customFormats: [{ trashId: "trash-7", scoreOverride: 100 }],
							}),
						},
					},
				]),
			},
			instanceQualityProfileOverride: {
				upsert: upsertOverride.mockResolvedValue({}),
				updateMany: updateOverrides.mockResolvedValue({ count: 1 }),
				findMany: findOverrides.mockImplementation(async ({ select }) =>
					select
						? []
						: [
								{
									id: "override-1",
									updatedAt: new Date("2026-01-01"),
									qualityProfileId: 4,
									customFormatId: 7,
									status: "APPLIED",
								},
							],
				),
				deleteMany: deleteOverrides.mockResolvedValue({ count: 1 }),
			},
			$transaction: vi.fn(
				async (work: Array<Promise<unknown>> | ((client: typeof transactionClient) => unknown)) =>
					typeof work === "function" ? work(transactionClient) : Promise.all(work),
			),
		};
		const client = {
			qualityProfile: {
				getById: getProfile,
				update: updateProfile.mockResolvedValue(undefined),
			},
			customFormat: {
				getAll: getCustomFormats.mockResolvedValue([{ id: 7, name: "Reject" }]),
			},
		};

		app = Fastify({ logger: false });
		setupAuthInjection(app, { id: userId, username: "admin" });
		registerTestErrorHandler(app);
		app.decorate("prisma", prisma as never);
		app.decorate("arrClientFactory", {
			create: vi.fn().mockReturnValue(client),
			createConnectionCredentialIdentity: vi.fn().mockReturnValue("credentials"),
		} as never);
		app.decorate("deploymentExecutor", {
			runWithEndpointMutation: vi.fn(async (_userId, target, _operation, callback) =>
				callback(createDeploymentEndpointKey(userId, target)),
			),
		} as never);
		await app.register(registerInstanceQualityProfileRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	it("durably saves the score intent before the drift-checked upstream PUT", async () => {
		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: true, isTemplateManaged: true });
		expect(upsertOverride).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					score: -10000,
					status: "PENDING",
					connectionStateToken: createDeploymentConnectionStateToken(instance),
				}),
				update: expect.objectContaining({ status: "PENDING" }),
			}),
		);
		expect(upsertOverride.mock.invocationCallOrder[0]).toBeLessThan(
			updateProfile.mock.invocationCallOrder[0]!,
		);
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "APPLIED" }),
			}),
		);
	});

	it("retains the durable intent when the upstream PUT result is uncertain", async () => {
		updateProfile.mockRejectedValueOnce(new Error("request timed out"));

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode).toBe(500);
		expect(upsertOverride).toHaveBeenCalledOnce();
		expect(upsertOverride.mock.invocationCallOrder[0]).toBeLessThan(
			updateProfile.mock.invocationCallOrder[0]!,
		);
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({ data: { status: "UNCERTAIN" } }),
		);
	});

	it("verifies the reset upstream before deleting the saved override", async () => {
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: -10000 }] };
		const after = { ...before, formatItems: [{ format: 7, score: 100 }] };
		getProfile
			.mockReset()
			.mockResolvedValueOnce(before)
			.mockResolvedValueOnce(before)
			.mockResolvedValue(after);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: true, revertedScore: 100 });
		expect(updateProfile).toHaveBeenCalledWith(
			4,
			expect.objectContaining({ formatItems: [{ format: 7, score: 100 }] }),
		);
		expect(updateOverrides).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PENDING",
					intentOperation: "RESET_SCORE",
					intendedScore: 100,
				}),
			}),
		);
		expect(updateOverrides.mock.invocationCallOrder[0]).toBeLessThan(
			updateProfile.mock.invocationCallOrder[0]!,
		);
		expect(updateProfile.mock.invocationCallOrder[0]).toBeLessThan(
			deleteOverrides.mock.invocationCallOrder[0]!,
		);
	});

	it("retains an uncertain reset intent when the upstream PUT times out", async () => {
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: -10000 }] };
		getProfile.mockReset().mockResolvedValue(before);
		updateProfile.mockRejectedValueOnce(new Error("request timed out"));

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(500);
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({ data: { status: "UNCERTAIN" } }),
		);
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("exposes an uncertain score intent after reload with an exact retry action", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-1",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "UNCERTAIN",
				intentOperation: "RESET_SCORE",
				intendedScore: 100,
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			overrides: [],
			recoveryIntents: [
				{
					customFormatId: 7,
					operation: "RESET_SCORE",
					intendedScore: 100,
					status: "UNCERTAIN",
					retryAction: { method: "DELETE" },
				},
			],
		});
	});

	it("includes uncertain intents in the bulk score reload response", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "UNCERTAIN",
				intentOperation: "SET_SCORE",
				intendedScore: -10000,
				updatedAt: new Date("2026-01-01"),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/bulk-overrides",
			{ body: { profileIds: [4] } },
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			totalOverrides: 0,
			overridesByProfile: {},
			recoveryIntents: [
				{
					qualityProfileId: 4,
					customFormatId: 7,
					operation: "SET_SCORE",
					intendedScore: -10000,
					retryable: true,
				},
			],
		});
	});

	it("shows an uncertain intent saved through an equivalent service alias", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides.mockResolvedValueOnce([
			{
				id: "alias-override",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "UNCERTAIN",
				intentOperation: "SET_SCORE",
				intendedScore: -10000,
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json().recoveryIntents).toEqual([
			expect.objectContaining({ customFormatId: 7, operation: "SET_SCORE" }),
		]);
		expect(findOverrides).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({ instanceId: { in: [instance.id, alias.id] } }),
					]),
				}),
			}),
		);
	});

	it("completes the original uncertain intent when retried through an equivalent alias", async () => {
		const alias = { ...instance, id: "instance-alias" };
		const uncertainIntent = {
			id: "alias-override",
			updatedAt: new Date("2026-01-01"),
			qualityProfileId: 4,
			customFormatId: 7,
			intentOperation: "SET_SCORE",
			intendedScore: -10000,
		};
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides
			.mockReset()
			.mockResolvedValueOnce([uncertainIntent])
			.mockResolvedValueOnce([uncertainIntent]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode).toBe(200);
		expect(upsertOverride).not.toHaveBeenCalled();
		expect(updateOverrides).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "alias-override" }),
				data: expect.objectContaining({
					instanceId: instance.id,
					status: "PENDING",
					connectionGeneration: instance.connectionGeneration,
					connectionStateToken: createDeploymentConnectionStateToken(instance),
				}),
			}),
		);
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ instanceId: { in: [instance.id, alias.id] } }),
				data: expect.objectContaining({ status: "APPLIED" }),
			}),
		);
	});

	it("fails closed before the upstream PUT when an alias retry cannot be rebound", async () => {
		const alias = { ...instance, id: "instance-alias" };
		const uncertainIntent = {
			id: "alias-override",
			updatedAt: new Date("2026-01-01"),
			qualityProfileId: 4,
			customFormatId: 7,
			intentOperation: "SET_SCORE",
			intendedScore: -10000,
		};
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides
			.mockReset()
			.mockResolvedValueOnce([uncertainIntent])
			.mockResolvedValueOnce([uncertainIntent]);
		updateOverrides.mockRejectedValueOnce(new Error("unique constraint"));

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("could not be rebound");
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("rolls back the alias rebind batch when one of multiple retry intents changed", async () => {
		const alias = { ...instance, id: "instance-alias" };
		const uncertainIntents = [
			{
				id: "alias-override-7",
				updatedAt: new Date("2026-01-01"),
				qualityProfileId: 4,
				customFormatId: 7,
				intentOperation: "SET_SCORE",
				intendedScore: -10000,
			},
			{
				id: "alias-override-8",
				updatedAt: new Date("2026-01-01"),
				qualityProfileId: 4,
				customFormatId: 8,
				intentOperation: "SET_SCORE",
				intendedScore: 50,
			},
		];
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides
			.mockReset()
			.mockResolvedValueOnce(uncertainIntents)
			.mockResolvedValueOnce(uncertainIntents);
		getCustomFormats.mockResolvedValueOnce([
			{ id: 7, name: "Reject" },
			{ id: 8, name: "Prefer" },
		]);
		updateOverrides.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{
				body: {
					scoreUpdates: [
						{ customFormatId: 7, score: -10000 },
						{ customFormatId: 8, score: 50 },
					],
				},
			},
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("changed while it was being resumed");
		expect(updateOverrides).toHaveBeenCalledTimes(2);
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("retries the exact uncertain reset idempotently and clears its durable intent", async () => {
		const resetProfile = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		getProfile.mockReset().mockResolvedValue(resetProfile);
		findOverrides.mockImplementation(async ({ select }) =>
			select
				? [
						{
							qualityProfileId: 4,
							customFormatId: 7,
							intentOperation: "RESET_SCORE",
							intendedScore: 100,
						},
					]
				: [
						{
							id: "override-1",
							updatedAt: new Date("2026-01-01"),
							customFormatId: 7,
							status: "UNCERTAIN",
						},
					],
		);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(200);
		expect(updateProfile).toHaveBeenCalledOnce();
		expect(deleteOverrides).toHaveBeenCalledOnce();
	});

	it("leaves the reset intent pending when database cleanup fails after ARR succeeds", async () => {
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: -10000 }] };
		const after = { ...before, formatItems: [{ format: 7, score: 100 }] };
		getProfile
			.mockReset()
			.mockResolvedValueOnce(before)
			.mockResolvedValueOnce(before)
			.mockResolvedValue(after);
		deleteOverrides.mockRejectedValueOnce(new Error("database unavailable"));

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(500);
		expect(updateOverrides).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "PENDING" }) }),
		);
		expect(updateOverrides).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: "UNCERTAIN" } }),
		);
	});

	it("retains the saved override when ARR does not reflect the reset", async () => {
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: -10000 }] };
		getProfile.mockReset().mockResolvedValue(before);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(deleteOverrides).not.toHaveBeenCalled();
	});
});
