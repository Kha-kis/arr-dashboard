/**
 * Pulse Dismiss-Until-Recovery
 *
 * Pulse signals are stateless — recomputed from collectors every poll — so
 * "dismiss" is persisted as a tombstone (`PulseDismissal`) keyed by the
 * signal's stable id. This module owns the read-time semantics:
 *
 *  1. **Recovery sweep** — tombstones whose signal id is absent from the
 *     freshly-computed item set are deleted. The signal recovered, so a
 *     future recurrence must resurface; a tombstone that outlived its
 *     signal would silently swallow the next occurrence.
 *  2. **Critical breakthrough** — the filter only suppresses non-critical
 *     items. Severity is evaluated at read time, so a dismissed warning
 *     that escalates to critical reappears with no writes anywhere; if it
 *     de-escalates back to warning (same id, still tombstoned) it re-hides.
 *  3. **Honest counting** — callers receive `dismissedCount` so surfaces
 *     can show "N dismissed" instead of silently under-reporting.
 *
 * There is deliberately NO write-time severity validation on dismiss:
 * verifying "is this signal currently non-critical?" would cost a full
 * collector run per dismiss, and read-time enforcement is strictly
 * stronger (it also covers post-dismiss escalation).
 */

import type { PulseItem } from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

export interface DismissalResult {
	/** Items that survive dismissal filtering, original order preserved. */
	visibleItems: PulseItem[];
	/** How many items were hidden by active tombstones. */
	dismissedCount: number;
}

/**
 * Apply the user's dismissal tombstones to a freshly-computed item set.
 *
 * Call this ONLY on the fresh-compute path of GET /pulse (never on cache
 * hits — the cached response is already filtered, and sweeping against a
 * stale snapshot could delete tombstones for signals that still fire).
 *
 * The sweep is best-effort: a failed delete is logged and the request
 * continues — worst case a recovered signal's tombstone lingers until the
 * next successful sweep, which only risks hiding a *recurrence* slightly
 * longer, never showing wrong data.
 */
export async function applyDismissals(
	app: FastifyInstance,
	userId: string,
	items: PulseItem[],
	log: FastifyBaseLogger,
): Promise<DismissalResult> {
	const dismissals = await app.prisma.pulseDismissal.findMany({
		where: { userId },
		select: { signalId: true },
	});

	if (dismissals.length === 0) {
		return { visibleItems: items, dismissedCount: 0 };
	}

	const currentIds = new Set(items.map((item) => item.id));
	const recovered = dismissals
		.map((d) => d.signalId)
		.filter((signalId) => !currentIds.has(signalId));

	if (recovered.length > 0) {
		try {
			await app.prisma.pulseDismissal.deleteMany({
				where: { userId, signalId: { in: recovered } },
			});
			log.info({ count: recovered.length }, "pulse-dismiss: swept recovered tombstones");
		} catch (err) {
			log.warn({ err, count: recovered.length }, "pulse-dismiss: tombstone sweep failed");
		}
	}

	const active = new Set(dismissals.map((d) => d.signalId).filter((id) => currentIds.has(id)));
	const visibleItems = items.filter((item) => item.severity === "critical" || !active.has(item.id));

	return { visibleItems, dismissedCount: items.length - visibleItems.length };
}
