/**
 * qui-aware mode (Phase 2.3) — gate the strike system on qui torrent state.
 *
 * When `QueueCleanerConfig.quiAwareMode` is on, we skip strikes for queue
 * items whose corresponding torrent has been paused or errored in qui. The
 * assumption: qui (or a human operating qui) is already acting, and a strike
 * from arr-dashboard would be either redundant or actively interfering.
 *
 * Gate predicate: a fresh `LibraryCache.torrentState` in {"paused", "error"},
 * or unavailable/stale evidence for an otherwise correlated hash while qUI is
 * enabled. The latter fails closed so an incomplete multi-qUI sync cannot
 * silently disable protection.
 *
 * No-op when the user has no qui instance configured — `torrentState` stays
 * NULL across rows, the predicate never matches, and the original strike
 * behavior is preserved exactly.
 */

import type { PrismaClient } from "../prisma.js";

/** qui torrent states that mean "qui or human-via-qui is already acting". */
const GATED_STATES = new Set(["paused", "error"]);

/** Three scheduler intervals (10m each) before cached qUI evidence is stale. */
const QUI_EVIDENCE_FRESHNESS_MS = 30 * 60 * 1000;

export type QuiAwareGateReason = "paused_or_error" | "evidence_unavailable";

/** qBit info hashes are 40-hex (SHA-1) or 64-hex (SHA-256), lowercase canonical. */
const HASH_RE = /^[a-f0-9]{40,64}$/;

/**
 * Normalize a raw *arr `downloadId` to the canonical lowercase-hex form used
 * by `LibraryCache.infoHash`. Returns null for non-torrent download IDs
 * (NZB, magnets, anything that doesn't look like a qBit info hash) — those
 * legitimately have no qui correlation and should not be gated.
 */
export function normalizeDownloadId(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const lower = value.toLowerCase();
	return HASH_RE.test(lower) ? lower : null;
}

/**
 * Pure logic — given a set of hashes that the strike loop is about to act on
 * and a set of hashes qui has reported in a gated state, return the subset
 * that should be skipped.
 *
 * Exposed for unit testing the partition independent of the DB lookup.
 */
export function partitionByGatedHashes(
	hashesByItemId: Map<string, string>,
	gatedHashes: ReadonlySet<string>,
): { gatedItemIds: Set<string> } {
	const gatedItemIds = new Set<string>();
	for (const [itemId, hash] of hashesByItemId) {
		if (gatedHashes.has(hash)) {
			gatedItemIds.add(itemId);
		}
	}
	return { gatedItemIds };
}

/**
 * Resolve the set of item IDs whose torrent qui considers gated (paused/error).
 *
 * @param prisma  Prisma client (used to query LibraryCache scoped to userId)
 * @param userId  Owner of the LibraryCache rows (AGENTS.md ownership invariant)
 * @param hashesByItemId  Map of *arr queueItemId → normalized lowercase hash
 *                        for every matched item the caller wants to consider
 *
 * Returns the subset of itemIds whose torrents are paused/error in qui.
 */
export async function resolveQuiAwareGateReasons(
	prisma: PrismaClient,
	userId: string,
	hashesByItemId: Map<string, string>,
	now: Date = new Date(),
): Promise<Map<string, QuiAwareGateReason>> {
	if (hashesByItemId.size === 0) {
		return new Map();
	}

	const enabledQui = await prisma.serviceInstance.findFirst({
		where: { userId, service: "QUI", enabled: true },
		select: { id: true },
	});
	if (!enabledQui) return new Map();

	const uniqueHashes = Array.from(new Set(hashesByItemId.values()));
	// Ownership flows through the parent ServiceInstance — `LibraryCache` has
	// no direct `userId` column. An earlier version of this gate queried
	// `where: { userId, ... }` directly, which raised `PrismaClientValidationError`
	// at runtime; the route wraps this call in a non-fatal try/catch so the
	// error was silent and `quiAwareMode` was effectively inert in production.
	// Filter via the relation instead.
	const rows = await prisma.libraryCache.findMany({
		where: {
			instance: { userId },
			infoHash: { in: uniqueHashes },
		},
		select: { infoHash: true, torrentState: true, torrentSyncedAt: true },
	});

	const reasonByHash = new Map<string, QuiAwareGateReason>();
	const hashesWithFreshEvidence = new Set<string>();
	const freshnessCutoff = now.getTime() - QUI_EVIDENCE_FRESHNESS_MS;
	for (const row of rows) {
		if (!row.infoHash) continue;
		const hash = row.infoHash.toLowerCase();
		if (!row.torrentSyncedAt || row.torrentSyncedAt.getTime() < freshnessCutoff) {
			reasonByHash.set(hash, "evidence_unavailable");
			continue;
		}
		hashesWithFreshEvidence.add(hash);
		if (GATED_STATES.has(row.torrentState ?? "") && !reasonByHash.has(hash)) {
			reasonByHash.set(hash, "paused_or_error");
		}
	}
	for (const hash of uniqueHashes) {
		if (!hashesWithFreshEvidence.has(hash) && !reasonByHash.has(hash)) {
			reasonByHash.set(hash, "evidence_unavailable");
		}
	}

	const reasons = new Map<string, QuiAwareGateReason>();
	for (const [itemId, hash] of hashesByItemId) {
		const reason = reasonByHash.get(hash);
		if (reason) reasons.set(itemId, reason);
	}
	return reasons;
}
