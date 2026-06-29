/**
 * System Pulse Route
 *
 * GET /api/pulse — returns a prioritized attention feed aggregated
 * from all connected services. Results are cached per-user for 60 seconds.
 */

import { type PulseItem, type PulseResponse, pulseActionSchema } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { dispatchPulseAction } from "../lib/pulse/actions.js";
import { pulseCollectors } from "../lib/pulse/collectors.js";
import { applyDismissals } from "../lib/pulse/dismissals.js";
import { validateRequest } from "../lib/utils/validate.js";

// ============================================================================
// In-memory cache (per user, 60s TTL)
// ============================================================================

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
	data: PulseResponse;
	expiresAt: number;
}

const pulseCache = new Map<string, CacheEntry>();

/**
 * Drop the cached Pulse response for a user so the next GET /pulse call
 * refetches from collectors. Called after a successful action so the row
 * the operator just resolved disappears on the next poll instead of
 * waiting out the 60s TTL.
 */
export function invalidatePulseCache(userId: string): void {
	pulseCache.delete(userId);
}

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
export const COLLECTOR_LABELS: Record<string, string> = {
	collectArrSignals: "ARR health and disk space",
	collectMediaServerReachability: "media server reachability",
	collectArrQueueFailures: "queue failures",
	collectSeerrCircuitBreaker: "Seerr circuit breaker",
	collectCacheStaleness: "cache freshness",
	collectLibrarySyncHealth: "library sync",
	collectValidationHealth: "validation health",
	collectLibraryInsightCounts: "library insights",
	collectHuntFailures: "hunt failures",
	collectQueueCleanerFailures: "queue cleaner",
	collectTrashSyncFailures: "TRaSH sync",
	collectSchedulerHealth: "scheduler health",
	collectCleanupOpportunities: "cleanup opportunities",
	collectQuiSignals: "qui health",
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

/**
 * Queue-failure rows (`queue-failed-*`, `queue-stuck-*`, `queue-overflow-*`)
 * can fan out per instance — a bad download-client day could produce 10+
 * items per ARR instance. Without a secondary sort, those rows would push
 * genuinely more-important system issues (a disabled scheduler, an
 * unreachable ARR) below the visible fold of the 10-row Needs Attention
 * panel. So within a severity bucket we rank non-queue items first; queue
 * items still show up, just after the system signals.
 */
function isQueueRow(item: PulseItem): boolean {
	return item.id.startsWith("queue-");
}

// Exported for focused unit testing. The behavior under test is:
//   (a) severity bucket ordering (critical > warning > info)
//   (b) queue-row deprioritization within a severity bucket
//   (c) newest-first within the same severity + row class
export function sortPulseItems(items: PulseItem[]): PulseItem[] {
	return items.sort((a, b) => {
		const severityDiff = (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9);
		if (severityDiff !== 0) return severityDiff;
		const queueDiff = (isQueueRow(a) ? 1 : 0) - (isQueueRow(b) ? 1 : 0);
		if (queueDiff !== 0) return queueDiff;
		// Newest first within same severity + row class
		return b.timestamp.localeCompare(a.timestamp);
	});
}

// ============================================================================
// Attention-only filter
// ============================================================================
//
// An item is "attention-worthy" iff it is critical/warning AND ships with an
// actionUrl the operator can click through. Informational items and warnings
// without a resolution path are excluded — the filter's contract is
// "actionable attention", not "everything non-info".
//
// **Collector contract** — any collector emitting `severity: "critical"` or
// `severity: "warning"` should also set `actionUrl`. Omit `actionUrl` *only*
// when the item is informational-only and you explicitly want it hidden from
// the dashboard Needs Attention panel (the collector-error fallback below is
// the canonical example — there is no operator action for "a collector
// crashed"). A collector that forgets `actionUrl` silently vanishes from
// Needs Attention, which is a foot-gun worth knowing about.
function isAttentionItem(item: PulseItem): boolean {
	if (item.severity !== "critical" && item.severity !== "warning") return false;
	return typeof item.actionUrl === "string" && item.actionUrl.length > 0;
}

function applyAttentionFilter(response: PulseResponse): PulseResponse {
	const items = response.items.filter(isAttentionItem);
	return {
		items,
		summary: {
			critical: items.filter((i) => i.severity === "critical").length,
			warning: items.filter((i) => i.severity === "warning").length,
			info: 0,
		},
		generatedAt: response.generatedAt,
		// Carried through verbatim: the count describes the whole feed (the
		// tombstones hide items before this view is derived), and curated
		// surfaces simply don't render it.
		dismissedCount: response.dismissedCount,
	};
}

// ============================================================================
// Route
// ============================================================================

export const registerPulseRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.get("/pulse", async (request, reply) => {
		const userId = request.currentUser!.id;

		// `attentionOnly=true` is a view over the same collector output — we
		// filter the cached/fresh response rather than running a parallel
		// pipeline, so both views stay consistent and cheap.
		const query = request.query as { attentionOnly?: string } | undefined;
		const attentionOnly = query?.attentionOnly === "true";

		// Check cache
		const cached = pulseCache.get(userId);
		if (cached && Date.now() < cached.expiresAt) {
			return reply.send(attentionOnly ? applyAttentionFilter(cached.data) : cached.data);
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

		// Dismiss-until-recovery happens on the fresh-compute path ONLY (the
		// cached response below is already filtered): sweep tombstones whose
		// signal stopped firing, hide non-critical tombstoned items, and count
		// what was hidden. Summary counts are computed AFTER filtering so the
		// badge numbers always match the rows an operator can actually see.
		const { visibleItems, dismissedCount } = await applyDismissals(
			app,
			userId,
			allItems,
			request.log,
		);

		const response: PulseResponse = {
			items: visibleItems,
			summary: {
				critical: visibleItems.filter((i) => i.severity === "critical").length,
				warning: visibleItems.filter((i) => i.severity === "warning").length,
				info: visibleItems.filter((i) => i.severity === "info").length,
			},
			generatedAt: new Date().toISOString(),
			dismissedCount,
		};

		pulseCache.set(userId, { data: response, expiresAt: Date.now() + CACHE_TTL_MS });

		return reply.send(attentionOnly ? applyAttentionFilter(response) : response);
	});

	// ============================================================================
	// POST /pulse/:id/action — dispatch an operator action for a Pulse signal
	// ============================================================================
	//
	// The `:id` path param is the Pulse signal id (for logging/audit context).
	// Signals are stateless — regenerated every poll — so the server does NOT
	// look the id up. Authorization derives from the action's target fields:
	//   - scheduler.enable: global (single-admin)
	//   - cache.refresh:    per-instance, via require*Client ownership check
	//
	// On success the per-user cache is invalidated so the row the operator
	// just resolved drops from /pulse on the next poll instead of waiting
	// out the 60s TTL.

	const pulseIdParams = z.object({ id: z.string().min(1) });

	// Rate limit the action route so a runaway script (or an overeager
	// operator mashing "Refresh now") can't hammer upstream Plex/Tautulli
	// via cache.refresh. 10/min is generous for real operator use — a
	// human clicking one button per row per minute stays well under the
	// cap, but bot-scale abuse trips 429. Aligns with the {max:2, 5m}
	// limit on the dedicated manual-refresh routes.
	app.post(
		"/pulse/:id/action",
		{
			config: { rateLimit: { max: 10, timeWindow: "1m" } },
		},
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id: signalId } = validateRequest(pulseIdParams, request.params);
			const action = validateRequest(pulseActionSchema, request.body);

			const result = await dispatchPulseAction(app, userId, action, request.log);

			invalidatePulseCache(userId);

			request.log.info(
				{
					action: action.kind,
					target: action.target,
					signalId,
					userId,
				},
				"pulse-action: dispatched",
			);

			// Strip `backgroundTask` — it's a Promise (not JSON-serializable)
			// used only by the dispatcher's internal fire-and-forget contract.
			// The client cares about `{ status, detail? }` only.
			const { backgroundTask: _bg, ...wireResult } = result;
			void _bg; // silence no-unused-vars; we deliberately don't await
			return reply.send(wireResult);
		},
	);

	// ============================================================================
	// Dismiss-until-recovery — POST /pulse/:id/dismiss, DELETE …/dismiss,
	// DELETE /pulse/dismissals
	// ============================================================================
	//
	// Tombstone semantics live in lib/pulse/dismissals.ts (applyDismissals on
	// the GET path). These routes only manage tombstone rows. Notes:
	//
	//   - No write-time validation that the signal id exists or is
	//     non-critical: signals are stateless, so verifying either would cost
	//     a full collector run per dismiss. The GET-path filter enforces the
	//     critical-breakthrough rule at read time (strictly stronger — it
	//     also covers post-dismiss escalation), and the recovery sweep
	//     deletes tombstones for ids that never fire.
	//   - Every mutation invalidates the per-user pulse cache so the next
	//     poll reflects the change instead of waiting out the 60s TTL.
	//   - Rate limited like the action route — these are cheap DB writes,
	//     but a runaway client mashing dismiss shouldn't churn the cache.

	const dismissRateLimit = { config: { rateLimit: { max: 30, timeWindow: "1m" } } };

	app.post("/pulse/:id/dismiss", dismissRateLimit, async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id: signalId } = validateRequest(pulseIdParams, request.params);

		// Idempotent: re-dismissing keeps the original dismissedAt.
		await app.prisma.pulseDismissal.upsert({
			where: { userId_signalId: { userId, signalId } },
			create: { userId, signalId },
			update: {},
		});

		invalidatePulseCache(userId);
		request.log.info({ signalId, userId }, "pulse-dismiss: signal dismissed");
		return reply.send({ status: "ok" });
	});

	// Undo a single dismissal (the toast's "Undo" path). deleteMany (not
	// delete) so undoing an already-swept tombstone is a quiet no-op
	// instead of a P2025 throw.
	app.delete("/pulse/:id/dismiss", dismissRateLimit, async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id: signalId } = validateRequest(pulseIdParams, request.params);

		await app.prisma.pulseDismissal.deleteMany({ where: { userId, signalId } });

		invalidatePulseCache(userId);
		request.log.info({ signalId, userId }, "pulse-dismiss: signal restored");
		return reply.send({ status: "ok" });
	});

	// Restore-all — the management surface for dismissals that outlived
	// their undo toast. Returns the cleared count so the UI can toast
	// "Restored N signals" honestly.
	app.delete("/pulse/dismissals", dismissRateLimit, async (request, reply) => {
		const userId = request.currentUser!.id;

		const { count } = await app.prisma.pulseDismissal.deleteMany({ where: { userId } });

		invalidatePulseCache(userId);
		request.log.info({ cleared: count, userId }, "pulse-dismiss: all signals restored");
		return reply.send({ status: "ok", cleared: count });
	});

	done();
};
