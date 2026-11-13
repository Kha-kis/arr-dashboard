import { AsyncResource } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import { registerRestoreRuntimeActivation } from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import type { QuiTorrentInventory } from "../../lib/qui/client-factory.js";
import {
	__torrentListCacheState,
	invalidateTorrentListCache,
} from "../../lib/qui/torrent-list-cache.js";
import plugin from "../qui-cache-prewarm.js";

// Native persistence, bootstrap, owner/crypto and real sequential cache lifetime.
// Only createQuiClient is synthetic. Empty synthetic inventory is not provider proof.
const boundary = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("../../lib/qui/client-factory.js", () => ({ createQuiClient: boundary.createClient }));
type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [];
const fixtures = new Map<
	Native,
	{
		instances: Array<{ id: string; userId: string }>;
		owners: Array<{ userId: string; channelId: string }>;
	}
>();
const realTimeout = globalThis.setTimeout,
	realClearTimeout = globalThis.clearTimeout;
type TimerRecord = {
	callback: () => void;
	handle: ReturnType<typeof setTimeout>;
	dueAt: number;
	delay: number;
};
const installed: TimerRecord[] = [],
	activeTimers = new Map<ReturnType<typeof setTimeout>, TimerRecord>();
const providerBudgets: number[] = [];
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
		phase?: "lookup" | "provider";
		gate?: Promise<void>;
		reject?: boolean;
		preClose?: Promise<void>;
		empty?: boolean;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const owners = [
		{ userId: native.userId, channelId: native.channelId },
		await native.createOwner(),
	];
	const owned = { instances: [] as Array<{ id: string; userId: string }>, owners };
	fixtures.set(native, owned);
	const seeded: ServiceInstance[] = [];
	await native.run(async () => {
		for (let index = 0; index < 4; index++) {
			const key = native.encryptor.encrypt("synthetic-qui-key");
			const instance = await native.prisma.serviceInstance.create({
				data: {
					userId: owners[index === 1 ? 1 : 0]!.userId,
					service: index === 3 ? "RADARR" : "QUI",
					label: "Same synthetic label",
					baseUrl: "https://synthetic.invalid",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
					enabled: index === 2 ? false : !options.empty,
					connectionGeneration: 7,
					identityGeneration: 1,
					identityStatus: "UNVERIFIED",
				},
			});
			seeded.push(instance);
			owned.instances.push({ id: instance.id, userId: instance.userId });
		}
	});
	const instances = seeded.slice(0, 2).filter((row) => row.enabled);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	const state = {
		reads: 0,
		providers: 0,
		pending: 0,
		teardown: false,
		afterTeardown: 0,
		pendingAtTeardown: -1,
		maxProviderFlight: 0,
	};
	let held = false,
		providerFlight = 0;
	const lookupSequences: ServiceInstance[][] = [],
		selected: Array<{ id: string; userId: string }> = [];
	const signals: AbortSignal[] = [];
	async function pause<T>(
		phase: "lookup" | "provider",
		operation: () => PromiseLike<T> | T,
	): Promise<T> {
		state.pending++;
		if (state.teardown) state.afterTeardown++;
		try {
			if (options.phase === phase) {
				held = true;
				await options.gate;
				if (options.reject) throw new Error("Synthetic unavailable");
			}
			return await operation();
		} finally {
			state.pending--;
			if (state.teardown) state.afterTeardown++;
		}
	}
	const findMany = prisma.serviceInstance.findMany.bind(prisma.serviceInstance);
	const reads: { findMany: AwaitOnly<typeof prisma.serviceInstance.findMany> } =
		prisma.serviceInstance;
	vi.spyOn(reads, "findMany").mockImplementation((query) => {
		expect(query).toEqual({ where: { service: "QUI", enabled: true } });
		state.reads++;
		return pause("lookup", async () => {
			const rows = await findMany(query);
			expect(new Set(rows.map((row) => row.id))).toEqual(new Set(instances.map((row) => row.id)));
			for (const row of rows)
				expect(row).toEqual(instances.find((instance) => instance.id === row.id));
			lookupSequences.push(rows);
			return rows;
		});
	});
	const forbidden = vi.fn(() => {
		throw new Error("Forbidden upstream operation");
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(forbidden);
	boundary.createClient.mockImplementation((context, instance: ServiceInstance) => {
		// The actual bootstrap wrapper supplies its registration Proxy, not root app.
		expect(context.prisma).toBe(prisma);
		expect(context.encryptor).toBe(native.encryptor);
		expect(context.restoreRuntime).toBe(native.runtime);
		expect(context.log).toBe(app.log);
		expect(app.prisma).toBe(prisma);
		expect(prisma).not.toBe(native.prisma);
		expect(app.encryptor).toBe(native.encryptor);
		expect(instance).toEqual(instances.find((row) => row.id === instance.id));
		expect(
			native.encryptor.decrypt({ value: instance.encryptedApiKey, iv: instance.encryptionIv }),
		).toBe("synthetic-qui-key");
		selected.push({ id: instance.id, userId: instance.userId });
		return {
			listTorrentInventory: async (input: {
				signal?: AbortSignal;
			}): Promise<QuiTorrentInventory> => {
				expect(Object.keys(input)).toEqual(["signal"]);
				expect(input.signal).toBeInstanceOf(AbortSignal);
				expect(input.signal!.aborted).toBe(false);
				signals.push(input.signal!);
				state.providers++;
				providerFlight++;
				state.maxProviderFlight = Math.max(state.maxProviderFlight, providerFlight);
				try {
					return await pause("provider", () => ({ torrents: [], complete: true }));
				} finally {
					providerFlight--;
				}
			},
		};
	});
	await app.register(
		fp(
			async (scope) => {
				scope.decorate("prisma", prisma);
				scope.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					expect(state.pending).toBe(0);
					expect(providerFlight).toBe(0);
					expect(forbidden).not.toHaveBeenCalled();
					await native.run(async () => {
						expect(
							await native.prisma.serviceInstance.count({ where: { OR: owned.instances } }),
						).toBe(4);
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
			async (scope) => {
				scope.decorate("encryptor", native.encryptor);
			},
			{ name: "security" },
		),
	);
	const register = app.register.bind(app),
		displayName = Symbol.for("fastify.display-name");
	let selectedRegistrations = 0;
	const registration = vi.spyOn(app, "register").mockImplementation(((
		candidate: unknown,
		...args: unknown[]
	) => {
		if (
			typeof candidate === "function" &&
			Reflect.get(candidate, displayName) === Reflect.get(plugin, displayName)
		) {
			expect(candidate).not.toBe(plugin);
			expect(Reflect.get(candidate, Symbol.for("plugin-meta"))).toBe(
				Reflect.get(plugin, Symbol.for("plugin-meta")),
			);
			selectedRegistrations++;
			return Reflect.apply(register, app, [candidate, ...args]);
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
		if (options.preClose) await options.preClose;
	});
	await app.ready();
	const record = installed.find((row) => row.delay === 30_000);
	if (record) expect(record.handle.hasRef()).toBe(false);
	const startup = record?.callback;
	const start = () => {
		if (record) clearTimeout(record.handle);
		startup?.();
	};
	const idle = async () => {
		await native.runtime.drain();
		expect(await waitForNative(() => state.pending === 0 && providerFlight === 0)).toBe(true);
		await settle();
	};
	const advance = async (ms: number) => {
		const target = Date.now() + ms;
		do {
			const due = Math.min(...[...activeTimers.values()].map((timer) => timer.dueAt));
			await vi.advanceTimersByTimeAsync(Math.max(0, Math.min(target, due) - Date.now()));
			await idle();
		} while (Date.now() < target);
		expect(Date.now()).toBe(target);
	};
	return {
		app,
		state,
		start,
		startup,
		forbidden,
		owners,
		instances,
		selected,
		lookupSequences,
		signals,
		idle,
		advance,
		waitUntilHeld: () => waitForNative(() => held && state.pending === 1),
		async closePending() {
			let closed = false;
			const promise = app.close().then(() => {
				closed = true;
			});
			await preClosed.promise;
			await settle();
			return { promise, closed: () => closed };
		},
	};
}
beforeEach(() => {
	installed.length = 0;
	activeTimers.clear();
	providerBudgets.length = 0;
	vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	const virtualTimeout = globalThis.setTimeout,
		virtualClear = globalThis.clearTimeout;
	const sourceFrame = () =>
		new Error().stack
			?.split("\n")
			.find((line) => line.includes("/src/") && !line.includes("/__tests__/"));
	vi.stubGlobal("setTimeout", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		const frame = sourceFrame();
		if (frame?.includes("/lib/qui/cache-prewarm.ts")) providerBudgets.push(delay ?? 0);
		if (!frame?.includes("/plugins/qui-cache-prewarm.ts"))
			return Reflect.apply(realTimeout, globalThis, [callback, delay, ...args]);
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		let handle: ReturnType<typeof setTimeout>;
		const forward = () => {
			activeTimers.delete(handle);
			invoke();
		};
		handle = Reflect.apply(virtualTimeout, globalThis, [forward, delay]);
		const row = {
			callback: invoke,
			handle,
			delay: delay ?? 0,
			dueAt: Date.now() + Math.max(0, delay ?? 0),
		};
		installed.push(row);
		activeTimers.set(handle, row);
		return handle;
	}) as typeof setTimeout);
	vi.stubGlobal("clearTimeout", ((handle: Parameters<typeof clearTimeout>[0]) => {
		if (installed.some((row) => row.handle === handle)) {
			activeTimers.delete(handle as ReturnType<typeof setTimeout>);
			return virtualClear(handle);
		}
		return realClearTimeout(handle);
	}) as typeof clearTimeout);
	vi.stubEnv("DISABLE_QUI_CACHE_PREWARM", "false");
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(apps.splice(0).map((app) => app.close()));
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	for (const [native, owned] of fixtures) {
		expect(__torrentListCacheState().pending).toBe(0);
		for (const instance of owned.instances) invalidateTorrentListCache(instance.id);
		expect(__torrentListCacheState()).toEqual({ cached: 0, pending: 0 });
		await native.run(async () => {
			expect(
				(await native.prisma.serviceInstance.deleteMany({ where: { OR: owned.instances } })).count,
			).toBe(4);
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
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	boundary.createClient.mockReset();
});

describe("qUI pre-warm shutdown and maintenance", () => {
	for (const phase of ["lookup", "provider"] as const)
		for (const reject of [false, true]) {
			it(`retains an accepted ${phase} ${reject ? "failure" : "success"} until database teardown is safe`, async () => {
				const held = deferred();
				const h = await boot({ phase, gate: held.promise, reject });
				h.start();
				expect(await h.waitUntilHeld()).toBe(true);
				expect(h.state.pending).toBe(1);
				await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
					statusCode: 409,
				});
				const closing = await h.closePending();
				const close = closing.promise;
				try {
					expect(closing.closed()).toBe(false);
					expect(h.state.teardown).toBe(false);
				} finally {
					held.resolve();
					await close;
				}
				expect(h.state.afterTeardown).toBe(0);
				expect(h.state.pendingAtTeardown).toBe(0);
				expect(h.state.providers).toBe(phase === "lookup" ? 0 : 1);
				if (phase === "provider") expect(h.signals.map((signal) => signal.aborted)).toEqual([true]);
				expect(__torrentListCacheState()).toEqual({ cached: 0, pending: 0 });
				await expect(withCleanupMaintenanceGuard(async () => "safe")).resolves.toBe("safe");
				expect(h.forbidden).not.toHaveBeenCalled();
			});
		}
	it("does not admit its startup callback while a sibling preClose is pending", async () => {
		const held = deferred();
		const h = await boot({ preClose: held.promise });
		const closing = await h.closePending();
		const close = closing.promise;
		h.start();
		await h.idle();
		try {
			expect(h.state.reads).toBe(0);
			expect(h.state.providers).toBe(0);
		} finally {
			held.resolve();
			await close;
		}
		h.start();
		await h.idle();
		expect(h.state.reads).toBe(0);
	});
	it("denies startup work during database maintenance without creating a client", async () => {
		const held = deferred();
		const h = await boot();
		const maintenance = withCleanupMaintenanceGuard(async () => held.promise);
		await settle();
		h.start();
		await h.idle();
		try {
			expect(h.state.reads).toBe(0);
			expect(h.state.providers).toBe(0);
		} finally {
			held.resolve();
			await maintenance;
		}
	});
	it("keeps exactly one active pre-warm if a retained startup callback fires twice", async () => {
		const held = deferred();
		const h = await boot({ phase: "lookup", gate: held.promise, empty: true });
		h.start();
		h.start();
		expect(await h.waitUntilHeld()).toBe(true);
		try {
			expect(h.state.reads).toBe(1);
		} finally {
			held.resolve();
			await h.idle();
		}
		await h.app.close();
		expect(h.state.afterTeardown).toBe(0);
	});
	it("preserves the opt-out without issuing database or provider reads", async () => {
		vi.stubEnv("DISABLE_QUI_CACHE_PREWARM", "true");
		const h = await boot();
		expect(h.startup).toBeUndefined();
		expect(h.state.reads).toBe(0);
		expect(h.state.providers).toBe(0);
	});
	it("still pre-warms both enabled instances sequentially on a normal boot", async () => {
		const h = await boot();
		h.start();
		await h.idle();
		expect(h.state.reads).toBe(1);
		expect(h.state.providers).toBe(2);
		expect(h.state.maxProviderFlight).toBe(1);
		expect(h.selected).toEqual(h.lookupSequences[0]!.map(({ id, userId }) => ({ id, userId })));
		expect(new Set(h.selected.map((row) => row.userId))).toEqual(
			new Set(h.owners.map((row) => row.userId)),
		);
		expect(providerBudgets).toEqual([60_000, 60_000]);
		expect(__torrentListCacheState()).toEqual({ cached: 2, pending: 0 });
		await expect(withCleanupMaintenanceGuard(async () => "safe")).resolves.toBe("safe");
		await h.app.close();
		h.start();
		await h.idle();
		expect(h.state.reads).toBe(1);
	});
	it("keeps the natural default starting startup delay without eager pre-warm", async () => {
		const h = await boot();
		expect(h.state.reads).toBe(0);
		await h.advance(29_999);
		expect(h.state.reads).toBe(0);
		expect(h.state.providers).toBe(0);
		await h.advance(1);
		expect(h.state.reads).toBe(1);
		expect(h.state.providers).toBe(2);
		expect(h.state.maxProviderFlight).toBe(1);
		expect(__torrentListCacheState()).toEqual({ cached: 2, pending: 0 });
		expect(providerBudgets).toEqual([60_000, 60_000]);
		await h.advance(30_000);
		expect(h.state.reads).toBe(1);
	});
});
