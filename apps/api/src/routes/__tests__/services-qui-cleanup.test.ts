/**
 * Regression tests for qui-cache cleanup integration in services.ts.
 *
 * Background: the qui torrent-list SWR cache and the inode-based
 * hardlink index are both keyed by qui instance id. When an instance is
 * removed (DELETE) or made unreachable from this app (disabled, or
 * service type changed away from QUI), the cache entries should be
 * dropped — otherwise they linger for the rest of the process lifetime
 * (TTL-on-read only; nothing reads a deleted/disabled instance).
 *
 * A code-review pass on PR #475 flagged that `services-lifecycle.test.ts`
 * and `services.test.ts` covered the broad lifecycle but never asserted
 * the cleanup wiring actually fires. A future refactor that drops the
 * `invalidateTorrentListCache` + `clearFileIdIndexCache` calls (or
 * moves them out of the qui-type branch) would silently leak megabytes
 * of cached torrent data and inode indexes keyed to dead instances.
 * This file pins the wiring.
 */

import Fastify from "fastify";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ----------------------------------------------------------------------
// Module-level mocks — hoisted so they apply before `services.js` imports
// ----------------------------------------------------------------------

const {
	mockRequireInstance,
	mockBuildUpdateData,
	mockUpsertTags,
	mockUpdateInstanceTags,
	mockFormatServiceInstance,
	mockInvalidateTorrentListCache,
	mockClearFileIdIndexCache,
} = vi.hoisted(() => ({
	mockRequireInstance: vi.fn(),
	mockBuildUpdateData: vi.fn().mockReturnValue({}),
	mockUpsertTags: vi.fn().mockResolvedValue([]),
	mockUpdateInstanceTags: vi.fn().mockResolvedValue(undefined),
	mockFormatServiceInstance: vi.fn().mockImplementation((instance: Record<string, unknown>) => ({
		id: instance.id,
		service: (instance.service as string | undefined)?.toLowerCase() ?? "qui",
		label: instance.label ?? "Test Instance",
		enabled: instance.enabled ?? true,
	})),
	mockInvalidateTorrentListCache: vi.fn(),
	mockClearFileIdIndexCache: vi.fn(),
}));

vi.mock("../../lib/arr/instance-helpers.js", () => ({
	requireInstance: (...args: unknown[]) => mockRequireInstance(...args),
}));

vi.mock("../../lib/services/connection-tester.js", () => ({
	testServiceConnection: vi.fn().mockResolvedValue({ success: true }),
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

// Mock the qui-cache invalidation functions so we can spy on calls.
vi.mock("../../lib/qui/torrent-list-cache.js", () => ({
	invalidateTorrentListCache: (...args: unknown[]) => mockInvalidateTorrentListCache(...args),
}));

vi.mock("../../lib/library-sync/infohash-backfill-by-inode.js", () => ({
	clearFileIdIndexCache: (...args: unknown[]) => mockClearFileIdIndexCache(...args),
}));

// ----------------------------------------------------------------------
// Imports — must come after vi.mock declarations
// ----------------------------------------------------------------------

import { withQuiObservationTopologyGuard } from "../../lib/qui/observation-topology-guard.js";
import { createDeploymentEndpointKey } from "../../lib/trash-guides/deployment-target.js";
import { registerServiceRoutes } from "../services.js";
import {
	createInjectAuthenticated,
	createMockEncryptor,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// ----------------------------------------------------------------------
// Test data
// ----------------------------------------------------------------------

function makeQuiInstance(overrides: Record<string, unknown> = {}) {
	return {
		id: "qui-instance-1",
		userId: "user-1",
		service: "QUI",
		label: "My qui",
		baseUrl: "http://qui:7476",
		encryptedApiKey: "encrypted-key",
		encryptionIv: "mock-iv",
		enabled: true,
		isDefault: false,
		createdAt: new Date(),
		updatedAt: new Date(),
		tags: [],
		...overrides,
	};
}

function makeSonarrInstance(overrides: Record<string, unknown> = {}) {
	return makeQuiInstance({
		id: "sonarr-instance-1",
		service: "SONARR",
		label: "My Sonarr",
		baseUrl: "http://sonarr:8989",
		...overrides,
	});
}

function createMockPrisma() {
	const prisma = {
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn(),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		libraryCache: {
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		episodeFileCache: {
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		plexCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		plexEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		tautulliCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		jellyfinEpisodeCache: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		cacheRefreshStatus: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		templateQualityProfileMapping: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		instanceQualityProfileOverride: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		trashSyncHistory: {
			findMany: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
		},
		templateDeploymentHistory: {
			findMany: vi.fn().mockResolvedValue([]),
			count: vi.fn().mockResolvedValue(0),
		},
		serviceTag: {
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn(),
			delete: vi.fn(),
		},
		serviceInstanceTag: { findFirst: vi.fn().mockResolvedValue(null) },
		$transaction: vi.fn(),
	};
	prisma.$transaction.mockImplementation(
		async (operation: (tx: typeof prisma) => Promise<unknown>) => await operation(prisma),
	);
	return prisma;
}

const clearedQuiObservation = {
	torrentState: null,
	torrentRatio: null,
	torrentSyncedAt: null,
};

function expectDurableQuiObservationsCleared() {
	expect(mockPrisma.libraryCache.updateMany).toHaveBeenCalledWith({
		where: { instance: { userId: "user-1" } },
		data: clearedQuiObservation,
	});
	expect(mockPrisma.episodeFileCache.updateMany).toHaveBeenCalledWith({
		where: { instance: { userId: "user-1" } },
		data: clearedQuiObservation,
	});
}

// ----------------------------------------------------------------------
// Fastify app setup
// ----------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();
	mockPrisma = createMockPrisma();
	mockBuildUpdateData.mockReturnValue({});

	app = Fastify();
	app.decorate("prisma", mockPrisma);
	app.decorate("encryptor", createMockEncryptor("decrypted"));
	app.decorate("arrClientFactory", {
		createConnectionCredentialIdentity: vi.fn((instance) =>
			JSON.stringify([instance.encryptedApiKey, instance.encryptedHttpAuthCredentials ?? null]),
		),
	} as never);
	app.decorate("deploymentExecutor", {
		runWithEndpointMutation: vi.fn(async (userId, target, _operation, callback) =>
			callback(createDeploymentEndpointKey(userId, target)),
		),
	} as never);
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

describe("POST /services — qUI topology cleanup", () => {
	it("clears prior user-wide observations when qUI-B is added alongside qUI-A", async () => {
		mockPrisma.serviceInstance.findMany.mockResolvedValue([makeQuiInstance()]);
		mockPrisma.serviceInstance.create.mockResolvedValue(
			makeQuiInstance({ id: "qui-instance-2", label: "qUI B" }),
		);

		const res = await injectAuthenticated("POST", "/services", {
			body: {
				label: "qUI B",
				baseUrl: "http://qui-b:7476",
				apiKey: "qui-b-api-key",
				service: "qui",
			},
		});

		expect(res.statusCode).toBe(201);
		expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
		expectDurableQuiObservationsCleared();
	});
});

// ----------------------------------------------------------------------
// DELETE /services/:id — should always invalidate (no-op for non-qui)
// ----------------------------------------------------------------------

describe("DELETE /services/:id — qui-cache cleanup", () => {
	it("clears qUI-A observations when it is deleted while qUI-B remains enabled", async () => {
		mockRequireInstance.mockResolvedValue(makeQuiInstance());
		mockPrisma.serviceInstance.findMany.mockResolvedValue([
			makeQuiInstance({ id: "qui-instance-2", label: "qUI B" }),
		]);
		mockPrisma.serviceInstance.delete.mockResolvedValue(undefined);

		const res = await injectAuthenticated("DELETE", "/services/qui-instance-1");

		expect(res.statusCode, res.body).toBe(204);
		expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
		expectDurableQuiObservationsCleared();
		expect(mockInvalidateTorrentListCache).toHaveBeenCalledTimes(1);
		expect(mockInvalidateTorrentListCache).toHaveBeenCalledWith("qui-instance-1");
		expect(mockClearFileIdIndexCache).toHaveBeenCalledTimes(1);
		expect(mockClearFileIdIndexCache).toHaveBeenCalledWith("qui-instance-1");
	});

	it("also calls cache cleanup for non-QUI instances (cheap no-op there)", async () => {
		// Behavior choice: rather than guard the call on instance type
		// (extra Prisma lookup at delete time), we let the cache functions
		// no-op when the id isn't a known key. The route stays uniform
		// across service types; the cache functions handle the no-op.
		mockRequireInstance.mockResolvedValue(makeSonarrInstance());
		mockPrisma.serviceInstance.delete.mockResolvedValue(undefined);

		const res = await injectAuthenticated("DELETE", "/services/sonarr-instance-1");

		expect(res.statusCode, res.body).toBe(204);
		expect(mockPrisma.$transaction).not.toHaveBeenCalled();
		expect(mockPrisma.libraryCache.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.episodeFileCache.updateMany).not.toHaveBeenCalled();
		// Both still fire — they're a no-op for non-key ids.
		expect(mockInvalidateTorrentListCache).toHaveBeenCalledWith("sonarr-instance-1");
		expect(mockClearFileIdIndexCache).toHaveBeenCalledWith("sonarr-instance-1");
	});

	it("calls cache cleanup AFTER prisma.delete (so a delete failure aborts cleanup)", async () => {
		// Order matters: if we cleaned the cache first then the delete
		// failed, the cache would refresh against the still-existing
		// instance and re-populate immediately. The route's order is
		// delete → cleanup, which keeps cache + DB in sync.
		mockRequireInstance.mockResolvedValue(makeQuiInstance());
		const callOrder: string[] = [];
		mockPrisma.serviceInstance.delete.mockImplementation(async () => {
			callOrder.push("prisma.delete");
		});
		mockInvalidateTorrentListCache.mockImplementation(() => {
			callOrder.push("invalidateTorrentListCache");
		});

		await injectAuthenticated("DELETE", "/services/qui-instance-1");

		expect(callOrder).toEqual(["prisma.delete", "invalidateTorrentListCache"]);
	});
});

// ----------------------------------------------------------------------
// PUT /services/:id — should invalidate ONLY when QUI becomes inert
// ----------------------------------------------------------------------

describe("PUT /services/:id — qUI topology cleanup", () => {
	it("waits for an in-flight old-topology writer, then clears its observation", async () => {
		mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: true }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance({ enabled: false }));
		const writerStarted = deferred();
		const releaseWriter = deferred();
		const callOrder: string[] = [];
		mockPrisma.libraryCache.updateMany.mockImplementation(async (args) => {
			callOrder.push(args.data.torrentState === null ? "topology-clear" : "old-topology-write");
			return { count: 1 };
		});

		const oldTopologyWriter = withQuiObservationTopologyGuard("user-1", async () => {
			writerStarted.resolve();
			await releaseWriter.promise;
			await mockPrisma.libraryCache.updateMany({
				where: { instance: { userId: "user-1" } },
				data: {
					torrentState: "seeding",
					torrentRatio: 1,
					torrentSyncedAt: new Date(),
				},
			});
		});
		await writerStarted.promise;

		const responsePromise = injectAuthenticated("PUT", "/services/qui-instance-1", {
			body: { enabled: false },
		});
		await vi.waitFor(() => expect(mockBuildUpdateData).toHaveBeenCalledOnce());
		expect(mockPrisma.$transaction).not.toHaveBeenCalled();

		releaseWriter.resolve();
		await oldTopologyWriter;
		const res = await responsePromise;

		expect(res.statusCode, res.body).toBe(200);
		expect(callOrder).toEqual(["old-topology-write", "topology-clear"]);
		expect(mockPrisma.libraryCache.updateMany).toHaveBeenLastCalledWith({
			where: { instance: { userId: "user-1" } },
			data: clearedQuiObservation,
		});
	});

	it("invalidates process caches before releasing the topology guard", async () => {
		mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: true }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance({ enabled: false }));
		const clearStarted = deferred();
		const releaseClear = deferred();
		const events: string[] = [];
		mockPrisma.libraryCache.updateMany.mockImplementation(async () => {
			events.push("durable-clear");
			clearStarted.resolve();
			await releaseClear.promise;
			return { count: 1 };
		});
		mockInvalidateTorrentListCache.mockImplementation(() => {
			events.push("process-cache-clear");
		});

		const responsePromise = injectAuthenticated("PUT", "/services/qui-instance-1", {
			body: { enabled: false },
		});
		await clearStarted.promise;
		const nextObserver = withQuiObservationTopologyGuard("user-1", async () => {
			events.push("next-observer");
		});
		releaseClear.resolve();

		const [response] = await Promise.all([responsePromise, nextObserver]);

		expect(response.statusCode).toBe(200);
		expect(events).toEqual(["durable-clear", "process-cache-clear", "next-observer"]);
	});

	it("clears qUI-A observations when it is disabled while qUI-B remains enabled", async () => {
		mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: true }));
		mockPrisma.serviceInstance.findMany.mockResolvedValue([
			makeQuiInstance({ id: "qui-instance-2", label: "qUI B" }),
		]);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance({ enabled: false }));

		const res = await injectAuthenticated("PUT", "/services/qui-instance-1", {
			body: { enabled: false },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
		expectDurableQuiObservationsCleared();
		expect(mockInvalidateTorrentListCache).toHaveBeenCalledWith("qui-instance-1");
		expect(mockClearFileIdIndexCache).toHaveBeenCalledWith("qui-instance-1");
	});

	it("clears observations when qUI-A is enabled while qUI-B remains enabled", async () => {
		mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: false }));
		mockPrisma.serviceInstance.findMany.mockResolvedValue([
			makeQuiInstance({ id: "qui-instance-2", label: "qUI B" }),
		]);
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance({ enabled: true }));

		const res = await injectAuthenticated("PUT", "/services/qui-instance-1", {
			body: { enabled: true },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
		expectDurableQuiObservationsCleared();
		expect(mockInvalidateTorrentListCache).toHaveBeenCalledWith("qui-instance-1");
		expect(mockClearFileIdIndexCache).toHaveBeenCalledWith("qui-instance-1");
	});

	it("does NOT drop caches when a QUI instance is updated but stays enabled", async () => {
		mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: true }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeQuiInstance({ enabled: true, label: "Renamed qui" }),
		);

		const res = await injectAuthenticated("PUT", "/services/qui-instance-1", {
			body: { label: "Renamed qui" },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.$transaction).not.toHaveBeenCalled();
		expect(mockPrisma.libraryCache.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.episodeFileCache.updateMany).not.toHaveBeenCalled();
		expect(mockInvalidateTorrentListCache).not.toHaveBeenCalled();
		expect(mockClearFileIdIndexCache).not.toHaveBeenCalled();
	});

	it("does NOT drop caches when a QUI instance was already disabled and stays disabled", async () => {
		// `existing.enabled === true` is the trigger. Updating an
		// already-disabled instance doesn't re-fire cleanup.
		mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: false }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance({ enabled: false }));

		const res = await injectAuthenticated("PUT", "/services/qui-instance-1", {
			body: { label: "Tweak" },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.$transaction).not.toHaveBeenCalled();
		expect(mockPrisma.libraryCache.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.episodeFileCache.updateMany).not.toHaveBeenCalled();
		expect(mockInvalidateTorrentListCache).not.toHaveBeenCalled();
		expect(mockClearFileIdIndexCache).not.toHaveBeenCalled();
	});

	it("drops caches when service type changes away from QUI", async () => {
		// Edge case: an operator changes the service type on an existing
		// instance via PUT. The instance is no longer QUI, so the old
		// qui-keyed caches should be dropped.
		mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: true }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(
			makeSonarrInstance({ id: "qui-instance-1" }),
		);

		const res = await injectAuthenticated("PUT", "/services/qui-instance-1", {
			body: { service: "sonarr" },
		});

		expect(res.statusCode, res.body).toBe(200);
		expectDurableQuiObservationsCleared();
		expect(mockInvalidateTorrentListCache).toHaveBeenCalledWith("qui-instance-1");
		expect(mockClearFileIdIndexCache).toHaveBeenCalledWith("qui-instance-1");
	});

	it("does NOT drop caches when updating a non-QUI instance", async () => {
		// A Sonarr instance's PUT shouldn't touch qui caches at all.
		mockRequireInstance.mockResolvedValue(makeSonarrInstance({ enabled: true }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeSonarrInstance({ enabled: false }));

		const res = await injectAuthenticated("PUT", "/services/sonarr-instance-1", {
			body: { enabled: false },
		});

		expect(res.statusCode).toBe(200);
		expect(mockPrisma.$transaction).not.toHaveBeenCalled();
		expect(mockPrisma.libraryCache.updateMany).not.toHaveBeenCalled();
		expect(mockPrisma.episodeFileCache.updateMany).not.toHaveBeenCalled();
		expect(mockInvalidateTorrentListCache).not.toHaveBeenCalled();
		expect(mockClearFileIdIndexCache).not.toHaveBeenCalled();
	});

	it.each([
		["endpoint", { baseUrl: "http://replacement-qui:7476" }],
		["API credential", { apiKey: "replacement-api-key" }],
		["filesystem access", { hasLocalFilesystemAccess: false }],
		["path mapping", { pathPrefix: "/downloads>/data" }],
	] as const)(
		"clears qUI-A observations when its %s changes while qUI-B remains enabled",
		async (_label, body) => {
			mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: true }));
			mockPrisma.serviceInstance.findMany.mockResolvedValue([
				makeQuiInstance({ id: "qui-instance-2", label: "qUI B" }),
			]);
			mockPrisma.serviceInstance.findFirst.mockResolvedValue(
				makeQuiInstance({ enabled: true, ...body }),
			);

			const res = await injectAuthenticated("PUT", "/services/qui-instance-1", { body });

			expect(res.statusCode).toBe(200);
			expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
			expectDurableQuiObservationsCleared();
			expect(mockInvalidateTorrentListCache).toHaveBeenCalledWith("qui-instance-1");
			expect(mockClearFileIdIndexCache).toHaveBeenCalledWith("qui-instance-1");
		},
	);
});
