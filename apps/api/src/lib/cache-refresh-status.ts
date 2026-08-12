import type { PrismaClient } from "./prisma.js";

export type CacheRefreshPublication = {
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
};

/** Destructive consumers may use only a complete generation published by this attempt. */
export function assertCompleteCacheRefresh(
	source: string,
	result: CacheRefreshPublication,
): asserts result is CacheRefreshPublication & { complete: true; completedAt: Date } {
	if (result.superseded) throw new Error(`${source} evidence refresh was superseded`);
	if (!result.complete) throw new Error(`${source} evidence refresh was incomplete`);
	if (!result.completedAt) throw new Error(`${source} evidence refresh was not published`);
}

/** Record a failed attempt without moving an existing successful generation. */
export async function recordCacheRefreshFailure(
	prisma: Pick<PrismaClient, "cacheRefreshStatus">,
	instanceId: string,
	cacheType: string,
	message: string,
	attemptedAt: Date = new Date(),
): Promise<void> {
	await prisma.cacheRefreshStatus.upsert({
		where: { instanceId_cacheType: { instanceId, cacheType } },
		create: {
			instanceId,
			cacheType,
			lastRefreshedAt: attemptedAt,
			lastResult: "error",
			lastErrorMessage: message,
			itemCount: 0,
			lastAttemptAt: attemptedAt,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: message,
		},
		update: {
			lastAttemptAt: attemptedAt,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: message,
		},
	});
}
