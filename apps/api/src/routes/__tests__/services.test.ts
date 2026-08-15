import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

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
} = vi.hoisted(() => ({
	mockRequireInstance: vi.fn(),
	mockTestConnection: vi.fn().mockResolvedValue({ success: true, version: "4.0.0" }),
	mockBuildUpdateData: vi.fn().mockReturnValue({}),
	mockUpsertTags: vi.fn().mockResolvedValue([]),
	mockUpdateInstanceTags: vi.fn().mockResolvedValue(undefined),
	mockInvalidatePulseCache: vi.fn(),
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

vi.mock("../pulse.js", () => ({
	invalidatePulseCache: (...args: unknown[]) => mockInvalidatePulseCache(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { acquireCleanupOperationGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { registerServiceRoutes } from "../services.js";
import { InstanceNotFoundError } from "../../lib/errors.js";
import {
	setupAuthInjection,
	createInjectAuthenticated,
	createMockEncryptor,
	registerTestErrorHandler,
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
		plexCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		plexEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		tautulliCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		cacheRefreshStatus: {
			deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
			upsert: vi.fn().mockResolvedValue({}),
		},
	};
	return {
		...prisma,
		$transaction: vi.fn(
			async (callback: (transaction: typeof prisma) => Promise<unknown>) => await callback(prisma),
		),
	};
}

// ---------------------------------------------------------------------------
// Fastify app setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();

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
		let jellyfinCleared = false;
		let jellyfinEpisodesCleared = false;
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
		mockPrisma.jellyfinCache.deleteMany.mockImplementation(async () => {
			if (!plexEpisodesCleared) throw new Error("Plex episode cache must clear first");
			calls.push("jellyfin");
			await Promise.resolve();
			jellyfinCleared = true;
		});
		mockPrisma.jellyfinEpisodeCache.deleteMany.mockImplementation(async () => {
			if (!jellyfinCleared) throw new Error("Jellyfin cache must clear first");
			calls.push("jellyfin_episode");
			await Promise.resolve();
			jellyfinEpisodesCleared = true;
		});
		mockPrisma.tautulliCache.deleteMany.mockImplementation(async () => {
			if (!jellyfinEpisodesCleared) throw new Error("Jellyfin episode cache must clear first");
			calls.push("tautulli");
			await Promise.resolve();
			tautulliCleared = true;
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
			"jellyfin",
			"jellyfin_episode",
			"tautulli",
			"status",
		]);
		expect(mockPrisma.cacheRefreshStatus.upsert).toHaveBeenCalledTimes(2);
		expect(mockPrisma.cacheRefreshStatus.upsert).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: {
					instanceId_cacheType: { instanceId: "inst-1", cacheType: "plex" },
				},
				create: expect.objectContaining({
					lastResult: "error",
					lastAttemptResult: "error",
					lastAttemptErrorMessage: "Provider connection changed; refresh required",
				}),
			}),
		);
		expect(mockPrisma.cacheRefreshStatus.upsert).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: {
					instanceId_cacheType: { instanceId: "inst-1", cacheType: "plex_episode" },
				},
			}),
		);
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
		expect(mockPrisma.cacheRefreshStatus.upsert).toHaveBeenCalledTimes(1);
		expect(mockPrisma.cacheRefreshStatus.upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { instanceId_cacheType: { instanceId: "inst-1", cacheType: "tautulli" } },
			}),
		);
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

	it("advances generation for an ARR endpoint replacement", async () => {
		const existing = makeInstance({ service: "RADARR", baseUrl: "http://radarr:7878" });
		mockRequireInstance.mockResolvedValue(existing);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://replacement-radarr:7878" });
		mockPrisma.serviceInstance.findMany.mockResolvedValue([existing]);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeInstance({ service: "RADARR", baseUrl: "http://replacement-radarr:7878" }),
		);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://replacement-radarr:7878" },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.serviceInstance.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "inst-1", userId: "user-1" },
				data: expect.objectContaining({ connectionGeneration: { increment: 1 } }),
			}),
		);
	});

	it("blocks an ARR endpoint replacement while a deployment still owns upstream state", async () => {
		const existing = makeInstance({ service: "RADARR", baseUrl: "http://radarr:7878" });
		mockRequireInstance.mockResolvedValue(existing);
		mockBuildUpdateData.mockReturnValue({ baseUrl: "http://replacement-radarr:7878" });
		mockPrisma.serviceInstance.findMany.mockResolvedValue([existing]);
		mockPrisma.templateDeploymentHistory.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
			{
				status: "SUCCESS",
				backupId: "backup-active",
				backup: makeAppliedDeploymentBackup(),
			},
		]);

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { baseUrl: "http://replacement-radarr:7878" },
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).message).toContain("active deployment ownership");
		expect(mockPrisma.serviceInstance.updateMany).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// DELETE /services/:id
// ===========================================================================

describe("DELETE /services/:id", () => {
	it("deletes owned instance and returns 204", async () => {
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
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});

	it("refuses to race an ARR deletion with active cleanup work", async () => {
		const releaseMutation = acquireCleanupOperationGuard();
		try {
			const res = await injectAuthenticated("DELETE", "/services/inst-1");
			expect(res.statusCode).toBe(409);
			expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
		} finally {
			releaseMutation();
		}
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

	it("rejects HTTP Basic Auth for Tracearr", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "https://tracearr.example.test",
				apiKey: "trr_pub_key",
				service: "tracearr",
				httpAuth: { username: "proxy-user", password: "proxy-pass" },
			},
		});
		expect(res.statusCode).toBe(400);
		expect(res.payload).toMatch(/not supported for Tracearr/i);
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
