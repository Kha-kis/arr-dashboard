/**
 * Publishes a complete per-instance Plex episode snapshot. A refresh is staged
 * in memory and replaces the prior generation only after every bounded source
 * proves complete.
 */

import { randomUUID } from "node:crypto";
import type { Prisma } from "../prisma.js";
import {
	beginPlexCacheRefreshAttempt,
	finishPlexCacheRefreshAttemptFailure,
	type PlexCacheRefreshAttempt,
} from "../services/provider-cache-status.js";
import {
	ProviderIdentityGuardError,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { PlexPublicationContext } from "./plex-cache-refresher.js";
import {
	PlexRefreshAttemptSupersededError,
	publishAuthoritativePlexEpisodeGeneration,
} from "./plex-cache-storage.js";
import { PlexClient } from "./plex-client.js";
import {
	collectPlexEpisodeLiveEvidence,
	type PlexEpisodeRow,
} from "./plex-episode-live-collector.js";
import { createPlexSelectionProjection } from "./plex-canonical-projection.js";
import {
	DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
	PlexAuthorityService,
} from "./plex-authority-service.js";
import { plexConnectionFingerprint } from "./service-instance-fingerprint.js";

export interface PlexEpisodeRefreshResult {
	upserted: number;
	errors: number;
	errorMessages: string[];
	eligibleShows: number;
	refreshedShows: number;
	coverageIncomplete: boolean;
	capacityDegraded: boolean;
	complete: boolean;
	completedAt?: Date;
	superseded?: boolean;
}

type CollectedPlexEpisodeRefresh = PlexEpisodeRefreshResult & {
	rows?: PlexEpisodeRow[];
	parentAuthority?: {
		generationId: string;
		publicationLevel: "authoritative";
		connectionGeneration: number;
		identityGeneration: number;
	};
};

function failedResult(
	errorMessages: string[],
	eligibleShows: number,
	refreshedShows: number,
	capacityDegraded = false,
): PlexEpisodeRefreshResult {
	return {
		upserted: 0,
		errors: Math.max(1, errorMessages.length),
		errorMessages,
		eligibleShows,
		refreshedShows,
		coverageIncomplete: true,
		capacityDegraded,
		complete: false,
	};
}

export async function refreshPlexEpisodeCache(
	context: PlexPublicationContext,
): Promise<PlexEpisodeRefreshResult> {
	const { prisma, instance, log } = context;
	try {
		const attempt = await beginPlexCacheRefreshAttempt(prisma, "plex_episode", instance, {
			cleanupRunClaimToken: context.cleanupRunClaimToken,
		});
		if (!attempt) {
			return { ...failedResult([], 0, 0), errors: 0, errorMessages: [], superseded: true };
		}
		return await refreshPlexEpisodeCacheWithAttempt(context, attempt);
	} catch (error) {
		const message =
			error instanceof ProviderIdentityGuardError
				? error.message
				: `Atomic Plex episode publication failed: ${getErrorMessage(error)}`;
		log.error({ err: error, instanceId: instance.id }, message);
		return failedResult([message], 0, 0);
	}
}

/**
 * Continue an episode refresh with an attempt already acquired by the
 * production pre-decryption boundary. The public refresher remains the safe
 * internal path for callers that begin from an already decrypted snapshot.
 */
export async function refreshPlexEpisodeCacheWithAttempt(
	context: PlexPublicationContext,
	attempt: PlexCacheRefreshAttempt,
): Promise<PlexEpisodeRefreshResult> {
	const { prisma, instance, log } = context;
	try {
		const client = new PlexClient(
			instance.baseUrl,
			instance.apiKey,
			log,
			undefined,
			instance.httpAuthHeaders,
		);
		const result = await withGuardedProviderPublication(
			prisma,
			instance,
			log,
			async () => {
				const showMap = new Map<number, Set<string>>();
				const authority = new PlexAuthorityService({
					prisma,
					log,
					createClient: () => client,
				});
				const parentBefore = await authority.scanInstancePolicy({
					userId: instance.userId,
					instanceId: instance.id,
					domains: ["membership", "episode-parents", "watch"],
					mutation: true,
					maxAgeMs: DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
					onBatch: ({ rows }) => {
						for (const row of rows) {
							if (!row.ratingKey) continue;
							const ratingKeys = showMap.get(row.tmdbId) ?? new Set<string>();
							ratingKeys.add(row.ratingKey);
							showMap.set(row.tmdbId, ratingKeys);
						}
					},
				});
				if (
					!parentBefore.available ||
					parentBefore.evidence.publicationLevel !== "authoritative" ||
					parentBefore.evidence.completeness !== "complete"
				) {
					return failedResult(["Authoritative parent Plex generation is unavailable"], 0, 0);
				}
				const collected = await collectPlexEpisodeLiveEvidence(
					client,
					showMap,
					instance.id,
					log,
					plexConnectionFingerprint(instance),
				);
				if (!collected.complete) return collected;
				const parentAfter = await authority.scanInstancePolicy({
					userId: instance.userId,
					instanceId: instance.id,
					domains: ["membership", "episode-parents", "watch"],
					mutation: true,
					maxAgeMs: DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
				});
				if (
					!parentAfter.available ||
					parentAfter.evidence.publicationLevel !== "authoritative" ||
					parentAfter.evidence.completeness !== "complete" ||
					parentAfter.generationId !== parentBefore.generationId ||
					parentAfter.connectionGeneration !== parentBefore.connectionGeneration ||
					parentAfter.identityGeneration !== parentBefore.identityGeneration
				) {
					return failedResult(
						["Authoritative parent Plex generation changed during episode collection"],
						collected.eligibleShows,
						collected.refreshedShows,
					);
				}
				return {
					...collected,
					parentAuthority: {
						generationId: parentBefore.generationId,
						publicationLevel: "authoritative" as const,
						connectionGeneration: parentBefore.connectionGeneration,
						identityGeneration: parentBefore.identityGeneration,
					},
				};
			},
			async (tx, collected) => await publishPlexEpisodeCache(tx, instance, attempt!, collected),
			{ cleanupRunClaimToken: context.cleanupRunClaimToken },
		);
		if (!result.complete || !result.completedAt) {
			const finished = await finishPlexCacheRefreshAttemptFailure(
				prisma,
				"plex_episode",
				result.errorMessages.slice(0, 3).join("; ").slice(0, 500) ||
					"Plex episode refresh did not produce a complete generation",
				instance,
				attempt,
				log,
				{ cleanupRunClaimToken: context.cleanupRunClaimToken },
			);
			if (finished === "superseded") {
				return { ...failedResult([], 0, 0), errors: 0, errorMessages: [], superseded: true };
			}
		}
		return result;
	} catch (error) {
		let publicationError = error;
		if (
			!(error instanceof PlexRefreshAttemptSupersededError) &&
			!(error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_SUPERSEDED")
		) {
			const finished = await finishPlexCacheRefreshAttemptFailure(
				prisma,
				"plex_episode",
				getErrorMessage(error, "Unknown Plex episode refresh failure"),
				instance,
				attempt,
				log,
				{ cleanupRunClaimToken: context.cleanupRunClaimToken },
			);
			if (!(error instanceof ProviderIdentityGuardError) && finished === "superseded") {
				publicationError = new PlexRefreshAttemptSupersededError();
			}
		}
		if (
			(publicationError instanceof ProviderIdentityGuardError &&
				publicationError.code === "PUBLICATION_SUPERSEDED") ||
			publicationError instanceof PlexRefreshAttemptSupersededError
		) {
			return {
				upserted: 0,
				errors: 0,
				errorMessages: [],
				eligibleShows: 0,
				refreshedShows: 0,
				coverageIncomplete: true,
				capacityDegraded: false,
				complete: false,
				superseded: true,
			};
		}
		const message =
			publicationError instanceof ProviderIdentityGuardError
				? publicationError.message
				: `Atomic Plex episode publication failed: ${getErrorMessage(publicationError)}`;
		log.error({ err: publicationError, instanceId: instance.id }, message);
		return failedResult([message], 0, 0);
	}
}

async function publishPlexEpisodeCache(
	tx: Prisma.TransactionClient,
	instance: PlexPublicationContext["instance"],
	attempt: PlexCacheRefreshAttempt,
	collected: CollectedPlexEpisodeRefresh,
): Promise<PlexEpisodeRefreshResult> {
	if (!collected.complete || !collected.completedAt || !collected.rows) return collected;
	if (!collected.parentAuthority) {
		return failedResult(
			["Authoritative parent Plex generation is unavailable"],
			collected.eligibleShows,
			collected.refreshedShows,
		);
	}
	const rows = collected.rows;
	const generationId = randomUUID();
	const episodeDigest = createPlexSelectionProjection({
		rows: rows.map((row) => ({
			sectionId: "",
			mediaType: "episode",
			tmdbId: row.showTmdbId,
			ratingKey: row.ratingKey,
			title: row.title,
			seasonNumber: row.seasonNumber,
			episodeNumber: row.episodeNumber,
			watched: row.watched,
			watchedByUsers: row.watchedByUsers,
			lastWatchedAt: row.lastWatchedAt,
			watchCount: row.watchCount,
		})),
		selection: { kind: "all" },
		domains: ["episodes"],
	}).domains.episodes!;
	const generationMetadata = JSON.stringify({
		version: 2,
		parentPlexGenerationId: collected.parentAuthority.generationId,
		parentPublicationLevel: collected.parentAuthority.publicationLevel,
		parentMetadataVersion: 3,
		canonicalizationVersion: 1,
		episodeDigest,
		connectionGeneration: collected.parentAuthority.connectionGeneration,
		identityGeneration: collected.parentAuthority.identityGeneration,
	});
	await publishAuthoritativePlexEpisodeGeneration(tx, {
		instance,
		rows: rows.map((row) => ({
			...row,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		})),
		completedAt: collected.completedAt,
		generationId,
		generationMetadata,
		attempt,
	});
	return { ...collected, upserted: rows.length };
}
