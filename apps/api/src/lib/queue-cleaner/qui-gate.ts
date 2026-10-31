/**
 * qui-aware mode (Phase 2.3) — gate the strike system on qui torrent state.
 *
 * When `QueueCleanerConfig.quiAwareMode` is on, we skip strikes for queue
 * items whose corresponding torrent has been paused or errored in qui. The
 * assumption: qui (or a human operating qui) is already acting, and a strike
 * from arr-dashboard would be either redundant or actively interfering.
 *
 * Gate predicate: a current complete qUI publication state in {"paused", "error"},
 * or unavailable/stale independent inventory evidence while qUI is
 * enabled. The latter fails closed so an incomplete multi-qUI sync cannot
 * silently disable protection.
 *
 * Complete inventory absence is usable without a Library correlation row.
 * No-op when the user has no enabled qui instance configured; the original strike
 * behavior is preserved exactly.
 */

import type { PrismaClient } from "../prisma.js";
import { readQuiTorrentObservations } from "../qui/torrent-observation-repository.js";

/** qui torrent states that mean "qui or human-via-qui is already acting". */
const GATED_STATES = new Set(["paused", "error"]);

export type QuiAwareGateReason = "paused_or_error" | "evidence_unavailable";

/** qBit info hashes are 40-hex (SHA-1) or 64-hex (SHA-256), lowercase canonical. */
const HASH_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

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
 * @param prisma  Prisma client for the independent owned publication reader
 * @param userId  Owner of the current qUI topology and observation generation
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

	const uniqueHashes = Array.from(new Set(hashesByItemId.values()));
	const publication = await readQuiTorrentObservations(prisma, userId, uniqueHashes, now);
	if (publication.status === "not_configured") return new Map();
	const reasons = new Map<string, QuiAwareGateReason>();
	for (const [itemId, hash] of hashesByItemId) {
		if (publication.status === "unavailable" || publication.rows.get(hash)?.state === "unknown")
			reasons.set(itemId, "evidence_unavailable");
		else if (GATED_STATES.has(publication.rows.get(hash)?.state ?? ""))
			reasons.set(itemId, "paused_or_error");
	}
	return reasons;
}
