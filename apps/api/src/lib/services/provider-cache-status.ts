import type { FastifyBaseLogger } from "fastify";
import { recordCacheRefreshFailure } from "../cache-refresh-status.js";
import type { PrismaClient } from "../prisma.js";
import {
	type ProviderConnectionIdentity,
	withCurrentProviderConnection,
} from "./provider-connection-guard.js";
import {
	hasAuthoritativeProviderCacheGeneration,
	type OwnedProviderPublicationSnapshot,
	withCurrentProviderPublicationAuthority,
} from "./provider-identity-guard.js";

export type PlexCacheRefreshType = "plex" | "plex_episode";

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

/** Record Plex failure diagnostics only for the exact full publication authority. */
export async function recordPlexCacheRefreshFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: PlexCacheRefreshType,
	message: string,
	instance: OwnedProviderPublicationSnapshot,
	log: Pick<FastifyBaseLogger, "warn">,
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		const attemptedAt = new Date();
		const result = await withCurrentProviderPublicationAuthority(prisma, instance, async (tx) => {
			const status = await tx.cacheRefreshStatus.findUnique({
				where: { instanceId_cacheType: { instanceId: instance.id, cacheType } },
				select: { connectionGeneration: true, identityGeneration: true },
			});
			if (status && !hasAuthoritativeProviderCacheGeneration(status, instance)) return false;

			const safeMessage = message.slice(0, 500);
			await tx.cacheRefreshStatus.upsert({
				where: { instanceId_cacheType: { instanceId: instance.id, cacheType } },
				create: {
					instanceId: instance.id,
					cacheType,
					lastRefreshedAt: attemptedAt,
					lastResult: "error",
					lastErrorMessage: safeMessage,
					itemCount: 0,
					lastAttemptAt: attemptedAt,
					lastAttemptResult: "error",
					lastAttemptErrorMessage: safeMessage,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
				},
				update: {
					lastErrorMessage: safeMessage,
					lastAttemptAt: attemptedAt,
					lastAttemptResult: "error",
					lastAttemptErrorMessage: safeMessage,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
				},
			});
			return true;
		});
		return result.matched && result.value ? "recorded" : "superseded";
	} catch (error) {
		log.warn(
			{ err: error, instanceId: instance.id, cacheType },
			"Failed to record Plex cache failure status",
		);
		return "failed";
	}
}
