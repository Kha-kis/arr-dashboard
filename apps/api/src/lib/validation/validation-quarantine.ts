/**
 * Validation Quarantine — Ring Buffer for Rejected Items
 *
 * Stores rejected upstream data items for later inspection, with per-integration
 * and global caps to prevent unbounded memory growth.
 *
 * Caps:
 * - Per-integration: 50 items (FIFO eviction when exceeded)
 * - Global total: 250 items (evicts oldest globally when exceeded)
 */

// ============================================================================
// Types
// ============================================================================

export interface QuarantinedItem {
	/** The raw data that failed validation */
	raw: unknown;
	/** Human-readable validation error details */
	errors: string[];
	/** Which integration produced the invalid data */
	integration: string;
	/** Which endpoint/category within the integration */
	category: string;
	/** ISO timestamp when the item was quarantined */
	timestamp: string;
}

// ============================================================================
// Constants
// ============================================================================

const PER_INTEGRATION_CAP = 50;
const GLOBAL_CAP = 250;

// ============================================================================
// Registry
// ============================================================================

class ValidationQuarantine {
	private readonly items = new Map<string, QuarantinedItem[]>();
	private _totalCount = 0;

	/** Push a rejected item into quarantine */
	push(item: QuarantinedItem): void {
		const { integration } = item;

		let bucket = this.items.get(integration);
		if (!bucket) {
			bucket = [];
			this.items.set(integration, bucket);
		}

		// Per-integration cap: evict oldest
		if (bucket.length >= PER_INTEGRATION_CAP) {
			bucket.shift();
			this._totalCount--;
		}

		bucket.push(item);
		this._totalCount++;

		// Global cap: evict oldest item across all integrations
		while (this._totalCount > GLOBAL_CAP) {
			this.evictOldestGlobally();
		}
	}

	/** Get quarantined items for a specific integration */
	getByIntegration(integration: string): QuarantinedItem[] {
		return this.items.get(integration) ?? [];
	}

	/** Get all quarantined items grouped by integration */
	getAll(): Record<string, QuarantinedItem[]> {
		const result: Record<string, QuarantinedItem[]> = {};
		for (const [integration, bucket] of this.items) {
			result[integration] = [...bucket];
		}
		return result;
	}

	/** Total count of quarantined items */
	get count(): number {
		return this._totalCount;
	}

	/** Clear all quarantined items */
	clear(): void {
		this.items.clear();
		this._totalCount = 0;
	}

	/** Clear quarantined items for a specific integration */
	clearIntegration(integration: string): void {
		const bucket = this.items.get(integration);
		if (bucket) {
			this._totalCount -= bucket.length;
			this.items.delete(integration);
		}
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	/** Evict the single oldest item across all integrations */
	private evictOldestGlobally(): void {
		let oldestTime = Number.POSITIVE_INFINITY;
		let oldestIntegration: string | null = null;

		for (const [integration, bucket] of this.items) {
			if (bucket.length > 0) {
				const firstTs = new Date(bucket[0]!.timestamp).getTime();
				if (firstTs < oldestTime) {
					oldestTime = firstTs;
					oldestIntegration = integration;
				}
			}
		}

		if (oldestIntegration) {
			const bucket = this.items.get(oldestIntegration)!;
			bucket.shift();
			this._totalCount--;

			if (bucket.length === 0) {
				this.items.delete(oldestIntegration);
			}
		}
	}
}

/** Singleton validation quarantine */
export const validationQuarantine = new ValidationQuarantine();
