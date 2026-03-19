/**
 * Unit tests for the RetryHandler retry/dead-letter queue.
 *
 * Uses fake timers to verify backoff scheduling, retry success/failure,
 * and graceful shutdown via flush().
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NotificationChannelType } from "@arr/shared";
import { RetryHandler } from "../retry-handler.js";
import type { NotificationPayload, SendResult } from "../types.js";

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
};

type SendFnType = (type: NotificationChannelType, config: Record<string, unknown>, payload: NotificationPayload) => Promise<SendResult>;
type LogFnType = (channelId: string, channelType: NotificationChannelType, payload: NotificationPayload, status: "sent" | "failed" | "dead_letter", error?: string, retryCount?: number) => Promise<void>;

let sendFn: ReturnType<typeof vi.fn<SendFnType>>;
let logDeliveryFn: ReturnType<typeof vi.fn<LogFnType>>;
let handler: RetryHandler;

function createPayload(title = "Test") {
	return {
		eventType: "HUNT_COMPLETED" as const,
		title,
		body: "Body text",
	};
}

describe("RetryHandler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		sendFn = vi.fn<SendFnType>();
		logDeliveryFn = vi.fn<LogFnType>().mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("logs 'sent' with retryCount=1 when retry succeeds on first attempt", async () => {
		sendFn.mockResolvedValue({ success: true, retryable: false } satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			config: { webhookUrl: "https://example.com" },
			payload: createPayload(),
		});

		expect(handler.pendingCount).toBe(1);

		// First retry fires at 30s
		await vi.advanceTimersByTimeAsync(30_000);

		expect(sendFn).toHaveBeenCalledTimes(1);
		expect(logDeliveryFn).toHaveBeenCalledWith(
			"ch-1",
			"DISCORD",
			expect.objectContaining({ title: "Test" }),
			"sent",
			undefined,
			1,
		);
		expect(handler.pendingCount).toBe(0);
	});

	it("dead-letters after max retries (3) are exhausted", async () => {
		sendFn.mockResolvedValue({ success: false, retryable: true, error: "server error" } satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			config: { webhookUrl: "https://example.com" },
			payload: createPayload(),
		});

		// Retry 1 at 30s
		await vi.advanceTimersByTimeAsync(30_000);
		expect(sendFn).toHaveBeenCalledTimes(1);

		// Retry 2 at 2min
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sendFn).toHaveBeenCalledTimes(2);

		// Retry 3 at 10min
		await vi.advanceTimersByTimeAsync(600_000);
		expect(sendFn).toHaveBeenCalledTimes(3);

		// After 3rd failure, should dead-letter (scheduleRetry called with attempt=3 >= MAX_RETRIES)
		const deadLetterCall = logDeliveryFn.mock.calls.find(
			(call: unknown[]) => call[3] === "dead_letter",
		);
		expect(deadLetterCall).toBeDefined();
		expect(deadLetterCall![4]).toContain("Exhausted 3 retries");
		expect(handler.pendingCount).toBe(0);
	});

	it("respects retryAfterMs from 429 response", async () => {
		sendFn.mockResolvedValueOnce({
			success: false,
			retryable: true,
			retryAfterMs: 5000,
			error: "rate limited",
		} satisfies SendResult);
		sendFn.mockResolvedValueOnce({ success: true, retryable: false } satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			config: { webhookUrl: "https://example.com" },
			payload: createPayload(),
			retryAfterMs: 5000,
		});

		// Should use the custom 5s delay instead of default 30s
		await vi.advanceTimersByTimeAsync(5000);
		expect(sendFn).toHaveBeenCalledTimes(1);

		// First retry returned retryable with retryAfterMs=5000, schedule next at 5s
		await vi.advanceTimersByTimeAsync(5000);
		expect(sendFn).toHaveBeenCalledTimes(2);

		expect(logDeliveryFn).toHaveBeenCalledWith(
			"ch-1",
			"DISCORD",
			expect.objectContaining({ title: "Test" }),
			"sent",
			undefined,
			2,
		);
	});

	it("immediately dead-letters on non-retryable failure during retry", async () => {
		sendFn.mockResolvedValue({
			success: false,
			retryable: false,
			error: "bad webhook URL",
		} satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			config: { webhookUrl: "https://example.com" },
			payload: createPayload(),
		});

		// First retry at 30s
		await vi.advanceTimersByTimeAsync(30_000);

		expect(sendFn).toHaveBeenCalledTimes(1);
		const deadLetterCall = logDeliveryFn.mock.calls.find(
			(call: unknown[]) => call[3] === "dead_letter",
		);
		expect(deadLetterCall).toBeDefined();
		expect(deadLetterCall![4]).toBe("bad webhook URL");
		expect(handler.pendingCount).toBe(0);
	});

	it("flush() clears all pending timers and dead-letters remaining items", () => {
		sendFn.mockResolvedValue({ success: false, retryable: true } satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			config: {},
			payload: createPayload("Item 1"),
		});
		handler.enqueue({
			channelId: "ch-2",
			channelType: "TELEGRAM",
			config: {},
			payload: createPayload("Item 2"),
		});

		expect(handler.pendingCount).toBe(2);

		handler.flush();

		expect(handler.pendingCount).toBe(0);

		// Both items should be dead-lettered with shutdown message
		const deadLetterCalls = logDeliveryFn.mock.calls.filter(
			(call: unknown[]) => call[3] === "dead_letter",
		);
		expect(deadLetterCalls).toHaveLength(2);
		expect(deadLetterCalls[0]![4]).toContain("shutdown");
		expect(deadLetterCalls[1]![4]).toContain("shutdown");
	});

	it("pendingCount reflects queue size", () => {
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		expect(handler.pendingCount).toBe(0);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			config: {},
			payload: createPayload(),
		});
		expect(handler.pendingCount).toBe(1);

		handler.enqueue({
			channelId: "ch-2",
			channelType: "TELEGRAM",
			config: {},
			payload: createPayload(),
		});
		expect(handler.pendingCount).toBe(2);

		handler.flush();
		expect(handler.pendingCount).toBe(0);
	});
});
