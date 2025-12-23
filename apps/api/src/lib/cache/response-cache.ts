/**
 * Simple In-Memory Response Cache
 *
 * Provides short-lived caching for expensive API responses.
 * Cache entries automatically expire and are cleaned up periodically.
 */

interface CacheEntry<T> {
	data: T;
	expiresAt: number;
}

/**
 * Generic in-memory cache with TTL support.
 */
export class ResponseCache<T> {
	private cache = new Map<string, CacheEntry<T>>();
	private cleanupInterval: NodeJS.Timeout | null = null;

	constructor(private defaultTtlMs: number = 30_000) {
		// Run cleanup every minute
		this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
	}

	/**
	 * Get a cached value if it exists and hasn't expired.
	 */
	get(key: string): T | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;

		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return undefined;
		}

		return entry.data;
	}

	/**
	 * Set a value in the cache with optional custom TTL.
	 */
	set(key: string, data: T, ttlMs?: number): void {
		this.cache.set(key, {
			data,
			expiresAt: Date.now() + (ttlMs ?? this.defaultTtlMs),
		});
	}

	/**
	 * Check if a key exists and hasn't expired.
	 */
	has(key: string): boolean {
		return this.get(key) !== undefined;
	}

	/**
	 * Delete a specific key from the cache.
	 */
	delete(key: string): boolean {
		return this.cache.delete(key);
	}

	/**
	 * Invalidate all entries matching a prefix.
	 * Useful for invalidating all cached data for a user.
	 */
	invalidatePrefix(prefix: string): number {
		let count = 0;
		for (const key of this.cache.keys()) {
			if (key.startsWith(prefix)) {
				this.cache.delete(key);
				count++;
			}
		}
		return count;
	}

	/**
	 * Clear all entries from the cache.
	 */
	clear(): void {
		this.cache.clear();
	}

	/**
	 * Get the current size of the cache.
	 */
	get size(): number {
		return this.cache.size;
	}

	/**
	 * Clean up expired entries.
	 */
	private cleanup(): void {
		const now = Date.now();
		for (const [key, entry] of this.cache.entries()) {
			if (now > entry.expiresAt) {
				this.cache.delete(key);
			}
		}
	}

	/**
	 * Stop the cleanup interval (for graceful shutdown).
	 */
	destroy(): void {
		if (this.cleanupInterval) {
			clearInterval(this.cleanupInterval);
			this.cleanupInterval = null;
		}
		this.cache.clear();
	}
}

/**
 * Build a cache key from components.
 */
export function buildCacheKey(...parts: (string | number | undefined | null)[]): string {
	return parts.filter((p) => p != null).join(":");
}
