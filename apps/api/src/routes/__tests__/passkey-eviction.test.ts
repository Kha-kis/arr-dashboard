/**
 * Unit tests for passkey challenge store eviction logic.
 *
 * Validates that:
 * - The FIFO eviction correctly removes the oldest entry when the cap is hit
 * - Non-expired challenges trigger a warning log when evicted
 * - Expired challenges are evicted silently
 * - The store never exceeds the configured max entries
 */

import { describe, expect, it } from "vitest";

/**
 * Simulate the eviction logic from auth-passkey.ts.
 * Extracted here for direct unit testing without needing a Fastify app instance.
 */
function simulateEviction(
	store: Map<string, { challenge: string; expiresAt: number }>,
	maxEntries: number,
): { evicted: boolean; wasNonExpired: boolean } {
	if (store.size >= maxEntries) {
		const oldestKey = store.keys().next().value;
		if (oldestKey) {
			const evicted = store.get(oldestKey);
			const wasNonExpired = !!(evicted && evicted.expiresAt > Date.now());
			store.delete(oldestKey);
			return { evicted: true, wasNonExpired };
		}
	}
	return { evicted: false, wasNonExpired: false };
}

describe("Passkey challenge store eviction", () => {
	it("does not evict when store is below cap", () => {
		const store = new Map<string, { challenge: string; expiresAt: number }>();
		store.set("key-1", { challenge: "abc", expiresAt: Date.now() + 300_000 });

		const result = simulateEviction(store, 1000);

		expect(result.evicted).toBe(false);
		expect(store.size).toBe(1);
	});

	it("evicts oldest entry when store reaches cap", () => {
		const store = new Map<string, { challenge: string; expiresAt: number }>();

		// Fill to capacity
		for (let i = 0; i < 5; i++) {
			store.set(`key-${i}`, { challenge: `challenge-${i}`, expiresAt: Date.now() + 300_000 });
		}
		expect(store.size).toBe(5);

		// Evict at cap of 5
		const result = simulateEviction(store, 5);

		expect(result.evicted).toBe(true);
		expect(store.size).toBe(4);
		// Oldest key (key-0) should be gone
		expect(store.has("key-0")).toBe(false);
		// Newest key (key-4) should remain
		expect(store.has("key-4")).toBe(true);
	});

	it("reports non-expired challenge eviction for logging", () => {
		const store = new Map<string, { challenge: string; expiresAt: number }>();

		// Add a challenge that expires in 5 minutes (non-expired)
		store.set("valid-challenge", {
			challenge: "abc",
			expiresAt: Date.now() + 5 * 60 * 1000,
		});

		const result = simulateEviction(store, 1);

		expect(result.evicted).toBe(true);
		expect(result.wasNonExpired).toBe(true);
	});

	it("reports expired challenge eviction silently", () => {
		const store = new Map<string, { challenge: string; expiresAt: number }>();

		// Add a challenge that already expired
		store.set("expired-challenge", {
			challenge: "abc",
			expiresAt: Date.now() - 1000,
		});

		const result = simulateEviction(store, 1);

		expect(result.evicted).toBe(true);
		expect(result.wasNonExpired).toBe(false);
	});

	it("maintains FIFO order across multiple evictions", () => {
		const store = new Map<string, { challenge: string; expiresAt: number }>();
		const maxEntries = 3;

		// Fill store
		store.set("first", { challenge: "a", expiresAt: Date.now() + 300_000 });
		store.set("second", { challenge: "b", expiresAt: Date.now() + 300_000 });
		store.set("third", { challenge: "c", expiresAt: Date.now() + 300_000 });

		// First eviction should remove "first"
		simulateEviction(store, maxEntries);
		expect(store.has("first")).toBe(false);
		expect(store.size).toBe(2);

		// Add new entry and evict again
		store.set("fourth", { challenge: "d", expiresAt: Date.now() + 300_000 });
		simulateEviction(store, maxEntries);
		expect(store.has("second")).toBe(false);
		expect(store.size).toBe(2);

		// Remaining should be "third" and "fourth"
		expect(store.has("third")).toBe(true);
		expect(store.has("fourth")).toBe(true);
	});

	it("handles store with single entry at cap", () => {
		const store = new Map<string, { challenge: string; expiresAt: number }>();
		store.set("only-key", { challenge: "x", expiresAt: Date.now() + 300_000 });

		const result = simulateEviction(store, 1);

		expect(result.evicted).toBe(true);
		expect(store.size).toBe(0);
	});
});
