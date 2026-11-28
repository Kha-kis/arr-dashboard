import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerSchedulers } from "../../bootstrap/schedulers.js";
import { SessionService } from "../../lib/auth/session.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import sessionCleanupPlugin from "../session-cleanup.js";

// Real SessionService, native SQL/runtime/bootstrap and separate observer/client.
// Only controlled deleteMany dependency failures are synthetic; no auth/cookie proof.
const HOUR = 60 * 60 * 1000;
type Native = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
type Owned = { owners: string[]; sessions: Array<{ id: string; userId: string; label: string }> };
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [],
	tasks: Promise<unknown>[] = [];
const fixtures = new Map<Native, Owned>();
const realInterval = globalThis.setInterval,
	realClearInterval = globalThis.clearInterval;
let hourly: { callback: () => void; handle: ReturnType<typeof setInterval> } | undefined;
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
beforeEach(() => {
	hourly = undefined;
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	const virtual = globalThis.setInterval,
		virtualClear = globalThis.clearInterval;
	vi.stubGlobal("setInterval", ((callback: () => void, delay?: number, ...args: unknown[]) => {
		const frame = new Error().stack
			?.split("\n")
			.find((line) => line.includes("/src/") && !line.includes("/__tests__/"));
		if (!frame?.includes("/plugins/session-cleanup.ts"))
			return Reflect.apply(realInterval, globalThis, [callback, delay, ...args]);
		expect(delay).toBe(HOUR);
		expect(hourly).toBeUndefined();
		const invoke = AsyncResource.bind(() => Reflect.apply(callback, globalThis, args));
		const handle = Reflect.apply(virtual, globalThis, [invoke, delay]);
		hourly = { callback: invoke, handle };
		return handle;
	}) as typeof setInterval);
	vi.stubGlobal("clearInterval", ((handle: Parameters<typeof clearInterval>[0]) =>
		handle === hourly?.handle
			? virtualClear(handle)
			: realClearInterval(handle)) as typeof clearInterval);
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(apps.splice(0).map((app) => app.close()));
	await Promise.all(tasks.splice(0));
	vi.restoreAllMocks();
	for (const [native, owned] of fixtures) {
		await native.runtime.drain();
		await native.run(async () => {
			const where = { OR: owned.sessions.map(({ id, userId }) => ({ id, userId })) };
			const remaining = await native.prisma.session.count({ where });
			expect((await native.prisma.session.deleteMany({ where })).count).toBe(remaining);
			expect(await native.prisma.session.count({ where })).toBe(0);
			expect(
				(await native.prisma.user.deleteMany({ where: { id: { in: owned.owners } } })).count,
			).toBe(2);
			expect(await native.prisma.user.count({ where: { id: { in: owned.owners } } })).toBe(0);
			expect(await native.prisma.session.count({ where: { userId: { in: owned.owners } } })).toBe(
				0,
			);
		});
		await native.close();
	}
	fixtures.clear();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
async function boot(
	options: { gates?: Promise<void>[]; rejectCalls?: number[]; beforeClose?: Promise<void> } = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	const second = await native.createOwner();
	const owned: Owned = { owners: [native.userId, second.userId], sessions: [] };
	fixtures.set(native, owned);
	const seed = async (label: string, expiresAt: Date) => {
		await native.run(async () => {
			for (const userId of owned.owners) {
				const id = randomUUID();
				await native.prisma.session.create({ data: { id, userId, expiresAt } });
				owned.sessions.push({ id, userId, label });
			}
		});
	};
	await seed("synthetic-active", new Date(Date.now() + 24 * HOUR));
	await seed("synthetic-expired", new Date(0));
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime),
		prisma = client.prisma;
	const state = {
		calls: 0,
		pending: 0,
		teardownCount: 0,
		pendingAtTeardown: -1,
		queriesAfterTeardown: 0,
	};
	let active = 0,
		elapsed = 0;
	const deleted: number[] = [];
	const remove = prisma.session.deleteMany.bind(prisma.session);
	const sessionWrites: { deleteMany: AwaitOnly<typeof prisma.session.deleteMany> } = prisma.session;
	vi.spyOn(sessionWrites, "deleteMany").mockImplementation(async (args) => {
		expect(args).toEqual({ where: { expiresAt: { lt: expect.any(Date) } } });
		expect(args!.where!.expiresAt).toHaveProperty("lt");
		const before = Date.now();
		const cutoff = (args!.where!.expiresAt as { lt: Date }).lt;
		expect(cutoff.getTime()).toBeLessThanOrEqual(before);
		expect(cutoff.getTime()).toBeGreaterThan(before - 4000);
		const call = ++state.calls;
		if (state.teardownCount > 0) state.queriesAfterTeardown++;
		state.pending++;
		try {
			await options.gates?.[call - 1];
			if (options.rejectCalls?.includes(call))
				throw new Error("Synthetic cleanup database failure");
			const result = await remove(args);
			deleted.push(result.count);
			return result;
		} finally {
			state.pending--;
		}
	});
	const app = Fastify({ logger: false });
	apps.push(app);
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma);
				server.decorate("restoreRuntime", native.runtime);
				server.decorate("dbProvider", native.engine as "sqlite" | "postgresql");
				server.addHook("onClose", async () => {
					expect(active).toBe(0);
					state.pendingAtTeardown = state.pending;
					await client.close();
					state.teardownCount++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				server.decorate("encryptor", native.encryptor);
				const sessions = new SessionService(prisma, {} as never);
				server.decorate("sessionService", sessions);
				server.addHook("preClose", async () => sessions.closeValidationAdmission());
				server.addHook("onClose", async () => sessions.drainValidations());
			},
			{ name: "security" },
		),
	);
	registerRestoreBootstrapPlugin(app, schedulerRegistryPlugin);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		active++;
		const task = track(...args).finally(() => {
			active--;
		});
		tasks.push(task.catch(() => undefined)); // Production runCleanup handles the recorded failure.
		return task;
	});
	const register = app.register.bind(app),
		displayName = Symbol.for("fastify.display-name");
	let selected = 0;
	const registration = vi.spyOn(app, "register").mockImplementation(((
		plugin: unknown,
		...args: unknown[]
	) => {
		if (
			typeof plugin === "function" &&
			Reflect.get(plugin, displayName) === Reflect.get(sessionCleanupPlugin, displayName)
		) {
			expect(plugin).not.toBe(sessionCleanupPlugin);
			expect(Reflect.get(plugin, Symbol.for("plugin-meta"))).toBe(
				Reflect.get(sessionCleanupPlugin, Symbol.for("plugin-meta")),
			);
			selected++;
			return Reflect.apply(register, app, [plugin, ...args]);
		}
		return app;
	}) as typeof app.register);
	try {
		registerSchedulers(app);
		expect(selected).toBe(1);
	} finally {
		registration.mockRestore();
	}
	await app.after();
	registerRestoreRuntimeActivation(app);
	const closing = deferred();
	app.addHook("preClose", async () => closing.resolve());
	if (options.beforeClose) app.addHook("preClose", async () => options.beforeClose);
	await app.ready();
	expect(app.dbProvider).toBe(native.engine);
	expect(hourly).toBeDefined();
	expect(deleted).toEqual(options.rejectCalls?.includes(1) ? [] : [2]);
	const idle = async () => {
		await native.runtime.drain();
		expect(await waitForNative(() => active === 0 && state.pending === 0)).toBe(true);
	};
	const advance = async (ms: number) => {
		const target = elapsed + ms;
		do {
			const next = Math.min(target, (Math.floor(elapsed / HOUR) + 1) * HOUR);
			await vi.advanceTimersByTimeAsync(next - elapsed);
			elapsed = next;
			expect(await waitForNative(() => active === 0 || state.pending > 0)).toBe(true);
			if (active === 0) await idle();
			else
				expect(
					await waitForNative(
						() => state.calls >= Math.floor(elapsed / HOUR) + 1 || state.teardownCount > 0,
					),
				).toBe(true);
		} while (elapsed < target);
	};
	const has = async (label: string) => {
		const ids = owned.sessions.filter((row) => row.label === label).map((row) => row.id);
		expect(ids).toHaveLength(2);
		const rows = await native.run(() =>
			native.prisma.session.findMany({
				where: { id: { in: ids }, userId: { in: owned.owners } },
				select: { id: true, userId: true },
			}),
		);
		expect([0, 2]).toContain(rows.length);
		if (rows.length === 2)
			expect(new Set(rows.map((row) => row.userId))).toEqual(new Set(owned.owners));
		return rows.length === 2;
	};
	return {
		app,
		state,
		seed,
		has,
		deleted,
		advance,
		idle,
		closing: closing.promise,
		checkpoint: async () => {
			expect(state.pending).toBeGreaterThan(0);
			await settle();
		},
		queuedTick: async () => {
			hourly!.callback();
			await idle();
		},
		status: () => app.schedulerRegistry.getStatus(JOB_ID.sessionCleanup)!,
		close() {
			let settled = false;
			const promise = app.close().then(() => {
				settled = true;
			});
			return { promise, settled: () => settled };
		},
	};
}

describe("session cleanup shutdown", () => {
	it.each([false, true])(
		"drains an hourly cleanup before database teardown (reject=%s)",
		async (reject) => {
			const gate = deferred();
			const fixture = await boot({
				gates: [Promise.resolve(), gate.promise],
				...(reject ? { rejectCalls: [2] } : {}),
			});
			await fixture.seed("synthetic-second-expired", new Date(0));
			await fixture.advance(HOUR);
			expect(fixture.state.calls).toBe(2);
			expect(fixture.state.pending).toBe(1);
			const close = fixture.close();
			try {
				await fixture.closing;
				await fixture.checkpoint();
				expect(close.settled()).toBe(false);
				expect(fixture.state.teardownCount).toBe(0);
			} finally {
				gate.resolve();
				await close.promise;
			}
			expect(fixture.state.pendingAtTeardown).toBe(0);
			expect(fixture.state.queriesAfterTeardown).toBe(0);
			expect(await fixture.has("synthetic-active")).toBe(true);
			expect(await fixture.has("synthetic-second-expired")).toBe(reject);
			expect(fixture.deleted).toEqual(reject ? [2] : [2, 2]);
			expect(fixture.status()).toMatchObject({ totalRuns: 2, totalFailures: reject ? 1 : 0 });
		},
	);

	it("closes admission before a sibling preClose wait and rejects an already queued callback", async () => {
		const sibling = deferred();
		const fixture = await boot({ beforeClose: sibling.promise });
		const close = fixture.close();
		try {
			await fixture.closing;
			await fixture.queuedTick();
			await fixture.advance(HOUR * 2);
			expect(close.settled()).toBe(false);
			expect(fixture.state.calls).toBe(1);
			expect(fixture.status()).toMatchObject({ totalRuns: 1, totalFailures: 0 });
		} finally {
			sibling.resolve();
			await close.promise;
		}
		await fixture.queuedTick();
		expect(fixture.state.queriesAfterTeardown).toBe(0);
	});

	it("drains every overlapping tick even when close is called twice", async () => {
		const first = deferred();
		const second = deferred();
		const fixture = await boot({ gates: [Promise.resolve(), first.promise, second.promise] });
		await fixture.advance(HOUR * 2);
		expect(fixture.state.pending).toBe(2);
		const close = fixture.close();
		const duplicate = fixture.app.close();
		try {
			await fixture.closing;
			first.resolve();
			expect(await waitForNative(() => fixture.state.pending === 1)).toBe(true);
			expect(fixture.state.pending).toBe(1);
			expect(close.settled()).toBe(false);
			expect(fixture.state.teardownCount).toBe(0);
		} finally {
			first.resolve();
			second.resolve();
			await Promise.all([close.promise, duplicate]);
		}
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.teardownCount).toBe(1);
		expect(fixture.status()).toMatchObject({ totalRuns: 3, totalFailures: 0 });
	});

	it("retains startup/hourly expiry cleanup and stops future work after an idle close", async () => {
		const fixture = await boot();
		expect(await fixture.has("synthetic-expired")).toBe(false);
		expect(await fixture.has("synthetic-active")).toBe(true);
		await fixture.advance(HOUR - 1);
		expect(fixture.state.calls).toBe(1);
		await fixture.advance(1);
		expect(fixture.state.calls).toBe(2);
		await fixture.app.close();
		await fixture.advance(HOUR * 2);
		expect(fixture.state.calls).toBe(2);
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.teardownCount).toBe(1);
	});

	it("preserves failure accounting and retries ordinary startup failure on the next hour", async () => {
		const fixture = await boot({ rejectCalls: [1] });
		expect(await fixture.has("synthetic-expired")).toBe(true);
		expect(fixture.status()).toMatchObject({
			totalRuns: 1,
			totalFailures: 1,
			consecutiveFailures: 1,
		});
		await fixture.advance(HOUR);
		await fixture.idle();
		expect(await fixture.has("synthetic-expired")).toBe(false);
		expect(await fixture.has("synthetic-active")).toBe(true);
		expect(fixture.status()).toMatchObject({
			totalRuns: 2,
			totalFailures: 1,
			consecutiveFailures: 0,
		});
		expect(fixture.deleted).toEqual([2]);
		await fixture.app.close();
		expect(fixture.state.pendingAtTeardown).toBe(0);
	});
});
