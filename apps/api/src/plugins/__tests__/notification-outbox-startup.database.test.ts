import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envSchema } from "../../config/env.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../../lib/backup/restore-runtime-bootstrap.js";
import { createNotificationOutboxNativeFixture } from "../../lib/notifications/__tests__/notification-outbox-native-fixture.js";
import { NotificationDispatcher } from "../../lib/notifications/notification-dispatcher.js";
import type { NotificationPayload } from "../../lib/notifications/types.js";
import notificationPlugin from "../notification-service.js";

describe(`actual notification plugin startup on owned native ${process.env.NOTIFICATION_OUTBOX_TEST_ENGINE ?? "sqlite"}`, () => {
	let fixture: Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
	let app: FastifyInstance | undefined;
	const delivered: NotificationPayload[] = [];
	let observed!: () => void;
	let received: Promise<void>;
	beforeEach(async () => {
		fixture = await createNotificationOutboxNativeFixture();
		app = undefined;
		delivered.length = 0;
		received = new Promise<void>((resolve) => {
			observed = resolve;
		});
		// Only the external transport is doubled; startup, service, runtime and DB are real.
		vi.spyOn(NotificationDispatcher.prototype, "send").mockImplementation(
			async (_type, _config, payload) => {
				delivered.push(payload);
				observed();
				return { success: true, retryable: false };
			},
		);
	});
	afterEach(async () => {
		try {
			if (app) await app.close();
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
			await fixture.close();
		}
	});
	async function open() {
		app = Fastify({ logger: false });
		app.decorate("restoreRuntime", fixture.runtime);
		app.decorate("prisma", fixture.prisma);
		app.decorate("encryptor", fixture.encryptor);
		app.decorate(
			"config",
			envSchema.parse({ NODE_ENV: "test", APP_URL: "https://example.invalid" }),
		);
		app.register(fp(async () => {}, { name: "prisma" }));
		app.register(fp(async () => {}, { name: "security" }));
		registerRestoreBootstrapPlugin(app, notificationPlugin);
		registerRestoreRuntimeActivation(app);
		app.get("/synthetic-probe", async () => ({ available: true }));
		await app.ready();
	}
	async function expectDelivery() {
		let timeout!: ReturnType<typeof setTimeout>;
		try {
			await Promise.race([
				received,
				new Promise<never>((_resolve, reject) => {
					timeout = setTimeout(
						() => reject(new Error("Synthetic startup delivery did not occur.")),
						3000,
					);
				}),
			]);
		} finally {
			clearTimeout(timeout);
		}
	}
	it("starts native-bound recovery only after actual activation and does not resend on ready", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		await fixture.restart(false);
		await open();
		await expectDelivery();
		await app!.notificationService.shutdown();
		expect(delivered).toEqual([fixture.payload]);
		await app!.ready();
		expect(delivered).toHaveLength(1);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "sent" },
				}),
			).toBe(1),
		);
	});
	it("recovers one due committed digest rather than its original members", async () => {
		await fixture.run(async () => {
			for (const title of ["Synthetic member one", "Synthetic member two"])
				await fixture.repository().admit({
					...fixture.input(),
					payload: { ...fixture.payload, title },
					policy: { stage: "aggregating", windowSeconds: 300, maxBatchSize: 2 },
				});
		});
		await fixture.restart(false);
		await open();
		await expectDelivery();
		await app!.notificationService.shutdown();
		expect(delivered).toHaveLength(1);
		expect(delivered[0]?.metadata?.count).toBe(2);
	});
	it("leaves future quiet-hours work durable after real plugin close", async () => {
		await fixture.run(() =>
			fixture.repository().admit({
				...fixture.input(),
				policy: { stage: "deferred", dueAt: new Date("2099-01-01T00:00:00.000Z") },
			}),
		);
		await fixture.restart(false);
		await open();
		await app!.close();
		app = undefined;
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
	it("keeps API readiness during a real discovery-read fault and resumes safely after repair", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		await fixture.restart(false);
		await fixture.runtime.runStarting(() =>
			fixture.prisma.$executeRawUnsafe(
				'ALTER TABLE "User" RENAME TO "synthetic_notification_user_fault"',
			),
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await expect(open()).resolves.toBeUndefined();
			expect((await app!.inject({ url: "/synthetic-probe" })).statusCode).toBe(200);
			expect(delivered).toEqual([]);
			// A repeated real read failure must re-arm recovery, not abandon persisted work.
			await vi.advanceTimersByTimeAsync(30_000);
			await app!.notificationService.drain();
			expect((await app!.inject({ url: "/synthetic-probe" })).statusCode).toBe(200);
			expect(delivered).toEqual([]);
		} finally {
			await fixture.run(() =>
				fixture.prisma.$executeRawUnsafe(
					'ALTER TABLE "synthetic_notification_user_fault" RENAME TO "User"',
				),
			);
		}
		await vi.advanceTimersByTimeAsync(29_999);
		await app!.notificationService.drain();
		expect(delivered).toEqual([]);
		await vi.advanceTimersByTimeAsync(1);
		await app!.notificationService.drain();
		expect(delivered).toEqual([fixture.payload]);
		await vi.advanceTimersByTimeAsync(30_000);
		await app!.notificationService.drain();
		expect(delivered).toHaveLength(1);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "sent" },
				}),
			).toBe(1),
		);
	});
	it("closes a failed discovery wakeup without a new send or idle native lifetime", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		await fixture.restart(false);
		await fixture.runtime.runStarting(() =>
			fixture.prisma.$executeRawUnsafe(
				'ALTER TABLE "User" RENAME TO "synthetic_notification_user_fault"',
			),
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await expect(open()).resolves.toBeUndefined();
		} finally {
			await fixture.run(() =>
				fixture.prisma.$executeRawUnsafe(
					'ALTER TABLE "synthetic_notification_user_fault" RENAME TO "User"',
				),
			);
		}
		await app!.close();
		app = undefined;
		await vi.advanceTimersByTimeAsync(30_000);
		expect(delivered).toEqual([]);
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "ready", attemptToken: null },
				}),
			).toBe(1),
		);
		fixture.runtime.closeAdmission();
		await fixture.runtime.drain();
		await fixture.restart();
	});
	it("refuses new recovery grants when native admission closes during the discovery retry", async () => {
		await fixture.run(() => fixture.repository().admit(fixture.input()));
		await fixture.restart(false);
		await fixture.runtime.runStarting(() =>
			fixture.prisma.$executeRawUnsafe(
				'ALTER TABLE "User" RENAME TO "synthetic_notification_user_fault"',
			),
		);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			await open();
		} finally {
			await fixture.run(() =>
				fixture.prisma.$executeRawUnsafe(
					'ALTER TABLE "synthetic_notification_user_fault" RENAME TO "User"',
				),
			);
		}
		fixture.runtime.closeAdmission();
		await vi.advanceTimersByTimeAsync(30_000);
		await app!.notificationService.drain();
		expect(delivered).toEqual([]);
		await expect(app!.notificationService.start()).rejects.toMatchObject({ statusCode: 503 });
		await app!.close();
		app = undefined;
		await fixture.runtime.drain();
		await fixture.restart();
		await fixture.run(async () =>
			expect(
				await fixture.prisma.notificationOutboxDelivery.count({
					where: { userId: fixture.userId, state: "ready", attemptToken: null },
				}),
			).toBe(1),
		);
	});
});
