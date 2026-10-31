import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRuntimeFixture } from "./runtime-fixture.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import scheduler from "../infohash-backfill-scheduler.js";
import registry from "../scheduler-registry.js";

// Real count helpers, registry, maintenance admission and Fastify hooks. Sweep
// boundaries are synthetic: their provider matching/publication have separate
// tests. This fixture never calls a provider or an existing database.
const boundary = vi.hoisted(() => ({
	history: vi.fn(),
	path: vi.fn(),
	metadata: vi.fn(),
	episode: vi.fn(),
}));
vi.mock("../../lib/library-sync/infohash-backfill.js", async (original) => ({
	...(await original<typeof import("../../lib/library-sync/infohash-backfill.js")>()),
	runInfoHashBackfillSweep: boundary.history,
}));
vi.mock("../../lib/library-sync/infohash-backfill-by-path.js", () => ({
	runPathBackfillSweep: boundary.path,
}));
vi.mock("../../lib/library-sync/episode-file-backfill.js", () => ({
	runEpisodeFileSync: boundary.metadata,
	runEpisodeBackfillSweep: boundary.episode,
}));
type Origin = "startup" | "steady" | "retry";
type Phase =
	| "users"
	| "candidate-movie"
	| "candidate-episode"
	| "outstanding-movie"
	| "outstanding-episode"
	| "due-movie"
	| "due-episode"
	| "history"
	| "path"
	| "metadata"
	| "episode";
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [];
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
async function settle() {
	for (let i = 0; i < 8; i++) await new Promise<void>((done) => setImmediate(done));
}
async function boot(
	options: {
		hold?: { phase: Phase; gate: Promise<void>; call?: number; reject?: boolean };
		backlog?: number[];
		preClose?: Promise<void>;
	} = {},
) {
	const state = {
		pending: 0,
		teardown: false,
		afterTeardown: 0,
		pendingAtTeardown: -1,
		armed: false,
	};
	const counts = new Map<Phase, number>(),
		order: Phase[] = [];
	const backlog = [...(options.backlog ?? [0])];
	async function pause(phase: Phase) {
		const call = (counts.get(phase) ?? 0) + 1;
		counts.set(phase, call);
		order.push(phase);
		state.pending++;
		if (state.teardown) state.afterTeardown++;
		try {
			if (state.armed && options.hold?.phase === phase && call === (options.hold.call ?? 1)) {
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic unavailable boundary");
			}
		} finally {
			state.pending--;
			if (state.teardown) state.afterTeardown++;
		}
	}
	const forbidden = vi.fn(() => {
		throw new Error("Forbidden persistence or credential operation");
	});
	const owners = { in: ["owner-a", "owner-b"] };
	const prisma = new Proxy(
		{
			serviceInstance: {
				findMany: async (args: unknown) => {
					expect(args).toEqual({
						where: { service: "QUI", enabled: true },
						select: { userId: true },
						distinct: ["userId"],
					});
					await pause("users");
					return [{ userId: "owner-a" }, { userId: "owner-b" }];
				},
			},
			libraryCache: {
				count: async ({ where }: { where: Record<string, unknown> }) => {
					let phase: Phase;
					if (where.OR) {
						phase = "candidate-movie";
						expect(where).toEqual({
							infoHash: null,
							instance: { userId: owners },
							OR: [
								{ itemType: "series" },
								{
									itemType: "movie",
									OR: [
										{ pathBackfillRetryAfter: null },
										{ pathBackfillRetryAfter: { lte: expect.any(Date) } },
									],
								},
							],
						});
					} else if (where.pathBackfillRetryAfter) {
						phase = "due-movie";
						expect(where).toEqual({
							infoHash: null,
							itemType: "movie",
							pathBackfillRetryAfter: { lte: expect.any(Date) },
							instance: { userId: owners, service: "RADARR" },
						});
					} else {
						phase = "outstanding-movie";
						expect(where).toEqual({
							infoHash: null,
							itemType: { in: ["movie", "series"] },
							instance: { userId: owners },
						});
					}
					await pause(phase);
					return !state.armed
						? 0
						: phase === "candidate-movie"
							? (backlog.shift() ?? 0)
							: phase === "due-movie"
								? 1
								: 7;
				},
			},
			episodeFileCache: {
				count: async ({ where }: { where: Record<string, unknown> }) => {
					let phase: Phase;
					if (where.OR) {
						phase = "candidate-episode";
						expect(where).toEqual({
							infoHash: null,
							instance: { userId: owners, service: "SONARR" },
							OR: [
								{ inodeBackfillRetryAfter: null },
								{ inodeBackfillRetryAfter: { lte: expect.any(Date) } },
							],
						});
					} else if (where.inodeBackfillRetryAfter) {
						phase = "due-episode";
						expect(where).toEqual({
							infoHash: null,
							instance: { userId: owners, service: "SONARR" },
							inodeBackfillRetryAfter: { lte: expect.any(Date) },
						});
					} else {
						phase = "outstanding-episode";
						expect(where).toEqual({
							infoHash: null,
							instance: { userId: owners, service: "SONARR" },
						});
					}
					await pause(phase);
					return state.armed && phase === "due-episode" ? 1 : 0;
				},
			},
		},
		{
			get(target, key) {
				return key in target
					? target[key as keyof typeof target]
					: ["then", "getter", "setter"].includes(String(key))
						? undefined
						: forbidden;
			},
		},
	);
	const app = Fastify({ logger: false });
	apps.push(app);
	await installRuntimeFixture(app);
	for (const phase of ["history", "path", "metadata", "episode"] as const)
		boundary[phase].mockImplementation(async (args) => {
			expect(args.app).toBe(app);
			if (phase === "history") expect(args).toMatchObject({ batchSize: 500, perRowSleepMs: 100 });
			if (phase === "metadata") expect(args.seriesCap).toBe(1000);
			if (phase === "path") expect(args.batchSize).toBe(500);
			if (phase === "episode") expect(args.batchSize).toBe(args.dueOnly ? 1000 : 2000);
			await pause(phase);
			return {
				usersScanned: 2,
				rowsScanned: 2,
				rowsHashed: 1,
				rowsMissed: 1,
				errors: 0,
				durationMs: 0,
				filesUpserted: 2,
			};
		});
	app.register(
		fp(
			async (scope) => {
				scope.decorate("prisma", prisma as unknown as FastifyInstance["prisma"]);
				scope.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					state.teardown = true;
				});
			},
			{ name: "prisma" },
		),
	);
	app.register(
		fp(
			async (scope) => {
				scope.decorate("encryptor", {
					decrypt: forbidden,
				} as unknown as FastifyInstance["encryptor"]);
			},
			{ name: "security" },
		),
	);
	app.register(registry);
	app.register(scheduler);
	const preClosed = deferred();
	// Observe and hold shutdown only after the real scheduler closes admission.
	app.register(
		fp(
			async (server) => {
				server.addHook("preClose", async () => preClosed.resolve());
				if (options.preClose) server.addHook("preClose", async () => options.preClose);
			},
			{
				name: "infohash-backfill-shutdown-observer",
				dependencies: ["infohash-backfill-scheduler"],
			},
		),
	);
	const timeouts = vi.spyOn(globalThis, "setTimeout"),
		intervals = vi.spyOn(globalThis, "setInterval");
	await app.ready();
	const track = vi.spyOn(app.schedulerRegistry, "track"),
		info = vi.spyOn(app.log, "info"),
		warn = vi.spyOn(app.log, "warn");
	function callback(origin: Origin) {
		const spy = origin === "startup" ? timeouts : intervals,
			ms = origin === "startup" ? 30_000 : origin === "steady" ? 6 * 60 * 60_000 : 5 * 60_000;
		let index = -1;
		spy.mock.calls.forEach(([, delay], call) => {
			if (delay === ms) index = call;
		});
		const fn = spy.mock.calls[index]?.[0];
		if (typeof fn !== "function") throw new Error("Backfill callback missing");
		return () => {
			if (origin === "startup") clearTimeout(spy.mock.results[index]?.value);
			fn();
		};
	}
	function arm() {
		state.armed = true;
		counts.clear();
		order.splice(0);
	}
	return {
		app,
		state,
		counts,
		order,
		track,
		info,
		warn,
		forbidden,
		callback,
		arm,
		intervals,
		async start(origin: Origin) {
			if (origin !== "startup") {
				callback("startup")();
				await settle();
			}
			arm();
			callback(origin)();
			await settle();
		},
		async closePending() {
			let settled = false;
			const promise = app.close().then(() => {
				settled = true;
			});
			await preClosed.promise;
			await settle();
			return { promise, settled: () => settled };
		},
		status: () => app.schedulerRegistry.getStatus(JOB_ID.infoHashBackfill)!,
	};
}
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids network"));
	for (const mock of Object.values(boundary)) mock.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	const closing = Promise.all(apps.splice(0).map((app) => app.close()));
	// Only cleanup failed RED cases: wake an old scheduler's unowned idle sleep.
	await vi.advanceTimersByTimeAsync(60_000);
	await settle();
	await closing;
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
describe("infoHash backfill accepted-work lifecycle", () => {
	const scenarios: Array<{ origin: Origin; phases: Phase[] }> = [
		{
			origin: "startup",
			phases: [
				"users",
				"candidate-movie",
				"candidate-episode",
				"outstanding-movie",
				"outstanding-episode",
				"history",
				"path",
				"metadata",
				"episode",
			],
		},
		{ origin: "steady", phases: ["history", "path", "metadata", "episode"] },
		{ origin: "retry", phases: ["users", "due-movie", "due-episode", "path", "episode"] },
	];
	for (const { origin, phases } of scenarios)
		for (const phase of phases)
			for (const reject of [false, true]) {
				it(`protects and drains ${origin} ${phase} ${reject ? "failure" : "success"} before teardown`, async () => {
					const held = deferred(),
						h = await boot({
							hold: { phase, gate: held.promise, reject },
							backlog: phase.startsWith("outstanding-") ? [0] : [1],
						});
					await h.start(origin);
					expect(h.state.pending).toBeGreaterThan(0);
					const close = await h.closePending();
					try {
						await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
							statusCode: 409,
						});
						expect(close.settled()).toBe(false);
						expect(h.state.teardown).toBe(false);
					} finally {
						held.resolve();
						await close.promise;
					}
					expect(h.state.pendingAtTeardown).toBe(0);
					expect(h.state.afterTeardown).toBe(0);
					expect(h.forbidden).not.toHaveBeenCalled();
					await expect(withCleanupMaintenanceGuard(async () => "safe")).resolves.toBe("safe");
				});
			}
	for (const origin of ["startup", "steady", "retry"] as const) {
		it(`rejects retained ${origin} callback during preClose and after close`, async () => {
			const held = deferred(),
				h = await boot({ preClose: held.promise });
			if (origin !== "startup") {
				h.callback("startup")();
				await settle();
			}
			h.arm();
			h.track.mockClear();
			const close = await h.closePending();
			try {
				h.callback(origin)();
				await settle();
				expect(h.counts.size).toBe(0);
				expect(h.track).not.toHaveBeenCalled();
			} finally {
				held.resolve();
				await close.promise;
			}
			h.callback(origin)();
			await settle();
			expect(h.counts.size).toBe(0);
			expect(h.track).not.toHaveBeenCalled();
		});
		it(`denies ${origin} during maintenance and recovers on a later steady tick`, async () => {
			const held = deferred(),
				h = await boot();
			if (origin !== "startup") {
				h.callback("startup")();
				await settle();
			}
			h.arm();
			const maintenance = withCleanupMaintenanceGuard(async () => held.promise);
			await settle();
			try {
				h.callback(origin)();
				await settle();
				expect(h.counts.size).toBe(0);
				expect(h.status().totalRuns).toBe(0);
				expect(h.warn).not.toHaveBeenCalled();
			} finally {
				held.resolve();
				await maintenance;
			}
			h.callback("steady")();
			await settle();
			expect(h.counts.get("history")).toBe(1);
			expect(h.counts.get("episode")).toBe(1);
		});
	}
	it("does not hold maintenance through an idle gap and closes without waiting sixty seconds", async () => {
		const h = await boot({ backlog: [2, 1, 0] });
		await h.start("startup");
		expect(h.counts.get("history")).toBe(1);
		expect(h.state.pending).toBe(0);
		await expect(withCleanupMaintenanceGuard(async () => "idle safe")).resolves.toBe("idle safe");
		const close = await h.closePending();
		try {
			expect(close.settled()).toBe(true);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			await vi.advanceTimersByTimeAsync(60_000);
			await close.promise;
		}
		expect(h.counts.get("history")).toBe(1);
		expect(h.state.afterTeardown).toBe(0);
	});
	for (const reject of [false, true])
		it(`retains the outstanding-user ${reject ? "failure" : "success"} probe after an empty candidate count`, async () => {
			const held = deferred(),
				h = await boot({
					hold: { phase: "users", gate: held.promise, call: 2, reject },
					backlog: [0],
				});
			await h.start("startup");
			const close = await h.closePending();
			try {
				expect(close.settled()).toBe(false);
				await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
					statusCode: 409,
				});
			} finally {
				held.resolve();
				await close.promise;
			}
			expect(h.state.afterTeardown).toBe(0);
			expect(h.state.pendingAtTeardown).toBe(0);
		});
	for (const origin of ["startup", "steady", "retry"] as const)
		it(`recovers after an accepted ${origin} operation rejects`, async () => {
			const held = deferred(),
				h = await boot({
					hold: {
						phase: origin === "steady" ? "history" : "users",
						gate: held.promise,
						reject: true,
					},
				});
			await h.start(origin);
			held.resolve();
			await settle();
			if (origin === "retry")
				expect(h.warn).toHaveBeenCalledWith(
					{ category: "correlation-retry-failed" },
					"infoHash due correlation retry failed; next probe will retry",
				);
			await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
			h.callback("steady")();
			await settle();
			expect(h.counts.get("episode")).toBe(1);
			expect(h.status().state).toBe("idle");
		});
	it("does not overlap steady and due-only sweeps, then permits a later retry", async () => {
		const held = deferred(),
			h = await boot({ hold: { phase: "history", gate: held.promise } });
		await h.start("steady");
		h.callback("retry")();
		h.callback("steady")();
		await settle();
		try {
			expect(h.counts.get("history")).toBe(1);
			expect(h.counts.get("users")).toBeUndefined();
		} finally {
			held.resolve();
			await settle();
		}
		h.callback("retry")();
		await settle();
		expect(h.counts.get("due-movie")).toBe(1);
		expect(h.counts.get("path")).toBe(2);
		expect(h.status().totalRuns).toBe(2);
	});
	it("waits thirty seconds to start and keeps the five-minute due-only cadence", async () => {
		const h = await boot();
		h.arm();
		await vi.advanceTimersByTimeAsync(29_999);
		expect(h.counts.size).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(h.counts.get("users")).toBe(2);
		expect(h.counts.get("history")).toBeUndefined();
		await vi.advanceTimersByTimeAsync(299_999);
		expect(h.counts.get("due-movie")).toBeUndefined();
		await vi.advanceTimersByTimeAsync(1);
		await settle();
		expect(h.counts.get("due-movie")).toBe(1);
		expect(h.counts.get("path")).toBe(1);
		expect(h.counts.get("metadata")).toBeUndefined();
	});
	it("retains the full accepted sweep after shutdown begins during history", async () => {
		const held = deferred(),
			h = await boot({ hold: { phase: "history", gate: held.promise }, backlog: [1] });
		await h.start("startup");
		const close = await h.closePending();
		try {
			expect(close.settled()).toBe(false);
		} finally {
			held.resolve();
			await close.promise;
		}
		expect(
			h.order.filter((phase) => ["history", "path", "metadata", "episode"].includes(phase)),
		).toEqual(["history", "path", "metadata", "episode"]);
		expect(h.state.afterTeardown).toBe(0);
	});
	it("keeps one catch-up admission if its retained startup callback fires twice", async () => {
		const held = deferred(),
			h = await boot({ hold: { phase: "users", gate: held.promise } });
		await h.start("startup");
		h.callback("startup")();
		await settle();
		try {
			expect(h.counts.get("users")).toBe(1);
		} finally {
			held.resolve();
			await settle();
		}
		expect(
			h.intervals.mock.calls.filter(([, ms]) => [300_000, 21_600_000].includes(Number(ms))),
		).toHaveLength(2);
	});
	it("retains two catch-up batches and refreshes episode metadata only once after success", async () => {
		const h = await boot({ backlog: [3, 2, 0] });
		await h.start("startup");
		await vi.advanceTimersByTimeAsync(120_000);
		await settle();
		expect(h.counts.get("history")).toBe(2);
		expect(h.counts.get("metadata")).toBe(1);
		expect(h.counts.get("episode")).toBe(2);
		expect(h.info).toHaveBeenCalledWith(
			{ outstanding: 7 },
			"infoHash backfill: no currently eligible rows; unresolved backlog remains",
		);
	});
});
