import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import { recordWatchProviderCacheRefreshFailure } from "../services/provider-cache-status.js";
import type { OwnedProviderPublicationSnapshot } from "../services/provider-identity-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { refreshJellyfinCache } from "./jellyfin-cache-refresher.js";

type JellyfinCacheRefreshResult = Awaited<ReturnType<typeof refreshJellyfinCache>>;

const inFlightRefreshes = new Map<string, Promise<JellyfinCacheRefreshResult>>();

function refreshKey(instance: OwnedProviderPublicationSnapshot): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				instance.id,
				instance.userId,
				instance.service,
				instance.enabled,
				instance.expectedIdentity,
				instance.identityStatus,
				instance.connectionGeneration,
				instance.identityGeneration,
				instance.baseUrl,
				instance.encryptedApiKey,
				instance.encryptionIv,
				instance.encryptedHttpAuthCredentials,
				instance.httpAuthEncryptionIv,
			]),
		)
		.digest("hex");
}

type JellyfinCacheRefreshObserver = {
	prisma: Pick<PrismaClient, "$transaction">;
	log: Pick<FastifyBaseLogger, "warn">;
};

export async function recordJellyfinCacheRefreshFailure(
	instance: OwnedProviderPublicationSnapshot,
	message: string,
	observer: JellyfinCacheRefreshObserver,
): Promise<void> {
	await recordWatchProviderCacheRefreshFailure(
		observer.prisma,
		"jellyfin",
		message,
		instance,
		observer.log,
	);
}

async function runObservedRefresh(
	instance: OwnedProviderPublicationSnapshot,
	refresh: () => Promise<JellyfinCacheRefreshResult>,
	observer: JellyfinCacheRefreshObserver,
): Promise<JellyfinCacheRefreshResult> {
	try {
		const result = await refresh();
		if ((!result.complete || !result.completedAt) && !result.superseded) {
			await recordJellyfinCacheRefreshFailure(
				instance,
				result.errorMessages.slice(0, 3).join("; ") ||
					"Jellyfin refresh did not publish a complete generation",
				observer,
			);
		}
		return result;
	} catch (error) {
		await recordJellyfinCacheRefreshFailure(
			instance,
			getErrorMessage(error, "Unknown Jellyfin cache refresh error"),
			observer,
		);
		throw error;
	}
}

/** Coalesce only refreshes sharing the exact full publication authority. */
export function runJellyfinCacheRefreshSingleFlight(
	instance: OwnedProviderPublicationSnapshot,
	refresh: () => Promise<JellyfinCacheRefreshResult>,
	observer: JellyfinCacheRefreshObserver,
): Promise<JellyfinCacheRefreshResult> {
	const key = refreshKey(instance);
	const existing = inFlightRefreshes.get(key);
	if (existing) return existing;

	const pending = Promise.resolve().then(() => runObservedRefresh(instance, refresh, observer));
	inFlightRefreshes.set(key, pending);
	void pending
		.finally(() => {
			if (inFlightRefreshes.get(key) === pending) inFlightRefreshes.delete(key);
		})
		.catch(() => undefined);
	return pending;
}

export function clearJellyfinCacheRefreshSingleFlightsForTests(): void {
	inFlightRefreshes.clear();
}
