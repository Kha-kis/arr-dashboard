import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockListQuiInstances, mockCreateQuiClient } = vi.hoisted(() => ({
	mockListQuiInstances: vi.fn(),
	mockCreateQuiClient: vi.fn(),
}));

vi.mock("../instance-helpers.js", () => ({
	listQuiInstances: mockListQuiInstances,
}));

vi.mock("../client-factory.js", () => ({
	createQuiClient: mockCreateQuiClient,
}));

import { runQuiTorrentStateSync } from "../torrent-state-sync.js";

const silentLog: FastifyBaseLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	fatal: vi.fn(),
	trace: vi.fn(),
	child: vi.fn(() => silentLog),
	level: "info",
	silent: vi.fn(),
} as unknown as FastifyBaseLogger;

function makeApp(overrides: Record<string, unknown> = {}) {
	const updateMany = vi.fn().mockResolvedValue({ count: 1 });
	const findMany = vi.fn().mockResolvedValue([]);
	return {
		log: silentLog,
		prisma: {
			libraryCache: { updateMany },
			serviceInstance: { findMany },
		},
		__updateMany: updateMany,
		__findMany: findMany,
		...overrides,
		// biome-ignore lint/suspicious/noExplicitAny: test-shim
	} as any;
}

describe("runQuiTorrentStateSync", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("no-ops when no users have qui instances", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([]);

		const result = await runQuiTorrentStateSync(app);

		expect(result.usersScanned).toBe(0);
		expect(result.instancesScanned).toBe(0);
		expect(mockListQuiInstances).not.toHaveBeenCalled();
		expect(app.__updateMany).not.toHaveBeenCalled();
	});

	it("normalizes states and updates LibraryCache rows by infoHash", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", label: "main qui", baseUrl: "http://qui" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi.fn().mockResolvedValue([
				{ hash: "AAAA", state: "stalledUP", ratio: 1.5 },
				{ hash: "BBBB", state: "stalledDL", ratio: 0.1 },
				{ hash: "CCCC", state: "downloading", ratio: 0.5 },
			]),
		});

		const result = await runQuiTorrentStateSync(app);

		expect(result.torrentsSeen).toBe(3);
		// 3 per-torrent updates + 1 stale-state cleanup updateMany at the end of
		// the user's loop = 4 total. The cleanup is a single bulk call regardless
		// of how many stale rows exist.
		expect(app.__updateMany).toHaveBeenCalledTimes(4);
		// SECURITY: each per-torrent updateMany must include `instance: { userId }`.
		// Without this, a torrent shared between users would have its state
		// overwritten across user boundaries.
		const perTorrentCalls = app.__updateMany.mock.calls.filter(
			(call: [{ where: Record<string, unknown> }]) =>
				typeof (call[0]?.where as { infoHash?: unknown })?.infoHash === "string",
		);
		expect(perTorrentCalls.length).toBe(3);
		for (const call of perTorrentCalls) {
			expect(call[0].where.instance).toEqual({ userId: "user-1" });
		}
		// stalledUP must collapse to "seeding" (not "stalled") via the normalizer.
		expect(app.__updateMany).toHaveBeenCalledWith({
			where: { infoHash: "aaaa", instance: { userId: "user-1" } },
			data: expect.objectContaining({ torrentState: "seeding", torrentRatio: 1.5 }),
		});
		expect(app.__updateMany).toHaveBeenCalledWith({
			where: { infoHash: "bbbb", instance: { userId: "user-1" } },
			data: expect.objectContaining({ torrentState: "stalled_dl", torrentRatio: 0.1 }),
		});
	});

	it("isolates per-instance failures: one bad instance does not abort the run", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-bad", userId: "user-1", label: "broken", baseUrl: "http://bad" },
			{ id: "qui-good", userId: "user-1", label: "ok", baseUrl: "http://ok" },
		]);
		mockCreateQuiClient.mockImplementation((_app: unknown, instance: { id: string }) => ({
			listAllTorrents:
				instance.id === "qui-bad"
					? vi.fn().mockRejectedValue(new Error("kaboom"))
					: vi.fn().mockResolvedValue([{ hash: "DDDD", state: "uploading", ratio: 2.0 }]),
		}));

		const result = await runQuiTorrentStateSync(app);

		expect(result.errors).toBe(1);
		expect(result.instancesScanned).toBe(2);
		expect(result.torrentsSeen).toBe(1); // only the good instance contributed
		expect(app.__updateMany).toHaveBeenCalledOnce();
	});

	it("nulls torrentState for rows whose hash is no longer in qui's response (stale-state cleanup)", async () => {
		// User had a torrent, deleted it from qui. Without cleanup, the row's
		// torrentState would stay at last-known value forever — the badge would
		// keep showing "Seeding 1.24×" even though the torrent is gone, which
		// actively misleads the user.
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", label: "main", baseUrl: "http://qui" },
		]);
		// qui now reports ONE remaining torrent (hash AAAA). The stale row whose
		// hash was, say, BBBB, must get nulled.
		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi
				.fn()
				.mockResolvedValue([{ hash: "AAAA", state: "uploading", ratio: 1.5 }]),
		});

		const result = await runQuiTorrentStateSync(app);

		// updateMany was called twice for this user: once for the present torrent,
		// once for the stale-state cleanup at the end of the user's loop.
		const cleanupCall = app.__updateMany.mock.calls.find(
			(call: [{ where: Record<string, unknown> }]) =>
				call[0]?.where?.torrentState !== undefined && call[0]?.where?.infoHash !== undefined,
		);
		expect(cleanupCall, "expected a stale-state cleanup updateMany call").toBeDefined();
		// The cleanup must scope to: this user, rows that HAD a state, rows synced
		// before this run, and rows whose hash is NOT in the seen set.
		const cleanupWhere = cleanupCall[0].where as {
			instance: { userId: string };
			torrentState: { not: null };
			torrentSyncedAt: { lt: Date };
			infoHash: { notIn: string[] };
		};
		expect(cleanupWhere.instance.userId).toBe("user-1");
		expect(cleanupWhere.torrentState).toEqual({ not: null });
		expect(cleanupWhere.torrentSyncedAt.lt).toBeInstanceOf(Date);
		expect(cleanupWhere.infoHash.notIn).toEqual(["aaaa"]); // lower-cased
		expect(result.rowsCleared).toBeGreaterThanOrEqual(0);
	});

	it("isolates the cleanup decision per-user — one user's error does not suppress another user's cleanup", async () => {
		// Without per-user error tracking, user A's qui failure would suppress
		// stale-state cleanup for user B (and every user that runs after them
		// in the same tick), leaving deleted torrents showing as still-seeding
		// indefinitely. The fix tracks errors per-user.
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([
			{ userId: "user-a" },
			{ userId: "user-b" },
		]);
		mockListQuiInstances.mockImplementation(async (_app: unknown, userId: string) => {
			if (userId === "user-a") {
				return [{ id: "qui-a", userId, label: "broken", baseUrl: "http://a" }];
			}
			return [{ id: "qui-b", userId, label: "ok", baseUrl: "http://b" }];
		});
		mockCreateQuiClient.mockImplementation((_app: unknown, instance: { id: string }) => ({
			listAllTorrents:
				instance.id === "qui-a"
					? vi.fn().mockRejectedValue(new Error("kaboom"))
					: vi.fn().mockResolvedValue([{ hash: "BBBB", state: "uploading", ratio: 1.0 }]),
		}));

		const result = await runQuiTorrentStateSync(app);

		expect(result.errors).toBe(1);
		// User B should still have their cleanup updateMany called even though
		// user A's sync errored — both users' decisions are independent.
		const cleanupCalls = app.__updateMany.mock.calls.filter(
			(call: [{ where: Record<string, unknown> }]) =>
				(call[0]?.where as { torrentState?: unknown })?.torrentState !== undefined,
		);
		// Exactly one cleanup call expected: user B's. User A is skipped.
		expect(cleanupCalls).toHaveLength(1);
		expect((cleanupCalls[0][0].where as { instance: { userId: string } }).instance.userId).toBe(
			"user-b",
		);
	});

	it("does NOT null stale rows when the sync run had errors (incomplete view)", async () => {
		// If a qui instance failed mid-run, we have an incomplete picture of
		// which torrents exist — over-clearing would show users falsely "missing"
		// torrents. Cleanup must be skipped on error.
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-bad", userId: "user-1", label: "broken", baseUrl: "http://bad" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi.fn().mockRejectedValue(new Error("kaboom")),
		});

		await runQuiTorrentStateSync(app);

		// No cleanup updateMany call should have happened — only updates from the
		// inner Promise.all loop, but here zero torrents → zero updateMany calls.
		const cleanupCall = app.__updateMany.mock.calls.find(
			(call: [{ where: Record<string, unknown> }]) =>
				call[0]?.where?.torrentState !== undefined && call[0]?.where?.infoHash !== undefined,
		);
		expect(cleanupCall, "cleanup must be skipped when sync had errors").toBeUndefined();
	});

	it("coerces non-finite ratio to null (qBit's `inf` / `-1` for never-completed)", async () => {
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", label: "main", baseUrl: "http://qui" },
		]);
		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi
				.fn()
				.mockResolvedValue([{ hash: "EEEE", state: "uploading", ratio: Number.POSITIVE_INFINITY }]),
		});

		await runQuiTorrentStateSync(app);

		expect(app.__updateMany).toHaveBeenCalledWith({
			where: { infoHash: "eeee", instance: { userId: "user-1" } },
			data: expect.objectContaining({ torrentRatio: null }),
		});
	});
});
