import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRuntimeFixture } from "./runtime-fixture.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import registry from "../scheduler-registry.js";
import scheduler from "../tautulli-cache-scheduler.js";

// Exercise real Fastify hooks, scheduler orchestration and maintenance registry.
// Provider identity, attempt CAS and publication remain the refresher's separate contracts.
const boundary = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshOwnedTautulliCache: boundary.refresh,
}));
const STARTUP_MS = 120_000,
	INTERVAL_MS = 300_000;
type Origin = "startup" | "interval";
type Phase = "lookup" | "refresh";
const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
let sequence = 0;
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
function positiveResult() {
	return {
		kind: "positive-observation",
		complete: true,
		upserted: 3,
		errors: 0,
		errorMessages: [],
	};
}
async function boot(
	options: {
		hold?: { phase: Phase; gate: Promise<void>; call?: number; reject?: boolean };
		preCloseGate?: Promise<void>;
		empty?: boolean;
		superseded?: boolean;
	} = {},
) {
	const instances: ServiceInstance[] = [0, 1, 2].map((i) => ({
		id: `instance-${++sequence}`,
		userId: i % 2 ? "owner-b" : "owner-a",
		service: "TAUTULLI",
		label: "Same synthetic label",
		baseUrl: "https://synthetic.invalid",
		externalUrl: null,
		encryptedApiKey: "synthetic-key",
		encryptionIv: "synthetic-iv",
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		isDefault: false,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		connectionGeneration: 7,
		expectedIdentity: `identity-${i}`,
		identityKind: null,
		identityStatus: "VERIFIED",
		identityGeneration: 3,
		identityVerifiedAt: null,
		identityLastCheckedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	}));
	const counts = { lookup: 0, refresh: 0 };
	const state = { pending: 0, teardown: false, afterTeardown: 0, pendingAtTeardown: -1 };
	const selected: ServiceInstance[] = [];
	async function pause(phase: Phase) {
		counts[phase]++;
		state.pending++;
		if (state.teardown) state.afterTeardown++;
		try {
			if (options.hold?.phase === phase && counts[phase] === (options.hold.call ?? 1)) {
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	}
	const prisma = {
		serviceInstance: {
			findMany: vi.fn(async (args) => {
				expect(args).toEqual({ where: { service: "TAUTULLI", enabled: true } });
				await pause("lookup");
				return options.empty ? [] : instances;
			}),
		},
	};
	const encryptor = {
		decrypt: vi.fn(() => {
			throw new Error("Fixture forbids credentials");
		}),
	};
	boundary.refresh.mockImplementation(async (args) => {
		expect(args.prisma).toBe(prisma);
		expect(args.encryptor).toBe(encryptor);
		expect(instances).toContain(args.instance);
		selected.push(args.instance);
		await pause("refresh");
		return options.superseded
			? { ...positiveResult(), kind: "unpublished", upserted: 0, superseded: true }
			: positiveResult();
	});
	const app = Fastify({ logger: false });
	apps.push(app);
	await installRuntimeFixture(app);
	const info = vi.spyOn(app.log, "info"),
		error = vi.spyOn(app.log, "error");
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma as never);
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					state.teardown = true;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				server.decorate("encryptor", encryptor as never);
			},
			{ name: "security" },
		),
	);
	await app.register(registry);
	const timeouts = vi.spyOn(globalThis, "setTimeout"),
		intervals = vi.spyOn(globalThis, "setInterval");
	await app.register(scheduler);
	const preClosed = deferred();
	app.addHook("preClose", async () => preClosed.resolve());
	if (options.preCloseGate) app.addHook("preClose", async () => options.preCloseGate);
	await app.ready();
	const startupIndex = timeouts.mock.calls.findIndex(([, ms]) => ms === STARTUP_MS);
	function callback(origin: Origin) {
		const spy = origin === "startup" ? timeouts : intervals;
		const index =
			origin === "startup"
				? startupIndex
				: spy.mock.calls.findIndex(([, ms]) => ms === INTERVAL_MS);
		const fn = spy.mock.calls[index]?.[0];
		if (typeof fn !== "function") throw new Error("Tautulli callback missing");
		return () => {
			if (origin === "startup") clearTimeout(spy.mock.results[index]?.value);
			fn();
		};
	}
	return {
		app,
		instances,
		counts,
		state,
		selected,
		encryptor,
		callback,
		intervals,
		info,
		error,
		status: () => app.schedulerRegistry.getStatus(JOB_ID.tautulliCache)!,
		async start(origin: Origin) {
			if (origin === "interval") {
				callback("startup")();
				await settle();
			}
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
	};
}
beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids network"));
	boundary.refresh.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(apps.splice(0).map((app) => app.close()));
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
describe("Tautulli scheduler admission and full accepted-round lifetime", () => {
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of ["lookup", "refresh"] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before database teardown`, async () => {
					const gate = deferred();
					const f = await boot({
						hold: {
							phase,
							gate: gate.promise,
							reject,
							call: origin === "startup" ? 1 : phase === "lookup" ? 2 : 4,
						},
					});
					await f.start(origin);
					expect(f.state.pending).toBe(1);
					const closing = await f.closePending();
					expect(closing.settled()).toBe(false);
					expect(f.state.teardown).toBe(false);
					expect(f.status().state).toBe("running");
					gate.resolve();
					await closing.promise;
					expect(f.state).toMatchObject({
						pending: 0,
						pendingAtTeardown: 0,
						afterTeardown: 0,
						teardown: true,
					});
					expect(f.selected).toEqual(
						origin === "interval"
							? [...f.instances, ...(phase === "lookup" && reject ? [] : f.instances)]
							: phase === "lookup" && reject
								? []
								: f.instances,
					);
					expect(f.status().state).toBe("idle");
					expect(f.encryptor.decrypt).not.toHaveBeenCalled();
					expect(vi.getTimerCount()).toBe(0);
				});
			}
			it(`keeps maintenance excluded throughout ${origin} ${phase}`, async () => {
				const gate = deferred();
				const f = await boot({
					hold: {
						phase,
						gate: gate.promise,
						call: origin === "startup" ? 1 : phase === "lookup" ? 2 : 4,
					},
				});
				await f.start(origin);
				await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
					statusCode: 409,
				});
				const closing = await f.closePending();
				await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
					statusCode: 409,
				});
				gate.resolve();
				await closing.promise;
				await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
				expect(f.state.afterTeardown).toBe(0);
			});
		}
		it(`rejects ${origin} admission while a sibling preClose hook is held`, async () => {
			const gate = deferred(),
				f = await boot({ preCloseGate: gate.promise });
			if (origin === "interval") await f.start("startup");
			const invoke = f.callback(origin),
				before = { ...f.counts },
				intervals = f.intervals.mock.calls.length;
			const closing = await f.closePending();
			invoke();
			await settle();
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(intervals);
			gate.resolve();
			await closing.promise;
		});
		it(`ignores retired ${origin} callbacks and never reinstalls a timer`, async () => {
			const f = await boot();
			if (origin === "interval") await f.start("startup");
			const invoke = f.callback(origin),
				before = { ...f.counts },
				intervals = f.intervals.mock.calls.length;
			await f.app.close();
			invoke();
			await settle();
			await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(intervals);
			expect(f.state.afterTeardown).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});
		it(`skips overlapping ${origin} rounds without losing the accepted drain`, async () => {
			const gate = deferred(),
				f = await boot({
					hold: { phase: "refresh", gate: gate.promise, call: origin === "startup" ? 1 : 4 },
				});
			await f.start(origin);
			const before = { ...f.counts };
			f.callback("interval")();
			await settle();
			expect(f.counts).toEqual(before);
			const closing = await f.closePending();
			expect(closing.settled()).toBe(false);
			gate.resolve();
			await closing.promise;
			expect(f.selected).toEqual(
				origin === "startup" ? f.instances : [...f.instances, ...f.instances],
			);
			expect(f.state.afterTeardown).toBe(0);
		});
		it(`treats maintenance-denied ${origin} work as no run and recovers on the next interval`, async () => {
			const f = await boot();
			if (origin === "interval") await f.start("startup");
			const before = { ...f.counts },
				status = { ...f.status() };
			await withCleanupMaintenanceGuard(async () => {
				f.callback(origin)();
				await settle();
			});
			expect(f.counts).toEqual(before);
			expect(f.status()).toEqual(status);
			expect(f.error).not.toHaveBeenCalled();
			f.callback("interval")();
			await settle();
			expect(f.counts.lookup).toBe(before.lookup + 1);
			expect(f.counts.refresh).toBe(before.refresh + 3);
		});
	}
	it("drains all accepted mixed-owner same-label instances, including a held second refresh", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "refresh", gate: gate.promise, call: 2 } });
		await f.start("startup");
		expect(f.selected).toEqual(f.instances.slice(0, 2));
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await closing.promise;
		expect(f.selected).toEqual(f.instances);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("handles duplicate close requests without abandoning a held refresh", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "refresh", gate: gate.promise } });
		await f.start("startup");
		const closing = await f.closePending(),
			second = f.app.close();
		await settle();
		expect(f.state.teardown).toBe(false);
		gate.resolve();
		await Promise.all([closing.promise, second]);
		expect(f.selected).toEqual(f.instances);
		expect(f.state.pendingAtTeardown).toBe(0);
	});
	it("preserves the two-minute delay and five-minute serial cadence", async () => {
		const f = await boot();
		await vi.advanceTimersByTimeAsync(STARTUP_MS - 1);
		expect(f.counts.lookup).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.selected).toEqual(f.instances);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
		expect(f.counts.lookup).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.selected).toEqual([...f.instances, ...f.instances]);
	});
	it("closes an empty accepted round without provider work", async () => {
		const f = await boot({ empty: true });
		await f.start("startup");
		await f.app.close();
		expect(f.counts).toEqual({ lookup: 1, refresh: 0 });
		expect(f.state.pendingAtTeardown).toBe(0);
	});
	for (const phase of ["lookup", "refresh"] as const) {
		it(`releases failed ${phase} work and admits a later interval`, async () => {
			const gate = deferred(),
				f = await boot({ hold: { phase, gate: gate.promise, reject: true } });
			await f.start("startup");
			gate.resolve();
			await settle();
			expect(f.status().state).toBe("idle");
			await expect(withCleanupMaintenanceGuard(async () => undefined)).resolves.toBeUndefined();
			const before = { ...f.counts };
			f.callback("interval")();
			await settle();
			expect(f.counts).toEqual({ lookup: before.lookup + 1, refresh: before.refresh + 3 });
			expect(f.error).toHaveBeenCalledWith(
				{
					provider: "tautulli",
					reasonCode: phase === "lookup" ? "scheduler_tick_failed" : "unknown_failure",
				},
				expect.any(String),
			);
		});
	}
	it("preserves superseded outcomes while draining a refresh", async () => {
		const gate = deferred(),
			f = await boot({ superseded: true, hold: { phase: "refresh", gate: gate.promise } });
		await f.start("startup");
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await closing.promise;
		expect(f.info).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: "superseded", superseded: true }),
			expect.any(String),
		);
		expect(f.error).not.toHaveBeenCalled();
	});
});
