import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRuntimeFixture } from "./runtime-fixture.js";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
} from "../../lib/backup/restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { synchronizeSqliteRuntimeSchema } from "../../lib/backup/runtime-schema-sqlite.js";
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

const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];

function deferred<T>(fallback: T) {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((release) => {
		resolve = release;
	});
	releases.push(() => resolve(fallback));
	return { promise, resolve };
}

async function buildTestApp(
	rows: unknown[] = [{ userId: "owner-a" }],
	options: { beforeClose?: Promise<void>; bootstrap?: boolean } = {},
) {
	if (options.bootstrap) {
		vi.useRealTimers();
		vi.useFakeTimers({
			toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
		});
	}
	const app = Fastify({ logger: false });
	apps.push(app);
	if (options.bootstrap) {
		const directory = mkdtempSync(join(tmpdir(), "history-bootstrap-"));
		chmodSync(directory, 0o700);
		const databaseUrl = `file:${join(directory, "fixture.db")}`;
		await synchronizeSqliteRuntimeSchema(databaseUrl);
		const runtime = await openRestoreRuntime({ databaseUrl });
		app.decorate("restoreRuntime", runtime);
		app.addHook("onClose", async () => {
			await runtime.close();
			rmSync(directory, { recursive: true, force: true });
		});
		await runtime.bindDestination("synthetic-history-bootstrap");
	} else await installRuntimeFixture(app);
	let teardownCount = 0;
	const findMany = vi.fn().mockResolvedValue(rows);
	const prisma = { serviceInstance: { findMany } };
	app.decorate("prisma", prisma as never);
	app.decorate("arrClientFactory", {} as never);
	app.decorate("encryptor", {} as never);
	await app.register(
		fp(
			async (scope) => {
				// Mirror the synthetic application persistence boundary's close ordering.
				scope.addHook("onClose", async () => {
					teardownCount++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(noOpDependency("security"));
	await app.register(noOpDependency("arr-client"));
	if (options.bootstrap) {
		registerRestoreBootstrapPlugin(app, schedulerRegistryPlugin);
		await app.after();
	} else await app.register(schedulerRegistryPlugin);
	const timeout = vi.spyOn(globalThis, "setTimeout");
	const interval = vi.spyOn(globalThis, "setInterval");
	const initialized = vi.fn(() =>
		getRestoreRuntimeClientContext(app.restoreRuntime).assertTicket(),
	);
	const info = vi.spyOn(app.log, "info").mockImplementation((...args) => {
		if (options.bootstrap && args[1] === "History observation scheduler initialized") initialized();
	});
	if (options.bootstrap) {
		const registered: FastifyPluginAsync[] = [];
		registerSchedulers({
			register: (plugin: FastifyPluginAsync) => registered.push(plugin),
		} as never);
		const selected = registered.filter(
			(plugin) =>
				Reflect.get(plugin, Symbol.for("fastify.display-name")) === "history-collection-scheduler",
		);
		expect(selected).toHaveLength(1);
		// Queue the final activation before awaiting Fastify's thenable; awaiting
		// register here runs readiness early, unlike the real bootstrap pipeline.
		app.register(selected[0]!);
		registerRestoreRuntimeActivation(app);
	} else await app.register(historyCollectionSchedulerPlugin);
	const warn = vi.spyOn(app.log, "warn").mockImplementation(() => undefined);
	const error = vi.spyOn(app.log, "error").mockImplementation(() => undefined);
	const closing = deferred<void>(undefined);
	app.addHook("preClose", async () => closing.resolve());
	if (options.beforeClose) app.addHook("preClose", async () => options.beforeClose);
	await app.ready();
	return {
		app,
		findMany,
		info,
		initialized,
		warn,
		error,
		closing: closing.promise,
		teardownCount: () => teardownCount,
		queuedStartup() {
			const callback = timeout.mock.calls.find(([, delay]) => delay === STARTUP_DELAY_MS)?.[0];
			if (typeof callback !== "function") throw new Error("History startup timer not captured");
			callback();
		},
		queuedInterval() {
			const callback = interval.mock.calls.find(([, delay]) => delay === INTERVAL_MS)?.[0];
			if (typeof callback !== "function") throw new Error("History interval not captured");
			callback();
		},
	};
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

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(apps.splice(0).map((app) => app.close()));
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

	it("registers the History scheduler during scheduler bootstrap", async () => {
		const { app, initialized, findMany } = await buildTestApp(undefined, { bootstrap: true });
		expect(initialized).toHaveBeenCalledOnce();
		const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
		const ticks: Promise<unknown>[] = [];
		vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
			const task = track(...args);
			if (args[0] === JOB_ID.historyCollection) ticks.push(task);
			return task;
		});
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(ticks).toHaveLength(1);
		await ticks[0];
		expect(mocks.collect).toHaveBeenCalledOnce();
		expect(app.schedulerRegistry.getStatus(JOB_ID.historyCollection)).toMatchObject({
			totalRuns: 1,
			totalFailures: 0,
			state: "idle",
		});
		await app.close();
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(findMany).toHaveBeenCalledOnce();
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

	it("drains an in-flight owner before database teardown without starting another", async () => {
		const deferred: { resolve: () => void } = { resolve: () => undefined };
		const pending = new Promise<void>((resolve) => {
			deferred.resolve = resolve;
		});
		mocks.collect.mockImplementationOnce(async () => {
			await pending;
			return result();
		});
		releases.push(deferred.resolve);
		const { app, closing, teardownCount } = await buildTestApp([
			{ userId: "owner-a" },
			{ userId: "owner-b" },
		]);
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(mocks.collect).toHaveBeenCalledTimes(1);
		let closed = false;
		const close = app.close().then(() => {
			closed = true;
		});
		try {
			await closing;
			await vi.advanceTimersByTimeAsync(0);
			expect(closed).toBe(false);
			expect(teardownCount()).toBe(0);
		} finally {
			deferred.resolve();
			await close;
		}
		expect(teardownCount()).toBe(1);
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

describe("History scheduler shutdown dependency lifetime", () => {
	it.each([false, true])("drains owner enumeration before teardown (reject=%s)", async (reject) => {
		const gate = deferred<void>(undefined);
		const fixture = await buildTestApp();
		let pending = false;
		fixture.findMany.mockImplementationOnce(async () => {
			pending = true;
			try {
				await gate.promise;
				if (reject) throw new Error("Synthetic owner-query failure");
				return [{ userId: "owner-a" }];
			} finally {
				pending = false;
			}
		});
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(pending).toBe(true);
		let closed = false;
		const close = fixture.app.close().then(() => {
			closed = true;
		});
		try {
			await fixture.closing;
			await vi.advanceTimersByTimeAsync(0);
			expect(closed).toBe(false);
			expect(fixture.teardownCount()).toBe(0);
		} finally {
			gate.resolve();
			await close;
		}
		expect(pending).toBe(false);
		expect(fixture.teardownCount()).toBe(1);
		expect(mocks.collect).not.toHaveBeenCalled();
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.historyCollection)).toMatchObject({
			totalRuns: 1,
			totalFailures: reject ? 1 : 0,
			lastError: reject ? GENERIC_FAILURE : null,
		});
	});

	it.each([false, true])(
		"drains the accepted collector and shares duplicate close (reject=%s)",
		async (reject) => {
			const gate = deferred<void>(undefined);
			let pending = false;
			mocks.collect.mockImplementationOnce(async () => {
				pending = true;
				try {
					await gate.promise;
					if (reject) throw new Error("Synthetic collector failure");
					return result();
				} finally {
					pending = false;
				}
			});
			const fixture = await buildTestApp([{ userId: "owner-a" }, { userId: "owner-b" }]);
			await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			expect(pending).toBe(true);
			let closed = false;
			const close = fixture.app.close().then(() => {
				closed = true;
			});
			const duplicate = fixture.app.close();
			try {
				await fixture.closing;
				await vi.advanceTimersByTimeAsync(0);
				expect(closed).toBe(false);
				expect(fixture.teardownCount()).toBe(0);
				expect(fixture.findMany).toHaveBeenCalledTimes(1);
			} finally {
				gate.resolve();
				await Promise.all([close, duplicate]);
			}
			expect(pending).toBe(false);
			expect(fixture.teardownCount()).toBe(1);
			expect(mocks.collect).toHaveBeenCalledTimes(1);
			expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.historyCollection)).toMatchObject({
				totalRuns: 1,
				totalFailures: reject ? 1 : 0,
				lastError: reject ? GENERIC_FAILURE : null,
			});
		},
	);

	it.each(["startup", "interval"] as const)(
		"rejects a queued %s callback while a sibling preClose is waiting",
		async (kind) => {
			const sibling = deferred<void>(undefined);
			const fixture = await buildTestApp([{ userId: "owner-a" }], { beforeClose: sibling.promise });
			if (kind === "interval") await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
			const expectedRuns = kind === "interval" ? 1 : 0;
			const close = fixture.app.close();
			try {
				await fixture.closing;
				if (kind === "startup") fixture.queuedStartup();
				else fixture.queuedInterval();
				// Flush work without also expiring Fastify's unrelated close-hook budget.
				await vi.advanceTimersByTimeAsync(0);
				expect(fixture.findMany).toHaveBeenCalledTimes(expectedRuns);
				expect(mocks.collect).toHaveBeenCalledTimes(expectedRuns);
				expect(fixture.teardownCount()).toBe(0);
			} finally {
				sibling.resolve();
				await close;
			}
			if (kind === "startup") fixture.queuedStartup();
			else fixture.queuedInterval();
			await vi.advanceTimersByTimeAsync(0);
			expect(fixture.findMany).toHaveBeenCalledTimes(expectedRuns);
			expect(fixture.teardownCount()).toBe(1);
		},
	);
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
		releases.push(resolveFirst);
		const closing = app.close();
		try {
			await vi.advanceTimersByTimeAsync(0);
		} finally {
			resolveFirst();
			await closing;
		}
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
