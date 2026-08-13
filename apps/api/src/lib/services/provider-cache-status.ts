import type { FastifyBaseLogger } from "fastify";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";
import type { PrismaClient } from "../prisma.js";
import {
	type ProviderConnectionIdentity,
	withCurrentProviderConnection,
} from "./provider-connection-guard.js";

/** Persist an in-flight attempt before any provider request is sent. */
export async function recordProviderCacheRefreshPending(
	prisma: Pick<PrismaClient, "$transaction">,
	instanceId: string,
	cacheType: string,
	expected: ProviderConnectionIdentity,
	log: Pick<FastifyBaseLogger, "warn">,
	attemptedAt: Date = new Date(),
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		const result = await withCurrentProviderConnection(
			prisma,
			instanceId,
			expected,
			async (tx) =>
				await tx.cacheRefreshStatus.upsert({
					where: { instanceId_cacheType: { instanceId, cacheType } },
					create: {
						instanceId,
						cacheType,
						lastRefreshedAt: attemptedAt,
						lastResult: "error",
						lastErrorMessage: "No complete cache generation has been published",
						itemCount: 0,
						lastAttemptAt: attemptedAt,
						lastAttemptResult: "pending",
						lastAttemptErrorMessage: null,
					},
					update: {
						lastAttemptAt: attemptedAt,
						lastAttemptResult: "pending",
						lastAttemptErrorMessage: null,
					},
				}),
		);
		return result.matched ? "recorded" : "superseded";
	} catch (error) {
		log.warn(
			{ err: error, instanceId, cacheType },
			"Failed to record provider cache refresh pending status",
		);
		return "failed";
	}
}

/**
 * Record a provider refresh failure only while the connection generation that
 * produced the attempt is still current.
 */
export async function recordProviderCacheRefreshFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	instanceId: string,
	cacheType: string,
	message: string,
	expected: ProviderConnectionIdentity,
	log: Pick<FastifyBaseLogger, "warn">,
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		const result = await withCurrentProviderConnection(
			prisma,
			instanceId,
			expected,
			async (tx) =>
				await recordCacheRefreshFailure(tx, instanceId, cacheType, message.slice(0, 500)),
		);
		return result.matched ? "recorded" : "superseded";
	} catch (error) {
		log.warn(
			{ err: error, instanceId, cacheType },
			"Failed to record provider cache failure status",
		);
		return "failed";
	}
}
