import type { PrismaClient } from "./prisma.js";

/**
 * Record a failed refresh attempt without moving an existing successful
 * generation pointer. The create branch represents an instance that has never
 * published a complete generation; the update branch changes only diagnostic
 * text and deliberately preserves status, timestamp, and count.
 */
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
			lastErrorMessage: message,
			lastAttemptAt: attemptedAt,
			lastAttemptResult: "error",
			lastAttemptErrorMessage: message,
		},
	});
}
