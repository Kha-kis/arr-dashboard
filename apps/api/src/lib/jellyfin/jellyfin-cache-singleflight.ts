import { createHash } from "node:crypto";
import type { ProviderCacheRefreshAttempt } from "../services/provider-cache-status.js";
import type { ProviderPublicationAuthority } from "../services/provider-identity-guard.js";

export type JellyfinCacheSingleFlightType = "jellyfin" | "jellyfin_episode";

const inFlightRefreshes = new Map<string, Promise<unknown>>();

function refreshKey(
	authority: ProviderPublicationAuthority,
	cacheType: JellyfinCacheSingleFlightType,
	cleanupRunClaimToken?: string,
	attempt?: ProviderCacheRefreshAttempt,
): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				authority.id,
				authority.userId,
				authority.service,
				authority.enabled,
				authority.expectedIdentity,
				authority.identityStatus,
				authority.connectionGeneration,
				authority.identityGeneration,
				authority.baseUrl,
				authority.encryptedApiKey,
				authority.encryptionIv,
				authority.encryptedHttpAuthCredentials,
				authority.httpAuthEncryptionIv,
				cacheType,
				cleanupRunClaimToken ?? null,
				attempt?.resultMarker ?? null,
			]),
		)
		.digest("hex");
}

/** Coalesce only refreshes sharing the exact full plaintext-free authority. */
export function runJellyfinCacheRefreshSingleFlight<TResult>(
	authority: ProviderPublicationAuthority,
	cacheType: JellyfinCacheSingleFlightType,
	refresh: () => Promise<TResult>,
	cleanupRunClaimToken?: string,
): Promise<TResult> {
	const key = refreshKey(authority, cacheType, cleanupRunClaimToken);
	return runSingleFlightByKey(key, refresh);
}

/**
 * Coalesce a refresh that already owns a durable attempt. The opaque marker
 * partitions this local optimization so a stale callback cannot share a newer
 * attempt's promise.
 */
export function runJellyfinCacheRefreshSingleFlightWithAttempt<TResult>(
	authority: ProviderPublicationAuthority,
	cacheType: JellyfinCacheSingleFlightType,
	attempt: ProviderCacheRefreshAttempt,
	refresh: () => Promise<TResult>,
	cleanupRunClaimToken?: string,
): Promise<TResult> {
	const key = refreshKey(authority, cacheType, cleanupRunClaimToken, attempt);
	return runSingleFlightByKey(key, refresh);
}

function runSingleFlightByKey<TResult>(
	key: string,
	refresh: () => Promise<TResult>,
): Promise<TResult> {
	const existing = inFlightRefreshes.get(key);
	if (existing) return existing as Promise<TResult>;

	const pending = Promise.resolve().then(refresh);
	inFlightRefreshes.set(key, pending);
	void pending.then(
		() => {
			if (inFlightRefreshes.get(key) === pending) inFlightRefreshes.delete(key);
		},
		() => {
			if (inFlightRefreshes.get(key) === pending) inFlightRefreshes.delete(key);
		},
	);
	return pending;
}

export function clearJellyfinCacheRefreshSingleFlightsForTests(): void {
	inFlightRefreshes.clear();
}
