/**
 * Integration Health Registry
 *
 * Tracks validation statistics across all integrations (TRaSH, Seerr, Plex, Tautulli, etc.)
 * in a unified registry. Each integration can record stats by category, and the
 * health endpoint surfaces aggregate data for monitoring/debugging.
 */

import type { ValidationStats } from "./validate-batch.js";

// ============================================================================
// Types
// ============================================================================

export interface IntegrationHealth {
	lastRefreshAt: string | null;
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

class IntegrationHealthRegistry {
	private readonly data = new Map<string, IntegrationHealth>();
	private _resetAt: string | null = null;

	/** Record validation stats for a specific integration + category */
	record(integration: string, category: string, stats: ValidationStats): void {
		let health = this.data.get(integration);
		if (!health) {
			health = {
				lastRefreshAt: null,
				categories: {},
				totals: { total: 0, validated: 0, rejected: 0 },
			};
			this.data.set(integration, health);
		}

		health.lastRefreshAt = new Date().toISOString();

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
	}
}

/** Singleton integration health registry */
export const integrationHealth = new IntegrationHealthRegistry();
