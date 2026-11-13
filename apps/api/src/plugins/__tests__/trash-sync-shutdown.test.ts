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
import { createNotificationOutboxRepository } from "../../lib/notifications/outbox-repository.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import { SyncEngine, type SyncOptions } from "../../lib/trash-guides/sync-engine.js";
import notificationServicePlugin from "../notification-service.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";
import trashSyncSchedulerPlugin from "../trash-sync-scheduler.js";

const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];
type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
const natives: NativeFixture[] = [];
const ownedTemplates = new Map<NativeFixture, Array<{ id: string; userId: string }>>();
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;

async function waitForNative(observation: () => boolean, milliseconds = 5_000) {
	const deadline = performance.now() + milliseconds;
	while (!observation()) {
		if (performance.now() >= deadline) return false;
		await settle();
	}
	return true;
}

/** Native database/bootstrap/outbox authority; external sync and send transport only are synthetic. */
async function boot(
	options: {
		origin?: "startup" | "interval";
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; count?: number };
		mode?: Mode;
		twoOwners?: boolean;
	} = {},
) {
	const native = await createNotificationOutboxNativeFixture();
	natives.push(native);
	const templates: Array<{ id: string; userId: string }> = [];
	ownedTemplates.set(native, templates);
	const state = {
		due: 0,
		repo: 0,
		validate: 0,
		execute: 0,
		advance: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
		pending: 0,
		teardown: 0,
		pendingAtTeardown: -1,
		afterTeardown: 0,
		ready: false,
	};
	const entered = deferred();
	let armed = options.origin !== "interval";
	let held = false;
	const pause = async (phase: Phase) => {
		const count = ++state[phase];
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			if (armed && !held && options.hold?.phase === phase && count === (options.hold.count ?? 1)) {
				held = true;
				entered.resolve();
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic sync dependency failure");
			}
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	};
	const owners = [{ userId: native.userId, channelId: native.channelId }];
	if (options.twoOwners) owners.push(await native.createOwner());
	const targets: Array<{
		userId: string;
		channelId: string;
		templateId: string;
		instanceId: string;
		scheduleId: string;
	}> = [];
	await native.run(async () => {
		for (const owner of owners) {
			const config = native.encryptor.encrypt(
				JSON.stringify({
					webhookUrl: `https://example.invalid/synthetic-worker/${owner.userId}`,
				}),
			);
			await native.prisma.notificationChannel.updateMany({
				where: { id: owner.channelId, userId: owner.userId },
				data: { encryptedConfig: config.value, configIv: config.iv },
			});
			await native.prisma.notificationSubscription.createMany({
				data: ["TRASH_SYNC_ERROR", "TRASH_PROFILE_UPDATED"].map((eventType) => ({
					channelId: owner.channelId,
					eventType,
				})),
			});
			const key = native.encryptor.encrypt("synthetic-provider-key");
			const instance = await native.prisma.serviceInstance.create({
				data: {
					userId: owner.userId,
					service: "RADARR",
					label: "Synthetic instance",
					baseUrl: "https://example.invalid/synthetic-provider",
					encryptedApiKey: key.value,
					encryptionIv: key.iv,
				},
			});
			const template = await native.prisma.trashTemplate.create({
				data: {
					userId: owner.userId,
					name: "Synthetic template",
					serviceType: "RADARR",
					configData: "{}",
				},
			});
			templates.push({ id: template.id, userId: owner.userId });
			const schedule = await native.prisma.trashSyncSchedule.create({
				data: {
					userId: owner.userId,
					instanceId: instance.id,
					templateId: options.mode === "missing" ? null : template.id,
					frequency: "DAILY",
					autoApply: true,
					notifyUser: options.mode !== "silent",
					enabled: armed && options.mode !== "empty",
					nextRunAt: new Date("2026-10-01T00:00:00.000Z"),
				},
			});
			targets.push({
				...owner,
				templateId: template.id,
				instanceId: instance.id,
				scheduleId: schedule.id,
			});
		}
	});
	await native.restart(false);
	const client = createRuntimePrismaClient(native.runtime);
	const prisma = client.prisma;
	const dueRead = prisma.trashSyncSchedule.findMany.bind(prisma.trashSyncSchedule);
	const dueReads: { findMany: AwaitOnly<typeof prisma.trashSyncSchedule.findMany> } =
		prisma.trashSyncSchedule;
	vi.spyOn(dueReads, "findMany").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { enabled: true, nextRunAt: { lte: new Date() } },
			include: {
				template: { select: { id: true, name: true, serviceType: true } },
				instance: { select: { id: true, label: true } },
			},
		});
		const rows = await dueRead(args);
		for (const row of rows) {
			const owned = targets.find((target) => target.scheduleId === row.id);
			expect(owned?.userId).toBe(row.userId);
			expect(owned?.instanceId).toBe(row.instanceId);
		}
		await pause("due");
		return rows;
	});
	const repoRead = prisma.trashSettings.findFirst.bind(prisma.trashSettings);
	const repoReads: { findFirst: AwaitOnly<typeof prisma.trashSettings.findFirst> } =
		prisma.trashSettings;
	vi.spyOn(repoReads, "findFirst").mockImplementation(async (args) => {
		expect(args).toEqual({
			where: { customRepoOwner: { not: null } },
			select: {
				customRepoOwner: true,
				customRepoName: true,
				customRepoBranch: true,
				customRepoMode: true,
			},
		});
		const row = await repoRead(args);
		await pause("repo");
		return row;
	});
	const advances: string[] = [];
	const advance = prisma.trashSyncSchedule.update.bind(prisma.trashSyncSchedule);
	const updates: { update: AwaitOnly<typeof prisma.trashSyncSchedule.update> } =
		prisma.trashSyncSchedule;
	vi.spyOn(updates, "update").mockImplementation(async (args) => {
		expect(targets.map((target) => target.scheduleId)).toContain(args.where.id);
		expect(args.data).toEqual({
			lastRunAt: new Date("2026-10-02T00:00:00.000Z"),
			nextRunAt: new Date("2026-10-03T00:00:00.000Z"),
		});
		await pause("advance");
		const row = await advance(args);
		advances.push(row.id);
		return row;
	});
	const subscriptionRead = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptions: { findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany> } =
		prisma.notificationSubscription;
	vi.spyOn(subscriptions, "findMany").mockImplementation(async (args) => {
		expect(args?.include).toEqual({ channel: true });
		const rows = await subscriptionRead({ ...args, include: { channel: true } });
		for (const row of rows) {
			expect(owners).toContainEqual({ userId: row.channel.userId, channelId: row.channelId });
		}
		if (typeof args?.where?.eventType !== "string") {
			expect(args?.where?.eventType).toEqual({
				in: ["TRASH_DEPLOY_UNCERTAIN", "TRASH_SYNC_ERROR"],
			});
			expect(owners.map((owner) => owner.userId)).toContain(
				(args?.where?.channel as { userId?: string })?.userId,
			);
		} else {
			expect(["TRASH_SYNC_ERROR", "TRASH_PROFILE_UPDATED"]).toContain(args.where.eventType);
		}
		await pause("subscription");
		return rows;
	});
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation, transactionOptions) =>
		transaction(async (tx) => {
			const logCreate = tx.notificationLog.create.bind(tx.notificationLog);
			const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
			vi.spyOn(history, "create").mockImplementation(async (args) => {
				expect(owners.map((owner) => owner.channelId)).toContain(args.data.channelId);
				const row = await logCreate(args);
				await pause("log");
				return row;
			});
			const channelUpdate = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const channels: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(channels, "updateMany").mockImplementation(async (args) => {
				const owner = owners.find((owner) => owner.channelId === args.where?.id);
				expect(owner).toBeDefined();
				expect(args.where?.userId).toBe(owner?.userId);
				const row = await channelUpdate(args);
				if (args.data.lastSendResult !== undefined) {
					expect(args.where?.type).toBe("DISCORD");
					expect(args.where?.encryptedConfig).toBeTypeOf("string");
					expect(args.where?.configIv).toBeTypeOf("string");
					await pause("channel");
				}
				return row;
			});
			return operation(tx);
		}, transactionOptions),
	);
	const executions: string[] = [];
	const ownedRequest = (request: SyncOptions) => {
		const target = targets.find((target) => target.userId === request.userId);
		expect(target).toBeDefined();
		expect(request).toEqual({
			templateId: target!.templateId,
			instanceId: target!.instanceId,
			userId: target!.userId,
			syncType: "SCHEDULED",
		});
		return target!;
	};
	vi.spyOn(SyncEngine.prototype, "validate").mockImplementation(async (request) => {
		ownedRequest(request);
		await pause("validate");
		return {
			valid: options.mode !== "invalid",
			conflicts: [],
			errors: options.mode === "invalid" ? ["Synthetic invalid mapping"] : [],
			warnings: [],
		};
	});
	vi.spyOn(SyncEngine.prototype, "execute").mockImplementation(async (request, resolutions) => {
		const owner = ownedRequest(request).userId;
		expect(resolutions).toBeUndefined();
		await pause("execute");
		executions.push(owner);
		const status =
			options.mode === "success" ? "SUCCESS" : options.mode === "failed" ? "FAILED" : "UNCERTAIN";
		return {
			syncId: `${owner}-sync`,
			success: status === "SUCCESS",
			status,
			duration: 1,
			configsApplied: status === "SUCCESS" ? 1 : 0,
			configsFailed: status === "FAILED" ? 1 : 0,
			configsSkipped: 0,
			errors:
				status === "SUCCESS"
					? []
					: [
							{
								configName: "Synthetic config",
								error: "Synthetic unresolved write",
								retryable: false,
							},
						],
		};
	});
	const events: Array<{ event: string; owner: string; reason: unknown; advanceFailed: unknown }> =
		[];
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		async (type, config, payload) => {
			const owner = owners.find(
				(target) =>
					config.webhookUrl === `https://example.invalid/synthetic-worker/${target.userId}`,
			)?.userId;
			expect(type).toBe("DISCORD");
			expect(config).toEqual({ webhookUrl: `https://example.invalid/synthetic-worker/${owner}` });
			expect(owners.map((target) => target.userId)).toContain(owner);
			expect(["TRASH_DEPLOY_UNCERTAIN", "TRASH_SYNC_ERROR", "TRASH_PROFILE_UPDATED"]).toContain(
				payload.eventType,
			);
			events.push({
				event: payload.eventType,
				owner: owner!,
				reason: payload.metadata?.reason,
				advanceFailed: payload.metadata?.scheduleAdvanceFailed,
			});
			await pause("send");
			return { success: true, retryable: false };
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(() => {
			throw new Error("Fixture forbids external network access");
		}),
	);
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
	app.decorate("deploymentExecutor", {} as never);
	await app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					await client.close();
					state.teardown++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => {}, { name: "security" }));
	await app.register(fp(async () => {}, { name: "deployment-executor" }));
	registerRestoreBootstrapPlugin(app, notificationServicePlugin);
	await app.register(schedulerRegistryPlugin);
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const work = track(...args);
		tasks.push(work.catch(() => undefined));
		return work;
	});
	const interval = vi.spyOn(globalThis, "setInterval");
	registerRestoreBootstrapPlugin(app, trashSyncSchedulerPlugin, { readyPhase: "running" });
	const closing = deferred();
	app.addHook("preClose", async () => closing.resolve());
	registerRestoreRuntimeActivation(app);
	const ready = Promise.resolve(app.ready()).finally(() => {
		state.ready = true;
	});
	expect(await waitForNative(() => state.ready)).toBe(true);
	await ready;
	const idle = async () => {
		await settle();
		await Promise.all(tasks);
		await app.notificationService.drain();
	};
	if (options.origin === "interval") {
		await idle();
		armed = true;
		if (options.mode !== "empty") {
			await native.run(() =>
				native.prisma.trashSyncSchedule.updateMany({
					where: {
						id: { in: targets.map((target) => target.scheduleId) },
						userId: { in: owners.map((owner) => owner.userId) },
					},
					data: { enabled: true },
				}),
			);
		}
	} else if (options.hold) {
		expect(await waitForNative(() => held)).toBe(true);
	} else await idle();
	const callback = () => {
		const fn = [...interval.mock.calls].reverse().find(([, delay]) => delay === 60_000)?.[0];
		if (typeof fn !== "function") throw new Error("No native sync callback");
		return fn;
	};
	return {
		app,
		native,
		state,
		ready,
		events,
		advances,
		executions,
		idle,
		owners,
		targets,
		ownerA: targets[0]!.userId,
		ownerB: targets[1]?.userId,
		scheduleA: targets[0]!.scheduleId,
		scheduleB: targets[1]?.scheduleId,
		templateId: targets[0]!.templateId,
		instanceId: targets[0]!.instanceId,
		entered: entered.promise,
		closing: closing.promise,
		callback,
		tick: () => callback()(),
		async outcome() {
			return native.run(async () => ({
				schedule: await native.prisma.trashSyncSchedule.findFirstOrThrow({
					where: { id: targets[0]!.scheduleId, userId: native.userId },
				}),
				events: await native.prisma.notificationOutboxEvent.findMany({
					where: { userId: { in: owners.map((owner) => owner.userId) } },
				}),
				deliveries: await native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: { in: owners.map((owner) => owner.userId) } },
				}),
				history: await native.prisma.notificationLog.findMany({
					where: { channelId: { in: owners.map((owner) => owner.channelId) } },
				}),
				channel: await native.prisma.notificationChannel.findFirstOrThrow({
					where: { id: native.channelId, userId: native.userId },
				}),
			}));
		},
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	releases.push(resolve);
	return { promise, resolve };
}

async function settle() {
	for (let turn = 0; turn < 8; turn++) await new Promise<void>((resolve) => setImmediate(resolve));
}

type Phase =
	| "due"
	| "repo"
	| "validate"
	| "execute"
	| "advance"
	| "subscription"
	| "send"
	| "log"
	| "channel";
type Mode = "uncertain" | "success" | "failed" | "invalid" | "empty" | "missing" | "silent";

async function assertPersisted(
	fixture: Awaited<ReturnType<typeof boot>>,
	eventType: "TRASH_DEPLOY_UNCERTAIN" | "TRASH_SYNC_ERROR" | "TRASH_PROFILE_UPDATED" | null,
	deliveryState: "ready" | "sent" | "uncertain" | "submitting" | null,
	options: { advanceFailed?: boolean; reason?: string; owner?: string } = {},
) {
	const owner = options.owner ?? fixture.ownerA;
	const target = fixture.targets.find((target) => target.userId === owner)!;
	const result = await fixture.outcome();
	const rows = result.deliveries.filter((row) => row.userId === owner);
	const events = result.events.filter((row) => row.userId === owner);
	const history = result.history.filter((row) => row.channelId === target.channelId);
	expect(rows.map((row) => row.state)).toEqual(deliveryState ? [deliveryState] : []);
	expect(events.map((row) => row.eventType)).toEqual(eventType ? [eventType] : []);
	expect(history.map((row) => row.status)).toEqual(deliveryState === "sent" ? ["sent"] : []);
	for (const row of rows) {
		expect(row.channelId).toBe(target.channelId);
		expect(row.channelType).toBe("DISCORD");
		expect(row.subscriptionEventType).toBe(
			eventType === "TRASH_DEPLOY_UNCERTAIN" ? "TRASH_SYNC_ERROR" : eventType,
		);
		expect(row.attemptOrdinal).toBe(0);
		expect(row.nextAttemptAt.toISOString()).toBe("2026-10-02T00:00:00.000Z");
		const stored = events.find((event) => event.id === row.eventId)!;
		expect(stored.dueAt.toISOString()).toBe("2026-10-02T00:00:00.000Z");
		expect(stored.scopeFingerprint).toBeTypeOf("string");
		expect(stored.encryptedPayload).not.toContain("Synthetic template");
		const work = await fixture.native.run(() =>
			createNotificationOutboxRepository(
				fixture.native.prisma,
				fixture.native.runtime,
				fixture.native.encryptor,
				owner,
			).readEvent(row.eventId),
		);
		expect(work?.payload.eventType).toBe(eventType);
		expect(work?.payload.url).toBe("https://synthetic.invalid/trash-guides");
		expect(work?.policy).toEqual({ stage: "ready" });
		expect(work?.recipients).toEqual([
			{
				channelId: target.channelId,
				channelType: "DISCORD",
				subscriptionEventType:
					eventType === "TRASH_DEPLOY_UNCERTAIN" ? "TRASH_SYNC_ERROR" : eventType,
			},
		]);
		expect(work?.fallbackEventTypes).toEqual(
			eventType === "TRASH_DEPLOY_UNCERTAIN" ? ["TRASH_SYNC_ERROR"] : [],
		);
		if (eventType === "TRASH_DEPLOY_UNCERTAIN") {
			expect(work?.payload.title).toBe("Scheduled sync needs review: Synthetic template");
			expect(work?.payload.body).toBe(
				"Synthetic template → Synthetic instance: ARR may have applied changes, but the result could not be verified. Synthetic unresolved write" +
					(options.advanceFailed
						? " Schedule timing also could not be updated: Synthetic sync dependency failure"
						: ""),
			);
			expect(work?.payload.metadata).toEqual({
				templateId: target.templateId,
				instanceId: target.instanceId,
				syncId: `${owner}-sync`,
				reason: "uncertain_result",
				scheduleAdvanceFailed: options.advanceFailed ?? false,
			});
		} else if (eventType === "TRASH_PROFILE_UPDATED") {
			expect(work?.payload.title).toBe("Scheduled sync completed: Synthetic template");
			expect(work?.payload.body).toBe(
				"Synthetic template synced to Synthetic instance successfully",
			);
			expect(work?.payload.metadata).toEqual({
				templateId: target.templateId,
				instanceId: target.instanceId,
				syncId: `${owner}-sync`,
			});
		} else if (options.reason === "validation_failed") {
			expect(work?.payload.title).toBe("Scheduled sync skipped: Synthetic template");
			expect(work?.payload.body).toBe(
				"Validation failed for Synthetic template → Synthetic instance: Synthetic invalid mapping",
			);
			expect(work?.payload.metadata).toEqual({
				templateId: target.templateId,
				instanceId: target.instanceId,
				reason: "validation_failed",
			});
		} else if (options.reason === "failed") {
			expect(work?.payload.title).toBe("Scheduled sync failed: Synthetic template");
			expect(work?.payload.body).toBe(
				"Synthetic template → Synthetic instance: Synthetic unresolved write",
			);
			expect(work?.payload.metadata).toEqual({
				templateId: target.templateId,
				instanceId: target.instanceId,
			});
		} else {
			expect(work?.payload.title).toBe("Scheduled sync error: Synthetic template");
			expect(work?.payload.body).toBe("Synthetic sync dependency failure");
			expect(work?.payload.metadata).toBeUndefined();
		}
	}
	const channel = await fixture.native.run(() =>
		fixture.native.prisma.notificationChannel.findFirstOrThrow({
			where: { id: target.channelId, userId: owner },
		}),
	);
	expect(channel.lastSendResult).toBe(deliveryState === "sent" ? "success" : null);
	expect(channel.lastSentAt?.toISOString() ?? null).toBe(
		deliveryState === "sent" ? "2026-10-02T00:00:00.000Z" : null,
	);
}

beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(tasks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	for (const native of natives.splice(0)) {
		const templates = ownedTemplates.get(native) ?? [];
		if (templates.length > 0) {
			const removed = await native.run(() =>
				native.prisma.trashTemplate.deleteMany({ where: { OR: templates } }),
			);
			expect(removed.count).toBe(templates.length);
			expect(
				await native.run(() => native.prisma.trashTemplate.count({ where: { OR: templates } })),
			).toBe(0);
		}
		ownedTemplates.delete(native);
		await native.close();
	}
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

describe("TRaSH Sync native production startup controls", () => {
	for (const origin of ["startup", "interval"] as const) {
		it(`durably delivers an unheld due ${origin} uncertainty notification with production registration`, async () => {
			const fixture = await boot({ origin });
			if (origin === "interval") {
				fixture.tick();
				await fixture.idle();
			}
			const result = await fixture.outcome();
			expect(fixture.executions).toEqual([fixture.ownerA]);
			expect(result.schedule.lastRunAt?.toISOString()).toBe("2026-10-02T00:00:00.000Z");
			expect(result.schedule.nextRunAt?.toISOString()).toBe("2026-10-03T00:00:00.000Z");
			expect(result.events).toHaveLength(1);
			expect(result.deliveries).toHaveLength(1);
			const delivery = result.deliveries[0]!;
			expect(delivery.userId).toBe(fixture.native.userId);
			expect(delivery.channelId).toBe(fixture.native.channelId);
			expect(delivery.subscriptionEventType).toBe("TRASH_SYNC_ERROR");
			expect(delivery.state).toBe("sent");
			expect(delivery.attemptOrdinal).toBe(0);
			expect(delivery.nextAttemptAt.toISOString()).toBe("2026-10-02T00:00:00.000Z");
			const event = await fixture.native.run(() =>
				fixture.native.repository().readEvent(delivery.eventId),
			);
			expect(event?.payload.eventType).toBe("TRASH_DEPLOY_UNCERTAIN");
			expect(event?.payload.url).toBe("https://synthetic.invalid/trash-guides");
			expect(event?.payload.metadata).toEqual({
				templateId: fixture.templateId,
				instanceId: fixture.instanceId,
				syncId: `${fixture.ownerA}-sync`,
				reason: "uncertain_result",
				scheduleAdvanceFailed: false,
			});
			expect(event?.policy).toEqual({ stage: "ready" });
			expect(event?.recipients).toEqual([
				{
					channelId: fixture.native.channelId,
					channelType: "DISCORD",
					subscriptionEventType: "TRASH_SYNC_ERROR",
				},
			]);
			expect(result.history.map(({ status }) => status)).toEqual(["sent"]);
			expect(result.channel.lastSendResult).toBe("success");
			expect(result.channel.lastSentAt?.toISOString()).toBe("2026-10-02T00:00:00.000Z");
		});
	}
	it("does not hold readiness behind an admitted native startup due-query", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "due", gate: gate.promise } });
		const readyWhileHeld = await waitForNative(() => fixture.state.ready, 200);
		expect(readyWhileHeld).toBe(true);
		let closed = false;
		const close = fixture.app.close().then(() => {
			closed = true;
		});
		await fixture.closing;
		await settle();
		expect(closed).toBe(false);
		expect(fixture.state.teardown).toBe(0);
		gate.resolve();
		await close;
		expect(fixture.state.pendingAtTeardown).toBe(0);
		expect(fixture.executions).toEqual([fixture.ownerA]);
		await assertPersisted(fixture, "TRASH_DEPLOY_UNCERTAIN", "ready");
		expect(fixture.events).toEqual([]);
	});
});

describe("TRaSH Sync accepted batch and notification drain", () => {
	for (const origin of ["startup", "interval"] as const) {
		for (const phase of [
			"due",
			"repo",
			"validate",
			"execute",
			"advance",
			"subscription",
			"send",
			"log",
			"channel",
		] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before teardown`, async () => {
					const gate = deferred();
					const fixture = await boot({
						origin,
						hold: {
							phase,
							gate: gate.promise,
							reject,
							count: origin === "interval" && phase === "due" ? 2 : 1,
						},
					});
					if (origin === "interval") fixture.tick();
					expect(
						await waitForNative(
							() => fixture.state[phase] > (origin === "interval" && phase === "due" ? 1 : 0),
						),
					).toBe(true);
					expect(fixture.state.pending).toBeGreaterThan(0);
					await fixture.entered;
					let closed = false;
					const close = fixture.app.close().then(() => {
						closed = true;
					});
					await fixture.closing;
					await settle();
					expect(closed).toBe(false);
					expect(fixture.state.teardown).toBe(0);
					gate.resolve();
					await close;
					expect(fixture.state.pendingAtTeardown).toBe(0);
					expect(fixture.state.afterTeardown).toBe(0);
					const startedSend = ["send", "log", "channel"].includes(phase);
					const noEvent = reject && ["due", "subscription"].includes(phase);
					const eventType = noEvent
						? null
						: reject && ["repo", "validate", "execute"].includes(phase)
							? "TRASH_SYNC_ERROR"
							: "TRASH_DEPLOY_UNCERTAIN";
					const deliveryState = noEvent
						? null
						: !startedSend
							? "ready"
							: !reject
								? "sent"
								: phase === "send"
									? "uncertain"
									: "submitting";
					await assertPersisted(fixture, eventType, deliveryState, {
						advanceFailed: reject && phase === "advance",
					});
					expect(fixture.events.map(({ event }) => event)).toEqual(startedSend ? [eventType] : []);
					expect(fixture.state.send).toBe(startedSend ? 1 : 0);
					if (!reject) {
						expect(fixture.executions).toEqual([fixture.ownerA]);
						expect(fixture.advances).toEqual([fixture.scheduleA]);
					} else if (phase === "due") {
						expect(fixture.executions).toEqual([]);
						expect(fixture.advances).toEqual([]);
					} else if (phase === "advance") {
						expect(fixture.executions).toEqual([fixture.ownerA]);
						expect(fixture.advances).toEqual([]);
					} else if (["repo", "validate", "execute"].includes(phase)) {
						expect(fixture.executions).toEqual([]);
						expect(fixture.advances).toEqual([fixture.scheduleA]);
					}
					const schedule = (await fixture.outcome()).schedule;
					const advanced = !(reject && ["due", "advance"].includes(phase));
					expect(schedule.lastRunAt?.toISOString() ?? null).toBe(
						advanced ? "2026-10-02T00:00:00.000Z" : null,
					);
					expect(schedule.nextRunAt?.toISOString()).toBe(
						advanced ? "2026-10-03T00:00:00.000Z" : "2026-10-01T00:00:00.000Z",
					);
				});
			}
		}
	}

	it("refuses late captured timers and starts after terminal admission closes", async () => {
		const fixture = await boot({ mode: "empty" });
		const callback = fixture.callback();
		const before = fixture.state.due;
		await fixture.app.close();
		callback();
		fixture.app.trashSyncScheduler.start();
		await settle();
		expect(fixture.state.due).toBe(before);
		expect(fixture.state.afterTeardown).toBe(0);
	});
	it("retires old callbacks while preserving ordinary stop and restart", async () => {
		const fixture = await boot({ mode: "empty" });
		const callback = fixture.callback();
		fixture.app.trashSyncScheduler.stop();
		callback();
		await settle();
		expect(fixture.state.due).toBe(1);
		fixture.app.trashSyncScheduler.start();
		await fixture.idle();
		expect(fixture.state.due).toBe(2);
		callback();
		await settle();
		expect(fixture.state.due).toBe(2);
		fixture.tick();
		await fixture.idle();
		expect(fixture.state.due).toBe(3);
	});
	it("shares duplicate close and suppresses overlapping schedule batches", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "execute", gate: gate.promise } });
		await fixture.entered;
		fixture.tick();
		await settle();
		expect(fixture.state.due).toBe(1);
		let closed = 0;
		const closes = [fixture.app.close(), fixture.app.close()].map((work) =>
			work.then(() => {
				closed++;
			}),
		);
		await fixture.closing;
		await settle();
		expect(closed).toBe(0);
		gate.resolve();
		await Promise.all(closes);
		expect(fixture.state.teardown).toBe(1);
		expect(fixture.executions).toEqual([fixture.ownerA]);
		await assertPersisted(fixture, "TRASH_DEPLOY_UNCERTAIN", "ready");
		expect(fixture.state.send).toBe(0);
	});
	it("retains the whole accepted serial batch across close without mixing notification owners", async () => {
		const gate = deferred();
		const fixture = await boot({
			twoOwners: true,
			hold: { phase: "execute", gate: gate.promise, count: 2 },
		});
		await fixture.entered;
		expect(fixture.executions).toEqual([fixture.ownerA]);
		const close = fixture.app.close();
		await fixture.closing;
		await settle();
		expect(fixture.state.teardown).toBe(0);
		gate.resolve();
		await close;
		expect(fixture.executions).toEqual([fixture.ownerA, fixture.ownerB]);
		expect(fixture.advances).toEqual([fixture.scheduleA, fixture.scheduleB]);
		expect(fixture.events.map(({ event, owner }) => ({ event, owner }))).toEqual([
			{ event: "TRASH_DEPLOY_UNCERTAIN", owner: fixture.ownerA },
		]);
		await assertPersisted(fixture, "TRASH_DEPLOY_UNCERTAIN", "sent");
		await assertPersisted(fixture, "TRASH_DEPLOY_UNCERTAIN", "ready", { owner: fixture.ownerB });
		const result = await fixture.outcome();
		expect(result.events).toHaveLength(2);
		expect(new Set(result.events.map((event) => event.scopeFingerprint)).size).toBe(2);
		expect(fixture.state.afterTeardown).toBe(0);
	});
	it("preserves immediate startup and minute cadence without duplicate start", async () => {
		const fixture = await boot({ mode: "empty" });
		fixture.app.trashSyncScheduler.start();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(fixture.state.due).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await fixture.idle();
		expect(fixture.state.due).toBe(2);
	});
	it.each(["success", "failed", "invalid", "empty", "missing", "silent"] as const)(
		"preserves %s outcomes",
		async (mode) => {
			const fixture = await boot({ mode });
			expect(fixture.executions).toEqual(
				["invalid", "empty", "missing"].includes(mode) ? [] : [fixture.ownerA],
			);
			expect(fixture.advances).toEqual(
				["empty", "missing"].includes(mode) ? [] : [fixture.scheduleA],
			);
			expect(fixture.events.map(({ event }) => event)).toEqual(
				mode === "success"
					? ["TRASH_PROFILE_UPDATED"]
					: ["failed", "invalid"].includes(mode)
						? ["TRASH_SYNC_ERROR"]
						: [],
			);
			const eventType =
				mode === "success"
					? "TRASH_PROFILE_UPDATED"
					: ["failed", "invalid"].includes(mode)
						? "TRASH_SYNC_ERROR"
						: null;
			await assertPersisted(fixture, eventType, eventType ? "sent" : null, {
				reason: mode === "invalid" ? "validation_failed" : mode === "failed" ? "failed" : undefined,
			});
			const schedule = (await fixture.outcome()).schedule;
			expect(schedule.lastRunAt?.toISOString() ?? null).toBe(
				["empty", "missing"].includes(mode) ? null : "2026-10-02T00:00:00.000Z",
			);
		},
	);
	it("recovers on the next tick after a due-query failure", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "due", gate: gate.promise, reject: true } });
		await fixture.entered;
		gate.resolve();
		await fixture.idle();
		expect(fixture.executions).toEqual([]);
		fixture.tick();
		await fixture.idle();
		expect(fixture.executions).toEqual([fixture.ownerA]);
		expect(fixture.advances).toEqual([fixture.scheduleA]);
		await assertPersisted(fixture, "TRASH_DEPLOY_UNCERTAIN", "sent");
	});
	it("skips maintenance-blocked ticks without false errors or registry failures", async () => {
		const fixture = await boot({ mode: "empty" });
		const before = fixture.app.schedulerRegistry.getStatus(JOB_ID.trashSync);
		const errors = vi.spyOn(fixture.app.log, "error");
		await withCleanupMaintenanceGuard(async () => {
			fixture.tick();
			await settle();
		});
		expect(fixture.state.due).toBe(1);
		expect(errors).not.toHaveBeenCalled();
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.trashSync)).toEqual(before);
	});
	it("holds the existing maintenance exclusion until accepted bookkeeping settles", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "advance", gate: gate.promise } });
		await fixture.entered;
		let maintenance = false;
		await expect(
			withCleanupMaintenanceGuard(async () => {
				maintenance = true;
			}),
		).rejects.toThrow("maintenance");
		expect(maintenance).toBe(false);
		gate.resolve();
		await fixture.idle();
		await withCleanupMaintenanceGuard(async () => {
			maintenance = true;
		});
		expect(maintenance).toBe(true);
	});
});
