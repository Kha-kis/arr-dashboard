import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AggregationBuffer } from "../aggregation-buffer.js";
import { DedupGate } from "../dedup-gate.js";
import { NotificationDispatcher } from "../notification-dispatcher.js";
import { NotificationService } from "../notification-service.js";
import { RetryHandler } from "../retry-handler.js";
import { RuleEngine } from "../rule-engine.js";
import type { NotificationPayload, SendResult } from "../types.js";
import { createNotificationOutboxNativeFixture } from "./notification-outbox-native-fixture.js";

describe(`actual notification service outbox on owned native ${process.env.NOTIFICATION_OUTBOX_TEST_ENGINE ?? "sqlite"}`, () => {
	let fixture: Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
	const delivered: NotificationPayload[] = [];
	let services: { service: NotificationService; retry: RetryHandler; dedup: DedupGate }[];
	const logger = { info() {}, warn() {}, error() {}, debug() {} };
	function service(
		withRuntime = true,
		send: (
			config: Record<string, unknown>,
			payload: NotificationPayload,
		) => Promise<SendResult> = async (_config, payload) => {
			delivered.push(payload);
			return { success: true, retryable: false };
		},
	) {
		const dispatcher = new NotificationDispatcher();
		dispatcher.registerSender("DISCORD", {
			send,
			async test() {
				throw new Error("No external Test in this fixture.");
			},
		});
		const dedup = new DedupGate();
		const retry = new RetryHandler(dispatcher.send.bind(dispatcher), async () => {}, logger);
		const result = new NotificationService(
			fixture.prisma,
			fixture.encryptor,
			dispatcher,
			logger,
			dedup,
			retry,
			"https://example.invalid",
			new RuleEngine(),
			(callback) => new AggregationBuffer(callback),
			withRuntime ? { runtime: fixture.runtime, clock: fixture.clock } : undefined,
		);
		services.push({ service: result, retry, dedup });
		return result;
	}
	async function stop() {
		for (const entry of services) {
			await entry.service.shutdown();
			await entry.retry.flush();
			entry.dedup.destroy();
		}
	}
	async function quietHours() {
		fixture.now = new Date();
		const start = new Date(Date.now() - 3_600_000).toISOString().slice(11, 16);
		const end = new Date(Date.now() + 3_600_000).toISOString().slice(11, 16);
		await fixture.run(() =>
			fixture.prisma.notificationRule.create({
				data: {
					userId: fixture.userId,
					name: "Synthetic quiet hours",
					action: "quiet_hours",
					conditions: "[]",
					quietHoursStart: start,
					quietHoursEnd: end,
					quietHoursTimezone: "UTC",
				},
			}),
		);
	}
	beforeEach(async () => {
		fixture = await createNotificationOutboxNativeFixture();
		delivered.length = 0;
		services = [];
	});
	afterEach(async () => {
		await stop();
		await fixture.close();
	});
	it("commits the actual submitting marker before a sender observes any work", async () => {
		let committedBeforeSend = false;
		const current = service(true, async (_config, payload) => {
			delivered.push(payload);
			committedBeforeSend =
				(await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "submitting", attemptToken: { not: null } },
				})) === 1;
			return { success: true, retryable: false };
		});
		await fixture.run(() => current.notify(fixture.payload));
		expect(committedBeforeSend).toBe(true);
		expect(delivered).toEqual([fixture.payload]);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "sent" },
				}),
			).toBe(1),
		);
	});
	it("refuses durable admission failure before making any provider call", async () => {
		await fixture.run(async () => {
			if (fixture.engine === "sqlite")
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER "service_event_reject" BEFORE INSERT ON "NotificationOutboxEvent" BEGIN SELECT RAISE(ABORT, \'synthetic admission rejection\'); END',
				);
			else {
				await fixture.prisma.$executeRawUnsafe(
					"CREATE FUNCTION service_event_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic admission rejection'; END $$",
				);
				await fixture.prisma.$executeRawUnsafe(
					'CREATE TRIGGER service_event_reject BEFORE INSERT ON "NotificationOutboxEvent" FOR EACH ROW EXECUTE FUNCTION service_event_reject()',
				);
			}
		});
		const current = service();
		try {
			await expect(fixture.run(() => current.notify(fixture.payload))).rejects.toMatchObject({
				category: "storage-unavailable",
			});
			expect(delivered).toEqual([]);
			await fixture.run(async () =>
				expect(
					await fixture.prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
				).toBe(0),
			);
		} finally {
			await fixture.run(async () => {
				await fixture.prisma.$executeRawUnsafe(
					fixture.engine === "sqlite"
						? 'DROP TRIGGER "service_event_reject"'
						: 'DROP TRIGGER service_event_reject ON "NotificationOutboxEvent"',
				);
				if (fixture.engine === "postgresql")
					await fixture.prisma.$executeRawUnsafe("DROP FUNCTION service_event_reject()");
			});
		}
		await fixture.run(() => current.notify(fixture.payload));
		expect(delivered).toHaveLength(1);
	});
	it("persists accepted aggregation instead of relying on the legacy buffer", async () => {
		await fixture.run(() =>
			fixture.prisma.notificationAggregationConfig.create({
				data: {
					userId: fixture.userId,
					eventType: "HUNT_COMPLETED",
					windowSeconds: 300,
					maxBatchSize: 10,
					enabled: true,
				},
			}),
		);
		const current = service();
		await fixture.run(() => current.notify(fixture.payload));
		expect(delivered).toEqual([]);
		await fixture.run(async () => {
			expect(
				await fixture.prisma.notificationOutboxEvent.count({
					where: { userId: fixture.userId, stage: "aggregating" },
				}),
			).toBe(1);
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "waiting" },
				}),
			).toBe(1);
		});
	});
	it("persists quiet-hours intent and its selected recipient before returning", async () => {
		await quietHours();
		const current = service();
		await fixture.run(() => current.notify(fixture.payload));
		expect(delivered).toEqual([]);
		await fixture.run(async () => {
			const event = await fixture.prisma.notificationOutboxEvent.findFirstOrThrow({
				where: { userId: fixture.userId },
			});
			expect(event.stage).toBe("deferred");
			expect(event.dueAt > fixture.now).toBe(true);
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, channelId: fixture.channelId, state: "waiting" },
				}),
			).toBe(1);
		});
	});
	it("preserves future quiet-hours work without a forced shutdown dead-letter", async () => {
		await quietHours();
		const current = service();
		await fixture.run(() => current.notify(fixture.payload));
		await current.shutdown();
		expect(delivered).toEqual([]);
		await fixture.run(async () => {
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "waiting" },
				}),
			).toBe(1);
			expect(
				await fixture.prisma.notificationLog.count({ where: { channelId: fixture.channelId } }),
			).toBe(0);
		});
	});
	it("retains committed content deduplication across a service and native restart", async () => {
		const first = service();
		await fixture.run(() => first.notify(fixture.payload));
		await stop();
		await fixture.restart();
		const next = service();
		await fixture.run(() => next.notify(fixture.payload));
		expect(delivered).toHaveLength(1);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(1),
		);
	});
	it("keeps identical content and acceptance authority separate for each owner", async () => {
		const { userId: otherId } = await fixture.createOwner();
		const current = service();
		await fixture.run(() => current.notify(fixture.payload));
		expect(delivered).toHaveLength(2);
		await fixture.run(async () => {
			expect(
				await fixture.prisma.notificationOutboxEvent.count({ where: { userId: fixture.userId } }),
			).toBe(1);
			expect(
				await fixture.prisma.notificationOutboxEvent.count({ where: { userId: otherId } }),
			).toBe(1);
		});
	});
	it("durably accepts an already-admitted producer's handoff during close", async () => {
		const current = service();
		let release!: () => void;
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const producer = fixture.run(() =>
			current.runProducer(async () => {
				entered();
				await barrier;
				await current.notify(fixture.payload);
			}),
		);
		await started;
		const shutdown = current.shutdown();
		release();
		await Promise.all([producer, shutdown]);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "ready" },
				}),
			).toBe(1),
		);
		expect(delivered).toEqual([]);
	});
	it("does not fall back to a memory-only sender when durable runtime was not supplied", async () => {
		const current = service(false);
		await expect(fixture.run(() => current.notify(fixture.payload))).rejects.toMatchObject({
			category: "binding-unavailable",
		});
		expect(delivered).toEqual([]);
	});
	it("recovers committed work on ordinary service startup without a new notify call", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		await fixture.restart();
		const current = service();
		await current.start();
		// Shutdown joins the startup worker; it must not require a new producer.
		await current.drain();
		expect(delivered).toEqual([fixture.payload]);
		await current.start();
		await current.drain();
		expect(delivered).toHaveLength(1);
	});
	it("rejects recovery before activation then admits it after the real runtime opens", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		await fixture.restart(false);
		const current = service();
		await expect(current.start()).rejects.toMatchObject({ statusCode: 503 });
		expect(delivered).toEqual([]);
		await fixture.runtime.activate();
		await current.start();
		await current.drain();
		expect(delivered).toEqual([fixture.payload]);
	});
	it("returns from recovery startup while joining an actual slow sender during close", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		let entered!: () => void;
		let release!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		const current = service(true, async (_config, payload) => {
			delivered.push(payload);
			entered();
			await barrier;
			return { success: true, retryable: false };
		});
		try {
			await current.start();
			await started;
			let closed = false;
			const closing = current.shutdown().then(() => {
				closed = true;
			});
			await Promise.resolve();
			expect(closed).toBe(false);
			release();
			await closing;
			expect(closed).toBe(true);
		} finally {
			release();
		}
		expect(delivered).toHaveLength(1);
	});
});
