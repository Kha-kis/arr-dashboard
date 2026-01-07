/**
 * TRaSH Guides Sync Metrics Service
 *
 * Provides observability for sync operations including:
 * - Operation counts (syncs, deployments, rollbacks)
 * - Success/failure rates
 * - Timing information
 * - Error categorization
 */

import type { SyncMetricsSnapshot, SyncOperationType } from "@arr/shared";

// Re-export for internal use (avoids breaking existing imports)
export type OperationType = SyncOperationType;

// ============================================================================
// Types (Internal - uses Date objects, converted to strings in getSnapshot)
// ============================================================================

export interface OperationMetric {
	count: number;
	successCount: number;
	failureCount: number;
	lastRun: Date | null;
	lastSuccess: Date | null;
	lastFailure: Date | null;
	totalDurationMs: number;
	avgDurationMs: number;
	minDurationMs: number;
	maxDurationMs: number;
}

export interface ErrorMetric {
	message: string;
	count: number;
	lastOccurred: Date;
	operationType: OperationType;
}

// Note: SyncMetricsSnapshot is imported from @arr/shared and used as return type.
// The internal types above use Date objects; getSnapshot() converts them to ISO strings.

// ============================================================================
// Metrics Service
// ============================================================================

class SyncMetricsService {
	private startedAt: Date;
	private operations: Map<OperationType, OperationMetric>;
	private recentErrors: ErrorMetric[];
	private readonly maxRecentErrors = 50;

	constructor() {
		this.startedAt = new Date();
		this.operations = new Map();
		this.recentErrors = [];

		// Initialize all operation types with default metrics
		const operationTypes: OperationType[] = ["sync", "deployment", "rollback", "template_update"];
		for (const type of operationTypes) {
			this.operations.set(type, this.createEmptyMetric());
		}
	}

	private createEmptyMetric(): OperationMetric {
		return {
			count: 0,
			successCount: 0,
			failureCount: 0,
			lastRun: null,
			lastSuccess: null,
			lastFailure: null,
			totalDurationMs: 0,
			avgDurationMs: 0,
			minDurationMs: Number.POSITIVE_INFINITY,
			maxDurationMs: 0,
		};
	}

	/**
	 * Record the start of an operation. Returns a function to call when operation completes.
	 */
	startOperation(type: OperationType): () => { recordSuccess: () => void; recordFailure: (error?: string) => void } {
		const startTime = Date.now();

		return () => ({
			recordSuccess: () => this.recordCompletion(type, startTime, true),
			recordFailure: (error?: string) => this.recordCompletion(type, startTime, false, error),
		});
	}

	/**
	 * Record a completed operation with its duration and success status.
	 */
	recordCompletion(
		type: OperationType,
		startTime: number,
		success: boolean,
		errorMessage?: string,
	): void {
		const durationMs = Date.now() - startTime;
		const now = new Date();

		const metric = this.operations.get(type) || this.createEmptyMetric();

		metric.count++;
		metric.totalDurationMs += durationMs;
		metric.lastRun = now;

		if (success) {
			metric.successCount++;
			metric.lastSuccess = now;
		} else {
			metric.failureCount++;
			metric.lastFailure = now;

			if (errorMessage) {
				this.recordError(type, errorMessage);
			}
		}

		// Update duration stats
		if (durationMs < metric.minDurationMs) {
			metric.minDurationMs = durationMs;
		}
		if (durationMs > metric.maxDurationMs) {
			metric.maxDurationMs = durationMs;
		}
		metric.avgDurationMs = metric.totalDurationMs / metric.count;

		this.operations.set(type, metric);
	}

	/**
	 * Record an error occurrence.
	 */
	private recordError(type: OperationType, message: string): void {
		// Normalize error message (remove instance-specific details for grouping)
		const normalizedMessage = this.normalizeErrorMessage(message);

		// Find existing error or create new one
		const existingIndex = this.recentErrors.findIndex(
			(e) => e.message === normalizedMessage && e.operationType === type,
		);

		if (existingIndex >= 0) {
			const existing = this.recentErrors[existingIndex];
			if (existing) {
				existing.count++;
				existing.lastOccurred = new Date();
			}
		} else {
			this.recentErrors.unshift({
				message: normalizedMessage,
				count: 1,
				lastOccurred: new Date(),
				operationType: type,
			});

			// Trim to max size
			if (this.recentErrors.length > this.maxRecentErrors) {
				this.recentErrors = this.recentErrors.slice(0, this.maxRecentErrors);
			}
		}
	}

	/**
	 * Normalize error messages for better grouping.
	 */
	private normalizeErrorMessage(message: string): string {
		// Remove UUIDs, IDs, and instance-specific info
		return message
			.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "[ID]")
			.replace(/https?:\/\/[^\s]+/g, "[URL]")
			.replace(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/g, "[IP]")
			.replace(/port \d+/gi, "port [PORT]")
			.slice(0, 200); // Limit length
	}

	/**
	 * Get current metrics snapshot.
	 * Converts internal Date objects to ISO strings for API response.
	 */
	getSnapshot(): SyncMetricsSnapshot {
		const operations: Record<OperationType, SyncMetricsSnapshot["operations"][OperationType]> =
			{} as Record<OperationType, SyncMetricsSnapshot["operations"][OperationType]>;

		let totalOps = 0;
		let totalSuccess = 0;
		let totalDuration = 0;

		for (const [type, metric] of this.operations) {
			// Convert Date objects to ISO strings and fix Infinity for JSON serialization
			operations[type] = {
				count: metric.count,
				successCount: metric.successCount,
				failureCount: metric.failureCount,
				lastRun: metric.lastRun?.toISOString() ?? null,
				lastSuccess: metric.lastSuccess?.toISOString() ?? null,
				lastFailure: metric.lastFailure?.toISOString() ?? null,
				totalDurationMs: metric.totalDurationMs,
				avgDurationMs: metric.avgDurationMs,
				minDurationMs: metric.count === 0 ? 0 : metric.minDurationMs,
				maxDurationMs: metric.maxDurationMs,
			};

			totalOps += metric.count;
			totalSuccess += metric.successCount;
			totalDuration += metric.totalDurationMs;
		}

		return {
			uptime: Math.floor((Date.now() - this.startedAt.getTime()) / 1000),
			startedAt: this.startedAt.toISOString(),
			operations,
			recentErrors: this.recentErrors.slice(0, 20).map((e) => ({
				message: e.message,
				count: e.count,
				lastOccurred: e.lastOccurred.toISOString(),
				operationType: e.operationType,
			})),
			totals: {
				totalOperations: totalOps,
				successRate: totalOps > 0 ? (totalSuccess / totalOps) * 100 : 100,
				avgDurationMs: totalOps > 0 ? totalDuration / totalOps : 0,
			},
		};
	}

	/**
	 * Reset all metrics (useful for testing or manual reset).
	 */
	reset(): void {
		this.startedAt = new Date();
		this.recentErrors = [];

		for (const type of this.operations.keys()) {
			this.operations.set(type, this.createEmptyMetric());
		}
	}
}

// ============================================================================
// Singleton Export
// ============================================================================

// Singleton instance for application-wide metrics
let metricsInstance: SyncMetricsService | null = null;

/**
 * Get the sync metrics service singleton.
 */
export function getSyncMetrics(): SyncMetricsService {
	if (!metricsInstance) {
		metricsInstance = new SyncMetricsService();
	}
	return metricsInstance;
}

/**
 * Reset the metrics service (primarily for testing).
 */
export function resetSyncMetrics(): void {
	if (metricsInstance) {
		metricsInstance.reset();
	}
}
