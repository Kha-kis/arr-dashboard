/**
 * Plex Episode Cache Refresher
 *
 * Fetches per-episode watch status for shows with recent activity.
 * Only refreshes shows that have been watched recently (not all shows)
 * to keep API call count bounded.
 */

import type { FastifyBaseLogger } from "fastify";
import type { PrismaClientInstance } from "../prisma.js";
import { getErrorMessage } from "../utils/error-message.js";
import type { PlexClient, PlexEpisodeItem } from "./plex-client.js";

const MAX_SHOWS_PER_REFRESH = 50;
const REFRESHES_PER_FRESHNESS_WINDOW = 4;
const MAX_HISTORY_RESULTS = 5000;

function parseWatchedByUsers(value: string): string[] {
	try {
		const parsed = JSON.parse(value);
		return Array.isArray(parsed)
			? parsed.filter((user): user is string => typeof user === "string")
			: [];
	} catch {
		return [];
	}
}

function latestDate(left: Date | null, right: Date | null): Date | null {
	if (!left) return right;
	if (!right) return left;
	return left.getTime() >= right.getTime() ? left : right;
}

/**
 * Refresh episode-level watch data for recently-watched shows on a single Plex instance.
 *
 * Strategy:
 * 1. Query PlexCache for shows with recent watch activity on this instance
 * 2. For each show, fetch all episodes from Plex
 * 3. Cross-reference with history to determine watched status
 * 4. Upsert into PlexEpisodeCache
 */
export async function refreshPlexEpisodeCache(
	client: PlexClient,
	prisma: PrismaClientInstance,
	instanceId: string,
	log: FastifyBaseLogger,
	sourceFingerprint: string,
): Promise<{
	upserted: number;
	errors: number;
	errorMessages: string[];
	eligibleShows: number;
	refreshedShows: number;
	coverageIncomplete: boolean;
	capacityDegraded: boolean;
}> {
	let upserted = 0;
	let errors = 0;
	const errorMessages: string[] = [];

	// Find shows with recent watch activity (have a ratingKey and non-zero watchCount)
	const recentlyWatchedShows = await prisma.plexCache.findMany({
		where: {
			instanceId,
			mediaType: "series",
			ratingKey: { not: null },
			watchCount: { gt: 0 },
		},
		orderBy: { lastWatchedAt: "desc" },
		select: {
			tmdbId: true,
			ratingKey: true,
		},
	});

	if (recentlyWatchedShows.length === 0) {
		log.debug({ instanceId }, "No recently watched shows to refresh episodes for");
		return {
			upserted,
			errors,
			errorMessages,
			eligibleShows: 0,
			refreshedShows: 0,
			coverageIncomplete: false,
			capacityDegraded: false,
		};
	}

	// Group every Plex copy of the same logical show. Duplicate sections and
	// quality libraries have distinct rating keys, and any one of them may own
	// the Sonarr path or carry the configured account's current watch count.
	const showMap = new Map<number, Set<string>>();
	for (const show of recentlyWatchedShows) {
		if (!show.ratingKey) continue;
		const ratingKeys = showMap.get(show.tmdbId) ?? new Set<string>();
		ratingKeys.add(show.ratingKey);
		showMap.set(show.tmdbId, ratingKeys);
	}
	const eligibleShows = showMap.size;

	// Rotate the bounded batch toward shows with the oldest episode evidence.
	// This guarantees eventual coverage instead of permanently refreshing only
	// the same newest 50 watched shows.
	const existingRefreshes = await prisma.plexEpisodeCache.groupBy({
		by: ["showTmdbId"],
		where: {
			instanceId,
			showTmdbId: { in: [...showMap.keys()] },
		},
		_max: { refreshedAt: true },
	});
	const newestRefreshByShow = new Map<number, number>();
	for (const row of existingRefreshes) {
		if (row._max.refreshedAt) {
			newestRefreshByShow.set(row.showTmdbId, row._max.refreshedAt.getTime());
		}
	}
	const selectedShows = [...showMap.entries()]
		.sort(([leftTmdbId], [rightTmdbId]) => {
			const leftRefresh = newestRefreshByShow.get(leftTmdbId) ?? Number.NEGATIVE_INFINITY;
			const rightRefresh = newestRefreshByShow.get(rightTmdbId) ?? Number.NEGATIVE_INFINITY;
			return leftRefresh - rightRefresh;
		})
		.slice(0, MAX_SHOWS_PER_REFRESH);
	let coverageIncomplete = eligibleShows > selectedShows.length;
	const capacityDegraded = eligibleShows > MAX_SHOWS_PER_REFRESH * REFRESHES_PER_FRESHNESS_WINDOW;

	// Fetch history for best-effort user attribution. Metadata viewCount is
	// authoritative for cleanup, so attribution failures must not prevent it
	// from being refreshed.
	const historyMap = new Map<
		string,
		{
			users: Set<string>;
			lastWatched: number;
			eventCount: number;
			attributionComplete: boolean;
		}
	>();
	let history: Awaited<ReturnType<PlexClient["getHistory"]>> = [];
	let historyAvailable = true;
	try {
		history = await client.getHistory({ maxResults: MAX_HISTORY_RESULTS });
	} catch (err) {
		historyAvailable = false;
		log.warn({ err, instanceId }, "Failed to fetch history for episode cache refresh");
		errors++;
		errorMessages.push(`Failed to fetch history: ${getErrorMessage(err)}`);
	}
	const historyComplete = historyAvailable && history.length < MAX_HISTORY_RESULTS;
	if (historyAvailable && !historyComplete) {
		log.warn(
			{ instanceId, maxResults: MAX_HISTORY_RESULTS },
			"Plex history reached its bounded result limit; preserving aggregate state for omitted episodes",
		);
	}
	const existingEpisodeStates = new Map<
		string,
		{
			ratingKey: string;
			sourceFingerprint: string | null;
			watched: boolean;
			watchedByUsers: string[];
			lastWatchedAt: Date | null;
		}
	>();
	let accountMap = new Map<number, string>();
	let accountLookupComplete = true;
	let hasIncompleteAccountAttribution = false;
	if (history.length > 0) {
		try {
			const accounts = await client.getAccounts();
			accountMap = new Map(accounts.map((account) => [account.id, account.name]));
		} catch (err) {
			accountLookupComplete = false;
			log.warn({ err, instanceId }, "Failed to fetch Plex accounts for episode attribution");
			errors++;
			errorMessages.push(`Failed to fetch Plex accounts: ${getErrorMessage(err)}`);
		}
	}
	for (const item of history) {
		if (item.type !== "episode") continue;
		const key = item.ratingKey;
		const existing = historyMap.get(key);
		const mappedUserName = accountLookupComplete ? accountMap.get(item.accountID) : undefined;
		const userName =
			typeof mappedUserName === "string" && mappedUserName.trim() ? mappedUserName : null;
		const attributionComplete = userName !== null;
		if (!attributionComplete) hasIncompleteAccountAttribution = true;
		if (existing) {
			if (userName) existing.users.add(userName);
			existing.eventCount++;
			existing.attributionComplete &&= attributionComplete;
			if (item.viewedAt > existing.lastWatched) {
				existing.lastWatched = item.viewedAt;
			}
		} else {
			historyMap.set(key, {
				users: new Set(userName ? [userName] : []),
				lastWatched: item.viewedAt,
				eventCount: 1,
				attributionComplete,
			});
		}
	}
	if (hasIncompleteAccountAttribution && accountLookupComplete) {
		log.warn(
			{ instanceId },
			"Plex history referenced accounts absent from the current account list; preserving attribution per episode",
		);
	}
	if (!historyComplete || hasIncompleteAccountAttribution) {
		const existingEpisodes = await prisma.plexEpisodeCache.findMany({
			where: {
				instanceId,
				showTmdbId: { in: selectedShows.map(([tmdbId]) => tmdbId) },
			},
			select: {
				showTmdbId: true,
				seasonNumber: true,
				episodeNumber: true,
				ratingKey: true,
				sourceFingerprint: true,
				watched: true,
				watchedByUsers: true,
				lastWatchedAt: true,
			},
		});
		for (const episode of existingEpisodes) {
			existingEpisodeStates.set(
				`${episode.showTmdbId}:${episode.seasonNumber}:${episode.episodeNumber}`,
				{
					ratingKey: episode.ratingKey,
					sourceFingerprint: episode.sourceFingerprint,
					watched: episode.watched,
					watchedByUsers: parseWatchedByUsers(episode.watchedByUsers),
					lastWatchedAt: episode.lastWatchedAt,
				},
			);
		}
	}

	// Process each show
	const refreshedAt = new Date();
	let refreshedShows = 0;
	for (const [tmdbId, showRatingKeys] of selectedShows) {
		try {
			const sortedShowRatingKeys = [...showRatingKeys].sort();
			const copyResults = await Promise.allSettled(
				sortedShowRatingKeys.map((showRatingKey) => client.getEpisodes(showRatingKey)),
			);
			const episodeCopies: PlexEpisodeItem[] = [];
			let successfulCopies = 0;
			for (const [index, result] of copyResults.entries()) {
				const showRatingKey = sortedShowRatingKeys[index]!;
				if (result.status === "fulfilled") {
					successfulCopies++;
					episodeCopies.push(...result.value);
					continue;
				}
				errors++;
				coverageIncomplete = true;
				log.warn(
					{ err: result.reason, instanceId, tmdbId, showRatingKey },
					"Failed to fetch one Plex show copy during episode cache refresh",
				);
				if (errorMessages.length < 5) {
					errorMessages.push(
						`Failed to fetch episodes for show tmdb:${tmdbId} copy:${showRatingKey}: ${getErrorMessage(result.reason)}`,
					);
				}
			}
			if (successfulCopies === 0) continue;
			const copyCoverageIncomplete = successfulCopies !== sortedShowRatingKeys.length;
			const episodesByCoordinate = new Map<string, PlexEpisodeItem[]>();
			for (const episode of episodeCopies) {
				const coordinate = `${episode.seasonNumber}:${episode.episodeNumber}`;
				const copies = episodesByCoordinate.get(coordinate) ?? [];
				copies.push(episode);
				episodesByCoordinate.set(coordinate, copies);
			}
			refreshedShows++;

			for (const copies of episodesByCoordinate.values()) {
				// Keep one cache row per logical episode so duplicate Plex copies
				// cannot inflate the completion denominator. The strongest live
				// configured-account count is the destructive proof; ties are
				// deterministic so incomplete-history preservation stays stable.
				const episode = [...copies].sort((left, right) => {
					const leftCount =
						Number.isInteger(left.viewCount) && left.viewCount > 0 ? left.viewCount : 0;
					const rightCount =
						Number.isInteger(right.viewCount) && right.viewCount > 0 ? right.viewCount : 0;
					return rightCount - leftCount || left.ratingKey.localeCompare(right.ratingKey);
				})[0]!;
				const watchData = copies
					.map((copy) => historyMap.get(copy.ratingKey))
					.filter((data) => data !== undefined);
				const plexViewCount =
					Number.isInteger(episode.viewCount) && episode.viewCount > 0 ? episode.viewCount : 0;
				// Shared history drives aggregate progress/completion, while the
				// configured account's current metadata count remains the only
				// destructive episode-cleanup authorization signal.
				const watchCount = plexViewCount;
				const watched =
					watchCount > 0 || watchData.some((data) => data.eventCount > 0);
				const observedUsers = [
					...new Set(watchData.flatMap((data) => [...data.users])),
				];
				const episodeAttributionComplete = watchData.every(
					(data) => data.attributionComplete,
				);
				const latestHistoryAt = watchData.reduce(
					(latest, data) => Math.max(latest, data.lastWatched),
					0,
				);
				const latestMetadataAt = copies.reduce(
					(latest, copy) => Math.max(latest, copy.lastViewedAt ?? 0),
					0,
				);
				const latestWatchedAt = Math.max(latestHistoryAt, latestMetadataAt);
				const lastWatchedAt =
					latestWatchedAt > 0 ? new Date(latestWatchedAt * 1000) : null;
				const existingState = existingEpisodeStates.get(
					`${tmdbId}:${episode.seasonNumber}:${episode.episodeNumber}`,
				);
				const compatibleExistingState =
					existingState &&
					(copyCoverageIncomplete ||
						copies.some((copy) => copy.ratingKey === existingState.ratingKey)) &&
					existingState.sourceFingerprint === sourceFingerprint
						? existingState
						: null;
				const aggregateWatchUpdate =
					!historyAvailable && watchCount > 0
						? {
								watched: true,
								...(lastWatchedAt ? { lastWatchedAt } : {}),
							}
						: {};
				const effectiveWatched = historyComplete
					? watched
					: (compatibleExistingState?.watched ?? false) || watched;
				const effectiveWatchedByUsers =
					historyComplete && episodeAttributionComplete
						? observedUsers
						: [
								...new Set([
									...(compatibleExistingState?.watchedByUsers ?? []),
									...observedUsers,
								]),
							];
				const effectiveLastWatchedAt = historyComplete
					? lastWatchedAt
					: latestDate(compatibleExistingState?.lastWatchedAt ?? null, lastWatchedAt);

				try {
					if (!historyAvailable) {
						// Without shared history we cannot safely initialize a new
						// aggregate row or attach old progress to a new Plex identity.
						// The identity predicates also make the update fail closed if
						// another refresh changes the row after the read above.
						if (!compatibleExistingState) continue;
						const updated = await prisma.plexEpisodeCache.updateMany({
							where: {
								instanceId,
								showTmdbId: tmdbId,
								seasonNumber: episode.seasonNumber,
								episodeNumber: episode.episodeNumber,
								ratingKey: compatibleExistingState.ratingKey,
								sourceFingerprint,
							},
							data: {
								ratingKey: episode.ratingKey,
								title: episode.title,
								...aggregateWatchUpdate,
								watchCount,
								refreshedAt,
								sourceFingerprint,
							},
						});
						upserted += updated.count;
						continue;
					}
					// A bounded successful history response proves only what it
					// contains, but getEpisodes still proves this episode exists.
					// Keep a conservative unwatched row for newly discovered
					// episodes so completion rules retain the full denominator.
					await prisma.plexEpisodeCache.upsert({
						where: {
							instanceId_showTmdbId_seasonNumber_episodeNumber: {
								instanceId,
								showTmdbId: tmdbId,
								seasonNumber: episode.seasonNumber,
								episodeNumber: episode.episodeNumber,
							},
						},
						create: {
							instanceId,
							showTmdbId: tmdbId,
							seasonNumber: episode.seasonNumber,
							episodeNumber: episode.episodeNumber,
							ratingKey: episode.ratingKey,
							title: episode.title,
							watched: effectiveWatched,
							watchedByUsers: JSON.stringify(effectiveWatchedByUsers),
							lastWatchedAt: effectiveLastWatchedAt,
							watchCount,
							refreshedAt,
							sourceFingerprint,
						},
						update: {
							ratingKey: episode.ratingKey,
							title: episode.title,
							watched: effectiveWatched,
							watchedByUsers: JSON.stringify(effectiveWatchedByUsers),
							lastWatchedAt: effectiveLastWatchedAt,
							watchCount,
							refreshedAt,
							sourceFingerprint,
						},
					});
					upserted++;
				} catch (err) {
					errors++;
					if (errors <= 3) {
						log.warn(
							{
								err,
								instanceId,
								tmdbId,
								episode: `S${episode.seasonNumber}E${episode.episodeNumber}`,
							},
							"Failed to upsert episode cache entry",
						);
					}
					if (errorMessages.length < 5) {
						errorMessages.push(
							`Failed to upsert S${episode.seasonNumber}E${episode.episodeNumber}: ${getErrorMessage(err)}`,
						);
					}
				}
			}
		} catch (err) {
			errors++;
			log.warn(
				{ err, instanceId, tmdbId, showRatingKeys: [...showRatingKeys] },
				"Failed to fetch episodes for show",
			);
			if (errorMessages.length < 5) {
				errorMessages.push(
					`Failed to fetch episodes for show tmdb:${tmdbId}: ${getErrorMessage(err)}`,
				);
			}
		}
	}

	log.info(
		{
			instanceId,
			eligibleShows,
			refreshedShows,
			coverageIncomplete,
			capacityDegraded,
			upserted,
			errors,
		},
		"Plex episode cache refresh completed",
	);

	return {
		upserted,
		errors,
		errorMessages,
		eligibleShows,
		refreshedShows,
		coverageIncomplete,
		capacityDegraded,
	};
}
