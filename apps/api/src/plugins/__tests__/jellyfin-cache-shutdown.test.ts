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
import {
	claimProviderCacheRefreshAttempt,
	finishProviderCacheRefreshAttemptFailure,
	type ProviderCacheRefreshAttempt,
} from "../../lib/services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../../lib/services/provider-identity-guard.js";
import {
	ensureLibraryRefreshRecovery,
	type LibraryRefreshRecoveryBridge,
	type LibraryRefreshRecoveryRequest,
} from "../../lib/services/library-refresh-recovery.js";
import cachePlugin from "../jellyfin-cache-scheduler.js";
import registryPlugin from "../scheduler-registry.js";

// Native SQL/runtime/bootstrap/crypto and actual singleflight; only the provider
// executor is synthetic. This scheduler emits no notification or delivery proof.
const refresh = vi.hoisted(() => vi.fn());
vi.mock("../../lib/jellyfin/jellyfin-cache-refresher.js", () => ({
	refreshOwnedJellyfinCacheWithAttempt: refresh,
}));
const STARTUP_MS = 45_000,
	INTERVAL_MS = 6 * 60 * 60_000;
type Origin = "startup" | "interval" | "retry" | "arm";
type Phase = "roundLookup" | "currentLookup" | "refresh";
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
		statuses: string[];
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
async function cleanup(native: Native) {
	const owned = fixtures.get(native)!;
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
			await native.prisma.cacheRefreshStatus.count({ where: { id: { in: owned.statuses } } }),
		).toBe(0);
	});
	await native.close();
	fixtures.delete(native);
}
async function boot(
	options: {
		origin?: Origin;
		service?: "JELLYFIN" | "EMBY";
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; call?: number };
		empty?: boolean;
		firstRefreshFailed?: boolean;
		alwaysRetryable?: boolean;
		superseded?: boolean;
		positiveOnly?: boolean;
		instances?: number;
		preCloseGate?: Promise<void>;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const owners = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	const owned = {
		instances: [] as Array<{ id: string; userId: string }>,
		statuses: [] as string[],
		owners,
	};
	fixtures.set(native, owned);
	await native.run(async () => {
		for (const [index, owner] of owners.entries()) {
			const encrypted = native.encryptor.encrypt("synthetic-provider-key");
			const row = await native.prisma.serviceInstance.create({
				data: {
					userId: owner.userId,
					service: options.service ?? (index === 0 ? "JELLYFIN" : "EMBY"),
					label: "Same synthetic label",
					baseUrl: "https://example.invalid/synthetic-provider",
					encryptedApiKey: encrypted.value,
					encryptionIv: encrypted.iv,
					enabled: !options.empty && (index === 0 || options.instances === 2),
					connectionGeneration: 7,
					identityGeneration: 3,
					expectedIdentity: `synthetic-identity-${index}`,
					identityStatus: "VERIFIED",
				},
			});
			owned.instances.push({ id: row.id, userId: row.userId });
			const status = await native.prisma.cacheRefreshStatus.create({
				data: {
					instanceId: row.id,
					cacheType: "jellyfin",
					lastRefreshedAt: new Date(),
					lastResult: "success",
					lastAttemptAt: new Date(),
					lastAttemptResult: "error",
					connectionGeneration: 7,
					identityGeneration: 3,
				},
			});
			owned.statuses.push(status.id);
		}
	});
	const allInstances = await native.run(() =>
			native.prisma.serviceInstance.findMany({ where: { OR: owned.instances } }),
		),
		instances = allInstances.filter((row) => row.enabled);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const counts: Record<Phase, number> = { roundLookup: 0, currentLookup: 0, refresh: 0 };
	const state = {
		pending: 0,
		teardown: false,
		afterTeardown: 0,
		pendingAtTeardown: -1,
		forbidden: 0,
		network: 0,
	};
	const selected: string[] = [],
		enteredIds: string[] = [];
	let held = false,
		active = 0,
		settledCurrent = 0;
	const preClosed = deferred();
	const pause = async (phase: Phase) => {
		const call = ++counts[phase];
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			if (options.hold?.phase === phase && call === (options.hold.call ?? 1)) {
				held = true;
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	};
	const refuse = () => {
		state.forbidden++;
		throw new Error("Unexpected provider access");
	};
	vi.stubGlobal("fetch", () => {
		state.network++;
		return refuse();
	});
	const lookup = prisma.serviceInstance.findMany.bind(prisma.serviceInstance);
	const rounds: { findMany: AwaitOnly<typeof prisma.serviceInstance.findMany> } =
		prisma.serviceInstance;
	vi.spyOn(rounds, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({ where: { service: { in: ["JELLYFIN", "EMBY"] }, enabled: true } });
		await pause("roundLookup");
		const rows = await lookup(args);
		for (const row of rows) expect(allInstances).toContainEqual(row);
		return rows;
	});
	const current = prisma.serviceInstance.findFirst.bind(prisma.serviceInstance);
	const currentReads: { findFirst: AwaitOnly<typeof prisma.serviceInstance.findFirst> } =
		prisma.serviceInstance;
	vi.spyOn(currentReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: {
				id: expect.any(String),
				...(args?.where?.userId !== undefined ? { userId: expect.any(String) } : {}),
				service: { in: ["JELLYFIN", "EMBY"] },
				enabled: true,
				identityStatus: "VERIFIED",
				expectedIdentity: { not: null },
			},
		});
		await pause("currentLookup");
		const row = await current(args);
		if (row) expect(allInstances).toContainEqual(row);
		settledCurrent++;
		return row;
	});
	const app = Fastify({ logger: false });
	apps.push(app);
	refresh.mockImplementation(
		async (
			context: {
				prisma: unknown;
				encryptor: unknown;
				instance: ServiceInstance;
				log: unknown;
			},
			attempt: ProviderCacheRefreshAttempt,
		) => {
			expect(context).toEqual({
				prisma,
				encryptor: native.encryptor,
				instance: expect.anything(),
				log: app.log,
				signal: expect.any(AbortSignal),
			});
			expect(allInstances).toContainEqual(context.instance);
			expect(
				native.encryptor.decrypt({
					value: context.instance.encryptedApiKey,
					iv: context.instance.encryptionIv,
				}),
			).toBe("synthetic-provider-key");
			enteredIds.push(context.instance.id);
			await pause("refresh");
			selected.push(context.instance.id);
			// This synthetic executor publishes no generation. Settle its actual
			// diagnostic claim while preserving the native last-good publication.
			await finishProviderCacheRefreshAttemptFailure(
				prisma,
				"jellyfin",
				"provider-unavailable",
				createProviderPublicationAuthority(context.instance),
				attempt,
				app.log,
			);
			if (context.instance.id === request.instanceId) request.attempt = attempt;
			if (options.superseded)
				return { complete: false, upserted: 0, errors: 0, errorMessages: [], superseded: true };
			if (options.alwaysRetryable || (options.firstRefreshFailed && counts.refresh === 1))
				return {
					complete: false,
					upserted: 0,
					errors: 1,
					errorMessages: ["Synthetic provider unavailable"],
				};
			if (options.positiveOnly)
				return { complete: false, upserted: 7, errors: 0, errorMessages: [] };
			return { complete: true, upserted: 1, errors: 0, errorMessages: [] };
		},
	);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("prisma", prisma);
	app.decorate("encryptor", native.encryptor);
	app.decorate("config", { APP_URL: "https://example.invalid" } as never);
	app.decorate("arrClientFactory", { create: refuse } as never);
	await app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					expect(state.pending).toBe(0);
					expect(active).toBe(0);
					expect(state.forbidden).toBe(0);
					expect(state.network).toBe(0);
					await native.run(async () => {
						const ids = owners.map((owner) => owner.userId);
						expect(
							await native.prisma.notificationOutboxEvent.count({ where: { userId: { in: ids } } }),
						).toBe(0);
						expect(
							await native.prisma.notificationOutboxDelivery.count({
								where: { userId: { in: ids } },
							}),
						).toBe(0);
						expect(
							await native.prisma.notificationLog.count({
								where: { channelId: { in: owners.map((owner) => owner.channelId) } },
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
	await app.register(fp(async () => {}, { name: "security" }));
	registerRestoreBootstrapPlugin(app, registryPlugin);
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
	const bridge = ensureLibraryRefreshRecovery(app).libraryRefreshRecovery;
	let retained!: Parameters<LibraryRefreshRecoveryBridge["register"]>[1];
	const registerHandler = bridge.register.bind(bridge);
	vi.spyOn(bridge, "register").mockImplementation((provider, handler) => {
		retained = handler;
		return registerHandler(provider, handler);
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
			Reflect.get(plugin, displayName) === Reflect.get(cachePlugin, displayName)
		) {
			expect(plugin).not.toBe(cachePlugin);
			expect(Reflect.get(plugin, Symbol.for("plugin-meta"))).toBe(
				Reflect.get(cachePlugin, Symbol.for("plugin-meta")),
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
	app.addHook("preClose", async () => {
		preClosed.resolve();
		if (options.preCloseGate) await options.preCloseGate;
	});
	await app.ready();
	expect(
		await native.run(() => native.prisma.serviceInstance.count({ where: { OR: owned.instances } })),
	).toBe(2);
	const initialAuthority = createProviderPublicationAuthority(
		allInstances.find((row) => row.id === owned.instances[0]!.id)!,
	);
	const initialClaim = options.empty
		? undefined
		: await native.run(() =>
				claimProviderCacheRefreshAttempt(native.prisma, "jellyfin", initialAuthority),
			);
	if (initialClaim && initialClaim.status !== "acquired")
		throw new Error("missing initial owned test claim");
	if (initialClaim?.status === "acquired")
		await native.run(() =>
			finishProviderCacheRefreshAttemptFailure(
				native.prisma,
				"jellyfin",
				"provider-unavailable",
				initialAuthority,
				initialClaim.attempt,
				app.log,
			),
		);
	const request: LibraryRefreshRecoveryRequest = {
		provider: "jellyfin",
		userId: owners[0]!.userId,
		instanceId: owned.instances[0]!.id,
		authority: initialAuthority,
		// Empty fixtures exercise retained shutdown callbacks, never admission.
		attempt:
			initialClaim?.status === "acquired"
				? initialClaim.attempt
				: {
						attemptedAt: new Date(),
						resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
					},
	};
	bridge.admit(request);
	const arm = (value = request) => {
		const task = app.restoreRuntime.runOperation(() => bridge.arm(value));
		tasks.push(task);
		return task;
	};
	const idle = async () => {
		await native.runtime.drain();
		expect(await waitForNative(() => active === 0 && state.pending === 0)).toBe(true);
		await settle();
	};
	const advance = async (ms: number) => {
		const target = Date.now() + ms;
		do {
			const due = Math.min(...[...activeTimers.values()].map((timer) => timer.dueAt));
			// Fire actual virtual timers at each recorded deadline; real native I/O
			// must settle there before the clock crosses another scheduler boundary.
			await vi.advanceTimersByTimeAsync(Math.max(0, Math.min(target, due) - Date.now()));
			let drained = false;
			const joining = native.runtime.drain().then(() => {
				drained = true;
			});
			tasks.push(joining);
			expect(await waitForNative(() => drained || (held && state.pending > 0))).toBe(true);
			if (!(held && state.pending > 0)) await idle();
		} while (Date.now() < target);
		expect(Date.now()).toBe(target);
	};

	const callback = (kind: "startup" | "interval" | "retry") => {
		const record =
			kind === "startup"
				? installed.find((row) => row.kind === "timeout" && row.delay === STARTUP_MS)
				: kind === "interval"
					? installed.find((row) => row.kind === "interval")
					: [...installed].reverse().find((row) => row.kind === "timeout" && row.delay === 30_000);
		if (!record) throw new Error("Cache callback missing");
		return record.callback;
	};
	const start = async (origin: Origin) => {
		if (origin === "arm") return arm();
		if (origin !== "startup") await advance(STARTUP_MS);
		const delay = origin === "interval" ? INTERVAL_MS : origin === "retry" ? 30_000 : STARTUP_MS;
		await advance(delay - 1);
		await advance(1);
		return undefined;
	};
	const closePending = async () => {
		let closed = false;
		const promise = app.close().then(() => {
			closed = true;
		});
		await preClosed.promise;
		await settle();
		return { promise, settled: () => closed };
	};
	const dispose = async () => {
		await app.close();
		await cleanup(native);
		apps.splice(apps.indexOf(app), 1);
	};
	return {
		app,
		native,
		owners,
		prisma,
		instances,
		counts,
		state,
		selected,
		enteredIds,
		request,
		bridge,
		arm,
		idle,
		advance,
		callback,
		start,
		closePending,
		dispose,
		retained: (value = request) => retained(value),
		waitUntilHeld: () => waitForNative(() => held),
		waitCurrent: (count: number) => waitForNative(() => settledCurrent === count),
		timerCount: () => activeTimers.size,
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
			?.includes("/plugins/jellyfin-cache-scheduler.ts") === true;
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
	refresh.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	for (const app of apps.splice(0)) await app.close();
	vi.restoreAllMocks();
	for (const native of [...fixtures.keys()]) await cleanup(native);
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Jellyfin/Emby cache scheduler lifetime", () => {
	for (const service of ["JELLYFIN", "EMBY"] as const) {
		for (const origin of ["startup", "interval", "retry"] as const) {
			const lookup = origin === "retry" ? "currentLookup" : "roundLookup";
			for (const phase of [lookup, "refresh"] as const) {
				for (const reject of [false, true]) {
					it(`drains ${service} ${origin} ${phase} ${reject ? "failure" : "completion"} before teardown`, async () => {
						const gate = deferred();
						const f = await boot({
							service,
							origin,
							firstRefreshFailed: origin === "retry",
							hold: {
								phase,
								gate: gate.promise,
								reject,
								call: origin === "startup" || phase === "currentLookup" ? 1 : 2,
							},
						});
						await f.start(origin);
						expect(await f.waitUntilHeld()).toBe(true);
						expect(f.state.pending).toBe(1);
						const closing = await f.closePending();
						expect(closing.settled()).toBe(false);
						expect(f.state.teardown).toBe(false);
						gate.resolve();
						await closing.promise;
						expect(f.state.pending).toBe(0);
						expect(f.state.afterTeardown).toBe(0);
						const before = { ...f.counts };
						await f.advance(24 * 60 * 60_000);
						expect(f.counts).toEqual(before);
					});
				}
			}
		}
		it(`queues ${service} operator recovery without database admission and closes its timer`, async () => {
			const f = await boot({ origin: "arm", service });
			await expect(f.arm()).resolves.toEqual({ status: "accepted" });
			expect(f.counts.currentLookup).toBe(0);
			expect(f.state.pending).toBe(0);
			const closing = await f.closePending();
			await closing.promise;
			await expect(f.arm()).resolves.toEqual({ status: "unavailable" });
			expect(f.counts.refresh).toBe(0);
			expect(f.state.afterTeardown).toBe(0);
		});
	}
	it("permanently rejects retired startup/interval/retry and retained recovery callbacks", async () => {
		const f = await boot({ firstRefreshFailed: true });
		await f.start("startup");
		await f.idle();
		const startup = f.callback("startup"),
			interval = f.callback("interval"),
			retry = f.callback("retry");
		await f.app.close();
		const before = { ...f.counts };
		startup();
		interval();
		retry();
		await expect(f.retained()).resolves.toEqual({ status: "unavailable" });
		await expect(f.arm()).resolves.toEqual({ status: "unavailable" });
		await f.advance(24 * 60 * 60_000);
		await settle();
		expect(f.counts).toEqual(before);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("closes admission before sibling preClose waits and never reinstalls timers", async () => {
		const gate = deferred();
		const f = await boot({ empty: true, preCloseGate: gate.promise });
		const startup = f.callback("startup");
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		startup();
		await settle();
		expect(f.counts.roundLookup).toBe(0);
		await expect(f.retained()).resolves.toEqual({ status: "unavailable" });
		gate.resolve();
		await closing.promise;
		await f.advance(24 * 60 * 60_000);
		expect(f.counts.roundLookup).toBe(0);
	});
	it("joins duplicate close calls while an accepted refresh remains pending", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "refresh", gate: gate.promise } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		let secondSettled = false;
		const second = f.app.close().then(() => {
			secondSettled = true;
		});
		await settle();
		expect(closing.settled()).toBe(false);
		expect(secondSettled).toBe(false);
		gate.resolve();
		await Promise.all([closing.promise, second]);
		expect(f.state.afterTeardown).toBe(0);
		expect(f.counts.refresh).toBe(1);
	});
	it("suppresses overlapping rounds but permits the next interval after a rejected lookup", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "roundLookup", gate: gate.promise, reject: true } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		await f.advance(INTERVAL_MS);
		expect(f.counts.roundLookup).toBe(1);
		gate.resolve();
		await f.idle();
		await f.advance(INTERVAL_MS - 1);
		expect(f.counts.roundLookup).toBe(1);
		await f.advance(1);
		expect(f.counts.roundLookup).toBe(2);
		expect(f.counts.refresh).toBe(1);
	});
	it("retains full selected multi-instance round lifetime without mixing identities", async () => {
		const gate = deferred();
		const f = await boot({ instances: 2, hold: { phase: "refresh", gate: gate.promise, call: 2 } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		expect(f.state.pending).toBe(1);
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await closing.promise;
		expect([...f.selected].sort()).toEqual(f.instances.map((row) => row.id).sort());
		expect(f.state.afterTeardown).toBe(0);
	});
	it("rejects an unrelated live handoff while draining the owned authority-keyed singleflight", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "refresh", gate: gate.promise } });
		await f.start("startup");
		expect(await f.waitUntilHeld()).toBe(true);
		await expect(f.arm()).resolves.toEqual({ status: "unavailable" });
		await f.advance(30_000);
		await settle();
		expect(f.counts.currentLookup).toBe(0);
		expect(f.counts.refresh).toBe(1);
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		gate.resolve();
		await closing.promise;
		expect(f.selected).toHaveLength(1);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("does not bypass owner-scoped recovery admission", async () => {
		const f = await boot();
		const wrong = { ...f.request, userId: f.owners[1]!.userId };
		f.bridge.admit(wrong);
		await expect(f.arm(wrong)).resolves.toEqual({ status: "ineligible" });
		expect(f.prisma.serviceInstance.findFirst).not.toHaveBeenCalled();
		await f.advance(30_000);
		expect(f.counts.refresh).toBe(0);
	});
	it("keeps existing three-attempt backoff and does not promote superseded results", async () => {
		const f = await boot({ alwaysRetryable: true });
		await f.advance(STARTUP_MS + 30_000 + 120_000 + 600_000);
		await settle();
		expect(f.counts.refresh).toBe(4);
		expect(f.counts.currentLookup).toBe(3);
		await f.advance(600_000);
		expect(f.counts.refresh).toBe(4);
		await f.dispose();
		const superseded = await boot({ superseded: true });
		await superseded.advance(STARTUP_MS + 20 * 60_000);
		await settle();
		expect(superseded.counts.refresh).toBe(1);
		expect(superseded.counts.currentLookup).toBe(0);
		await superseded.dispose();
		const positive = await boot({ positiveOnly: true });
		await positive.advance(STARTUP_MS + 20 * 60_000);
		expect(positive.counts.refresh).toBe(1);
		expect(positive.counts.currentLookup).toBe(0);
		// This case boots three real native fixtures before checking each outcome.
	}, 15_000);
	for (const deniedRung of [0, 1, 2]) {
		it(`preserves recovery rung ${deniedRung + 1} throughout prolonged maintenance`, async () => {
			const delays = [30_000, 120_000, 600_000];
			const f = await boot({ alwaysRetryable: true });
			await f.start("startup");
			await f.idle();
			for (let rung = 0; rung < deniedRung; rung++) {
				await f.advance(delays[rung]!);
			}
			const before = { ...f.counts };
			await withCleanupMaintenanceGuard(async () => {
				await f.advance(20 * 60_000);
				expect(f.counts).toEqual(before);
			});
			await f.advance(delays[deniedRung]!);
			expect(f.counts.refresh).toBe(before.refresh + 1);
			for (let rung = deniedRung + 1; rung < delays.length; rung++) {
				await f.advance(delays[rung]!);
			}
			expect(f.counts.refresh).toBe(4);
			await f.advance(20 * 60_000);
			expect(f.counts.refresh).toBe(4);
		});
	}
	it("reports maintenance-skipped startup and interval rounds without refresh failures", async () => {
		const f = await boot();
		const errors = vi.spyOn(f.app.log, "error");
		await withCleanupMaintenanceGuard(async () => {
			await f.advance(STARTUP_MS);
			await f.advance(INTERVAL_MS);
		});
		expect(errors).not.toHaveBeenCalled();
		expect(f.counts.roundLookup).toBe(0);
		await f.advance(INTERVAL_MS);
		expect(f.counts.refresh).toBe(1);
	});
	for (const origin of ["startup", "retry"] as const) {
		it(`keeps maintenance excluded throughout accepted ${origin} lookup`, async () => {
			const gate = deferred();
			const phase = origin === "startup" ? "roundLookup" : "currentLookup";
			const f = await boot({
				origin,
				firstRefreshFailed: origin === "retry",
				hold: { phase, gate: gate.promise },
			});
			const task = f.start(origin);
			expect(await f.waitUntilHeld()).toBe(true);
			expect(f.state.pending).toBe(1);
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});
			gate.resolve();
			await task;
			await settle();
			await f.app.close();
			await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
		});
	}
	it("does not start a new refresh or recovery lookup through maintenance and recovers afterward", async () => {
		const f = await boot();
		await withCleanupMaintenanceGuard(async () => {
			await f.advance(STARTUP_MS);
			await expect(f.arm()).resolves.toEqual({ status: "accepted" });
		});
		expect(f.counts.roundLookup).toBe(0);
		expect(f.counts.currentLookup).toBe(0);
		expect(f.counts.refresh).toBe(0);
		await f.advance(30_000);
		expect(f.counts.refresh).toBe(1);
	});
	it("naturally observes45-second startup and six-hour cadence with distinct owned Jellyfin/Emby sources", async () => {
		const f = await boot({ instances: 2 });
		await f.advance(STARTUP_MS - 1);
		expect(f.counts.roundLookup).toBe(0);
		expect(f.counts.refresh).toBe(0);
		await f.advance(1);
		expect(f.counts.roundLookup).toBe(1);
		expect(f.counts.refresh).toBe(2);
		expect(f.instances.map((row) => row.service).sort()).toEqual(["EMBY", "JELLYFIN"]);
		expect([...f.selected].sort()).toEqual(f.instances.map((row) => row.id).sort());
		await f.advance(INTERVAL_MS - 1);
		expect(f.counts.roundLookup).toBe(1);
		expect(f.counts.refresh).toBe(2);
		await f.advance(1);
		expect(f.counts.roundLookup).toBe(2);
		expect(f.counts.refresh).toBe(4);
		await f.app.close();
		expect(f.timerCount()).toBe(0);
		const before = { ...f.counts };
		await f.advance(INTERVAL_MS);
		expect(f.counts).toEqual(before);
	});
});
