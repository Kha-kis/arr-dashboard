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
	const findTransactionOverrides = vi.fn();
	const deleteAliasOverrides = vi.fn();
	const countTransactionOverrides = vi.fn();
	const updateTemplate = vi.fn();
	const findTransactionInstance = vi.fn();
	const findTransactionMappings = vi.fn();
	const runTransaction = vi.fn();
	const runWithEndpointMutation = vi.fn();

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
			serviceInstance: {
				findFirst: findTransactionInstance,
			},
			templateQualityProfileMapping: {
				findMany: findTransactionMappings,
			},
			instanceQualityProfileOverride: {
				findMany: findTransactionOverrides.mockResolvedValue([]),
				deleteMany: deleteAliasOverrides.mockResolvedValue({ count: 0 }),
				count: countTransactionOverrides.mockResolvedValue(0),
				updateMany: updateOverrides,
				upsert: upsertOverride,
			},
			trashTemplate: {
				updateMany: updateTemplate.mockResolvedValue({ count: 1 }),
			},
		};
		const template = {
			id: "template-1",
			userId,
			updatedAt: new Date("2026-01-01"),
			configData: JSON.stringify({
				customFormats: [
					{
						trashId: "trash-7",
						name: "Reject",
						scoreOverride: 100,
						originalConfig: { _instanceCFId: 7 },
					},
				],
			}),
		};
		const mapping = {
			id: "mapping-1",
			updatedAt: new Date("2026-01-01"),
			templateId: template.id,
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
			template,
		};
		findTransactionInstance.mockResolvedValue(instance);
		findTransactionMappings.mockResolvedValue([mapping]);
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: findServiceInstances.mockResolvedValue([instance]),
			},
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: {
				findMany: findMappings.mockResolvedValue([mapping]),
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
			$transaction: runTransaction.mockImplementation(
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
			runWithEndpointMutation: runWithEndpointMutation.mockImplementation(
				async (_userId, target, _operation, callback) =>
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

	it("removes the recovery intent after a verified unmanaged profile update", async () => {
		findMappings.mockResolvedValueOnce([]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(deleteOverrides).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					qualityProfileId: 4,
					status: "PENDING",
					OR: [
						expect.objectContaining({
							customFormatId: 7,
							intentOperation: "SET_SCORE",
							intendedScore: -10000,
						}),
					],
				}),
			}),
		);
		expect(updateOverrides).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) }),
		);
	});

	it("keeps a durable override when the current template mapping belongs to an equivalent alias", async () => {
		const mappedAlias = {
			...instance,
			id: "instance-alias",
			encryptedApiKey: "other-encrypted-key",
			encryptionIv: "other-iv",
		};
		findServiceInstances.mockResolvedValueOnce([instance, mappedAlias]);
		findMappings.mockResolvedValueOnce([
			{
				templateId: "template-1",
				instanceId: mappedAlias.id,
				qualityProfileId: 4,
				connectionGeneration: mappedAlias.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(mappedAlias),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().isTemplateManaged).toBe(true);
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "APPLIED" }) }),
		);
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("rejects duplicate Custom Format score updates before any mutation", async () => {
		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{
				body: {
					scoreUpdates: [
						{ customFormatId: 7, score: 100 },
						{ customFormatId: 7, score: -10_000 },
					],
				},
			},
		);

		expect(response.statusCode).toBe(400);
		expect(updateProfile).not.toHaveBeenCalled();
		expect(upsertOverride).not.toHaveBeenCalled();
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

	it("atomically replaces an applied override from an equivalent alias", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findTransactionOverrides.mockResolvedValueOnce([
			{
				id: "alias-applied",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				status: "APPLIED",
			},
		]);
		deleteAliasOverrides.mockResolvedValueOnce({ count: 1 });

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode).toBe(200);
		expect(deleteAliasOverrides).toHaveBeenCalledWith({
			where: {
				id: { in: ["alias-applied"] },
				status: "APPLIED",
				userId,
			},
		});
		expect(upsertOverride).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					instanceId_qualityProfileId_customFormatId: {
						instanceId: instance.id,
						qualityProfileId: 4,
						customFormatId: 7,
					},
				},
				update: expect.objectContaining({ status: "PENDING", score: -10000 }),
			}),
		);
		expect(deleteAliasOverrides.mock.invocationCallOrder[0]).toBeLessThan(
			updateProfile.mock.invocationCallOrder[0]!,
		);
	});

	it("fails closed if an equivalent override becomes uncertain during replacement", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findTransactionOverrides.mockResolvedValueOnce([
			{
				id: "alias-uncertain",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				status: "UNCERTAIN",
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("changed while the score intent was being saved");
		expect(deleteAliasOverrides).not.toHaveBeenCalled();
		expect(upsertOverride).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("fails closed when an applied alias changes before its transactional delete", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findTransactionOverrides.mockResolvedValueOnce([
			{
				id: "alias-applied",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				status: "APPLIED",
			},
		]);
		deleteAliasOverrides.mockResolvedValueOnce({ count: 0 });

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("changed before it could be replaced");
		expect(upsertOverride).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
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

	it("resets to the template quality profile score set", async () => {
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: -10000 }] };
		const after = { ...before, formatItems: [{ format: 7, score: 50 }] };
		getProfile
			.mockReset()
			.mockResolvedValueOnce(before)
			.mockResolvedValueOnce(before)
			.mockResolvedValue(after);
		findMappings.mockResolvedValueOnce([
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
						qualityProfile: { trash_score_set: "sqp-1-1080p" },
						customFormats: [
							{
								trashId: "trash-7",
								originalConfig: {
									trash_scores: { default: 100, "sqp-1-1080p": 50 },
								},
							},
						],
					}),
				},
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ revertedScore: 50 });
		expect(updateProfile).toHaveBeenCalledWith(
			4,
			expect.objectContaining({ formatItems: [{ format: 7, score: 50 }] }),
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

	it("includes and deduplicates applied overrides from equivalent aliases in bulk reloads", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides.mockResolvedValueOnce([
			{
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
				updatedAt: new Date("2026-01-02"),
			},
			{
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
				updatedAt: new Date("2026-01-01"),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/bulk-overrides",
			{ body: { profileIds: [4] } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toMatchObject({
			totalOverrides: 1,
			overridesByProfile: { 4: [{ customFormatId: 7, score: -10000 }] },
		});
	});

	it("fails closed when equivalent aliases have conflicting applied scores", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides.mockResolvedValueOnce([
			{
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 100,
				status: "APPLIED",
			},
			{
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("conflicting saved score overrides");
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
						expect.objectContaining({
							status: { in: ["PENDING", "UNCERTAIN"] },
							instanceId: { in: [instance.id, alias.id] },
						}),
					]),
				}),
			}),
		);
	});

	it("shows an applied override saved through an equivalent service alias", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides.mockResolvedValueOnce([
			{
				id: "alias-override",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
				intentOperation: null,
				intendedScore: null,
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().overrides).toEqual([
			expect.objectContaining({ id: "alias-override", score: -10000 }),
		]);
		expect(findOverrides).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({
							status: "APPLIED",
							OR: expect.arrayContaining([
								expect.objectContaining({
									instanceId: alias.id,
									connectionGeneration: alias.connectionGeneration,
									connectionStateToken: createDeploymentConnectionStateToken(alias),
								}),
							]),
						}),
					]),
				}),
			}),
		);
	});

	it("reads applied alias overrides only through the alias's current connection binding", async () => {
		const staleAlias = {
			...instance,
			id: "instance-alias",
			encryptedApiKey: "stale-encrypted-key",
			connectionGeneration: 1,
		};
		const currentAlias = {
			...staleAlias,
			encryptedApiKey: "current-encrypted-key",
			connectionGeneration: 2,
		};
		findServiceInstances.mockResolvedValueOnce([instance, currentAlias]);
		findOverrides.mockResolvedValueOnce([]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode, response.body).toBe(200);
		const query = findOverrides.mock.calls[0]![0];
		expect(query).toEqual(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({
							status: "APPLIED",
							OR: expect.arrayContaining([
								expect.objectContaining({
									instanceId: currentAlias.id,
									connectionGeneration: currentAlias.connectionGeneration,
									connectionStateToken: createDeploymentConnectionStateToken(currentAlias),
								}),
							]),
						}),
					]),
				}),
			}),
		);
		expect(JSON.stringify(query)).not.toContain(createDeploymentConnectionStateToken(staleAlias));
	});

	it("promotes the exact reviewed override while holding the endpoint mutation lock", async () => {
		const updatedAt = new Date("2026-01-02");
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-1",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
				updatedAt,
			},
		]);
		deleteAliasOverrides.mockResolvedValueOnce({ count: 1 });

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/promote-override",
			{ body: { customFormatId: 7, templateId: "template-1" } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(runWithEndpointMutation).toHaveBeenCalledWith(
			userId,
			expect.objectContaining({ id: instance.id }),
			"Score override promotion",
			expect.any(Function),
		);
		expect(deleteAliasOverrides).toHaveBeenCalledWith({
			where: {
				userId,
				status: "APPLIED",
				OR: [{ id: "override-1", updatedAt }],
			},
		});
		expect(updateTemplate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "template-1", userId }),
				data: expect.objectContaining({
					configData: expect.stringContaining('"scoreOverride":-10000'),
				}),
			}),
		);
	});

	it("does not promote when the reviewed override changes before the transaction", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-1",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
				updatedAt: new Date("2026-01-02"),
			},
		]);
		deleteAliasOverrides.mockResolvedValueOnce({ count: 0 });

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/promote-override",
			{ body: { customFormatId: 7, templateId: "template-1" } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("changed while it was being promoted");
		expect(updateTemplate).not.toHaveBeenCalled();
	});

	it("does not promote an applied score while an equivalent alias has unresolved intent", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-applied",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 100,
				status: "APPLIED",
				intentOperation: null,
				intendedScore: null,
				updatedAt: new Date("2026-01-01"),
			},
			{
				id: "override-uncertain",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 100,
				status: "UNCERTAIN",
				intentOperation: "SET_SCORE",
				intendedScore: -10000,
				updatedAt: new Date("2026-01-02"),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/promote-override",
			{ body: { customFormatId: 7, templateId: "template-1" } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("unresolved upstream result");
		expect(runTransaction).not.toHaveBeenCalled();
		expect(updateTemplate).not.toHaveBeenCalled();
	});

	it("rolls back promotion when the equivalent override set changes in the transaction", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-1",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
				updatedAt: new Date("2026-01-02"),
			},
		]);
		deleteAliasOverrides.mockResolvedValueOnce({ count: 1 });
		countTransactionOverrides.mockResolvedValueOnce(1);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/promote-override",
			{ body: { customFormatId: 7, templateId: "template-1" } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("override set changed");
		expect(updateTemplate).not.toHaveBeenCalled();
	});

	it("rolls back promotion when the ARR connection rotates inside the transaction", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-1",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
				updatedAt: new Date("2026-01-02"),
			},
		]);
		findTransactionInstance.mockResolvedValueOnce({
			...instance,
			encryptedApiKey: "rotated-key",
			connectionGeneration: instance.connectionGeneration + 1,
		});

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/promote-override",
			{ body: { customFormatId: 7, templateId: "template-1" } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("service connection changed");
		expect(deleteAliasOverrides).not.toHaveBeenCalled();
		expect(updateTemplate).not.toHaveBeenCalled();
	});

	it("rolls back promotion when its template mapping is unlinked in the transaction", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-1",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10000,
				status: "APPLIED",
				updatedAt: new Date("2026-01-02"),
			},
		]);
		findTransactionMappings.mockResolvedValueOnce([]);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/promote-override",
			{ body: { customFormatId: 7, templateId: "template-1" } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("template mapping changed");
		expect(deleteAliasOverrides).not.toHaveBeenCalled();
		expect(updateTemplate).not.toHaveBeenCalled();
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
		expect(runTransaction.mock.calls.some(([work]) => typeof work === "function")).toBe(true);
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("retries the exact uncertain reset idempotently and clears its durable intent", async () => {
		const resetProfile = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		getProfile.mockReset().mockResolvedValue(resetProfile);
		findOverrides.mockImplementation(async ({ select }) =>
			select
				? [
						{
							id: "override-1",
							instanceId: instance.id,
							connectionGeneration: instance.connectionGeneration,
							connectionStateToken: createDeploymentConnectionStateToken(instance),
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

	it("retries an uncertain reset from its persisted score after the template changes", async () => {
		const resetProfile = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		getProfile.mockReset().mockResolvedValue(resetProfile);
		findMappings.mockResolvedValueOnce([
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
						customFormats: [{ trashId: "trash-7", scoreOverride: 200 }],
					}),
				},
			},
		]);
		findOverrides.mockImplementation(async ({ select }) =>
			select
				? [
						{
							id: "override-1",
							instanceId: instance.id,
							connectionGeneration: instance.connectionGeneration,
							connectionStateToken: createDeploymentConnectionStateToken(instance),
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
							intentOperation: "RESET_SCORE",
							intendedScore: 100,
						},
					],
		);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(200);
		expect(updateProfile).toHaveBeenCalledWith(
			4,
			expect.objectContaining({ formatItems: [{ format: 7, score: 100 }] }),
		);
		expect(deleteOverrides).toHaveBeenCalledOnce();
	});

	it("rejects a reset intent saved under a stale equivalent-alias connection", async () => {
		const staleAlias = {
			...instance,
			id: "instance-alias",
			encryptedApiKey: "stale-key",
			connectionGeneration: 1,
		};
		const currentAlias = {
			...staleAlias,
			encryptedApiKey: "current-key",
			connectionGeneration: 2,
		};
		findServiceInstances.mockResolvedValueOnce([instance, currentAlias]);
		findOverrides.mockImplementation(async ({ select }) =>
			select
				? [
						{
							id: "stale-reset",
							instanceId: staleAlias.id,
							connectionGeneration: staleAlias.connectionGeneration,
							connectionStateToken: createDeploymentConnectionStateToken(staleAlias),
							qualityProfileId: 4,
							customFormatId: 7,
							intentOperation: "RESET_SCORE",
							intendedScore: 100,
						},
					]
				: [
						{
							id: "current-override",
							instanceId: instance.id,
							connectionGeneration: instance.connectionGeneration,
							connectionStateToken: createDeploymentConnectionStateToken(instance),
							updatedAt: new Date("2026-01-01"),
							customFormatId: 7,
							status: "APPLIED",
						},
					],
		);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("older ARR connection");
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("rolls back the reset intent batch when one override changes concurrently", async () => {
		findOverrides.mockImplementation(async ({ select }) =>
			select
				? []
				: [
						{
							id: "override-7",
							updatedAt: new Date("2026-01-01"),
							qualityProfileId: 4,
							customFormatId: 7,
							status: "APPLIED",
						},
						{
							id: "override-8",
							updatedAt: new Date("2026-01-01"),
							qualityProfileId: 4,
							customFormatId: 8,
							status: "APPLIED",
						},
					],
		);
		updateOverrides.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/overrides/bulk-delete",
			{ body: { customFormatIds: [7, 8] } },
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("changed while the reset intent was being saved");
		expect(updateOverrides).toHaveBeenCalledTimes(2);
		expect(updateProfile).not.toHaveBeenCalled();
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
