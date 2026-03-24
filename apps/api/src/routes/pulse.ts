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

		// Run all collectors in parallel, each wrapped in try/catch
		const collectorResults = await Promise.all(
			pulseCollectors.map(async (collector) => {
				try {
					return await collector(app, userId, request.log);
				} catch (error) {
					request.log.warn({ err: error }, "pulse: collector failed");
					return [
						{
							id: `collector-error-${Date.now()}`,
							severity: "warning" as const,
							category: "health" as const,
							title: "Could not check some signals",
							detail: "A pulse collector encountered an error",
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
