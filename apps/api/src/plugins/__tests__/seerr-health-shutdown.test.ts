import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRuntimeFixture } from "./runtime-fixture.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import seerrCircuitBreakerPlugin from "../seerr-circuit-breaker.js";
import seerrHealthSchedulerPlugin from "../seerr-health-scheduler.js";

const STARTUP_DELAY_MS = 20_000;
const INTERVAL_MS = 5 * 60_000;
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

type Phase = "lookup" | "provider" | "success" | "error";

async function boot(
	options: {
		holds?: Array<{ phase: Phase; call?: number; gate: Promise<void>; reject?: boolean }>;
		beforeClose?: Promise<void>;
		warmupEmpty?: boolean;
		providerFailure?: boolean;
	} = {},
) {
	const state = {
		lookup: 0,
		provider: 0,
		success: 0,
		error: 0,
		pending: 0,
		teardownCount: 0,
		pendingAtTeardown: -1,
		breakerTeardownCount: 0,
		pendingAtBreakerTeardown: -1,
		operationsAfterTeardown: 0,
	};
	const records = new Map<string, "success" | "error">();
	const entered = deferred();
	const pause = async (phase: Phase) => {
		const call = ++state[phase];
		if (state.teardownCount > 0 || state.breakerTeardownCount > 0) {
			state.operationsAfterTeardown++;
		}
		state.pending++;
		try {
			const hold = options.holds?.find((item) => item.phase === phase && (item.call ?? 1) === call);
			if (hold) {
				entered.resolve();
				await hold.gate;
			}
			return hold?.reject ?? false;
		} finally {
			state.pending--;
		}
	};
	const instances = ["synthetic-a", "synthetic-b"].map((id) => ({
		id,
		userId: id === "synthetic-a" ? "owner-a" : "owner-b",
		service: "SEERR",
		enabled: true,
		label: "Synthetic service",
		baseUrl: "https://synthetic.invalid",
		encryptedApiKey: "synthetic-cipher",
		encryptionIv: "synthetic-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
	}));
	const app = Fastify({ logger: false });
	apps.push(app);
	await installRuntimeFixture(app);
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", {
					serviceInstance: {
						async findMany(args: unknown) {
							if (JSON.stringify(args) !== '{"where":{"service":"SEERR","enabled":true}}') {
								throw new Error("Fixture refuses a changed system health selector");
							}
							if (await pause("lookup")) throw new Error("Synthetic lookup failure");
							return options.warmupEmpty && state.lookup === 1 ? [] : instances;
						},
					},
					cacheRefreshStatus: {
						async upsert(args: {
							where: { instanceId_cacheType: { instanceId: string; cacheType: string } };
							create: {
								instanceId: string;
								cacheType: string;
								lastResult: "success" | "error";
								lastRefreshedAt: Date;
								lastErrorMessage: string | null;
								itemCount: number;
							};
							update: {
								lastResult: "success" | "error";
								lastRefreshedAt: Date;
								lastErrorMessage: string | null;
							};
						}) {
							const { instanceId, cacheType } = args.where.instanceId_cacheType;
							if (
								!instances.some((instance) => instance.id === instanceId) ||
								cacheType !== "seerr_health" ||
								args.create.cacheType !== cacheType ||
								args.create.instanceId !== instanceId ||
								args.create.lastResult !== args.update.lastResult ||
								!(args.create.lastRefreshedAt instanceof Date) ||
								!(args.update.lastRefreshedAt instanceof Date) ||
								args.create.itemCount !== 0 ||
								(args.create.lastResult === "success" && args.update.lastErrorMessage !== null) ||
								(args.create.lastResult === "error" &&
									typeof args.update.lastErrorMessage !== "string")
							)
								throw new Error("Fixture refuses a changed health publication target/status");
							if (await pause(args.update.lastResult)) throw new Error("Synthetic status failure");
							records.set(instanceId, args.update.lastResult);
							return { ...args.create, ...args.update };
						},
					},
				} as never);
				server.decorate("arrClientFactory", {
					async rawRequest(
						instance: { id: string },
						path: string,
						args: { method: string; timeout: number; body?: unknown; headers?: unknown },
					) {
						if (
							!instances.includes(instance as (typeof instances)[number]) ||
							path !== "/api/v1/status" ||
							args.method !== "GET" ||
							args.timeout !== 10_000 ||
							args.body !== undefined ||
							args.headers !== undefined
						)
							throw new Error("Fixture refuses a changed provider read");
						const rejected = await pause("provider");
						if (rejected || (options.providerFailure && instance.id === "synthetic-a")) {
							return new Response("{}", {
								status: 404,
								headers: { "content-type": "application/json" },
							});
						}
						return new Response(
							JSON.stringify({
								version: "synthetic",
								commitTag: "synthetic",
								updateAvailable: false,
								commitsBehind: 0,
							}),
							{ headers: { "content-type": "application/json" } },
						);
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
	await app.register(fp(async () => undefined, { name: "security" }));
	await app.register(seerrCircuitBreakerPlugin);
	const destroy = app.seerrCircuitBreaker.destroy.bind(app.seerrCircuitBreaker);
	vi.spyOn(app.seerrCircuitBreaker, "destroy").mockImplementation(() => {
		state.breakerTeardownCount++;
		state.pendingAtBreakerTeardown = state.pending;
		destroy();
	});
	await app.register(schedulerRegistryPlugin);
	const originalTrack = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = originalTrack(...args);
		ticks.push(task.catch(() => undefined));
		return task;
	});
	const timeout = vi.spyOn(globalThis, "setTimeout");
	const interval = vi.spyOn(globalThis, "setInterval");
	await app.register(seerrHealthSchedulerPlugin);
	const closing = deferred();
	app.addHook("preClose", async () => closing.resolve());
	if (options.beforeClose) app.addHook("preClose", async () => options.beforeClose);
	await app.ready();
	const callback = (origin: "startup" | "interval") => {
		const calls = origin === "startup" ? timeout.mock.calls : interval.mock.calls;
		const timer = calls.find(
			([, delay]) => delay === (origin === "startup" ? STARTUP_DELAY_MS : INTERVAL_MS),
		)?.[0];
		if (typeof timer !== "function") throw new Error("Seerr health timer callback not captured");
		return timer;
	};
	return { app, state, records, entered: entered.promise, closing: closing.promise, callback };
}

beforeEach(() => {
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

describe("Seerr Health scheduler shutdown ownership", () => {
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of ["lookup", "provider", "success", "error"] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before dependencies close`, async () => {
					const gate = deferred();
					const fixture = await boot({
						warmupEmpty: origin === "interval",
						providerFailure: phase === "error",
						holds: [
							{
								phase,
								call: phase === "lookup" && origin === "interval" ? 2 : 1,
								gate: gate.promise,
								reject,
							},
						],
					});
					fixture.callback("startup")();
					if (origin === "interval") {
						await settle();
						fixture.callback("interval")();
					}
					await fixture.entered;
					let closed = false;
					const close = fixture.app.close().then(() => {
						closed = true;
					});
					await fixture.closing;
					await settle();
					expect(closed).toBe(false);
					expect(fixture.state.teardownCount).toBe(0);
					expect(fixture.state.breakerTeardownCount).toBe(0);
					expect(fixture.state.pending).toBe(1);
					gate.resolve();
					await close;
					expect(fixture.state.pendingAtTeardown).toBe(0);
					expect(fixture.state.pendingAtBreakerTeardown).toBe(0);
					expect(fixture.state.operationsAfterTeardown).toBe(0);
					const status = fixture.app.schedulerRegistry.getStatus(JOB_ID.seerrHealth);
					expect(status?.state).toBe("idle");
					expect(status?.totalRuns).toBe(origin === "interval" ? 2 : 1);
					expect(status?.totalFailures).toBe(phase === "lookup" && reject ? 1 : 0);
					if (phase === "lookup" && reject) {
						expect(fixture.records.size).toBe(0);
						expect(fixture.state.provider).toBe(0);
					} else {
						expect(fixture.records.get("synthetic-a")).toBe(
							phase === "error" ? (reject ? undefined : "error") : reject ? "error" : "success",
						);
						expect(fixture.records.get("synthetic-b")).toBe("success");
						expect(fixture.state.provider).toBe(2);
					}
				});
			}
		}
	}

	it("cancels startup before warmup without issuing provider reads", async () => {
		const fixture = await boot();
		await fixture.app.close();
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS + INTERVAL_MS);
		expect(fixture.state.lookup).toBe(0);
		expect(fixture.state.provider).toBe(0);
		expect(fixture.records.size).toBe(0);
	});

	it("refuses queued startup/interval callbacks in sibling preClose and after teardown", async () => {
		const gate = deferred();
		const fixture = await boot({ beforeClose: gate.promise, warmupEmpty: true });
		const startup = fixture.callback("startup");
		startup();
		await settle();
		const interval = fixture.callback("interval");
		const close = fixture.app.close();
		await fixture.closing;
		await settle();
		startup();
		interval();
		await settle();
		expect(fixture.state.lookup).toBe(1);
		expect(fixture.state.provider).toBe(0);
		gate.resolve();
		await close;
		startup();
		interval();
		await settle();
		expect(fixture.state.lookup).toBe(1);
		expect(fixture.state.operationsAfterTeardown).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("preserves no-overlap behavior while duplicate close waits the accepted check", async () => {
		const gate = deferred();
		const fixture = await boot({ holds: [{ phase: "lookup", gate: gate.promise }] });
		fixture.callback("startup")();
		await fixture.entered;
		fixture.callback("interval")();
		await settle();
		expect(fixture.state.lookup).toBe(1);
		let closed = 0;
		const closes = [fixture.app.close(), fixture.app.close()].map((promise) =>
			promise.then(() => {
				closed++;
			}),
		);
		await fixture.closing;
		await settle();
		expect(closed).toBe(0);
		gate.resolve();
		await Promise.all(closes);
		expect(closed).toBe(2);
		expect(fixture.state.teardownCount).toBe(1);
		expect(fixture.state.pendingAtBreakerTeardown).toBe(0);
		expect(fixture.records.size).toBe(2);
	});

	it("retains first-instance status while draining the second instance's failed provider read", async () => {
		const gate = deferred();
		const fixture = await boot({
			holds: [{ phase: "provider", call: 2, gate: gate.promise, reject: true }],
		});
		fixture.callback("startup")();
		await fixture.entered;
		expect(fixture.records.get("synthetic-a")).toBe("success");
		const close = fixture.app.close();
		await fixture.closing;
		await settle();
		expect(fixture.state.teardownCount).toBe(0);
		gate.resolve();
		await close;
		expect([...fixture.records]).toEqual([
			["synthetic-a", "success"],
			["synthetic-b", "error"],
		]);
		expect(fixture.state.operationsAfterTeardown).toBe(0);
	});

	it("recovers on the next scheduled check after an instance lookup failure", async () => {
		const fixture = await boot({
			holds: [{ phase: "lookup", gate: Promise.resolve(), reject: true }],
		});
		fixture.callback("startup")();
		await settle();
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.seerrHealth)?.totalFailures).toBe(1);
		expect(fixture.records.size).toBe(0);
		fixture.callback("interval")();
		await settle();
		expect(fixture.records.size).toBe(2);
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.seerrHealth)?.consecutiveFailures).toBe(
			0,
		);
	});

	it("retains twenty-second startup followed by five-minute cadence", async () => {
		const fixture = await boot();
		await vi.advanceTimersByTimeAsync(STARTUP_DELAY_MS - 1);
		expect(fixture.state.lookup).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.state.lookup).toBe(1);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
		expect(fixture.state.lookup).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fixture.state.lookup).toBe(2);
		expect(fixture.state.provider).toBe(4);
		expect(fixture.records.size).toBe(2);
	});

	it("keeps maintenance exclusion before instance/provider/status work", async () => {
		const fixture = await boot();
		await withCleanupMaintenanceGuard(async () => {
			fixture.callback("startup")();
			await settle();
			expect(fixture.state.lookup).toBe(0);
			expect(fixture.state.provider).toBe(0);
			expect(fixture.records.size).toBe(0);
			await fixture.app.close();
		});
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.seerrHealth)?.totalRuns).toBe(0);
	});
});
