import { performance } from "node:perf_hooks";
import type { BackupFileInfo } from "@arr/shared";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "../../lib/backup/backup-service.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../../lib/backup/restore-runtime-client.js";
import {
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
} from "../../lib/library-cleanup/cleanup-maintenance-gate.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import { JOB_ID } from "../../lib/scheduler-registry/job-definitions.js";
import backupSchedulerPlugin from "../backup-scheduler.js";
import notificationServicePlugin from "../notification-service.js";
import schedulerRegistryPlugin from "../scheduler-registry.js";

const apps: FastifyInstance[] = [];
type NativeFixture = Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
const natives: NativeFixture[] = [];
const ownedSettings = new Map<NativeFixture, Date>();
const releases: Array<() => void> = [];
const tasks: Promise<unknown>[] = [];
type AwaitOnly<T> = T extends (...args: infer Args) => unknown
	? (...args: Args) => PromiseLike<unknown>
	: never;

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((release) => {
		resolve = release;
	});
	releases.push(resolve);
	return { promise, resolve };
}

async function settle() {
	for (let turn = 0; turn < 8; turn++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

// Native SQL/crypto settlement is not bounded by eight microtask turns. Poll
// observations with a real deadline without advancing the scheduler's fake clock.
async function waitFor(observation: () => boolean) {
	const deadline = performance.now() + 5_000;
	while (!observation()) {
		if (performance.now() >= deadline) throw new Error("Native scheduler observation expired");
		await settle();
	}
}

type Phase =
	| "settings"
	| "create"
	| "list"
	| "delete"
	| "update"
	| "subscription"
	| "send"
	| "log"
	| "channel";
type Origin = "startup" | "interval";

async function boot(
	options: {
		origin?: Origin;
		hold?: { phase: Phase; gate: Promise<void>; reject?: boolean; count?: number };
		mode?: "due" | "none" | "disabled" | "future" | "unsynchronized";
	} = {},
) {
	const state = {
		settings: 0,
		create: 0,
		list: 0,
		delete: 0,
		update: 0,
		subscription: 0,
		send: 0,
		log: 0,
		channel: 0,
		pending: 0,
		teardown: 0,
		pendingAtTeardown: -1,
		afterTeardown: 0,
	};
	const entered = deferred();
	let armed = options.origin !== "interval";
	let held = 0;
	const deleted: string[] = [];
	const events: string[] = [];
	const pause = async (phase: Phase) => {
		state[phase]++;
		if (state.teardown) state.afterTeardown++;
		state.pending++;
		try {
			if (armed && options.hold?.phase === phase && held < (options.hold.count ?? 1)) {
				held++;
				entered.resolve();
				await options.hold.gate;
				if (options.hold.reject) throw new Error("Synthetic backup dependency failure");
			}
		} finally {
			if (state.teardown) state.afterTeardown++;
			state.pending--;
		}
	};
	const native = await createNotificationOutboxNativeFixture();
	natives.push(native);
	await native.run(async () => {
		await native.prisma.notificationSubscription.createMany({
			data: ["BACKUP_COMPLETED", "BACKUP_FAILED"].map((eventType) => ({
				channelId: native.channelId,
				eventType,
			})),
		});
		if (options.mode !== "none") {
			const settings = await native.prisma.backupSettings.create({
				data: {
					id: 1,
					enabled: armed && options.mode !== "disabled",
					intervalType: "HOURLY",
					intervalValue: 1,
					retentionCount: 2,
					nextRunAt: new Date(
						options.mode === "future" ? "2026-10-03T00:00:00.000Z" : "2026-10-01T00:00:00.000Z",
					),
				},
			});
			ownedSettings.set(native, settings.createdAt);
		}
	});
	await native.restart(false);
	const appNative = createRuntimePrismaClient(native.runtime);
	const prisma = appNative.prisma;
	const settingsRead = prisma.backupSettings.findUnique.bind(prisma.backupSettings);
	const settingsReads: { findUnique: AwaitOnly<typeof prisma.backupSettings.findUnique> } =
		prisma.backupSettings;
	vi.spyOn(settingsReads, "findUnique").mockImplementation(async (args) => {
		expect(args).toEqual({ where: { id: 1 } });
		const row = await settingsRead(args);
		await pause("settings");
		return row;
	});
	const settingsUpdate = prisma.backupSettings.update.bind(prisma.backupSettings);
	const settingsWrites: { update: AwaitOnly<typeof prisma.backupSettings.update> } =
		prisma.backupSettings;
	vi.spyOn(settingsWrites, "update").mockImplementation(async (args) => {
		expect(args.where).toEqual({ id: 1 });
		expect(args.data).toEqual({
			lastRunAt: new Date("2026-10-02T00:00:00.000Z"),
			nextRunAt: new Date("2026-10-02T01:00:00.000Z"),
		});
		await pause("update");
		return settingsUpdate(args);
	});
	const subscriptionRead = prisma.notificationSubscription.findMany.bind(
		prisma.notificationSubscription,
	);
	const subscriptions: { findMany: AwaitOnly<typeof prisma.notificationSubscription.findMany> } =
		prisma.notificationSubscription;
	vi.spyOn(subscriptions, "findMany").mockImplementation(async (args) => {
		expect(["BACKUP_COMPLETED", "BACKUP_FAILED"]).toContain(args?.where?.eventType);
		expect(args?.include).toEqual({ channel: true });
		const rows = await subscriptionRead({ ...args, include: { channel: true } });
		expect(rows).toHaveLength(1);
		expect(rows[0]?.channel.userId).toBe(native.userId);
		expect(rows[0]?.channelId).toBe(native.channelId);
		await pause("subscription");
		return rows;
	});
	const transaction = prisma.$transaction.bind(prisma);
	vi.spyOn(prisma, "$transaction").mockImplementation(async (operation, transactionOptions) =>
		transaction(async (tx) => {
			const logCreate = tx.notificationLog.create.bind(tx.notificationLog);
			const history: { create: AwaitOnly<typeof tx.notificationLog.create> } = tx.notificationLog;
			vi.spyOn(history, "create").mockImplementation(async (args) => {
				expect(args.data.channelId).toBe(native.channelId);
				const row = await logCreate(args);
				await pause("log");
				return row;
			});
			const channelUpdate = tx.notificationChannel.updateMany.bind(tx.notificationChannel);
			const channels: { updateMany: AwaitOnly<typeof tx.notificationChannel.updateMany> } =
				tx.notificationChannel;
			vi.spyOn(channels, "updateMany").mockImplementation(async (args) => {
				expect(args.where?.id).toBe(native.channelId);
				expect(args.where?.userId).toBe(native.userId);
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
	const info = (
		id: string,
		timestamp: string,
		type: BackupFileInfo["type"] = "scheduled",
	): BackupFileInfo => ({ id, filename: `${id}.enc`, timestamp, type, size: 1 });
	// Keep the real createBackup maintenance upgrade. Only its external encrypted
	// export/filesystem body and outbound transport are synthetic.
	vi.spyOn(
		BackupService.prototype as unknown as {
			createBackupExclusive(
				version: string,
				type: string,
				options: unknown,
			): Promise<BackupFileInfo>;
		},
		"createBackupExclusive",
	).mockImplementation(async (version, type, createOptions) => {
		expect(version).toBeTruthy();
		expect(type).toBe("scheduled");
		expect(createOptions).toEqual({});
		await pause("create");
		return info("synthetic-new", "2026-10-02T00:00:00.000Z");
	});
	vi.spyOn(BackupService.prototype, "listBackups").mockImplementation(async () => {
		await pause("list");
		return [
			info("synthetic-old", "2026-09-01T00:00:00.000Z"),
			info("synthetic-manual", "2026-08-01T00:00:00.000Z", "manual"),
			info("synthetic-new", "2026-10-02T00:00:00.000Z"),
			info("synthetic-kept", "2026-10-01T00:00:00.000Z"),
		];
	});
	vi.spyOn(BackupService.prototype, "deleteBackup").mockImplementation(async (id) => {
		expect(id).toBe("synthetic-old");
		await pause("delete");
		deleted.push(id);
	});
	vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
		async (type, config, payload) => {
			expect(type).toBe("DISCORD");
			expect(config.webhookUrl).toBe("https://example.invalid/synthetic-worker");
			expect(["BACKUP_COMPLETED", "BACKUP_FAILED"]).toContain(payload.eventType);
			events.push(payload.eventType);
			await pause("send");
			return { success: true, retryable: false };
		},
	);
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorate("restoreRuntime", native.runtime);
	app.decorate("prisma", prisma);
	app.decorate("encryptor", native.encryptor);
	app.decorate("config", {
		DATABASE_URL: "file:/synthetic-in-memory-fixture/unused.db",
		APP_URL: "https://synthetic.invalid",
	} as never);
	app.decorate("secretsSynchronized", options.mode !== "unsynchronized");
	await app.register(
		fp(
			async (server) => {
				server.addHook("onClose", async () => {
					state.pendingAtTeardown = state.pending;
					await appNative.close();
					state.teardown++;
				});
			},
			{ name: "prisma" },
		),
	);
	await app.register(fp(async () => {}, { name: "security" }));
	registerRestoreBootstrapPlugin(app, notificationServicePlugin);
	await app.register(schedulerRegistryPlugin);
	const track = app.schedulerRegistry.track.bind(app.schedulerRegistry);
	vi.spyOn(app.schedulerRegistry, "track").mockImplementation((...args) => {
		const task = track(...args);
		tasks.push(task.catch(() => undefined));
		return task;
	});
	const interval = vi.spyOn(globalThis, "setInterval");
	registerRestoreBootstrapPlugin(app, backupSchedulerPlugin, { readyPhase: "running" });
	const closing = deferred();
	app.addHook("preClose", async () => closing.resolve());
	registerRestoreRuntimeActivation(app);
	let readySettled = false;
	const ready = Promise.resolve(app.ready()).finally(() => {
		readySettled = true;
	});
	try {
		await waitFor(() => readySettled);
	} catch {
		throw new Error(`Native bootstrap did not settle: ${JSON.stringify(state)}`);
	}
	await ready;
	const idle = async () => {
		await settle();
		await Promise.all(tasks);
		await app.notificationService.drain();
	};
	if (options.origin === "interval") {
		await idle();
		armed = true;
		if (options.mode !== "none")
			await native.run(() =>
				native.prisma.backupSettings.update({
					where: { id: 1 },
					data: { enabled: options.mode !== "disabled" },
				}),
			);
	} else if (options.hold) await waitFor(() => state[options.hold!.phase] > 0);
	else await idle();
	const callback = () => {
		const fn = [...interval.mock.calls].reverse().find(([, delay]) => delay === 60_000)?.[0];
		if (typeof fn !== "function") throw new Error("No backup interval callback");
		return fn;
	};
	return {
		app,
		native,
		state,
		deleted,
		events,
		idle,
		entered: entered.promise,
		closing: closing.promise,
		tick: () => callback()(),
		callback,
		history: () =>
			native.run(() =>
				native.prisma.notificationLog.findMany({
					where: { channelId: native.channelId },
					orderBy: { sentAt: "asc" },
				}),
			),
		deliveries: () =>
			native.run(() =>
				native.prisma.notificationOutboxDelivery.findMany({
					where: { userId: native.userId, channelId: native.channelId },
				}),
			),
	};
}

async function assertOutcome(
	fixture: Awaited<ReturnType<typeof boot>>,
	eventType: "BACKUP_COMPLETED" | "BACKUP_FAILED",
	deliveryState: "ready" | "sent" | "uncertain" | "submitting" | null,
) {
	const rows = await fixture.deliveries();
	expect(rows.map((row) => row.state)).toEqual(deliveryState ? [deliveryState] : []);
	expect((await fixture.history()).map((row) => row.status)).toEqual(
		deliveryState === "sent" ? ["sent"] : [],
	);
	for (const row of rows) {
		expect(row.userId).toBe(fixture.native.userId);
		expect(row.channelId).toBe(fixture.native.channelId);
		expect(row.subscriptionEventType).toBe(eventType);
		expect(row.attemptOrdinal).toBe(0);
		const work = await fixture.native.run(() => fixture.native.repository().readEvent(row.eventId));
		expect(work?.payload.eventType).toBe(eventType);
		expect(work?.payload.title).toBe(
			eventType === "BACKUP_COMPLETED" ? "Scheduled backup completed" : "Scheduled backup failed",
		);
		expect(work?.payload.url).toBe("https://synthetic.invalid/settings?tab=backups");
		expect(work?.policy).toEqual({ stage: "ready" });
		expect(work?.recipients).toEqual([
			{
				channelId: fixture.native.channelId,
				channelType: "DISCORD",
				subscriptionEventType: eventType,
			},
		]);
		if (eventType === "BACKUP_COMPLETED") {
			expect(work?.payload.body).toBe("Next backup at 2026-10-02T01:00:00.000Z");
			expect(work?.payload.metadata).toEqual({
				nextRunAt: "2026-10-02T01:00:00.000Z",
				intervalType: "HOURLY",
				retentionCount: 2,
			});
		}
	}
	const channel = await fixture.native.run(() =>
		fixture.native.prisma.notificationChannel.findFirstOrThrow({
			where: { id: fixture.native.channelId, userId: fixture.native.userId },
		}),
	);
	expect(channel.lastSendResult).toBe(deliveryState === "sent" ? "success" : null);
	if (deliveryState === "sent")
		expect(channel.lastSentAt?.toISOString()).toBe("2026-10-02T00:00:00.000Z");
	else expect(channel.lastSentAt).toBeNull();
}
beforeEach(() => {
	vi.useFakeTimers({
		toFake: ["Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
	});
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(tasks.splice(0));
	await Promise.all(apps.splice(0).map((app) => app.close()));
	for (const native of natives.splice(0)) {
		const createdAt = ownedSettings.get(native);
		if (createdAt) {
			// The native fixture may share one freshly owned PostgreSQL database.
			// Delete only this test's successfully inserted singleton after joining.
			const removed = await native.run(() =>
				native.prisma.backupSettings.deleteMany({
					where: { id: 1, createdAt },
				}),
			);
			expect(removed.count).toBe(1);
			ownedSettings.delete(native);
		}
		await native.close();
	}
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Backup scheduler accepted work and notification drain", () => {
	it("durably delivers a due startup backup notification after real bootstrap", async () => {
		const fixture = await boot();
		const settings = await fixture.native.run(() =>
			fixture.native.prisma.backupSettings.findUniqueOrThrow({ where: { id: 1 } }),
		);
		expect({
			lastRunAt: settings.lastRunAt?.toISOString(),
			nextRunAt: settings.nextRunAt?.toISOString(),
			deleted: fixture.deleted,
			events: fixture.events,
			deliveries: (await fixture.deliveries()).map((row) => row.state),
			history: (await fixture.history()).map((row) => row.status),
		}).toEqual({
			lastRunAt: "2026-10-02T00:00:00.000Z",
			nextRunAt: "2026-10-02T01:00:00.000Z",
			deleted: ["synthetic-old"],
			events: ["BACKUP_COMPLETED"],
			deliveries: ["sent"],
			history: ["sent"],
		});
		await assertOutcome(fixture, "BACKUP_COMPLETED", "sent");
	});

	for (const origin of ["startup", "interval"] as const) {
		for (const phase of [
			"settings",
			"create",
			"list",
			"delete",
			"update",
			"subscription",
			"send",
			"log",
			"channel",
		] as const) {
			for (const reject of [false, true]) {
				it(`drains ${origin} ${phase} ${reject ? "failure" : "completion"} before dependency teardown`, async () => {
					const gate = deferred();
					const fixture = await boot({ origin, hold: { phase, gate: gate.promise, reject } });
					if (origin === "interval") fixture.tick();
					await waitFor(() => fixture.state[phase] > 0);
					// Assert reachability before awaiting the held-phase signal, avoiding timeout-only failures.
					expect(fixture.state[phase]).toBeGreaterThan(0);
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
					const eventType =
						reject && ["settings", "create", "update"].includes(phase)
							? "BACKUP_FAILED"
							: "BACKUP_COMPLETED";
					// Closing before dispatch conserves accepted work for restart. Once a
					// send began, close joins its real result/finalization transaction.
					const deliveryState =
						reject && phase === "subscription"
							? null
							: !startedSend
								? "ready"
								: !reject
									? "sent"
									: phase === "send"
										? "uncertain"
										: "submitting";
					await assertOutcome(fixture, eventType, deliveryState);
					expect(fixture.events).toEqual(startedSend ? [eventType] : []);
					if (!reject) expect(fixture.deleted).toEqual(["synthetic-old"]);
					if (["subscription", "send", "log", "channel"].includes(phase)) {
						const settings = await fixture.native.run(() =>
							fixture.native.prisma.backupSettings.findUniqueOrThrow({ where: { id: 1 } }),
						);
						expect(settings.lastRunAt?.toISOString()).toBe("2026-10-02T00:00:00.000Z");
						expect(settings.nextRunAt?.toISOString()).toBe("2026-10-02T01:00:00.000Z");
					}
				});
			}
		}
	}

	it("refuses queued callbacks and future starts after closing admission", async () => {
		const fixture = await boot({ mode: "none" });
		const callback = fixture.callback();
		const before = fixture.state.settings;
		await fixture.app.close();
		callback();
		fixture.app.backupScheduler.start();
		await fixture.idle();
		expect(fixture.state.settings).toBe(before);
		expect(fixture.state.afterTeardown).toBe(0);
	});

	it("retires captured timer callbacks across ordinary stop and restart", async () => {
		const fixture = await boot({ mode: "none" });
		const callback = fixture.callback();
		fixture.app.backupScheduler.stop();
		callback();
		await fixture.idle();
		expect(fixture.state.settings).toBe(1);
		fixture.app.backupScheduler.start();
		await fixture.idle();
		expect(fixture.state.settings).toBe(2);
		callback();
		await fixture.idle();
		expect(fixture.state.settings).toBe(2);
		fixture.tick();
		await fixture.idle();
		expect(fixture.state.settings).toBe(3);
	});

	it("shares duplicate close while an accepted settings read is pending", async () => {
		const gate = deferred();
		const fixture = await boot({ mode: "none", hold: { phase: "settings", gate: gate.promise } });
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
		expect(closed).toBe(2);
		expect(fixture.state.teardown).toBe(1);
		expect(fixture.state.pendingAtTeardown).toBe(0);
	});

	it("retains normal startup and minute cadence without duplicate start", async () => {
		const fixture = await boot({ mode: "none" });
		fixture.app.backupScheduler.start();
		await vi.advanceTimersByTimeAsync(59_999);
		expect(fixture.state.settings).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await fixture.idle();
		expect(fixture.state.settings).toBe(2);
	});

	it("drains every accepted check when settings lookups overlap", async () => {
		const gate = deferred();
		const fixture = await boot({
			mode: "none",
			hold: { phase: "settings", gate: gate.promise, count: 2 },
		});
		fixture.tick();
		await waitFor(() => fixture.state.settings === 2);
		expect(fixture.state.pending).toBe(2);
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
	});

	it("allows the next ordinary tick to recover after a failed backup", async () => {
		const gate = deferred();
		const fixture = await boot({
			origin: "interval",
			hold: { phase: "create", gate: gate.promise, reject: true },
		});
		fixture.tick();
		await waitFor(() => fixture.state.create === 1);
		gate.resolve();
		await fixture.idle();
		expect(fixture.events).toEqual(["BACKUP_FAILED"]);
		fixture.tick();
		await fixture.idle();
		expect(fixture.state.create).toBe(2);
		expect(fixture.state.update).toBe(1);
		expect(fixture.deleted).toEqual(["synthetic-old"]);
		expect(fixture.events).toEqual(["BACKUP_FAILED", "BACKUP_COMPLETED"]);
		expect((await fixture.history()).map((row) => row.status)).toEqual(["sent", "sent"]);
		expect((await fixture.deliveries()).map((row) => row.state)).toEqual(["sent", "sent"]);
	});

	it("does not admit another backup while exclusive creation is active", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "create", gate: gate.promise } });
		const errors = vi.spyOn(fixture.app.log, "error");
		fixture.tick();
		await settle();
		expect(fixture.state.settings).toBe(1);
		expect(fixture.state.create).toBe(1);
		expect(errors).not.toHaveBeenCalled();
		gate.resolve();
		await fixture.idle();
		expect(fixture.events).toEqual(["BACKUP_COMPLETED"]);
	});

	it.each(["none", "disabled", "future", "unsynchronized"] as const)(
		"does not create a backup for %s settings",
		async (mode) => {
			const fixture = await boot({ mode });
			expect(fixture.state.settings).toBe(mode === "unsynchronized" ? 0 : 1);
			expect(fixture.state.create).toBe(0);
			expect(fixture.state.update).toBe(0);
			expect(fixture.events).toEqual([]);
		},
	);

	it("skips maintenance-blocked ticks without changing the ledger or logging a false failure", async () => {
		const fixture = await boot({ mode: "none" });
		const before = fixture.app.schedulerRegistry.getStatus(JOB_ID.backup);
		const errors = vi.spyOn(fixture.app.log, "error");
		await withCleanupMaintenanceGuard(async () => {
			fixture.tick();
			await fixture.idle();
		});
		expect(fixture.state.settings).toBe(1);
		expect(errors).not.toHaveBeenCalled();
		expect(fixture.app.schedulerRegistry.getStatus(JOB_ID.backup)).toEqual(before);
	});

	it("preserves maintenance exclusion through accepted schedule bookkeeping", async () => {
		const gate = deferred();
		const fixture = await boot({ hold: { phase: "update", gate: gate.promise } });
		await fixture.entered;
		let entered = false;
		await expect(
			withCleanupMaintenanceGuard(async () => {
				entered = true;
			}),
		).rejects.toThrow("maintenance");
		expect(entered).toBe(false);
		gate.resolve();
		await fixture.idle();
		await withCleanupMaintenanceGuard(async () => {
			entered = true;
		});
		expect(entered).toBe(true);
	});

	it("refuses exclusive backup creation when another shared operation is active", async () => {
		const fixture = await boot({ origin: "interval" });
		await withCleanupOperationGuard(async () => {
			fixture.tick();
			await fixture.idle();
		});
		expect(fixture.state.create).toBe(0);
		expect(fixture.state.update).toBe(0);
		expect(fixture.events).toEqual(["BACKUP_FAILED"]);
		await assertOutcome(fixture, "BACKUP_FAILED", "sent");
	});
});
