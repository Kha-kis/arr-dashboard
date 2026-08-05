import type { refreshJellyfinCache } from "./jellyfin-cache-refresher.js";

type JellyfinCacheRefreshResult = Awaited<ReturnType<typeof refreshJellyfinCache>>;

const inFlightRefreshes = new Map<string, Promise<JellyfinCacheRefreshResult>>();

/**
 * Coalesce full Jellyfin/Emby cache refreshes per service instance.
 *
 * Scheduled refreshes, Pulse retries, manual refreshes, and cleanup safety
 * revalidation all use the same process-local gate. Every caller observes the
 * same complete/incomplete result, and a settled attempt never blocks retry.
 */
export function runJellyfinCacheRefreshSingleFlight(
	instanceId: string,
	refresh: () => Promise<JellyfinCacheRefreshResult>,
): Promise<JellyfinCacheRefreshResult> {
	const existing = inFlightRefreshes.get(instanceId);
	if (existing) return existing;

	const pending = Promise.resolve().then(refresh);
	inFlightRefreshes.set(instanceId, pending);
	void pending
		.finally(() => {
			if (inFlightRefreshes.get(instanceId) === pending) {
				inFlightRefreshes.delete(instanceId);
			}
		})
		.catch(() => undefined);
	return pending;
}

export function clearJellyfinCacheRefreshSingleFlightsForTests(): void {
	inFlightRefreshes.clear();
}
