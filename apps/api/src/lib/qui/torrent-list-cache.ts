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
/** Beyond this age, the home page must not use a cached list for KPIs. */
export const TORRENT_LIST_MAX_LAST_KNOWN_MS = 15 * 60_000;

export type TorrentListObservation =
	| {
			availability: "current" | "last-known";
			torrents: QuiTorrent[];
			fetchedAtMs: number;
			complete: boolean;
	  }
	| { availability: "unavailable"; torrents: []; fetchedAtMs: null; failure?: unknown };

interface CacheEntry {
	torrents: QuiTorrent[];
	fetchedAt: number;
	complete: boolean;
}

/** Keyed by qui ServiceInstance id (cuid). */
const cache = new Map<string, CacheEntry>();
/** In-flight fetches, keyed the same way — the dedup channel. */
const pending = new Map<string, { promise: Promise<CacheEntry>; protectReader: () => void }>();
/** A replaced connection must not be repopulated by its old in-flight fetch. */
const generations = new Map<string, symbol>();

function currentGeneration(quiInstanceId: string): symbol {
	let generation = generations.get(quiInstanceId);
	if (!generation) {
		generation = Symbol();
		generations.set(quiInstanceId, generation);
	}
	return generation;
}

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
	signal?: AbortSignal,
	readerNeedsResult = false,
): Promise<CacheEntry> {
	const inflight = pending.get(quiInstanceId);
	if (inflight) {
		// A foreground reader makes this shared flight more than optional boot work.
		if (readerNeedsResult) inflight.protectReader();
		return inflight.promise;
	}
	const generation = currentGeneration(quiInstanceId);
	const cancellation = signal ? new AbortController() : undefined;
	const abort = () => cancellation?.abort(signal?.reason);
	signal?.addEventListener("abort", abort, { once: true });
	const releaseCancellation = () => signal?.removeEventListener("abort", abort);
	let inventory: ReturnType<QuiClient["listTorrentInventory"]>;
	try {
		inventory = client.listTorrentInventory(
			cancellation ? { signal: cancellation.signal } : undefined,
		);
	} catch (error) {
		releaseCancellation();
		throw error;
	}

	const fetchPromise = inventory
		.then(({ torrents, complete }) => {
			cancellation?.signal.throwIfAborted();
			if (generations.get(quiInstanceId) !== generation)
				throw new Error("Torrent list cache was invalidated");
			const entry = { torrents, complete, fetchedAt: nowMs() };
			cache.set(quiInstanceId, entry);
			return entry;
		})
		.finally(() => {
			releaseCancellation();
			if (pending.get(quiInstanceId)?.promise === fetchPromise) pending.delete(quiInstanceId);
		});

	pending.set(quiInstanceId, { promise: fetchPromise, protectReader: releaseCancellation });
	return fetchPromise;
}

/**
 * Pre-warm must await revalidation, not the UI's immediate stale array.
 * Only a newly started flight receives this caller's cancellation signal:
 * joining an existing UI flight does not transfer ownership or cancel it.
 */
export async function prewarmTorrentList(
	quiInstanceId: string,
	client: QuiClient,
	signal: AbortSignal,
	nowMs: () => number = Date.now,
): Promise<QuiTorrent[]> {
	signal.throwIfAborted();
	const cached = cache.get(quiInstanceId);
	if (cached && nowMs() - cached.fetchedAt < TORRENT_LIST_CACHE_TTL_MS) return cached.torrents;
	const entry = await refreshTorrentList(quiInstanceId, client, nowMs, signal);
	signal.throwIfAborted();
	return entry.torrents;
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
	const refresh = refreshTorrentList(quiInstanceId, client, nowMs, undefined, !cached);

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
	return (await refresh).torrents;
}

/**
 * A bounded observation for user-facing KPIs. Unlike the legacy array-only
 * accessor, callers can distinguish current, last-known, and unavailable
 * evidence without presenting an expired list as live provider data.
 */
export async function getTorrentListObservation(
	quiInstanceId: string,
	client: QuiClient,
	nowMs: () => number = Date.now,
): Promise<TorrentListObservation> {
	const cached = cache.get(quiInstanceId);
	const ageMs = cached ? nowMs() - cached.fetchedAt : null;
	if (cached && ageMs !== null && ageMs < TORRENT_LIST_CACHE_TTL_MS) {
		return {
			availability: "current",
			torrents: cached.torrents,
			fetchedAtMs: cached.fetchedAt,
			complete: cached.complete,
		};
	}

	const refresh = refreshTorrentList(quiInstanceId, client, nowMs, undefined, !cached);
	if (cached) {
		// Keep the refresh alive after returning, but do not leak a rejected
		// provider request as an unhandled promise rejection.
		void refresh.catch(() => undefined);
		if (ageMs !== null && ageMs <= TORRENT_LIST_MAX_LAST_KNOWN_MS) {
			return {
				availability: "last-known",
				torrents: cached.torrents,
				fetchedAtMs: cached.fetchedAt,
				complete: cached.complete,
			};
		}
		return { availability: "unavailable", torrents: [], fetchedAtMs: null };
	}

	try {
		const entry = await refresh;
		return {
			availability: "current",
			torrents: entry.torrents,
			fetchedAtMs: entry.fetchedAt,
			complete: entry.complete,
		};
	} catch (failure) {
		return { availability: "unavailable", torrents: [], fetchedAtMs: null, failure };
	}
}

/**
 * Drop cached torrent lists. Pass an id to clear one instance, or omit
 * to clear all. Used by tests and available for future write-through
 * invalidation after mutations.
 */
export function invalidateTorrentListCache(quiInstanceId?: string): void {
	if (quiInstanceId) {
		generations.delete(quiInstanceId);
		cache.delete(quiInstanceId);
		pending.delete(quiInstanceId);
	} else {
		generations.clear();
		cache.clear();
		pending.clear();
	}
}

/** Test-only introspection of cache + pending-map sizes. */
export function __torrentListCacheState(): { cached: number; pending: number } {
	return { cached: cache.size, pending: pending.size };
}
