/**
 * Seerr Server-Side Cache
 *
 * In-memory TTL cache for Seerr data that changes slowly:
 * - Movie/TV genres per instance (1h TTL)
 * - Open issue counts per instance (5min TTL)
 *
 * Follows the DedupGate pattern: Map + setInterval cleanup + timer.unref() + destroy().
 */

const CLEANUP_INTERVAL_MS = 60_000; // 1 minute

/** 1 hour for genres */
export const GENRE_TTL_MS = 60 * 60 * 1000;

/** 5 minutes for issue counts */
export const ISSUE_COUNT_TTL_MS = 5 * 60 * 1000;

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

export class SeerrCache {
	private readonly store = new Map<string, CacheEntry<unknown>>();
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;

	constructor() {
		this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
		this.cleanupTimer.unref();
	}

	get<T>(key: string): T | undefined {
		const entry = this.store.get(key);
		if (!entry) return undefined;
		if (Date.now() >= entry.expiresAt) {
			this.store.delete(key);
			return undefined;
		}
		return entry.value as T;
	}

	set<T>(key: string, value: T, ttlMs: number): void {
		this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
	}

	/** Invalidate all keys matching a prefix */
	invalidate(pattern: string): void {
		for (const key of this.store.keys()) {
			if (key.startsWith(pattern)) {
				this.store.delete(key);
			}
		}
	}

	/** Invalidate all cached data for a specific instance */
	invalidateInstance(instanceId: string): number {
		let cleared = 0;
		// Match structured key format "prefix:instanceId" or "prefix:instanceId:suffix"
		// to prevent false matches when one instance ID is a substring of another.
		const suffix = `:${instanceId}`;
		for (const key of this.store.keys()) {
			if (key.endsWith(suffix) || key.includes(`${suffix}:`)) {
				this.store.delete(key);
				cleared++;
			}
		}
		return cleared;
	}

	/** Remove all expired entries */
	private cleanup(): void {
		const now = Date.now();
		for (const [key, entry] of this.store) {
			if (now >= entry.expiresAt) {
				this.store.delete(key);
			}
		}
	}

	destroy(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		this.store.clear();
	}
}

// Cache key builders
export function genreCacheKey(instanceId: string, type: "movie" | "tv"): string {
	return `genres:${instanceId}:${type}`;
}

export function issueCountCacheKey(instanceId: string): string {
	return `issue_counts:${instanceId}`;
}
