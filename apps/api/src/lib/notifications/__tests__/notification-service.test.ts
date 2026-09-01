/**
 * Unit tests for the NotificationService orchestrator.
 *
 * Validates the dispatch flow: subscription lookup, dedup, decrypt,
 * send, retry enqueue, and delivery logging.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import { NotificationService } from "../notification-service.js";
import type { NotificationPayload, SendResult } from "../types.js";

let mockPrisma: any;
let mockEncryptor: any;
let mockDispatcher: any;
let mockLogger: any;
let mockDedupGate: any;
let mockRetryHandler: any;
let service: NotificationService;

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as NotificationPayload["eventType"],
		title: "Test notification",
		body: "Test body",
		...overrides,
	};
}

function makeSubscription(
	channelId: string,
	channelType: string,
	enabled = true,
	eventType = "HUNT_COMPLETED",
) {
	return {
		id: `sub-${channelId}`,
		channelId,
		eventType,
		channel: {
			id: channelId,
			name: `Channel ${channelId}`,
			type: channelType,
			enabled,
			encryptedConfig: "encrypted-data",
			configIv: "iv-data",
		},
	};
}

describe("NotificationService", () => {
	beforeEach(() => {
		// Recreate all mocks fresh per test to prevent call-count leaking
		mockPrisma = {
			notificationSubscription: { findMany: vi.fn() },
			notificationLog: { create: vi.fn() },
			notificationChannel: { update: vi.fn(), findFirst: vi.fn() },
		};
		mockEncryptor = { decrypt: vi.fn(), encrypt: vi.fn() };
		mockDispatcher = { hasSender: vi.fn(), send: vi.fn(), test: vi.fn() };
		mockLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
		mockDedupGate = { isDuplicate: vi.fn() };
		mockRetryHandler = { enqueue: vi.fn() };

		// Set sensible defaults
		mockDedupGate.isDuplicate.mockReturnValue(false);
		mockDispatcher.hasSender.mockReturnValue(true);
		mockEncryptor.decrypt.mockReturnValue(JSON.stringify({ webhookUrl: "https://example.com" }));
		mockPrisma.notificationLog.create.mockResolvedValue({});
		mockPrisma.notificationChannel.update.mockResolvedValue({});

		service = new NotificationService(
			mockPrisma as any,
			mockEncryptor as any,
			mockDispatcher as any,
			mockLogger,
			mockDedupGate as any,
			mockRetryHandler as any,
			"http://localhost:3000",
		);
	});

	it("dispatches: subscription lookup -> decrypt -> send -> log as sent", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("ch-1", "discord"),
		]);
		mockDispatcher.send.mockResolvedValue({ success: true, retryable: false } satisfies SendResult);

		const payload = makePayload();
		await service.notify(payload);

		// Dedup check
		expect(mockDedupGate.isDuplicate).toHaveBeenCalledWith(payload);

		// Subscription lookup
		expect(mockPrisma.notificationSubscription.findMany).toHaveBeenCalledWith({
			where: { eventType: "HUNT_COMPLETED" },
			include: { channel: true },
		});

		// Decrypt
		expect(mockEncryptor.decrypt).toHaveBeenCalledWith({
			value: "encrypted-data",
			iv: "iv-data",
		});

		// Send
		expect(mockDispatcher.send).toHaveBeenCalledWith(
			"discord",
			{ webhookUrl: "https://example.com" },
			payload,
		);

		// Log delivery as "sent"
		expect(mockPrisma.notificationLog.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				channelId: "ch-1",
				channelType: "discord",
				status: "sent",
			}),
		});
	});

	it("holds mutation ownership for the complete notification dispatch", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("ch-1", "discord"),
		]);
		const sendStarted = deferred<void>();
		const finishSend = deferred<SendResult>();
		mockDispatcher.send.mockImplementation(async () => {
			sendStarted.resolve();
			return finishSend.promise;
		});

		const notification = service.notify(makePayload());
		await sendStarted.promise;
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		finishSend.resolve({ success: true, retryable: false });
		await notification;
		await expect(withCleanupMaintenanceGuard(async () => "restored")).resolves.toBe("restored");
	});

	it("rejects notification dispatch while restore owns maintenance", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("ch-1", "discord"),
		]);
		mockDispatcher.send.mockResolvedValue({ success: true, retryable: false } satisfies SendResult);
		const finishRestore = deferred<void>();
		const restore = withCleanupMaintenanceGuard(() => finishRestore.promise);

		await expect(service.notify(makePayload())).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);
		expect(mockDispatcher.send).not.toHaveBeenCalled();

		finishRestore.resolve();
		await restore;
	});

	it("keeps deferred notifications queued while restore owns maintenance", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("ch-1", "discord"),
		]);
		mockDispatcher.send.mockResolvedValue({ success: true, retryable: false } satisfies SendResult);
		const internals = service as unknown as {
			deferNotification: (payload: NotificationPayload, deferUntil: string, ruleId: string) => void;
			flushDeferredNotifications: () => Promise<void>;
		};
		internals.deferNotification(
			makePayload(),
			new Date(Date.now() - 1_000).toISOString(),
			"quiet-hours-rule",
		);
		const finishRestore = deferred<void>();
		const restore = withCleanupMaintenanceGuard(() => finishRestore.promise);

		await internals.flushDeferredNotifications();
		expect(mockDispatcher.send).not.toHaveBeenCalled();

		finishRestore.resolve();
		await restore;
		await internals.flushDeferredNotifications();
		expect(mockDispatcher.send).toHaveBeenCalledTimes(1);
		expect(mockPrisma.notificationLog.create).toHaveBeenCalledTimes(1);
	});

	it("routes a logical event to explicit and legacy fallback channels once per channel", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("explicit", "discord", true, "TRASH_DEPLOY_UNCERTAIN"),
			makeSubscription("explicit", "discord", true, "TRASH_DEPLOY_FAILED"),
			makeSubscription("legacy", "telegram", true, "TRASH_DEPLOY_FAILED"),
		]);
		mockDispatcher.send.mockResolvedValue({ success: true, retryable: false } satisfies SendResult);
		const payload = makePayload({ eventType: "TRASH_DEPLOY_UNCERTAIN" });

		await service.notify(payload, {
			userId: "user-1",
			fallbackEventTypes: ["TRASH_DEPLOY_FAILED"],
		});

		expect(mockPrisma.notificationSubscription.findMany).toHaveBeenCalledWith({
			where: {
				eventType: { in: ["TRASH_DEPLOY_UNCERTAIN", "TRASH_DEPLOY_FAILED"] },
				channel: { userId: "user-1" },
			},
			include: { channel: true },
		});
		expect(mockDispatcher.send).toHaveBeenCalledTimes(2);
		expect(mockPrisma.notificationLog.create).toHaveBeenCalledTimes(2);
		for (const [call] of mockPrisma.notificationLog.create.mock.calls) {
			expect(call.data.eventType).toBe("TRASH_DEPLOY_UNCERTAIN");
		}
	});

	it("uses an updated normalized base URL for subsequent notification links", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("ch-1", "discord"),
		]);
		mockDispatcher.send.mockResolvedValue({ success: true, retryable: false } satisfies SendResult);

		service.setBaseUrl("  https://arr.example.com/  ");
		await service.notify(makePayload({ url: "/settings" }));

		expect(mockDispatcher.send).toHaveBeenCalledWith(
			"discord",
			{ webhookUrl: "https://example.com" },
			expect.objectContaining({ url: "https://arr.example.com/settings" }),
		);
	});

	it("dedup gate blocks duplicate and returns early", async () => {
		mockDedupGate.isDuplicate.mockReturnValue(true);

		await service.notify(makePayload());

		expect(mockLogger.debug).toHaveBeenCalledWith(
			expect.objectContaining({ eventType: "HUNT_COMPLETED" }),
			"Duplicate notification suppressed",
		);
		expect(mockPrisma.notificationSubscription.findMany).not.toHaveBeenCalled();
	});

	it("enqueues retryable failure to retry handler while other channels succeed", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("ch-1", "discord"),
			makeSubscription("ch-2", "telegram"),
		]);

		// ch-1 (discord) fails retryable, ch-2 (telegram) succeeds
		mockDispatcher.send
			.mockResolvedValueOnce({
				success: false,
				retryable: true,
				error: "rate limited",
				retryAfterMs: 5000,
			} satisfies SendResult)
			.mockResolvedValueOnce({ success: true, retryable: false } satisfies SendResult);

		await service.notify(makePayload());

		// ch-1 enqueued to retry handler
		expect(mockRetryHandler.enqueue).toHaveBeenCalledWith({
			channelId: "ch-1",
			channelType: "discord",
			config: { webhookUrl: "https://example.com" },
			payload: expect.objectContaining({ title: "Test notification" }),
			retryAfterMs: 5000,
		});

		// ch-2 logged as sent
		const sentLogCall = mockPrisma.notificationLog.create.mock.calls.find(
			(call: any[]) => call[0].data.channelId === "ch-2" && call[0].data.status === "sent",
		);
		expect(sentLogCall).toBeDefined();
	});

	it("logs non-retryable failure without enqueuing to retry handler", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("ch-1", "discord"),
		]);
		mockDispatcher.send.mockResolvedValue({
			success: false,
			retryable: false,
			error: "bad webhook",
		} satisfies SendResult);

		await service.notify(makePayload());

		expect(mockRetryHandler.enqueue).not.toHaveBeenCalled();
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.objectContaining({ channelId: "ch-1", error: "bad webhook" }),
			expect.stringContaining("failed"),
		);
		expect(mockPrisma.notificationLog.create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				channelId: "ch-1",
				status: "failed",
				error: "bad webhook",
			}),
		});
	});

	it("returns early with debug log when no subscriptions exist", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([]);

		await service.notify(makePayload());

		expect(mockLogger.debug).toHaveBeenCalledWith(
			expect.objectContaining({ eventType: "HUNT_COMPLETED" }),
			"No channels subscribed to event, skipping notification",
		);
		expect(mockDispatcher.send).not.toHaveBeenCalled();
	});

	it("logs failure and continues to next channel when config decryption fails", async () => {
		mockPrisma.notificationSubscription.findMany.mockResolvedValue([
			makeSubscription("ch-1", "discord"),
			makeSubscription("ch-2", "telegram"),
		]);

		// First channel decryption fails, second succeeds
		mockEncryptor.decrypt
			.mockImplementationOnce(() => {
				throw new Error("decryption failed");
			})
			.mockReturnValueOnce(JSON.stringify({ botToken: "tok", chatId: "123" }));

		mockDispatcher.send.mockResolvedValue({ success: true, retryable: false } satisfies SendResult);

		await service.notify(makePayload());

		// ch-1 logged as failed due to decryption error
		const failedLogCall = mockPrisma.notificationLog.create.mock.calls.find(
			(call: any[]) => call[0].data.channelId === "ch-1" && call[0].data.status === "failed",
		);
		expect(failedLogCall).toBeDefined();

		// ch-2 still dispatched successfully
		expect(mockDispatcher.send).toHaveBeenCalledTimes(1);
		expect(mockDispatcher.send).toHaveBeenCalledWith(
			"telegram",
			{ botToken: "tok", chatId: "123" },
			expect.any(Object),
		);
	});
});
