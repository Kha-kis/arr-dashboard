import { describe, expect, it } from "vitest";
import {
	prepareNativeWatchGeneration,
	verifyPreparedNativeWatchGeneration,
} from "../jellyfin-native-watch-repository.js";

// These doubles stop at Prisma: the real staging/verification code drives every call.
function fixture(
	options: {
		failAt?: number;
		failPhase?: "request" | "callback" | "commit";
		cleanupBatches?: number;
	} = {},
) {
	const error = { code: "P2028", message: "private synthetic failure" };
	const input = {
		userId: "synthetic-owner",
		instanceId: "synthetic-instance",
		runId: "synthetic-run",
		cacheGenerationId: "synthetic-generation",
		preparationToken: "synthetic-token",
		connectionGeneration: 1,
		identityGeneration: 1,
		observedAt: new Date(0),
		expectedScopeCount: 1,
		candidates: [
			{
				userKeyDigest: "digest",
				libraryId: "library",
				jellyfinId: "episode",
				seriesId: "series",
				seasonNumber: 1,
				episodeNumber: 1,
				played: false,
				playCount: 0,
				lastPlayedAt: null,
			},
		],
		receipts: [
			{
				userKeyDigest: "digest",
				libraryId: "library",
				expectedRawCount: 1,
				observedRawCount: 1,
				exact: true,
				contentFingerprint: "a".repeat(64),
			},
		],
	};
	const trace: string[] = [];
	const rows: object[] = [];
	const receipts: object[] = [];
	const readSizes: number[] = [];
	const renewalRows: number[] = [];
	let transactions = 0;
	let rowDeletes = 0;
	let receiptDeletes = 0;
	let rowReadOffset = 0;
	const db = {
		jellyfinEpisodePreparation: {
			updateMany: async () => {
				trace.push("renew");
				renewalRows.push(rows.length);
				return { count: 1 };
			},
		},
		$executeRaw: async (strings: TemplateStringsArray) => {
			const sql = strings.join("?");
			if (sql.includes('DELETE FROM "jellyfin_native_watch_rows"')) {
				trace.push("row-delete");
				return rowDeletes++ < (options.cleanupBatches ?? 0) ? 1 : 0;
			}
			if (sql.includes('DELETE FROM "jellyfin_native_watch_scope_receipts"')) {
				trace.push("receipt-delete");
				return receiptDeletes++ < (options.cleanupBatches ?? 0) ? 1 : 0;
			}
			trace.push("write-intent");
			return 1;
		},
		jellyfinNativeWatchRow: {
			createMany: async ({ data }: { data: object[] }) => {
				trace.push("row-insert");
				rows.push(...data);
			},
		},
		jellyfinNativeWatchScopeReceipt: {
			createMany: async ({ data }: { data: object[] }) => {
				trace.push("receipt-insert");
				receipts.push(...data);
			},
			findMany: async () => {
				trace.push("receipt-read");
				return receipts;
			},
		},
		$queryRaw: async (query: { sql: string; values: unknown[] }) => {
			if (query.sql.includes('FROM "ServiceInstance" AS instance')) {
				trace.push("authority");
				return [{ expectedIdentity: "synthetic", unpublishedRun: 1, livePreparation: 1 }];
			}
			trace.push("row-read");
			const limit = Number(query.values.at(-1));
			readSizes.push(limit);
			const page = rows.slice(rowReadOffset, rowReadOffset + limit);
			rowReadOffset += page.length;
			return page;
		},
		$transaction: async (...args: [(tx: object) => Promise<unknown>, ...unknown[]]) => {
			expect(args).toHaveLength(1); // The original default timeout/options remain untouched.
			const index = ++transactions;
			trace.push("transaction-request");
			if (index === options.failAt && options.failPhase === "request") throw error;
			trace.push("transaction-entry");
			if (index === options.failAt && options.failPhase === "callback") {
				const original = db.$executeRaw;
				db.$executeRaw = async () => {
					throw error;
				};
				try {
					await args[0](db);
				} finally {
					db.$executeRaw = original;
				}
			} else await args[0](db);
			trace.push("transaction-commit");
			if (index === options.failAt && options.failPhase === "commit") throw error;
		},
	};
	return { db, input, trace, error, rows, receipts, readSizes, renewalRows };
}

describe("native-watch preparation transaction observation", () => {
	it.each([
		["missing row", [], "superseded"],
		[
			"duplicate rows",
			[
				{ expectedIdentity: "server", unpublishedRun: 1, livePreparation: 1 },
				{ expectedIdentity: "server", unpublishedRun: 1, livePreparation: 1 },
			],
			"superseded",
		],
		[
			"nonstring identity",
			[{ expectedIdentity: 1, unpublishedRun: 1, livePreparation: 1 }],
			"superseded",
		],
		[
			"string authority flag",
			[{ expectedIdentity: "server", unpublishedRun: "1", livePreparation: 1 }],
			"superseded",
		],
		[
			"boolean authority flag",
			[{ expectedIdentity: "server", unpublishedRun: true, livePreparation: 1 }],
			"superseded",
		],
		[
			"unknown authority flag",
			[{ expectedIdentity: "server", unpublishedRun: 2, livePreparation: 1 }],
			"superseded",
		],
		[
			"missing lease flag",
			[{ expectedIdentity: "server", unpublishedRun: 1 }],
			"lease is unavailable",
		],
		[
			"string lease flag",
			[{ expectedIdentity: "server", unpublishedRun: 1, livePreparation: "1" }],
			"lease is unavailable",
		],
		[
			"boolean lease flag",
			[{ expectedIdentity: "server", unpublishedRun: 1, livePreparation: true }],
			"lease is unavailable",
		],
	] as const)(
		"fails closed for %s from the metadata boundary",
		async (_name, metadata, message) => {
			const { input } = fixture();
			const db = { $queryRaw: async () => metadata };
			await expect(verifyPreparedNativeWatchGeneration(db as never, input)).rejects.toThrow(
				message,
			);
		},
	);

	it("accepts explicit bigint metadata flags", async () => {
		const { input } = fixture();
		const db = {
			$queryRaw: async (query: { sql: string }) =>
				query.sql.includes('FROM "ServiceInstance" AS instance')
					? [{ expectedIdentity: "server", unpublishedRun: 1n, livePreparation: 1n }]
					: [],
			jellyfinNativeWatchScopeReceipt: { findMany: async () => [] },
		};
		await expect(
			verifyPreparedNativeWatchGeneration(db as never, {
				...input,
				candidates: [],
				receipts: [],
				expectedScopeCount: 0,
			}),
		).resolves.toBeUndefined();
	});

	it("reports each original transaction through real commit without changing stage events or database calls", async () => {
		const baseline = fixture();
		const baselineStages: unknown[] = [];
		await prepareNativeWatchGeneration(baseline.db as never, baseline.input, (event) =>
			baselineStages.push(event),
		);
		const observed = fixture();
		const stages: unknown[] = [];
		const events: unknown[] = [];
		await prepareNativeWatchGeneration(
			observed.db as never,
			observed.input,
			(event) => stages.push(event),
			(event) => {
				events.push(event);
				observed.trace.push(`event-${event.phase}`);
			},
		);
		expect(events).toEqual(
			[
				"lease-checkpoint",
				"row-chunk",
				"receipt-chunk",
				"lease-checkpoint",
				"lease-checkpoint",
			].flatMap((kind) => [
				{ kind, phase: "requested" },
				{ kind, phase: "callback-entered" },
				{ kind, phase: "succeeded" },
			]),
		);
		expect(stages).toEqual(baselineStages);
		// Assert outside the best-effort observer: thrown assertions there are intentionally ignored.
		for (const [index, entry] of observed.trace.entries()) {
			if (entry === "event-requested")
				expect(observed.trace[index + 1]).toBe("transaction-request");
			if (entry === "event-callback-entered")
				expect(observed.trace[index - 1]).toBe("transaction-entry");
			if (entry === "event-succeeded") expect(observed.trace[index - 1]).toBe("transaction-commit");
		}
		expect(observed.trace.filter((entry) => !entry.startsWith("event-"))).toEqual(baseline.trace);
		expect(observed.trace.filter((entry) => entry === "transaction-request")).toHaveLength(5);
		expect(observed.trace.filter((entry) => entry === "write-intent")).toHaveLength(5);
		expect(observed.trace.filter((entry) => entry === "row-insert")).toHaveLength(1);
		expect(observed.trace.filter((entry) => entry === "receipt-insert")).toHaveLength(1);
		expect(observed.rows).toEqual(baseline.rows);
		expect(observed.receipts).toEqual(baseline.receipts);
	});

	it("budgets row writes separately from 500-receipt writes and 500-row verification pages", async () => {
		const { db, input, rows, receipts, readSizes } = fixture();
		const candidate = input.candidates[0]!;
		const receipt = input.receipts[0]!;
		input.candidates = Array.from({ length: 501 }, (_, index) => ({
			...candidate,
			libraryId: `library-${String(index).padStart(3, "0")}`,
		}));
		input.receipts = Array.from({ length: 501 }, (_, index) => ({
			...receipt,
			libraryId: `library-${String(index).padStart(3, "0")}`,
		}));
		input.expectedScopeCount = 501;
		const requested: string[] = [];
		const writes: Array<{ stage: string; count?: number }> = [];
		await prepareNativeWatchGeneration(
			db as never,
			input,
			(event) => {
				if (event.stage === "row-chunk-write" || event.stage === "receipt-chunk-write")
					writes.push(event);
			},
			(event) => {
				if (event.phase === "requested") requested.push(event.kind);
			},
		);
		expect(requested).toEqual([
			"lease-checkpoint",
			"row-chunk",
			"row-chunk",
			"row-chunk",
			"row-chunk",
			"row-chunk",
			"row-chunk",
			"receipt-chunk",
			"receipt-chunk",
			"lease-checkpoint",
			"lease-checkpoint",
		]);
		expect(writes).toEqual([
			...Array.from({ length: 15 }, () => ({ stage: "row-chunk-write", count: 100 })),
			{ stage: "row-chunk-write", count: 1 },
			{ stage: "row-chunk-write", count: 1 },
			{ stage: "row-chunk-write", count: 1 },
			{ stage: "receipt-chunk-write", count: 500 },
			{ stage: "receipt-chunk-write", count: 500 },
			{ stage: "receipt-chunk-write", count: 500 },
			{ stage: "receipt-chunk-write", count: 1 },
			{ stage: "receipt-chunk-write", count: 1 },
			{ stage: "receipt-chunk-write", count: 1 },
		]);
		expect(rows).toHaveLength(501);
		expect(receipts).toHaveLength(501);
		expect(readSizes).toEqual([500, 500]);
	});

	it("retains lease renewal after 5000 staged rows and 5000 verified rows", async () => {
		const { db, input, renewalRows, readSizes } = fixture();
		input.candidates = Array.from({ length: 5_501 }, (_, index) => ({
			...input.candidates[0]!,
			jellyfinId: `episode-${String(index).padStart(5, "0")}`,
		}));
		input.receipts[0]!.expectedRawCount = 5_501;
		input.receipts[0]!.observedRawCount = 5_501;
		await prepareNativeWatchGeneration(db as never, input);
		expect(renewalRows).toEqual([0, 0, 5_000, 5_501, 5_501, 5_501, 5_501]);
		expect(readSizes).toEqual(Array(12).fill(500));
	});

	it("observes cleanup checkpoints as well as initial and verification checkpoints", async () => {
		const { db, input } = fixture({ cleanupBatches: 10 });
		const requested: string[] = [];
		await prepareNativeWatchGeneration(db as never, input, undefined, (event) => {
			if (event.phase === "requested") requested.push(event.kind);
		});
		expect(requested).toEqual([
			"lease-checkpoint",
			"lease-checkpoint",
			"lease-checkpoint",
			"row-chunk",
			"receipt-chunk",
			"lease-checkpoint",
			"lease-checkpoint",
		]);
	});

	it.each([
		{ failAt: 1, kind: "lease-checkpoint", failPhase: "request" as const },
		{ failAt: 2, kind: "row-chunk", failPhase: "callback" as const },
		{ failAt: 3, kind: "receipt-chunk", failPhase: "commit" as const },
	])(
		"retains the same thrown object on $kind $failPhase failure even when observers throw",
		async (failure) => {
			const { db, input, error } = fixture(failure);
			const events: unknown[] = [];
			await expect(
				prepareNativeWatchGeneration(
					db as never,
					input,
					() => {
						throw new Error("ignored stage observer");
					},
					(event) => {
						events.push(event);
						throw new Error("ignored transaction observer");
					},
				),
			).rejects.toBe(error);
			expect(events.slice(failure.failPhase === "request" ? -2 : -3)).toEqual([
				{ kind: failure.kind, phase: "requested" },
				...(failure.failPhase === "request"
					? []
					: [{ kind: failure.kind, phase: "callback-entered" }]),
				{ kind: failure.kind, phase: "failed" },
			]);
		},
	);

	it("ignores throwing transaction observers on success", async () => {
		const { db, input, rows, receipts } = fixture();
		await expect(
			prepareNativeWatchGeneration(db as never, input, undefined, () => {
				throw new Error("ignored");
			}),
		).resolves.toBeUndefined();
		expect(rows).toHaveLength(1);
		expect(receipts).toHaveLength(1);
	});
});
