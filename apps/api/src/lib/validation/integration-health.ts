/**
 * Integration Health Registry
 *
 * Tracks validation statistics across all integrations (TRaSH, Seerr, Plex, Tautulli, etc.)
 * in a unified registry. Each integration can record stats by category, and the
 * health endpoint surfaces aggregate data for monitoring/debugging.
 *
 * Health state tracking: consecutive failures are tracked per integration to
 * compute a state (healthy / degraded / failing) for observability dashboards.
 */

import type { ValidationStats } from "./validate-batch.js";

// ============================================================================
// Types
// ============================================================================

/** Health state derived from consecutive failure count */
export type HealthState = "healthy" | "degraded" | "failing";

export interface IntegrationHealth {
	lastRefreshAt: string | null;
	lastSuccessAt: string | null;
	lastFailureAt: string | null;
	consecutiveFailures: number;
	state: HealthState;
	categories: Record<string, ValidationStats>;
	totals: ValidationStats;
}

export interface AllIntegrationHealth {
	integrations: Record<string, IntegrationHealth>;
	overallTotals: ValidationStats;
	/** ISO timestamp of the last reset (null = never reset, stats since app start) */
	resetAt: string | null;
}

// ============================================================================
// Registry
// ============================================================================

/** Compute health state from consecutive failure count */
function computeState(consecutiveFailures: number): HealthState {
	if (consecutiveFailures === 0) return "healthy";
	if (consecutiveFailures <= 2) return "degraded";
	return "failing";
}

class IntegrationHealthRegistry {
	private readonly data = new Map<string, IntegrationHealth>();
	private _resetAt: string | null = null;
	private _notifyFn: ((payload: { eventType: string; title: string; body: string; metadata: Record<string, string> }) => void) | null = null;
	private readonly _lastNotifiedAt = new Map<string, number>();

	/** Set a callback for health degradation notifications */
	setNotifyFn(fn: (payload: { eventType: string; title: string; body: string; metadata: Record<string, string> }) => void): void {
		this._notifyFn = fn;
	}

	/** Record validation stats for a specific integration + category */
	record(integration: string, category: string, stats: ValidationStats): void {
		let health = this.data.get(integration);
		if (!health) {
			health = {
				lastRefreshAt: null,
				lastSuccessAt: null,
				lastFailureAt: null,
				consecutiveFailures: 0,
				state: "healthy",
				categories: {},
				totals: { total: 0, validated: 0, rejected: 0 },
			};
			this.data.set(integration, health);
		}

		const now = new Date().toISOString();
		health.lastRefreshAt = now;

		const existing = health.categories[category];
		if (existing) {
			existing.total += stats.total;
			existing.validated += stats.validated;
			existing.rejected += stats.rejected;
		} else {
			health.categories[category] = { ...stats };
		}

		health.totals.total += stats.total;
		health.totals.validated += stats.validated;
		health.totals.rejected += stats.rejected;

		// Track consecutive failures and state
		const previousState = health.state;
		const isAllRejection = stats.rejected > 0 && stats.validated === 0;
		if (isAllRejection) {
			health.consecutiveFailures++;
			health.lastFailureAt = now;
		} else if (stats.validated > 0) {
			health.consecutiveFailures = 0;
			health.lastSuccessAt = now;
		}

		health.state = computeState(health.consecutiveFailures);

		// Notify on state degradation
		if (previousState === "healthy" && (health.state === "degraded" || health.state === "failing")) {
			this.maybeNotify(integration, health);
		}
	}

	/** Get health data for a specific integration */
	getByIntegration(integration: string): IntegrationHealth | undefined {
		return this.data.get(integration);
	}

	/** Get all integration health data */
	getAll(): AllIntegrationHealth {
		const integrations: Record<string, IntegrationHealth> = {};
		const overallTotals: ValidationStats = { total: 0, validated: 0, rejected: 0 };

		for (const [name, health] of this.data) {
			integrations[name] = health;
			overallTotals.total += health.totals.total;
			overallTotals.validated += health.totals.validated;
			overallTotals.rejected += health.totals.rejected;
		}

		return { integrations, overallTotals, resetAt: this._resetAt };
	}

	/** Reset stats for a specific integration */
	resetIntegration(integration: string): void {
		this.data.delete(integration);
	}

	/** Reset all stats and record the reset timestamp */
	reset(): void {
		this._resetAt = new Date().toISOString();
		this.data.clear();
		this._lastNotifiedAt.clear();
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	/** Send notification if not throttled (max 1 per integration per hour) */
	private maybeNotify(integration: string, health: IntegrationHealth): void {
		if (!this._notifyFn) return;

		const now = Date.now();
		const lastNotified = this._lastNotifiedAt.get(integration);
		const THROTTLE_MS = 60 * 60 * 1000; // 1 hour

		if (lastNotified && now - lastNotified < THROTTLE_MS) return;

		this._lastNotifiedAt.set(integration, now);

		const affectedCategories = Object.entries(health.categories)
			.filter(([, s]) => s.rejected > 0)
			.map(([cat]) => cat)
			.join(", ");

		this._notifyFn({
			eventType: "VALIDATION_HEALTH_DEGRADED",
			title: `Validation health degraded: ${integration}`,
			body: `Integration "${integration}" has ${health.consecutiveFailures} consecutive validation failure(s). State: ${health.state}.`,
			metadata: {
				integration,
				failureCount: String(health.consecutiveFailures),
				affectedCategories: affectedCategories || "unknown",
			},
		});
	}
}

/** Singleton integration health registry */
export const integrationHealth = new IntegrationHealthRegistry();
