import Fastify from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import { HISTORY_SERVICE_TYPES } from "../../lib/history/history-source-contract.js";
import { JOB_ID, KNOWN_JOBS } from "../../lib/scheduler-registry/job-definitions.js";
import {
	HISTORY_SCHEDULER_MAX_DURATION_MS,
	HISTORY_SCHEDULER_MAX_TELEMETRY_VALUE,
} from "../history-collection-scheduler.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";

const mocks = vi.hoisted(() => ({ collect: vi.fn() }));

vi.mock("../../lib/history/history-collector.js", () => ({
	collectHistoryObservationsForOwner: mocks.collect,
}));

import historyCollectionSchedulerPlugin from "../history-collection-scheduler.js";

const STARTUP_DELAY_MS = 3 * 60_000;
const INTERVAL_MS = 5 * 60_000;
const GENERIC_FAILURE = "History observation scheduler failed";

function result(
	status: "completed" | "lease-unavailable" | "superseded" | "failed" = "completed",
	overrides: Record<string, unknown> = {},
) {
	return {
		status,
		candidateSourceCount: 1,
		sourceTurnCount: 1,
		providerRequestCount: 1,
		rawRecordCount: 1,
		publishedTurnCount: status === "completed" ? 1 : 0,
		preservedTurnCount: 0,
		supersededTurnCount: status === "superseded" ? 1 : 0,
		failedTurnCount: status === "failed" ? 1 : 0,
		sourceSetTruncated: false,
		limitReason: null,
		leaseReleased: true,
		durationMs: 12,
		...overrides,
	};
}

function noOpDependency(name: string) {
	return fp(async () => undefined, { name });
}

async function buildTestApp(rows: unknown[] = [{ userId: "owner-a" }]) {
	const app = Fastify({ logger: false });
	const findMany = vi.fn().mockResolvedValue(rows);
	const prisma = { serviceInstance: { findMany } };
	app.decorate("prisma", prisma as never);
	app.decorate("arrClientFactory", {} as never);
	app.decorate("encryptor", {} as never);
	await app.register(noOpDependency("prisma"));
	await app.register(noOpDependency("security"));
	await app.register(noOpDependency("arr-client"));
	await app.register(schedulerRegistryPlugin);
	await app.register(historyCollectionSchedulerPlugin);
	const info = vi.spyOn(app.log, "info").mockImplementation(() => undefined);
	const warn = vi.spyOn(app.log, "warn").mockImplementation(() => undefined);
	const error = vi.spyOn(app.log, "error").mockImplementation(() => undefined);
	await app.ready();
	return { app, findMany, info, warn, error };
}

async function settle() {
	await vi.runOnlyPendingTimersAsync();
	await Promise.resolve();
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.clearAllMocks();
	mocks.collect.mockResolvedValue(result());
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("History scheduler catalog and bootstrap", () => {
	it("has one stable five-minute serial job definition", () => {
		expect(JOB_ID.historyCollection).toBe("history-collection");
		expect(KNOWN_JOBS).toContainEqual(
			expect.objectContaining({
				id: JOB_ID.historyCollection,
				concurrency: "serial",
				intervalMs: INTERVAL_MS,
			}),
		);
	});

	it("registers the History scheduler during scheduler bootstrap", () => {
		const register = vi.fn();
		registerSchedulers({ register } as never);
		expect(register).toHaveBeenCalledWith(historyCollectionSchedulerPlugin);
	});
});

describe("History scheduler lifecycle", () => {
	it("waits exactly three minutes, ticks immediately, then repeats every five minutes", async () => {
		const { app } = await buildTestApp();
		try {
			expect(mocks.collect).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
			expect(mocks.collect).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(mocks.collect).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
			expect(mocks.collect).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			expect(mocks.collect).toHaveBeenCalledTimes(2);
		} finally {
			await app.close();
		}
	});

	it("does not start or install an interval when closed before startup", async () => {
		const { app, findMany } = await buildTestApp();
		await app.close();
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + INTERVAL_MS);
		expect(findMany).not.toHaveBeenCalled();
		expect(mocks.collect).not.toHaveBeenCalled();
	});

	it("clears timers on close and lets an in-flight owner settle without starting another", async () => {
		const deferred: { resolve: () => void } = { resolve: () => undefined };
		const pending = new Promise<void>((resolve) => {
			deferred.resolve = resolve;
		});
		mocks.collect.mockImplementationOnce(async () => {
			await pending;
			return result();
		});
		const { app } = await buildTestApp([{ userId: "owner-a" }, { userId: "owner-b" }]);
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(mocks.collect).toHaveBeenCalledTimes(1);
		await app.close();
		deferred.resolve();
		await settle();
		expect(mocks.collect).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2);
		expect(mocks.collect).toHaveBeenCalledTimes(1);
	});

	it("skips overlap before querying owners or tracking a second tick", async () => {
		let release!: () => void;
		const pending = new Promise<ReturnType<typeof result>>((resolve) => {
			release = () => resolve(result());
		});
		mocks.collect.mockReturnValue(pending);
		const { app, findMany, warn } = await buildTestApp();
		const track = vi.spyOn(app.schedulerRegistry, "track");
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			await vi.advanceTimersByTimeAsync(INTERVAL_MS);
			expect(findMany).toHaveBeenCalledTimes(1);
			expect(mocks.collect).toHaveBeenCalledTimes(1);
			expect(track).toHaveBeenCalledTimes(1);
			expect(warn).toHaveBeenCalledWith(
				expect.objectContaining({ provider: "history", reasonCode: "overlap_skip" }),
				expect.any(String),
			);
			const status = app.schedulerRegistry.getStatus(JOB_ID.historyCollection);
			expect(status?.totalRuns).toBe(0);
			release();
			await settle();
		} finally {
			await app.close();
		}
	});
});

describe("History scheduler owner contract", () => {
	it.each([
		["control characters", "owner-\n-invalid"],
		["overlong UTF-8 ids", "é".repeat(129)],
	])("rejects owner ids with %s before collector invocation", async (_name, userId) => {
		const { app } = await buildTestApp([{ userId }]);
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			expect(mocks.collect).not.toHaveBeenCalled();
			expect(app.schedulerRegistry.getStatus(JOB_ID.historyCollection)?.lastError).toBe(
				GENERIC_FAILURE,
			);
		} finally {
			await app.close();
		}
	});

	it("queries only enabled supported owners in ascending order and defensively deduplicates", async () => {
		const { app, findMany } = await buildTestApp([
			{ userId: "owner-b" },
			{ userId: "owner-a" },
			{ userId: "owner-b" },
		]);
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			expect(findMany).toHaveBeenCalledWith({
				where: { enabled: true, service: { in: [...HISTORY_SERVICE_TYPES] } },
				select: { userId: true },
				orderBy: { userId: "asc" },
				distinct: ["userId"],
			});
			expect(mocks.collect.mock.calls.map(([deps, owner]) => [deps, owner])).toEqual([
				[{ prisma: app.prisma, clientFactory: app.arrClientFactory }, "owner-a"],
				[{ prisma: app.prisma, clientFactory: app.arrClientFactory }, "owner-b"],
			]);
		} finally {
			await app.close();
		}
	});

	it("treats zero eligible owners as a tracked successful no-op", async () => {
		const { app } = await buildTestApp([]);
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			expect(mocks.collect).not.toHaveBeenCalled();
			const status = app.schedulerRegistry.getStatus(JOB_ID.historyCollection);
			expect(status?.totalRuns).toBe(1);
			expect(status?.totalFailures).toBe(0);
		} finally {
			await app.close();
		}
	});

	it("processes owners serially and isolates each owner arguments", async () => {
		let active = 0;
		let maxActive = 0;
		mocks.collect.mockImplementation(async () => {
			active += 1;
			maxActive = Math.max(maxActive, active);
			await Promise.resolve();
			active -= 1;
			return result();
		});
		const { app } = await buildTestApp([{ userId: "owner-a" }, { userId: "owner-b" }]);
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			expect(maxActive).toBe(1);
			expect(mocks.collect.mock.calls.map(([, owner]) => owner)).toEqual(["owner-a", "owner-b"]);
		} finally {
			await app.close();
		}
	});

	it("keeps lease-unavailable and superseded distinct while continuing", async () => {
		mocks.collect
			.mockResolvedValueOnce(result("lease-unavailable"))
			.mockResolvedValueOnce(result("superseded"))
			.mockResolvedValueOnce(result("completed"));
		const { app, info } = await buildTestApp([
			{ userId: "owner-a" },
			{ userId: "owner-b" },
			{ userId: "owner-c" },
		]);
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			const status = app.schedulerRegistry.getStatus(JOB_ID.historyCollection);
			expect(status?.totalRuns).toBe(1);
			expect(status?.lastError).toBeNull();
			const aggregate = info.mock.calls
				.map(([payload]) => payload)
				.find((payload) => payload && typeof payload === "object" && "outcome" in payload) as
				| Record<string, unknown>
				| undefined;
			expect(aggregate).toEqual(
				expect.objectContaining({
					leaseUnavailableOwnerCount: 1,
					supersededOwnerCount: 1,
					completedOwnerCount: 1,
				}),
			);
		} finally {
			await app.close();
		}
	});

	it.each([
		["throws", () => Promise.reject(new Error("PRIVATE SDK URL token"))],
		["returns malformed", () => Promise.resolve({ status: "completed", privateTitle: "PRIVATE" })],
		["returns failed", () => Promise.resolve(result("failed"))],
	])(
		"isolates an owner %s, continues, and stores only the constant generic failure",
		async (_name, implementation) => {
			mocks.collect.mockImplementationOnce(implementation).mockResolvedValue(result());
			const { app, info, warn, error } = await buildTestApp([
				{ userId: "owner-a" },
				{ userId: "owner-b" },
			]);
			try {
				await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
				expect(mocks.collect).toHaveBeenCalledTimes(2);
				const status = app.schedulerRegistry.getStatus(JOB_ID.historyCollection);
				expect(status?.lastError).toBe(GENERIC_FAILURE);
				expect(JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(
					"PRIVATE",
				);
			} finally {
				await app.close();
			}
		},
	);

	it("stops between owner settlements without starting the next owner", async () => {
		let resolveFirst!: () => void;
		mocks.collect.mockImplementationOnce(
			() => new Promise((resolve) => (resolveFirst = () => resolve(result()))),
		);
		const { app } = await buildTestApp([{ userId: "owner-a" }, { userId: "owner-b" }]);
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		await app.close();
		resolveFirst();
		await settle();
		expect(mocks.collect).toHaveBeenCalledTimes(1);
	});
});

describe("History scheduler telemetry", () => {
	it("caps valid large collector counts while retaining a separate long-duration ceiling", async () => {
		let release!: () => void;
		mocks.collect.mockResolvedValue(
			result("completed", {
				candidateSourceCount: Number.MAX_SAFE_INTEGER,
				sourceTurnCount: Number.MAX_SAFE_INTEGER,
				providerRequestCount: Number.MAX_SAFE_INTEGER,
				rawRecordCount: Number.MAX_SAFE_INTEGER,
				publishedTurnCount: Number.MAX_SAFE_INTEGER,
				preservedTurnCount: Number.MAX_SAFE_INTEGER,
				supersededTurnCount: Number.MAX_SAFE_INTEGER,
				failedTurnCount: Number.MAX_SAFE_INTEGER,
			}),
		);
		mocks.collect.mockImplementationOnce(
			() =>
				new Promise(
					(resolve) =>
						(release = () =>
							resolve(
								result("completed", {
									candidateSourceCount: Number.MAX_SAFE_INTEGER,
									sourceTurnCount: Number.MAX_SAFE_INTEGER,
									providerRequestCount: Number.MAX_SAFE_INTEGER,
									rawRecordCount: Number.MAX_SAFE_INTEGER,
									publishedTurnCount: Number.MAX_SAFE_INTEGER,
									preservedTurnCount: Number.MAX_SAFE_INTEGER,
									supersededTurnCount: Number.MAX_SAFE_INTEGER,
									failedTurnCount: Number.MAX_SAFE_INTEGER,
								}),
							)),
				),
		);
		const { app, info } = await buildTestApp();
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			await vi.advanceTimersByTimeAsync(HISTORY_SCHEDULER_MAX_DURATION_MS + 1_000);
			release();
			await vi.advanceTimersByTimeAsync(0);
			const aggregate = info.mock.calls
				.map(([payload]) => payload)
				.find((payload) => payload && typeof payload === "object" && "outcome" in payload) as
				| Record<string, unknown>
				| undefined;
			expect(aggregate).toBeDefined();
			for (const [key, value] of Object.entries(aggregate ?? {})) {
				if (key.endsWith("Count")) {
					expect(value).toEqual(expect.any(Number));
					expect(Number.isFinite(value)).toBe(true);
					expect(Number.isInteger(value)).toBe(true);
					expect(value).toBeLessThanOrEqual(HISTORY_SCHEDULER_MAX_TELEMETRY_VALUE);
				}
			}
			expect(aggregate?.durationMs).toBe(HISTORY_SCHEDULER_MAX_DURATION_MS);
		} finally {
			await app.close();
		}
	});

	it("bounds aggregate numeric telemetry and excludes private values and errors", async () => {
		mocks.collect.mockResolvedValue(
			result("completed", {
				candidateSourceCount: Number.POSITIVE_INFINITY,
				sourceTurnCount: -1,
				providerRequestCount: 1.5,
				durationMs: Number.NaN,
				privateTitle: "PRIVATE_TITLE",
			}),
		);
		const { app, info, warn, error } = await buildTestApp();
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			expect(app.schedulerRegistry.getStatus(JOB_ID.historyCollection)?.lastError).toBe(
				GENERIC_FAILURE,
			);
			const output = JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls]);
			expect(output).not.toContain("PRIVATE_TITLE");
			expect(output).not.toContain("NaN");
			expect(output).not.toContain("Infinity");
			expect(output).not.toContain("PRIVATE");
		} finally {
			await app.close();
		}
	});

	it("records an owner-enumeration rejection as a sanitized failed tick", async () => {
		const { app, findMany, info, warn, error } = await buildTestApp();
		findMany.mockRejectedValueOnce(new Error("PRIVATE DATABASE URL credential"));
		try {
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			const status = app.schedulerRegistry.getStatus(JOB_ID.historyCollection);
			expect(status?.lastError).toBe(GENERIC_FAILURE);
			expect(JSON.stringify([info.mock.calls, warn.mock.calls, error.mock.calls])).not.toContain(
				"PRIVATE",
			);
		} finally {
			await app.close();
		}
	});
});
