/**
 * Unit tests for the RetryHandler retry/dead-letter queue.
 *
 * Uses fake timers to verify backoff scheduling, retry success/failure,
 * and graceful shutdown via flush().
 */

import type { NotificationChannelType } from "@arr/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CleanupMaintenanceConflictError,
	withCleanupMaintenanceGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import { RetryHandler } from "../retry-handler.js";
import type {
	DeliveryAttemptContext,
	DeliveryRecipient,
	NotificationPayload,
	SendResult,
} from "../types.js";

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
};

type SendFnType = (
	type: NotificationChannelType,
	config: Record<string, unknown>,
	payload: NotificationPayload,
) => Promise<SendResult>;
type LogFnType = (
	channelId: string,
	channelType: NotificationChannelType,
	payload: NotificationPayload,
	status: "sent" | "failed" | "dead_letter",
	error?: string,
	retryCount?: number,
	attemptContext?: DeliveryAttemptContext,
) => Promise<void>;

let sendFn: ReturnType<typeof vi.fn<SendFnType>>;
let logDeliveryFn: ReturnType<typeof vi.fn<LogFnType>>;
let handler: RetryHandler;

function context(id = "ch-1", type = "DISCORD"): DeliveryAttemptContext {
	return { id, userId: "owner", type, encryptedConfig: "encrypted", configIv: "iv" };
}

function recipient(
	config: Record<string, unknown> = {},
	id = "ch-1",
	type = "DISCORD",
): DeliveryRecipient {
	return { config, context: context(id, type) };
}

function createPayload(title = "Test") {
	return {
		eventType: "HUNT_COMPLETED" as const,
		title,
		body: "Body text",
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
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
			attemptContext: context(),
			resolveRecipient: async () => recipient({ webhookUrl: "https://example.com" }),
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
			context(),
		);
		expect(handler.pendingCount).toBe(0);
	});

	it("shutdown retains the latest actual retry generation instead of newly revalidated settings", async () => {
		let current = recipient({ webhookUrl: "retry-destination" });
		current = {
			...current,
			context: { ...current.context, encryptedConfig: "retry-encrypted", configIv: "retry-iv" },
		};
		const attempted = { ...current.context };
		sendFn.mockResolvedValue({ success: false, retryable: true });
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => current,
			payload: createPayload(),
		});
		await vi.advanceTimersByTimeAsync(30_000);
		expect(sendFn).toHaveBeenCalledWith(
			"DISCORD",
			{ webhookUrl: "retry-destination" },
			createPayload(),
		);
		current = {
			config: { webhookUrl: "shutdown-destination" },
			context: { ...context(), encryptedConfig: "shutdown-encrypted" },
		};
		await handler.flush();
		expect(sendFn).toHaveBeenCalledTimes(1);
		expect(logDeliveryFn.mock.calls).toHaveLength(1);
		expect(logDeliveryFn.mock.calls[0]?.[6]).toEqual(attempted);
		expect(logDeliveryFn.mock.calls[0]?.[3]).toBe("dead_letter");
	});

	it("freezes the original attempt when enqueue receives a mutable caller object", async () => {
		const original = { ...context() };
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: original,
			resolveRecipient: async () => recipient(),
			payload: createPayload(),
		});
		original.encryptedConfig = "never-attempted";
		await handler.flush();
		expect(logDeliveryFn.mock.calls[0]?.[6]).toEqual(context());
	});

	it.each(["owner", "id", "type", "missing context"] as const)(
		"rejects a resolved recipient with mismatched %s before send or shutdown logging",
		async (mismatch) => {
			const resolved = recipient();
			const invalid =
				mismatch === "missing context"
					? { config: resolved.config }
					: {
							...resolved,
							context: {
								...resolved.context,
								[mismatch === "owner" ? "userId" : mismatch]: "wrong",
							},
						};
			handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
			handler.enqueue({
				channelId: "ch-1",
				channelType: "DISCORD",
				attemptContext: context(),
				resolveRecipient: async () => invalid as DeliveryRecipient,
				payload: createPayload(),
			});
			await vi.advanceTimersByTimeAsync(30_000);
			await handler.flush();
			expect(sendFn).not.toHaveBeenCalled();
			expect(logDeliveryFn).not.toHaveBeenCalled();
			expect(handler.pendingCount).toBe(0);
		},
	);

	it("does not accept a queued item without original attempt evidence", async () => {
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: undefined as unknown as DeliveryAttemptContext,
			resolveRecipient: async () => recipient(),
			payload: createPayload(),
		});
		await vi.advanceTimersByTimeAsync(30_000);
		await handler.flush();
		expect(sendFn).not.toHaveBeenCalled();
		expect(logDeliveryFn).not.toHaveBeenCalled();
	});

	it("holds mutation ownership across retry dispatch and delivery logging", async () => {
		const sendStarted = deferred<void>();
		const finishSend = deferred<SendResult>();
		sendFn.mockImplementation(async () => {
			sendStarted.resolve();
			return finishSend.promise;
		});
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => recipient({ webhookUrl: "https://example.com" }),
			payload: createPayload(),
		});

		const advance = vi.advanceTimersByTimeAsync(30_000);
		await sendStarted.promise;
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		finishSend.resolve({ success: true, retryable: false });
		await advance;
		expect(logDeliveryFn).toHaveBeenCalledTimes(1);
	});

	it("does not dispatch a retry while restore owns maintenance", async () => {
		sendFn.mockResolvedValue({ success: true, retryable: false } satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => recipient({ webhookUrl: "https://example.com" }),
			payload: createPayload(),
		});
		const finishRestore = deferred<void>();
		const restore = withCleanupMaintenanceGuard(() => finishRestore.promise);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(sendFn).not.toHaveBeenCalled();
		expect(handler.pendingCount).toBe(1);

		finishRestore.resolve();
		await restore;
		await vi.advanceTimersByTimeAsync(120_000);
		expect(sendFn).toHaveBeenCalledTimes(1);
		expect(logDeliveryFn).toHaveBeenCalledWith(
			"ch-1",
			"DISCORD",
			expect.objectContaining({ title: "Test" }),
			"sent",
			undefined,
			1,
			context(),
		);
	});

	it("dead-letters after max retries (3) are exhausted", async () => {
		sendFn.mockResolvedValue({
			success: false,
			retryable: true,
			error: "server error",
		} satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => recipient({ webhookUrl: "https://example.com" }),
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
		expect(deadLetterCall![4]).toMatch(/not confirmed after retries.*check/i);
		expect(handler.pendingCount).toBe(0);
	});

	it("holds mutation ownership until max-retry dead-letter logging settles", async () => {
		const deadLetterStarted = deferred<void>();
		const finishDeadLetter = deferred<void>();
		sendFn.mockResolvedValue({
			success: false,
			retryable: true,
			error: "server error",
		} satisfies SendResult);
		logDeliveryFn.mockImplementation(async (_channelId, _channelType, _payload, status) => {
			if (status === "dead_letter") {
				deadLetterStarted.resolve();
				await finishDeadLetter.promise;
			}
		});
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => recipient({ webhookUrl: "https://example.com" }),
			payload: createPayload(),
		});

		const advance = vi.advanceTimersByTimeAsync(30_000 + 120_000 + 600_000);
		await deadLetterStarted.promise;
		await Promise.resolve();
		await Promise.resolve();
		await expect(withCleanupMaintenanceGuard(async () => undefined)).rejects.toBeInstanceOf(
			CleanupMaintenanceConflictError,
		);

		finishDeadLetter.resolve();
		await advance;
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
			attemptContext: context(),
			resolveRecipient: async () => recipient({ webhookUrl: "https://example.com" }),
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
			context(),
		);
	});

	it("immediately dead-letters on non-retryable failure during retry", async () => {
		sendFn.mockResolvedValue({
			success: false,
			retryable: false,
			error: "bad webhook URL",
			failureCategory: "authentication",
		} satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => recipient({ webhookUrl: "https://example.com" }),
			payload: createPayload(),
		});

		// First retry at 30s
		await vi.advanceTimersByTimeAsync(30_000);

		expect(sendFn).toHaveBeenCalledTimes(1);
		const deadLetterCall = logDeliveryFn.mock.calls.find(
			(call: unknown[]) => call[3] === "dead_letter",
		);
		expect(deadLetterCall).toBeDefined();
		expect(deadLetterCall![4]).toMatch(/authentication.*credentials.*permissions/i);
		expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain("bad webhook URL");
		expect(handler.pendingCount).toBe(0);
	});

	it("flush() clears all pending timers and dead-letters remaining items", async () => {
		sendFn.mockResolvedValue({ success: false, retryable: true } satisfies SendResult);
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => recipient(),
			payload: createPayload("Item 1"),
		});
		handler.enqueue({
			channelId: "ch-2",
			channelType: "TELEGRAM",
			attemptContext: context("ch-2", "TELEGRAM"),
			resolveRecipient: async () => recipient({}, "ch-2", "TELEGRAM"),
			payload: createPayload("Item 2"),
		});

		expect(handler.pendingCount).toBe(2);

		await handler.flush();

		expect(handler.pendingCount).toBe(0);

		// Both items should be dead-lettered with shutdown message
		const deadLetterCalls = logDeliveryFn.mock.calls.filter(
			(call: unknown[]) => call[3] === "dead_letter",
		);
		expect(deadLetterCalls).toHaveLength(2);
		expect(deadLetterCalls[0]![4]).toContain("shutdown");
		expect(deadLetterCalls[1]![4]).toContain("shutdown");
	});

	it.each(["revoked", "resolver failure"] as const)(
		"flush() does not persist payload when recipient is %s",
		async (resolution) => {
			const resolutionStarted = deferred<void>();
			handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
			handler.enqueue({
				channelId: "ch-1",
				channelType: "DISCORD",
				attemptContext: context(),
				resolveRecipient: async () => {
					resolutionStarted.resolve();
					if (resolution === "resolver failure") throw new Error("private resolver detail");
					return null;
				},
				payload: createPayload("Private notification"),
			});

			const flushing = handler.flush();
			await resolutionStarted.promise;
			await flushing;

			expect(sendFn).not.toHaveBeenCalled();
			expect(logDeliveryFn).not.toHaveBeenCalled();
			expect(handler.pendingCount).toBe(0);
			expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain("private");
		},
	);

	it("flush() awaits recipient revalidation and shutdown delivery logging", async () => {
		const resolverStarted = deferred<void>();
		const finishResolver = deferred<DeliveryRecipient | null>();
		const logStarted = deferred<void>();
		const finishLog = deferred<void>();
		logDeliveryFn.mockImplementation(async () => {
			logStarted.resolve();
			await finishLog.promise;
		});
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);
		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => {
				resolverStarted.resolve();
				return finishResolver.promise;
			},
			payload: createPayload("Private notification"),
		});

		let settled = false;
		const flushPromise = handler.flush();
		expect(flushPromise).toBeInstanceOf(Promise);
		void flushPromise.then(() => {
			settled = true;
		});
		await resolverStarted.promise;
		expect(handler.pendingCount).toBe(0);
		expect(settled).toBe(false);

		finishResolver.resolve(recipient({ webhookUrl: "current" }));
		await logStarted.promise;
		expect(settled).toBe(false);
		finishLog.resolve();
		await flushPromise;

		expect(settled).toBe(true);
		expect(sendFn).not.toHaveBeenCalled();
	});

	it("pendingCount reflects queue size", async () => {
		handler = new RetryHandler(sendFn, logDeliveryFn, mockLogger);

		expect(handler.pendingCount).toBe(0);

		handler.enqueue({
			channelId: "ch-1",
			channelType: "DISCORD",
			attemptContext: context(),
			resolveRecipient: async () => recipient(),
			payload: createPayload(),
		});
		expect(handler.pendingCount).toBe(1);

		handler.enqueue({
			channelId: "ch-2",
			channelType: "TELEGRAM",
			attemptContext: context("ch-2", "TELEGRAM"),
			resolveRecipient: async () => recipient({}, "ch-2", "TELEGRAM"),
			payload: createPayload(),
		});
		expect(handler.pendingCount).toBe(2);

		await handler.flush();
		expect(handler.pendingCount).toBe(0);
	});
});
