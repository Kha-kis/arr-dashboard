import type { FastifyBaseLogger } from "fastify";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";
import type { PrismaClient } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import { withCurrentJellyfinConnection } from "./jellyfin-connection-guard.js";
import type { refreshJellyfinCache } from "./jellyfin-cache-refresher.js";

type Result = Awaited<ReturnType<typeof refreshJellyfinCache>>;
type Observer = {
	prisma: Pick<PrismaClient, "$transaction">;
	log: Pick<FastifyBaseLogger, "warn">;
};
const inFlight = new Map<string, Promise<Result>>();

async function recordJellyfinCacheRefreshFailure(
	instanceId: string,
	connectionFingerprint: string,
	message: string,
	observer: Observer,
): Promise<void> {
	try {
		await withCurrentJellyfinConnection(
			observer.prisma,
			instanceId,
			connectionFingerprint,
			async (tx) =>
				await recordCacheRefreshFailure(tx, instanceId, "jellyfin", message.slice(0, 500)),
		);
	} catch (error) {
		observer.log.warn(
			{ err: error, instanceId },
			"Failed to record Jellyfin cache refresh failure status",
		);
	}
}

export function runJellyfinCacheRefreshSingleFlight(
	instanceId: string,
	generation: string,
	refresh: (generation: string) => Promise<Result>,
	observer: Observer,
): Promise<Result> {
	const key = `${instanceId}:${generation}`;
	const existing = inFlight.get(key);
	if (existing) return existing;
	const pending = Promise.resolve()
		.then(async () => {
			try {
				const result = await refresh(generation);
				if ((!result.complete || !result.completedAt) && !result.superseded) {
					await recordJellyfinCacheRefreshFailure(
						instanceId,
						generation,
						result.errorMessages.slice(0, 3).join("; ") ||
							"Jellyfin refresh did not publish a complete generation",
						observer,
					);
				}
				return result;
			} catch (error) {
				await recordJellyfinCacheRefreshFailure(
					instanceId,
					generation,
					getErrorMessage(error, "Jellyfin cache refresh failed"),
					observer,
				);
				throw error;
			}
		})
		.catch((error) => {
			observer.log.warn(
				{ err: error, instanceId },
				getErrorMessage(error, "Jellyfin cache refresh failed"),
			);
			throw error;
		});
	inFlight.set(key, pending);
	void pending.finally(() => inFlight.delete(key)).catch(() => undefined);
	return pending;
}

export function clearJellyfinCacheRefreshSingleFlightsForTests(): void {
	inFlight.clear();
}
