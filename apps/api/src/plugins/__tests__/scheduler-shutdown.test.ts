import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_HUNT_DURATION_MS } from "../../lib/hunting/constants.js";
import { getHuntingScheduler } from "../../lib/hunting/scheduler.js";
import { MAX_CLEAN_DURATION_MS } from "../../lib/queue-cleaner/constants.js";
import { getQueueCleanerScheduler } from "../../lib/queue-cleaner/scheduler.js";
import huntingPlugin from "../hunting-scheduler.js";
import queueCleanerPlugin from "../queue-cleaner-scheduler.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import { installRuntimeFixture } from "./runtime-fixture.js";

const executors = vi.hoisted(() => ({
	hunt: vi.fn(),
	clean: vi.fn(),
	preview: vi.fn(),
}));
vi.mock("../../lib/hunting/hunt-executor.js", () => ({
	executeHuntWithSdk: executors.hunt,
}));
vi.mock("../../lib/queue-cleaner/cleaner-executor.js", () => ({
	executeQueueCleaner: executors.clean,
	executeEnhancedPreview: executors.preview,
}));

const huntResult = {
	itemsSearched: 1,
	itemsGrabbed: 0,
	searchedItems: [],
	grabbedItems: [],
	message: "Synthetic completion",
	status: "completed",
	apiCallsMade: 1,
};
const cleanResult = {
	itemsCleaned: 1,
	itemsSkipped: 0,
	itemsWarned: 0,
	cleanedItems: [],
	skippedItems: [],
	warnedItems: [],
	isDryRun: false,
	status: "success",
	message: "Synthetic completion",
};

type Kind = "hunting" | "queue-cleaner";
let app: FastifyInstance | undefined;
let releaseGates: Array<() => void> = [];
let sequence = 0;

function deferred<T>(fallback: T) {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	releaseGates.push(() => resolve(fallback));
	return { promise, resolve, reject };
}

async function settle() {
	await vi.advanceTimersByTimeAsync(0);
}

async function boot(
	kind: Kind,
	options: {
		startup?: Promise<unknown[]>;
		failAfterInit?: boolean;
		automatic?: boolean;
		both?: boolean;
	} = {},
) {
	const instance = {
		id: `shutdown-instance-${++sequence}`,
		label: "Synthetic instance",
		service: "RADARR",
		userId: "synthetic-user",
	};
	const config = {
		id: `config-${sequence}`,
		instanceId: instance.id,
		instance,
		dryRunMode: false,
		huntMissingEnabled: true,
		huntUpgradesEnabled: true,
		missingIntervalMins: 15,
		upgradeIntervalMins: 30,
		apiCallsThisHour: 0,
		hourlyApiCap: 100,
		apiCallsResetAt: new Date(Date.now() + 60 * 60 * 1000),
		intervalMins: 15,
	};
	const configModel = {
		count: vi.fn().mockResolvedValue(options.automatic ? 1 : 0),
		findUnique: vi.fn().mockResolvedValue(config),
		findMany: vi.fn().mockResolvedValue([]),
		update: vi.fn().mockResolvedValue({}),
	};
	const logModel = {
		findMany: vi.fn().mockReturnValue(options.startup ?? Promise.resolve([])),
		updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		create: vi.fn().mockResolvedValue({ id: `log-${sequence}` }),
		update: vi.fn().mockResolvedValue({}),
	};
	const notify = vi.fn().mockResolvedValue(undefined);
	const tx = { queueCleanerLog: logModel, queueCleanerConfig: configModel };
	const prisma = {
		huntConfig: configModel,
		huntLog: logModel,
		queueCleanerConfig: configModel,
		queueCleanerLog: logModel,
		queueCleanerStrike: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		$transaction: vi.fn((work: (client: typeof tx) => Promise<void>) => work(tx)),
	};
	let disconnected = false;
	app = Fastify({ logger: false });
	await installRuntimeFixture(app);
	await app.register(
		fp(
			async (server) => {
				server.decorate("prisma", prisma as never);
				// Mirror the synthetic application persistence boundary's close ordering.
				server.addHook("onClose", async () => {
					disconnected = true;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(schedulerRegistryPlugin);
	// This fixture isolates scheduler draining; the real producer admission contract
	// is exercised with the actual service in hunting-notification-shutdown.test.ts.
	await app.register(
		fp(
			async (server) => {
				server.decorate("notificationService", {
					notify,
					runProducer: <T>(work: () => Promise<T>) => work(),
				} as never);
			},
			{ name: "notification-service" },
		),
	);
	if (options.failAfterInit) {
		if (kind === "hunting")
			configModel.count.mockRejectedValue(new Error("Synthetic init failure"));
		else
			vi.spyOn(getQueueCleanerScheduler(), "setTrackTick").mockImplementation(() => {
				throw new Error("Synthetic init failure");
			});
	}
	if (options.both) {
		await app.register(huntingPlugin);
		await app.register(queueCleanerPlugin);
	} else await app.register(kind === "hunting" ? huntingPlugin : queueCleanerPlugin);
	let readySettled = false;
	const ready = app.ready().then(() => {
		if (!options.automatic) {
			(kind === "hunting" ? getHuntingScheduler() : getQueueCleanerScheduler()).stop();
			if (options.both) getHuntingScheduler().stop();
		}
		readySettled = true;
	});
	if (options.startup) {
		// Required local recovery now belongs to readiness, not detached timer work.
		await settle();
		expect(logModel.findMany).toHaveBeenCalledTimes(1);
		expect(readySettled).toBe(false);
	} else await ready;
	const scheduler = kind === "hunting" ? getHuntingScheduler() : getQueueCleanerScheduler();
	await settle();
	return {
		app,
		scheduler,
		instance,
		config,
		configModel,
		logModel,
		notify,
		ready,
		disconnected: () => disconnected,
		async trigger(id = instance.id) {
			if (kind === "hunting") {
				const result = getHuntingScheduler().triggerManualHunt(id, "missing");
				return { accepted: result.queued, message: result.message };
			}
			const result = await getQueueCleanerScheduler().triggerManualClean(id);
			return { accepted: result.triggered, message: result.message };
		},
		close() {
			let settled = false;
			const promise = this.app.close().then(() => {
				settled = true;
			});
			return { promise, settled: () => settled };
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	releaseGates = [];
	executors.hunt.mockReset().mockResolvedValue(huntResult);
	executors.clean.mockReset().mockResolvedValue(cleanResult);
	executors.preview.mockReset().mockResolvedValue({ instanceReachable: true });
});

afterEach(async () => {
	// Unblock all synthetic work even when a RED assertion throws.
	for (const release of releaseGates) release();
	getHuntingScheduler().stop();
	getQueueCleanerScheduler().stop();
	await settle();
	await app?.close();
	app = undefined;
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe.each<Kind>(["hunting", "queue-cleaner"])("%s terminal shutdown", (kind) => {
	it("shares one terminal drain and permits a new lifecycle only after settlement", async () => {
		const startup = deferred<unknown[]>([]);
		const fixture = await boot(kind, { startup: startup.promise });
		const drain = fixture.scheduler.shutdown();
		expect(fixture.scheduler.shutdown()).toBe(drain);
		expect(() => fixture.scheduler.initialize(fixture.app)).toThrow(/shutting down/);
		startup.resolve([]);
		await fixture.ready;
		await drain;
		await fixture.app.close();
		const next = await boot(kind);
		await expect(next.trigger()).resolves.toMatchObject({ accepted: true });
		await next.app.close();
	});

	it("waits for startup reaping before the database close hook, even with no timer", async () => {
		const startup = deferred<unknown[]>([{ id: "synthetic-stuck-log" }]);
		const fixture = await boot(kind, { startup: startup.promise });
		expect(fixture.scheduler.isRunning()).toBe(false);
		const closing = fixture.close();
		await settle();
		expect(closing.settled()).toBe(false);
		expect(fixture.disconnected()).toBe(false);
		startup.resolve([{ id: "synthetic-stuck-log" }]);
		await fixture.ready;
		await closing.promise;
		expect(fixture.logModel.updateMany).toHaveBeenCalledTimes(1);
		expect(fixture.disconnected()).toBe(true);
	});

	it("drains startup work after a later initialization step disables the feature", async () => {
		const startup = deferred<unknown[]>([]);
		const fixture = await boot(kind, { startup: startup.promise, failAfterInit: true });
		expect(
			kind === "hunting" ? fixture.app.huntingSchedulerEnabled : fixture.app.queueCleanerEnabled,
		).toBe(false);
		const closing = fixture.close();
		await settle();
		expect(closing.settled()).toBe(false);
		expect(fixture.disconnected()).toBe(false);
		startup.resolve([]);
		await fixture.ready;
		expect(
			kind === "hunting" ? fixture.app.huntingSchedulerEnabled : fixture.app.queueCleanerEnabled,
		).toBe(false);
		await closing.promise;
	});

	it("keeps ordinary stop manual-capable, then drains admitted lookup and final bookkeeping", async () => {
		const fixture = await boot(kind);
		const lookup = deferred(fixture.config);
		const notification = deferred<void>(undefined);
		fixture.configModel.findUnique.mockReturnValue(lookup.promise);
		fixture.notify.mockReturnValue(notification.promise);
		await expect(fixture.trigger()).resolves.toMatchObject({ accepted: true });
		const closing = fixture.close();
		await settle();
		expect(closing.settled()).toBe(false);
		await expect(fixture.trigger("new-after-shutdown")).resolves.toMatchObject({
			accepted: false,
			message: expect.stringContaining("shutting down"),
		});
		// Already-admitted work may finish; its late bookkeeping is also part of the drain.
		lookup.resolve(fixture.config);
		await settle();
		expect(kind === "hunting" ? executors.hunt : executors.clean).toHaveBeenCalledTimes(1);
		expect(fixture.notify).toHaveBeenCalledTimes(1);
		expect(closing.settled()).toBe(false);
		expect(fixture.disconnected()).toBe(false);
		notification.resolve();
		await closing.promise;
		expect(fixture.configModel.update).toHaveBeenCalledTimes(1);
		fixture.scheduler.start(fixture.app);
		expect(fixture.scheduler.isRunning()).toBe(false);
	});

	it("does not equate an executor timeout with physical settlement", async () => {
		const fixture = await boot(kind);
		const execution = deferred(kind === "hunting" ? huntResult : cleanResult);
		(kind === "hunting" ? executors.hunt : executors.clean).mockReturnValue(execution.promise);
		await fixture.trigger();
		await settle();
		await vi.advanceTimersByTimeAsync(
			(kind === "hunting" ? MAX_HUNT_DURATION_MS : MAX_CLEAN_DURATION_MS) + 1,
		);
		expect(fixture.logModel.update).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "error" }) }),
		);
		const closing = fixture.close();
		await settle();
		expect(closing.settled()).toBe(false);
		expect(fixture.disconnected()).toBe(false);
		expect(() => fixture.scheduler.initialize(fixture.app)).toThrow(/shutting down/);
		// Rejection is genuine settlement too; no late unhandled rejection or false success.
		execution.reject(new Error("Synthetic late executor failure"));
		await closing.promise;
	});

	it("finishes a pending scheduled lookup without admitting its next executor", async () => {
		const fixture = await boot(kind, { automatic: true });
		const scheduledLookup = deferred([fixture.config]);
		fixture.configModel.findMany.mockImplementation((query) => {
			if (kind === "hunting" && query.select) return Promise.resolve([]);
			if (kind === "queue-cleaner" && query.select) return Promise.resolve([]);
			return scheduledLookup.promise;
		});
		await vi.advanceTimersByTimeAsync(60 * 1000);
		expect(fixture.configModel.findMany).toHaveBeenCalled();
		const closing = fixture.close();
		await settle();
		expect(closing.settled()).toBe(false);
		scheduledLookup.resolve([fixture.config]);
		await closing.promise;
		await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
		expect(kind === "hunting" ? executors.hunt : executors.clean).not.toHaveBeenCalled();
	});

	it("awaits a queued tick wrapper but does not start its body after shutdown", async () => {
		const fixture = await boot(kind, { automatic: true });
		const wrapper = deferred<void>(undefined);
		fixture.scheduler.setTrackTick((work) => wrapper.promise.then(work));
		await vi.advanceTimersByTimeAsync(60 * 1000);
		const closing = fixture.close();
		await settle();
		expect(closing.settled()).toBe(false);
		wrapper.resolve();
		await closing.promise;
		expect(fixture.configModel.findMany).not.toHaveBeenCalled();
	});
});

it("closes both schedulers' admission before awaiting either plugin drain", async () => {
	const fixture = await boot("queue-cleaner", { both: true });
	const execution = deferred(cleanResult);
	executors.clean.mockReturnValue(execution.promise);
	await fixture.trigger();
	await settle();
	const closing = fixture.close();
	await settle();
	expect(closing.settled()).toBe(false);
	expect(getHuntingScheduler().triggerManualHunt("during-sibling-drain", "missing")).toMatchObject({
		queued: false,
		message: expect.stringContaining("shutting down"),
	});
	execution.resolve(cleanResult);
	await closing.promise;
});

describe("queue cleaner read-only work at shutdown", () => {
	it("includes the queued manual failure ledger and lease release in its drain", async () => {
		const fixture = await boot("queue-cleaner");
		const ledger = deferred({ id: "synthetic-failure-log" });
		fixture.configModel.findUnique.mockRejectedValue(new Error("Synthetic lookup failure"));
		fixture.logModel.create.mockReturnValue(ledger.promise);
		await fixture.trigger();
		await settle();
		expect(fixture.logModel.create).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ status: "error" }) }),
		);
		const closing = fixture.close();
		await settle();
		expect(closing.settled()).toBe(false);
		expect(fixture.disconnected()).toBe(false);
		ledger.resolve({ id: "synthetic-failure-log" });
		await closing.promise;
		expect(executors.clean).not.toHaveBeenCalled();
	});

	it.each(["dry-run", "enhanced-preview"])(
		"tracks uncancelled %s work after timeout",
		async (kind) => {
			const fixture = await boot("queue-cleaner");
			const execution = deferred(kind === "dry-run" ? cleanResult : { instanceReachable: true });
			(kind === "dry-run" ? executors.clean : executors.preview).mockReturnValue(execution.promise);
			const scheduler = getQueueCleanerScheduler();
			const run =
				kind === "dry-run"
					? scheduler.triggerDryRun(fixture.instance.id)
					: scheduler.triggerEnhancedPreview(fixture.instance.id);
			const timedOut = expect(run).rejects.toThrow(/timed out/);
			await vi.advanceTimersByTimeAsync(MAX_CLEAN_DURATION_MS + 1);
			await timedOut;
			const closing = fixture.close();
			await settle();
			expect(closing.settled()).toBe(false);
			await expect(
				kind === "dry-run"
					? scheduler.triggerDryRun("new-after-shutdown")
					: scheduler.triggerEnhancedPreview("new-after-shutdown"),
			).rejects.toMatchObject({ statusCode: 503 });
			execution.reject(new Error("Synthetic late read failure"));
			await closing.promise;
			expect(fixture.logModel.create).not.toHaveBeenCalled();
		},
	);
});
