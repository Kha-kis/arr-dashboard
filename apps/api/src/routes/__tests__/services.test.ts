import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const {
	mockRequireInstance,
	mockTestConnection,
	mockBuildUpdateData,
	mockUpsertTags,
	mockUpdateInstanceTags,
	mockFormatServiceInstance,
	mockInvalidatePulseCache,
	mockReadProviderIdentity,
} = vi.hoisted(() => ({
	mockRequireInstance: vi.fn(),
	mockTestConnection: vi.fn().mockResolvedValue({ success: true, version: "4.0.0" }),
	mockBuildUpdateData: vi.fn().mockReturnValue({}),
	mockUpsertTags: vi.fn().mockResolvedValue([]),
	mockUpdateInstanceTags: vi.fn().mockResolvedValue(undefined),
	mockFormatServiceInstance: vi.fn().mockImplementation((instance: any) => ({
		id: instance.id,
		service: instance.service?.toLowerCase?.() ?? "sonarr",
		label: instance.label ?? "Test Instance",
		baseUrl: instance.baseUrl ?? "http://localhost:8989",
		externalUrl: instance.externalUrl ?? null,
		enabled: instance.enabled ?? true,
		isDefault: instance.isDefault ?? false,
		tags: [],
		storageGroupId: instance.storageGroupId ?? null,
	})),
	mockInvalidatePulseCache: vi.fn(),
	mockReadProviderIdentity: vi.fn(),
}));

vi.mock("../pulse.js", () => ({
	invalidatePulseCache: (...args: unknown[]) => mockInvalidatePulseCache(...args),
}));

vi.mock("../../lib/arr/instance-helpers.js", () => ({
	requireInstance: (...args: unknown[]) => mockRequireInstance(...args),
}));

vi.mock("../../lib/services/connection-tester.js", () => ({
	testServiceConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

vi.mock("../../lib/services/update-builder.js", () => ({
	buildUpdateData: (...args: unknown[]) => mockBuildUpdateData(...args),
}));

vi.mock("../../lib/services/tag-manager.js", () => ({
	upsertTags: (...args: unknown[]) => mockUpsertTags(...args),
	updateInstanceTags: (...args: unknown[]) => mockUpdateInstanceTags(...args),
}));

vi.mock("../../lib/services/service-formatter.js", () => ({
	formatServiceInstance: (instance: unknown) => mockFormatServiceInstance(instance),
}));

vi.mock("../../lib/services/service-identity.js", () => ({
	readProviderIdentity: (...args: unknown[]) => mockReadProviderIdentity(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { InstanceNotFoundError } from "../../lib/errors.js";
import { acquireCleanupOperationGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import {
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
} from "../../lib/trash-guides/deployment-target.js";
import { registerServiceRoutes } from "../services.js";
import {
	createInjectAuthenticated,
	createMockEncryptor,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeInstance(overrides: Record<string, unknown> = {}) {
	return {
		id: "inst-1",
		userId: "user-1",
		service: "SONARR",
		label: "Sonarr 1",
		baseUrl: "http://localhost:8989",
		externalUrl: null,
		encryptedApiKey: "encrypted-key",
		encryptionIv: "mock-iv",
		enabled: true,
		isDefault: false,
		createdAt: new Date("2024-01-01T00:00:00Z"),
		updatedAt: new Date("2024-01-01T00:00:00Z"),
		connectionGeneration: 0,
		expectedIdentity: null,
		identityKind: null,
		identityStatus: "UNVERIFIED",
		identityGeneration: 0,
		identityVerifiedAt: null,
		identityLastCheckedAt: null,
		storageGroupId: null,
		tags: [],
		...overrides,
	};
}

function makeAppliedDeploymentBackup() {
	return {
		id: "backup-active",
		backupData: JSON.stringify({
			schemaVersion: 2,
			endpointKey: "endpoint",
			connectionStateToken: "connection",
			customFormats: [],
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 7,
					name: "Created CF",
					status: "applied",
					postStateToken: "created-post",
				},
			],
			managedCustomFormats: [],
			managedCustomFormatsCaptured: true,
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "not_started",
				action: "updated",
				profileId: null,
				postStateToken: null,
			},
			namingDeployment: null,
		}),
	};
}

// ---------------------------------------------------------------------------
// Mock Prisma client
// ---------------------------------------------------------------------------

function createMockPrisma() {
	const prisma = {
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		systemSettings: {
			findUnique: vi.fn().mockResolvedValue({
				analyticsProvider: "tracearr",
				analyticsProviderSource: "explicit",
			}),
			upsert: vi.fn(),
		},
		serviceInstance: {
			count: vi.fn().mockResolvedValue(0),
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn().mockImplementation(({ data }: any) => ({
				id: "inst-new",
				...data,
				createdAt: new Date(),
				updatedAt: new Date(),
				tags: [],
			})),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		templateQualityProfileMapping: {
			findMany: vi.fn().mockResolvedValue([]),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		serviceTag: {
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn().mockImplementation(({ create }: any) => ({
				id: "tag-1",
				name: create.name,
			})),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		serviceInstanceTag: {
			findFirst: vi.fn().mockResolvedValue(null),
		},
		trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
		templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		jellyfinCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		plexCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		plexEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		tautulliCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		cacheRefreshStatus: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			upsert: vi.fn().mockResolvedValue({}),
		},
		instanceQualityProfileOverride: {
			findMany: vi.fn().mockResolvedValue([]),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
		},
	};
	return Object.assign(prisma, {
		$transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
			callback(prisma),
		),
	});
}

// ---------------------------------------------------------------------------
// Fastify app setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockReadProviderIdentity.mockImplementation(async ({ service }: { service: string }) => {
		const identities = {
			PLEX: "plex-machine-identifier",
			JELLYFIN: "jellyfin-server-id",
			EMBY: "emby-server-id",
			TAUTULLI: "tautulli-pms-identifier",
		} as const;
		return {
			service,
			identityKind: identities[service as keyof typeof identities],
			rawIdentity: `${service}-identity`,
			fingerprint: "safe-fingerprint",
			confirmationDigest: "a".repeat(64),
		};
	});

	mockPrisma = createMockPrisma();

	// Default: requireInstance returns a valid instance
	mockRequireInstance.mockResolvedValue(makeInstance());
	mockBuildUpdateData.mockReturnValue({});

	app = Fastify();

	// Decorations
	app.decorate("prisma", mockPrisma);
	app.decorate("encryptor", createMockEncryptor("decrypted-api-key"));
	app.decorate("notificationService", {
		notify: vi.fn().mockResolvedValue(undefined),
	});
	app.decorate("arrClientFactory", {
		createConnectionCredentialIdentity: vi.fn().mockReturnValue("credential-identity"),
	});
	app.decorate("deploymentExecutor", {
		runWithEndpointMutation: vi.fn(async (lockedUserId, target, _operation, callback) =>
			callback(
				createDeploymentEndpointKey(lockedUserId, {
					...target,
					credentialIdentity: app.arrClientFactory.createConnectionCredentialIdentity(target),
				}),
			),
		),
	});

	setupAuthInjection(app);
	registerTestErrorHandler(app);

	await app.register(registerServiceRoutes);
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

// ===========================================================================
// POST /services — create instance
// ===========================================================================

describe("POST /services", () => {
	it("creates instance with encrypted API key and returns 201", async () => {
		const res = await injectAuthenticated("POST", "/services", {
			body: {
				label: "My Sonarr",
				baseUrl: "http://sonarr:8989",
				apiKey: "my-secret-api-key",
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);
		expect(body.service).toBeDefined();
		expect(body.service.id).toBeDefined();

		// Encryption should have been called with the raw API key
		expect((app as any).encryptor.encrypt).toHaveBeenCalledWith("my-secret-api-key");

		// Prisma create should receive encrypted values, not plaintext
		expect(mockPrisma.serviceInstance.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					encryptedApiKey: "encrypted",
					encryptionIv: "mock-iv",
					userId: "user-1",
					service: "SONARR",
				}),
			}),
		);
	});

	it("accepts Tautulli as a supported integration", async () => {
		const res = await injectAuthenticated("POST", "/services", {
			body: {
				label: "Primary Tautulli",
				baseUrl: "http://tautulli:8181",
				apiKey: "tautulli-api-key",
				service: "tautulli",
			},
		});

		expect(res.statusCode).toBe(201);
		expect(mockPrisma.serviceInstance.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ service: "TAUTULLI" }),
			}),
		);
	});

	it("demotes other instances when isDefault is true", async () => {
		const res = await injectAuthenticated("POST", "/services", {
			body: {
				label: "Default Sonarr",
				baseUrl: "http://sonarr:8989",
				apiKey: "my-secret-api-key",
				service: "sonarr",
				isDefault: true,
			},
		});

		expect(res.statusCode).toBe(201);

		// Should have called updateMany to demote other SONARR instances
		expect(mockPrisma.serviceInstance.updateMany).toHaveBeenCalledWith({
			where: { service: "SONARR", userId: "user-1" },
			data: { isDefault: false },
		});
	});

	it("does not demote when isDefault is false", async () => {
		await injectAuthenticated("POST", "/services", {
			body: {
				label: "Secondary Sonarr",
				baseUrl: "http://sonarr2:8989",
				apiKey: "my-secret-api-key",
				service: "sonarr",
				isDefault: false,
			},
		});

		expect(mockPrisma.serviceInstance.updateMany).not.toHaveBeenCalled();
	});

	it("returns 409 without changing topology while cleanup owns the lease", async () => {
		mockPrisma.libraryCleanupConfig.updateMany.mockResolvedValueOnce({ count: 0 });

		const res = await injectAuthenticated("POST", "/services", {
			body: {
				label: "Concurrent Sonarr",
				baseUrl: "http://sonarr:8989",
				apiKey: "my-secret-api-key",
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).message).toContain(
			"cannot be changed while a library cleanup operation is in progress",
		);
		expect(mockPrisma.serviceInstance.create).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// PUT /services/:id — update instance
// ===========================================================================

describe("PUT /services/:id", () => {
	it("keeps default reassignment inside a provider connection transition transaction", async () => {
		mockRequireInstance.mockResolvedValue(makeInstance({ service: "PLEX" }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "PLEX", isDefault: true }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: {
				baseUrl: "http://plex-new:32400",
				isDefault: true,
			},
		});

		expect(res.statusCode).toBe(200);
		const transactionOrder = mockPrisma.$transaction.mock.invocationCallOrder[0]!;
		const defaultResetOrder = mockPrisma.serviceInstance.updateMany.mock.invocationCallOrder[0]!;
		expect(transactionOrder).toBeLessThan(defaultResetOrder);
		expect(mockPrisma.serviceInstance.updateMany).toHaveBeenNthCalledWith(1, {
			where: { service: "PLEX", userId: "user-1", NOT: { id: "inst-1" } },
			data: { isDefault: false },
		});
	});

	it("clears provider cache state sequentially in the connection-generation transaction", async () => {
		mockRequireInstance.mockResolvedValue(makeInstance({ service: "PLEX" }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeInstance({ service: "PLEX" }));
		const calls: string[] = [];
		let plexCleared = false;
		let plexEpisodesCleared = false;
		let tautulliCleared = false;
		mockPrisma.plexCache.deleteMany.mockImplementation(async () => {
			calls.push("plex");
			await Promise.resolve();
			plexCleared = true;
		});
		mockPrisma.plexEpisodeCache.deleteMany.mockImplementation(async () => {
			if (!plexCleared) throw new Error("Plex cache must clear first");
			calls.push("plex_episode");
			await Promise.resolve();
			plexEpisodesCleared = true;
		});
		mockPrisma.tautulliCache.deleteMany.mockImplementation(async () => {
			if (!plexEpisodesCleared) throw new Error("Plex episode cache must clear first");
			calls.push("tautulli");
			await Promise.resolve();
			tautulliCleared = true;
		});
		mockPrisma.jellyfinCache.deleteMany.mockImplementation(async () => {
			if (!tautulliCleared) throw new Error("Tautulli cache must clear first");
			calls.push("jellyfin");
			await Promise.resolve();
		});
		mockPrisma.jellyfinEpisodeCache.deleteMany.mockImplementation(async () => {
			if (!tautulliCleared) throw new Error("Tautulli cache must clear first");
			calls.push("jellyfin_episode");
			await Promise.resolve();
		});
		mockPrisma.cacheRefreshStatus.deleteMany.mockImplementation(async () => {
			if (!tautulliCleared) throw new Error("Tautulli cache must clear first");
			calls.push("status");
		});

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { label: "Plex", baseUrl: "http://plex-new:32400" },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.serviceInstance.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ connectionGeneration: { increment: 1 } }),
			}),
		);
		expect(calls).toEqual([
			"plex",
			"plex_episode",
			"tautulli",
			"jellyfin",
			"jellyfin_episode",
			"status",
		]);
		expect(mockPrisma.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
		expect(mockInvalidatePulseCache).toHaveBeenCalledWith("user-1");
	});

	it("increments generation and invalidates durable Tautulli cache state on connection edits", async () => {
		mockRequireInstance.mockResolvedValue(makeInstance({ service: "TAUTULLI" }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeInstance({ service: "TAUTULLI" }));

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://tautulli-new:8181" },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.serviceInstance.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ connectionGeneration: { increment: 1 } }),
			}),
		);
		expect(mockPrisma.tautulliCache.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "inst-1" },
		});
		expect(mockPrisma.cacheRefreshStatus.upsert).not.toHaveBeenCalled();
	});

	it("calls buildUpdateData and updates the instance", async () => {
		mockBuildUpdateData.mockReturnValue({ label: "Updated Label" });
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ label: "Updated Label" }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { label: "Updated Label" },
		});

		expect(res.statusCode).toBe(200);

		// requireInstance should verify ownership
		expect(mockRequireInstance).toHaveBeenCalledWith(
			expect.anything(), // app
			"user-1",
			"inst-1",
		);

		// buildUpdateData receives the payload and encryptor
		expect(mockBuildUpdateData).toHaveBeenCalledWith(
			expect.objectContaining({ label: "Updated Label" }),
			expect.objectContaining({ encrypt: expect.any(Function) }),
		);
		expect(mockPrisma.libraryCleanupConfig.updateMany).toHaveBeenCalledTimes(2);
	});

	it("returns 404 for non-owned instance via requireInstance", async () => {
		mockRequireInstance.mockRejectedValue(new InstanceNotFoundError("inst-999"));

		const res = await injectAuthenticated("PUT", "/services/inst-999", {
			body: { label: "Hacker Update" },
		});

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).message).toContain("not found");
	});

	it("advances an ARR connection generation without erasing saved score intent", async () => {
		mockRequireInstance.mockResolvedValue(
			makeInstance({ service: "RADARR", baseUrl: "http://radarr-old:7878" }),
		);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://radarr-new:7878" });
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({
				service: "RADARR",
				baseUrl: "http://radarr-new:7878",
				connectionGeneration: 1,
			}),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://radarr-new:7878" },
		});

		expect(res.statusCode).toBe(200);
		const connectionUpdate = mockPrisma.serviceInstance.updateMany.mock.calls.find(
			([args]) => args.where.id === "inst-1",
		)?.[0];
		expect(connectionUpdate?.data.connectionGeneration).toEqual({ increment: 1 });
		expect(mockPrisma.instanceQualityProfileOverride.deleteMany).not.toHaveBeenCalled();
	});

	it("holds the ARR endpoint mutation gate while replacing a connection", async () => {
		const original = makeInstance({
			service: "RADARR",
			baseUrl: "http://radarr-old:7878",
		});
		mockRequireInstance.mockResolvedValue(original);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://radarr-new:7878" });
		mockPrisma.serviceInstance.findMany.mockResolvedValue([original]);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "RADARR", baseUrl: "http://radarr-new:7878" }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://radarr-new:7878" },
		});

		expect(res.statusCode).toBe(200);
		expect((app as any).deploymentExecutor.runWithEndpointMutation).toHaveBeenCalledWith(
			"user-1",
			original,
			"ARR connection replacement",
			expect.any(Function),
		);
		expect(mockRequireInstance).toHaveBeenCalledTimes(2);
		expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
	});

	it("rejects an ARR connection replacement when its authority changes before the gate", async () => {
		const original = makeInstance({
			service: "RADARR",
			baseUrl: "http://radarr-old:7878",
			connectionGeneration: 2,
		});
		const changed = makeInstance({
			service: "RADARR",
			baseUrl: "http://radarr-other:7878",
			connectionGeneration: 3,
		});
		mockRequireInstance.mockResolvedValue(original);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://radarr-new:7878" });
		vi.mocked((app as any).deploymentExecutor.runWithEndpointMutation).mockImplementationOnce(
			async (lockedUserId: string, target: any, _operation: string, callback: any) => {
				mockRequireInstance.mockResolvedValue(changed);
				return callback(
					createDeploymentEndpointKey(lockedUserId, {
						...target,
						credentialIdentity: "credential-identity",
					}),
				);
			},
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://radarr-new:7878" },
		});

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).message).toContain("changed while the replacement was starting");
		expect(mockPrisma.serviceInstance.updateMany).not.toHaveBeenCalled();
	});

	it("does not advance ARR generation for a normalized equivalent URL", async () => {
		mockRequireInstance.mockResolvedValue(
			makeInstance({ service: "RADARR", baseUrl: "http://radarr:7878" }),
		);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://radarr:7878/" });
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "RADARR", baseUrl: "http://radarr:7878/" }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://radarr:7878/" },
		});

		expect(res.statusCode).toBe(200);
		expect(
			mockPrisma.serviceInstance.updateMany.mock.calls.some(
				([args]) => args.data.connectionGeneration !== undefined,
			),
		).toBe(false);
	});

	it("does not advance ARR generation when credentials resolve to the same identity", async () => {
		mockRequireInstance.mockResolvedValue(makeInstance({ service: "SONARR" }));
		mockBuildUpdateData.mockReturnValue({
			encryptedApiKey: "re-encrypted-same-key",
			encryptionIv: "new-iv",
		});
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeInstance({ service: "SONARR" }));

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { apiKey: "same-api-key" },
		});

		expect(res.statusCode).toBe(200);
		expect(
			mockPrisma.serviceInstance.updateMany.mock.calls.some(
				([args]) => args.data.connectionGeneration !== undefined,
			),
		).toBe(false);
	});

	it("advances ARR generation when credential identity changes", async () => {
		mockRequireInstance.mockResolvedValue(
			makeInstance({ service: "SONARR", encryptedApiKey: "old-encrypted-key" }),
		);
		mockBuildUpdateData.mockReturnValue({
			encryptedApiKey: "new-encrypted-key",
			encryptionIv: "new-iv",
		});
		vi.mocked((app as any).arrClientFactory.createConnectionCredentialIdentity).mockImplementation(
			(candidate: { encryptedApiKey: string }) => candidate.encryptedApiKey,
		);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "SONARR", encryptedApiKey: "new-encrypted-key" }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { apiKey: "different-api-key" },
		});

		expect(res.statusCode).toBe(200);
		const connectionUpdate = mockPrisma.serviceInstance.updateMany.mock.calls.find(
			([args]) => args.where.id === "inst-1",
		)?.[0];
		expect(connectionUpdate?.data.connectionGeneration).toEqual({ increment: 1 });
	});

	it("advances provider generation for a non-ARR connection update", async () => {
		mockRequireInstance.mockResolvedValue(
			makeInstance({ service: "JELLYFIN", baseUrl: "http://jellyfin-old:8096" }),
		);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://jellyfin-new:8096" });
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "JELLYFIN", baseUrl: "http://jellyfin-new:8096" }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://jellyfin-new:8096" },
		});

		expect(res.statusCode).toBe(200);
		const connectionUpdate = mockPrisma.serviceInstance.updateMany.mock.calls.find(
			([args]) => args.where.id === "inst-1",
		)?.[0];
		expect(connectionUpdate?.data.connectionGeneration).toEqual({ increment: 1 });
	});

	it("blocks a real ARR credential change while an equivalent alias has unresolved intent", async () => {
		const primary = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr:7878",
			encryptedApiKey: "old-encrypted-key",
		});
		const alias = makeInstance({
			id: "inst-alias",
			service: "RADARR",
			baseUrl: "http://radarr:7878/",
			encryptedApiKey: "old-encrypted-key",
		});
		mockRequireInstance.mockResolvedValue(primary);
		mockBuildUpdateData.mockReturnValue({
			encryptedApiKey: "new-encrypted-key",
			encryptionIv: "new-iv",
		});
		vi.mocked((app as any).arrClientFactory.createConnectionCredentialIdentity).mockImplementation(
			(candidate: { encryptedApiKey: string }) => candidate.encryptedApiKey,
		);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([primary, alias]);
		mockPrisma.instanceQualityProfileOverride.findMany.mockResolvedValue([
			{
				id: "pending-alias-intent",
				userId: "user-1",
				instanceId: alias.id,
				qualityProfileId: 4,
				customFormatId: 7,
				status: "PENDING",
			},
		]);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { apiKey: "different-api-key" },
		});

		expect(res.statusCode).toBe(409);
		expect(mockPrisma.instanceQualityProfileOverride.findMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				instanceId: { in: expect.arrayContaining(["inst-1", "inst-alias"]) },
				status: { in: ["PENDING", "UNCERTAIN"] },
			},
		});
		expect(mockPrisma.serviceInstance.updateMany).not.toHaveBeenCalled();
	});

	it("blocks an ARR connection replacement while a deployment still owns upstream state", async () => {
		const existing = makeInstance({
			service: "RADARR",
			baseUrl: "http://radarr:7878",
		});
		mockRequireInstance.mockResolvedValue(existing);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://replacement-radarr:7878" });
		mockPrisma.serviceInstance.findMany.mockResolvedValue([existing]);
		mockPrisma.templateDeploymentHistory.findMany.mockResolvedValue([
			{
				status: "SUCCESS",
				backupId: "backup-active",
				backup: makeAppliedDeploymentBackup(),
			},
		]);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://replacement-radarr:7878" },
		});

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).message).toContain("active deployment ownership");
		expect(mockPrisma.serviceInstance.updateMany).not.toHaveBeenCalled();
	});

	it("atomically clears Jellyfin cache state after a connection update", async () => {
		const order: string[] = [];
		mockRequireInstance.mockResolvedValue(
			makeInstance({ service: "JELLYFIN", baseUrl: "http://jellyfin-old:8096" }),
		);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://jellyfin-new:8096" });
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "JELLYFIN", baseUrl: "http://jellyfin-new:8096" }),
		);
		mockPrisma.serviceInstance.updateMany.mockImplementation(async () => {
			order.push("update");
			return { count: 1 };
		});
		mockPrisma.jellyfinCache.deleteMany.mockImplementation(async () => {
			order.push("cache");
			return { count: 1 };
		});
		mockPrisma.jellyfinEpisodeCache.deleteMany.mockImplementation(async () => {
			order.push("episode-cache");
			return { count: 1 };
		});
		mockPrisma.cacheRefreshStatus.deleteMany.mockImplementation(async () => {
			order.push("status");
			return { count: 2 };
		});

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://jellyfin-new:8096" },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
		expect(order).toEqual(["update", "cache", "episode-cache", "status"]);
		const connectionUpdate = mockPrisma.serviceInstance.updateMany.mock.calls.find(
			([args]) => args.where.id === "inst-1",
		)?.[0];
		expect(connectionUpdate?.data.connectionGeneration).toEqual({ increment: 1 });
		expect(mockPrisma.cacheRefreshStatus.deleteMany).toHaveBeenCalledWith({
			where: { instanceId: "inst-1" },
		});
		expect(mockInvalidatePulseCache).toHaveBeenCalledWith("user-1");
	});

	it("keeps Jellyfin cache state when the form resubmits unchanged connection fields", async () => {
		mockRequireInstance.mockResolvedValue(
			makeInstance({ service: "JELLYFIN", baseUrl: "http://jellyfin:8096", enabled: true }),
		);
		mockBuildUpdateData.mockReturnValue({
			label: "Renamed Jellyfin",
			service: "JELLYFIN",
			baseUrl: "http://jellyfin:8096",
			enabled: true,
		});
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "JELLYFIN", label: "Renamed Jellyfin" }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: {
				label: "Renamed Jellyfin",
				service: "jellyfin",
				baseUrl: "http://jellyfin:8096",
				enabled: true,
			},
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		expect(mockPrisma.jellyfinEpisodeCache.deleteMany).not.toHaveBeenCalled();
		expect(mockPrisma.cacheRefreshStatus.deleteMany).not.toHaveBeenCalled();
		expect(mockInvalidatePulseCache).not.toHaveBeenCalled();
		expect(
			mockPrisma.serviceInstance.updateMany.mock.calls.some(
				([args]) => args.data.connectionGeneration !== undefined,
			),
		).toBe(false);
	});

	it.each([
		["PLEX", "jellyfin"],
		["TAUTULLI", "emby"],
	] as const)(
		"atomically clears outgoing provider state when changing %s to %s",
		async (existingService, targetService) => {
			mockRequireInstance.mockResolvedValue(makeInstance({ service: existingService }));
			mockBuildUpdateData.mockReturnValue({ service: targetService.toUpperCase() });
			mockPrisma.serviceInstance.findFirst.mockResolvedValue(
				makeInstance({ service: targetService.toUpperCase() }),
			);

			const res = await injectAuthenticated("PUT", "/services/inst-1", {
				body: { service: targetService },
			});

			expect(res.statusCode).toBe(200);
			expect(mockPrisma.$transaction).toHaveBeenCalled();
			expect(mockPrisma.plexCache.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockPrisma.plexEpisodeCache.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockPrisma.tautulliCache.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockPrisma.jellyfinCache.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockPrisma.jellyfinEpisodeCache.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockPrisma.cacheRefreshStatus.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockInvalidatePulseCache).toHaveBeenCalledWith("user-1");
		},
	);

	it.each([
		["PLEX", "http://plex-old:32400", "http://plex-new:32400"],
		["TAUTULLI", "http://tautulli-old:8181", "http://tautulli-new:8181"],
	] as const)(
		"advances %s generation and clears every provider cache on URL replacement",
		async (service, oldUrl, newUrl) => {
			mockRequireInstance.mockResolvedValue(makeInstance({ service, baseUrl: oldUrl }));
			mockBuildUpdateData.mockReturnValue({ baseUrl: newUrl });
			mockPrisma.serviceInstance.findFirst.mockResolvedValue(
				makeInstance({ service, baseUrl: newUrl, connectionGeneration: 1 }),
			);

			const res = await injectAuthenticated("PUT", "/services/inst-1", {
				body: { baseUrl: newUrl },
			});

			expect(res.statusCode).toBe(200);
			const connectionUpdate = mockPrisma.serviceInstance.updateMany.mock.calls.find(
				([args]) => args.where.id === "inst-1",
			)?.[0];
			expect(connectionUpdate?.data.connectionGeneration).toEqual({ increment: 1 });
			expect(mockPrisma.plexCache.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockPrisma.plexEpisodeCache.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockPrisma.tautulliCache.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockPrisma.cacheRefreshStatus.deleteMany).toHaveBeenCalledWith({
				where: { instanceId: "inst-1" },
			});
			expect(mockInvalidatePulseCache).toHaveBeenCalledWith("user-1");
		},
	);

	it("keeps Jellyfin cache state for a label-only update", async () => {
		mockRequireInstance.mockResolvedValue(makeInstance({ service: "JELLYFIN" }));
		mockBuildUpdateData.mockReturnValue({ label: "Renamed Jellyfin" });
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "JELLYFIN", label: "Renamed Jellyfin" }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { label: "Renamed Jellyfin" },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.jellyfinCache.deleteMany).not.toHaveBeenCalled();
		expect(mockPrisma.cacheRefreshStatus.deleteMany).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// DELETE /services/:id
// ===========================================================================

describe("DELETE /services/:id", () => {
	it("deletes owned instance and returns 204", async () => {
		mockPrisma.serviceInstance.findMany.mockResolvedValue([makeInstance()]);
		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(204);
		expect(mockRequireInstance).toHaveBeenCalledWith(expect.anything(), "user-1", "inst-1");
		expect(mockPrisma.serviceInstance.delete).toHaveBeenCalledWith({
			where: { id: "inst-1", userId: "user-1" },
		});
		expect(mockPrisma.libraryCleanupConfig.updateMany).toHaveBeenCalledTimes(2);
	});

	it("returns 404 for non-owned instance", async () => {
		mockRequireInstance.mockRejectedValue(new InstanceNotFoundError("inst-999"));

		const res = await injectAuthenticated("DELETE", "/services/inst-999");

		expect(res.statusCode).toBe(404);
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("validates ownership after acquiring deletion authority", async () => {
		mockRequireInstance.mockRejectedValueOnce(new InstanceNotFoundError("inst-1"));

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(404);
		expect(mockRequireInstance).toHaveBeenCalledTimes(1);
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("refuses to erase an instance with active TRaSH recovery evidence", async () => {
		mockPrisma.templateDeploymentHistory.findMany.mockResolvedValueOnce([
			{
				id: "deployment-1",
				status: "PARTIAL_UNDEPLOY",
				undeployStatus: "PARTIAL",
				rolledBack: false,
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).message).toContain("recovery");
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("refuses to race an ARR deletion with an active TRaSH mutation", async () => {
		const releaseMutation = acquireCleanupOperationGuard();
		try {
			const res = await injectAuthenticated("DELETE", "/services/inst-1");

			expect(res.statusCode).toBe(409);
			expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
		} finally {
			releaseMutation();
		}
	});

	it("migrates current mappings and applied overrides to one exact surviving ARR alias", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr:7878",
			connectionGeneration: 2,
		});
		const survivor = makeInstance({
			id: "inst-2",
			service: "RADARR",
			baseUrl: "http://radarr:7878/",
			connectionGeneration: 5,
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source, survivor]);
		mockPrisma.templateQualityProfileMapping.findMany.mockResolvedValue([
			{
				id: "mapping-source",
				instanceId: source.id,
				templateId: "template-1",
				qualityProfileId: 4,
				qualityProfileName: "Any",
				connectionGeneration: source.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(source),
				template: { userId: "user-1" },
				instance: { userId: "user-1" },
			},
		]);
		mockPrisma.instanceQualityProfileOverride.findMany.mockResolvedValue([
			{
				id: "override-source",
				instanceId: source.id,
				qualityProfileId: 4,
				customFormatId: 7,
				score: -10_000,
				status: "APPLIED",
				userId: "user-1",
				connectionGeneration: source.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(source),
				instance: { userId: "user-1" },
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.templateQualityProfileMapping.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "mapping-source", instanceId: "inst-1" }),
				data: expect.objectContaining({
					instanceId: "inst-2",
					connectionGeneration: 5,
					connectionStateToken: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			}),
		);
		expect(mockPrisma.instanceQualityProfileOverride.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "override-source", instanceId: "inst-1" }),
				data: expect.objectContaining({
					instanceId: "inst-2",
					connectionGeneration: 5,
					connectionStateToken: expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			}),
		);
		expect(mockPrisma.serviceInstance.delete).toHaveBeenCalledWith({
			where: { id: "inst-1", userId: "user-1" },
		});
	});

	it.each(["PENDING", "UNCERTAIN"])(
		"blocks ARR alias deletion while %s score intent exists",
		async (status) => {
			const source = makeInstance({
				id: "inst-1",
				service: "SONARR",
				baseUrl: "http://sonarr:8989",
			});
			const survivor = makeInstance({
				id: "inst-2",
				service: "SONARR",
				baseUrl: "http://sonarr:8989/",
			});
			mockRequireInstance.mockResolvedValue(source);
			mockPrisma.serviceInstance.findMany.mockResolvedValue([source, survivor]);
			mockPrisma.instanceQualityProfileOverride.findMany.mockResolvedValue([
				{
					id: "intent-1",
					instanceId: source.id,
					qualityProfileId: 4,
					customFormatId: 7,
					status,
					userId: "user-1",
					instance: { userId: "user-1" },
				},
			]);

			const res = await injectAuthenticated("DELETE", "/services/inst-1");

			expect(res.statusCode).toBe(409);
			expect(mockPrisma.templateQualityProfileMapping.updateMany).not.toHaveBeenCalled();
			expect(mockPrisma.instanceQualityProfileOverride.updateMany).not.toHaveBeenCalled();
			expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
		},
	);

	it("blocks ARR alias deletion when saved state has no exact surviving alias", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr:7878",
			connectionGeneration: 2,
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source]);
		mockPrisma.templateQualityProfileMapping.findMany.mockResolvedValue([
			{
				id: "mapping-source",
				instanceId: source.id,
				templateId: "template-1",
				qualityProfileId: 4,
				qualityProfileName: "Any",
				connectionGeneration: source.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(source),
				template: { userId: "user-1" },
				instance: { userId: "user-1" },
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(409);
		expect(mockPrisma.templateQualityProfileMapping.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("does not migrate ARR state to a distinct endpoint", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr-a:7878",
		});
		const distinct = makeInstance({
			id: "inst-2",
			service: "RADARR",
			baseUrl: "http://radarr-b:7878",
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source, distinct]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.templateQualityProfileMapping.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.instanceQualityProfileOverride.updateMany).not.toHaveBeenCalled();
	});

	it("does not migrate saved ARR state to a distinct endpoint that reuses credentials", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr-a:7878",
			connectionGeneration: 2,
		});
		const distinct = makeInstance({
			id: "inst-2",
			service: "RADARR",
			baseUrl: "http://radarr-b:7878",
			connectionGeneration: 5,
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source, distinct]);
		mockPrisma.templateQualityProfileMapping.findMany.mockResolvedValue([
			{
				id: "mapping-source",
				instanceId: source.id,
				templateId: "template-1",
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "notify",
				managedCustomFormatsCaptured: false,
				managedCustomFormats: null,
				connectionGeneration: source.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(source),
				template: { userId: "user-1" },
				instance: { userId: "user-1" },
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(409);
		expect(mockPrisma.templateQualityProfileMapping.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("rejects alias deletion when duplicate mappings disagree about deployment authority", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "SONARR",
			baseUrl: "http://sonarr:8989",
			connectionGeneration: 2,
		});
		const survivor = makeInstance({
			id: "inst-2",
			service: "SONARR",
			baseUrl: "http://sonarr:8989/",
			connectionGeneration: 5,
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source, survivor]);
		mockPrisma.templateQualityProfileMapping.findMany.mockResolvedValue([
			{
				id: "mapping-source",
				instanceId: source.id,
				templateId: "template-1",
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "auto",
				managedCustomFormatsCaptured: true,
				managedCustomFormats: '[{"resourceId":7}]',
				connectionGeneration: source.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(source),
				template: { userId: "user-1" },
				instance: { userId: "user-1" },
			},
			{
				id: "mapping-survivor",
				instanceId: survivor.id,
				templateId: "template-1",
				qualityProfileId: 4,
				qualityProfileName: "Any",
				syncStrategy: "notify",
				managedCustomFormatsCaptured: false,
				managedCustomFormats: null,
				connectionGeneration: survivor.connectionGeneration,
				connectionStateToken: createDeploymentConnectionStateToken(survivor),
				template: { userId: "user-1" },
				instance: { userId: "user-1" },
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).message).toContain("conflicting deployment authority");
		expect(mockPrisma.templateQualityProfileMapping.deleteMany).not.toHaveBeenCalled();
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("keeps active deployment ownership instead of cascading it during alias deletion", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr:7878",
		});
		const survivor = makeInstance({
			id: "inst-2",
			service: "RADARR",
			baseUrl: "http://radarr:7878/",
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source, survivor]);
		mockPrisma.templateDeploymentHistory.findMany.mockResolvedValue([
			{
				id: "deployment-1",
				status: "SUCCESS",
				rolledBack: false,
				undeployStatus: null,
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).message).toContain("recovery");
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("keeps snapshotless uncertain audit evidence during ARR alias deletion", async () => {
		mockPrisma.trashSyncHistory.findMany.mockResolvedValueOnce([
			{
				id: "uncertain-sync",
				status: "UNCERTAIN",
				rolledBack: false,
				rollbackStatus: null,
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(409);
		expect(JSON.parse(res.payload).message).toContain("recovery");
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("cascades terminal deployment audit rows when deleting an ARR alias", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr:7878",
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source]);
		mockPrisma.trashSyncHistory.findMany.mockResolvedValueOnce([
			{
				id: "sync-1",
				status: "SUCCESS",
				rolledBack: true,
				rollbackStatus: "COMPLETED",
			},
		]);
		mockPrisma.templateDeploymentHistory.findMany.mockResolvedValueOnce([
			{
				id: "deployment-1",
				status: "SUCCESS",
				rolledBack: true,
				undeployStatus: "COMPLETED",
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.serviceInstance.findFirst).toHaveBeenCalledWith({
			where: {
				id: source.id,
				userId: "user-1",
				OR: expect.arrayContaining([
					{ trashSchedules: { some: {} } },
					{ standaloneCFDeployments: { some: {} } },
					{
						namingDeployHistory: {
							some: {
								status: { in: ["PENDING", "SUCCESS"] },
								rolledBack: false,
							},
						},
					},
				]),
			},
			select: { id: true },
		});
		const durableStateWhere = mockPrisma.serviceInstance.findFirst.mock.calls[0]?.[0]?.where;
		expect(durableStateWhere?.OR).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ trashSyncHistory: expect.anything() }),
				expect.objectContaining({ deploymentHistory: expect.anything() }),
			]),
		);
		expect(mockPrisma.serviceInstance.delete).toHaveBeenCalledWith({
			where: { id: source.id, userId: "user-1" },
		});
	});

	it("cascades a backup-less sync audit after explicit manual resolution", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr:7878",
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source]);
		mockPrisma.trashSyncHistory.findMany.mockResolvedValueOnce([
			{
				id: "sync-manually-resolved",
				status: "FAILED",
				backupId: null,
				rolledBack: false,
				rollbackStatus: "MANUALLY_RESOLVED",
			},
		]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.serviceInstance.delete).toHaveBeenCalledWith({
			where: { id: source.id, userId: "user-1" },
		});
	});

	it("never migrates ARR state to another user's equivalent alias", async () => {
		const source = makeInstance({
			id: "inst-1",
			service: "RADARR",
			baseUrl: "http://radarr:7878",
		});
		const otherUserAlias = makeInstance({
			id: "other-inst",
			userId: "user-2",
			service: "RADARR",
			baseUrl: "http://radarr:7878/",
		});
		mockRequireInstance.mockResolvedValue(source);
		mockPrisma.serviceInstance.findMany.mockResolvedValue([source, otherUserAlias]);

		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.serviceInstance.findMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { userId: "user-1", service: "RADARR" } }),
		);
		expect(mockPrisma.templateQualityProfileMapping.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.instanceQualityProfileOverride.updateMany).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// POST /services/test-connection — SSRF guard
// ===========================================================================

describe("POST /services/test-connection", () => {
	it("calls connection tester with valid http URL", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "http://sonarr:8989",
				apiKey: "test-key",
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(200);
		expect(mockTestConnection).toHaveBeenCalledWith("http://sonarr:8989", "test-key", "sonarr");
	});

	it("passes Tautulli through to its dedicated connection tester", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "http://tautulli:8181",
				apiKey: "tautulli-api-key",
				service: "tautulli",
			},
		});

		expect(res.statusCode).toBe(200);
		expect(mockTestConnection).toHaveBeenCalledWith(
			"http://tautulli:8181",
			"tautulli-api-key",
			"tautulli",
		);
	});

	it("rejects non-http scheme (SSRF prevention)", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "file:///etc/passwd",
				apiKey: "test-key",
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toBe("Invalid URL scheme");

		// Connection tester should NOT have been called
		expect(mockTestConnection).not.toHaveBeenCalled();
	});

	it("rejects URL-embedded credentials with guidance to use dedicated fields", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "https://user:pass@sonarr.example.test",
				apiKey: "test-key",
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(400);
		expect(res.payload).toMatch(/HTTP Basic Auth fields/i);
		expect(mockTestConnection).not.toHaveBeenCalled();
	});

	it("rejects HTTP Basic Auth for Jellyfin because modern auth uses Authorization", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "https://jellyfin.example.test",
				apiKey: "jellyfin-key",
				service: "jellyfin",
				httpAuth: { username: "proxy-user", password: "proxy-pass" },
			},
		});
		expect(res.statusCode).toBe(400);
		expect(res.payload).toMatch(/not supported for jellyfin/i);
		expect(mockTestConnection).not.toHaveBeenCalled();
	});

	it("rejects invalid service type", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "http://sonarr:8989",
				apiKey: "test-key",
				service: "not-a-real-service",
			},
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toBe("Invalid service type");
		expect(mockTestConnection).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// POST /tags — upsert
// ===========================================================================

describe("POST /tags", () => {
	it("creates a new tag and returns 201", async () => {
		const res = await injectAuthenticated("POST", "/tags", {
			body: { name: "anime" },
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);
		expect(body.tag.name).toBe("anime");

		expect(mockPrisma.serviceTag.upsert).toHaveBeenCalledWith({
			where: { name: "anime" },
			update: {},
			create: { name: "anime" },
		});
	});
});

// ===========================================================================
// DELETE /tags/:id — ownership check
// ===========================================================================

describe("DELETE /tags/:id", () => {
	it("returns 404 when user has no instance using the tag", async () => {
		mockPrisma.serviceInstanceTag.findFirst.mockResolvedValue(null);

		const res = await injectAuthenticated("DELETE", "/tags/tag-1");

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toBe("Tag not found");
		expect(mockPrisma.serviceTag.delete).not.toHaveBeenCalled();
	});

	it("deletes tag when user has an instance using it", async () => {
		mockPrisma.serviceInstanceTag.findFirst.mockResolvedValue({
			tagId: "tag-1",
			instanceId: "inst-1",
		});

		const res = await injectAuthenticated("DELETE", "/tags/tag-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.serviceTag.delete).toHaveBeenCalledWith({
			where: { id: "tag-1" },
		});
	});
});
