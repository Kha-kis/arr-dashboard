/**
 * Publishes a complete per-instance Plex episode snapshot. A refresh is staged
 * in memory and replaces the prior generation only after every bounded source
 * proves complete.
 */

import { randomUUID } from "node:crypto";
import { evidenceFingerprint } from "../evidence-fingerprint.js";
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
import {
	DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
	PlexAuthorityService,
} from "./plex-authority-service.js";
import type { PlexPublicationContext } from "./plex-cache-refresher.js";
import {
	PlexRefreshAttemptSupersededError,
	publishAuthoritativePlexEpisodeGeneration,
	publishPositivePlexEpisodeGeneration,
} from "./plex-cache-storage.js";
import { createPlexSelectionProjection } from "./plex-canonical-projection.js";
import { PlexClient } from "./plex-client.js";
import {
	type CollectedPositivePlexEpisodeRefresh,
	collectPlexEpisodeLiveEvidence,
	collectPositivePlexEpisodeLiveEvidence,
	type PlexEpisodeRow,
} from "./plex-episode-live-collector.js";
import {
	encodePlexPositiveEpisodeGenerationMetadata,
	type PlexPositiveEpisodePartialReason,
} from "./plex-positive-episode-generation-metadata.js";
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
	publicationLevel?: "authoritative" | "positive-only";
	partialReasons?: readonly PlexPositiveEpisodePartialReason[];
}

type CollectedPlexEpisodeRefresh = PlexEpisodeRefreshResult & {
	kind?: undefined;
	rows?: PlexEpisodeRow[];
	parentAuthority?: {
		generationId: string;
		publicationLevel: "authoritative";
		connectionGeneration: number;
		identityGeneration: number;
	};
};

type CollectedPositiveEpisodeRefresh = CollectedPositivePlexEpisodeRefresh & {
	parentAuthority: {
		generationId: string;
		connectionGeneration: number;
		identityGeneration: number;
		parentTargetDigest: string;
		parentTargetCount: number;
		partialReasons: readonly { code: string; count: number }[];
	};
};

type StagedPlexEpisodeRefresh = CollectedPlexEpisodeRefresh | CollectedPositiveEpisodeRefresh;

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

function positiveParentSignature(parent: {
	generationId: string;
	connectionGeneration: number;
	identityGeneration: number;
	provenance: { parentTargetDigest: string; parentTargetCount: number };
	rows: readonly { instanceId: string; tmdbId: number; sectionId: string; ratingKey: string }[];
}) {
	return JSON.stringify({
		generationId: parent.generationId,
		connectionGeneration: parent.connectionGeneration,
		identityGeneration: parent.identityGeneration,
		parentTargetDigest: parent.provenance.parentTargetDigest,
		parentTargetCount: parent.provenance.parentTargetCount,
		rows: [...parent.rows]
			.sort(
				(left, right) =>
					left.instanceId.localeCompare(right.instanceId) ||
					left.tmdbId - right.tmdbId ||
					left.sectionId.localeCompare(right.sectionId) ||
					left.ratingKey.localeCompare(right.ratingKey),
			)
			.map((row) => [row.instanceId, row.tmdbId, row.sectionId, row.ratingKey]),
	});
}

function observedPositiveParentTargets<
	T extends { instanceId: string; tmdbId: number; sectionId: string; ratingKey: string },
>(parent: {
	rows: readonly { instanceId: string; tmdbId: number; sectionId: string; ratingKey: string }[];
	targets: readonly T[];
}): T[] {
	const observed = new Set(
		parent.rows.map(
			(row) => `${row.instanceId}\u0000${row.tmdbId}\u0000${row.sectionId}\u0000${row.ratingKey}`,
		),
	);
	return parent.targets.filter((target) =>
		observed.has(
			`${target.instanceId}\u0000${target.tmdbId}\u0000${target.sectionId}\u0000${target.ratingKey}`,
		),
	);
}

function mergePositivePartialReasons(
	parentReasons: readonly { code: string; count: number }[],
	ambiguityReasons: readonly { code: "ambiguous_episode_parent_targets"; count: number }[],
): PlexPositiveEpisodePartialReason[] | null {
	const counts = new Map<string, number>();
	for (const reason of [...parentReasons, ...ambiguityReasons]) {
		if (!Number.isSafeInteger(reason.count) || reason.count < 1) return null;
		const current = counts.get(reason.code) ?? 0;
		if (!Number.isSafeInteger(current + reason.count)) return null;
		counts.set(reason.code, current + reason.count);
	}
	return [...counts.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([code, count]) => ({ code, count })) as PlexPositiveEpisodePartialReason[];
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
				const parentBefore = await authority.scanInstanceEpisodeParentPolicy({
					userId: instance.userId,
					instanceId: instance.id,
					domains: ["membership", "episode-parents", "watch"],
					mutation: true,
					maxAgeMs: DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
					onTargets: (targets) => {
						for (const target of targets) {
							const ratingKeys = showMap.get(target.tmdbId) ?? new Set<string>();
							ratingKeys.add(target.ratingKey);
							showMap.set(target.tmdbId, ratingKeys);
						}
					},
				});
				if (
					parentBefore.available &&
					parentBefore.evidence.publicationLevel === "authoritative" &&
					parentBefore.evidence.completeness === "complete"
				) {
					const collected = await collectPlexEpisodeLiveEvidence(
						client,
						showMap,
						instance.id,
						log,
						plexConnectionFingerprint(instance),
					);
					if (!collected.complete) return collected;
					const postCollectionShowMap = new Map<number, Set<string>>();
					const parentAfter = await authority.scanInstanceEpisodeParentPolicy({
						userId: instance.userId,
						instanceId: instance.id,
						domains: ["membership", "episode-parents", "watch"],
						mutation: true,
						maxAgeMs: DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
						onTargets: (targets) => {
							for (const target of targets) {
								const ratingKeys = postCollectionShowMap.get(target.tmdbId) ?? new Set<string>();
								ratingKeys.add(target.ratingKey);
								postCollectionShowMap.set(target.tmdbId, ratingKeys);
							}
						},
					});
					if (
						!parentAfter.available ||
						parentAfter.evidence.publicationLevel !== "authoritative" ||
						parentAfter.evidence.completeness !== "complete" ||
						parentAfter.generationId !== parentBefore.generationId ||
						parentAfter.connectionGeneration !== parentBefore.connectionGeneration ||
						parentAfter.identityGeneration !== parentBefore.identityGeneration ||
						evidenceFingerprint(postCollectionShowMap) !== evidenceFingerprint(showMap)
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
				}

				const positiveBefore = await authority.readPositiveEpisodeParents({
					userId: instance.userId,
					instanceId: instance.id,
					maxAgeMs: DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
				});
				if (
					!positiveBefore.available ||
					positiveBefore.provenance.publicationLevel !== "positive-only" ||
					positiveBefore.provenance.completeness !== "partial"
				) {
					return failedResult(["Positive parent Plex generation is unavailable"], 0, 0);
				}
				const beforeSignature = positiveParentSignature(positiveBefore);
				const first = await collectPositivePlexEpisodeLiveEvidence(
					client,
					observedPositiveParentTargets(positiveBefore).map((target) => ({
						instanceId: target.instanceId,
						generationId: target.generationId,
						showTmdbId: target.tmdbId,
						sectionId: target.sectionId,
						sectionUuid: target.sectionUuid,
						mediaType: target.mediaType as "series",
						tvdbId: target.tvdbId,
						ratingKey: target.ratingKey,
					})),
					log,
					plexConnectionFingerprint(instance),
				);
				if (first.kind !== "positive-observation") return first;
				const positiveMiddle = await authority.readPositiveEpisodeParents({
					userId: instance.userId,
					instanceId: instance.id,
					maxAgeMs: DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
				});
				if (
					!positiveMiddle.available ||
					positiveParentSignature(positiveMiddle) !== beforeSignature
				) {
					return failedResult(
						["Positive parent Plex generation changed during episode collection"],
						first.eligibleShows,
						first.refreshedShows,
					);
				}
				const final = await collectPositivePlexEpisodeLiveEvidence(
					client,
					observedPositiveParentTargets(positiveMiddle).map((target) => ({
						instanceId: target.instanceId,
						generationId: target.generationId,
						showTmdbId: target.tmdbId,
						sectionId: target.sectionId,
						sectionUuid: target.sectionUuid,
						mediaType: target.mediaType as "series",
						tvdbId: target.tvdbId,
						ratingKey: target.ratingKey,
					})),
					log,
					plexConnectionFingerprint(instance),
				);
				if (final.kind !== "positive-observation") return final;
				const positiveAfter = await authority.readPositiveEpisodeParents({
					userId: instance.userId,
					instanceId: instance.id,
					maxAgeMs: DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
				});
				if (
					!positiveAfter.available ||
					positiveParentSignature(positiveAfter) !== beforeSignature ||
					final.episodeDigest !== first.episodeDigest
				) {
					return failedResult(
						["Positive Plex episode evidence changed during collection"],
						final.eligibleShows,
						final.refreshedShows,
					);
				}
				const partialReasons = mergePositivePartialReasons(
					positiveBefore.partialReasons,
					final.partialReasons,
				);
				if (!partialReasons) {
					return failedResult(
						["Positive Plex episode partial reasons were invalid"],
						final.eligibleShows,
						final.refreshedShows,
					);
				}
				return {
					...final,
					partialReasons,
					parentAuthority: {
						generationId: positiveBefore.generationId,
						connectionGeneration: positiveBefore.connectionGeneration,
						identityGeneration: positiveBefore.identityGeneration,
						parentTargetDigest: positiveBefore.provenance.parentTargetDigest,
						parentTargetCount: positiveBefore.provenance.parentTargetCount,
						partialReasons: positiveBefore.partialReasons,
					},
				};
			},
			async (tx, collected) =>
				await publishPlexEpisodeCache(
					tx,
					instance,
					attempt!,
					collected as StagedPlexEpisodeRefresh,
				),
			{ cleanupRunClaimToken: context.cleanupRunClaimToken },
		);
		if ((!result.complete && result.publicationLevel !== "positive-only") || !result.completedAt) {
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
	collected: StagedPlexEpisodeRefresh,
): Promise<PlexEpisodeRefreshResult> {
	if (!collected.completedAt || !collected.rows) return collected;
	const rows = collected.rows;
	const generationId = randomUUID();
	const storedRows = rows.map((row) => ({
		...row,
		connectionGeneration: instance.connectionGeneration,
		identityGeneration: instance.identityGeneration,
	}));
	if (collected.kind === "positive-observation") {
		const generationMetadata = encodePlexPositiveEpisodeGenerationMetadata({
			version: 3,
			publicationLevel: "positive-only",
			completeness: "partial",
			itemCount: rows.length,
			canonicalizationVersion: 1,
			capability: {
				domain: "episodes",
				field: "watchCount",
				semantics: "lower-bound",
				operator: "greater_than",
			},
			parentPlexGenerationId: collected.parentAuthority.generationId,
			parentMetadataVersion: 4,
			parentPublicationLevel: "positive-only",
			parentTargetDigest: collected.parentAuthority.parentTargetDigest,
			episodeDigest: collected.episodeDigest,
			partialReasons: collected.partialReasons,
			connectionGeneration: collected.parentAuthority.connectionGeneration,
			identityGeneration: collected.parentAuthority.identityGeneration,
		});
		await publishPositivePlexEpisodeGeneration(tx, {
			instance,
			rows: storedRows,
			completedAt: collected.completedAt,
			generationId,
			generationMetadata,
			attempt,
		});
		return { ...collected, upserted: rows.length, publicationLevel: "positive-only" };
	}
	if (!collected.complete) return collected;
	if (!collected.parentAuthority) {
		return failedResult(
			["Authoritative parent Plex generation is unavailable"],
			collected.eligibleShows,
			collected.refreshedShows,
		);
	}
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
		rows: storedRows,
		completedAt: collected.completedAt,
		generationId,
		generationMetadata,
		attempt,
	});
	return { ...collected, upserted: rows.length };
}
