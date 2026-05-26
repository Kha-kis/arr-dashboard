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

import { registerServiceRoutes } from "../services.js";
import {
	createInjectAuthenticated,
	createMockEncryptor,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

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
	return {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn(),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		serviceTag: {
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn(),
			delete: vi.fn(),
		},
		serviceInstanceTag: { findFirst: vi.fn().mockResolvedValue(null) },
	};
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

// ----------------------------------------------------------------------
// DELETE /services/:id — should always invalidate (no-op for non-qui)
// ----------------------------------------------------------------------

describe("DELETE /services/:id — qui-cache cleanup", () => {
	it("calls invalidateTorrentListCache + clearFileIdIndexCache for a QUI instance", async () => {
		mockRequireInstance.mockResolvedValue(makeQuiInstance());
		mockPrisma.serviceInstance.delete.mockResolvedValue(undefined);

		const res = await injectAuthenticated("DELETE", "/services/qui-instance-1");

		expect(res.statusCode).toBe(204);
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

		expect(res.statusCode).toBe(204);
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

describe("PUT /services/:id — qui-cache cleanup on disable / service change", () => {
	it("drops caches when a QUI instance is disabled (enabled: true → false)", async () => {
		mockRequireInstance.mockResolvedValue(makeQuiInstance({ enabled: true }));
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeQuiInstance({ enabled: false }));

		const res = await injectAuthenticated("PUT", "/services/qui-instance-1", {
			body: { enabled: false },
		});

		expect(res.statusCode).toBe(200);
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

		expect(res.statusCode).toBe(200);
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
		expect(mockInvalidateTorrentListCache).not.toHaveBeenCalled();
		expect(mockClearFileIdIndexCache).not.toHaveBeenCalled();
	});
});
