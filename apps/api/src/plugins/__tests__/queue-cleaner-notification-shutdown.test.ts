import { performance } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import { withCleanupMaintenanceGuard } from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import {
	MANUAL_CLEAN_COOLDOWN_MINS,
	MAX_CLEAN_DURATION_MS,
	SCHEDULER_TICK_MS,
} from "../../lib/queue-cleaner/constants.js";
import { getQueueCleanerScheduler } from "../../lib/queue-cleaner/scheduler.js";
import notificationPlugin from "../notification-service.js";
import queuePlugin from "../queue-cleaner-scheduler.js";
import registryPlugin from "../scheduler-registry.js";

// Exercise the real job/notification lifetimes. Provider execution and outbound
// transport are the only substituted behavior; no provider action is performed.
const executors = vi.hoisted(() => ({ clean: vi.fn(), preview: vi.fn() }));
vi.mock("../../lib/queue-cleaner/cleaner-executor.js", () => ({
	executeQueueCleaner: executors.clean,
	executeEnhancedPreview: executors.preview,
}));
type Origin = "manual" | "scheduled";
type Outcome = "removed" | "warned" | "both" | "throw" | "empty";
type Phase =
	| "startup"
	| "lookup"
	| "executor"
	| "result"
	| "bookkeeping"
	| "subscription"
	| "send"
	| "log"
	| "channel";
const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];
type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;
const natives: NativeFixture[] = [];
const ownedRows = new Map<
	NativeFixture,
	{
		instances: Array<{ id: string; userId: string }>;
		configs: Array<{ id: string; instanceId: string; userId: string }>;
		logs: Array<{ id: string; instanceId: string; userId: string }>;
		channels: Array<{ id: string; userId: string }>;
		subscriptions: Array<{ eventType: string; channelId: string; userId: string }>;
	}
>();
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
async function waitForNative(observation: () => boolean) {
	const deadline = performance.now() + 4_000;
	while (!observation()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}
async function boot(
	options: {
		origin?: Origin;
		outcome?: Outcome;
		dryRun?: boolean;
		operation?: "dry-run" | "preview";
		stale?: boolean;
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean };
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	natives.push(native);
	const owned = {
		instances: [],
		configs: [],
		logs: [],
		channels: [],
		subscriptions: [],
	} as NonNullable<ReturnType<typeof ownedRows.get>>;
	ownedRows.set(native, owned);
	const other = await native.createOwner();
	const owner = native.userId;
	const channelId = native.channelId;
	const allowedEvents = [
		"QUEUE_ITEMS_REMOVED",
		"QUEUE_STRIKES_ISSUED",
		"QUEUE_CLEANER_FAILED",
	] as const;
	let instance!: Awaited<ReturnType<typeof native.prisma.serviceInstance.create>>;
	let config!: Awaited<ReturnType<typeof native.prisma.queueCleanerConfig.create>> & {
		instance: typeof instance;
	};
	let staleId: string | undefined;
	await native.run(async () => {
		for (const selected of [{ userId: owner, channelId }, other]) {
			const encrypted = native.encryptor.encrypt(
				JSON.stringify({
					webhookUrl: `https://example.invalid/synthetic-worker/${selected.userId}`,
				}),
			);
			await native.prisma.notificationChannel.updateMany({
				where: { id: selected.channelId, userId: selected.userId },
				data: {
					name: "Same synthetic channel",
					encryptedConfig: encrypted.value,
					configIv: encrypted.iv,
				},
			});
			owned.channels.push({ id: selected.channelId, userId: selected.userId });
			for (const eventType of allowedEvents) {
				const row = await native.prisma.notificationSubscription.create({
					data: { channelId: selected.channelId, eventType },
				});
				owned.subscriptions.push({
					eventType: row.eventType,
					channelId: selected.channelId,
					userId: selected.userId,
				});
			}
			const key = native.encryptor.encrypt("synthetic-provider-key");
			const row = await native.prisma.serviceInstance.create({
				data: {
					userId: selected.userId,
					service: "RADARR",
					label: "Same synthetic label",
					baseUrl: "https://example.invalid/synthetic-provider",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
			owned.instances.push({ id: row.id, userId: selected.userId });
			const cfg = await native.prisma.queueCleanerConfig.create({
				data: {
					instanceId: row.id,
					enabled: selected.userId === owner,
					dryRunMode: options.dryRun ?? false,
					intervalMins: 15,
					strikeSystemEnabled: false,
				},
			});
			owned.configs.push({ id: cfg.id, instanceId: row.id, userId: selected.userId });
			if (selected.userId === owner) {
				instance = row;
				config = { ...cfg, instance: row };
			} else {
				const foreign = await native.prisma.queueCleanerLog.create({
					data: {
						instanceId: row.id,
						status: "success",
						message: "Foreign owner control",
						completedAt: new Date(),
					},
				});
				owned.logs.push({ id: foreign.id, instanceId: row.id, userId: selected.userId });
			}
			await native.prisma.queueCleanerStrike.create({
				data: {
					instanceId: row.id,
					downloadId: "synthetic-download",
					downloadTitle: "Synthetic title",
					lastRule: "failed",
					lastReason: "Synthetic reason",
				},
			});
		}
		if (options.stale) {
			const row = await native.prisma.queueCleanerLog.create({
				data: { instanceId: instance.id, status: "running" },
			});
			staleId = row.id;
			owned.logs.push({ id: row.id, instanceId: instance.id, userId: owner });
		}
	});
	const id = instance.id;
	const counts: Record<Phase, number> = {
		startup: 0,
		lookup: 0,
		executor: 0,
		result: 0,
		bookkeeping: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
	};
	const state = { pending: 0, disconnected: false, afterTeardown: 0, readySettled: false };
	let held = false;
	const pause = async (phase: Phase) => {
		counts[phase]++;
		if (state.disconnected) state.afterTeardown++;
		state.pending++;
		try {
			if (options.hold?.phase === phase && !held) {
				held = true;
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic boundary unavailable");
			}
		} finally {
			if (state.disconnected) state.afterTeardown++;
			state.pending--;
		}
	};
	const sent: Array<{ eventType: string; owner: string }> = [];
	const logs: string[] = [],
		outcomes: string[] = [];
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		async (type, recipient, payload) => {
			expect(type).toBe("DISCORD");
			expect(recipient.webhookUrl).toBe(`https://example.invalid/synthetic-worker/${owner}`);
			expect(allowedEvents).toContain(payload.eventType);
			sent.push({ eventType: payload.eventType, owner });
			await pause("send");
			return { success: true, retryable: false };
		},
	);
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime);
	const prisma = client.prisma;
	const configModel = prisma.queueCleanerConfig;
	vi.spyOn(configModel, "update");
	vi.spyOn(prisma.queueCleanerStrike, "deleteMany");
	const logModel = prisma.queueCleanerLog;
	const lookup = configModel.findUnique.bind(configModel);
	let observedConfig = config;
	const configReads: { findUnique: AwaitOnly<typeof configModel.findUnique> } = configModel;
	vi.spyOn(configReads, "findUnique").mockImplementation(async (args) => {
		expect(args).toEqual({ where: { instanceId: id }, include: { instance: true } });
		const row = await lookup({ ...args, include: { instance: true } });
		expect(row).toMatchObject({
			id: config.id,
			instanceId: id,
			instance,
			enabled: true,
			dryRunMode: config.dryRunMode,
		});
		if (!row) throw new Error("Owned Queue Cleaner config missing");
		observedConfig = row;
		await pause("lookup");
		return row;
	});
	const startupRead = logModel.findMany.bind(logModel);
	const startupReads: { findMany: AwaitOnly<typeof logModel.findMany> } = logModel;
	vi.spyOn(startupReads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({ where: { status: "running" } });
		const rows = await startupRead(args);
		expect(rows.map((row) => row.id)).toEqual(staleId ? [staleId] : []);
		await pause("startup");
		return rows;
	});
	const create = logModel.create.bind(logModel);
	const jobCreates: { create: AwaitOnly<typeof logModel.create> } = logModel;
	vi.spyOn(jobCreates, "create").mockImplementation(async (args) => {
		expect(args.data).toEqual({
			instanceId: id,
			status: "running",
			isDryRun: options.dryRun ?? false,
		});
		const row = await create(args);
		owned.logs.push({ id: row.id, instanceId: id, userId: owner });
		return row;
	});
	const update = logModel.update.bind(logModel);
	const jobWrites: { update: AwaitOnly<typeof logModel.update> } = logModel;
	vi.spyOn(jobWrites, "update").mockImplementation(async (args) => {
		expect(owned.logs.map((row) => row.id)).toContain(args.where.id);
		const row = await update(args);
		outcomes.push(row.status);
		await pause("result");
		return row;
	});
	const subscriptionRead = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptions: { findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany> } =
		prisma.notificationSubscription;
	vi.spyOn(subscriptions, "findMany").mockImplementation(async (args) => {
		expect(args?.where?.channel).toEqual({ userId: owner });
		expect(allowedEvents).toContain(args?.where?.eventType);
		const rows = await subscriptionRead({ ...args, include: { channel: true } });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.channelId).toBe(channelId);
		expect(rows[0]?.channel.userId).toBe(owner);
		await pause("subscription");
		return rows;
	});
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation, transactionOptions) =>
		transaction(async (tx) => {
			const resultWrite = tx.queueCleanerLog.update.bind(tx.queueCleanerLog);
			const results: { update: AwaitOnly<typeof tx.queueCleanerLog.update> } = tx.queueCleanerLog;
			vi.spyOn(results, "update").mockImplementation(async (args) => {
				expect(owned.logs.map((row) => row.id)).toContain(args.where.id);
				const row = await resultWrite(args);
				outcomes.push(row.status);
				await pause("result");
				return row;
			});
			const bookkeepingWrite = tx.queueCleanerConfig.update.bind(tx.queueCleanerConfig);
			const bookkeeping: { update: AwaitOnly<typeof tx.queueCleanerConfig.update> } =
				tx.queueCleanerConfig;
			vi.spyOn(bookkeeping, "update").mockImplementation(async (args) => {
				expect(args.where).toEqual({ instanceId: id });
				const row = await bookkeepingWrite(args);
				await pause("bookkeeping");
				return row;
			});
			const historyWrite = tx.notificationLog.create.bind(tx.notificationLog);
			const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
			vi.spyOn(history, "create").mockImplementation(async (args) => {
				expect(args.data.channelId).toBe(channelId);
				const row = await historyWrite(args);
				logs.push(row.status);
				await pause("log");
				return row;
			});
			const channelWrite = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const channels: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(channels, "updateMany").mockImplementation(async (args) => {
				expect(args.where?.id).toBe(channelId);
				expect(args.where?.userId).toBe(owner);
				const row = await channelWrite(args);
				if (args.data.lastSendResult !== undefined) await pause("channel");
				return row;
			});
			return operation(tx);
		}, transactionOptions),
	);
	const result = {
		itemsCleaned: options.outcome === "removed" || options.outcome === "both" ? 1 : 0,
		itemsWarned: options.outcome === "warned" || options.outcome === "both" ? 1 : 0,
		itemsSkipped: 0,
		cleanedItems: [],
		warnedItems: [],
		skippedItems: [],
		isDryRun: options.dryRun ?? false,
		status: "success",
		message: "Synthetic outcome",
	};
	executors.clean.mockImplementation(async (_app, selectedInstance, selectedConfig) => {
		expect(selectedInstance).toEqual(instance);
		expect(selectedConfig).toEqual({
			...observedConfig,
			dryRunMode: options.operation === "dry-run" ? true : config.dryRunMode,
		});
		await pause("executor");
		if (options.outcome === "throw") throw new Error("Synthetic cleaner unavailable");
		return { ...result, isDryRun: selectedConfig.dryRunMode };
	});
	const preview = {
		instanceId: id,
		instanceLabel: instance.label,
		instanceService: "radarr",
		instanceReachable: true,
		queueSummary: {
			totalItems: 0,
			downloading: 0,
			paused: 0,
			queued: 0,
			seeding: 0,
			importPending: 0,
			failed: 0,
		},
		wouldRemove: 0,
		wouldImport: 0,
		wouldWarn: 0,
		wouldSkip: 0,
		previewItems: [],
		ruleSummary: {},
		previewGeneratedAt: new Date().toISOString(),
		configSnapshot: {
			dryRunMode: true,
			strikeSystemEnabled: false,
			maxStrikes: 3,
			maxRemovalsPerRun: 10,
		},
	};
	executors.preview.mockImplementation(async (_app, selectedInstance, selectedConfig) => {
		expect(selectedInstance).toEqual(instance);
		expect(selectedConfig).toEqual(config);
		await pause("executor");
		return preview;
	});

	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("prisma", prisma);
	app.decorate("encryptor", native.encryptor);
	app.decorate("config", { APP_URL: "https://synthetic.invalid" } as never);
	app.decorate("arrClientFactory", {
		create() {
			throw new Error("Fixture forbids provider access");
		},
	} as never);
	await app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					expect(state.pending).toBe(0);
					await client.close();
					state.disconnected = true;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => {}, { name: "security" }));
	registerRestoreBootstrapPlugin(app, notificationPlugin);
	registerRestoreBootstrapPlugin(app, registryPlugin);
	await app.after();
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = track(...args);
		tasks.push(task.catch(() => undefined));
		return task;
	});
	const intervals = vi.spyOn(globalThis, "setInterval");
	// Match production: local stale-log recovery is required starting work.
	registerRestoreBootstrapPlugin(app, queuePlugin);
	await app.after();
	registerRestoreRuntimeActivation(app);
	const preClosed = deferred();
	app.addHook("preClose", async () => preClosed.resolve());
	const ready = Promise.resolve(app.ready()).finally(() => {
		state.readySettled = true;
	});
	tasks.push(ready.catch(() => undefined));
	if (options.hold?.phase === "startup") expect(await waitForNative(() => held)).toBe(true);
	else {
		expect(await waitForNative(() => state.readySettled)).toBe(true);
		await ready;
	}
	const scheduler = getQueueCleanerScheduler();
	const timer = [...intervals.mock.calls].reverse().find(([, ms]) => ms === SCHEDULER_TICK_MS)?.[0];
	if (options.origin !== "scheduled") scheduler.stop();
	const pending = () =>
		(scheduler as unknown as { pendingWork: Set<Promise<unknown>> }).pendingWork;
	const idle = async () => {
		expect(await waitForNative(() => pending().size === 0)).toBe(true);
		await app.notificationService.drain();
	};
	if (options.hold?.phase !== "startup") await idle();
	const outcome = async () =>
		native.run(async () => ({
			config: await native.prisma.queueCleanerConfig.findUniqueOrThrow({
				where: { instanceId: id },
			}),
			jobs: await native.prisma.queueCleanerLog.findMany({
				where: { instanceId: id },
				orderBy: { startedAt: "asc" },
			}),
			strikes: await native.prisma.queueCleanerStrike.findMany({
				where: { instanceId: { in: owned.instances.map((row) => row.id) } },
				orderBy: { id: "asc" },
			}),
			events: await native.prisma.notificationOutboxEvent.findMany({
				where: { userId: owner },
				orderBy: { acceptedAt: "asc" },
			}),
			deliveries: await native.prisma.notificationOutboxDelivery.findMany({
				where: { userId: owner },
				orderBy: { createdAt: "asc" },
			}),
			history: await native.prisma.notificationLog.findMany({
				where: { channelId },
				orderBy: { sentAt: "asc" },
			}),
			channel: await native.prisma.notificationChannel.findFirstOrThrow({
				where: { id: channelId, userId: owner },
			}),
			foreignConfig: await native.prisma.queueCleanerConfig.findUniqueOrThrow({
				where: { instanceId: owned.instances[1]!.id },
			}),
			foreignLogs: await native.prisma.queueCleanerLog.findMany({
				where: { instanceId: owned.instances[1]!.id },
			}),
			foreignEvents: await native.prisma.notificationOutboxEvent.findMany({
				where: { userId: other.userId },
			}),
			foreignHistory: await native.prisma.notificationLog.findMany({
				where: { channelId: other.channelId },
			}),
			foreignChannel: await native.prisma.notificationChannel.findFirstOrThrow({
				where: { id: other.channelId, userId: other.userId },
			}),
		}));
	const manual = (target = id) =>
		native.runtime.runOperation(() => scheduler.triggerManualClean(target));
	return {
		app,
		native,
		scheduler,
		config,
		configModel,
		logModel,
		prisma,
		counts,
		state,
		sent,
		logs,
		outcomes,
		result,
		preview,
		staleId,
		ready,
		idle,
		outcome,
		manual,
		waitUntilHeld: () => waitForNative(() => held),
		async readOnly(kind: "dry-run" | "preview") {
			const task =
				kind === "dry-run"
					? native.runtime.runOperation(() => scheduler.triggerDryRun(id))
					: native.runtime.runOperation(() => scheduler.triggerEnhancedPreview(id));
			tasks.push(task.catch(() => undefined));
			return task;
		},
		async start() {
			if (options.origin === "scheduled") {
				if (typeof timer !== "function") throw new Error("Queue Cleaner timer missing");
				timer();
			} else expect((await manual()).triggered).toBe(true);
		},
		async closePending() {
			let settled = false;
			const promise = app.close().then(() => {
				settled = true;
			});
			tasks.push(promise);
			if (options.hold?.phase !== "startup") await preClosed.promise;
			await settle();
			return { promise, settled: () => settled };
		},
	};
}

async function assertPersisted(
	f: Awaited<ReturnType<typeof boot>>,
	eventTypes: readonly string[],
	states: readonly ("ready" | "sent")[],
	status: "success" | "error" | null = "success",
	error = "Synthetic cleaner unavailable",
) {
	const rows = await f.outcome();
	expect(rows.events).toHaveLength(eventTypes.length);
	expect(rows.deliveries).toHaveLength(eventTypes.length);
	expect(rows.events.map((row) => row.eventType).sort()).toEqual([...eventTypes].sort());
	expect(rows.history.map((row) => row.status)).toEqual(
		states.filter((state) => state === "sent").map(() => "sent"),
	);
	for (const [index, eventType] of eventTypes.entries()) {
		const event = rows.events.find((row) => row.eventType === eventType)!;
		const delivery = rows.deliveries.find((row) => row.eventId === event.id)!;
		expect(event.userId).toBe(f.native.userId);
		expect(event.encryptedPayload).not.toContain("Same synthetic label");
		expect(delivery).toMatchObject({
			userId: f.native.userId,
			channelId: f.native.channelId,
			channelType: "DISCORD",
			subscriptionEventType: eventType,
			state: states[index],
			attemptOrdinal: 0,
		});
		expect(event.dueAt).toEqual(event.acceptedAt);
		const work = await f.native.run(() => f.native.repository().readEvent(event.id));
		expect(work?.policy).toEqual({ stage: "ready" });
		expect(work?.fallbackEventTypes).toEqual([]);
		expect(work?.recipients).toEqual([
			{ channelId: f.native.channelId, channelType: "DISCORD", subscriptionEventType: eventType },
		]);
		const job = rows.jobs.at(-1)!;
		const metadata = { instance: "Same synthetic label", service: "RADARR" };
		const payload =
			eventType === "QUEUE_ITEMS_REMOVED"
				? {
						eventType,
						title: "Queue cleaner removed 1 item(s) on Same synthetic label",
						body: "Synthetic outcome",
						metadata: {
							...metadata,
							itemsCleaned: 1,
							itemsSkipped: 0,
							durationMs: job.durationMs,
							cleanedItems: [],
						},
					}
				: eventType === "QUEUE_STRIKES_ISSUED"
					? {
							eventType,
							title: "Queue cleaner issued strikes on Same synthetic label",
							body: "1 item(s) received strikes",
							metadata: { ...metadata, itemsWarned: 1, warnedItems: [] },
						}
					: {
							eventType,
							title: "Queue cleaner failed on Same synthetic label",
							body: error,
							metadata: { ...metadata, durationMs: job.durationMs },
						};
		expect(work?.payload).toEqual({
			...payload,
			url: "https://synthetic.invalid/settings?tab=queue-cleaner",
		});
	}
	expect(rows.channel.lastSendResult).toBe(states.includes("sent") ? "success" : null);
	expect(rows.channel.lastSentAt === null).toBe(!states.includes("sent"));
	if (status === null) expect(rows.jobs).toEqual([]);
	else {
		expect(rows.jobs.length).toBeGreaterThan(0);
		for (const job of rows.jobs) {
			expect(job).toMatchObject({
				instanceId: f.config.instanceId,
				status,
				isDryRun: f.config.dryRunMode,
				itemsCleaned: status === "success" ? f.result.itemsCleaned : 0,
				itemsWarned: status === "success" ? f.result.itemsWarned : 0,
				itemsSkipped: 0,
				cleanedItems: null,
				skippedItems: null,
				warnedItems: null,
				message: status === "error" ? error : "Synthetic outcome",
			});
			expect(job.completedAt).toBeInstanceOf(Date);
			expect(job.durationMs).toBeGreaterThanOrEqual(0);
		}
		expect(rows.config.lastRunAt).toEqual(
			status === "success" ? rows.jobs.at(-1)!.completedAt : null,
		);
		expect(rows.config.lastRunItemsCleaned).toBe(status === "success" ? f.result.itemsCleaned : 0);
		expect(rows.config.lastRunItemsSkipped).toBe(0);
	}
	expect(rows.strikes).toHaveLength(2);
	expect(rows.strikes.map((row) => row.strikeCount)).toEqual([1, 1]);
	expect(rows.foreignConfig.lastRunAt).toBeNull();
	expect(rows.foreignConfig.lastRunItemsCleaned).toBe(0);
	expect(rows.foreignLogs).toHaveLength(1);
	expect(rows.foreignLogs[0]).toMatchObject({
		status: "success",
		message: "Foreign owner control",
	});
	expect(rows.foreignEvents).toEqual([]);
	expect(rows.foreignHistory).toEqual([]);
	expect(rows.foreignChannel.lastSentAt).toBeNull();
	expect(rows.foreignChannel.lastSendResult).toBeNull();
}

async function disposeNativeFixture(native: NativeFixture) {
	const owned = ownedRows.get(native)!;
	await native.run(async () => {
		if (owned.instances.length) {
			const where = { OR: owned.instances };
			const configWhere = {
				OR: owned.configs.map(({ id, instanceId, userId }) => ({
					id,
					instanceId,
					instance: { userId },
				})),
			};
			const logWhere = {
				OR: owned.logs.map(({ id, instanceId, userId }) => ({
					id,
					instanceId,
					instance: { userId },
				})),
			};
			expect(await native.prisma.queueCleanerConfig.count({ where: configWhere })).toBe(
				owned.configs.length,
			);
			if (owned.logs.length)
				expect(await native.prisma.queueCleanerLog.count({ where: logWhere })).toBe(
					owned.logs.length,
				);
			expect((await native.prisma.serviceInstance.deleteMany({ where })).count).toBe(
				owned.instances.length,
			);
			expect(await native.prisma.serviceInstance.count({ where })).toBe(0);
			expect(await native.prisma.queueCleanerConfig.count({ where: configWhere })).toBe(0);
			if (owned.logs.length)
				expect(await native.prisma.queueCleanerLog.count({ where: logWhere })).toBe(0);
			expect(
				await native.prisma.queueCleanerStrike.count({
					where: { instanceId: { in: owned.instances.map((row) => row.id) } },
				}),
			).toBe(0);
		}
		if (owned.subscriptions.length) {
			const where = {
				OR: owned.subscriptions.map(({ eventType, channelId, userId }) => ({
					eventType,
					channelId,
					channel: { userId },
				})),
			};
			expect((await native.prisma.notificationSubscription.deleteMany({ where })).count).toBe(
				owned.subscriptions.length,
			);
			expect(await native.prisma.notificationSubscription.count({ where })).toBe(0);
		}
		if (owned.channels.length) {
			const where = { OR: owned.channels };
			expect((await native.prisma.notificationChannel.deleteMany({ where })).count).toBe(
				owned.channels.length,
			);
			expect(await native.prisma.notificationChannel.count({ where })).toBe(0);
		}
	});
	await native.close();
	ownedRows.delete(native);
	const index = natives.indexOf(native);
	expect(index).toBeGreaterThanOrEqual(0);
	natives.splice(index, 1);
}

beforeEach(() => {
	const realTimeout = globalThis.setTimeout;
	const realClear = globalThis.clearTimeout;
	vi.useFakeTimers({
		toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
	});
	const virtualTimeout = globalThis.setTimeout;
	const virtualClear = globalThis.clearTimeout;
	const virtualHandles = new Set<ReturnType<typeof setTimeout>>();
	// Advance only the application execution deadline, not native PostgreSQL I/O safety timers.
	vi.stubGlobal("setTimeout", (...args: Parameters<typeof setTimeout>) => {
		if (args[1] !== MAX_CLEAN_DURATION_MS) return realTimeout(...args);
		const handle = virtualTimeout(...args);
		virtualHandles.add(handle);
		return handle;
	});
	vi.stubGlobal("clearTimeout", (handle: Parameters<typeof clearTimeout>[0]) => {
		if (handle !== undefined && virtualHandles.delete(handle as ReturnType<typeof setTimeout>))
			virtualClear(handle);
		else realClear(handle);
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Fixture forbids network"));
	executors.clean.mockReset();
	executors.preview.mockReset();
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.all(tasks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	for (const native of [...natives]) await disposeNativeFixture(native);
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
describe("Queue Cleaner accepted notification handoff", () => {
	it("reaps actual stale native logs before opening admission without immediate cleanup", async () => {
		const f = await boot({ stale: true, origin: "scheduled" });
		expect(f.state.readySettled).toBe(true);
		expect(await f.native.run(async () => "native-ready")).toBe("native-ready");
		const rows = await f.outcome();
		expect(rows.jobs).toHaveLength(1);
		expect(rows.jobs[0]).toMatchObject({
			id: f.staleId,
			status: "error",
			message: "Clean was interrupted (app restart or crash)",
		});
		expect(rows.jobs[0]?.completedAt).toBeInstanceOf(Date);
		expect(rows.config.lastRunAt).toBeNull();
		expect(f.counts.startup).toBe(1);
		expect(f.counts.lookup).toBe(0);
		expect(f.counts.executor).toBe(0);
		expect(rows.events).toEqual([]);
		expect(f.sent).toEqual([]);
		await f.start();
		await f.idle();
		expect(f.counts.executor).toBe(1);
		expect((await f.outcome()).jobs.map((row) => row.status)).toEqual(["error", "success"]);
	});
	it("joins required native startup reaping and retains maintenance exclusion through shutdown", async () => {
		const gate = deferred();
		const f = await boot({ stale: true, hold: { phase: "startup", gate: gate.promise } });
		expect(f.state.readySettled).toBe(false);
		expect(f.counts.startup).toBe(1);
		expect(f.counts.executor).toBe(0);
		await expect(f.native.run(async () => undefined)).rejects.toMatchObject({ statusCode: 503 });
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});
		const closing = await f.closePending();
		expect(closing.settled()).toBe(false);
		expect(f.state.disconnected).toBe(false);
		gate.resolve();
		await f.ready;
		await closing.promise;
		expect((await f.outcome()).jobs[0]).toMatchObject({
			id: f.staleId,
			status: "error",
			message: "Clean was interrupted (app restart or crash)",
		});
		expect(f.state.afterTeardown).toBe(0);
		expect(f.counts.executor).toBe(0);
		await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
	});

	for (const origin of ["manual", "scheduled"] as const) {
		for (const [outcome, events] of [
			["removed", ["QUEUE_ITEMS_REMOVED"]],
			["warned", ["QUEUE_STRIKES_ISSUED"]],
			["both", ["QUEUE_ITEMS_REMOVED", "QUEUE_STRIKES_ISSUED"]],
			["throw", ["QUEUE_CLEANER_FAILED"]],
		] as const) {
			it(`preserves ${origin} ${outcome} alerts after admission closes`, async () => {
				const gate = deferred();
				const f = await boot({ origin, outcome, hold: { phase: "lookup", gate: gate.promise } });
				await f.start();
				expect(await f.waitUntilHeld()).toBe(true);
				expect(f.counts.lookup).toBe(1);
				const closing = await f.closePending();
				expect(closing.settled()).toBe(false);
				expect(f.state.disconnected).toBe(false);
				await expect(f.manual("new-after-close")).resolves.toMatchObject({
					triggered: false,
				});
				await expect(
					f.app.notificationService.notify(
						{ eventType: "QUEUE_CLEANER_FAILED", title: "Synthetic", body: "Synthetic" },
						{ userId: f.config.instance.userId },
					),
				).rejects.toThrow(/shutting down/);
				gate.resolve();
				await closing.promise;
				expect(f.sent).toEqual([]);
				expect(f.logs).toEqual([]);
				await assertPersisted(
					f,
					events,
					events.map(() => "ready"),
					outcome === "throw" ? "error" : "success",
				);
				expect(f.outcomes).toEqual([outcome === "throw" ? "error" : "success"]);
				expect(f.counts.executor).toBe(1);
				expect(f.state.afterTeardown).toBe(0);
			});
		}
		for (const phase of [
			"executor",
			"result",
			"bookkeeping",
			"subscription",
			"send",
			"log",
			"channel",
		] as const) {
			it(`drains ${origin} ${phase} before database teardown`, async () => {
				const gate = deferred();
				const f = await boot({ origin, outcome: "both", hold: { phase, gate: gate.promise } });
				await f.start();
				expect(await f.waitUntilHeld()).toBe(true);
				expect(f.counts[phase]).toBe(1);
				const closing = await f.closePending();
				expect(closing.settled()).toBe(false);
				expect(f.state.disconnected).toBe(false);
				gate.resolve();
				await closing.promise;
				const started = ["send", "log", "channel"].includes(phase);
				expect(f.sent.map((item) => item.eventType)).toEqual(
					started ? ["QUEUE_ITEMS_REMOVED"] : [],
				);
				expect(f.logs).toEqual(started ? ["sent"] : []);
				await assertPersisted(
					f,
					["QUEUE_ITEMS_REMOVED", "QUEUE_STRIKES_ISSUED"],
					started ? ["sent", "ready"] : ["ready", "ready"],
				);
				expect(f.counts.bookkeeping).toBe(1);
				expect(f.state.afterTeardown).toBe(0);
			});
		}
	}
	it("keeps ordinary stop manual-capable and honors cooldown after notification failure", async () => {
		const gate = deferred();
		gate.resolve();
		const f = await boot({
			outcome: "removed",
			hold: { phase: "subscription", gate: gate.promise, reject: true },
		});
		expect(f.scheduler.isRunning()).toBe(false);
		await f.start();
		await f.idle();
		expect(f.outcomes).toEqual(["success"]);
		expect(f.sent).toEqual([]);
		await expect(f.manual()).resolves.toMatchObject({
			triggered: false,
		});
		vi.setSystemTime(new Date(Date.now() + MANUAL_CLEAN_COOLDOWN_MINS * 60_000 + 1));
		await f.start();
		await f.idle();
		expect(f.counts.executor).toBe(2);
		expect(f.sent.map((item) => item.eventType)).toEqual(["QUEUE_ITEMS_REMOVED"]);
		await assertPersisted(f, ["QUEUE_ITEMS_REMOVED"], ["sent"]);
	});
	it("retains raw executor ownership after timeout and hands off failure during drain", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "executor", gate: gate.promise } });
		await f.start();
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		await vi.advanceTimersByTimeAsync(MAX_CLEAN_DURATION_MS - 1);
		expect(f.outcomes).toEqual([]);
		expect(f.counts.executor).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await waitForNative(() => f.outcomes.length === 1 && f.counts.subscription === 1)).toBe(
			true,
		);
		expect(f.sent).toEqual([]);
		expect(f.outcomes).toEqual(["error"]);
		expect(closing.settled()).toBe(false);
		expect(() => f.scheduler.initialize(f.app)).toThrow(/shutting down/);
		gate.resolve();
		await closing.promise;
		expect(f.counts.executor).toBe(1);
		await assertPersisted(
			f,
			["QUEUE_CLEANER_FAILED"],
			["ready"],
			"error",
			`Queue clean timed out after ${MAX_CLEAN_DURATION_MS / 1000} seconds`,
		);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("does not overlap an uncancelled executor after its timeout and cooldown expire", async () => {
		const gate = deferred();
		const f = await boot({ hold: { phase: "executor", gate: gate.promise } });
		await f.start();
		expect(await f.waitUntilHeld()).toBe(true);
		await vi.advanceTimersByTimeAsync(MAX_CLEAN_DURATION_MS - 1);
		expect(f.outcomes).toEqual([]);
		expect(f.counts.executor).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(await waitForNative(() => f.outcomes.length === 1 && f.counts.subscription === 1)).toBe(
			true,
		);
		expect(f.outcomes).toEqual(["error"]);
		vi.setSystemTime(new Date(Date.now() + MANUAL_CLEAN_COOLDOWN_MINS * 60_000 + 1));
		await expect(f.manual()).resolves.toMatchObject({
			triggered: false,
			message: expect.stringMatching(/in progress/),
		});
		expect(f.counts.executor).toBe(1);
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});
		gate.resolve();
		await f.idle();
		await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
		await assertPersisted(
			f,
			["QUEUE_CLEANER_FAILED"],
			["sent"],
			"error",
			`Queue clean timed out after ${MAX_CLEAN_DURATION_MS / 1000} seconds`,
		);
	});
	it("retains the maintenance barrier through accepted handoff, then releases it", async () => {
		const gate = deferred();
		const f = await boot({
			outcome: "removed",
			hold: { phase: "subscription", gate: gate.promise },
		});
		await f.start();
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toMatchObject({
			statusCode: 409,
		});
		gate.resolve();
		await closing.promise;
		await expect(withCleanupMaintenanceGuard(async () => "released")).resolves.toBe("released");
		await assertPersisted(f, ["QUEUE_ITEMS_REMOVED"], ["ready"]);
	});
	it("refuses manual work during database maintenance before any lookup", async () => {
		const f = await boot();
		await withCleanupMaintenanceGuard(async () => {
			await expect(f.manual()).rejects.toMatchObject({
				statusCode: 409,
			});
		});
		expect(f.counts.lookup).toBe(0);
		expect(f.counts.executor).toBe(0);
		expect(f.counts.subscription).toBe(0);
		await assertPersisted(f, [], [], null);
	});
	it("contains failed alert submission without changing committed cleanup results", async () => {
		const gate = deferred();
		const f = await boot({
			outcome: "both",
			hold: { phase: "subscription", gate: gate.promise, reject: true },
		});
		await f.start();
		expect(await f.waitUntilHeld()).toBe(true);
		const closing = await f.closePending();
		gate.resolve();
		await closing.promise;
		expect(f.outcomes).toEqual(["success"]);
		expect(f.counts.bookkeeping).toBe(1);
		expect(f.sent).toEqual([]);
		await assertPersisted(f, ["QUEUE_STRIKES_ISSUED"], ["ready"]);
		expect(f.state.afterTeardown).toBe(0);
	});
	it("uses the new app's producer after a completed singleton lifecycle", async () => {
		const previous = await boot({ outcome: "removed" });
		await previous.start();
		await previous.idle();
		await previous.app.close();
		await assertPersisted(previous, ["QUEUE_ITEMS_REMOVED"], ["sent"]);
		await disposeNativeFixture(previous.native);
		const gate = deferred();
		const next = await boot({ outcome: "removed", hold: { phase: "lookup", gate: gate.promise } });
		await next.start();
		expect(await next.waitUntilHeld()).toBe(true);
		const closing = await next.closePending();
		gate.resolve();
		await closing.promise;
		expect(next.sent).toEqual([]);
		await assertPersisted(next, ["QUEUE_ITEMS_REMOVED"], ["ready"]);
		expect(previous.state.afterTeardown).toBe(0);
		expect(next.state.afterTeardown).toBe(0);
		// Two complete native app lifecycles retain real keyed fingerprint work.
	}, 15_000);
	it("does not invent completion alerts for an empty result", async () => {
		const f = await boot({ outcome: "empty" });
		await f.start();
		await f.idle();
		expect(f.sent).toEqual([]);
		expect(f.outcomes).toEqual(["success"]);
		expect(f.counts.subscription).toBe(0);
		await assertPersisted(f, [], []);
	});
	it.each(["manual", "scheduled"] as const)(
		"does not issue removal alerts for configured %s dry-run work",
		async (origin) => {
			const gate = deferred();
			const f = await boot({
				origin,
				outcome: "removed",
				dryRun: true,
				hold: { phase: "lookup", gate: gate.promise },
			});
			await f.start();
			expect(await f.waitUntilHeld()).toBe(true);
			const closing = await f.closePending();
			gate.resolve();
			await closing.promise;
			expect(f.sent).toEqual([]);
			expect(f.counts.subscription).toBe(0);
			expect(f.outcomes).toEqual(["success"]);
			expect(f.counts.bookkeeping).toBe(1);
			await assertPersisted(f, [], []);
		},
	);
	it.each(["dry-run", "preview"] as const)(
		"keeps %s read-only and drains its accepted execution without job alerts",
		async (kind) => {
			const gate = deferred();
			const f = await boot({ operation: kind, hold: { phase: "executor", gate: gate.promise } });
			const before = await f.outcome();
			const writesBefore = vi.mocked(f.prisma.$transaction).mock.calls.length;
			const task = f.readOnly(kind);
			expect(await f.waitUntilHeld()).toBe(true);
			expect(f.counts.executor).toBe(1);
			const closing = await f.closePending();
			expect(closing.settled()).toBe(false);
			gate.resolve();
			const result = await task;
			await closing.promise;
			if (kind === "dry-run") expect(result).toMatchObject({ isDryRun: true, status: "success" });
			else expect(result).toEqual(f.preview);
			expect(f.logModel.create).not.toHaveBeenCalled();
			expect(f.logModel.update).not.toHaveBeenCalled();
			expect(vi.mocked(f.prisma.$transaction).mock.calls.length).toBe(writesBefore);
			expect(await f.outcome()).toEqual(before);
			expect(f.prisma.queueCleanerStrike.deleteMany).not.toHaveBeenCalled();
			expect(f.configModel.update).not.toHaveBeenCalled();
			expect(f.sent).toEqual([]);
			expect(f.counts.subscription).toBe(0);
			expect(f.state.afterTeardown).toBe(0);
		},
	);
});
