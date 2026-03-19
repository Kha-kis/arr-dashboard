/**
 * Unit tests for the AggregationBuffer.
 *
 * Validates time-window flushing, batch-size thresholds,
 * digest payload construction, and shutdown flush.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AggregationBuffer } from "../aggregation-buffer.js";
import type { AggregationConfig } from "../aggregation-buffer.js";
import type { NotificationPayload } from "../types.js";

function makePayload(overrides?: Partial<NotificationPayload>): NotificationPayload {
	return {
		eventType: "HUNT_COMPLETED" as NotificationPayload["eventType"],
		title: "Test notification",
		body: "Test body",
		...overrides,
	};
}

describe("AggregationBuffer", () => {
	type FlushFn = (digest: NotificationPayload) => Promise<void>;
	let flushCallback: ReturnType<typeof vi.fn<FlushFn>>;
	let buffer: AggregationBuffer;
	const config: AggregationConfig = {
		eventType: "HUNT_COMPLETED",
		windowSeconds: 60,
		maxBatchSize: 5,
	};

	beforeEach(() => {
		vi.useFakeTimers();
		flushCallback = vi.fn<FlushFn>().mockResolvedValue(undefined);
		buffer = new AggregationBuffer(flushCallback);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("push returns true when config exists", () => {
		const result = buffer.push(makePayload(), config);
		expect(result).toBe(true);
	});

	it("flushes after time window expires", () => {
		buffer.push(makePayload(), config);

		expect(flushCallback).not.toHaveBeenCalled();

		vi.advanceTimersByTime(config.windowSeconds * 1000);

		expect(flushCallback).toHaveBeenCalledTimes(1);
		const digest = flushCallback.mock.calls[0]![0] as NotificationPayload;
		expect(digest.eventType).toBe("HUNT_COMPLETED");
		expect(digest.title).toContain("[1x]");
	});

	it("flushes when batch size threshold is reached", () => {
		for (let i = 0; i < config.maxBatchSize; i++) {
			buffer.push(makePayload({ title: `Item ${i}` }), config);
		}

		// Should flush immediately without waiting for timer
		expect(flushCallback).toHaveBeenCalledTimes(1);
		const digest = flushCallback.mock.calls[0]![0] as NotificationPayload;
		expect(digest.title).toContain(`[${config.maxBatchSize}x]`);
	});

	it("digest payload contains aggregated title and count", () => {
		buffer.push(makePayload({ title: "Alpha" }), config);
		buffer.push(makePayload({ title: "Beta" }), config);
		buffer.push(makePayload({ title: "Gamma" }), config);

		vi.advanceTimersByTime(config.windowSeconds * 1000);

		expect(flushCallback).toHaveBeenCalledTimes(1);
		const digest = flushCallback.mock.calls[0]![0] as NotificationPayload;
		expect(digest.title).toMatch(/^\[3x\]/);
		expect(digest.body).toContain("3");
		expect(digest.metadata).toEqual(
			expect.objectContaining({
				aggregated: true,
				count: 3,
			}),
		);
	});

	it("flushAll flushes all buckets", () => {
		const configB: AggregationConfig = {
			eventType: "BACKUP_COMPLETED",
			windowSeconds: 120,
			maxBatchSize: 10,
		};

		buffer.push(makePayload(), config);
		buffer.push(
			makePayload({ eventType: "BACKUP_COMPLETED" as NotificationPayload["eventType"], title: "Backup done" }),
			configB,
		);

		expect(flushCallback).not.toHaveBeenCalled();

		buffer.flushAll();

		expect(flushCallback).toHaveBeenCalledTimes(2);
	});

	it("pendingCount reflects items in all buckets", () => {
		const configB: AggregationConfig = {
			eventType: "BACKUP_COMPLETED",
			windowSeconds: 120,
			maxBatchSize: 10,
		};

		buffer.push(makePayload(), config);
		buffer.push(makePayload(), config);
		buffer.push(
			makePayload({ eventType: "BACKUP_COMPLETED" as NotificationPayload["eventType"] }),
			configB,
		);

		expect(buffer.pendingCount).toBe(3);
	});

	it("hasConfig returns matching config", () => {
		const configs: AggregationConfig[] = [config];
		const result = buffer.hasConfig("HUNT_COMPLETED", configs);
		expect(result).toBe(config);
	});

	it("hasConfig returns undefined for non-matching eventType", () => {
		const configs: AggregationConfig[] = [config];
		const result = buffer.hasConfig("SOME_OTHER_EVENT", configs);
		expect(result).toBeUndefined();
	});
});
