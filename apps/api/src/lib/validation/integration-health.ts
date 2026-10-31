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

type HealthNotifyFn = (payload: {
	eventType: string;
	title: string;
	body: string;
	metadata: Record<string, string>;
}) => void | Promise<void>;

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
	private _notifyFn: HealthNotifyFn | null = null;
	private readonly _lastNotifiedAt = new Map<string, number>();
	private readonly _pendingNotifications = new Map<string, object>();
	private readonly _retryAfter = new Map<string, number>();

	/** Set a callback for health degradation notifications */
	setNotifyFn(fn: HealthNotifyFn): void {
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

		// Retry rejected submissions on a later failed validation, without
		// repeating accepted alerts merely because a source remains unhealthy.
		if (
			isAllRejection &&
			(previousState === "healthy" || this._retryAfter.has(integration)) &&
			(health.state === "degraded" || health.state === "failing")
		) {
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
		this._pendingNotifications.clear();
		this._retryAfter.clear();
	}

	// ============================================================================
	// Private Helpers
	// ============================================================================

	/** Throttle accepted submissions for one hour; failed admission retries after one minute. */
	private maybeNotify(integration: string, health: IntegrationHealth): void {
		if (!this._notifyFn || this._pendingNotifications.has(integration)) return;

		const now = Date.now();
		const lastNotified = this._lastNotifiedAt.get(integration);
		const THROTTLE_MS = 60 * 60 * 1000; // 1 hour

		if (lastNotified !== undefined && now - lastNotified < THROTTLE_MS) return;
		const retryAfter = this._retryAfter.get(integration);
		if (retryAfter !== undefined && now < retryAfter) return;

		// Reserve before invoking the callback, including synchronous re-entry.
		// A reset invalidates the token so an obsolete completion cannot rewrite new state.
		const token = {};
		this._pendingNotifications.set(integration, token);
		const accepted = () => {
			if (this._pendingNotifications.get(integration) !== token) return;
			this._pendingNotifications.delete(integration);
			this._retryAfter.delete(integration);
			this._lastNotifiedAt.set(integration, Date.now());
		};
		const rejected = () => {
			if (this._pendingNotifications.get(integration) !== token) return;
			this._pendingNotifications.delete(integration);
			this._retryAfter.set(integration, Date.now() + 60_000);
		};

		const affectedCategories = Object.entries(health.categories)
			.filter(([, s]) => s.rejected > 0)
			.map(([cat]) => cat)
			.join(", ");

		const payload = {
			eventType: "VALIDATION_HEALTH_DEGRADED",
			title: `Validation health degraded: ${integration}`,
			body: `Integration "${integration}" has ${health.consecutiveFailures} consecutive validation failure(s). State: ${health.state}.`,
			metadata: {
				integration,
				failureCount: String(health.consecutiveFailures),
				affectedCategories: affectedCategories || "unknown",
			},
		};
		try {
			const submission = this._notifyFn(payload);
			if (submission === undefined) accepted();
			else void Promise.resolve(submission).then(accepted, rejected);
		} catch {
			// Alert rejection must not turn already recorded validation evidence
			// into a provider failure or prevent the refresh from continuing.
			rejected();
		}
	}
}

/** Singleton integration health registry */
export const integrationHealth = new IntegrationHealthRegistry();
