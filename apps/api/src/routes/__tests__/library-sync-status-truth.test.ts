import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLibrarySyncScheduler } from "../../lib/library-sync/index.js";
import { registerLibraryRoutes } from "../library.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const lastFullSync = new Date("2026-09-27T20:00:00Z");

function createPrisma() {
	const persistedStatus = {
		lastFullSync,
		lastSyncDurationMs: 1000,
		syncInProgress: true,
		lastError: "private provider detail" as string | null,
		itemCount: 1559,
		pollingEnabled: true,
		pollingIntervalMins: 15,
	};
	const tables = {
		serviceInstance: {
			findMany: vi.fn(async ({ where }: { where: { userId: string; service: unknown } }) => {
				expect(where.userId).toBe("user-1");
				return where.service === "QUI"
					? []
					: [
							{
								id: "arr-1",
								label: "Test ARR",
								service: "RADARR",
								librarySyncStatus: persistedStatus,
							},
						];
			}),
		},
		libraryCache: {
			count: vi.fn().mockResolvedValue(1),
			findMany: vi.fn().mockResolvedValue([]),
		},
		librarySyncStatus: {
			findMany: vi.fn().mockResolvedValue([persistedStatus]),
		},
	};
	return {
		...tables,
		$transaction: vi.fn(async <T>(read: (tx: typeof tables) => Promise<T>) => read(tables)),
	};
}

describe("Library sync status truth", () => {
	let app: ReturnType<typeof Fastify>;
	let prisma: ReturnType<typeof createPrisma>;
	let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

	beforeEach(async () => {
		prisma = createPrisma();
		app = Fastify();
		app.decorate("prisma", prisma);
		app.decorate("dbProvider", "sqlite");
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		await app.register(registerLibraryRoutes);
		await app.ready();
		injectAuthenticated = createInjectAuthenticated(app);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await app.close();
	});

	it("does not report a persisted stale flag as an active cached-library sync", async () => {
		vi.spyOn(getLibrarySyncScheduler(), "isInstanceSyncing").mockReturnValue(false);

		const response = await injectAuthenticated("GET", "/library");

		expect(response.statusCode).toBe(200);
		expect(response.json().syncStatus).toMatchObject({
			isCached: true,
			syncInProgress: false,
			lastSync: lastFullSync.toISOString(),
		});
	});

	it("reports a generic interruption without exposing the old provider error", async () => {
		vi.spyOn(getLibrarySyncScheduler(), "isInstanceSyncing").mockReturnValue(false);

		const response = await injectAuthenticated("GET", "/library/sync/status");

		expect(response.statusCode).toBe(200);
		const status = response.json().instances[0].syncStatus;
		expect(status.syncInProgress).toBe(false);
		expect(status.lastFullSync).toBe(lastFullSync.toISOString());
		expect(status.lastError).toMatch(/interrupted/i);
		expect(status.lastError).not.toContain("private provider detail");
	});

	it("reports an actually active sync even before its persisted flag is written", async () => {
		vi.spyOn(getLibrarySyncScheduler(), "isInstanceSyncing").mockReturnValue(true);
		prisma.serviceInstance.findMany.mockResolvedValueOnce([
			{
				id: "arr-1",
				label: "Test ARR",
				service: "RADARR",
				librarySyncStatus: {
					lastFullSync,
					lastSyncDurationMs: 1000,
					syncInProgress: false,
					lastError: null,
					itemCount: 1559,
					pollingEnabled: true,
					pollingIntervalMins: 15,
				},
			},
		]);

		const response = await injectAuthenticated("GET", "/library/sync/status");

		expect(response.statusCode).toBe(200);
		expect(response.json().instances[0].syncStatus.syncInProgress).toBe(true);
	});

	it("does not claim a zero-cache sync is active when its trigger did not start", async () => {
		const scheduler = getLibrarySyncScheduler();
		vi.spyOn(scheduler, "isInstanceSyncing").mockReturnValue(false);
		vi.spyOn(scheduler, "triggerSync").mockResolvedValue(null);
		prisma.libraryCache.count.mockResolvedValue(0);

		const response = await injectAuthenticated("GET", "/library");

		expect(response.statusCode).toBe(200);
		expect(response.json().syncStatus).toMatchObject({
			isCached: false,
			syncInProgress: false,
		});
	});

	it("recognizes a completed zero-item library without triggering another initial sync", async () => {
		const scheduler = getLibrarySyncScheduler();
		const trigger = vi.spyOn(scheduler, "triggerSync").mockResolvedValue(null);
		vi.spyOn(scheduler, "isInstanceSyncing").mockReturnValue(false);
		prisma.libraryCache.count.mockResolvedValue(0);
		prisma.librarySyncStatus.findMany.mockResolvedValue([
			{
				instanceId: "arr-1",
				lastFullSync,
				itemCount: 0,
				lastError: null,
				syncInProgress: false,
			},
		]);

		const response = await injectAuthenticated("GET", "/library");

		expect(response.statusCode).toBe(200);
		expect(response.json().syncStatus).toMatchObject({
			isCached: true,
			lastSync: lastFullSync.toISOString(),
			syncInProgress: false,
			totalCachedItems: 0,
		});
		expect(trigger).not.toHaveBeenCalled();
	});

	it("retains last-known zero-item evidence after a later sync failure", async () => {
		const scheduler = getLibrarySyncScheduler();
		const trigger = vi.spyOn(scheduler, "triggerSync").mockResolvedValue(null);
		vi.spyOn(scheduler, "isInstanceSyncing").mockReturnValue(false);
		prisma.libraryCache.count.mockResolvedValue(0);
		prisma.librarySyncStatus.findMany.mockResolvedValue([
			{
				instanceId: "arr-1",
				lastFullSync,
				itemCount: 0,
				lastError: "private provider detail",
				syncInProgress: false,
			},
		]);

		const response = await injectAuthenticated("GET", "/library");

		expect(response.statusCode).toBe(200);
		expect(response.json().syncStatus).toMatchObject({
			isCached: true,
			lastSync: lastFullSync.toISOString(),
			syncInProgress: false,
			totalCachedItems: 0,
		});
		expect(trigger).not.toHaveBeenCalled();
	});
});
