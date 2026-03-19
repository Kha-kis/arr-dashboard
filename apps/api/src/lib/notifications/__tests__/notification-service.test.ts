/**
 * Unit tests for the NotificationService orchestrator.
 *
 * Validates the dispatch flow: subscription lookup, dedup, decrypt,
 * send, retry enqueue, and delivery logging.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotificationService } from "../notification-service.js";
import type { NotificationPayload, SendResult } from "../types.js";

let mockPrisma: any;
let mockEncryptor: any;
let mockDispatcher: any;
let mockLogger: any;
let mockDedupGate: any;
let mockRetryHandler: any;
let service: NotificationService;

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as NotificationPayload["eventType"],
		title: "Test notification",
		body: "Test body",
		...overrides,
	};
}

function makeSubscription(channelId: string, channelType: string, enabled = true) {
	return {
		id: `sub-${channelId}`,
		channelId,
		eventType: "HUNT_COMPLETED",
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
