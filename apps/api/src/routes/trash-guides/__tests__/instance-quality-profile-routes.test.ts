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

describe("instance quality profile score persistence", () => {
	let app: FastifyInstance;
	const findServiceInstance = vi.fn();
	const findServiceInstances = vi.fn();
	const findMappings = vi.fn();
	const findOverrides = vi.fn();
	const findTransactionOverrides = vi.fn();
	const deleteAliasOverrides = vi.fn();
	const upsertOverride = vi.fn();
	const updateOverrides = vi.fn();
	const deleteOverrides = vi.fn();
	const getProfile = vi.fn();
	const updateProfile = vi.fn();
	const getCustomFormats = vi.fn();
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
			formatItems: [{ format: 7, score: -10_000 }],
		};
		getProfile
			.mockResolvedValueOnce(beforeProfile)
			.mockResolvedValueOnce(beforeProfile)
			.mockResolvedValueOnce(beforeProfile)
			.mockResolvedValue(afterProfile);

		const template = {
			id: "template-1",
			userId,
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
			templateId: template.id,
			instanceId: instance.id,
			qualityProfileId: 4,
			qualityProfileName: "Any",
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			template,
		};

		findServiceInstance.mockResolvedValue(instance);
		findServiceInstances.mockResolvedValue([instance]);
		findMappings.mockResolvedValue([mapping]);
		findOverrides.mockImplementation(async ({ select }) => (select ? [] : []));
		findTransactionOverrides.mockResolvedValue([]);
		deleteAliasOverrides.mockResolvedValue({ count: 0 });
		upsertOverride.mockResolvedValue({});
		updateOverrides.mockResolvedValue({ count: 1 });
		deleteOverrides.mockResolvedValue({ count: 1 });
		updateProfile.mockResolvedValue(undefined);
		getCustomFormats.mockResolvedValue([{ id: 7, name: "Reject" }]);

		const transactionClient = {
			instanceQualityProfileOverride: {
				findMany: findTransactionOverrides,
				deleteMany: deleteAliasOverrides,
				upsert: upsertOverride,
				updateMany: updateOverrides,
			},
		};
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			serviceInstance: {
				findFirst: findServiceInstance,
				findMany: findServiceInstances,
			},
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: {
				findMany: findMappings,
				findUnique: vi.fn().mockResolvedValue(mapping),
			},
			instanceQualityProfileOverride: {
				findMany: findOverrides,
				findUnique: vi.fn().mockResolvedValue(null),
				upsert: upsertOverride,
				updateMany: updateOverrides,
				deleteMany: deleteOverrides,
			},
			$transaction: vi.fn(async (work: (client: typeof transactionClient) => unknown) =>
				work(transactionClient),
			),
		};
		const client = {
			qualityProfile: { getById: getProfile, update: updateProfile },
			customFormat: { getAll: getCustomFormats },
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
	});

	it("saves durable intent before the upstream profile update", async () => {
		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(upsertOverride).toHaveBeenCalledWith(
			expect.objectContaining({
				create: expect.objectContaining({
					instanceId: "instance-1",
					score: -10_000,
					status: "PENDING",
					intentOperation: "SET_SCORE",
					intendedScore: -10_000,
					connectionStateToken: createDeploymentConnectionStateToken(instance),
				}),
			}),
		);
		expect(upsertOverride.mock.invocationCallOrder[0]).toBeLessThan(
			updateProfile.mock.invocationCallOrder[0]!,
		);
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: { status: "APPLIED", intentOperation: null, intendedScore: null },
			}),
		);
	});

	it("retains uncertain intent when the upstream result is unknown", async () => {
		updateProfile.mockRejectedValueOnce(new Error("request timed out"));

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(500);
		expect(upsertOverride).toHaveBeenCalledOnce();
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({ data: { status: "UNCERTAIN" } }),
		);
	});

	it("keeps a current mapping stored through an equivalent service alias", async () => {
		const alias = { ...instance, id: "instance-alias", label: "Renamed alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findMappings.mockResolvedValueOnce([
			{
				templateId: "template-1",
				instanceId: alias.id,
				qualityProfileId: 4,
				connectionGeneration: alias.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(alias),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().isTemplateManaged).toBe(true);
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: { status: "APPLIED", intentOperation: null, intendedScore: null },
			}),
		);
	});

	it("atomically consolidates an applied override from an equivalent alias", async () => {
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
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(deleteAliasOverrides).toHaveBeenCalledWith({
			where: { id: { in: ["alias-applied"] }, status: "APPLIED", userId },
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
			}),
		);
	});

	it("fails closed if an equivalent override becomes uncertain during consolidation", async () => {
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
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(updateProfile).not.toHaveBeenCalled();
		expect(upsertOverride).not.toHaveBeenCalled();
	});

	it("rejects conflicting applied overrides from equivalent aliases transactionally", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findTransactionOverrides.mockResolvedValueOnce([
			{
				id: "primary-applied",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 100,
				status: "APPLIED",
			},
			{
				id: "alias-applied",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 200,
				status: "APPLIED",
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(deleteAliasOverrides).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("rejects duplicate Custom Format updates before any mutation", async () => {
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

	it("serializes score writes through the canonical endpoint mutation lock", async () => {
		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(runWithEndpointMutation).toHaveBeenCalledWith(
			userId,
			expect.objectContaining({ id: "instance-1", baseUrl: "http://radarr:7878" }),
			"Quality profile score update",
			expect.any(Function),
		);
	});

	it("serializes concurrent saves for equivalent endpoint aliases", async () => {
		let activeMutation = false;
		let releaseFirstUpdate!: () => void;
		let markFirstUpdateStarted!: () => void;
		const firstUpdateStarted = new Promise<void>((resolve) => {
			markFirstUpdateStarted = resolve;
		});
		const firstUpdateBlocked = new Promise<void>((resolve) => {
			releaseFirstUpdate = resolve;
		});
		updateProfile
			.mockImplementationOnce(async () => {
				markFirstUpdateStarted();
				await firstUpdateBlocked;
			})
			.mockResolvedValue(undefined);
		runWithEndpointMutation.mockImplementation(async (_userId, target, _operation, callback) => {
			if (activeMutation) {
				throw Object.assign(new Error("concurrent endpoint mutation"), { statusCode: 409 });
			}
			activeMutation = true;
			try {
				return await callback(createDeploymentEndpointKey(userId, target));
			} finally {
				activeMutation = false;
			}
		});

		const first = createInjectAuthenticated(app)("PATCH", "/instance-1/quality-profiles/4/scores", {
			body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] },
		});
		await firstUpdateStarted;
		const second = createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		releaseFirstUpdate();

		const responses = await Promise.all([first, second]);
		expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
		expect(runWithEndpointMutation).toHaveBeenCalledTimes(2);
	});

	it("rejects an exact retry saved under an older alias connection generation", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides.mockImplementation(async ({ select }) =>
			select?.connectionStateToken
				? [
						{
							instanceId: alias.id,
							qualityProfileId: 4,
							customFormatId: 7,
							intentOperation: "SET_SCORE",
							intendedScore: -10_000,
							connectionGeneration: 1,
							connectionStateToken: "stale-token",
						},
					]
				: [],
		);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(400);
		expect(upsertOverride).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("marks intent uncertain when database finalization cannot confirm the applied write", async () => {
		updateOverrides.mockResolvedValueOnce({ count: 0 }).mockResolvedValueOnce({ count: 1 });

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(updateProfile).toHaveBeenCalledOnce();
		expect(updateOverrides).toHaveBeenLastCalledWith(
			expect.objectContaining({ data: { status: "UNCERTAIN" } }),
		);
	});

	it("scopes all reads to the authenticated user and current connection binding", async () => {
		findOverrides.mockResolvedValueOnce([]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(findServiceInstance).toHaveBeenCalledWith(
			expect.objectContaining({ where: expect.objectContaining({ id: "instance-1", userId }) }),
		);
		expect(findOverrides).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId,
					qualityProfileId: 4,
					OR: [
						expect.objectContaining({
							status: "APPLIED",
							OR: [
								expect.objectContaining({
									instanceId: "instance-1",
									connectionGeneration: 2,
									connectionStateToken: createDeploymentConnectionStateToken(instance),
								}),
							],
						}),
						expect.objectContaining({
							status: { in: ["PENDING", "UNCERTAIN"] },
							instanceId: { in: ["instance-1"] },
						}),
					],
				}),
			}),
		);
	});

	it("exposes retryable uncertain intent without treating it as an applied override", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "uncertain-1",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10_000,
				status: "UNCERTAIN",
				intentOperation: "SET_SCORE",
				intendedScore: -10_000,
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				updatedAt: new Date("2026-08-09T00:00:00Z"),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toMatchObject({
			overrides: [],
			recoveryIntents: [
				{
					customFormatId: 7,
					operation: "SET_SCORE",
					intendedScore: -10_000,
					status: "UNCERTAIN",
					retryAction: { method: "PATCH", score: -10_000 },
				},
			],
		});
	});

	it("fails closed when equivalent aliases expose conflicting applied scores", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findOverrides.mockResolvedValueOnce([
			{
				id: "primary-override",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 100,
				status: "APPLIED",
			},
			{
				id: "alias-override",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 200,
				status: "APPLIED",
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode).toBe(409);
	});

	it("denies cross-user access before reading or mutating profile state", async () => {
		findServiceInstance.mockResolvedValueOnce(null);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/other-user-instance/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(404);
		expect(getProfile).not.toHaveBeenCalled();
		expect(upsertOverride).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
	});
});
