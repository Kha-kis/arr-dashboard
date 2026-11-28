import type { FastifyInstance } from "fastify";
import { expect, it, vi } from "vitest";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import { AggregationBuffer } from "../../notifications/aggregation-buffer.js";
import { NotificationDispatcher } from "../../notifications/notification-dispatcher.js";
import { NotificationService } from "../../notifications/notification-service.js";
import { RuleEngine } from "../../notifications/rule-engine.js";
import { getHuntingScheduler } from "../scheduler.js";

const execute = vi.hoisted(() => vi.fn());
const logger = { info() {}, warn() {}, error() {}, debug() {} };
vi.mock("../hunt-executor.js", () => ({ executeHuntWithSdk: execute }));

it("keeps the completed Hunt result and reports uncertain bookkeeping as a system error", async () => {
	const native = await createNotificationOutboxNativeFixture();
	const scheduler = getHuntingScheduler();
	try {
		await native.run(async () => {
			const prisma = native.prisma;
			const instance = await prisma.serviceInstance.create({
				data: {
					userId: native.userId,
					service: "RADARR",
					label: "Synthetic",
					baseUrl: "http://127.0.0.1:1",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			const previousMissing = new Date("2026-10-01T00:00:00.000Z");
			const previousReset = new Date("2026-10-01T01:00:00.000Z");
			const config = await prisma.huntConfig.create({
				data: {
					instanceId: instance.id,
					apiCallsThisHour: 4,
					lastMissingHunt: previousMissing,
					apiCallsResetAt: previousReset,
				},
			});
			const notify = vi.fn().mockResolvedValue(undefined);
			const rejectBookkeeping = vi.fn(async () => {
				const preceding = await prisma.huntLog.findFirstOrThrow({
					where: { instanceId: instance.id },
				});
				expect(preceding.status).toBe("completed");
				throw new Error("Synthetic counter update refusal");
			});
			const app = {
				prisma: {
					huntConfig: {
						findUnique: prisma.huntConfig.findUnique.bind(prisma.huntConfig),
						update: rejectBookkeeping,
					},
					huntLog: prisma.huntLog,
				},
				notificationService: { notify },
			} as unknown as FastifyInstance;
			execute.mockResolvedValue({
				itemsSearched: 1,
				itemsGrabbed: 1,
				searchedItems: [],
				grabbedItems: [],
				status: "completed",
				message: "Synthetic settled result",
				apiCallsMade: 1,
			});
			await scheduler.initialize(app);
			expect(scheduler.triggerManualHunt(instance.id, "missing").queued).toBe(true);
			await scheduler.shutdown();
			const logs = await prisma.huntLog.findMany({ where: { instanceId: instance.id } });
			const current = await prisma.huntConfig.findUniqueOrThrow({ where: { id: config.id } });
			expect(execute).toHaveBeenCalledOnce();
			expect(rejectBookkeeping).toHaveBeenCalledOnce();
			expect(current.apiCallsThisHour).toBe(4);
			expect(current.lastMissingHunt).toEqual(previousMissing);
			expect(current.apiCallsResetAt).toEqual(previousReset);
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({
				status: "completed",
				itemsSearched: 1,
				itemsFound: 1,
				message: "Synthetic settled result",
			});
			expect(notify.mock.calls).toHaveLength(2);
			expect(notify.mock.calls[0]?.[0]).toMatchObject({ eventType: "HUNT_CONTENT_FOUND" });
			expect(notify.mock.calls[1]).toMatchObject([
				{
					eventType: "SYSTEM_ERROR",
					title: "Hunt API usage accounting unconfirmed",
					body: "The Hunt result was saved, but its API usage count and last run time could not be confirmed.",
				},
				{ userId: native.userId },
			]);
		});
	} finally {
		await scheduler.shutdown();
		await native.close();
	}
});

it("continues to report a genuine executor failure as HUNT_FAILED", async () => {
	const native = await createNotificationOutboxNativeFixture();
	const scheduler = getHuntingScheduler();
	try {
		await native.run(async () => {
			const prisma = native.prisma;
			const instance = await prisma.serviceInstance.create({
				data: {
					userId: native.userId,
					service: "RADARR",
					label: "Synthetic",
					baseUrl: "http://127.0.0.1:1",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			await prisma.huntConfig.create({ data: { instanceId: instance.id } });
			const notify = vi.fn().mockResolvedValue(undefined);
			const app = {
				prisma: {
					huntConfig: { findUnique: prisma.huntConfig.findUnique.bind(prisma.huntConfig) },
					huntLog: prisma.huntLog,
				},
				notificationService: { notify },
			} as unknown as FastifyInstance;
			execute.mockReset().mockRejectedValue(new Error("Synthetic execution failure"));
			await scheduler.initialize(app);
			expect(scheduler.triggerManualHunt(instance.id, "missing").queued).toBe(true);
			await scheduler.shutdown();
			const logs = await prisma.huntLog.findMany({ where: { instanceId: instance.id } });
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({ status: "error", message: "Synthetic execution failure" });
			expect(notify).toHaveBeenCalledOnce();
			expect(notify.mock.calls[0]?.[0]).toMatchObject({ eventType: "HUNT_FAILED" });
		});
	} finally {
		await scheduler.shutdown();
		await native.close();
	}
});

it("does not replay a usage write after commit acknowledgement is lost", async () => {
	const native = await createNotificationOutboxNativeFixture();
	const scheduler = getHuntingScheduler();
	try {
		await native.run(async () => {
			const prisma = native.prisma;
			const instance = await prisma.serviceInstance.create({
				data: {
					userId: native.userId,
					service: "RADARR",
					label: "Synthetic",
					baseUrl: "http://127.0.0.1:1",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			const config = await prisma.huntConfig.create({ data: { instanceId: instance.id } });
			const updateAfterCommit = vi.fn(async (args: unknown) => {
				await prisma.huntConfig.update(args as Parameters<typeof prisma.huntConfig.update>[0]);
				throw new Error("Synthetic lost commit acknowledgement");
			});
			const notify = vi.fn().mockResolvedValue(undefined);
			const app = {
				prisma: {
					huntConfig: {
						findUnique: prisma.huntConfig.findUnique.bind(prisma.huntConfig),
						update: updateAfterCommit,
					},
					huntLog: prisma.huntLog,
				},
				notificationService: { notify },
			} as unknown as FastifyInstance;
			execute.mockReset().mockResolvedValue({
				itemsSearched: 1,
				itemsGrabbed: 1,
				searchedItems: [],
				grabbedItems: [],
				status: "completed",
				message: "Synthetic settled result",
				apiCallsMade: 1,
			});
			await scheduler.initialize(app);
			expect(scheduler.triggerManualHunt(instance.id, "missing").queued).toBe(true);
			await scheduler.shutdown();
			const logs = await prisma.huntLog.findMany({ where: { instanceId: instance.id } });
			const current = await prisma.huntConfig.findUniqueOrThrow({ where: { id: config.id } });
			expect(execute).toHaveBeenCalledOnce();
			expect(updateAfterCommit).toHaveBeenCalledOnce();
			expect(current.apiCallsThisHour).toBe(1);
			expect(current.lastMissingHunt).toEqual(expect.any(Date));
			expect(current.apiCallsResetAt).toEqual(expect.any(Date));
			expect(logs).toHaveLength(1);
			expect(logs[0]).toMatchObject({ status: "completed", message: "Synthetic settled result" });
			expect(notify.mock.calls).toHaveLength(2);
			expect(notify.mock.calls[0]?.[0]).toMatchObject({ eventType: "HUNT_CONTENT_FOUND" });
			expect(notify.mock.calls[1]?.[0]).toMatchObject({ eventType: "SYSTEM_ERROR" });
		});
	} finally {
		await scheduler.shutdown();
		await native.close();
	}
});

it("routes an unconfirmed usage warning only to the owner's SYSTEM_ERROR subscription through the real outbox", async () => {
	const native = await createNotificationOutboxNativeFixture();
	const scheduler = getHuntingScheduler();
	const sent: Array<{ channelId: string; userId: string; eventType: string }> = [];
	const channels = new Map<string, { channelId: string; userId: string }>();
	const dispatcher = new NotificationDispatcher();
	dispatcher.registerSender("DISCORD", {
		async send(config, payload) {
			const recipient = channels.get(String(config.webhookUrl));
			if (!recipient) throw new Error("Unexpected synthetic notification destination");
			sent.push({ ...recipient, eventType: payload.eventType });
			return { success: true, retryable: false };
		},
		async test() {
			throw new Error("No external test in this fixture");
		},
	});
	const notificationService = new NotificationService(
		native.prisma,
		native.encryptor,
		dispatcher,
		logger,
		undefined,
		undefined,
		"https://example.invalid",
		new RuleEngine(),
		(callback) => new AggregationBuffer(callback),
		{ runtime: native.runtime, clock: native.clock },
	);
	try {
		await native.run(async () => {
			const prisma = native.prisma;
			const instance = await prisma.serviceInstance.create({
				data: {
					userId: native.userId,
					service: "RADARR",
					label: "Synthetic",
					baseUrl: "http://127.0.0.1:1",
					encryptedApiKey: "synthetic",
					encryptionIv: "synthetic",
				},
			});
			const config = await prisma.huntConfig.create({
				data: { instanceId: instance.id, apiCallsThisHour: 3 },
			});
			const other = await native.createOwner();
			const failedOnlyId = "hunt-failed-only";
			const failedUrl = "https://example.invalid/hunt-failed-only";
			const failedConfig = native.encryptor.encrypt(JSON.stringify({ webhookUrl: failedUrl }));
			await prisma.notificationChannel.create({
				data: {
					id: failedOnlyId,
					userId: native.userId,
					name: "Synthetic HUNT_FAILED only",
					type: "DISCORD",
					encryptedConfig: failedConfig.value,
					configIv: failedConfig.iv,
					subscriptions: { create: { eventType: "HUNT_FAILED" } },
				},
			});
			const errorId = "owner-system-error";
			const errorUrl = "https://example.invalid/owner-system-error";
			const errorConfig = native.encryptor.encrypt(JSON.stringify({ webhookUrl: errorUrl }));
			await prisma.notificationChannel.create({
				data: {
					id: errorId,
					userId: native.userId,
					name: "Synthetic owner system errors",
					type: "DISCORD",
					encryptedConfig: errorConfig.value,
					configIv: errorConfig.iv,
					subscriptions: { create: { eventType: "SYSTEM_ERROR" } },
				},
			});
			const otherUrl = "https://example.invalid/other-system-error";
			const otherConfig = native.encryptor.encrypt(JSON.stringify({ webhookUrl: otherUrl }));
			await prisma.notificationChannel.update({
				where: { id: other.channelId, userId: other.userId },
				data: {
					encryptedConfig: otherConfig.value,
					configIv: otherConfig.iv,
					subscriptions: { create: { eventType: "SYSTEM_ERROR" } },
				},
			});
			channels.set(failedUrl, { channelId: failedOnlyId, userId: native.userId });
			channels.set(errorUrl, { channelId: errorId, userId: native.userId });
			channels.set(otherUrl, { channelId: other.channelId, userId: other.userId });

			const rejectBookkeeping = vi.fn(async () => {
				const saved = await prisma.huntLog.findFirstOrThrow({ where: { instanceId: instance.id } });
				expect(saved.status).toBe("completed");
				throw new Error("Synthetic accounting write refusal");
			});
			const app = {
				prisma: {
					huntConfig: {
						findUnique: prisma.huntConfig.findUnique.bind(prisma.huntConfig),
						update: rejectBookkeeping,
					},
					huntLog: prisma.huntLog,
				},
				notificationService,
			} as unknown as FastifyInstance;
			execute.mockReset().mockResolvedValue({
				itemsSearched: 1,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				status: "completed",
				message: "Synthetic acknowledged Hunt result",
				apiCallsMade: 2,
			});
			await scheduler.initialize(app);
			expect(scheduler.triggerManualHunt(instance.id, "missing").queued).toBe(true);
			await scheduler.shutdown();
			await notificationService.drain();

			const hunt = await prisma.huntLog.findFirstOrThrow({ where: { instanceId: instance.id } });
			const current = await prisma.huntConfig.findUniqueOrThrow({ where: { id: config.id } });
			expect(hunt).toMatchObject({
				status: "completed",
				itemsSearched: 1,
				itemsFound: 0,
				message: "Synthetic acknowledged Hunt result",
			});
			expect(current.apiCallsThisHour).toBe(3);
			expect(current.lastMissingHunt).toBeNull();
			expect(current.apiCallsResetAt).toBeNull();

			const systemEvents = await prisma.notificationOutboxEvent.findMany({
				where: { eventType: "SYSTEM_ERROR" },
			});
			expect(systemEvents).toHaveLength(1);
			expect(systemEvents[0]).toMatchObject({ userId: native.userId, stage: "terminal" });
			const delivery = await prisma.notificationOutboxDelivery.findMany({
				where: { eventId: systemEvents[0]!.id },
			});
			expect(delivery).toHaveLength(1);
			expect(delivery[0]).toMatchObject({
				userId: native.userId,
				channelId: errorId,
				state: "sent",
				outcomeCategory: "acknowledged",
			});
			const history = await prisma.notificationLog.findMany();
			expect(history).toHaveLength(1);
			expect(history[0]).toMatchObject({
				channelId: errorId,
				eventType: "SYSTEM_ERROR",
				status: "sent",
				title: "Hunt API usage accounting unconfirmed",
			});
			expect(sent).toEqual([
				{ channelId: errorId, userId: native.userId, eventType: "SYSTEM_ERROR" },
			]);
			expect(sent.some((entry) => entry.eventType === "HUNT_FAILED")).toBe(false);
			expect(rejectBookkeeping).toHaveBeenCalledOnce();
		});
	} finally {
		await scheduler.shutdown();
		await notificationService.shutdown();
		await native.close();
	}
});
