/**
 * Unit tests for the Phase 4.1 qui action service.
 *
 * What this test pins:
 *  - **Audit-log granularity is per-hash.** A bulk pause of N hashes
 *    must write N rows (one (hash, action) pair each), not a single row
 *    with a JSON array. Future refactors that "optimize" to one row per
 *    bulk call break the per-torrent history surface — the assertion on
 *    `transaction.calls[0][0].length` catches that.
 *  - **Pending→success transition records `completedAt`.** Operators
 *    rely on this to distinguish "request in flight" from "completed
 *    quickly" when the route returns immediately.
 *  - **qui errors translate to `failed` rows, not thrown errors.** The
 *    service must NEVER let a qui exception propagate — the audit log
 *    is the single source of truth for outcome, and a thrown error
 *    leaves the database in an inconsistent state (rows stuck at
 *    `pending`).
 *  - **Empty hashes returns no-op success.** Defensive against future
 *    callers; route schema currently rejects but contract belongs here.
 */

import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeQuiAction } from "../action-service.js";
import type { QuiClient } from "../client-factory.js";

const silentLog = {
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

function makeApp(opts: { txReturn?: { id: string }[] } = {}) {
	const create = vi.fn();
	const updateMany = vi.fn().mockResolvedValue({ count: 0 });
	const $transaction = vi
		.fn()
		// $transaction(operations[]) — Prisma passes back the per-op resolved values.
		// Default: synthesize one created row per operation so the service can
		// collect their ids for the update step. Tests can override.
		.mockImplementation((ops: unknown[]) =>
			Promise.resolve(opts.txReturn ?? ops.map((_, i) => ({ id: `row-${i}` }))),
		);
	return {
		log: silentLog,
		prisma: {
			quiActionLog: { create, updateMany },
			$transaction,
		},
		__create: create,
		__updateMany: updateMany,
		__transaction: $transaction,
		// biome-ignore lint/suspicious/noExplicitAny: test-shim
	} as any;
}

function makeClient(overrides: Partial<QuiClient> = {}): QuiClient {
	return {
		getTorrentByHash: vi.fn().mockResolvedValue(null),
		getTrackers: vi.fn().mockResolvedValue([]),
		getTrackerIcons: vi.fn().mockResolvedValue({}),
		getTrackerCustomizations: vi.fn().mockResolvedValue([]),
		getCrossSeedMatches: vi.fn().mockResolvedValue([]),
		listInstances: vi.fn().mockResolvedValue([]),
		listAllTorrents: vi.fn().mockResolvedValue([]),
		testConnection: vi.fn().mockResolvedValue({ ok: true }),
		bulkAction: vi.fn().mockResolvedValue(undefined),
		getTorrentProperties: vi.fn().mockResolvedValue({
			additionDate: 0,
			completionDate: 0,
			comment: "",
			totalSize: 0,
			totalDownloaded: 0,
			totalUploaded: 0,
			shareRatio: 0,
			uploadSpeed: 0,
			downloadSpeed: 0,
			uploadLimit: 0,
			downloadLimit: 0,
			seedsActual: 0,
			peersActual: 0,
			eta: 0,
			ratioLimit: -2,
			seedingTimeLimit: -2,
			inactiveSeedingTimeLimit: -2,
			savePath: "",
		}),
		getTorrentFiles: vi.fn().mockResolvedValue([]),
		listCategories: vi.fn().mockResolvedValue([]),
		listTags: vi.fn().mockResolvedValue([]),
		getCapabilities: vi.fn(),
		renameTorrent: vi.fn().mockResolvedValue(undefined),
		addTrackers: vi.fn().mockResolvedValue(undefined),
		removeTrackers: vi.fn().mockResolvedValue(undefined),
		editTracker: vi.fn().mockResolvedValue(undefined),
		createNotificationTarget: vi.fn().mockResolvedValue({ id: 1 }),
		triggerDirScan: vi.fn().mockResolvedValue({
			runId: 1,
			directoryId: 1,
			directoryPath: "/data/media/movies",
			scanRoot: "/data/media/movies",
		}),
		...overrides,
	};
}

describe("executeQuiAction — per-hash audit granularity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("writes one pending row per hash, then transitions all to success", async () => {
		const app = makeApp();
		const client = makeClient();

		const result = await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: ["aaa", "bbb", "ccc"],
			action: "pause",
		});

		expect(result.status).toBe("success");
		expect(result.logRowCount).toBe(3);
		// $transaction was called with exactly 3 create operations
		expect(app.__transaction).toHaveBeenCalledOnce();
		const txOps = app.__transaction.mock.calls[0]?.[0];
		expect(txOps).toHaveLength(3);
		// One updateMany sweep for the success transition
		expect(app.__updateMany).toHaveBeenCalledOnce();
		const updateArgs = app.__updateMany.mock.calls[0]?.[0];
		expect(updateArgs.where.id.in).toEqual(["row-0", "row-1", "row-2"]);
		expect(updateArgs.data.status).toBe("success");
		expect(updateArgs.data.completedAt).toBeInstanceOf(Date);
	});

	it("translates qui errors to `failed` rows without throwing", async () => {
		const app = makeApp();
		const client = makeClient({
			bulkAction: vi
				.fn()
				.mockRejectedValue(new Error("qui request to /api/... failed: 502 Bad Gateway")),
		});

		const result = await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: ["aaa"],
			action: "pause",
		});

		// Service returns failed; it does NOT re-throw the qui error.
		expect(result.status).toBe("failed");
		expect(result.error).toMatch(/502 Bad Gateway/);
		// Audit row count still records intent — 1 pending row was created.
		expect(result.logRowCount).toBe(1);
		// updateMany was called with the failed transition (status + error + completedAt)
		const updateArgs = app.__updateMany.mock.calls[0]?.[0];
		expect(updateArgs.data.status).toBe("failed");
		expect(updateArgs.data.error).toMatch(/502 Bad Gateway/);
		expect(updateArgs.data.completedAt).toBeInstanceOf(Date);
	});

	it("returns no-op success on empty hashes (defensive contract)", async () => {
		const app = makeApp();
		const client = makeClient();

		const result = await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: [],
			action: "pause",
		});

		expect(result).toEqual({ logRowCount: 0, status: "success", error: null });
		expect(app.__transaction).not.toHaveBeenCalled();
		expect(client.bulkAction).not.toHaveBeenCalled();
	});

	it("stores `setTags` tag list as JSON payload, not other actions", async () => {
		const app = makeApp();
		const client = makeClient();

		// With tags: payload should be JSON.stringify({ tags })
		await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: ["aaa"],
			action: "setTags",
			payload: { tags: "verified,seedonly" },
		});
		const tagCreateOps = app.__transaction.mock.calls[0]?.[0] as Array<{ then?: unknown }>;
		// Each operation in the tx is a Prisma create call; the test uses mocks
		// so we re-derive what was *passed* to create() by introspecting the
		// generator. Simpler: just check that all create() calls saw the same
		// payload (since they were all enqueued through the same loop).
		expect(app.__create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					payload: JSON.stringify({ tags: "verified,seedonly" }),
					action: "setTags",
				}),
			}),
		);
		// (tagCreateOps is unused at runtime — referenced so the lint rule does
		// not flag the line; we keep it for clarity that the tx receives one
		// op per hash.)
		expect(tagCreateOps).toHaveLength(1);

		vi.clearAllMocks();

		// Without tags (pause/resume/etc.): payload should be null
		await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: ["aaa"],
			action: "pause",
		});
		expect(app.__create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					payload: null,
					action: "pause",
				}),
			}),
		);
	});

	it("scopes the audit row to the caller's (userId, serviceInstanceId)", async () => {
		const app = makeApp();
		const client = makeClient();

		await executeQuiAction({
			app,
			client,
			userId: "user-42",
			serviceInstanceId: "svc-qui-foo",
			qbitInstanceId: 3,
			hashes: ["aaa"],
			action: "recheck",
		});

		// Tenant isolation invariant: every audit row carries the caller's
		// userId AND the resolved ServiceInstance id. If a future refactor
		// drops one of these, cross-user audit-log enumeration becomes
		// possible — this assertion is the canary.
		expect(app.__create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					userId: "user-42",
					serviceInstanceId: "svc-qui-foo",
					qbitInstanceId: 3,
					torrentHash: "aaa",
					action: "recheck",
				}),
			}),
		);
	});
});
