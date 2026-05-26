/**
 * Last-seed protection (Phase 2.4) — gate strikes on whether *arr's library
 * still references the torrent's content.
 *
 * Predicate (single condition for v1, by deliberate design):
 *   Protect from strike iff the torrent's infoHash appears in *arr's library
 *   caches as an actively-referenced file. Specifically:
 *     - LibraryCache row exists with this infoHash AND hasFile = true
 *       (covers Radarr movies, Lidarr artists, Readarr authors), OR
 *     - EpisodeFileCache row exists with this infoHash (covers Sonarr series
 *       at per-episode granularity).
 *
 * Why this single check:
 *   - If *arr STILL has a file row pointing at this hash, the operator's
 *     library system wants the content. Removing the torrent risks orphaning
 *     the file (qBit removes the .torrent, *arr loses the source, the file
 *     may be deleted depending on operator's *arr config).
 *   - If *arr has REMOVED the file row (quality upgrade, manual delete, etc),
 *     condition is false → strike is allowed. The user explicitly confirmed
 *     this behavior on 2026-05-19: "protect when it is referenced."
 *
 * Cross-instance scope: queries across ALL of the user's *arr instances,
 * not just the cleaner's current instance. A torrent referenced by Radarr
 * but in Sonarr's queue is still protected — losing the file would hurt
 * Radarr.
 *
 * Cross-seed / inode-group sibling checks (A) and (B) from the original
 * design discussion are intentionally NOT in v1. Rationale: simpler
 * predicate → fewer false-positive vectors → safer ship. Extending to
 * sibling-aware nuance is straightforward as a v2 refinement (would allow
 * striking duplicate seeds when other copies survive); ship the strict
 * version first.
 *
 * Fail-closed: any DB error from the lookup causes ALL hashed candidates
 * to be treated as protected. Deliberately stricter than qui-gate.ts (which
 * falls through to normal strike behavior on error). Rationale: the cost of
 * over-protection is "stale seeds stay seeding longer" (operator can
 * manually clean); the cost of under-protection is data loss (irrecoverable
 * without re-grabbing). The asymmetry justifies the divergence.
 */

import type { PrismaClient } from "../prisma.js";

/**
 * Pure-function partition — exposed for unit-test coverage of the predicate
 * logic independent of the DB query layer.
 */
export function partitionByReferencedHashes(
	hashesByItemId: Map<string, string>,
	referencedHashes: ReadonlySet<string>,
): { protectedItemIds: Set<string> } {
	const protectedItemIds = new Set<string>();
	for (const [itemId, hash] of hashesByItemId) {
		if (referencedHashes.has(hash)) {
			protectedItemIds.add(itemId);
		}
	}
	return { protectedItemIds };
}

/**
 * Resolve the set of item IDs whose torrents are still referenced by any of
 * the user's *arr library caches.
 *
 * Implementation: TWO batched DB queries (LibraryCache + EpisodeFileCache),
 * union the resulting infoHashes, then partition the input by membership.
 * Cost is independent of the number of candidates — only the size of the
 * unique-hash set matters for the `in` clause.
 *
 * @param prisma           Prisma client
 * @param userId           Owner of the library caches (CLAUDE.md §Ownership)
 * @param hashesByItemId   Map of *arr queueItemId → normalized lowercase hash
 *                         for every item the caller wants to consider
 * @returns                Subset of itemIds whose hashes are still referenced
 *                         in *arr's library (and should be protected from
 *                         strike). On DB error, returns ALL itemIds that
 *                         had a hash — fail-closed protection.
 */
export async function resolveLibraryReferencedItemIds(
	prisma: PrismaClient,
	userId: string,
	hashesByItemId: Map<string, string>,
): Promise<Set<string>> {
	if (hashesByItemId.size === 0) {
		return new Set();
	}

	const uniqueHashes = Array.from(new Set(hashesByItemId.values()));

	try {
		// Batched lookup across BOTH caches in parallel. LibraryCache covers
		// item-level files (movies/artists/authors); EpisodeFileCache covers
		// per-episode files (series). A hash is "referenced" if it appears
		// in EITHER, scoped to the user's instances via the relation join.
		const [libRows, epRows] = await Promise.all([
			prisma.libraryCache.findMany({
				where: {
					instance: { userId },
					infoHash: { in: uniqueHashes },
					hasFile: true,
				},
				select: { infoHash: true },
			}),
			prisma.episodeFileCache.findMany({
				where: {
					instance: { userId },
					infoHash: { in: uniqueHashes },
				},
				select: { infoHash: true },
			}),
		]);

		const referencedHashes = new Set<string>();
		for (const r of libRows) {
			if (r.infoHash) referencedHashes.add(r.infoHash);
		}
		for (const r of epRows) {
			if (r.infoHash) referencedHashes.add(r.infoHash);
		}

		return partitionByReferencedHashes(hashesByItemId, referencedHashes).protectedItemIds;
	} catch {
		// Fail-closed: any unexpected DB error → protect every item with a
		// hash. The caller catches this implicitly via the Set we return.
		// Logging is the caller's responsibility (it has the full route
		// context for correlation).
		return new Set(hashesByItemId.keys());
	}
}
