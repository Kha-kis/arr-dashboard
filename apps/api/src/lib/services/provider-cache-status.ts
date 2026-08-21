import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import {
	hasAuthoritativeProviderCacheGeneration,
	type ProviderIdentityGuardOptions,
	type ProviderPublicationAuthority,
	withCurrentProviderPublicationAuthority,
} from "./provider-identity-guard.js";

export type WatchProviderCacheRefreshType =
	| "plex"
	| "plex_episode"
	| "jellyfin"
	| "jellyfin_episode"
	| "tautulli";
export type PlexCacheRefreshType = Extract<WatchProviderCacheRefreshType, "plex" | "plex_episode">;

export type PlexCacheRefreshAttempt = {
	attemptedAt: Date;
	resultMarker: string;
};

export type ProviderCacheStatusGenerationRelation =
	| "current"
	| "obsolete"
	| "future-or-inconsistent";

type ProviderCacheStatusGeneration = {
	connectionGeneration: number | null;
	identityGeneration: number | null;
};

/**
 * Classify persisted cache provenance relative to the exact verified service
 * authority. Unknown, unsafe, future, and crossed state fail closed.
 */
export function classifyProviderCacheStatusGeneration(
	status: unknown,
	authority: unknown,
): ProviderCacheStatusGenerationRelation {
	if (!isGenerationAuthority(authority) || !isStatusGeneration(status)) {
		return "future-or-inconsistent";
	}
	if (
		(status.connectionGeneration !== null &&
			status.connectionGeneration > authority.connectionGeneration) ||
		(status.identityGeneration !== null && status.identityGeneration > authority.identityGeneration)
	) {
		return "future-or-inconsistent";
	}
	if (
		status.connectionGeneration === authority.connectionGeneration &&
		status.identityGeneration === authority.identityGeneration
	) {
		return "current";
	}
	return "obsolete";
}

/**
 * Revoke prior Plex mutation authority before any upstream read. The opaque
 * marker doubles as a durable cross-process claim without requiring a schema
 * change; only the attempt that still owns this exact marker may finish.
 */
export async function beginPlexCacheRefreshAttempt(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: PlexCacheRefreshType,
	instance: ProviderPublicationAuthority,
	options: ProviderIdentityGuardOptions = {},
): Promise<PlexCacheRefreshAttempt | null> {
	const attemptedAt = new Date();
	const resultMarker = `in_progress:${randomUUID()}`;
	const result = await withCurrentProviderPublicationAuthority(
		prisma,
		instance,
		async (tx) => {
			const status = await tx.cacheRefreshStatus.findUnique({
				where: { instanceId_cacheType: { instanceId: instance.id, cacheType } },
				select: {
					id: true,
					connectionGeneration: true,
					identityGeneration: true,
					lastAttemptAt: true,
					lastAttemptResult: true,
				},
			});
			if (status) {
				const relation = classifyProviderCacheStatusGeneration(status, instance);
				if (relation === "future-or-inconsistent") return false;
				if (relation === "obsolete") {
					const takeover = await tx.cacheRefreshStatus.updateMany({
						where: {
							id: status.id,
							instanceId: instance.id,
							cacheType,
							connectionGeneration: status.connectionGeneration,
							identityGeneration: status.identityGeneration,
							lastAttemptAt: status.lastAttemptAt,
							lastAttemptResult: status.lastAttemptResult,
						},
						data: {
							lastRefreshedAt: attemptedAt,
							lastResult: "error",
							lastErrorMessage: "Plex cache refresh has not published a generation",
							itemCount: 0,
							generationId: null,
							generationMetadata: null,
							lastAttemptAt: attemptedAt,
							lastAttemptResult: resultMarker,
							lastAttemptErrorMessage: null,
							connectionGeneration: instance.connectionGeneration,
							identityGeneration: instance.identityGeneration,
						},
					});
					return takeover.count === 1;
				}
			}
			await tx.cacheRefreshStatus.upsert({
				where: { instanceId_cacheType: { instanceId: instance.id, cacheType } },
				create: {
					instanceId: instance.id,
					cacheType,
					lastRefreshedAt: attemptedAt,
					lastResult: "error",
					lastErrorMessage: "Plex cache refresh has not published a generation",
					itemCount: 0,
					lastAttemptAt: attemptedAt,
					lastAttemptResult: resultMarker,
					lastAttemptErrorMessage: null,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
				},
				update: {
					lastAttemptAt: attemptedAt,
					lastAttemptResult: resultMarker,
					lastAttemptErrorMessage: null,
				},
			});
			return true;
		},
		options,
	);
	return result.matched && result.value ? { attemptedAt, resultMarker } : null;
}

function isGenerationAuthority(value: unknown): value is {
	connectionGeneration: number;
	identityGeneration: number;
} {
	return (
		isRecord(value) &&
		isSafeGeneration(value.connectionGeneration) &&
		isSafeGeneration(value.identityGeneration)
	);
}

function isStatusGeneration(value: unknown): value is ProviderCacheStatusGeneration {
	return (
		isRecord(value) &&
		isNullableSafeGeneration(value.connectionGeneration) &&
		isNullableSafeGeneration(value.identityGeneration)
	);
}

function isNullableSafeGeneration(value: unknown): value is number | null {
	return value === null || isSafeGeneration(value);
}

function isSafeGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Finish only the exact still-current in-progress Plex attempt. */
export async function finishPlexCacheRefreshAttemptFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: PlexCacheRefreshType,
	message: string,
	instance: ProviderPublicationAuthority,
	attempt: PlexCacheRefreshAttempt,
	log: Pick<FastifyBaseLogger, "warn">,
	options: ProviderIdentityGuardOptions = {},
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		const result = await withCurrentProviderPublicationAuthority(
			prisma,
			instance,
			async (tx) => {
				const updated = await tx.cacheRefreshStatus.updateMany({
					where: {
						instanceId: instance.id,
						cacheType,
						lastAttemptAt: attempt.attemptedAt,
						lastAttemptResult: attempt.resultMarker,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					},
					data: {
						lastAttemptResult: "error",
						lastAttemptErrorMessage: message.slice(0, 500),
					},
				});
				return updated.count === 1;
			},
			options,
		);
		return result.matched && result.value ? "recorded" : "superseded";
	} catch (error) {
		log.warn(
			{ err: error, instanceId: instance.id, cacheType },
			"Failed to finish Plex cache refresh attempt",
		);
		return "failed";
	}
}

/** Record Plex failure diagnostics only for the exact full publication authority. */
export async function recordPlexCacheRefreshFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: PlexCacheRefreshType,
	message: string,
	instance: ProviderPublicationAuthority,
	log: Pick<FastifyBaseLogger, "warn">,
): Promise<"recorded" | "superseded" | "failed"> {
	return await recordWatchProviderCacheRefreshFailure(prisma, cacheType, message, instance, log);
}

/** Record failure diagnostics only for an exact, service-compatible publication authority. */
export async function recordWatchProviderCacheRefreshFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: WatchProviderCacheRefreshType,
	message: string,
	instance: ProviderPublicationAuthority,
	log: Pick<FastifyBaseLogger, "warn">,
	options: ProviderIdentityGuardOptions = {},
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		if (!supportsCacheType(instance.service, cacheType)) {
			throw new Error("Provider cache type does not match publication service");
		}
		const attemptedAt = new Date();
		const result = await withCurrentProviderPublicationAuthority(
			prisma,
			instance,
			async (tx) => {
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
						lastAttemptAt: attemptedAt,
						lastAttemptResult: "error",
						lastAttemptErrorMessage: safeMessage,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					},
				});
				return true;
			},
			options,
		);
		return result.matched && result.value ? "recorded" : "superseded";
	} catch (error) {
		log.warn(
			{ err: error, instanceId: instance.id, cacheType },
			"Failed to record provider cache failure status",
		);
		return "failed";
	}
}

function supportsCacheType(
	service: ProviderPublicationAuthority["service"],
	cacheType: WatchProviderCacheRefreshType,
): boolean {
	switch (service) {
		case "PLEX":
			return cacheType === "plex" || cacheType === "plex_episode";
		case "JELLYFIN":
		case "EMBY":
			return cacheType === "jellyfin" || cacheType === "jellyfin_episode";
		case "TAUTULLI":
			return cacheType === "tautulli";
	}
}
