import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { installNonDatabaseRuntimeFixture } from "../../lib/__tests__/runtime-admission-fixture.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import notificationServicePlugin from "../notification-service.js";

const SIX_HOURS = 6 * 60 * 60 * 1000;
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

async function flushCloseCallbacks() {
	for (let turn = 0; turn < 8; turn++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

beforeEach(() => {
	// Interval/clock behavior is virtual; Fastify close and promises remain real.
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
});

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(ticks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	vi.restoreAllMocks();
	vi.useRealTimers();
});

type Phase = "settings" | "page" | "delete";

async function boot(
	options: {
		holds?: Array<{ phase: Phase; call: number; gate?: Promise<void>; reject?: boolean }>;
		beforeClose?: Promise<void>;
		retentionDays?: number;
	} = {},
) {
	const state = {
		settings: 0,
		page: 0,
		delete: 0,
		pending: 0,
		teardownCount: 0,
		pendingAtTeardown: -1,
		queriesAfterTeardown: 0,
	};
	const rows = new Map([
		["synthetic-old", new Date("2026-03-01T00:00:00.000Z")],
		["synthetic-recent", new Date("2026-09-30T00:00:00.000Z")],
	]);
	const pause = async (phase: Phase) => {
		const call = ++state[phase];
		if (state.teardownCount > 0) state.queriesAfterTeardown++;
		state.pending++;
		try {
			const hold = options.holds?.find((item) => item.phase === phase && item.call === call);
			await hold?.gate;
			if (hold?.reject) throw new Error("Synthetic retention database failure");
		} finally {
			state.pending--;
		}
	};
	// All persistence is an in-memory boundary. The real plugin/service/purge run.
	const prisma = {
		vapidKeys: {
			async findUnique() {
				return {
					publicKey: "synthetic-public",
					encryptedPrivateKey: "synthetic-cipher",
					privateKeyIv: "synthetic-iv",
				};
			},
		},
		systemSettings: {
			async findUnique(args: { where: { id: number } }) {
				if (JSON.stringify(args) !== '{"where":{"id":1}}') {
					throw new Error("Fixture refuses a changed settings selector");
				}
				await pause("settings");
				return options.retentionDays === undefined
					? null
					: { notificationLogRetentionDays: options.retentionDays };
			},
		},
		notificationLog: {
			async findMany(args: {
				where: { sentAt: { lt: Date } };
				select: { id: boolean };
				take: number;
			}) {
				if (
					Object.keys(args).sort().join() !== "select,take,where" ||
					Object.keys(args.where).join() !== "sentAt" ||
					Object.keys(args.where.sentAt).join() !== "lt" ||
					!(args.where.sentAt.lt instanceof Date) ||
					JSON.stringify(args.select) !== '{"id":true}' ||
					args.take !== 1000
				) {
					throw new Error("Fixture refuses a changed retention filter/projection/batch limit");
				}
				await pause("page");
				return [...rows]
					.filter(([, sentAt]) => sentAt < args.where.sentAt.lt)
					.slice(0, args.take)
					.map(([id]) => ({ id }));
			},
			async deleteMany(args: { where: { id: { in: string[] } } }) {
				if (
					Object.keys(args).join() !== "where" ||
					Object.keys(args.where).join() !== "id" ||
					Object.keys(args.where.id).join() !== "in" ||
					!Array.isArray(args.where.id.in) ||
					args.where.id.in.length > 1000 ||
					args.where.id.in.includes("synthetic-recent")
				) {
					throw new Error("Fixture refuses unbounded or recent-log deletion");
				}
				await pause("delete");
				let count = 0;
				for (const id of args.where.id.in) if (rows.delete(id)) count++;
				return { count };
			},
		},
	};
	const app = Fastify({ logger: false });
	installNonDatabaseRuntimeFixture(app);
	apps.push(app);
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma as never);
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					state.teardownCount++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(
		fp(
			async (server) => {
				server.decorate("encryptor", {
					decrypt() {
						// Fail before sender construction or contact-environment access.
						throw new Error("Synthetic browser push unavailable");
					},
				} as never);
				server.decorate("config", { APP_URL: "http://fixture.invalid" } as never);
			},
			{ name: "security" },
		),
	);
	const interval = vi.spyOn(globalThis, "setInterval");
	await app.register(notificationServicePlugin);
	const closing = deferred();
	app.addHook("preClose", async () => closing.resolve());
	if (options.beforeClose) app.addHook("preClose", async () => options.beforeClose);
	await app.ready();
	const callback = interval.mock.calls.find(([, delay]) => delay === SIX_HOURS)?.[0];
	if (typeof callback !== "function") throw new Error("Retention timer was not installed");
	const errors = vi.spyOn(app.log, "error");
	return {
		app,
		state,
		rows,
		errors,
		closing: closing.promise,
		queuedTick() {
			const tick = Promise.resolve(callback());
			ticks.push(tick);
			return tick;
		},
		close() {
			let settled = false;
			const promise = app.close().then(() => {
				settled = true;
			});
			return { promise, settled: () => settled };
		},
	};
}

describe("notification retention shutdown", () => {
	it.each([
		{ phase: "settings" as const, call: 3, reject: false },
		{ phase: "settings" as const, call: 3, reject: true },
		{ phase: "page" as const, call: 2, reject: false },
		{ phase: "page" as const, call: 2, reject: true },
		{ phase: "delete" as const, call: 2, reject: false },
		{ phase: "delete" as const, call: 2, reject: true },
	])("drains accepted $phase work before database teardown (reject=$reject)", async (hold) => {
		const gate = deferred();
		const fixture = await boot({ holds: [{ ...hold, gate: gate.promise }] });
		fixture.rows.set("synthetic-later-old", new Date("2026-03-01T00:00:00.000Z"));
		const tick = fixture.queuedTick();
		await flushCloseCallbacks();
		expect(fixture.state[hold.phase]).toBe(hold.call);
		expect(fixture.state.pending).toBe(1);
		const close = fixture.close();
		try {
			await fixture.closing;
			await flushCloseCallbacks();
			expect(close.settled()).toBe(false);
			expect(fixture.state.teardownCount).toBe(0);
		} finally {
			gate.resolve();
			await Promise.all([tick, close.promise]);
		}
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.queriesAfterTeardown).toBe(0);
		expect(fixture.rows.has("synthetic-recent")).toBe(true);
		expect(fixture.rows.has("synthetic-later-old")).toBe(hold.reject);
		expect(fixture.errors).toHaveBeenCalledTimes(hold.reject ? 1 : 0);
	});

	it.each([false, true])(
		"keeps dependencies alive between purge batches (reject=%s)",
		async (reject) => {
			const gate = deferred();
			const fixture = await boot({
				holds: [{ phase: "page", call: 3, gate: gate.promise, reject }],
			});
			for (let index = 0; index < 1001; index++) {
				fixture.rows.set(`synthetic-expired-${index}`, new Date("2026-03-01T00:00:00.000Z"));
			}
			const tick = fixture.queuedTick();
			await flushCloseCallbacks();
			expect(fixture.state.page).toBe(3);
			expect(fixture.state.pending).toBe(1);
			expect(fixture.rows.size).toBe(2); // First thousand deleted; last expired row and recent row remain.
			const close = fixture.close();
			try {
				await fixture.closing;
				await flushCloseCallbacks();
				expect(close.settled()).toBe(false);
				expect(fixture.state.teardownCount).toBe(0);
			} finally {
				gate.resolve();
				await Promise.all([tick, close.promise]);
			}
			expect(fixture.rows.size).toBe(reject ? 2 : 1);
			expect(fixture.rows.has("synthetic-recent")).toBe(true);
			expect(fixture.state.pendingAtTeardown).toBe(0);
			expect(fixture.state.queriesAfterTeardown).toBe(0);
			expect(fixture.errors).toHaveBeenCalledTimes(reject ? 1 : 0);
		},
	);

	it("refuses queued retention during a sibling preClose wait and after teardown", async () => {
		const sibling = deferred();
		const fixture = await boot({ beforeClose: sibling.promise });
		fixture.rows.set("synthetic-later-old", new Date("2026-03-01T00:00:00.000Z"));
		const close = fixture.close();
		try {
			await fixture.closing;
			await fixture.queuedTick();
			expect(close.settled()).toBe(false);
			expect(fixture.state.settings).toBe(2);
			expect(fixture.rows.has("synthetic-later-old")).toBe(true);
		} finally {
			sibling.resolve();
			await close.promise;
		}
		await fixture.queuedTick();
		await vi.advanceTimersByTimeAsync(SIX_HOURS * 2);
		expect(fixture.state.settings).toBe(2);
		expect(fixture.state.queriesAfterTeardown).toBe(0);
	});

	it("drains all overlapping retentions even when close is called twice", async () => {
		const first = deferred();
		const second = deferred();
		const fixture = await boot({
			holds: [
				{ phase: "settings", call: 3, gate: first.promise },
				{ phase: "settings", call: 4, gate: second.promise },
			],
		});
		const firstTick = fixture.queuedTick();
		const secondTick = fixture.queuedTick();
		expect(fixture.state.pending).toBe(2);
		const close = fixture.close();
		const duplicate = fixture.app.close();
		try {
			await fixture.closing;
			first.resolve();
			await firstTick;
			await flushCloseCallbacks();
			expect(fixture.state.pending).toBe(1);
			expect(close.settled()).toBe(false);
			expect(fixture.state.teardownCount).toBe(0);
		} finally {
			first.resolve();
			second.resolve();
			await Promise.all([firstTick, secondTick, close.promise, duplicate]);
		}
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.state.teardownCount).toBe(1);
		expect(fixture.state.queriesAfterTeardown).toBe(0);
	});

	it.each([undefined, 30])(
		"retains startup and six-hour batched expiry cleanup (%s days)",
		async (retentionDays) => {
			const fixture = await boot({ retentionDays });
			expect(fixture.rows.has("synthetic-old")).toBe(false);
			fixture.rows.set("synthetic-sixty-days", new Date("2026-08-01T00:00:00.000Z"));
			for (let index = 0; index < 1001; index++) {
				fixture.rows.set(`synthetic-expired-${index}`, new Date("2026-03-01T00:00:00.000Z"));
			}
			await vi.advanceTimersByTimeAsync(SIX_HOURS - 1);
			expect(fixture.state.settings).toBe(2);
			await vi.advanceTimersByTimeAsync(1);
			expect(fixture.state.settings).toBe(3);
			expect(fixture.state.delete).toBe(3);
			expect(fixture.rows.size).toBe(retentionDays === 30 ? 1 : 2);
			expect(fixture.rows.has("synthetic-sixty-days")).toBe(retentionDays !== 30);
			expect(fixture.rows.has("synthetic-recent")).toBe(true);
			await fixture.app.close();
			await vi.advanceTimersByTimeAsync(SIX_HOURS);
			expect(fixture.state.settings).toBe(3);
			expect(fixture.state.queriesAfterTeardown).toBe(0);
		},
	);

	it("retains rows on database failure and retries normally on the next six-hour tick", async () => {
		const fixture = await boot({ holds: [{ phase: "delete", call: 2, reject: true }] });
		fixture.rows.set("synthetic-later-old", new Date("2026-03-01T00:00:00.000Z"));
		await vi.advanceTimersByTimeAsync(SIX_HOURS);
		expect(fixture.rows.has("synthetic-later-old")).toBe(true);
		expect(fixture.errors).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(SIX_HOURS);
		expect(fixture.rows.has("synthetic-later-old")).toBe(false);
		expect(fixture.rows.has("synthetic-recent")).toBe(true);
		expect(fixture.errors).toHaveBeenCalledTimes(1);
	});
});
