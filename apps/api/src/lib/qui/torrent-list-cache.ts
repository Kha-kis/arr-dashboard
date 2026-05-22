/**
 * Stale-while-revalidate cache for qui's full torrent list (Phase 2.6 —
 * perf; SWR hardening).
 *
 * `client.listAllTorrents()` paginates through every torrent qui knows
 * (up to 50 pages of 2000). The `/qui` home page mounts both the summary
 * and attention hooks at once, so without a cache that full fetch runs
 * twice in parallel on every page load — the measured ~3.5s.
 *
 * This module addresses three things:
 *   1. In-flight dedup — if a fetch for an instance is already running,
 *      every other caller awaits the SAME promise instead of starting a
 *      second paginated walk. (Same pattern as the inode-index
 *      `INDEX_PENDING` map.) This collapses the summary+attention
 *      double-fetch on every page load.
 *   2. Stale-while-revalidate — once an instance has been fetched once,
 *      a stale entry is served *immediately* and a refresh runs in the
 *      background. No user request ever blocks on the multi-page walk
 *      again, except the very first one after a cold process start.
 *      Previously every TTL expiry made one unlucky user wait the full
 *      ~3.5s; SWR removes that recurring cliff.
 *   3. Process-local, not persisted — a restart re-warms on the first
 *      request (the only request that still pays the cold cost).
 *
 * Staleness is acceptable here: the `/qui` home page is a KPI overview.
 * Aggregate torrent counts don't shift meaningfully across a few minutes,
 * and real-time error alerting is handled separately by the qui
 * notification feed. SWR bounds the staleness to roughly one TTL window
 * while making it never block a request.
 */

import type { QuiTorrent } from "@arr/shared";
import type { QuiClient } from "./client-factory.js";

/** Age past which a cached entry is considered stale. A stale entry is
 * still served (stale-while-revalidate) while a background refresh runs. */
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
 * Start a paginated fetch for an instance, or join the one already
 * running. The promise writes the result into `cache` on success and
 * clears the `pending` slot once settled (success or failure). On
 * failure the cache is left untouched, so any stale entry survives and
 * the next call simply retries.
 */
function refreshTorrentList(
	quiInstanceId: string,
	client: QuiClient,
	nowMs: () => number,
): Promise<QuiTorrent[]> {
	const inflight = pending.get(quiInstanceId);
	if (inflight) return inflight;

	const fetchPromise = client
		.listAllTorrents()
		.then((torrents) => {
			cache.set(quiInstanceId, { torrents, fetchedAt: nowMs() });
			return torrents;
		})
		.finally(() => {
			pending.delete(quiInstanceId);
		});

	pending.set(quiInstanceId, fetchPromise);
	return fetchPromise;
}

/**
 * Return qui's full torrent list for an instance.
 *
 * - Fresh cache entry  → served straight from memory.
 * - Stale cache entry  → served immediately; a deduped refresh runs in
 *                        the background (stale-while-revalidate).
 * - No cache entry yet → the caller awaits the paginated walk (the only
 *                        request that pays the cold cost).
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

	// Stale or cold — kick a deduped refresh.
	const refresh = refreshTorrentList(quiInstanceId, client, nowMs);

	if (cached) {
		// Stale-while-revalidate: serve the stale list now, let the
		// refresh land in the background. A rejected refresh is swallowed
		// here — it's non-fatal (stale data was already served, and the
		// next call retries), and an unhandled rejection would otherwise
		// crash the process.
		void refresh.catch(() => undefined);
		return cached.torrents;
	}

	// Cold start — nothing cached at all, so this caller must wait.
	return refresh;
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
