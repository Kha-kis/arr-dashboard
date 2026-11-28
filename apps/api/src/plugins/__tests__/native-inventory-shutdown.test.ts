import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installRuntimeFixture } from "./runtime-fixture.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import type { ServiceInstance } from "../../lib/prisma.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import scheduler from "../native-inventory-scheduler.js";
import registry from "../scheduler-registry.js";

// Keep the actual scheduling, due selection, client/adapter construction and registry.
// Durable slice execution and persistence are external boundaries for these lifetime tests.
const boundary = vi.hoisted(() => ({ slice: vi.fn() }));
vi.mock("../../lib/provider-observation/native-inventory-job-runner.js", () => ({
	runNativeInventoryJobSlice: boundary.slice,
}));
const STARTUP_MS = 30_000,
	INTERVAL_MS = 30_000;
type Origin = "startup" | "interval";
type Phase = "admission" | "due" | "slice";
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
async function boot(
	options: {
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; call?: number };
		preCloseGate?: Promise<void>;
		empty?: boolean;
		invalidRuns?: boolean;
	} = {},
) {
	const instances: ServiceInstance[] = (["PLEX", "JELLYFIN", "EMBY"] as const).map(
		(service, i) => ({
			id: `instance-${++sequence}`,
			userId: i % 2 ? "owner-b" : "owner-a",
			service,
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
		}),
	);
	const runs = instances.map((instance, i) => ({
		id: `run-${instance.id}`,
		instanceId: instance.id,
		instance,
		workKey: i === 0 ? "paired" : i === 1 ? "library" : "episode",
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
		updatedAt: new Date(),
	}));
	const counts = { admission: 0, due: 0, slice: 0 };
	const state = { pending: 0, teardown: false, afterTeardown: 0, pendingAtTeardown: -1 };
	const selected: string[] = [];
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
				expect(args).toEqual({
					where: {
						enabled: true,
						identityStatus: "VERIFIED",
						service: { in: ["PLEX", "JELLYFIN", "EMBY"] },
					},
					orderBy: { id: "asc" },
				});
				await pause("admission");
				// No periodic admission or write: work below was already present in the synthetic store.
				return [];
			}),
		},
		providerNativeInventoryRun: {
			findMany: vi.fn(async (args) => {
				// The independent maintenance clock has no obsolete runs in this
				// provider-lifetime fixture. Its real query must not enter due work.
				if (args.where.activeSlotKey === null) return [];
				const now = new Date();
				expect(args).toEqual({
					where: {
						activeSlotKey: { not: null },
						state: { in: ["pending", "running", "ready"] },
						OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
						AND: [{ OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] }],
						instance: {
							enabled: true,
							identityStatus: "VERIFIED",
							service: { in: ["PLEX", "JELLYFIN", "EMBY"] },
						},
					},
					include: { instance: true },
					orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
				});
				await pause("due");
				return options.empty
					? []
					: options.invalidRuns
						? [
								{ ...runs[0]!, connectionGeneration: 6 },
								{ ...runs[1]!, identityGeneration: 2 },
								{ ...runs[2]!, workKey: "unknown" },
							]
						: runs;
			}),
		},
	};
	boundary.slice.mockImplementation(async (database, id, adapter, budget) => {
		expect(database).toBe(prisma);
		const run = runs.find((row) => row.id === id);
		expect(run).toBeDefined();
		expect(budget).toMatchObject({
			deadlineAt: Date.now() + 60_000,
			maxPages: 20,
			retryDelayMs: 30_000,
			pageSize: run!.instance.service === "JELLYFIN" ? 2_000 : 500,
			verifyIdentity: expect.any(Function),
			reportPhase: expect.any(Function),
		});
		expect(adapter).toMatchObject({
			discoverScopes: expect.any(Function),
			readPage: expect.any(Function),
		});
		selected.push(id);
		await pause("slice");
		return { status: "incomplete", pagesCommitted: 1 };
	});
	const app = Fastify({ logger: false });
	apps.push(app);
	await installRuntimeFixture(app);
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
				server.decorate("encryptor", { decrypt: () => "synthetic-token" } as never);
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
		if (typeof fn !== "function") throw new Error("Native callback missing");
		return () => {
			if (origin === "startup") clearTimeout(spy.mock.results[index]?.value);
			fn();
		};
	}
	return {
		app,
		runs,
		counts,
		state,
		selected,
		callback,
		intervals,
		status: () => app.schedulerRegistry.getStatus(JOB_ID.nativeInventory)!,
		async start(origin: Origin) {
			if (origin === "interval") {
				callback("startup")();
				await settle();
			}
			callback(origin)();
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
	boundary.slice.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(apps.splice(0).map((app) => app.close()));
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
describe("Native inventory scheduler admission and accepted tick lifetime", () => {
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of ["admission", "due", "slice"] as const)
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before database teardown`, async () => {
					const gate = deferred();
					const f = await boot({
						hold: {
							phase,
							gate: gate.promise,
							reject,
							call: origin === "interval" ? (phase === "slice" ? 4 : 2) : 1,
						},
					});
					await f.start(origin);
					await settle();
					expect(f.state.pending).toBe(1);
					const closing = await f.closePending();
					expect(closing.settled()).toBe(false);
					expect(f.state.teardown).toBe(false);
					gate.resolve();
					await closing.promise;
					expect(f.state.pendingAtTeardown).toBe(0);
					expect(f.state.afterTeardown).toBe(0);
					const before = { ...f.counts };
					await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
					expect(f.counts).toEqual(before);
				});
			}
		it(`refuses retained ${origin} during a waiting sibling preClose hook`, async () => {
			const gate = deferred(),
				f = await boot({ preCloseGate: gate.promise, empty: true });
			if (origin === "interval") {
				await f.start("startup");
				await settle();
			}
			const next = f.callback(origin),
				before = { ...f.counts },
				installed = f.intervals.mock.calls.length;
			const closing = await f.closePending();
			next();
			await settle();
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(installed);
			gate.resolve();
			await closing.promise;
		});
		it(`retires retained ${origin} without starting work or installing an interval`, async () => {
			const f = await boot({ empty: true });
			if (origin === "interval") {
				await f.start("startup");
				await settle();
			}
			const next = f.callback(origin);
			await f.app.close();
			const before = { ...f.counts },
				installed = f.intervals.mock.calls.length;
			next();
			await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
			expect(f.counts).toEqual(before);
			expect(f.intervals.mock.calls.length).toBe(installed);
		});
	}
	for (const phase of ["admission", "due", "slice"] as const) {
		it(`keeps maintenance exclusion through the accepted ${phase} boundary`, async () => {
			const gate = deferred(),
				f = await boot({ hold: { phase, gate: gate.promise } });
			await f.start("startup");
			await settle();
			await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
				statusCode: 409,
			});
			gate.resolve();
			await settle();
			await f.app.close();
			await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
		});
	}
	it("joins repeated closes and only finishes the already active provider batch", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "slice", gate: gate.promise } });
		await f.start("startup");
		await settle();
		const active = [...f.selected];
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
		expect(active).toHaveLength(2);
		expect(f.selected).toEqual(active);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("does not replace an accepted tick when interval callbacks overlap", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "admission", gate: gate.promise } });
		await f.start("startup");
		await settle();
		f.callback("interval")();
		f.callback("interval")();
		await settle();
		expect(f.counts.admission).toBe(1);
		expect(f.status().state).toBe("running");
		gate.resolve();
		await settle();
		expect(f.counts.slice).toBe(3);
		expect(f.status().totalRuns).toBe(1);
	});
	it("recovers on the same cadence after maintenance denies a tick without recording failure", async () => {
		const f = await boot();
		await withCleanupMaintenanceGuard(async () => {
			await f.start("startup");
			await settle();
			expect(f.counts).toEqual({ admission: 0, due: 0, slice: 0 });
			expect(f.status()).toMatchObject({ totalRuns: 0, totalFailures: 0, lastStartedAt: null });
		});
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(f.counts).toEqual({ admission: 1, due: 1, slice: 3 });
	});
	it("still runs due work after periodic admission rejects and retries admission next interval", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "admission", gate: gate.promise, reject: true } });
		await f.start("startup");
		await settle();
		gate.resolve();
		await settle();
		expect(f.counts).toEqual({ admission: 1, due: 1, slice: 3 });
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(f.counts).toEqual({ admission: 2, due: 2, slice: 6 });
	});
	it("can run the next tick after due-work lookup rejects", async () => {
		const gate = deferred(),
			f = await boot({ hold: { phase: "due", gate: gate.promise, reject: true } });
		await f.start("startup");
		await settle();
		gate.resolve();
		await settle();
		expect(f.counts.slice).toBe(0);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS);
		expect(f.counts).toEqual({ admission: 2, due: 2, slice: 3 });
	});
	it("retains generation and work-key filters before dispatch", async () => {
		const f = await boot({ invalidRuns: true });
		await f.start("startup");
		await settle();
		expect(f.counts).toEqual({ admission: 1, due: 1, slice: 0 });
	});
	it("keeps delayed startup and recurring thirty-second work ticks", async () => {
		const f = await boot({ empty: true });
		await vi.advanceTimersByTimeAsync(STARTUP_MS - 1);
		expect(f.counts.admission).toBe(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.counts.admission).toBe(1);
		await vi.advanceTimersByTimeAsync(INTERVAL_MS - 1);
		expect(f.counts.admission).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(f.counts.admission).toBe(2);
	});
});
