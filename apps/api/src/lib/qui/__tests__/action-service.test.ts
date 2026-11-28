/**
 * Unit tests for the Phase 4.1 qui action service.
 *
 * What this test pins:
 *  - **Audit-log granularity is per-hash.** A bulk pause of N hashes
 *    must write N rows (one (hash, action) pair each), not a single row
 *    with a JSON array. Future refactors that "optimize" to one row per
 *    bulk call break the per-torrent history surface.
 *  - **Pending→success transition records `completedAt`.** Operators
 *    rely on this to distinguish "request in flight" from "completed
 *    quickly" when the route returns immediately.
 *  - **Ambiguous qUI errors retain claims and mark rows uncertain.** A lost
 *    response may follow partial application; retry is held until resolved.
 *  - **Empty hashes returns no-op success.** Defensive against future
 *    callers; route schema currently rejects but contract belongs here.
 */

import type { FastifyBaseLogger } from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { executeQuiAction } from "../action-service.js";
import type { QuiClient } from "../client-factory.js";

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);
const HASH_C = "c".repeat(40);

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

type ActionFixture = {
	userId: string;
	serviceInstanceId: string;
	qbitInstanceId: number;
	torrentHash: string;
	attemptId: string;
	status?: string;
	[key: string]: unknown;
};

function matchesActionFixture(row: ActionFixture, where: Record<string, unknown>) {
	return Object.entries(where).every(([key, expected]) => {
		if (typeof expected === "object" && expected !== null && "in" in expected) {
			return Array.isArray(expected.in) && expected.in.includes(row[key]);
		}
		return row[key] === expected;
	});
}

function makeApp() {
	const rows: ActionFixture[] = [];
	const claims = new Map<string, ActionFixture>();
	const createMany = vi.fn().mockImplementation(async ({ data }: { data: ActionFixture[] }) => {
		rows.push(...data.map((row) => ({ ...row })));
		return { count: data.length };
	});
	const updateMany = vi
		.fn()
		.mockImplementation(
			async ({
				where,
				data,
			}: {
				where: Record<string, unknown>;
				data: Record<string, unknown>;
			}) => {
				const matching = rows.filter((row) => matchesActionFixture(row, where));
				for (const row of matching) Object.assign(row, data);
				return { count: matching.length };
			},
		);
	const claimCreateMany = vi
		.fn()
		.mockImplementation(async ({ data }: { data: ActionFixture[] }) => {
			if (data.some((row) => claims.has(row.torrentHash))) {
				throw Object.assign(new Error("unique claim conflict"), { code: "P2002" });
			}
			for (const row of data) claims.set(row.torrentHash, { ...row });
			return { count: data.length };
		});
	const claimDeleteMany = vi
		.fn()
		.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
			const matching = [...claims.values()].filter((row) => matchesActionFixture(row, where));
			for (const row of matching) claims.delete(row.torrentHash);
			return { count: matching.length };
		});
	const findMany = vi
		.fn()
		.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
			rows.filter((row) => matchesActionFixture(row, where)).map((row) => ({ ...row })),
		);
	const claimFindMany = vi
		.fn()
		.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
			[...claims.values()]
				.filter((row) => matchesActionFixture(row, where))
				.map((row) => ({ ...row })),
		);
	const tx = {
		quiActionLog: { createMany, updateMany, findMany },
		quiActionClaim: {
			createMany: claimCreateMany,
			deleteMany: claimDeleteMany,
			findMany: claimFindMany,
		},
	};
	const $transaction = vi.fn().mockImplementation(async (callback) => {
		const previousRows = rows.map((row) => ({ ...row }));
		const previousClaims = new Map([...claims].map(([hash, row]) => [hash, { ...row }]));
		try {
			return await callback(tx);
		} catch (error) {
			rows.splice(0, rows.length, ...previousRows);
			claims.clear();
			for (const [hash, row] of previousClaims) claims.set(hash, row);
			throw error;
		}
	});
	return {
		log: silentLog,
		prisma: {
			quiActionLog: { updateMany },
			$transaction,
		},
		__createMany: createMany,
		__claimCreateMany: claimCreateMany,
		__claimDeleteMany: claimDeleteMany,
		__claimFindMany: claimFindMany,
		__findMany: findMany,
		__updateMany: updateMany,
		__transaction: $transaction,
	} as any;
}

function makeClient(overrides: Partial<QuiClient> = {}): QuiClient {
	return {
		getTorrentsByHash: vi.fn().mockImplementation(async (hash: string) => [
			{ hash, instanceId: 7 },
			{ hash, instanceId: 3 },
		]),
		getTorrentByHash: vi.fn().mockResolvedValue(null),
		getTrackers: vi.fn().mockResolvedValue([]),
		getTrackerIcons: vi.fn().mockResolvedValue({}),
		getTrackerCustomizations: vi.fn().mockResolvedValue([]),
		getCrossSeedMatches: vi.fn().mockResolvedValue([]),
		listInstances: vi.fn().mockResolvedValue([
			{ id: 7, connected: true, isActive: true },
			{ id: 3, connected: true, isActive: true },
		]),
		listAllTorrents: vi.fn().mockResolvedValue([]),
		listTorrentInventory: vi.fn().mockResolvedValue({ torrents: [], complete: true }),
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
		getTransferInfo: vi.fn(),
		getFileMediaInfo: vi.fn(),
		getReannounceCandidates: vi.fn().mockResolvedValue([]),
		renameTorrent: vi.fn().mockResolvedValue(undefined),
		addTrackers: vi.fn().mockResolvedValue(undefined),
		removeTrackers: vi.fn().mockResolvedValue(undefined),
		editTracker: vi.fn().mockResolvedValue(undefined),
		ensureNotificationTarget: vi.fn().mockResolvedValue({ id: 1 }),
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
			hashes: [HASH_A, HASH_B, HASH_C],
			action: "pause",
		});

		expect(result.status).toBe("success");
		expect(result.logRowCount).toBe(3);
		expect(app.__transaction).toHaveBeenCalledTimes(3);
		expect(app.__createMany.mock.calls[0]?.[0].data).toHaveLength(3);
		expect(app.__claimCreateMany.mock.calls[0]?.[0].data).toHaveLength(3);
		// The first write locks the owned pending rows; the second records success.
		expect(app.__updateMany).toHaveBeenCalledTimes(2);
		const lockArgs = app.__updateMany.mock.calls[0]?.[0];
		expect(lockArgs.where).toMatchObject({
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			attemptId: expect.any(String),
			status: "pending",
		});
		expect(lockArgs.data).toEqual({ status: "pending" });
		const updateArgs = app.__updateMany.mock.calls[1]?.[0];
		expect(updateArgs.where.attemptId).toEqual(expect.any(String));
		expect(updateArgs.data.status).toBe("success");
		expect(updateArgs.data.completedAt).toBeInstanceOf(Date);
		expect(app.__claimDeleteMany).toHaveBeenCalledOnce();
	});

	it.each([
		["absent", []],
		["mismatched", [{ torrentHash: HASH_B }]],
	])("does not dispatch when final claim ownership is %s", async (_case, claimRows) => {
		const app = makeApp();
		const client = makeClient();
		app.__claimFindMany.mockResolvedValueOnce(claimRows);
		const result = await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: [HASH_A],
			action: "pause",
		});
		expect(result.status).toBe("audit_unsettled");
		expect(result.error).toContain("No qUI command was dispatched");
		expect(client.bulkAction).not.toHaveBeenCalled();
		expect(app.__claimDeleteMany).not.toHaveBeenCalled();
		expect(app.__claimFindMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				serviceInstanceId: "svc-qui-1",
				qbitInstanceId: 7,
				attemptId: app.__claimCreateMany.mock.calls[0][0].data[0].attemptId,
			},
			select: { torrentHash: true },
		});
		expect(app.__updateMany).not.toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "success" }) }),
		);
	});

	it("leaves the audit row pending when the upstream outcome is uncertain", async () => {
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
			hashes: [HASH_A],
			action: "pause",
		});

		// A response loss does not prove qUI failed before applying the action.
		expect(result.status).toBe("uncertain");
		expect(result.error).toContain("inspect My Actions");
		// Audit row count still records intent — 1 row was created and held.
		expect(result.logRowCount).toBe(1);
		expect(app.__updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: "uncertain" } }),
		);
		expect(app.__claimDeleteMany).not.toHaveBeenCalled();
	});

	it("keeps every bulk audit row pending when qUI applies only part before response loss", async () => {
		const app = makeApp();
		const applied: string[] = [];
		const client = makeClient({
			bulkAction: vi.fn().mockImplementation(async ({ hashes }: { hashes: string[] }) => {
				applied.push(hashes[0]!);
				throw new Error("response lost after partial application");
			}),
		});
		const result = await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: [HASH_A, HASH_B],
			action: "pause",
		});
		expect(applied).toEqual([HASH_A]);
		expect(result.status).toBe("uncertain");
		expect(result.logRowCount).toBe(2);
		expect(app.__createMany.mock.calls[0]?.[0].data).toHaveLength(2);
		expect(app.__updateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: { status: "uncertain" } }),
		);
		expect(app.__claimDeleteMany).not.toHaveBeenCalled();
	});

	it("refuses file deletion when shared-storage ownership cannot be proven", async () => {
		const app = makeApp();
		const client = makeClient();
		const result = await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: [HASH_A],
			action: "delete",
			payload: { deleteFiles: true },
		});
		expect(result).toEqual({
			logRowCount: 0,
			status: "failed",
			error: "qUI file deletion is unavailable until shared-storage ownership is verified",
		});
		expect(client.bulkAction).not.toHaveBeenCalled();
		expect(app.__transaction).not.toHaveBeenCalled();
	});

	it("rejects an internally supplied action override before claiming or auditing", async () => {
		const app = makeApp();
		const client = makeClient();
		const result = await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: [HASH_A],
			action: "pause",
			payload: { action: "deleteWithFiles", selectAll: true } as never,
		});
		expect(result).toMatchObject({ logRowCount: 0, status: "failed" });
		expect(client.bulkAction).not.toHaveBeenCalled();
		expect(app.__transaction).not.toHaveBeenCalled();
	});

	it("refuses a selected hash whose execution-time qBit identity does not match", async () => {
		const app = makeApp();
		const client = makeClient({
			getTorrentsByHash: vi.fn().mockResolvedValue([{ hash: HASH_A, instanceId: 3 }]),
		});

		const result = await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: [HASH_A],
			action: "delete",
			payload: { deleteFiles: false },
		});

		expect(result).toEqual({
			logRowCount: 0,
			status: "failed",
			error: "qUI action target could not be verified",
		});
		expect(client.bulkAction).not.toHaveBeenCalled();
		expect(app.__transaction).not.toHaveBeenCalled();
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
			hashes: [HASH_A],
			action: "setTags",
			payload: { tags: "verified,seedonly" },
		});
		expect(app.__createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						payload: JSON.stringify({ tags: "verified,seedonly" }),
						action: "setTags",
					}),
				],
			}),
		);

		vi.clearAllMocks();

		// Without tags (pause/resume/etc.): payload should be null
		await executeQuiAction({
			app,
			client,
			userId: "user-1",
			serviceInstanceId: "svc-qui-1",
			qbitInstanceId: 7,
			hashes: [HASH_A],
			action: "pause",
		});
		expect(app.__createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						payload: null,
						action: "pause",
					}),
				],
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
			hashes: [HASH_A],
			action: "recheck",
		});

		// Tenant isolation invariant: every audit row carries the caller's
		// userId AND the resolved ServiceInstance id. If a future refactor
		// drops one of these, cross-user audit-log enumeration becomes
		// possible — this assertion is the canary.
		expect(app.__createMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: [
					expect.objectContaining({
						userId: "user-42",
						serviceInstanceId: "svc-qui-foo",
						qbitInstanceId: 3,
						torrentHash: HASH_A,
						action: "recheck",
					}),
				],
			}),
		);
	});
});
