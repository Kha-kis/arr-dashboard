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
	const serviceInstanceFindMany = vi.fn().mockResolvedValue([]);
	// libraryCache.findMany is used by the chunked stale-state cleanup
	// (P2029-fix): fetch candidate rows, filter in JS, then updateMany by
	// id batches. Default empty so tests that don't care about cleanup
	// behavior keep working.
	const libraryCacheFindMany = vi.fn().mockResolvedValue([]);
	return {
		log: silentLog,
		prisma: {
			libraryCache: { updateMany, findMany: libraryCacheFindMany },
			serviceInstance: { findMany: serviceInstanceFindMany },
		},
		__updateMany: updateMany,
		__findMany: serviceInstanceFindMany,
		__libraryCacheFindMany: libraryCacheFindMany,
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
		// 3 per-torrent updateMany calls. The stale-state cleanup now uses
		// findMany-then-chunked-updateMany (P2029 fix); with the default
		// empty findMany result, no cleanup updateMany fires. So we expect
		// exactly 3 per-torrent calls.
		expect(app.__updateMany).toHaveBeenCalledTimes(3);
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
		//
		// Cleanup is now done as findMany-then-chunked-updateMany (P2029 fix):
		//   1. Find rows with torrentState != null AND torrentSyncedAt < runStart
		//   2. Filter in JS for rows whose hash isn't in seenHashesThisRun
		//   3. updateMany by id batches of <=500 to null those rows
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", label: "main", baseUrl: "http://qui" },
		]);
		// qui now reports ONE remaining torrent (hash AAAA). The stale row whose
		// hash was BBBB must get nulled.
		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi
				.fn()
				.mockResolvedValue([{ hash: "AAAA", state: "uploading", ratio: 1.5 }]),
		});
		// Two candidate stale rows: one currently-seen (AAAA, must SKIP), one
		// stale (BBBB, must be cleared). The new code's JS filter must keep
		// only BBBB; the updateMany must use that exact id list.
		app.prisma.libraryCache.findMany.mockResolvedValue([
			{ id: "row-aaaa", infoHash: "aaaa" }, // present in qui — skip
			{ id: "row-bbbb", infoHash: "bbbb" }, // missing from qui — clear
		]);

		const result = await runQuiTorrentStateSync(app);

		// Stale candidates pulled via findMany scoped to the right user.
		// NB: libraryCache.findMany is now called twice per user — once for
		// the Phase 2.5 prior-state snapshot (where has `infoHash`, no
		// `torrentState`) and once for stale-cleanup (where has
		// `torrentState: { not: null }`). Select the cleanup call by shape.
		const findManyCall = app.__libraryCacheFindMany.mock.calls.find(
			(call: [{ where?: Record<string, unknown> }]) =>
				(call[0]?.where as { torrentState?: unknown })?.torrentState !== undefined,
		);
		expect(findManyCall).toBeDefined();
		const findManyWhere = findManyCall[0].where as {
			instance: { userId: string };
			torrentState: { not: null };
			torrentSyncedAt: { lt: Date };
		};
		expect(findManyWhere.instance.userId).toBe("user-1");
		expect(findManyWhere.torrentState).toEqual({ not: null });
		expect(findManyWhere.torrentSyncedAt.lt).toBeInstanceOf(Date);

		// The cleanup updateMany must use `id: { in: [BBBB-row only] }`. AAAA
		// is still in qui so it must NOT be cleared. This pins the JS-side
		// filter (the whole point of the rewrite vs the old notIn).
		const cleanupCall = app.__updateMany.mock.calls.find(
			(call: [{ where: Record<string, unknown> }]) =>
				(call[0]?.where as { id?: { in?: unknown } })?.id?.in !== undefined,
		);
		expect(cleanupCall, "expected a chunked-id cleanup updateMany call").toBeDefined();
		const cleanupWhere = cleanupCall[0].where as { id: { in: string[] } };
		expect(cleanupWhere.id.in).toEqual(["row-bbbb"]);
		expect(result.rowsCleared).toBeGreaterThanOrEqual(0);
	});

	it("chunks the cleanup updateMany when stale-id list exceeds the safe parameter cap (P2029 guard)", async () => {
		// Production crash repro: this user has thousands of stale rows
		// after qui prunes a large batch of torrents. The naive
		// `updateMany({ where: { infoHash: { notIn: [10k hashes] } } })`
		// crashed with P2029 every scheduler tick. The fix chunks the
		// id-list into batches of <=500. Pin the chunking behavior here
		// so future refactors can't silently regress it.
		const app = makeApp();
		app.prisma.serviceInstance.findMany.mockResolvedValue([{ userId: "user-1" }]);
		mockListQuiInstances.mockResolvedValue([
			{ id: "qui-1", userId: "user-1", label: "main", baseUrl: "http://qui" },
		]);
		// The cleanup branch only runs when at least one torrent IS seen
		// AND there are no instance errors — otherwise we'd skip cleanup
		// out of "incomplete view" caution. So we report ONE seen torrent
		// and ensure the 1,072 stale rows have DIFFERENT hashes.
		mockCreateQuiClient.mockReturnValue({
			listAllTorrents: vi
				.fn()
				.mockResolvedValue([{ hash: "ZZZZ", state: "uploading", ratio: 1.0 }]),
		});
		// 1,072 stale rows (One Piece-scale). Old code: single updateMany
		// crashes. New code: 3 chunked updateMany calls (500+500+72).
		const staleRows = Array.from({ length: 1072 }, (_, i) => ({
			id: `stale-${i}`,
			infoHash: `hash-${i}`.padEnd(40, "0"),
		}));
		app.prisma.libraryCache.findMany.mockResolvedValue(staleRows);

		await runQuiTorrentStateSync(app);

		// Three chunks: [500, 500, 72]
		const idBatchCalls = app.__updateMany.mock.calls.filter(
			(call: [{ where: Record<string, unknown> }]) =>
				(call[0]?.where as { id?: { in?: unknown } })?.id?.in !== undefined,
		);
		expect(idBatchCalls).toHaveLength(3);
		expect((idBatchCalls[0][0].where as { id: { in: string[] } }).id.in).toHaveLength(500);
		expect((idBatchCalls[1][0].where as { id: { in: string[] } }).id.in).toHaveLength(500);
		expect((idBatchCalls[2][0].where as { id: { in: string[] } }).id.in).toHaveLength(72);
		// Union of all batches = the full stale-id set, no loss or duplication.
		const allClearedIds = idBatchCalls.flatMap(
			(c: [{ where: Record<string, unknown> }]) => (c[0].where as { id: { in: string[] } }).id.in,
		);
		expect(allClearedIds).toHaveLength(1072);
		expect(new Set(allClearedIds).size).toBe(1072);
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

		// Make sure user B has a stale candidate to clean — otherwise the
		// new chunked-update path stays silent and we'd be testing nothing.
		app.prisma.libraryCache.findMany.mockResolvedValue([
			{ id: "user-b-stale-1", infoHash: "ffff" }, // not in user-b's seen set (BBBB)
		]);

		const result = await runQuiTorrentStateSync(app);

		expect(result.errors).toBe(1);
		// User A is skipped (errors > 0 → over-clearing risk). User B is NOT
		// skipped. Cleanup is findMany + id-batch updateMany. The Phase 2.5
		// prior-state snapshot also calls libraryCache.findMany (once per
		// user, before any cleanup), so we filter to the STALE-CLEANUP call
		// by its `torrentState: { not: null }` shape: exactly one (user B's),
		// AND exactly one id-batch updateMany call (user B's).
		const cleanupFindManyCalls = app.__libraryCacheFindMany.mock.calls.filter(
			(call: [{ where?: Record<string, unknown> }]) =>
				(call[0]?.where as { torrentState?: unknown })?.torrentState !== undefined,
		);
		expect(cleanupFindManyCalls).toHaveLength(1);
		expect(
			(cleanupFindManyCalls[0][0].where as { instance: { userId: string } }).instance.userId,
		).toBe("user-b");

		const idBatchCalls = app.__updateMany.mock.calls.filter(
			(call: [{ where: Record<string, unknown> }]) =>
				(call[0]?.where as { id?: { in?: unknown } })?.id?.in !== undefined,
		);
		expect(idBatchCalls).toHaveLength(1);
		expect((idBatchCalls[0][0].where as { id: { in: string[] } }).id.in).toEqual([
			"user-b-stale-1",
		]);
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
