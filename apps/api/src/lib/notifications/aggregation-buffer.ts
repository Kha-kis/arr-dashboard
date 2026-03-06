/**
 * Aggregation Buffer for batching high-frequency notifications.
 *
 * Collects notifications by event type and flushes them as digest
 * payloads when either the time window expires or the batch size
 * threshold is reached.
 */

import type { NotificationPayload } from "./types.js";

export interface AggregationConfig {
	eventType: string;
	windowSeconds: number;
	maxBatchSize: number;
}

interface Bucket {
	items: NotificationPayload[];
	timer: ReturnType<typeof setTimeout>;
	config: AggregationConfig;
}

export class AggregationBuffer {
	private buckets = new Map<string, Bucket>();
	private flushCallback: (digest: NotificationPayload) => Promise<void>;

	constructor(flushCallback: (digest: NotificationPayload) => Promise<void>) {
		this.flushCallback = flushCallback;
	}

	/**
	 * Check if this event type has aggregation enabled.
	 */
	hasConfig(eventType: string, configs: AggregationConfig[]): AggregationConfig | undefined {
		return configs.find((c) => c.eventType === eventType);
	}

	/**
	 * Push a payload into the aggregation bucket.
	 * Returns true if the payload was aggregated (caller should NOT dispatch immediately).
	 * Returns false if no aggregation config exists (caller should dispatch normally).
	 */
	push(payload: NotificationPayload, config: AggregationConfig): boolean {
		const key = payload.eventType;
		let bucket = this.buckets.get(key);

		if (!bucket) {
			// Start a new bucket with a flush timer
			const timer = setTimeout(() => {
				this.flushBucket(key);
			}, config.windowSeconds * 1000);
			timer.unref();

			bucket = { items: [], timer, config };
			this.buckets.set(key, bucket);
		}

		bucket.items.push(payload);

		// Check count threshold
		if (bucket.items.length >= config.maxBatchSize) {
			this.flushBucket(key);
		}

		return true;
	}

	/**
	 * Flush a specific bucket, producing a digest notification.
	 */
	private flushBucket(key: string): void {
		const bucket = this.buckets.get(key);
		if (!bucket || bucket.items.length === 0) return;

		clearTimeout(bucket.timer);
		this.buckets.delete(key);

		const digest = this.buildDigest(bucket.items, key);
		this.flushCallback(digest).catch(() => {
			// Flush errors are logged by the service, not here
		});
	}

	/**
	 * Build a digest notification from multiple payloads.
	 */
	private buildDigest(items: NotificationPayload[], eventType: string): NotificationPayload {
		const count = items.length;
		const titles = items.map((i) => i.title);
		const uniqueTitles = [...new Set(titles)];
		const titleSummary =
			uniqueTitles.length <= 3
				? uniqueTitles.join(", ")
				: `${uniqueTitles.slice(0, 3).join(", ")} and ${uniqueTitles.length - 3} more`;

		return {
			eventType: eventType as NotificationPayload["eventType"],
			title: `[${count}x] ${titleSummary}`,
			body: `Aggregated ${count} ${eventType} notifications`,
			metadata: {
				aggregated: true,
				count,
				items: items.map((i) => ({ title: i.title, body: i.body })).slice(0, 10),
			},
		};
	}

	/**
	 * Flush all buckets (used during shutdown).
	 */
	flushAll(): void {
		for (const key of [...this.buckets.keys()]) {
			this.flushBucket(key);
		}
	}

	get pendingCount(): number {
		let count = 0;
		for (const bucket of this.buckets.values()) {
			count += bucket.items.length;
		}
		return count;
	}
}
