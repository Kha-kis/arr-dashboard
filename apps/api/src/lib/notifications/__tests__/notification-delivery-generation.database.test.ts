import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Encryptor } from "../../auth/encryption.js";
import type { PrismaClientInstance } from "../../prisma.js";
import { NotificationDispatcher } from "../notification-dispatcher.js";
import { NotificationService } from "../notification-service.js";
import type { SendResult } from "../types.js";
import { createNotificationOutboxNativeFixture } from "./notification-outbox-native-fixture.js";

let fixture: Awaited<ReturnType<typeof createNotificationOutboxNativeFixture>>;
let prisma: PrismaClientInstance;
let encryptor: Encryptor;
let owner: string;
let otherOwner: string;
let channelId: string;
let service: NotificationService;
let release: (result: SendResult) => void;
let pendingReleases: ((result: SendResult) => void)[];
let started: Promise<void>;
let dispatcher: NotificationDispatcher;
let sends: number;
const payload = {
	eventType: "HUNT_COMPLETED" as const,
	title: "Synthetic event",
	body: "Synthetic body",
};
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const previousTime = new Date("2026-01-01T00:00:00Z");
const outcomes: SendResult[] = [
	{ success: true, retryable: false },
	{ success: false, retryable: false, failureCategory: "authentication" },
];

beforeEach(async () => {
	fixture = await createNotificationOutboxNativeFixture();
	prisma = fixture.prisma;
	encryptor = fixture.encryptor;
	owner = fixture.userId;
	channelId = fixture.channelId;
	otherOwner = (await fixture.createOwner()).userId;
	await fixture.run(async () => {
		const config = encryptor.encrypt(
			JSON.stringify({ webhookUrl: "https://synthetic.invalid/original" }),
		);
		await prisma.notificationChannel.update({
			where: { id: channelId, userId: owner },
			data: {
				encryptedConfig: config.value,
				configIv: config.iv,
				lastSentAt: previousTime,
				lastSendResult: "failed",
			},
		});
	});
	pendingReleases = [];
	sends = 0;
	let markStarted!: () => void;
	started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const completion = new Promise<SendResult>((resolve) => {
		release = resolve;
		pendingReleases.push(resolve);
	});
	dispatcher = new NotificationDispatcher();
	dispatcher.registerSender("DISCORD", {
		send: async () => {
			sends++;
			markStarted();
			return completion;
		},
		test: async () => {},
	});
	service = new NotificationService(
		prisma,
		encryptor,
		dispatcher,
		logger,
		undefined,
		undefined,
		"https://synthetic.invalid",
		undefined,
		undefined,
		{ runtime: fixture.runtime, clock: fixture.clock },
	);
});

afterEach(async () => {
	for (const complete of pendingReleases ?? [])
		complete({ success: false, retryable: false, failureCategory: "unknown" });
	try {
		await service?.shutdown();
	} finally {
		vi.restoreAllMocks();
		await fixture?.close();
	}
});

async function advanceToRetry() {
	const pending = await prisma.notificationOutboxDelivery.findFirstOrThrow({
		where: { userId: owner, channelId, state: "retry-waiting" },
	});
	expect(pending.attemptOrdinal).toBe(1);
	expect(pending.nextAttemptAt).toEqual(new Date(fixture.now.getTime() + 1));
	expect(pending.attemptToken).toBeNull();
	expect(pending.dispatchedAt).toBeNull();
	fixture.now = pending.nextAttemptAt;
}

describe("retry and shutdown completion use actual attempted settings", () => {
	it.each(outcomes)(
		"records retry $success on its freshly resolved unchanged generation",
		async (outcome) =>
			fixture.run(async () => {
				const sending = service.notify(payload, { userId: owner });
				await started;
				release({ success: false, retryable: true, retryAfterMs: 1 });
				await sending;
				const attempted = encryptor.encrypt(
					JSON.stringify({ webhookUrl: "https://synthetic.invalid/fresh-retry" }),
				);
				await prisma.notificationChannel.update({
					where: { id: channelId },
					data: {
						encryptedConfig: attempted.value,
						configIv: attempted.iv,
						lastSentAt: previousTime,
						lastSendResult: "success",
					},
				});
				const configs: Record<string, unknown>[] = [];
				dispatcher.registerSender("DISCORD", {
					send: async (config) => {
						configs.push(config);
						return outcome;
					},
					test: async () => {},
				});
				await advanceToRetry();
				await service.start();
				await service.drain();
				expect(configs).toEqual([{ webhookUrl: "https://synthetic.invalid/fresh-retry" }]);
				const channel = await prisma.notificationChannel.findUniqueOrThrow({
					where: { id: channelId },
				});
				expect(channel.lastSentAt!.getTime()).toBeGreaterThan(previousTime.getTime());
				expect(channel.lastSendResult).toBe(outcome.success ? "success" : "failed");
				expect(
					await prisma.notificationLog.count({ where: { channelId: channelId, retryCount: 1 } }),
				).toBe(1);
			}),
	);

	it.each(outcomes)(
		"fences a late retry $success after capturing fresh retry settings",
		async (outcome) =>
			fixture.run(async () => {
				const sending = service.notify(payload, { userId: owner });
				await started;
				release({ success: false, retryable: true, retryAfterMs: 1 });
				await sending;
				const attempted = encryptor.encrypt(
					JSON.stringify({ webhookUrl: "https://synthetic.invalid/retry" }),
				);
				await prisma.notificationChannel.update({
					where: { id: channelId },
					data: {
						encryptedConfig: attempted.value,
						configIv: attempted.iv,
					},
				});
				let markRetryStarted!: () => void;
				const retryStarted = new Promise<void>((resolve) => {
					markRetryStarted = resolve;
				});
				let releaseRetry!: (result: SendResult) => void;
				const completion = new Promise<SendResult>((resolve) => {
					releaseRetry = resolve;
					pendingReleases.push(resolve);
				});
				const configs: Record<string, unknown>[] = [];
				dispatcher.registerSender("DISCORD", {
					send: async (config) => {
						configs.push(config);
						markRetryStarted();
						return completion;
					},
					test: async () => {},
				});
				await advanceToRetry();
				await service.start();
				await retryStarted;
				const replacement = encryptor.encrypt(
					JSON.stringify({ webhookUrl: "https://synthetic.invalid/after-retry" }),
				);
				await prisma.notificationChannel.update({
					where: { id: channelId },
					data: {
						encryptedConfig: replacement.value,
						configIv: replacement.iv,
						lastSentAt: previousTime,
						lastSendResult: "success",
					},
				});
				releaseRetry(outcome);
				await service.drain();
				expect(configs).toEqual([{ webhookUrl: "https://synthetic.invalid/retry" }]);
				const channel = await prisma.notificationChannel.findUniqueOrThrow({
					where: { id: channelId },
				});
				expect(channel.lastSentAt).toEqual(previousTime);
				expect(channel.lastSendResult).toBe("success");
				const history = await prisma.notificationLog.findMany({
					where: { channelId: channelId },
					orderBy: { retryCount: "asc" },
				});
				expect(history.map((row) => [row.status, row.retryCount])).toEqual([
					["failed", 0],
					[outcome.success ? "sent" : "dead_letter", 1],
				]);
			}),
	);

	it("shutdown preserves the scheduled retry without labeling replacement settings as attempted", async () =>
		fixture.run(async () => {
			const sending = service.notify(payload, { userId: owner });
			await started;
			release({ success: false, retryable: true });
			await sending;
			const replacement = encryptor.encrypt(
				JSON.stringify({ webhookUrl: "https://synthetic.invalid/shutdown-replacement" }),
			);
			await prisma.notificationChannel.update({
				where: { id: channelId },
				data: {
					encryptedConfig: replacement.value,
					configIv: replacement.iv,
					lastSentAt: previousTime,
					lastSendResult: "success",
				},
			});
			const pending = await prisma.notificationOutboxDelivery.findFirstOrThrow({
				where: { userId: owner, channelId, state: "retry-waiting" },
			});
			expect(pending.attemptOrdinal).toBe(1);
			expect(pending.nextAttemptAt).toEqual(new Date(fixture.now.getTime() + 30_000));
			await service.shutdown();
			expect(
				await prisma.notificationOutboxDelivery.findUniqueOrThrow({ where: { id: pending.id } }),
			).toEqual(pending);
			expect(sends).toBe(1);
			const channel = await prisma.notificationChannel.findUniqueOrThrow({
				where: { id: channelId },
			});
			expect(channel.lastSentAt).toEqual(previousTime);
			expect(channel.lastSendResult).toBe("success");
			expect(
				await prisma.notificationLog.findMany({
					where: { channelId: channelId, status: "dead_letter" },
				}),
			).toHaveLength(0);
			expect(await prisma.notificationLog.findMany({ where: { channelId } })).toMatchObject([
				{ status: "failed", retryCount: 0 },
			]);
		}));
});
describe("ordinary delivery completion belongs to the exact original connection", () => {
	it.each(["type", "iv"] as const)(
		"fences a pending outcome after only %s changes",
		async (change) =>
			fixture.run(async () => {
				const sending = service.notify(payload, { userId: owner });
				await started;
				await prisma.notificationChannel.update({
					where: { id: channelId },
					data: change === "type" ? { type: "TELEGRAM" } : { configIv: "replacement-iv" },
				});
				release({ success: true, retryable: false });
				await sending;
				const channel = await prisma.notificationChannel.findUniqueOrThrow({
					where: { id: channelId },
				});
				expect(channel.lastSentAt).toEqual(previousTime);
				expect(channel.lastSendResult).toBe("failed");
				expect(
					await prisma.notificationLog.findMany({ where: { channelId: channelId } }),
				).toMatchObject([{ channelType: "DISCORD", status: "sent" }]);
			}),
	);

	it.each(outcomes)(
		"records unchanged connection $success despite a metadata edit",
		async (outcome) =>
			fixture.run(async () => {
				const sending = service.notify(payload, { userId: owner });
				await started;
				await prisma.notificationChannel.update({
					where: { id: channelId },
					data: { name: "Synthetic renamed", enabled: false },
				});
				release(outcome);
				await sending;
				const channel = await prisma.notificationChannel.findUniqueOrThrow({
					where: { id: channelId },
				});
				expect(channel.lastSentAt!.getTime()).toBeGreaterThan(previousTime.getTime());
				expect(channel.lastSendResult).toBe(outcome.success ? "success" : "failed");
				expect(channel.name).toBe("Synthetic renamed");
				expect(channel.enabled).toBe(false);
				expect(await prisma.notificationLog.count({ where: { channelId: channelId } })).toBe(1);
			}),
	);

	it.each([
		"missing",
		"wrong id",
		"wrong type",
		"missing owner",
		"missing ciphertext",
		"missing iv",
	] as const)("rejects %s attempt context without inventing a current generation", async (kind) =>
		fixture.run(async () => {
			const channel = await prisma.notificationChannel.findUniqueOrThrow({
				where: { id: channelId },
			});
			const context =
				kind === "missing"
					? undefined
					: {
							id: kind === "wrong id" ? "another-channel" : channel.id,
							userId: kind === "missing owner" ? "" : channel.userId,
							type: kind === "wrong type" ? "TELEGRAM" : channel.type,
							encryptedConfig: kind === "missing ciphertext" ? "" : channel.encryptedConfig,
							configIv: kind === "missing iv" ? "" : channel.configIv,
						};
			await service.logDelivery(channelId, "DISCORD", payload, "sent", undefined, 0, context);
			expect(await prisma.notificationLog.count({ where: { channelId: channelId } })).toBe(0);
			expect(
				(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: channelId } }))
					.lastSentAt,
			).toEqual(previousTime);
		}),
	);

	it("rolls back a failed history transaction while independently retaining status", async () =>
		fixture.run(async () => {
			const context = await prisma.notificationChannel.findUniqueOrThrow({
				where: { id: channelId },
			});
			const transaction = prisma.$transaction.bind(prisma);
			vi.spyOn(prisma, "$transaction").mockImplementationOnce(async (operation) =>
				transaction(async (tx) => {
					await operation(tx);
					throw new Error("Synthetic transaction rollback");
				}),
			);
			await expect(
				service.logDelivery(channelId, "DISCORD", payload, "sent", undefined, 0, context),
			).rejects.toThrow("Synthetic transaction rollback");
			expect(await prisma.notificationLog.count({ where: { channelId: channelId } })).toBe(0);
			expect(
				(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: channelId } }))
					.lastSendResult,
			).toBe("success");
		}));

	it("retains history when the independent status write fails", async () =>
		fixture.run(async () => {
			const context = await prisma.notificationChannel.findUniqueOrThrow({
				where: { id: channelId },
			});
			vi.spyOn(prisma.notificationChannel, "updateMany").mockRejectedValueOnce(
				new Error("Synthetic status failure"),
			);
			await expect(
				service.logDelivery(channelId, "DISCORD", payload, "sent", undefined, 0, context),
			).rejects.toThrow("Synthetic status failure");
			expect(await prisma.notificationLog.count({ where: { channelId: channelId } })).toBe(1);
			expect(
				(await prisma.notificationChannel.findUniqueOrThrow({ where: { id: channelId } }))
					.lastSentAt,
			).toEqual(previousTime);
		}));

	it.each(outcomes)(
		"preserves a rotated connection's status while retaining its owner's $success attempt history",
		async (outcome) =>
			fixture.run(async () => {
				const sending = service.notify(payload, { userId: owner });
				await started;
				const next = encryptor.encrypt(
					JSON.stringify({ webhookUrl: "https://synthetic.invalid/replacement" }),
				);
				await prisma.notificationChannel.update({
					where: { id: channelId },
					data: {
						encryptedConfig: next.value,
						configIv: next.iv,
						lastSentAt: previousTime,
						lastSendResult: "success",
					},
				});
				release(outcome);
				await sending;
				const channel = await prisma.notificationChannel.findUniqueOrThrow({
					where: { id: channelId },
				});
				expect(channel.lastSentAt).toEqual(previousTime);
				expect(channel.lastSendResult).toBe("success");
				expect(channel.encryptedConfig).toBe(next.value);
				const history = await prisma.notificationLog.findMany({ where: { channelId: channelId } });
				expect(history).toHaveLength(1);
				expect(history[0]?.status).toBe(outcome.success ? "sent" : "failed");
			}),
	);

	it("does not attach the previous owner's in-flight outcome to a new owner", async () =>
		fixture.run(async () => {
			const sending = service.notify(payload, { userId: owner });
			await started;
			await prisma.notificationChannel.update({
				where: { id: channelId },
				data: { userId: otherOwner },
			});
			release({ success: true, retryable: false });
			await sending;
			const channel = await prisma.notificationChannel.findUniqueOrThrow({
				where: { id: channelId },
			});
			expect(channel.lastSentAt).toEqual(previousTime);
			expect(channel.lastSendResult).toBe("failed");
			expect(await prisma.notificationLog.count({ where: { channelId: channelId } })).toBe(0);
		}));

	it("does not create an orphan attempt history after the channel is deleted", async () =>
		fixture.run(async () => {
			const sending = service.notify(payload, { userId: owner });
			await started;
			await prisma.notificationChannel.delete({ where: { id: channelId } });
			release({ success: true, retryable: false });
			await sending;
			expect(await prisma.notificationLog.count({ where: { channelId: channelId } })).toBe(0);
		}));
});
