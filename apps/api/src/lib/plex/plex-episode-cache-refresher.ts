/**
 * Publishes a complete per-instance Plex episode snapshot. A refresh is staged
 * in memory and replaces the prior generation only after every bounded source
 * proves complete.
 */

import { randomUUID } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { PlexCache, Prisma } from "../prisma.js";
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
import { PlexClient, type PlexEpisodeItem } from "./plex-client.js";
import {
	DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
	loadInstanceMutationEvidence,
} from "./plex-evidence-repository.js";
import { plexConnectionFingerprint } from "./service-instance-fingerprint.js";

const MAX_SHOWS_PER_REFRESH = 50;
const REFRESHES_PER_FRESHNESS_WINDOW = 4;
const MAX_COMPLETE_SHOWS = MAX_SHOWS_PER_REFRESH * REFRESHES_PER_FRESHNESS_WINDOW;
const MAX_HISTORY_RESULTS = 100_000;

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

type PlexEpisodeRow = {
	instanceId: string;
	showTmdbId: number;
	seasonNumber: number;
	episodeNumber: number;
	ratingKey: string;
	title: string;
	watched: boolean;
	watchedByUsers: string;
	lastWatchedAt: Date | null;
	watchCount: number;
	refreshedAt: Date;
	sourceFingerprint: string;
};

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

async function collectPlexEpisodeCache(
	client: PlexClient,
	parentRows: PlexCache[],
	instanceId: string,
	log: FastifyBaseLogger,
	sourceFingerprint: string,
	connectionGeneration: number,
	identityGeneration: number,
): Promise<CollectedPlexEpisodeRefresh> {
	const recentlyWatchedShows = parentRows
		.filter(
			(row) =>
				row.instanceId === instanceId &&
				row.mediaType === "series" &&
				row.ratingKey !== null &&
				row.watchCount > 0 &&
				row.connectionGeneration === connectionGeneration &&
				row.identityGeneration === identityGeneration,
		)
		.sort(
			(left, right) => (right.lastWatchedAt?.getTime() ?? 0) - (left.lastWatchedAt?.getTime() ?? 0),
		);

	const showMap = new Map<number, Set<string>>();
	for (const show of recentlyWatchedShows) {
		if (!show.ratingKey) continue;
		const ratingKeys = showMap.get(show.tmdbId) ?? new Set<string>();
		ratingKeys.add(show.ratingKey);
		showMap.set(show.tmdbId, ratingKeys);
	}
	const eligibleShows = showMap.size;
	if (eligibleShows > MAX_COMPLETE_SHOWS) {
		const message = `Plex episode inventory exceeded ${MAX_COMPLETE_SHOWS} eligible shows`;
		log.warn({ instanceId, eligibleShows, limit: MAX_COMPLETE_SHOWS }, message);
		return failedResult([message], eligibleShows, 0, true);
	}

	const errorMessages: string[] = [];
	let history: Awaited<ReturnType<PlexClient["getHistory"]>>;
	try {
		history = await client.getHistory({
			maxResults: MAX_HISTORY_RESULTS,
			requireComplete: true,
		});
	} catch (error) {
		const message = `Failed to prove complete Plex history: ${getErrorMessage(error)}`;
		log.warn({ err: error, instanceId }, message);
		return failedResult([message], eligibleShows, 0);
	}

	let accounts: Awaited<ReturnType<PlexClient["getAccounts"]>> = [];
	if (history.some((entry) => entry.type === "episode")) {
		try {
			accounts = await client.getAccounts();
		} catch (error) {
			const message = `Failed to prove complete Plex accounts: ${getErrorMessage(error)}`;
			log.warn({ err: error, instanceId }, message);
			return failedResult([message], eligibleShows, 0);
		}
	}
	const accountMap = new Map(accounts.map((account) => [account.id, account.name]));
	const historyMap = new Map<
		string,
		{ users: Set<string>; lastWatched: number; eventCount: number }
	>();
	for (const item of history) {
		if (item.type !== "episode") continue;
		const userName = accountMap.get(item.accountID);
		if (!userName?.trim()) {
			const message = `Plex history account ${item.accountID} was absent from the complete account inventory`;
			return failedResult([message], eligibleShows, 0);
		}
		const current = historyMap.get(item.ratingKey);
		if (current) {
			current.users.add(userName);
			current.lastWatched = Math.max(current.lastWatched, item.viewedAt);
			current.eventCount++;
		} else {
			historyMap.set(item.ratingKey, {
				users: new Set([userName]),
				lastWatched: item.viewedAt,
				eventCount: 1,
			});
		}
	}

	const rows: PlexEpisodeRow[] = [];
	const completedAt = new Date();
	let refreshedShows = 0;

	for (const [tmdbId, ratingKeys] of [...showMap.entries()].sort(([a], [b]) => a - b)) {
		const copies: PlexEpisodeItem[] = [];
		for (const ratingKey of [...ratingKeys].sort()) {
			try {
				copies.push(...(await client.getEpisodes(ratingKey)));
			} catch (error) {
				const message = `Failed to fetch episodes for show tmdb:${tmdbId} copy:${ratingKey}: ${getErrorMessage(error)}`;
				errorMessages.push(message);
				log.warn({ err: error, instanceId, tmdbId, ratingKey }, message);
			}
		}
		if (errorMessages.length > 0) continue;
		refreshedShows++;

		const byCoordinate = new Map<string, PlexEpisodeItem[]>();
		for (const episode of copies) {
			const coordinate = `${episode.seasonNumber}:${episode.episodeNumber}`;
			const episodeCopies = byCoordinate.get(coordinate) ?? [];
			episodeCopies.push(episode);
			byCoordinate.set(coordinate, episodeCopies);
		}
		for (const episodeCopies of [...byCoordinate.values()].sort(
			([left], [right]) =>
				left!.seasonNumber - right!.seasonNumber || left!.episodeNumber - right!.episodeNumber,
		)) {
			const episode = [...episodeCopies].sort((left, right) => {
				const leftCount = Number.isSafeInteger(left.viewCount) ? (left.viewCount ?? 0) : 0;
				const rightCount = Number.isSafeInteger(right.viewCount) ? (right.viewCount ?? 0) : 0;
				return rightCount - leftCount || left.ratingKey.localeCompare(right.ratingKey);
			})[0]!;
			const watchCount = Math.max(0, episode.viewCount ?? 0);
			const evidence = episodeCopies
				.map((copy) => historyMap.get(copy.ratingKey))
				.filter((entry) => entry !== undefined);
			const lastWatched = Math.max(
				...evidence.map((entry) => entry.lastWatched),
				...episodeCopies.map((copy) => copy.lastViewedAt ?? 0),
				0,
			);
			rows.push({
				instanceId,
				showTmdbId: tmdbId,
				seasonNumber: episode.seasonNumber,
				episodeNumber: episode.episodeNumber,
				ratingKey: episode.ratingKey,
				title: episode.title,
				watched: watchCount > 0 || evidence.some((entry) => entry.eventCount > 0),
				watchedByUsers: JSON.stringify(
					[...new Set(evidence.flatMap((entry) => [...entry.users]))].sort(),
				),
				lastWatchedAt: lastWatched > 0 ? new Date(lastWatched * 1000) : null,
				watchCount,
				refreshedAt: completedAt,
				sourceFingerprint,
			});
		}
	}

	if (errorMessages.length > 0 || refreshedShows !== eligibleShows) {
		return failedResult(errorMessages, eligibleShows, refreshedShows);
	}

	try {
		await client.verifyHistorySnapshot(history);
	} catch (error) {
		const message = `Failed to revalidate Plex history before publication: ${getErrorMessage(error)}`;
		log.warn({ err: error, instanceId }, message);
		return failedResult([message], eligibleShows, refreshedShows);
	}

	return {
		upserted: 0,
		errors: 0,
		errorMessages: [],
		eligibleShows,
		refreshedShows,
		coverageIncomplete: false,
		capacityDegraded: false,
		complete: true,
		completedAt,
		rows,
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
				const parentBefore = await loadInstanceMutationEvidence(prisma, {
					userId: instance.userId,
					instanceId: instance.id,
					maxAgeMs: DEFAULT_PLEX_EVIDENCE_FRESHNESS_MS,
				});
				if (
					!parentBefore.available ||
					parentBefore.evidence.publicationLevel !== "authoritative" ||
					parentBefore.evidence.completeness !== "complete"
				) {
					return failedResult(["Authoritative parent Plex generation is unavailable"], 0, 0);
				}
				const collected = await collectPlexEpisodeCache(
					client,
					parentBefore.rows,
					instance.id,
					log,
					plexConnectionFingerprint(instance),
					instance.connectionGeneration,
					instance.identityGeneration,
				);
				if (!collected.complete) return collected;
				const parentAfter = await loadInstanceMutationEvidence(prisma, {
					userId: instance.userId,
					instanceId: instance.id,
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
	const generationMetadata = JSON.stringify({
		version: 1,
		parentPlexGenerationId: collected.parentAuthority.generationId,
		parentPublicationLevel: collected.parentAuthority.publicationLevel,
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
