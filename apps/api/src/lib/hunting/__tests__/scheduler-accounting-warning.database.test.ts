import type { FastifyInstance } from "fastify";
import { expect, it, vi } from "vitest";
import { createNotificationOutboxNativeFixture } from "../../notifications/__tests__/notification-outbox-native-fixture.js";
import { getHuntingScheduler } from "../scheduler.js";

const execute = vi.hoisted(() => vi.fn());
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
			const config = await prisma.huntConfig.create({ data: { instanceId: instance.id } });
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
			expect(current.apiCallsThisHour).toBe(0);
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
