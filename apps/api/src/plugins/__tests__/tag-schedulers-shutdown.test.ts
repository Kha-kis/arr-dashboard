import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runRuleWithLock } from "../../lib/auto-tag/run-with-lock.js";
import { registerLabelSyncMutationAdmission } from "../../lib/label-sync/mutation-admission.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import autoTagPlugin from "../auto-tag-scheduler.js";
import labelSyncPlugin from "../label-sync-scheduler.js";
import registry from "../scheduler-registry.js";
import { installRuntimeFixture } from "./runtime-fixture.js";

// Real scheduler classes, plugins, rule lock, label-result CAS, registry and
// maintenance gate. Only the executor/reconciliation and persistence boundaries
// are synthetic. These lifecycle tests do not prove real provider mutations.
const boundary = vi.hoisted(() => ({ autoTag: vi.fn(), labelSync: vi.fn(), reconcile: vi.fn() }));
vi.mock("../../lib/auto-tag/execute-rule.js", () => ({ executeAutoTagRule: boundary.autoTag }));
vi.mock("../../lib/label-sync/execute-rule.js", () => ({
	executeLabelSyncRule: boundary.labelSync,
}));
vi.mock("../../lib/label-sync/jellyfin-mutation-executor.js", () => ({
	reconcileJellyfinMutationAttempts: boundary.reconcile,
}));

type Kind = "auto-tag" | "label-sync";
type Origin = "startup" | "interval";
type Phase = "rules" | "reconcile" | "execute" | "save" | "failure-save" | "saved-read";
const apps: FastifyInstance[] = [],
	releases: Array<() => void> = [],
	cleanups: Array<() => void> = [];
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
	kind: Kind,
	options: {
		origin?: Origin;
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; call?: number };
		preClose?: Promise<void>;
		result?: "success" | "partial" | "failed";
		executionFails?: boolean;
		saveFails?: boolean;
		reconcileFails?: boolean;
		changedRule?: boolean;
		rows?: number;
		initFails?: boolean;
		wrapperGate?: Promise<void>;
	} = {},
) {
	const state = {
		pending: 0,
		teardown: false,
		afterTeardown: 0,
		pendingAtTeardown: -1,
		armed: options.origin !== "interval",
		sends: 0,
	};
	const counts = new Map<Phase, number>(),
		order: Phase[] = [],
		results: Array<Record<string, unknown>> = [];
	const rows = ["owner-a", "owner-b"].slice(0, options.rows ?? 1).map((userId, index) => ({
		id: `rule-${index}`,
		userId,
		name: "Synthetic rule",
		enabled: true,
		ruleType: "watched",
		parameters: "{}",
		operator: null,
		conditions: null,
		serviceFilter: null,
		instanceFilter: null,
		excludeTags: null,
		excludeTitles: null,
		plexLibraryFilter: null,
		tagName: "Synthetic tag",
		sourceService: "sonarr",
		sourceInstanceId: `source-${index}`,
		sourceTagName: "Synthetic tag",
		destService: "plex",
		destInstanceId: `destination-${index}`,
		destTagName: "Synthetic tag",
		updatedAt: new Date(0),
		lastRunAt: null,
		lastRunStatus: null,
		lastRunMessage: null,
	}));
	async function pause(phase: Phase) {
		const call = (counts.get(phase) ?? 0) + 1;
		counts.set(phase, call);
		order.push(phase);
		state.pending++;
		if (state.teardown) state.afterTeardown++;
		try {
			if (state.armed && options.hold?.phase === phase && call === (options.hold.call ?? 1)) {
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
		} finally {
			state.pending--;
			if (state.teardown) state.afterTeardown++;
		}
	}
	const model = {
		findMany: async (args: unknown) => {
			expect(args).toEqual({
				where: {
					enabled: true,
					OR: [{ lastRunAt: null }, { lastRunAt: { lt: expect.any(Date) } }],
				},
			});
			await pause("rules");
			return state.armed ? rows : [];
		},
		update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
			expect(rows.some((row) => row.id === where.id)).toBe(true);
			const failure = data.lastRunStatus === "failed" || data.lastRunAt === null;
			await pause(failure ? "failure-save" : "save");
			if (options.saveFails && !failure) throw new Error("Synthetic result save unavailable");
			results.push({ userId: rows.find((row) => row.id === where.id)?.userId, ...data });
			return {};
		},
		updateMany: async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const row = rows.find((row) => row.id === where.id);
			expect(row).toBeDefined();
			if (!row) throw new Error("Unexpected rule");
			expect(where).toEqual({
				id: row.id,
				userId: row.userId,
				name: row.name,
				enabled: true,
				sourceService: "sonarr",
				sourceInstanceId: row.sourceInstanceId,
				sourceTagName: "Synthetic tag",
				destService: "plex",
				destInstanceId: row.destInstanceId,
				destTagName: "Synthetic tag",
				updatedAt: new Date(0),
			});
			const failure = data.lastRunStatus === "failed";
			await pause(failure ? "failure-save" : "save");
			if (options.saveFails && !failure) throw new Error("Synthetic result save unavailable");
			if (options.changedRule) return { count: 0 };
			results.push({ userId: row.userId, ...data });
			return { count: 1 };
		},
		findFirst: async ({ where }: { where: { id: string; userId: string } }) => {
			const row = rows.find((row) => row.id === where.id && row.userId === where.userId);
			expect(row).toBeDefined();
			await pause("saved-read");
			return row;
		},
	};
	const prisma = {
		autoTagRule: model,
		labelSyncRule: model,
		$transaction: async <T>(fn: (tx: { labelSyncRule: typeof model }) => Promise<T>) =>
			fn({ labelSyncRule: model }),
	};
	const execute = async ({ rule }: { rule: { id: string; userId: string } }) => {
		expect(rows.some((row) => row.id === rule.id && row.userId === rule.userId)).toBe(true);
		await pause("execute");
		if (options.executionFails) throw new Error("Synthetic execution unavailable");
		state.sends++;
		return {
			status: options.result ?? "success",
			message: "Synthetic outcome",
			totals:
				kind === "auto-tag"
					? { instancesScanned: 1, itemsScanned: 1, itemsMatched: 1, tagsApplied: 1, failures: 0 }
					: {
							sourceInstancesScanned: 1,
							taggedItemsFound: 1,
							destMatchesFound: 1,
							labelsApplied: 1,
							failures: 0,
						},
		};
	};
	boundary[kind === "auto-tag" ? "autoTag" : "labelSync"].mockImplementation(execute);
	boundary.reconcile.mockImplementation(async () => {
		await pause("reconcile");
		if (options.reconcileFails) throw new Error("Synthetic reconciliation unavailable");
	});
	const app = Fastify({ logger: false });
	apps.push(app);
	await installRuntimeFixture(app);
	cleanups.push(registerLabelSyncMutationAdmission(prisma, { isOpen: () => true }));
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
				server.decorate("arrClientFactory", {} as never);
				server.decorate("encryptor", {} as never);
			},
			{ name: "arr-client" },
		),
	);
	await app.register(registry);
	if (options.wrapperGate) {
		const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
		vi.spyOn(app.schedulerRegistry, "track").mockImplementation(async (jobId, fn, trackOptions) => {
			await options.wrapperGate;
			return track(jobId, fn, trackOptions);
		});
	}
	await app.register(kind === "auto-tag" ? autoTagPlugin : labelSyncPlugin);
	if (options.preClose)
		await app.register(
			fp(
				async (server) => {
					server.addHook("preClose", async () => {
						await options.preClose;
					});
				},
				{ name: "synthetic-pre-close" },
			),
		);
	if (options.initFails) {
		vi.spyOn(app, "decorate").mockImplementationOnce(() => {
			throw new Error("Synthetic init failure");
		});
	}
	const realInterval = globalThis.setInterval;
	const intervals: Array<{ callback: () => void; handle: ReturnType<typeof setInterval> }> = [];
	const intervalSpy = vi
		.spyOn(globalThis, "setInterval")
		.mockImplementation((callback, delay, ...args) => {
			expect(delay).toBe(300_000);
			const handle = realInterval(callback, delay, ...args);
			intervals.push({ callback: callback as () => void, handle });
			return handle;
		});
	await app.ready();
	await settle();
	intervalSpy.mockRestore();
	state.armed = true;
	const scheduler = kind === "auto-tag" ? app.autoTagScheduler : app.labelSyncScheduler;
	return {
		app,
		scheduler,
		state,
		counts,
		order,
		results,
		rows,
		intervals,
		jobId: kind === "auto-tag" ? JOB_ID.autoTag : JOB_ID.labelSync,
		fire: () => intervals[0]?.callback(),
		close() {
			let resolved = false;
			const promise = app.close().then(() => {
				resolved = true;
			});
			return { promise, resolved: () => resolved };
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	boundary.autoTag.mockReset();
	boundary.labelSync.mockReset();
	boundary.reconcile.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	for (const app of apps.splice(0)) await app.close();
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe.each<Kind>(["auto-tag", "label-sync"])(
	"%s accepted work and terminal shutdown",
	(kind) => {
		const phases: Phase[] =
			kind === "auto-tag"
				? ["rules", "execute", "save", "failure-save"]
				: ["reconcile", "rules", "execute", "save", "failure-save", "saved-read"];
		for (const origin of ["startup", "interval"] as const) {
			for (const phase of phases) {
				for (const reject of [false, true]) {
					it(`drains ${origin} ${phase} ${reject ? "rejection" : "completion"} before teardown`, async () => {
						const gate = deferred();
						const f = await boot(kind, {
							origin,
							hold: {
								phase,
								gate: gate.promise,
								reject,
								call: origin === "interval" && ["rules", "reconcile"].includes(phase) ? 2 : 1,
							},
							executionFails: phase === "failure-save",
						});
						if (origin === "interval") {
							f.fire();
							await settle();
						}
						expect(f.state.pending).toBe(1);
						await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toThrow(
							/maintenance/i,
						);
						const close = f.close();
						await settle();
						expect(close.resolved()).toBe(false);
						expect(f.state.teardown).toBe(false);
						const counts = new Map(f.counts);
						f.fire();
						f.scheduler.start();
						await settle();
						expect(f.counts).toEqual(counts);
						gate.resolve();
						await close.promise;
						await settle();
						expect(f.state).toMatchObject({ pending: 0, afterTeardown: 0, pendingAtTeardown: 0 });
						await expect(
							withCleanupMaintenanceGuard(async () => undefined),
						).resolves.toBeUndefined();
					});
				}
			}
		}
		it("closes admission while a later plugin is still in preClose", async () => {
			const gate = deferred();
			const f = await boot(kind, { preClose: gate.promise, rows: 0 });
			const counts = new Map(f.counts);
			const close = f.close();
			await settle();
			f.fire();
			f.scheduler.start();
			await settle();
			expect(f.counts).toEqual(counts);
			expect(close.resolved()).toBe(false);
			gate.resolve();
			await close.promise;
		});
		it("does not admit a retained callback or restart after final close", async () => {
			const f = await boot(kind, { rows: 0 });
			await f.app.close();
			const counts = new Map(f.counts);
			f.fire();
			f.scheduler.start();
			await settle();
			expect(f.counts).toEqual(counts);
			expect(f.state.afterTeardown).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});
		it("preserves normal stop/start but invalidates the previous interval", async () => {
			const f = await boot(kind, { rows: 0 });
			const counts = new Map(f.counts);
			f.scheduler.stop();
			f.fire();
			await settle();
			expect(f.counts).toEqual(counts);
			f.scheduler.start();
			await settle();
			expect(f.counts.get("rules")).toBe(2);
			f.fire();
			await settle();
			expect(f.counts.get("rules")).toBe(2);
			await vi.advanceTimersByTimeAsync(300_000);
			await settle();
			expect(f.counts.get("rules")).toBe(3);
		});
		it("does not duplicate initial work or timers when start is repeated", async () => {
			const f = await boot(kind, { rows: 0 });
			f.scheduler.start();
			f.scheduler.start();
			await settle();
			expect(f.counts.get("rules")).toBe(1);
			expect(vi.getTimerCount()).toBe(1);
		});
		it("suppresses overlapping callbacks until the accepted lookup settles", async () => {
			const gate = deferred();
			const f = await boot(kind, { hold: { phase: "rules", gate: gate.promise } });
			f.fire();
			f.fire();
			await settle();
			expect(f.counts.get("rules")).toBe(1);
			gate.resolve();
			await settle();
			f.fire();
			await settle();
			expect(f.counts.get("rules")).toBe(2);
		});
		it("retains a tick accepted before its registry wrapper starts the body", async () => {
			const gate = deferred();
			const f = await boot(kind, { wrapperGate: gate.promise });
			expect(f.counts.size).toBe(0);
			const close = f.close();
			await settle();
			expect(close.resolved()).toBe(false);
			f.fire();
			gate.resolve();
			await close.promise;
			expect(f.counts.get("rules")).toBe(1);
			expect(f.results).toHaveLength(1);
			expect(f.state.afterTeardown).toBe(0);
		});
		it("releases a rejected lookup so the next scheduled tick can recover", async () => {
			const gate = deferred();
			const f = await boot(kind, { hold: { phase: "rules", gate: gate.promise, reject: true } });
			gate.resolve();
			await settle();
			expect(f.app.schedulerRegistry.getStatus(f.jobId)).toMatchObject({ totalFailures: 1 });
			await expect(withCleanupMaintenanceGuard(async () => undefined)).resolves.toBeUndefined();
			f.fire();
			await settle();
			expect(f.results).toHaveLength(1);
			expect(f.app.schedulerRegistry.getStatus(f.jobId)).toMatchObject({ consecutiveFailures: 0 });
		});
		it("keeps a maintenance-denied tick neutral and resumes after maintenance", async () => {
			const f = await boot(kind, { rows: 0 });
			const before = f.app.schedulerRegistry.getStatus(f.jobId);
			await withCleanupMaintenanceGuard(async () => {
				f.fire();
				await settle();
				expect(f.counts.get("rules")).toBe(1);
				expect(f.app.schedulerRegistry.getStatus(f.jobId)).toEqual(before);
			});
			f.fire();
			await settle();
			expect(f.counts.get("rules")).toBe(2);
		});
		it("retains init-failure observability without arming a timer", async () => {
			const f = await boot(kind, { initFails: true });
			expect(f.app.schedulerRegistry.getStatus(f.jobId)).toMatchObject({
				disabled: true,
				totalRuns: 0,
			});
			expect(f.counts.size).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
			await f.app.close();
		});
		for (const result of ["success", "partial", "failed"] as const) {
			it(`retains both owners' ${result} bookkeeping through close`, async () => {
				const gate = deferred();
				const f = await boot(kind, {
					rows: 2,
					result,
					hold: { phase: "execute", gate: gate.promise },
				});
				const close = f.close();
				await settle();
				gate.resolve();
				await close.promise;
				expect(f.results.map((row) => [row.userId, row.lastRunStatus])).toEqual([
					["owner-a", result],
					["owner-b", result],
				]);
				expect(f.state).toMatchObject({ sends: 2, afterTeardown: 0 });
			});
		}
		it("retains retry/failure recording after result-save failure", async () => {
			const gate = deferred();
			const f = await boot(kind, { saveFails: true, hold: { phase: "save", gate: gate.promise } });
			const close = f.close();
			await settle();
			gate.resolve();
			await close.promise;
			expect(f.results).toHaveLength(1);
			expect(f.results[0]).toMatchObject({
				lastRunStatus: kind === "auto-tag" ? "partial" : "failed",
			});
			if (kind === "auto-tag") expect(f.results[0]?.lastRunAt).toBeNull();
			expect(f.state).toMatchObject({ sends: 1, afterTeardown: 0 });
		});
	},
);

describe("label-sync accepted reconciliation and guarded persistence", () => {
	it("continues rule execution and persistence after reconciliation fails during close", async () => {
		const gate = deferred();
		const f = await boot("label-sync", {
			reconcileFails: true,
			hold: { phase: "reconcile", gate: gate.promise },
		});
		const close = f.close();
		await settle();
		gate.resolve();
		await close.promise;
		expect(f.order).toEqual(["reconcile", "rules", "execute", "save", "saved-read"]);
		expect(f.results[0]).toMatchObject({ lastRunStatus: "success" });
		expect(f.state.afterTeardown).toBe(0);
	});
	it("does not claim a saved result after the accepted rule version changes", async () => {
		const gate = deferred();
		const f = await boot("label-sync", {
			changedRule: true,
			hold: { phase: "save", gate: gate.promise },
		});
		const close = f.close();
		await settle();
		gate.resolve();
		await close.promise;
		expect(f.results).toEqual([]);
		expect(f.counts.has("saved-read")).toBe(false);
		expect(f.state.afterTeardown).toBe(0);
	});
});

it("preserves auto-tag's real per-rule lock when a manual run already owns the rule", async () => {
	const gate = deferred();
	const started = deferred();
	const manual = runRuleWithLock("rule-0", async () => {
		started.resolve();
		await gate.promise;
	});
	await started.promise;
	const f = await boot("auto-tag");
	await f.app.close();
	expect(f.counts.has("execute")).toBe(false);
	expect(f.results).toEqual([]);
	gate.resolve();
	await manual;
});
