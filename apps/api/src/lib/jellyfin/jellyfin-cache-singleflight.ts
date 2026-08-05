import type { FastifyBaseLogger } from "fastify";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";
import type { PrismaClient } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { refreshJellyfinCache } from "./jellyfin-cache-refresher.js";

type JellyfinCacheRefreshResult = Awaited<ReturnType<typeof refreshJellyfinCache>>;

const inFlightRefreshes = new Map<string, Promise<JellyfinCacheRefreshResult>>();

function refreshKey(instanceId: string, connectionFingerprint: string): string {
	return `${instanceId}:${connectionFingerprint}`;
}

type JellyfinCacheRefreshObserver = {
	prisma: Pick<PrismaClient, "cacheRefreshStatus">;
	log: Pick<FastifyBaseLogger, "warn">;
};

async function recordRefreshFailure(
	instanceId: string,
	message: string,
	observer: JellyfinCacheRefreshObserver,
): Promise<void> {
	try {
		await recordCacheRefreshFailure(observer.prisma, instanceId, "jellyfin", message.slice(0, 500));
	} catch (statusError) {
		observer.log.warn(
			{ err: statusError, instanceId },
			"Failed to record Jellyfin cache refresh failure status",
		);
	}
}

async function runObservedRefresh(
	instanceId: string,
	refresh: () => Promise<JellyfinCacheRefreshResult>,
	observer: JellyfinCacheRefreshObserver,
): Promise<JellyfinCacheRefreshResult> {
	try {
		const result = await refresh();
		if ((!result.complete || !result.completedAt) && !result.superseded) {
			await recordRefreshFailure(
				instanceId,
				result.errorMessages.slice(0, 3).join("; ") ||
					"Jellyfin refresh did not publish a complete generation",
				observer,
			);
		}
		return result;
	} catch (error) {
		await recordRefreshFailure(
			instanceId,
			getErrorMessage(error, "Unknown Jellyfin cache refresh error"),
			observer,
		);
		throw error;
	}
}

/**
 * Coalesce full Jellyfin/Emby cache refreshes per service instance.
 *
 * Scheduled refreshes, Pulse retries, manual refreshes, and cleanup safety
 * revalidation all use the same process-local gate. Every caller observes the
 * same complete/incomplete result, and a settled attempt never blocks retry.
 */
export function runJellyfinCacheRefreshSingleFlight(
	instanceId: string,
	connectionFingerprint: string,
	refresh: (expectedConnectionFingerprint: string) => Promise<JellyfinCacheRefreshResult>,
	observer: JellyfinCacheRefreshObserver,
): Promise<JellyfinCacheRefreshResult> {
	const key = refreshKey(instanceId, connectionFingerprint);
	const existing = inFlightRefreshes.get(key);
	if (existing) return existing;

	const pending = Promise.resolve().then(() =>
		runObservedRefresh(instanceId, () => refresh(connectionFingerprint), observer),
	);
	inFlightRefreshes.set(key, pending);
	void pending
		.finally(() => {
			if (inFlightRefreshes.get(key) === pending) {
				inFlightRefreshes.delete(key);
			}
		})
		.catch(() => undefined);
	return pending;
}

export function clearJellyfinCacheRefreshSingleFlightsForTests(): void {
	inFlightRefreshes.clear();
}
