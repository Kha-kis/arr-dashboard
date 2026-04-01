/**
 * Server-side Plex Token Store
 *
 * Keeps Plex auth tokens in-memory on the backend so they never
 * reach the browser during OAuth flows. Used by both the Plex OAuth
 * setup and Seerr auto-setup (which bootstraps via a Plex token).
 *
 * Tokens are short-lived (10 min TTL) with bounded capacity (100 entries).
 */

import { randomBytes } from "node:crypto";

interface StoredToken {
	authToken: string;
	expiresAt: number;
}

const tokenStore = new Map<string, StoredToken>();
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_MAX_ENTRIES = 100;

/** Start the cleanup interval. Returns the timer ref for graceful shutdown. */
export function startCleanupInterval(): ReturnType<typeof setInterval> {
	return setInterval(
		() => {
			const now = Date.now();
			for (const [ref, data] of tokenStore.entries()) {
				if (data.expiresAt < now) {
					tokenStore.delete(ref);
				}
			}
		},
		5 * 60 * 1000,
	);
}

/** Store a token server-side and return a short-lived opaque reference. */
export function storeToken(authToken: string): string {
	// Evict oldest if at capacity
	if (tokenStore.size >= TOKEN_MAX_ENTRIES) {
		const oldestKey = tokenStore.keys().next().value;
		if (oldestKey) tokenStore.delete(oldestKey);
	}
	const ref = randomBytes(32).toString("hex");
	tokenStore.set(ref, { authToken, expiresAt: Date.now() + TOKEN_TTL_MS });
	return ref;
}

/** Retrieve a stored token without deleting it. Returns null if expired or missing. */
export function peekToken(ref: string): string | null {
	const stored = tokenStore.get(ref);
	if (!stored || stored.expiresAt < Date.now()) {
		tokenStore.delete(ref);
		return null;
	}
	return stored.authToken;
}
