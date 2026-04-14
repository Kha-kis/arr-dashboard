/**
 * System Pulse Route
 *
 * GET /api/pulse — returns a prioritized attention feed aggregated
 * from all connected services. Results are cached per-user for 60 seconds.
 */

import type { PulseItem, PulseResponse } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { pulseCollectors } from "../lib/pulse/collectors.js";

// ============================================================================
// In-memory cache (per user, 60s TTL)
// ============================================================================

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
	data: PulseResponse;
	expiresAt: number;
}

const pulseCache = new Map<string, CacheEntry>();

// ============================================================================
// Severity ordering for sort
// ============================================================================

const SEVERITY_ORDER: Record<string, number> = {
	critical: 0,
	warning: 1,
	info: 2,
};

// ============================================================================
// Operator-friendly labels for collector failures
// ============================================================================
//
// The collector's function name (e.g. `collectArrSignals`) is used to build a
// stable id so React Query / row animations see the same failure item across
// refreshes. That name is jargon to operators, so we translate it to a plain
// label for the visible `detail` string. Unknown names fall back to a
// humanized camelCase form so a future collector never leaks raw source names.
const COLLECTOR_LABELS: Record<string, string> = {
	collectArrSignals: "ARR health and disk space",
	collectSeerrCircuitBreaker: "Seerr circuit breaker",
	collectCacheStaleness: "cache freshness",
	collectValidationHealth: "validation health",
	collectLibraryInsightCounts: "library insights",
	collectHuntFailures: "hunt failures",
	collectQueueCleanerFailures: "queue cleaner",
	collectTrashSyncFailures: "TRaSH sync",
	collectCleanupOpportunities: "cleanup opportunities",
};

export function labelForCollector(name: string): string {
	const known = COLLECTOR_LABELS[name];
	if (known) return known;
	const humanized = name
		.replace(/^collect/, "")
		.replace(/([A-Z])/g, " $1")
		.trim()
		.toLowerCase();
	return humanized || "signal";
}

function sortPulseItems(items: PulseItem[]): PulseItem[] {
	return items.sort((a, b) => {
		const severityDiff = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
		if (severityDiff !== 0) return severityDiff;
		// Newest first within same severity
		return b.timestamp.localeCompare(a.timestamp);
	});
}

// ============================================================================
// Route
// ============================================================================

export const registerPulseRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/pulse", async (request, reply) => {
		const userId = request.currentUser!.id;

		// Check cache
		const cached = pulseCache.get(userId);
		if (cached && Date.now() < cached.expiresAt) {
			return reply.send(cached.data);
		}

		// Run all collectors in parallel, each wrapped in try/catch.
		//
		// On failure we emit a warning pulse item so the operator knows a signal
		// is missing — never swallow silently, that's the whole trust model.
		//
		// Identify the collector by its function name (e.g. `collectArrSignals`)
		// so (a) the id is stable across refreshes — React Query and the row
		// animation see the same item instead of a new one each poll, and (b)
		// the operator can tell *which* signal is missing from the feed.
		const collectorResults = await Promise.all(
			pulseCollectors.map(async (collector, index) => {
				const collectorName = collector.name || `collector-${index}`;
				try {
					return await collector(app, userId, request.log);
				} catch (error) {
					request.log.warn({ err: error, collector: collectorName }, "pulse: collector failed");
					return [
						{
							id: `collector-error-${collectorName}`,
							severity: "warning" as const,
							category: "health" as const,
							title: "Could not check some signals",
							detail: `The ${labelForCollector(collectorName)} check encountered an error — results may be incomplete.`,
							source: "system",
							timestamp: new Date().toISOString(),
						},
					];
				}
			}),
		);

		const allItems = sortPulseItems(collectorResults.flat());

		const response: PulseResponse = {
			items: allItems,
			summary: {
				critical: allItems.filter((i) => i.severity === "critical").length,
				warning: allItems.filter((i) => i.severity === "warning").length,
				info: allItems.filter((i) => i.severity === "info").length,
			},
			generatedAt: new Date().toISOString(),
		};

		pulseCache.set(userId, { data: response, expiresAt: Date.now() + CACHE_TTL_MS });

		return reply.send(response);
	});

	done();
};
