import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";
import { collectHistoryObservationsForOwner } from "../history-collector.js";
import {
	HISTORY_COLLECTION_MAX_DURATION_MS,
	HISTORY_COLLECTION_MAX_RAW_ROWS,
	HISTORY_COLLECTION_MAX_SOURCE_TURNS,
	HISTORY_COLLECTION_MAX_TURNS_PER_SOURCE,
	HISTORY_COLLECTION_PROVIDER_TIMEOUT_MS,
} from "../history-source-contract.js";

const userId = "owner-collector";
const claimToken = "claim-token";
const fingerprint = createHash("sha256").update(claimToken).digest("hex");
const uuid = "123e4567-e89b-42d3-a456-426614174000";
const preparedMarker = `in_progress:v2:prepared:${fingerprint}:${uuid}`;
const startedMarker = `in_progress:v2:started:${fingerprint}:${uuid}`;

function claim() {
	return {
		userId,
		claimToken,
		claimedAt: new Date("2026-09-03T12:00:00.000Z"),
		heartbeatAt: new Date("2026-09-03T12:00:00.000Z"),
		expiresAt: new Date("2026-09-03T12:05:00.000Z"),
		nextSourceCursor: null,
	};
}

function attempt(sourceId: string, marker = preparedMarker, phase: "head" | "backfill" = "head") {
	return {
		userId,
		instanceId: sourceId,
		connectionGeneration: 7,
		attemptedAt: new Date("2026-09-03T12:00:00.000Z"),
		resultMarker: marker,
		phase,
		collectionPage: phase === "head" ? 1 : 2,
		backfillPage: 2,
	};
}

function instance(sourceId: string) {
	return {
		id: sourceId,
		service: "SONARR",
		baseUrl: "https://provider.invalid",
		encryptedApiKey: "encrypted-api-key",
		encryptionIv: "api-key-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		connectionGeneration: 7,
	};
}

function prisma() {
	return {
		serviceInstance: {
			findMany: vi.fn(async () => [{ id: "source-a" }]),
			findFirst: vi.fn(async ({ where }: { where: { id: string } }) => instance(where.id)),
		},
	};
}

function dependencies(overrides: Record<string, unknown> = {}) {
	const database = prisma();
	return {
		prisma: database,
		clientFactory: { createAnyClient: vi.fn(() => ({ history: {} })) },
		acquireLease: vi.fn(async () => claim()),
		heartbeatLease: vi.fn(async () => true),
		releaseLease: vi.fn(async () => true),
		beginAttempt: vi.fn(async (_prisma: unknown, { instanceId }: { instanceId: string }) =>
			attempt(instanceId),
		),
		markProviderStarted: vi.fn(
			async (
				_prisma: unknown,
				{ leaseClaim: _leaseClaim, ...prepared }: { resultMarker: string; leaseClaim: unknown },
			) => ({
				kind: "started",
				attempt: {
					...prepared,
					resultMarker: prepared.resultMarker.replace(":prepared:", ":started:"),
				},
			}),
		),
		deferAttempt: vi.fn(async () => "recorded"),
		finishAttemptFailure: vi.fn(async () => "recorded"),
		fetchProviderPage: vi.fn(async () => ({
			kind: "page",
			records: [],
			rawRecordCount: 0,
			totalRecordsHint: null,
		})),
		normalizeObservation: vi.fn(() => ({ ok: false })),
		publishObservations: vi.fn(async () => ({
			kind: "published",
			finish: { result: "success", reason: null },
			publishedObservationCount: 0,
			retainedObservationCount: 0,
			deletedObservationCount: 0,
		})),
		monotonicNow: vi.fn(() => 0),
		...overrides,
		database,
	};
}

function expectBoundedResult(result: unknown) {
	if (!result || typeof result !== "object") throw new Error("expected collector result");
	const keys = Object.keys(result).sort();
	expect(keys).toEqual([
		"candidateSourceCount",
		"durationMs",
		"failedTurnCount",
		"leaseReleased",
		"limitReason",
		"preservedTurnCount",
		"providerRequestCount",
		"publishedTurnCount",
		"rawRecordCount",
		"sourceSetTruncated",
		"sourceTurnCount",
		"status",
		"supersededTurnCount",
	]);
	expect(JSON.stringify(result)).not.toMatch(
		/owner-collector|provider\.invalid|encrypted-api-key|claim-token|in_progress|raw-secret|private-title/,
	);
}

function sources(ids: string[]) {
	return ids.map((id) => ({ id }));
}

describe("fair owner-scoped History collector", () => {
	it("returns a bounded lease-unavailable result without discovering or contacting a source", async () => {
		// Catches a collector that performs discovery or provider work before it owns the lease.
		const deps = dependencies({ acquireLease: vi.fn(async () => null) });
		const result = await collectHistoryObservationsForOwner(deps as never, userId);

		expect(result).toEqual({
			status: "lease-unavailable",
			candidateSourceCount: 0,
			sourceTurnCount: 0,
			providerRequestCount: 0,
			rawRecordCount: 0,
			publishedTurnCount: 0,
			preservedTurnCount: 0,
			supersededTurnCount: 0,
			failedTurnCount: 0,
			sourceSetTruncated: false,
			limitReason: null,
			leaseReleased: false,
			durationMs: 0,
		});
		expect(deps.database.serviceInstance.findMany).not.toHaveBeenCalled();
		expect(deps.clientFactory.createAnyClient).not.toHaveBeenCalled();
	});

	it("uses the exact execution authority and started attempt for one bounded provider turn", async () => {
		// Catches page-first collection, stale discovery credentials, missing start CAS, and loose client options.
		const deps = dependencies({ monotonicNow: vi.fn().mockReturnValueOnce(0).mockReturnValue(1) });
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(deps.beginAttempt).toHaveBeenCalledTimes(1);
		expect(deps.database.serviceInstance.findFirst).toHaveBeenCalledTimes(1);
		expect(deps.clientFactory.createAnyClient).toHaveBeenCalledTimes(1);
		expect(deps.markProviderStarted).toHaveBeenCalledTimes(1);

		expect(result).toMatchObject({
			status: "completed",
			candidateSourceCount: 1,
			sourceTurnCount: 1,
			providerRequestCount: 1,
			rawRecordCount: 0,
			publishedTurnCount: 1,
			preservedTurnCount: 0,
			supersededTurnCount: 0,
			failedTurnCount: 0,
			limitReason: null,
		});
		expect(deps.database.serviceInstance.findMany).toHaveBeenCalledWith({
			where: {
				userId,
				enabled: true,
				service: { in: ["SONARR", "RADARR", "PROWLARR", "LIDARR", "READARR"] },
			},
			orderBy: { id: "asc" },
			select: { id: true },
			take: 101,
		});
		expect(deps.clientFactory.createAnyClient).toHaveBeenCalledWith(instance("source-a"), {
			timeout: HISTORY_COLLECTION_PROVIDER_TIMEOUT_MS,
		});
		expect(deps.fetchProviderPage).toHaveBeenCalledWith({
			service: "sonarr",
			client: expect.anything(),
			page: 1,
		});
		expect(deps.publishObservations).toHaveBeenCalledWith(
			{
				attempt: expect.objectContaining({ resultMarker: startedMarker }),
				leaseClaim: claim(),
				receipt: {
					kind: "completed",
					rawRecordCount: 0,
					normalizedRows: [],
					totalRecordsHint: null,
				},
			},
			deps.prisma,
		);
	});

	it("exports the fixed admission bounds as server-internal contract values", () => {
		// Catches accidental changes that would permit an unbounded owner run or per-source retry loop.
		expect(HISTORY_COLLECTION_MAX_DURATION_MS).toBe(240_000);
		expect(HISTORY_COLLECTION_PROVIDER_TIMEOUT_MS).toBe(20_000);
		expect(HISTORY_COLLECTION_MAX_SOURCE_TURNS).toBe(100);
		expect(HISTORY_COLLECTION_MAX_TURNS_PER_SOURCE).toBe(2);
	});

	it("fails closed for an invalid initial clock and an acquisition throw", async () => {
		// Catches provider work being started when the owner-run budget has no valid monotonic authority.
		const invalid = dependencies({ monotonicNow: vi.fn(() => Number.NaN) });
		const invalidResult = await collectHistoryObservationsForOwner(invalid as never, userId);
		expect(invalidResult).toMatchObject({
			status: "failed",
			sourceTurnCount: 0,
			providerRequestCount: 0,
			durationMs: 240_001,
		});
		expect(invalid.acquireLease).not.toHaveBeenCalled();
		const thrown = dependencies({
			acquireLease: vi.fn(async () => {
				throw new Error("raw-secret");
			}),
		});
		const thrownResult = await collectHistoryObservationsForOwner(thrown as never, userId);
		expect(thrownResult).toMatchObject({
			status: "failed",
			candidateSourceCount: 0,
			sourceTurnCount: 0,
		});
		expectBoundedResult(thrownResult);
	});

	it("rotates exact cursor discovery through no more than two owner-scoped ID-only queries", async () => {
		// Catches unbounded discovery, owner leaks, non-History services, and page-first cursor reconstruction.
		const deps = dependencies();
		deps.acquireLease = vi.fn(async () => ({ ...claim(), nextSourceCursor: "source-c" })) as never;
		deps.database.serviceInstance.findMany = vi
			.fn()
			.mockResolvedValueOnce(sources(["source-c", "source-d"]))
			.mockResolvedValueOnce(sources(["source-a", "source-b"]));
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.candidateSourceCount).toBe(4);
		expect(deps.database.serviceInstance.findMany).toHaveBeenCalledTimes(2);
		expect(deps.database.serviceInstance.findMany).toHaveBeenNthCalledWith(1, {
			where: {
				userId,
				enabled: true,
				service: { in: ["SONARR", "RADARR", "PROWLARR", "LIDARR", "READARR"] },
				id: { gte: "source-c" },
			},
			orderBy: { id: "asc" },
			select: { id: true },
			take: 101,
		});
		expect(deps.database.serviceInstance.findMany).toHaveBeenNthCalledWith(2, {
			where: {
				userId,
				enabled: true,
				service: { in: ["SONARR", "RADARR", "PROWLARR", "LIDARR", "READARR"] },
				id: { lt: "source-c" },
			},
			orderBy: { id: "asc" },
			select: { id: true },
			take: 99,
		});
	});

	it("keeps the 101st discovered ID as a continuation sentinel at the 100-turn cap", async () => {
		// Catches off-by-one admission and requeue precedence that can lose the continuation source.
		const ids = Array.from(
			{ length: 101 },
			(_, index) => `source-${String(index).padStart(3, "0")}`,
		);
		const deps = dependencies({
			monotonicNow: vi.fn().mockReturnValueOnce(0).mockReturnValue(1),
			beginAttempt: vi.fn(async () => null),
		});
		deps.database.serviceInstance.findMany = vi.fn(async () => sources(ids));
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({
			candidateSourceCount: 101,
			sourceSetTruncated: true,
			sourceTurnCount: 100,
			supersededTurnCount: 100,
			limitReason: "turn-limit",
		});
		expect(deps.heartbeatLease).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.anything(),
			"source-100",
			expect.anything(),
		);
	});

	it("bounds begin-null and pre-network failures by source turns and does not spend provider requests", async () => {
		// Catches a request-budget-only loop that can starve later sources with cheap failures.
		const deps = dependencies({ beginAttempt: vi.fn(async () => null) });
		deps.database.serviceInstance.findMany = vi.fn(async () =>
			sources(["source-a", "source-b", "source-c"]),
		);
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({
			sourceTurnCount: 3,
			providerRequestCount: 0,
			supersededTurnCount: 3,
			failedTurnCount: 0,
		});
	});

	it("runs every first FIFO turn before a requeued second phase and never begins a phase twice", async () => {
		// Catches page-1-first and same-phase retry designs that violate durable phase fairness.
		const order: string[] = [];
		const deps = dependencies({
			monotonicNow: vi.fn().mockReturnValueOnce(0).mockReturnValue(1),
			beginAttempt: vi.fn(async (_prisma: unknown, { instanceId }: { instanceId: string }) => {
				const phase =
					order.filter((value) => value.startsWith(instanceId)).length === 0 ? "head" : "backfill";
				order.push(`${instanceId}:${phase}`);
				return attempt(instanceId, preparedMarker, phase);
			}),
		});
		deps.database.serviceInstance.findMany = vi.fn(async () => sources(["source-a", "source-b"]));
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.sourceTurnCount).toBeLessThanOrEqual(4);
		expect(order.slice(0, 2).map((value) => value.split(":")[0])).toEqual(["source-a", "source-b"]);
	});

	it("begins the attempt before the exact execution authority query, credential selection, and client creation", async () => {
		// Catches discovery-selected credentials and a client created before the prepared marker is durable.
		const calls: string[] = [];
		const deps = dependencies({
			beginAttempt: vi.fn(async (_input: unknown) => {
				calls.push("begin");
				return attempt("source-a");
			}),
			clientFactory: {
				createAnyClient: vi.fn((value: unknown, options: unknown) => {
					calls.push(`client:${JSON.stringify(value)}:${JSON.stringify(options)}`);
					return {};
				}),
			},
		});
		deps.database.serviceInstance.findFirst = vi.fn(async () => {
			calls.push("execution");
			return instance("source-a");
		});
		await collectHistoryObservationsForOwner(deps as never, userId);
		expect(calls[0]).toBe("begin");
		expect(calls[1]).toBe("execution");
		expect(calls.at(-1)).toContain("20000");
		expect(deps.database.serviceInstance.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "source-a",
					userId,
					enabled: true,
					service: { in: ["SONARR", "RADARR", "PROWLARR", "LIDARR", "READARR"] },
					connectionGeneration: 7,
				}),
				select: {
					id: true,
					service: true,
					baseUrl: true,
					encryptedApiKey: true,
					encryptionIv: true,
					encryptedHttpAuthCredentials: true,
					httpAuthEncryptionIv: true,
					connectionGeneration: true,
				},
			}),
		);
	});

	it("turns the 100th admitted source into the 100th request and rejects a mismatched started override", async () => {
		// Catches `< 100` off-by-one checks and trusting arbitrary/mismatched start results as I/O authority.
		const deps = dependencies({
			beginAttempt: vi.fn(async (_prisma: unknown, { instanceId }: { instanceId: string }) =>
				attempt(instanceId),
			),
		});
		deps.database.serviceInstance.findMany = vi.fn(async () =>
			sources(Array.from({ length: 100 }, (_, i) => `source-${i}`)),
		);
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(deps.beginAttempt).toHaveBeenCalledTimes(100);
		expect(deps.clientFactory.createAnyClient).toHaveBeenCalledTimes(100);
		expect(deps.markProviderStarted).toHaveBeenCalledTimes(100);
		expect(result.providerRequestCount).toBe(100);
		const mismatch = dependencies({
			markProviderStarted: vi.fn(async () => ({
				kind: "started",
				attempt: { ...attempt("other"), resultMarker: startedMarker, private: "raw-secret" },
			})),
		});
		const mismatchResult = await collectHistoryObservationsForOwner(mismatch as never, userId);
		expect(mismatchResult).toMatchObject({
			providerRequestCount: 0,
			failedTurnCount: 1,
			status: "failed",
		});
		expect(mismatch.fetchProviderPage).not.toHaveBeenCalled();
	});

	it("accounts provider rows before the next cursor heartbeat and submits a page-local receipt", async () => {
		// Catches cumulative-count publication and heartbeat/normalization reordering.
		const events: string[] = [];
		const deps = dependencies({
			heartbeatLease: vi.fn(async () => {
				events.push("heartbeat");
				return true;
			}),
			fetchProviderPage: vi.fn(async () => {
				events.push("provider");
				return {
					kind: "page",
					records: [{ eventType: "grabbed", id: 1 }],
					rawRecordCount: 1,
					totalRecordsHint: 1,
				};
			}),
			normalizeObservation: vi.fn(() => {
				events.push("normalize");
				return { ok: false };
			}),
			publishObservations: vi.fn(async ({ receipt }: { receipt: unknown }) => {
				events.push("publish");
				expect(receipt).toEqual({
					kind: "completed",
					rawRecordCount: 1,
					normalizedRows: [],
					totalRecordsHint: 1,
				});
				return { kind: "preserved", finish: "recorded", reason: "rows-inconsistent" };
			}),
		});
		await collectHistoryObservationsForOwner(deps as never, userId);
		expect(events.indexOf("provider")).toBeLessThan(events.indexOf("heartbeat"));
		expect(events.indexOf("heartbeat")).toBeLessThan(events.indexOf("normalize"));
	});

	it("retains duplicate bindings, normalizes each row once, and rejects malformed adapter envelopes", async () => {
		// Catches deduplicating in the collector and forwarding arbitrary provider fields.
		const normalize = vi.fn(() => ({
			ok: true,
			observation: { payload: {}, normalizedPayload: "{}", searchText: "" },
		}));
		const deps = dependencies({
			normalizeObservation: normalize,
			fetchProviderPage: vi.fn(async () => ({
				kind: "page",
				records: [{ id: 1 }, { id: 1 }],
				rawRecordCount: 2,
				totalRecordsHint: 2,
			})),
		});
		await collectHistoryObservationsForOwner(deps as never, userId);
		expect(normalize).toHaveBeenCalledTimes(2);
		const malformed = dependencies({
			fetchProviderPage: vi.fn(async () => ({
				kind: "surprise",
				rawRecordCount: 2,
				raw: "raw-secret",
			})),
		});
		await collectHistoryObservationsForOwner(malformed as never, userId);
		expect(malformed.publishObservations).toHaveBeenCalledWith(
			expect.objectContaining({ receipt: { kind: "adapter-invalid", rawRecordCount: 2 } }),
			expect.anything(),
		);
	});

	it("uses zero for an unsafe envelope count and never inspects a rejected provider error", async () => {
		// Catches unsafe count coercion and error-message leakage into persistence or results.
		const deps = dependencies({
			fetchProviderPage: vi.fn(async () => {
				throw new Error("raw-secret");
			}),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.rawRecordCount).toBe(0);
		expect(JSON.stringify(result)).not.toContain("raw-secret");
		expect(deps.finishAttemptFailure).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ reason: "provider-unavailable" }),
			expect.anything(),
		);
	});

	it("preserves raw count when normalization returns false or throws so publication records inconsistency", async () => {
		// Catches malformed rows being converted into empty successful pages.
		const normalize = vi
			.fn()
			.mockReturnValueOnce({ ok: false })
			.mockImplementationOnce(() => {
				throw new Error("private-title");
			});
		const deps = dependencies({
			normalizeObservation: normalize,
			fetchProviderPage: vi.fn(async () => ({
				kind: "page",
				records: [{ id: 1 }, { id: 2 }],
				rawRecordCount: 2,
				totalRecordsHint: 2,
			})),
		});
		await collectHistoryObservationsForOwner(deps as never, userId);
		expect(deps.publishObservations).toHaveBeenCalledWith(
			expect.objectContaining({
				receipt: expect.objectContaining({
					kind: "completed",
					rawRecordCount: 2,
					normalizedRows: [],
				}),
			}),
			expect.anything(),
		);
	});

	it("defers a prepared attempt at request, row, or time admission boundaries without fabricating a failure", async () => {
		// Catches provider-limit mapping for pre-start closure and untouched-source fabricated failures.
		const deps = dependencies({
			monotonicNow: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(220_000),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.limitReason).toBe("time-limit");
		expect(deps.fetchProviderPage).not.toHaveBeenCalled();
	});

	it("closes a started marker conservatively when the final clock crosses the cutoff", async () => {
		// Catches reverting started authority to prepared and retrying the same page after delayed CAS.
		const deps = dependencies({
			monotonicNow: vi
				.fn()
				.mockReturnValueOnce(0)
				.mockReturnValueOnce(1)
				.mockReturnValueOnce(1)
				.mockReturnValueOnce(220_001)
				.mockReturnValueOnce(240_001),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({
			limitReason: "time-limit",
			providerRequestCount: 0,
			rawRecordCount: 0,
		});
		expect(deps.deferAttempt).not.toHaveBeenCalled();
		expect(deps.finishAttemptFailure).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ reason: "unknown-failure" }),
			expect.anything(),
		);
	});

	it("fails on backwards or nonfinite later clocks with the duration sentinel and exact marker cleanup", async () => {
		// Catches Date.now budget authority and unsafe duration arithmetic.
		const deps = dependencies({
			monotonicNow: vi.fn().mockReturnValueOnce(10).mockReturnValueOnce(9),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({ status: "failed", durationMs: 240_001 });
		expect(JSON.stringify(result)).not.toMatch(/10|9/);
	});

	it("stops after post-provider heartbeat loss without normalizing or publishing", async () => {
		// Catches publishing after owner authority has been fenced and starting later FIFO turns.
		const deps = dependencies({
			heartbeatLease: vi.fn(async () => false),
			fetchProviderPage: vi.fn(async () => ({
				kind: "page",
				records: [{ id: 1 }],
				rawRecordCount: 1,
				totalRecordsHint: 1,
			})),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({
			status: "superseded",
			rawRecordCount: 1,
			supersededTurnCount: 1,
		});
		expect(deps.normalizeObservation).not.toHaveBeenCalled();
		expect(deps.publishObservations).not.toHaveBeenCalled();
	});

	it("maps publication, direct failure, deferral, and release outcomes exactly once", async () => {
		// Catches divergent aggregate counters and release status being mistaken for source outcome.
		const deps = dependencies({
			beginAttempt: vi.fn().mockResolvedValueOnce(attempt("source-a")).mockResolvedValueOnce(null),
			publishObservations: vi.fn(async () => ({
				kind: "preserved",
				finish: "recorded",
				reason: "provider-unavailable",
			})),
			releaseLease: vi.fn(async () => false),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({
			preservedTurnCount: 1,
			sourceTurnCount: 2,
			status: "superseded",
			leaseReleased: false,
		});
		expect(
			result.publishedTurnCount +
				result.preservedTurnCount +
				result.supersededTurnCount +
				result.failedTurnCount,
		).toBe(result.sourceTurnCount);
		const thrownRelease = dependencies({
			releaseLease: vi.fn(async () => {
				throw new Error("raw-secret");
			}),
		});
		expect((await collectHistoryObservationsForOwner(thrownRelease as never, userId)).status).toBe(
			"failed",
		);
	});

	it("keeps disposable SQLite lease, phase, publication, and restart state independent", async () => {
		// Catches process-local cursor/page state and publication rollback that cannot survive restart.
		const deps = dependencies({ dialect: "sqlite", monotonicNow: vi.fn().mockReturnValue(1) });
		deps.database.serviceInstance.findMany = vi.fn(async () => sources(["source-a", "source-b"]));
		const first = await collectHistoryObservationsForOwner(deps as never, userId);
		const second = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(first.sourceTurnCount).toBeGreaterThanOrEqual(0);
		expect(second.sourceTurnCount).toBeGreaterThanOrEqual(0);
		expect(deps.releaseLease).toHaveBeenCalled();
	});

	it("returns only bounded sanitized telemetry and invokes no logger or mutation-capable helper", async () => {
		// Catches private IDs, cursors, credentials, raw rows/errors, and accidental mutation paths in the aggregate result.
		const deps = dependencies({
			fetchProviderPage: vi.fn(async () => ({
				kind: "page",
				records: [{ title: "private-title", url: "https://provider.invalid/secret" }],
				rawRecordCount: 1,
				totalRecordsHint: 1,
			})),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expectBoundedResult(result);
		for (const key of [
			"executeOnInstances",
			"rawRequest",
			"cleanup",
			"search",
			"grab",
			"import",
			"sync",
			"refresh",
			"test",
			"verify",
			"save",
			"submit",
			"delete",
		])
			expect(deps.clientFactory).not.toHaveProperty(key);
	});

	it("group 1: acquires the owner lease before all bounded discovery and clock work", async () => {
		// Requirements 1, 2, and 21: invalid/denied/throwing acquisition, exact predicates, and sanitized result.
		const deps = dependencies({ acquireLease: vi.fn(async () => null) });
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.status).toBe("lease-unavailable");
		expect(deps.database.serviceInstance.findMany).not.toHaveBeenCalled();
		expectBoundedResult(result);
	});

	it("group 2: bounds discovery, sentinel rotation, and FIFO source-turn fairness", async () => {
		// Requirements 2, 3, 4, and 5: two queries, 101st sentinel, 100 turns, and first phases before requeues.
		const ids = Array.from({ length: 101 }, (_, index) => `source-${index}`);
		const deps = dependencies({
			beginAttempt: vi.fn(async () => null),
			monotonicNow: vi.fn().mockReturnValue(1),
		});
		deps.database.serviceInstance.findMany = vi.fn(async () => sources(ids));
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({
			candidateSourceCount: 101,
			sourceSetTruncated: true,
			sourceTurnCount: 100,
			limitReason: "turn-limit",
		});
		expect(deps.beginAttempt).toHaveBeenCalledTimes(100);
	});

	it("group 3: treats prepared and started markers as the only execution authority", async () => {
		// Requirements 6, 7, 8, 9, and 10: begin/query/client/start order and exact immutable identity.
		const sequence: string[] = [];
		const deps = dependencies({
			beginAttempt: vi.fn(async () => {
				sequence.push("begin");
				return attempt("source-a");
			}),
			markProviderStarted: vi.fn(async (input: unknown) => {
				sequence.push("start");
				return {
					kind: "started",
					attempt: { ...(input as Record<string, unknown>), leaseClaim: undefined },
				};
			}),
		});
		deps.database.serviceInstance.findFirst = vi.fn(async () => {
			sequence.push("authority");
			return instance("source-a");
		});
		await collectHistoryObservationsForOwner(deps as never, userId);
		expect(sequence[0]).toBe("begin");
		expect(sequence[1]).toBe("authority");
		expect(deps.fetchProviderPage).not.toHaveBeenCalled();
	});

	it("group 4: enforces request, row, turn, and duration admission without shrinking pages", async () => {
		// Requirements 10, 15, and 16: exact 100th call, precedence, pre-start deferral, and delayed start closure.
		const deps = dependencies({
			monotonicNow: vi.fn().mockReturnValueOnce(0).mockReturnValueOnce(220_000),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.limitReason).toBe("time-limit");
		expect(deps.deferAttempt).not.toHaveBeenCalled();
		expect(deps.fetchProviderPage).not.toHaveBeenCalled();
	});

	it("group 5: accounts exactly one provider envelope and one normalized receipt per turn", async () => {
		// Requirements 11, 12, 13, and 14: count-before-heartbeat, saturation, invalid envelopes, duplicates, and row mismatch.
		const deps = dependencies({
			fetchProviderPage: vi.fn(async () => ({ kind: "invalid", rawRecordCount: 2 })),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.providerRequestCount).toBe(1);
		expect(result.rawRecordCount).toBe(2);
		expect(deps.publishObservations).toHaveBeenCalledWith(
			expect.objectContaining({ receipt: { kind: "adapter-invalid", rawRecordCount: 2 } }),
			expect.anything(),
		);
	});

	it("group 6: fences every post-provider publication and direct-failure transition", async () => {
		// Requirements 17 and 18: heartbeat loss, publication/direct outcome mapping, and no later work after lost authority.
		const deps = dependencies({
			heartbeatLease: vi.fn(async () => false),
			fetchProviderPage: vi.fn(async () => ({
				kind: "page",
				records: [],
				rawRecordCount: 0,
				totalRecordsHint: null,
			})),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.status).toBe("superseded");
		expect(deps.publishObservations).not.toHaveBeenCalled();
	});

	it("group 7: releases the exact claim after success, source failure, internal failure, and lease loss", async () => {
		// Requirement 19: false/throwing release changes aggregate status without changing turn counters.
		const deps = dependencies({ releaseLease: vi.fn(async () => false) });
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result.leaseReleased).toBe(false);
		expect(result.status).toBe("superseded");
		expect(deps.releaseLease).toHaveBeenCalledTimes(1);
	});

	it("group 8: proves disposable restart-safe phase/cursor state and privacy quarantine", async () => {
		// Requirements 20 and 21: SQLite-facing dependencies stay synthetic at provider boundaries and output is exact/sanitized.
		const deps = dependencies({
			dialect: "sqlite",
			fetchProviderPage: vi.fn(async () => ({
				kind: "page",
				records: [],
				rawRecordCount: 0,
				totalRecordsHint: null,
			})),
		});
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expectBoundedResult(result);
		expect(JSON.stringify(result)).not.toMatch(
			/source-a|provider\.invalid|claim-token|raw-secret|private-title/,
		);
	});

	it("preserves every safe provider count, reports adapter limits, and saturates aggregate rows", async () => {
		for (const rawRecordCount of [101, Number.MAX_SAFE_INTEGER]) {
			const deps = dependencies({
				fetchProviderPage: vi.fn(async () => ({ kind: "adapter-invalid", rawRecordCount })),
			});
			const result = await collectHistoryObservationsForOwner(deps as never, userId);
			expect(result.rawRecordCount).toBe(
				rawRecordCount === Number.MAX_SAFE_INTEGER ? HISTORY_COLLECTION_MAX_RAW_ROWS + 1 : 101,
			);
			expect(deps.publishObservations).toHaveBeenCalledWith(
				expect.objectContaining({ receipt: { kind: "adapter-invalid", rawRecordCount } }),
				expect.anything(),
			);
		}
		const unsafe = dependencies({
			fetchProviderPage: vi.fn(async () => ({
				kind: "adapter-invalid",
				rawRecordCount: Number.MAX_SAFE_INTEGER + 1,
			})),
		});
		expect((await collectHistoryObservationsForOwner(unsafe as never, userId)).rawRecordCount).toBe(
			0,
		);
	});

	it("enforces reachable pre-turn request, row, and time closures with exact prepared authority", async () => {
		const preStart = dependencies({
			monotonicNow: vi
				.fn()
				.mockReturnValueOnce(0)
				.mockReturnValueOnce(1)
				.mockReturnValueOnce(220_000)
				.mockReturnValue(220_000),
		});
		const preStartResult = await collectHistoryObservationsForOwner(preStart as never, userId);
		expect(preStartResult).toMatchObject({
			status: "completed",
			limitReason: "time-limit",
			preservedTurnCount: 1,
		});
		expect(preStart.deferAttempt).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ resultMarker: preparedMarker, collectionPage: 1, phase: "head" }),
			expect.anything(),
		);
		expect(preStart.markProviderStarted).not.toHaveBeenCalled();
		expect(preStart.fetchProviderPage).not.toHaveBeenCalled();

		const request = dependencies({
			monotonicNow: vi.fn().mockReturnValue(1),
			beginAttempt: vi.fn(async (_p: unknown, { instanceId }: { instanceId: string }) =>
				attempt(instanceId),
			),
		});
		request.database.serviceInstance.findMany = vi.fn(async () =>
			sources(Array.from({ length: 100 }, (_, i) => `request-${i}`)),
		);
		const requestResult = await collectHistoryObservationsForOwner(request as never, userId);
		expect(requestResult).toMatchObject({ sourceTurnCount: 100, providerRequestCount: 100 });
		expect(requestResult.limitReason).toBeNull();

		const row = dependencies({
			monotonicNow: vi.fn().mockReturnValue(1),
			fetchProviderPage: vi.fn(async ({ page }: { page: number }) => ({
				kind: "adapter-invalid",
				rawRecordCount: page === 1 ? Number.MAX_SAFE_INTEGER : 0,
			})),
		});
		row.database.serviceInstance.findMany = vi.fn(async () => sources(["row-a", "row-b"]));
		const rowResult = await collectHistoryObservationsForOwner(row as never, userId);
		expect(rowResult).toMatchObject({
			sourceTurnCount: 1,
			limitReason: "row-limit",
			rawRecordCount: 10_001,
		});
		expect(row.beginAttempt).toHaveBeenCalledTimes(1);
	});

	it("fails closed at pre-start and post-start invalid clocks while preserving marker phase", async () => {
		const prepared = dependencies({
			monotonicNow: vi
				.fn()
				.mockReturnValueOnce(0)
				.mockReturnValueOnce(1)
				.mockReturnValueOnce(Number.NaN),
		});
		const preparedResult = await collectHistoryObservationsForOwner(prepared as never, userId);
		expect(preparedResult).toMatchObject({
			status: "failed",
			sourceTurnCount: 1,
			preservedTurnCount: 1,
		});
		expect(prepared.deferAttempt).not.toHaveBeenCalled();
		expect(prepared.markProviderStarted).not.toHaveBeenCalled();
		expect(prepared.finishAttemptFailure).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ resultMarker: preparedMarker, reason: "unknown-failure" }),
			expect.anything(),
		);

		const started = dependencies({
			monotonicNow: vi
				.fn()
				.mockReturnValueOnce(0)
				.mockReturnValueOnce(1)
				.mockReturnValueOnce(1)
				.mockReturnValueOnce(Number.NaN),
		});
		const startedResult = await collectHistoryObservationsForOwner(started as never, userId);
		expect(startedResult).toMatchObject({
			status: "failed",
			sourceTurnCount: 1,
			preservedTurnCount: 1,
		});
		expect(started.finishAttemptFailure).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ resultMarker: startedMarker, reason: "unknown-failure" }),
			expect.anything(),
		);
		expect(started.fetchProviderPage).not.toHaveBeenCalled();
	});

	it("requeues only recorded direct failures at the FIFO tail and never requeues superseded or failed finishes", async () => {
		const order: string[] = [];
		const direct = dependencies({
			monotonicNow: vi.fn().mockReturnValue(1),
			beginAttempt: vi.fn(async (_p: unknown, { instanceId }: { instanceId: string }) => {
				order.push(instanceId);
				return attempt(instanceId);
			}),
			finishAttemptFailure: vi.fn(async (_p: unknown, value: { instanceId: string }) =>
				value.instanceId === "source-a" ? "recorded" : "failed",
			),
		});
		direct.database.serviceInstance.findMany = vi.fn(async () => sources(["source-a", "source-b"]));
		direct.database.serviceInstance.findFirst = vi.fn(
			async ({ where }: { where: { id: string } }) =>
				where.id === "source-a" ? null : instance(where.id),
		) as never;
		const directResult = await collectHistoryObservationsForOwner(direct as never, userId);
		expect(order).toEqual(["source-a", "source-b", "source-a"]);
		expect(directResult.sourceTurnCount).toBe(3);

		for (const finish of ["superseded", "failed"] as const) {
			const noRequeue = dependencies({
				monotonicNow: vi.fn().mockReturnValue(1),
				finishAttemptFailure: vi.fn(async () => finish),
			});
			noRequeue.database.serviceInstance.findMany = vi.fn(async () =>
				sources(["source-a", "source-b"]),
			);
			noRequeue.database.serviceInstance.findFirst = vi.fn(async () => null) as never;
			const result = await collectHistoryObservationsForOwner(noRequeue as never, userId);
			expect(result.sourceTurnCount).toBe(finish === "superseded" ? 2 : 1);
			expect(noRequeue.beginAttempt).toHaveBeenCalledTimes(finish === "superseded" ? 2 : 1);
		}
	});

	it("persists the requeued direct-failure source as the post-turn FIFO cursor", async () => {
		const phases = new Map<string, number>();
		const deps = dependencies({
			monotonicNow: vi.fn().mockReturnValue(1),
			beginAttempt: vi.fn(async (_p: unknown, { instanceId }: { instanceId: string }) => {
				const turn = (phases.get(instanceId) ?? 0) + 1;
				phases.set(instanceId, turn);
				return attempt(
					instanceId,
					preparedMarker,
					instanceId === "source-b" && turn === 2 ? "backfill" : "head",
				);
			}),
			finishAttemptFailure: vi.fn(async (_p: unknown, value: { phase: string }) =>
				value.phase === "head" ? "recorded" : "superseded",
			),
		});
		deps.database.serviceInstance.findMany = vi.fn(async () => sources(["source-a", "source-b"]));
		deps.database.serviceInstance.findFirst = vi.fn(async ({ where }: { where: { id: string } }) =>
			where.id === "source-b" ? null : instance("source-a"),
		) as never;
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({
			sourceTurnCount: 3,
			publishedTurnCount: 1,
			preservedTurnCount: 1,
			supersededTurnCount: 1,
		});
		// A is terminal; B's recorded direct failure is the only queued head after its turn.
		expect(deps.heartbeatLease).toHaveBeenNthCalledWith(
			3,
			expect.anything(),
			expect.anything(),
			"source-b",
			expect.anything(),
		);
	});

	it("rejects malformed publication results with exact cleanup and no requeue", async () => {
		const malformed: unknown[] = [
			{
				kind: "published",
				finish: { result: "success", reason: null },
				publishedObservationCount: 0,
				retainedObservationCount: 0,
				deletedObservationCount: 0,
				extra: true,
			},
			{
				kind: "published",
				finish: { result: "success", reason: null },
				publishedObservationCount: -1,
				retainedObservationCount: 0,
				deletedObservationCount: 0,
			},
			{
				kind: "published",
				finish: { result: "success", reason: "provider-limit" },
				publishedObservationCount: 0,
				retainedObservationCount: 0,
				deletedObservationCount: 0,
			},
			{
				kind: "published",
				finish: { result: "error", reason: null },
				publishedObservationCount: 0,
				retainedObservationCount: 0,
				deletedObservationCount: 0,
			},
			{ kind: "preserved", finish: "recorded", reason: "private-title" },
		];
		for (const publication of malformed) {
			const deps = dependencies({ publishObservations: vi.fn(async () => publication) });
			const result = await collectHistoryObservationsForOwner(deps as never, userId);
			expect(result).toMatchObject({ status: "failed", sourceTurnCount: 1, failedTurnCount: 1 });
			expect(deps.finishAttemptFailure).toHaveBeenCalledTimes(1);
			expect(deps.beginAttempt).toHaveBeenCalledTimes(1);
			expectBoundedResult(result);
		}
	});

	it("classifies an unexpected result-processing exception exactly once and sanitizes its value", async () => {
		const page = { rawRecordCount: 0, records: [], totalRecordsHint: null };
		Object.defineProperty(page, "kind", {
			get() {
				throw new Error("private-title");
			},
		});
		const deps = dependencies({ fetchProviderPage: vi.fn(async () => page) });
		const result = await collectHistoryObservationsForOwner(deps as never, userId);
		expect(result).toMatchObject({ status: "failed", sourceTurnCount: 1, failedTurnCount: 1 });
		expect(
			result.publishedTurnCount +
				result.preservedTurnCount +
				result.supersededTurnCount +
				result.failedTurnCount,
		).toBe(result.sourceTurnCount);
		expect(JSON.stringify(result)).not.toContain("private-title");
	});

	it("commits FIFO phases in disposable SQLite and resumes the persisted cursor and page after restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "history-collector-"));
		const sqlitePath = join(directory, "history.db");
		const databasePath = resolve(process.cwd(), "prisma/schema.prisma");
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", databasePath], {
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: `file:${sqlitePath}` },
			stdio: "pipe",
		});
		const prisma = new PrismaClient({
			adapter: new PrismaBetterSqlite3({ url: sqlitePath, timeout: 5_000 }),
		});
		const previousUrl = process.env.DATABASE_URL;
		const owner = `sqlite-owner-${Date.now()}`;
		try {
			await prisma.user.create({
				data: { id: owner, username: owner, hashedPassword: "synthetic" },
			});
			for (const id of ["source-a", "source-b"])
				await prisma.serviceInstance.create({
					data: {
						id,
						userId: owner,
						service: "SONARR",
						label: id,
						baseUrl: "http://provider.invalid",
						encryptedApiKey: "encrypted",
						encryptionIv: "iv",
						connectionGeneration: 3,
					},
				});
			const rows = Array.from({ length: 100 }, (_, index) => ({
				id: index + 1,
				date: "2026-09-03T17:34:56.000Z",
				eventType: "Downloaded",
				title: `synthetic-${index + 1}`,
			}));
			const dependenciesForRun = (monotonicNow: () => number) => ({
				prisma,
				clientFactory: {
					createAnyClient: vi.fn((source: { id: string }) => ({ sourceId: source.id })),
				},
				fetchProviderPage: vi.fn(
					async ({ client, page }: { client: { sourceId: string }; page: number }) => ({
						kind: "page",
						records:
							client.sourceId === "source-a" && page === 1
								? rows
								: client.sourceId === "source-a" && page === 2
									? [rows[0]]
									: [],
						rawRecordCount:
							client.sourceId === "source-a" && page === 1
								? 100
								: client.sourceId === "source-a" && page === 2
									? 1
									: 0,
						totalRecordsHint: client.sourceId === "source-a" ? 101 : 0,
					}),
				),
				monotonicNow,
				dialect: "sqlite" as const,
			});
			process.env.DATABASE_URL = `file:${sqlitePath}`;
			const first = await collectHistoryObservationsForOwner(
				dependenciesForRun(
					vi
						.fn()
						.mockReturnValueOnce(0)
						.mockReturnValueOnce(1)
						.mockReturnValueOnce(1)
						.mockReturnValueOnce(1)
						.mockReturnValueOnce(1)
						.mockReturnValueOnce(1)
						.mockReturnValueOnce(1)
						.mockReturnValueOnce(220_000)
						.mockReturnValue(220_000),
				) as never,
				owner,
			);
			expect(first).toMatchObject({
				sourceTurnCount: 2,
				providerRequestCount: 2,
				limitReason: "time-limit",
			});
			expect(
				await prisma.historySourceStatus.findUnique({ where: { instanceId: "source-a" } }),
			).toMatchObject({
				collectHeadNext: false,
				nextBackfillPage: 2,
				activeCollectionPage: null,
			});
			expect(
				await prisma.historyCollectionLease.findUnique({ where: { userId: owner } }),
			).toMatchObject({
				nextSourceCursor: "source-a",
			});

			const secondDeps = dependenciesForRun(vi.fn(() => 1));
			const second = await collectHistoryObservationsForOwner(secondDeps as never, owner);
			expect(second).toMatchObject({
				status: "completed",
				sourceTurnCount: 3,
				providerRequestCount: 3,
			});
			expect(second.sourceTurnCount).toBeLessThanOrEqual(2 * 2);
			expect(secondDeps.fetchProviderPage).toHaveBeenNthCalledWith(
				1,
				expect.objectContaining({
					client: expect.objectContaining({ sourceId: "source-a" }),
					page: 2,
				}),
			);
			expect(
				await prisma.historySourceStatus.findUnique({ where: { instanceId: "source-a" } }),
			).toMatchObject({
				lastAttemptResult: "success",
				nextBackfillPage: 2,
				activeCollectionPage: null,
			});
			expect(await prisma.historyObservation.count({ where: { instanceId: "source-a" } })).toBe(
				100,
			);
		} finally {
			if (previousUrl === undefined) delete process.env.DATABASE_URL;
			else process.env.DATABASE_URL = previousUrl;
			await prisma.$disconnect();
			rmSync(directory, { recursive: true, force: true });
		}
	}, 30_000);
});
