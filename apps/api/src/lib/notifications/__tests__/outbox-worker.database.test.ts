import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withCleanupMaintenanceGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";
import { NotificationDispatcher } from "../notification-dispatcher.js";
import type { createNotificationOutboxWorker } from "../outbox-worker.js";
import type { NotificationPayload, SendResult } from "../types.js";
import { createNotificationOutboxNativeFixture } from "./notification-outbox-native-fixture.js";

describe(`notification outbox worker on owned native ${process.env.NOTIFICATION_OUTBOX_TEST_ENGINE ?? "sqlite"}`, () => {
	let fixture: Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
	let workers: ReturnType<typeof createNotificationOutboxWorker>[];
	const delivered: NotificationPayload[] = [];
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	async function worker(
		send: (
			config: Record<string, unknown>,
			payload: NotificationPayload,
		) => Promise<SendResult> = async (_config, payload) => {
			delivered.push(payload);
			return { success: true, retryable: false };
		},
	) {
		const { createNotificationOutboxWorker } = await import("../outbox-worker.js");
		const dispatcher = new NotificationDispatcher();
		dispatcher.registerSender("DISCORD", {
			send,
			async test() {
				throw new Error("No provider Test in this fixture.");
			},
		});
		const result = createNotificationOutboxWorker({
			repository: fixture.repository(),
			runtime: fixture.runtime,
			dispatcher,
			logger,
			clock: fixture.clock,
		});
		workers.push(result);
		return result;
	}
	async function stop() {
		for (const current of workers) current.closeAdmission();
		await Promise.all(workers.map((current) => current.drain()));
	}
	beforeEach(async () => {
		fixture = await createNotificationOutboxNativeFixture();
		workers = [];
		delivered.length = 0;
	});
	afterEach(async () => {
		await stop();
		await fixture.close();
	});
	it("delivers committed ready work and persists the actual acknowledgement", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		const current = await worker();
		await current.start();
		expect(delivered).toEqual([fixture.payload]);
		await fixture.run(async () => {
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "sent" },
				}),
			).toBe(1);
			expect(
				await fixture.prisma.notificationLog.count({
					where: { channelId: fixture.channelId, status: "sent" },
				}),
			).toBe(1);
		});
		await current.start();
		await current.wake();
		expect(delivered).toHaveLength(1);
	});
	it("keeps future deferred work durable without an idle cleanup or native lifetime", async () => {
		await fixture.run(() =>
			fixture.repository().admit({
				...fixture.input(),
				policy: { stage: "deferred", dueAt: new Date("2026-10-10T13:00:00.000Z") },
			}),
		);
		const current = await worker();
		await current.start();
		expect(delivered).toEqual([]);
		expect(await withCleanupMaintenanceGuard(async () => "admitted")).toBe("admitted");
		await stop();
		fixture.runtime.closeAdmission();
		await fixture.runtime.drain();
		await fixture.restart();
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "waiting" },
				}),
			).toBe(1),
		);
	});
	it("resumes deferred work after restart only at its accepted deadline", async () => {
		await fixture.run(() =>
			fixture.repository().admit({
				...fixture.input(),
				policy: { stage: "deferred", dueAt: new Date("2026-10-10T13:00:00.000Z") },
			}),
		);
		const first = await worker();
		await first.start();
		await stop();
		await fixture.restart();
		const next = await worker();
		await next.start();
		expect(delivered).toEqual([]);
		fixture.now = new Date("2026-10-10T13:00:00.000Z");
		await next.wake();
		expect(delivered).toEqual([fixture.payload]);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "sent" },
				}),
			).toBe(1),
		);
	});
	it("sends only the committed digest of a full aggregation batch", async () => {
		await fixture.run(async () => {
			for (const title of ["Synthetic first", "Synthetic second"])
				await fixture.repository().admit({
					...fixture.input(),
					payload: { ...fixture.payload, title },
					policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 2 },
				});
		});
		const current = await worker();
		await current.start();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.metadata?.count).toBe(2);
		await fixture.run(async () => {
			expect(
				await fixture.prisma.notificationOutboxEvent.count({
					where: { userId: fixture.userId, stage: "grouped" },
				}),
			).toBe(2);
			expect(
				await fixture.prisma.notificationLog.count({
					where: { channelId: fixture.channelId, status: "sent" },
				}),
			).toBe(1);
		});
	});
	it("retains a future partial aggregation window across normal worker close", async () => {
		await fixture.run(() =>
			fixture.repository().admit({
				...fixture.input(),
				policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 10 },
			}),
		);
		const first = await worker();
		await first.start();
		await stop();
		expect(delivered).toEqual([]);
		await fixture.restart();
		fixture.now = new Date("2026-10-10T12:05:00.000Z");
		const next = await worker();
		await next.start();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.metadata?.count).toBe(1);
	});
	it("honors persisted remaining retry deadlines and budget over four worker restarts", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		const send = async (
			_config: Record<string, unknown>,
			payload: NotificationPayload,
		): Promise<SendResult> => {
			delivered.push(payload);
			return { success: false, retryable: true, failureCategory: "provider-unavailable" };
		};
		const deadlines = [
			"2026-10-10T12:00:30.000Z",
			"2026-10-10T12:02:30.000Z",
			"2026-10-10T12:12:30.000Z",
		];
		let current = await worker(send);
		await current.start();
		for (let index = 0; index < 3; index++) {
			expect(delivered).toHaveLength(index + 1);
			await stop();
			await fixture.restart();
			current = await worker(send);
			await current.start();
			expect(delivered).toHaveLength(index + 1);
			fixture.now = new Date(deadlines[index]!);
			await current.wake();
		}
		expect(delivered).toHaveLength(4);
		await current.wake();
		expect(delivered).toHaveLength(4);
		await fixture.run(async () => {
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "rejected", attemptOrdinal: 3 },
				}),
			).toBe(1);
			expect(
				await fixture.prisma.notificationLog.count({
					where: { channelId: fixture.channelId, status: "dead_letter" },
				}),
			).toBe(1);
		});
	});
	it("preserves unknown sender settlement without inventing failure or retry permission", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		const current = await worker(async (_config, payload) => {
			delivered.push(payload);
			throw new Error("Synthetic private transport detail.");
		});
		await current.start();
		await current.wake();
		expect(delivered).toHaveLength(1);
		await fixture.run(async () => {
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "uncertain" },
				}),
			).toBe(1);
			expect(
				await fixture.prisma.notificationLog.count({ where: { channelId: fixture.channelId } }),
			).toBe(0);
		});
	});
	it("recovers an interrupted committed marker as uncertain without dispatching it", async () => {
		await fixture.run(async () => {
			const repo = fixture.repository();
			const admitted = await repo.admit(fixture.input());
			const row = await fixture.prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId: fixture.userId, eventId: admitted.eventId },
			});
			await repo.beginAttempt(row.id);
		});
		await fixture.restart();
		const current = await worker();
		await current.start();
		expect(delivered).toEqual([]);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "uncertain" },
				}),
			).toBe(1),
		);
	});
	it("does not steal another same-epoch worker's active send", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const send = async (
			_config: Record<string, unknown>,
			payload: NotificationPayload,
		): Promise<SendResult> => {
			delivered.push(payload);
			entered();
			await barrier;
			return { success: true, retryable: false };
		};
		const first = await worker(send);
		const second = await worker(send);
		const pending = first.start();
		await started;
		try {
			await second.start();
			expect(delivered).toHaveLength(1);
		} finally {
			release();
			await pending;
		}
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationLog.count({
					where: { channelId: fixture.channelId, status: "sent" },
				}),
			).toBe(1),
		);
	});
	it("drains the actual claimed send after close without retaining future work", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const current = await worker(async (_config, payload) => {
			delivered.push(payload);
			entered();
			await barrier;
			return { success: true, retryable: false };
		});
		const pending = current.start();
		await started;
		current.closeAdmission();
		fixture.runtime.closeAdmission();
		let drained = false;
		const drain = Promise.all([current.drain(), fixture.runtime.drain()]).then(() => {
			drained = true;
		});
		try {
			await Promise.resolve();
			expect(drained).toBe(false);
		} finally {
			release();
			await pending;
			await drain;
		}
		expect(drained).toBe(true);
		await fixture.restart();
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "sent" },
				}),
			).toBe(1),
		);
	});
	it("does not lose a wake for new committed work admitted during an active send", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const current = await worker(async (_config, payload) => {
			delivered.push(payload);
			if (delivered.length === 1) {
				entered();
				await barrier;
			}
			return { success: true, retryable: false };
		});
		const pending = current.start();
		await started;
		await fixture.run(() =>
			fixture.repository().admit({
				...fixture.input(),
				payload: { ...fixture.payload, title: "Synthetic later work" },
			}),
		);
		const wake = current.wake();
		release();
		await Promise.all([pending, wake]);
		expect(delivered.map((payload) => payload.title)).toEqual([
			"Synthetic worker event",
			"Synthetic later work",
		]);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationLog.count({
					where: { channelId: fixture.channelId, status: "sent" },
				}),
			).toBe(2),
		);
	});
	it("cancels a disabled current recipient without executing a provider call", async () => {
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			await fixture.prisma.notificationChannel.updateMany({
				where: { id: fixture.channelId, userId: fixture.userId },
				data: { enabled: false },
			});
		});
		const current = await worker();
		await current.start();
		expect(delivered).toEqual([]);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "canceled" },
				}),
			).toBe(1),
		);
	});
	it("leaves an acknowledged but uncommitted result unconfirmed and never replays it", async () => {
		await fixture.run(async () => {
			await fixture.repository().admit(fixture.input());
			if (fixture.engine === "sqlite")
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "worker_log_reject" BEFORE INSERT ON "notification_logs" BEGIN SELECT RAISE(ABORT, \'synthetic result rejection\'); END',
				);
			else {
				await fixture.prisma.$executeRawUnsafe(
					"CREATE FUNCTION worker_log_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic result rejection'; END $$",
				);
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER worker_log_reject BEFORE INSERT ON "notification_logs" FOR EACH ROW EXECUTE FUNCTION worker_log_reject()',
				);
			}
		});
		const current = await worker();
		try {
			await current.start();
			await current.wake();
			expect(delivered).toHaveLength(1);
			await fixture.run(async () => {
				expect(
					await fixture.prisma.notificationOutboxDelivery.count({
						where: { userId: fixture.userId, state: "submitting" },
					}),
				).toBe(1);
				expect(
					await fixture.prisma.notificationLog.count({ where: { channelId: fixture.channelId } }),
				).toBe(0);
			});
		} finally {
			await fixture.run(async () => {
				await fixture.prisma.$executeRawUnsafe(
					fixture.engine === "sqlite"
						? 'DROP TRIGGER "worker_log_reject"'
						: 'DROP TRIGGER worker_log_reject ON "notification_logs"',
				);
				if (fixture.engine === "postgresql")
					await fixture.prisma.$executeRawUnsafe("DROP FUNCTION worker_log_reject()");
			});
		}
		await stop();
		await fixture.restart();
		const next = await worker();
		await next.start();
		expect(delivered).toHaveLength(1);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "uncertain" },
				}),
			).toBe(1),
		);
	});
	it("does not start before actual native runtime activation", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		await fixture.restart(false);
		const current = await worker();
		await expect(current.start()).rejects.toMatchObject({ statusCode: 503 });
		expect(delivered).toEqual([]);
		await fixture.runtime.activate();
		await current.start();
		expect(delivered).toHaveLength(1);
	});
	it("joins initialization canceled by close without creating a new dispatch grant", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		const current = await worker();
		const starting = current.start();
		current.closeAdmission();
		await expect(starting).rejects.toMatchObject({ category: "binding-unavailable" });
		await current.drain();
		expect(delivered).toEqual([]);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "ready", attemptToken: null },
				}),
			).toBe(1),
		);
		expect(await withCleanupMaintenanceGuard(async () => "admitted")).toBe("admitted");
	});
});
