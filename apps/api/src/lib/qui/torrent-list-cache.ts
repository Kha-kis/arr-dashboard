/**
 * Short-TTL cache for qui's full torrent list (Phase 2.6 — perf).
 *
 * `client.listAllTorrents()` paginates through every torrent qui knows
 * (up to 50 pages of 2000). The `/qui` home page mounts both the summary
 * and attention hooks at once, so without a cache that full fetch runs
 * twice in parallel on every page load — the measured ~3.5s.
 *
 * This module fixes both halves:
 *   1. In-flight dedup — if a fetch for an instance is already running,
 *      the second caller awaits the SAME promise instead of starting a
 *      second paginated walk. (Same pattern as the inode-index
 *      `INDEX_PENDING` map.) This collapses the summary+attention
 *      double-fetch on every page load.
 *   2. Short-TTL result cache — a repeat visit within the TTL window
 *      serves instantly from memory.
 *
 * Staleness is acceptable here: the `/qui` home page is a KPI overview.
 * Aggregate torrent counts don't shift meaningfully across a few minutes,
 * and real-time error alerting is handled separately by the qui
 * notification feed. The cache is process-local and not persisted —
 * a restart simply re-warms on the first request.
 */

import type { QuiTorrent } from "@arr/shared";
import type { QuiClient } from "./client-factory.js";

/** Cache lifetime. A `/qui` visit within this window of the last fetch
 * (page visit OR background refresh) serves from memory. */
export const TORRENT_LIST_CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
	torrents: QuiTorrent[];
	fetchedAt: number;
}

/** Keyed by qui ServiceInstance id (cuid). */
const cache = new Map<string, CacheEntry>();
/** In-flight fetches, keyed the same way — the dedup channel. */
const pending = new Map<string, Promise<QuiTorrent[]>>();

/**
 * Return qui's full torrent list for an instance, served from cache when
 * fresh, deduped against an in-flight fetch otherwise.
 *
 * @param quiInstanceId  qui ServiceInstance id — the cache key
 * @param client         qui client for this instance (caller already
 *                       constructed + ownership-scoped it)
 * @param nowMs          injectable clock for tests; defaults to Date.now()
 */
export async function getCachedAllTorrents(
	quiInstanceId: string,
	client: QuiClient,
	nowMs: () => number = Date.now,
): Promise<QuiTorrent[]> {
	const cached = cache.get(quiInstanceId);
	if (cached && nowMs() - cached.fetchedAt < TORRENT_LIST_CACHE_TTL_MS) {
		return cached.torrents;
	}

	// A fetch is already running — join it rather than starting a second
	// paginated walk. This is what collapses the summary+attention
	// double-fetch into one network cost per page load.
	const inflight = pending.get(quiInstanceId);
	if (inflight) return inflight;

	const fetchPromise = client
		.listAllTorrents()
		.then((torrents) => {
			cache.set(quiInstanceId, { torrents, fetchedAt: nowMs() });
			return torrents;
		})
		.finally(() => {
			// Clear the in-flight slot whether the fetch succeeded or
			// threw. On failure the cache is left untouched (the `.then`
			// never ran), so the next caller retries cleanly.
			pending.delete(quiInstanceId);
		});

	pending.set(quiInstanceId, fetchPromise);
	return fetchPromise;
}

/**
 * Drop cached torrent lists. Pass an id to clear one instance, or omit
 * to clear all. Used by tests and available for future write-through
 * invalidation after mutations.
 */
export function invalidateTorrentListCache(quiInstanceId?: string): void {
	if (quiInstanceId) cache.delete(quiInstanceId);
	else cache.clear();
}

/** Test-only introspection of cache + pending-map sizes. */
export function __torrentListCacheState(): { cached: number; pending: number } {
	return { cached: cache.size, pending: pending.size };
}
