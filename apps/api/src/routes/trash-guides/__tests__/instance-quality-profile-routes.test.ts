import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	createUpstreamResourceStateToken,
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
const liveManagedCustomFormat = { id: 7, name: "Reject", specifications: [] };
const liveManagedCustomFormatStateToken = createUpstreamResourceStateToken(liveManagedCustomFormat);

describe("instance quality profile score persistence", () => {
	let app: FastifyInstance;
	const findServiceInstance = vi.fn();
	const findServiceInstances = vi.fn();
	const findMappings = vi.fn();
	const findOverrides = vi.fn();
	const findUniqueOverride = vi.fn();
	const findTransactionOverrides = vi.fn();
	const countTransactionOverrides = vi.fn();
	const findTransactionInstance = vi.fn();
	const findTransactionMappings = vi.fn();
	const updateTemplates = vi.fn();
	const deleteAliasOverrides = vi.fn();
	const upsertOverride = vi.fn();
	const updateOverrides = vi.fn();
	const deleteOverrides = vi.fn();
	const getProfile = vi.fn();
	const updateProfile = vi.fn();
	const getCustomFormats = vi.fn();
	const getCustomFormat = vi.fn();
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
		findUniqueOverride.mockResolvedValue(null);
		findTransactionOverrides.mockResolvedValue([]);
		countTransactionOverrides.mockResolvedValue(0);
		findTransactionInstance.mockResolvedValue(instance);
		findTransactionMappings.mockResolvedValue([]);
		updateTemplates.mockResolvedValue({ count: 1 });
		deleteAliasOverrides.mockResolvedValue({ count: 0 });
		upsertOverride.mockResolvedValue({});
		updateOverrides.mockResolvedValue({ count: 1 });
		deleteOverrides.mockResolvedValue({ count: 1 });
		updateProfile.mockResolvedValue(undefined);
		getCustomFormats.mockResolvedValue([{ id: 7, name: "Reject" }]);
		getCustomFormat.mockResolvedValue(liveManagedCustomFormat);

		const transactionClient = {
			serviceInstance: { findFirst: findTransactionInstance },
			templateQualityProfileMapping: { findMany: findTransactionMappings },
			trashTemplate: { updateMany: updateTemplates },
			instanceQualityProfileOverride: {
				findMany: findTransactionOverrides,
				count: countTransactionOverrides,
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
				findUnique: findUniqueOverride,
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
			customFormat: { getAll: getCustomFormats, getById: getCustomFormat },
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
					callback(
						createDeploymentEndpointKey(userId, {
							...target,
							credentialIdentity: "credentials",
						}),
					),
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
				score: 100,
				status: "APPLIED",
				connectionGeneration: alias.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(alias),
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
				connectionGeneration: alias.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(alias),
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
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
			},
			{
				id: "alias-applied",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 200,
				status: "APPLIED",
				connectionGeneration: alias.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(alias),
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

	it("rejects a stale mapping row from an equivalent alias before saving intent", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-current",
				templateId: "template-1",
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
			},
			{
				id: "mapping-stale",
				templateId: "template-1",
				instanceId: alias.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				connectionGeneration: 1,
				connectionStateToken: "stale-token",
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(upsertOverride).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("rejects a stale applied override row from an equivalent alias before saving intent", async () => {
		const alias = { ...instance, id: "instance-alias" };
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findTransactionOverrides.mockResolvedValueOnce([
			{
				id: "alias-applied-stale",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: 100,
				status: "APPLIED",
				connectionGeneration: 1,
				connectionStateToken: "stale-token",
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(deleteAliasOverrides).not.toHaveBeenCalled();
		expect(upsertOverride).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it.each(["4junk", "4.5", "0", "-4", "9007199254740992"])(
		"rejects non-canonical PATCH profile identity %s before lookup",
		async (profileId) => {
			const response = await createInjectAuthenticated(app)(
				"PATCH",
				`/instance-1/quality-profiles/${profileId}/scores`,
				{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
			);

			expect(response.statusCode).toBe(400);
			expect(getProfile).not.toHaveBeenCalled();
			expect(upsertOverride).not.toHaveBeenCalled();
			expect(updateProfile).not.toHaveBeenCalled();
		},
	);

	it.each(["4junk", "4.5", "0", "-4", "9007199254740992"])(
		"rejects non-canonical GET profile identity %s before lookup",
		async (profileId) => {
			const response = await createInjectAuthenticated(app)(
				"GET",
				`/instance-1/quality-profiles/${profileId}/overrides`,
			);

			expect(response.statusCode).toBe(400);
			expect(findOverrides).not.toHaveBeenCalled();
		},
	);

	it.each([4.5, 0, -4, Number.MAX_SAFE_INTEGER + 1])(
		"rejects non-positive-safe bulk profile identity %s before lookup",
		async (profileId) => {
			const response = await createInjectAuthenticated(app)(
				"POST",
				"/instance-1/quality-profiles/bulk-overrides",
				{ body: { profileIds: [profileId] } },
			);

			expect(response.statusCode).toBe(400);
			expect(findOverrides).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ id: 5, name: "Any", mismatch: "id" },
		{ id: 4, name: "Renamed upstream", mismatch: "name" },
	])("rejects a live profile with mismatched $mismatch authority", async (liveProfile) => {
		getProfile.mockReset().mockResolvedValue({
			id: liveProfile.id,
			name: liveProfile.name,
			formatItems: [{ format: 7, score: 100 }],
		});

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
		);

		expect(response.statusCode).toBe(409);
		expect(upsertOverride).not.toHaveBeenCalled();
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

	it.each(["RADARR", "SONARR"] as const)(
		"uses the stateful %s SDK getById/full-resource PUT contract with exact target IDs",
		async (service) => {
			const targetInstance = { ...instance, service };
			findServiceInstance.mockResolvedValue(targetInstance);
			findServiceInstances.mockResolvedValue([targetInstance]);
			findMappings.mockResolvedValue([
				{
					id: "mapping-1",
					templateId: "template-1",
					instanceId: targetInstance.id,
					qualityProfileId: 4,
					qualityProfileName: "Any",
					connectionGeneration: targetInstance.connectionGeneration,
					connectionStateToken: createDeploymentConnectionStateToken(targetInstance),
				},
			]);
			let liveProfile = {
				id: 4,
				name: "Any",
				upgradeAllowed: true,
				cutoff: 1,
				minFormatScore: 0,
				cutoffFormatScore: 100,
				items: [{ quality: { id: 1, name: "HD" }, allowed: true }],
				language: { id: 1, name: "English" },
				formatItems: [
					{ format: 7, score: 100, name: "Reject" },
					{ format: 8, score: 50, name: "Keep" },
				],
			};
			getProfile.mockReset().mockImplementation(async (profileId: number) => {
				expect(profileId).toBe(4);
				return structuredClone(liveProfile);
			});
			updateProfile.mockImplementation(async (profileId: number, payload: typeof liveProfile) => {
				expect(profileId).toBe(4);
				liveProfile = structuredClone(payload);
			});

			const response = await createInjectAuthenticated(app)(
				"PATCH",
				"/instance-1/quality-profiles/4/scores",
				{ body: { scoreUpdates: [{ customFormatId: 7, score: -10_000 }] } },
			);

			expect(response.statusCode, response.body).toBe(200);
			expect(getProfile).toHaveBeenCalledTimes(4);
			expect(getProfile.mock.calls.every(([profileId]) => profileId === 4)).toBe(true);
			expect(updateProfile).toHaveBeenCalledWith(4, {
				id: 4,
				name: "Any",
				upgradeAllowed: true,
				cutoff: 1,
				minFormatScore: 0,
				cutoffFormatScore: 100,
				items: [{ quality: { id: 1, name: "HD" }, allowed: true }],
				language: { id: 1, name: "English" },
				formatItems: [
					{ format: 7, score: -10_000, name: "Reject" },
					{ format: 8, score: 50, name: "Keep" },
				],
			});
		},
	);

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
				return await callback(
					createDeploymentEndpointKey(userId, {
						...target,
						credentialIdentity: "credentials",
					}),
				);
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

	it("rejects a row-level retry that omits part of the saved profile recovery plan", async () => {
		findOverrides.mockImplementation(async ({ select }) =>
			select?.connectionStateToken
				? [
						{
							id: "intent-7",
							instanceId: instance.id,
							updatedAt: new Date("2026-08-09T00:00:00Z"),
							qualityProfileId: 4,
							customFormatId: 7,
							intentOperation: "SET_SCORE",
							intendedScore: -10_000,
							connectionGeneration: instance.connectionGeneration,
							connectionStateToken: createDeploymentConnectionStateToken(instance),
						},
						{
							id: "intent-8",
							instanceId: instance.id,
							updatedAt: new Date("2026-08-09T00:00:00Z"),
							qualityProfileId: 4,
							customFormatId: 8,
							intentOperation: "SET_SCORE",
							intendedScore: 50,
							connectionGeneration: instance.connectionGeneration,
							connectionStateToken: createDeploymentConnectionStateToken(instance),
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
		expect(response.json().message).toContain("exact score update");
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("rejects a stale recovery token after another request resolved the intent", async () => {
		findOverrides.mockResolvedValue([]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{
				body: {
					recoveryToken: "a".repeat(64),
					scoreUpdates: [{ customFormatId: 7, score: -10_000 }],
				},
			},
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("no longer exists");
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("rejects a recovery token after the saved intent changes", async () => {
		findOverrides.mockResolvedValue([
			{
				id: "intent-7",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				intentOperation: "SET_SCORE",
				intendedScore: 25,
				status: "UNCERTAIN",
				updatedAt: new Date("2026-08-09T01:00:00Z"),
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"PATCH",
			"/instance-1/quality-profiles/4/scores",
			{
				body: {
					recoveryToken: "a".repeat(64),
					scoreUpdates: [{ customFormatId: 7, score: 25 }],
				},
			},
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("plan changed");
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
			recoveryPlans: [
				{
					qualityProfileId: 4,
					entries: [
						{
							customFormatId: 7,
							operation: "SET_SCORE",
							intendedScore: -10_000,
							status: "UNCERTAIN",
						},
					],
					retryAction: {
						method: "PATCH",
						recoveryToken: expect.stringMatching(/^[a-f0-9]{64}$/),
						scoreUpdates: [{ customFormatId: 7, score: -10_000 }],
					},
				},
			],
		});
	});

	it.each([
		{
			label: "stale SET",
			intentOperation: "SET_SCORE",
			connectionGeneration: 1,
			connectionStateToken: "stale-token",
		},
		{
			label: "legacy RESET",
			intentOperation: "RESET_SCORE",
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
		},
	])("reports $label intent as manual-only on single reads", async (intent) => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "manual-intent",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10_000,
				status: "UNCERTAIN",
				intentOperation: intent.intentOperation,
				intendedScore: -10_000,
				connectionGeneration: intent.connectionGeneration,
				connectionStateToken: intent.connectionStateToken,
				updatedAt: new Date("2026-08-09T00:00:00Z"),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"GET",
			"/instance-1/quality-profiles/4/overrides",
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().recoveryPlans).toEqual([
			expect.objectContaining({
				retryable: false,
				requiresManualReconciliation: true,
				retryAction: null,
			}),
		]);
	});

	it("reports stale intent consistently as manual-only on bulk reads", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "stale-intent",
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10_000,
				status: "PENDING",
				intentOperation: "SET_SCORE",
				intendedScore: -10_000,
				connectionGeneration: 1,
				connectionStateToken: "stale-token",
				updatedAt: new Date("2026-08-09T00:00:00Z"),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/bulk-overrides",
			{ body: { profileIds: [4] } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().recoveryPlans).toEqual([
			expect.objectContaining({
				retryable: false,
				requiresManualReconciliation: true,
			}),
		]);
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

	it("rejects reset when equivalent aliases have conflicting mapping authority", async () => {
		const alias = { ...instance, id: "instance-alias" };
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({ customFormats: [] }),
		};
		const managedCustomFormats = JSON.stringify([
			{
				trashId: "trash-7",
				name: "Reject",
				resourceId: 7,
				stateToken: liveManagedCustomFormatStateToken,
				profileId: 4,
				appliedScore: 100,
			},
		]);
		findServiceInstances.mockResolvedValueOnce([instance, alias]);
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-primary",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats,
				template,
			},
			{
				id: "mapping-alias",
				templateId: template.id,
				instanceId: alias.id,
				qualityProfileId: 4,
				qualityProfileName: "Different profile",
				syncStrategy: "manual",
				connectionGeneration: alias.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(alias),
				managedCustomFormatsCaptured: true,
				managedCustomFormats,
				template,
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("matches a reset by managed TRaSH identity when instance resource IDs collide", async () => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({
				completeQualityProfile: { sourceInstanceId: instance.id },
				customFormats: [
					{
						trashId: "instance-only-format",
						name: "Unmanaged format from the source instance",
						scoreOverride: 250,
						originalConfig: { _instanceCFId: 7 },
					},
					{
						trashId: "trash-7",
						name: "Reject",
						originalConfig: { trash_scores: { default: 0, "sqp-1-1080p": -10_000 } },
					},
				],
				qualityProfile: { trash_score_set: "sqp-1-1080p" },
			}),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "trash-7",
						name: "Reject",
						resourceId: 7,
						stateToken: liveManagedCustomFormatStateToken,
						profileId: 4,
						appliedScore: 100,
					},
				]),
				template,
			},
		]);
		findOverrides
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([
				{
					id: "override-1",
					userId,
					instanceId: instance.id,
					qualityProfileId: 4,
					customFormatId: 7,
					score: 100,
					status: "APPLIED",
					intentOperation: null,
					intendedScore: null,
					connectionGeneration: instance.connectionGeneration,
					connectionStateToken: createDeploymentConnectionStateToken(instance),
					updatedAt: new Date("2026-08-09T00:00:00Z"),
				},
			]);
		findUniqueOverride.mockResolvedValueOnce({
			id: "override-1",
			userId,
			instanceId: instance.id,
			qualityProfileId: 4,
			customFormatId: 7,
			score: 100,
			status: "APPLIED",
		});
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		const after = { ...before, formatItems: [{ format: 7, score: -10_000 }] };
		getProfile
			.mockReset()
			.mockResolvedValueOnce(before)
			.mockResolvedValueOnce(before)
			.mockResolvedValue(after);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().revertedScore).toBe(-10_000);
		expect(updateProfile).toHaveBeenCalledWith(
			4,
			expect.objectContaining({
				formatItems: [expect.objectContaining({ format: 7, score: -10_000 })],
			}),
		);
		expect(updateOverrides.mock.invocationCallOrder[0]).toBeLessThan(
			updateProfile.mock.invocationCallOrder[0]!,
		);
		expect(deleteOverrides.mock.invocationCallOrder[0]).toBeGreaterThan(
			updateProfile.mock.invocationCallOrder[0]!,
		);
	});

	it("fails before saving reset intent when a managed Custom Format identity drifted", async () => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({
				customFormats: [{ trashId: "trash-7", scoreOverride: -10_000 }],
			}),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "trash-7",
						name: "Reject",
						resourceId: 7,
						stateToken: liveManagedCustomFormatStateToken,
						profileId: 4,
						appliedScore: 100,
					},
				]),
				template,
			},
		]);
		const override = {
			id: "override-1",
			userId,
			instanceId: instance.id,
			qualityProfileId: 4,
			customFormatId: 7,
			score: 100,
			status: "APPLIED",
			intentOperation: null,
			intendedScore: null,
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			updatedAt: new Date("2026-08-09T00:00:00Z"),
		};
		findOverrides
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([override]);
		getCustomFormat.mockResolvedValue({
			id: 7,
			name: "Replacement format",
			specifications: [],
		});

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("Custom Format identity changed");
		expect(updateOverrides).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("rechecks managed Custom Format identity before resuming a reset intent", async () => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({
				customFormats: [{ trashId: "trash-7", scoreOverride: -10_000 }],
			}),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "trash-7",
						name: "Reject",
						resourceId: 7,
						stateToken: liveManagedCustomFormatStateToken,
						profileId: 4,
						appliedScore: 100,
					},
				]),
				template,
			},
		]);
		const pendingIntent = {
			id: "override-1",
			userId,
			instanceId: instance.id,
			qualityProfileId: 4,
			customFormatId: 7,
			score: 100,
			status: "PENDING",
			intentOperation: "RESET_SCORE",
			intendedScore: -10_000,
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			updatedAt: new Date("2026-08-09T00:00:00Z"),
		};
		findOverrides
			.mockResolvedValueOnce([pendingIntent])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([pendingIntent]);
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		const after = { ...before, formatItems: [{ format: 7, score: -10_000 }] };
		getProfile
			.mockReset()
			.mockResolvedValueOnce(before)
			.mockResolvedValueOnce(before)
			.mockResolvedValue(after);
		getCustomFormat
			.mockResolvedValueOnce(liveManagedCustomFormat)
			.mockResolvedValue({ id: 7, name: "Replacement format", specifications: [] });

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("Custom Format identity changed");
		expect(updateProfile).not.toHaveBeenCalled();
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("retains an uncertain reset intent when Custom Format identity changes after the ARR write", async () => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({
				customFormats: [{ trashId: "trash-7", scoreOverride: -10_000 }],
			}),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "trash-7",
						name: "Reject",
						resourceId: 7,
						stateToken: liveManagedCustomFormatStateToken,
						profileId: 4,
						appliedScore: 100,
					},
				]),
				template,
			},
		]);
		const override = {
			id: "override-1",
			userId,
			instanceId: instance.id,
			qualityProfileId: 4,
			customFormatId: 7,
			score: 100,
			status: "APPLIED",
			intentOperation: null,
			intendedScore: null,
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			updatedAt: new Date("2026-08-09T00:00:00Z"),
		};
		findOverrides
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([override]);
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		const after = { ...before, formatItems: [{ format: 7, score: -10_000 }] };
		getProfile
			.mockReset()
			.mockResolvedValueOnce(before)
			.mockResolvedValueOnce(before)
			.mockResolvedValue(after);
		getCustomFormat
			.mockResolvedValueOnce(liveManagedCustomFormat)
			.mockResolvedValueOnce(liveManagedCustomFormat)
			.mockResolvedValue({ id: 7, name: "Replacement format", specifications: [] });

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("Custom Format identity changed");
		expect(updateProfile).toHaveBeenCalledOnce();
		expect(updateOverrides).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: "UNCERTAIN" } }),
		);
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("does not reuse source-instance resource IDs on a different ARR endpoint", async () => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({
				completeQualityProfile: {
					sourceInstanceId: "source-instance",
					sourceConnectionStateToken: "source-token",
				},
				customFormats: [
					{
						trashId: "instance-only-format",
						scoreOverride: 250,
						originalConfig: { _instanceCFId: 7 },
					},
					{
						trashId: "managed-format",
						scoreOverride: -10_000,
						originalConfig: { _instanceCFId: 9001 },
					},
				],
			}),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "managed-format",
						name: "Managed format",
						resourceId: 9001,
						stateToken: liveManagedCustomFormatStateToken,
						profileId: 4,
						appliedScore: -10_000,
					},
				]),
				template,
			},
		]);
		const override = {
			id: "override-1",
			userId,
			instanceId: instance.id,
			qualityProfileId: 4,
			customFormatId: 7,
			score: 100,
			status: "APPLIED",
			intentOperation: null,
			intendedScore: null,
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			updatedAt: new Date("2026-08-09T00:00:00Z"),
		};
		findOverrides
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([override]);
		findUniqueOverride.mockResolvedValueOnce(override);
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		const after = { ...before, formatItems: [{ format: 7, score: 0 }] };
		getProfile
			.mockReset()
			.mockResolvedValueOnce(before)
			.mockResolvedValueOnce(before)
			.mockResolvedValue(after);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("Custom Format identity could not be established");
		expect(updateOverrides).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("retains instance-ID fallback on the verified cloned source connection", async () => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({
				completeQualityProfile: {
					sourceInstanceId: instance.id,
					sourceConnectionStateToken: createDeploymentConnectionStateToken(instance),
				},
				customFormats: [
					{
						trashId: "instance-only-format",
						name: "Instance-only format",
						scoreOverride: 250,
						originalConfig: {
							_instanceCFId: 7,
							name: "Instance-only format",
							specifications: [],
						},
					},
				],
			}),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: "[]",
				template,
			},
		]);
		const override = {
			id: "override-1",
			userId,
			instanceId: instance.id,
			qualityProfileId: 4,
			customFormatId: 7,
			score: 100,
			status: "APPLIED",
			intentOperation: null,
			intendedScore: null,
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			updatedAt: new Date("2026-08-09T00:00:00Z"),
		};
		findOverrides
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([override]);
		findUniqueOverride.mockResolvedValueOnce(override);
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		const after = { ...before, formatItems: [{ format: 7, score: 250 }] };
		getProfile
			.mockReset()
			.mockResolvedValueOnce(before)
			.mockResolvedValueOnce(before)
			.mockResolvedValue(after);
		getCustomFormat.mockResolvedValue({
			id: 7,
			name: "Instance-only format",
			specifications: [],
		});

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().revertedScore).toBe(250);
	});

	it.each([
		{
			label: "managed resource IDs",
			managedCustomFormats: [
				{ trashId: "trash-a", resourceId: 7 },
				{ trashId: "trash-b", resourceId: 7 },
			],
			customFormats: [{ trashId: "trash-a" }, { trashId: "trash-b" }],
		},
		{
			label: "managed TRaSH identities",
			managedCustomFormats: [
				{ trashId: "trash-a", resourceId: 7 },
				{ trashId: "trash-a", resourceId: 8 },
			],
			customFormats: [{ trashId: "trash-a" }],
		},
	])("fails closed on duplicate $label", async ({ managedCustomFormats, customFormats }) => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({ customFormats }),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify(
					managedCustomFormats.map((format) => ({
						...format,
						name: "Managed format",
						stateToken: liveManagedCustomFormatStateToken,
						profileId: 4,
						appliedScore: 100,
					})),
				),
				template,
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("duplicate managed Custom Format authority");
		expect(updateProfile).not.toHaveBeenCalled();
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("fails closed when a template repeats the managed TRaSH identity", async () => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({
				customFormats: [
					{ trashId: "trash-7", scoreOverride: 100 },
					{ trashId: "trash-7", scoreOverride: 200 },
				],
			}),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "trash-7",
						name: "Managed format",
						resourceId: 7,
						stateToken: liveManagedCustomFormatStateToken,
						profileId: 4,
						appliedScore: 100,
					},
				]),
				template,
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("duplicate Custom Format identity");
		expect(updateProfile).not.toHaveBeenCalled();
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("restores an applied reset intent when the profile changes before the ARR write", async () => {
		const template = {
			id: "template-1",
			userId,
			configData: JSON.stringify({
				customFormats: [
					{
						trashId: "trash-7",
						name: "Reject",
						originalConfig: { trash_scores: { default: 0 } },
					},
				],
			}),
		};
		findMappings.mockResolvedValueOnce([
			{
				id: "mapping-1",
				templateId: template.id,
				instanceId: instance.id,
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "manual",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "trash-7",
						name: "Reject",
						resourceId: 7,
						stateToken: liveManagedCustomFormatStateToken,
						profileId: 4,
						appliedScore: 100,
					},
				]),
				template,
			},
		]);
		const originalUpdatedAt = new Date("2026-08-09T00:00:00Z");
		const override = {
			id: "override-1",
			userId,
			instanceId: instance.id,
			qualityProfileId: 4,
			customFormatId: 7,
			score: 100,
			status: "APPLIED",
			intentOperation: null,
			intendedScore: null,
			connectionGeneration: instance.connectionGeneration,
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			updatedAt: originalUpdatedAt,
		};
		findOverrides
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([override]);
		findUniqueOverride.mockResolvedValueOnce(override);
		const before = { id: 4, name: "Any", formatItems: [{ format: 7, score: 100 }] };
		const changed = { ...before, formatItems: [{ format: 7, score: 200 }] };
		getProfile.mockReset().mockResolvedValueOnce(before).mockResolvedValueOnce(changed);

		const response = await createInjectAuthenticated(app)(
			"DELETE",
			"/instance-1/quality-profiles/4/overrides/7",
		);

		expect(response.statusCode, response.body).toBe(409);
		expect(updateProfile).not.toHaveBeenCalled();
		expect(updateOverrides).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: override.id, status: "PENDING" }),
				data: {
					status: "APPLIED",
					intentOperation: null,
					intendedScore: null,
					updatedAt: originalUpdatedAt,
				},
			}),
		);
		expect(deleteOverrides).not.toHaveBeenCalled();
	});

	it("promotes only an applied override bound through managed TRaSH identity", async () => {
		const template = {
			id: "template-1",
			userId,
			updatedAt: new Date("2026-08-09T00:00:00Z"),
			configData: JSON.stringify({
				customFormats: [
					{
						trashId: "trash-7",
						name: "Reject",
						originalConfig: { _instanceCFId: 9001 },
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
			managedCustomFormatsCaptured: true,
			managedCustomFormats: JSON.stringify([
				{
					trashId: "trash-7",
					name: "Reject",
					resourceId: 7,
					stateToken: liveManagedCustomFormatStateToken,
					profileId: 4,
					appliedScore: 100,
				},
			]),
			updatedAt: new Date("2026-08-09T00:00:00Z"),
			template,
		};
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-1",
				userId,
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10_000,
				status: "APPLIED",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				updatedAt: new Date("2026-08-09T00:00:00Z"),
			},
		]);
		findMappings.mockResolvedValueOnce([mapping]);
		findTransactionMappings.mockResolvedValueOnce([mapping]);
		deleteAliasOverrides.mockResolvedValueOnce({ count: 1 });

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/promote-override",
			{ body: { customFormatId: 7, templateId: "template-1" } },
		);

		expect(response.statusCode, response.body).toBe(200);
		expect(updateTemplates).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					configData: expect.stringContaining('"scoreOverride":-10000'),
				}),
			}),
		);
	});

	it("refuses to promote an unresolved score intent", async () => {
		findOverrides.mockResolvedValueOnce([
			{
				id: "override-1",
				userId,
				instanceId: instance.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10_000,
				status: "UNCERTAIN",
				connectionGeneration: instance.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(instance),
				updatedAt: new Date("2026-08-09T00:00:00Z"),
			},
		]);

		const response = await createInjectAuthenticated(app)(
			"POST",
			"/instance-1/quality-profiles/4/promote-override",
			{ body: { customFormatId: 7, templateId: "template-1" } },
		);

		expect(response.statusCode).toBe(409);
		expect(updateTemplates).not.toHaveBeenCalled();
	});

	it.each([
		[
			"POST",
			"/instance-1/quality-profiles/4.5/promote-override",
			{ customFormatId: 7, templateId: "template-1" },
		],
		["DELETE", "/instance-1/quality-profiles/4.5/overrides/7", undefined],
		["DELETE", "/instance-1/quality-profiles/4/overrides/7.5", undefined],
		["POST", "/instance-1/quality-profiles/4/overrides/bulk-delete", undefined],
	] as const)("rejects invalid mutation input for %s %s", async (method, url, body) => {
		const response = await createInjectAuthenticated(app)(method, url, body ? { body } : undefined);

		expect(response.statusCode).toBe(400);
		expect(updateProfile).not.toHaveBeenCalled();
	});
});
