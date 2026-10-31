import { AsyncResource } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import scheduler from "../jellyfin-positive-watch-scheduler.js";
import registry from "../scheduler-registry.js";

// Real native admission, bootstrap, crypto, owned rows, registry and lifetime.
// Only the positive-watch executor is synthetic; zero outbox is not delivery proof.
const boundary = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../lib/jellyfin/jellyfin-positive-watch-refresher.js", () => ({
	refreshOwnedJellyfinPositiveWatch: boundary.refresh,
}));
const STARTUP_MS = 90_000,
	INTERVAL_MS = 300_000;
type Origin = "startup" | "interval";
type Phase = "lookup" | "page";
type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [],
	tasks: Promise<unknown>[] = [];
const fixtures = new Map<
	Native,
	{
		instances: Array<{ id: string; userId: string }>;
		owners: Array<{ userId: string; channelId: string }>;
	}
>();
const realTimeout = globalThis.setTimeout,
	realClearTimeout = globalThis.clearTimeout,
	realInterval = globalThis.setInterval,
	realClearInterval = globalThis.clearInterval;
type TimerRecord = {
	kind: "timeout" | "interval";
	delay: number;
	dueAt: number;
	callback: () => void;
	handle: ReturnType<typeof setTimeout>;
};
const installed: TimerRecord[] = [],
	activeTimers = new Map<ReturnType<typeof setTimeout>, TimerRecord>();
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
async function settle() {
	await new Promise<void>((done) => setImmediate(done));
}
async function waitForNative(observe: () => boolean) {
	const deadline = performance.now() + 4000;
	while (!observe()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}
async function boot(
	options: {
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; call?: number };
		preCloseGate?: Promise<void>;
		instances?: number;
		empty?: boolean;
		failFirstPage?: boolean;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const owners = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	const owned = { instances: [] as Array<{ id: string; userId: string }>, owners };
	fixtures.set(native, owned);
	const allInstances: ServiceInstance[] = [];
	await native.run(async () => {
		for (let index = 0; index < 5; index++) {
			const key = native.encryptor.encrypt("synthetic-positive-watch-key");
			const instance = await native.prisma.serviceInstance.create({
				data: {
					userId: owners[index === 1 ? 1 : 0]!.userId,
					service: index === 2 ? "EMBY" : "JELLYFIN",
					label: "Same synthetic label",
					baseUrl: "https://synthetic.invalid",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
					enabled:
						index === 4
							? false
							: index === 1
								? !options.empty && options.instances === 2
								: !options.empty,
					connectionGeneration: 7,
					identityGeneration: 3,
					identityStatus: index === 3 ? "UNVERIFIED" : "VERIFIED",
					expectedIdentity: `synthetic-positive-identity-${index}`,
				},
			});
			owned.instances.push({ id: instance.id, userId: instance.userId });
			allInstances.push(instance);
		}
	});
	const instances = allInstances.slice(0, options.instances ?? 1).filter((row) => row.enabled);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("arrClientFactory", {
		create() {
			state.forbidden++;
			throw new Error("Fixture forbids provider clients");
		},
	} as never);
	const counts = { lookup: 0, page: 0 };
	const state = {
		pending: 0,
		teardown: false,
		afterTeardown: 0,
		pendingAtTeardown: -1,
		forbidden: 0,
		network: 0,
	};
	const selected: Array<{ id: string; userId: string }> = [],
		lookupSequences: ServiceInstance[][] = [];
	let held = false,
		active = 0;
	async function phase<T>(name: Phase, operation: () => PromiseLike<T> | T): Promise<T> {
		counts[name]++;
		state.pending++;
		if (state.teardown) state.afterTeardown++;
		try {
			if (options.hold?.phase === name && counts[name] === (options.hold.call ?? 1)) {
				held = true;
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
			return await operation();
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	}
	const findMany = prisma.serviceInstance.findMany.bind(prisma.serviceInstance);
	const reads: { findMany: AwaitOnly<typeof prisma.serviceInstance.findMany> } =
		prisma.serviceInstance;
	vi.spyOn(reads, "findMany").mockImplementation((args) => {
		expect(args).toEqual({
			where: { service: "JELLYFIN", enabled: true, identityStatus: "VERIFIED" },
		});
		return phase("lookup", async () => {
			const rows = await findMany(args);
			expect(new Set(rows.map((row) => row.id))).toEqual(new Set(instances.map((row) => row.id)));
			for (const row of rows)
				expect(row).toEqual(instances.find((instance) => instance.id === row.id));
			lookupSequences.push(rows);
			return rows;
		});
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		state.network++;
		throw new Error("Fixture forbids network");
	});
	boundary.refresh.mockImplementation(async (context) => {
		expect(Object.keys(context).sort()).toEqual(["encryptor", "instance", "log", "prisma"]);
		expect(context.prisma).toBe(prisma);
		expect(prisma).not.toBe(native.prisma);
		expect(context.encryptor).toBe(native.encryptor);
		expect(context.log).toBe(app.log);
		expect(context.instance).toEqual(instances.find((row) => row.id === context.instance.id));
		expect(
			native.encryptor.decrypt({
				value: context.instance.encryptedApiKey,
				iv: context.instance.encryptionIv,
			}),
		).toBe("synthetic-positive-watch-key");
		selected.push({ id: context.instance.id, userId: context.instance.userId });
		return phase("page", () => {
			if (options.failFirstPage && counts.page === 1)
				throw new Error("Synthetic provider unavailable");
			return { kind: "published", itemCount: 1, scopeCount: 1, durationMs: 4 };
		});
	});
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma);
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					expect(state.pending).toBe(0);
					expect(active).toBe(0);
					expect(state.forbidden).toBe(0);
					expect(state.network).toBe(0);
					await native.run(async () => {
						expect(
							await native.prisma.notificationOutboxEvent.count({
								where: { userId: { in: owners.map((row) => row.userId) } },
							}),
						).toBe(0);
						expect(
							await native.prisma.notificationOutboxDelivery.count({
								where: { userId: { in: owners.map((row) => row.userId) } },
							}),
						).toBe(0);
						expect(
							await native.prisma.notificationLog.count({
								where: { channelId: { in: owners.map((row) => row.channelId) } },
							}),
						).toBe(0);
					});
					await client.close();
					state.teardown = true;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				server.decorate("encryptor", native.encryptor);
			},
			{ name: "security" },
		),
	);
	registerRestoreBootstrapPlugin(app, registry);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		active++;
		const task = track(...args).finally(() => {
			active--;
		});
		tasks.push(task.catch(() => undefined));
		return task;
	});
	const register = app.register.bind(app),
		displayName = Symbol.for("fastify.display-name");
	let selectedRegistrations = 0;
	const registration = vi.spyOn(app, "register").mockImplementation(((
		plugin: unknown,
		...args: unknown[]
	) => {
		if (
			typeof plugin === "function" &&
			Reflect.get(plugin, displayName) === Reflect.get(scheduler, displayName)
		) {
			expect(plugin).not.toBe(scheduler);
			expect(Reflect.get(plugin, Symbol.for("plugin-meta"))).toBe(
				Reflect.get(scheduler, Symbol.for("plugin-meta")),
			);
			selectedRegistrations++;
			return Reflect.apply(register, app, [plugin, ...args]);
		}
		return app;
	}) as typeof app.register);
	try {
		registerSchedulers(app);
		expect(selectedRegistrations).toBe(1);
	} finally {
		registration.mockRestore();
	}
	await app.after();
	registerRestoreRuntimeActivation(app);
	const preClosed = deferred();
	app.addHook("preClose", async () => {
		preClosed.resolve();
		if (options.preCloseGate) await options.preCloseGate;
	});
	await app.ready();
	const idle = async () => {
		await native.runtime.drain();
		expect(await waitForNative(() => active === 0 && state.pending === 0)).toBe(true);
		await settle();
	};
	const advance = async (ms: number) => {
		const target = Date.now() + ms;
		do {
			const due = Math.min(...[...activeTimers.values()].map((timer) => timer.dueAt));
			await vi.advanceTimersByTimeAsync(Math.max(0, Math.min(target, due) - Date.now()));
			let drained = false;
			const drain = native.runtime.drain().then(() => {
				drained = true;
			});
			tasks.push(drain);
			expect(await waitForNative(() => drained || (held && state.pending > 0))).toBe(true);
			if (drained) await idle();
		} while (Date.now() < target);
		expect(Date.now()).toBe(target);
	};
	const callback = (origin: Origin) => {
		const record = installed.find((row) =>
			origin === "startup"
				? row.kind === "timeout" && row.delay === STARTUP_MS
				: row.kind === "interval" && row.delay === INTERVAL_MS,
		);
		if (!record) throw new Error("Positive-watch callback missing");
		// Retained/overlap/refusal controls only. Natural cadence uses advance.
		return () => {
			if (origin === "startup") clearTimeout(record.handle);
			record.callback();
		};
	};
	const timerObservation = (kind: "timeout" | "interval") => ({
		get mock() {
			return {
				calls: installed
					.filter((row) => row.kind === kind)
					.map((row) => [row.callback, row.delay] as const),
			};
		},
	});
	return {
		app,
		instances,
		allInstances,
		owners,
		counts,
		state,
		selected,
		lookupSequences,
		callback,
		advance,
		idle,
		waitUntilHeld: () => waitForNative(() => held),
		waitUntilIdle: () => waitForNative(() => active === 0 && state.pending === 0),
		timeouts: timerObservation("timeout"),
		intervals: timerObservation("interval"),
		status: () => app.schedulerRegistry.getStatus(JOB_ID.jellyfinPositiveWatch)!,
		async start(origin: Origin) {
			if (origin === "interval") await advance(STARTUP_MS);
			await advance(origin === "startup" ? STARTUP_MS : INTERVAL_MS);
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
	installed.length = 0;
	activeTimers.clear();
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	const virtualTimeout = globalThis.setTimeout,
		virtualClear = globalThis.clearTimeout;
	const virtualInterval = globalThis.setInterval,
		virtualClearInterval = globalThis.clearInterval;
	// Route by the actual installing callsite, not coincident delay values:
	// PostgreSQL safety timers and unrelated outbox deadlines stay real.
	const schedulerCallsite = () =>
		new Error().stack
			?.split("\n")
			.find((line) => line.includes("/src/") && !line.includes("/__tests__/"))
			?.includes("/plugins/jellyfin-positive-watch-scheduler.ts") === true;
	vi.stubGlobal("setTimeout", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realTimeout, globalThis, [callback, delay, ...args]);
		// Real Node timers retain the installing async context. Preserve that
		// existing context only; this does not mint native runtime authority.
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let handle: ReturnType<typeof setTimeout>;
		const forward = () => {
			activeTimers.delete(handle);
			invoke();
		};
		handle = Reflect.apply(virtualTimeout, globalThis, [forward, delay]);
		const record: TimerRecord = {
			kind: "timeout",
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
			callback: invoke,
			handle,
		};
		installed.push(record);
		activeTimers.set(handle, record);
		return handle;
	}) as typeof setTimeout);
	vi.stubGlobal("clearTimeout", ((handle: Parameters<typeof clearTimeout>[0]) => {
		if (installed.some((row) => row.handle === handle && row.kind === "timeout")) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClear(handle);
		}
		return realClearTimeout(handle);
	}) as typeof clearTimeout);
	vi.stubGlobal("setInterval", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		if (!schedulerCallsite())
			return Reflect.apply(realInterval, globalThis, [callback, delay, ...args]);
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let record: TimerRecord;
		const forward = () => {
			record.dueAt += record.delay;
			invoke();
		};
		const handle = Reflect.apply(virtualInterval, globalThis, [forward, delay]);
		record = {
			kind: "interval",
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
			callback: invoke,
			handle,
		};
		installed.push(record);
		activeTimers.set(handle, record);
		return handle;
	}) as typeof setInterval);
	vi.stubGlobal("clearInterval", ((handle: Parameters<typeof clearInterval>[0]) => {
		if (installed.some((row) => row.handle === handle && row.kind === "interval")) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClearInterval(handle);
		}
		return realClearInterval(handle);
	}) as typeof clearInterval);
	boundary.refresh.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
	for (const [native, owned] of fixtures) {
		await native.run(async () => {
			expect(
				(await native.prisma.serviceInstance.deleteMany({ where: { OR: owned.instances } })).count,
			).toBe(owned.instances.length);
			expect(
				await native.prisma.serviceInstance.count({
					where: { id: { in: owned.instances.map((row) => row.id) } },
				}),
			).toBe(0);
			expect(
				(
					await native.prisma.user.deleteMany({
						where: { id: { in: owned.owners.map((row) => row.userId) } },
					})
				).count,
			).toBe(2);
			expect(
				await native.prisma.user.count({
					where: { id: { in: owned.owners.map((row) => row.userId) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.notificationChannel.count({
					where: { id: { in: owned.owners.map((row) => row.channelId) } },
				}),
			).toBe(0);
			expect(
				await native.prisma.notificationSubscription.count({
					where: { channelId: { in: owned.owners.map((row) => row.channelId) } },
				}),
			).toBe(0);
		});
		await native.close();
	}
	fixtures.clear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Jellyfin positive-watch scheduler admission and accepted lifetime", () => {
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of ["lookup", "page"] as const)
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before database teardown`, async () => {
					const gate = deferred();
					const f = await boot({
						hold: { phase, gate: gate.promise, reject, call: origin === "interval" ? 2 : 1 },
					});
					await f.start(origin);
					expect(await f.waitUntilHeld()).toBe(true);
					expect(f.state.pending).toBe(1);
					const closing = await f.closePending();
					expect(closing.settled()).toBe(false);
					expect(f.state.teardown).toBe(false);
					gate.resolve();
					await closing.promise;
					expect(f.state.pendingAtTeardown).toBe(0);
					expect(f.state.afterTeardown).toBe(0);
					const before = { ...f.counts };
					await f.advance(24 * 60 * 60_000);
					expect(f.counts).toEqual(before);
				});
			}
		it(`refuses a retained ${origin} callback while a sibling preClose hook waits`, async () => {
			const gate = deferred(),
				f = await boot({ preCloseGate: gate.promise, empty: true });
			if (origin === "interval") {
				await f.start("startup");
				await f.idle();
			}
			const next = f.callback(origin),
				before = { ...f.counts },
				installed = f.intervals.mock.calls.length;
			const closing = await f.closePending();
			next();
			await f.idle();
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(installed);
			gate.resolve();
			await closing.promise;
		});
		it(`retires ${origin} callbacks without creating work or new intervals after close`, async () => {
			const f = await boot({ empty: true });
			if (origin === "interval") {
				await f.start("startup");
				await f.idle();
			}
			const next = f.callback(origin);
			await f.app.close();
			const before = { ...f.counts },
				installed = f.intervals.mock.calls.length;
			next();
			await f.advance(24 * 60 * 60_000);
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(installed);
		});
	}
	for (const phase of ["lookup", "page"] as const) {
		it(`keeps the existing maintenance exclusion through accepted ${phase}`, async () => {
			const gate = deferred(),
				f = await boot({ hold: { phase, gate: gate.promise } });
			await f.start("startup");
			expect(await f.waitUntilHeld()).toBe(true);
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});
			gate.resolve();
			await f.idle();
			await f.app.close();
			await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
		});
		it(`does not start the next owner's page after preClose while accepted ${phase} settles`, async () => {
			const work = deferred(),
				close = deferred();
			const f = await boot({
				instances: 2,
				preCloseGate: close.promise,
				hold: { phase, gate: work.promise },
			});
			await f.start("startup");
			expect(await f.waitUntilHeld()).toBe(true);
			const closing = await f.closePending();
			work.resolve();
			await f.idle();
			expect(f.selected.map(({ userId }) => userId)).toEqual(
				phase === "page" ? [f.lookupSequences[0]![0]!.userId] : [],
			);
			close.resolve();
			await closing.promise;
			expect(f.state.afterTeardown).toBe(0);
		});
	}
	it("joins repeated closes while an accepted page remains pending", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "page", gate: gate.promise } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		let secondSettled = false;
		const second = f.app.close().then(() => {
			secondSettled = true;
		});
		await settle();
		expect(secondSettled).toBe(false);
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await Promise.all([closing.promise, second]);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("suppresses overlapping callbacks without replacing the accepted tick", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "lookup", gate: gate.promise } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		f.callback("interval")();
		f.callback("interval")();
		await settle();
		expect(f.counts.lookup).toBe(1);
		expect(f.status().state).toBe("running");
		gate.resolve();
		await f.idle();
		expect(f.counts.page).toBe(1);
		expect(f.status().totalRuns).toBe(1);
	});
	it("resumes on the existing cadence after a maintenance-denied tick without marking failure", async () => {
		const f = await boot();
		await withCleanupMaintenanceGuard(async () => {
			await f.start("startup");
			await f.idle();
			expect(f.counts).toEqual({ lookup: 0, page: 0 });
			expect(f.status()).toMatchObject({ totalRuns: 0, totalFailures: 0, lastStartedAt: null });
		});
		await f.advance(INTERVAL_MS);
		expect(f.counts).toEqual({ lookup: 1, page: 1 });
		expect(f.status()).toMatchObject({ totalRuns: 1, totalFailures: 0 });
	});
	it("recovers on the next interval after the initial lookup rejects", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "lookup", gate: gate.promise, reject: true } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		gate.resolve();
		await f.idle();
		expect(f.status()).toMatchObject({ totalRuns: 1, totalFailures: 1, state: "idle" });
		await f.advance(INTERVAL_MS);
		await f.idle();
		expect(f.counts).toEqual({ lookup: 2, page: 1 });
		expect(f.status()).toMatchObject({ totalRuns: 2, totalFailures: 1, consecutiveFailures: 0 });
	});
	it("continues across independent same-label owners when the first provider fails", async () => {
		const f = await boot({ instances: 2, failFirstPage: true });
		await f.start("startup");
		await f.idle();
		expect(f.selected).toEqual(f.lookupSequences[0]!.map(({ id, userId }) => ({ id, userId })));
		expect(new Set(f.selected.map((row) => row.userId))).toEqual(
			new Set(f.owners.map((row) => row.userId)),
		);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("keeps the startup delay and recurring cadence without eager refresh", async () => {
		const f = await boot();
		await f.advance(STARTUP_MS - 1);
		expect(f.counts.lookup).toBe(0);
		await f.advance(1);
		expect(f.counts.lookup).toBe(1);
		await f.advance(INTERVAL_MS - 1);
		expect(f.counts.lookup).toBe(1);
		await f.advance(1);
		expect(f.counts.lookup).toBe(2);
	});
});
