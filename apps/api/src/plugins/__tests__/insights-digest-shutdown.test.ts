import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRuntimeFixture } from "./runtime-fixture.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import insightsDigestSchedulerPlugin from "../insights-digest-scheduler.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";

const STARTUP_DELAY_MS = 5 * 60_000;
const INTERVAL_MS = 6 * 60 * 60_000;
const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const ticks: Promise<unknown>[] = [];

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	releases.push(resolve);
	return { promise, resolve };
}

async function settle() {
	for (let turn = 0; turn < 8; turn++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

type Phase = "user" | "seerr" | "plex" | "notify";

async function boot(
	options: {
		holds?: Array<{ phase: Phase; call?: number; gate: Promise<void>; reject?: boolean }>;
		beforeClose?: Promise<void>;
		notificationFixture?: boolean;
	} = {},
) {
	const state = {
		user: 0,
		seerr: 0,
		plex: 0,
		notify: 0,
		pending: 0,
		teardownCount: 0,
		pendingAtTeardown: -1,
		operationsAfterTeardown: 0,
	};
	const entered = deferred();
	const pause = async (phase: Phase) => {
		const call = ++state[phase];
		if (state.teardownCount > 0) state.operationsAfterTeardown++;
		state.pending++;
		try {
			const hold = options.holds?.find((item) => item.phase === phase && (item.call ?? 1) === call);
			if (hold) {
				entered.resolve();
				await hold.gate;
				if (hold.reject) throw new Error("Synthetic digest dependency failure");
			}
		} finally {
			state.pending--;
		}
	};
	const app = Fastify({ logger: false });
	apps.push(app);
	await installRuntimeFixture(app);
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", {
					user: {
						async findFirst(args: unknown) {
							if (JSON.stringify(args) !== '{"select":{"id":true}}') {
								throw new Error("Fixture refuses a changed user projection");
							}
							await pause("user");
							return { id: "owner-a" };
						},
					},
					serviceInstance: {
						async findFirst(args: { where: unknown; select: unknown }) {
							if (JSON.stringify(args.where) !== '{"userId":"owner-a","service":"SEERR"}') {
								throw new Error("Fixture refuses an unowned Seerr lookup");
							}
							await pause("seerr");
							return null;
						},
						async findMany(args: unknown) {
							if (
								JSON.stringify(args) !==
								'{"where":{"userId":"owner-a","service":"PLEX","enabled":true},"select":{"id":true},"orderBy":{"id":"asc"}}'
							) {
								throw new Error("Fixture refuses an unowned Plex lookup");
							}
							await pause("plex");
							return [];
						},
					},
				} as never);
				server.decorate("arrClientFactory", {} as never);
				server.decorate("encryptor", {} as never);
				server.decorate("notificationService", {
					// This fixture isolates the scheduler; combined-plugin tests use the real scope.
					async runProducer(operation: () => Promise<void>) {
						await operation();
					},
					async notify(payload: { eventType: string }, options: { userId: string }) {
						if (
							payload.eventType !== "LIBRARY_INSIGHT_REQUESTED_UNWATCHED" ||
							JSON.stringify(options) !== '{"userId":"owner-a"}'
						) {
							throw new Error("Fixture refuses an unowned notification");
						}
						await pause("notify");
					},
				} as never);
				server.addHook("onClose", async () => {
					state.teardownCount++;
					state.pendingAtTeardown = state.pending;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => undefined, { name: "notification-service" }));
	await app.register(schedulerRegistryPlugin);
	const originalTrack = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = originalTrack(...args);
		ticks.push(task.catch(() => undefined));
		return task;
	});
	const timeout = vi.spyOn(globalThis, "setTimeout");
	const interval = vi.spyOn(globalThis, "setInterval");
	await app.register(insightsDigestSchedulerPlugin);
	const closing = deferred();
	app.addHook("preClose", async () => closing.resolve());
	if (options.beforeClose) app.addHook("preClose", async () => options.beforeClose);
	await app.ready();
	if (options.notificationFixture) {
		// Only the findings reader is synthetic for these two lifetime cases.
		// The actual check/digest/plugin/registry and awaited dispatch remain real.
		// This fixture does not establish Plex evidence or real delivery authority.
		const reader = app.insightsDigestScheduler as unknown as {
			findRequestedUnwatched: (userId: string) => Promise<unknown[]>;
		};
		vi.spyOn(reader, "findRequestedUnwatched").mockImplementation(async (userId) => {
			if (userId !== "owner-a") throw new Error("Fixture refuses a changed digest owner");
			return [{ title: "Synthetic finding", requestedBy: "Synthetic requester" }];
		});
	}
	const callback = (kind: "startup" | "interval") => {
		const calls = kind === "startup" ? timeout.mock.calls : interval.mock.calls;
		const timer = calls.find(([, delay]) =>
			kind === "startup" ? delay === STARTUP_DELAY_MS : delay === INTERVAL_MS,
		)?.[0];
		if (typeof timer !== "function") throw new Error("Digest timer callback not captured");
		return timer;
	};
	return { app, state, entered: entered.promise, closing: closing.promise, callback };
}

beforeEach(() => {
	// Fastify close and promise settlement stay real; only timer/clock behavior is virtual.
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
});

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(ticks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Insights Digest scheduler shutdown ownership", () => {
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of ["user", "seerr", "plex"] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "rejection" : "completion"} before dependencies close`, async () => {
					const gate = deferred();
					const fixture = await boot({ holds: [{ phase, gate: gate.promise, reject }] });
					fixture.callback(origin)();
					await fixture.entered;
					let closed = false;
					const close = fixture.app.close().then(() => {
						closed = true;
					});
					await fixture.closing;
					await settle();
					expect(closed).toBe(false);
					expect(fixture.state.teardownCount).toBe(0);
					expect(fixture.state.pending).toBe(1);
					gate.resolve();
					await close;
					expect(fixture.state.pendingAtTeardown).toBe(0);
					expect(fixture.state.operationsAfterTeardown).toBe(0);
					const status = fixture.app.schedulerRegistry.getStatus(JOB_ID.insightsDigest);
					expect(status?.state).toBe("idle");
					expect(status?.totalRuns).toBe(1);
					// The real authority service turns a failed connection query into unavailable evidence.
					expect(status?.totalFailures).toBe(reject && phase !== "plex" ? 1 : 0);
					expect(fixture.state.notify).toBe(0);
				});
			}
		}
	}

	for (const reject of [false, true]) {
		it(`drains a digest's awaited notification ${reject ? "rejection" : "completion"}`, async () => {
			const gate = deferred();
			const fixture = await boot({
				notificationFixture: true,
				holds: [{ phase: "notify", gate: gate.promise, reject }],
			});
			fixture.callback("startup")();
			await fixture.entered;
			let closed = false;
			const close = fixture.app.close().then(() => {
				closed = true;
			});
			await fixture.closing;
			await settle();
			expect(closed).toBe(false);
			expect(fixture.state.teardownCount).toBe(0);
			gate.resolve();
			await close;
			expect(fixture.state.pendingAtTeardown).toBe(0);
			expect(fixture.state.operationsAfterTeardown).toBe(0);
			expect(fixture.state.notify).toBe(1);
			expect(fixture.state.plex).toBe(1);
		});
	}

	it("cancels the startup timeout and interval when closed before the warmup", async () => {
		const fixture = await boot();
		await fixture.app.close();
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + INTERVAL_MS);
		expect(fixture.state.user).toBe(0);
		expect(fixture.state.operationsAfterTeardown).toBe(0);
	});

	it("refuses queued callbacks during sibling preClose and after teardown", async () => {
		const gate = deferred();
		const fixture = await boot({ beforeClose: gate.promise });
		const startup = fixture.callback("startup");
		const interval = fixture.callback("interval");
		const close = fixture.app.close();
		await fixture.closing;
		await settle();
		startup();
		interval();
		await settle();
		expect(fixture.state.user).toBe(0);
		gate.resolve();
		await close;
		startup();
		interval();
		await settle();
		expect(fixture.state.user).toBe(0);
		expect(fixture.state.operationsAfterTeardown).toBe(0);
	});

	it("drains overlapping accepted checks independently across duplicate close", async () => {
		const first = deferred();
		const second = deferred();
		const fixture = await boot({
			holds: [
				{ phase: "user", call: 1, gate: first.promise },
				{ phase: "user", call: 2, gate: second.promise },
			],
		});
		fixture.callback("startup")();
		await fixture.entered;
		fixture.callback("interval")();
		await settle();
		expect(fixture.state.pending).toBe(2);
		let closed = 0;
		const closes = [fixture.app.close(), fixture.app.close()].map((promise) =>
			promise.then(() => {
				closed++;
			}),
		);
		await fixture.closing;
		first.resolve();
		await settle();
		expect(closed).toBe(0);
		expect(fixture.state.pending).toBe(1);
		expect(fixture.state.teardownCount).toBe(0);
		second.resolve();
		await Promise.all(closes);
		expect(closed).toBe(2);
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.teardownCount).toBe(1);
		expect(fixture.state.operationsAfterTeardown).toBe(0);
	});

	it("keeps ordinary stop/start restartable but refuses retired timer callbacks", async () => {
		const fixture = await boot();
		const retiredStartup = fixture.callback("startup");
		const retiredInterval = fixture.callback("interval");
		fixture.app.insightsDigestScheduler.stop();
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(fixture.state.user).toBe(0);
		fixture.app.insightsDigestScheduler.start();
		retiredStartup();
		retiredInterval();
		await settle();
		expect(fixture.state.user).toBe(0);
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS);
		expect(fixture.state.user).toBe(1);
		await fixture.app.close();
		fixture.app.insightsDigestScheduler.start();
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + INTERVAL_MS);
		expect(fixture.state.user).toBe(1);
	});

	it("retains normal warmup and six-hour cadence without duplicate start timers", async () => {
		const fixture = await boot();
		fixture.app.insightsDigestScheduler.start();
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
		expect(fixture.state.user).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.state.user).toBe(1);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS - STARTUP_DELAY_MS - 1);
		expect(fixture.state.user).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.state.user).toBe(2);
		expect(fixture.state.notify).toBe(0);
	});

	it("keeps maintenance exclusion before any digest dependency or delivery", async () => {
		const fixture = await boot();
		await withCleanupMaintenanceGuard(async () => {
			fixture.callback("startup")();
			await settle();
			expect(fixture.state.user).toBe(0);
			expect(fixture.state.notify).toBe(0);
			await fixture.app.close();
		});
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.insightsDigest)?.totalRuns).toBe(0);
		expect(fixture.state.pendingAtTeardown).toBe(0);
	});
});
