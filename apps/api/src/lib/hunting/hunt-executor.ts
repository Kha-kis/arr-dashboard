/**
 * Hunt Executor
 *
 * Orchestrates hunts against Sonarr/Radarr/Lidarr/Readarr instances
 * to find missing content and trigger quality upgrade searches.
 *
 * Filter evaluation, grab detection, and utility functions are
 * extracted into separate modules for maintainability.
 */

import type { HuntConfig, ServiceInstance } from "../../lib/prisma.js";
import type { FastifyInstance } from "fastify";
import type { SonarrClient } from "arr-sdk/sonarr";
import type { RadarrClient } from "arr-sdk/radarr";
import type { LidarrClient } from "arr-sdk/lidarr";
import type { ReadarrClient } from "arr-sdk/readarr";
import type { QueueCapableClient } from "../arr/client-factory.js";
import { SEASON_SEARCH_THRESHOLD, SEARCH_DELAY_MS } from "./constants.js";
import {
	createSearchHistoryManager,
	type SearchHistoryManager,
	type SearchedItem,
} from "./search-history.js";
import { delay } from "../utils/delay.js";
import { fetchWantedWithWrapAround, type ApiCallCounter } from "./pagination-helpers.js";

// Extracted modules
import { shuffleArray, isContentReleased } from "./hunt-utils.js";
import {
	type HuntLogger,
	type HuntService,
	type ParsedFilters,
	parseFilters,
	passesFilters,
} from "./hunt-filters.js";
import {
	type GrabbedItem,
	detectGrabbedItemsFromHistoryWithSdk,
} from "./grab-detector.js";

// Re-export for external consumers
export type { GrabbedItem } from "./grab-detector.js";

export interface HuntResult {
	itemsSearched: number;
	itemsGrabbed: number;
	searchedItems: string[]; // Names of items we searched for
	grabbedItems: GrabbedItem[]; // Items that were actually grabbed/downloaded
	message: string;
	status: "completed" | "partial" | "skipped" | "error";
	apiCallsMade: number; // Actual count of API calls made to the arr instance
}

// Internal type for sub-functions (apiCallsMade added by executeHunt)
type HuntResultWithoutApiCount = Omit<HuntResult, "apiCallsMade">;

// ============================================================================
// SDK-based implementations (arr-sdk 0.3.0)
// ============================================================================

/**
 * Orchestrates a hunt run against a Sonarr or Radarr instance using the SDK.
 */
export async function executeHuntWithSdk(
	app: FastifyInstance,
	instance: ServiceInstance,
	config: HuntConfig,
	type: "missing" | "upgrade",
): Promise<HuntResult> {
	const logger = app.log.child({
		huntConfigId: config.id,
		instanceId: instance.id,
		huntType: type,
	});
	// Hunting only runs against queue-capable services (not Prowlarr)
	const client = app.arrClientFactory.create(instance) as QueueCapableClient;
	const apiCallCounter: ApiCallCounter = { count: 0 };

	const service = instance.service.toLowerCase() as HuntService;
	const filters = parseFilters(config, service, logger);

	// Check queue threshold first
	const queueCheck = await checkQueueThresholdWithSdk(
		client,
		config.queueThreshold,
		apiCallCounter,
		logger,
	);
	if (!queueCheck.ok) {
		return {
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: queueCheck.message,
			status: "skipped",
			apiCallsMade: apiCallCounter.count,
		};
	}

	// Create search history manager to track/filter recently searched items
	const historyManager = await createSearchHistoryManager(
		app.prisma,
		config.id,
		type,
		config.researchAfterDays,
	);

	const batchSize = type === "missing" ? config.missingBatchSize : config.upgradeBatchSize;

	if (service === "sonarr") {
		const result = await executeSonarrHuntWithSdk(
			client as SonarrClient,
			type,
			batchSize,
			filters,
			historyManager,
			apiCallCounter,
			logger,
			config.preferSeasonPacks,
		);
		return { ...result, apiCallsMade: apiCallCounter.count };
	}
	if (service === "radarr") {
		const result = await executeRadarrHuntWithSdk(
			client as RadarrClient,
			type,
			batchSize,
			filters,
			historyManager,
			apiCallCounter,
			logger,
		);
		return { ...result, apiCallsMade: apiCallCounter.count };
	}
	if (service === "lidarr") {
		const result = await executeLidarrHuntWithSdk(
			client as LidarrClient,
			type,
			batchSize,
			filters,
			historyManager,
			apiCallCounter,
			logger,
		);
		return { ...result, apiCallsMade: apiCallCounter.count };
	}
	if (service === "readarr") {
		const result = await executeReadarrHuntWithSdk(
			client as ReadarrClient,
			type,
			batchSize,
			filters,
			historyManager,
			apiCallCounter,
			logger,
		);
		return { ...result, apiCallsMade: apiCallCounter.count };
	}

	return {
		itemsSearched: 0,
		itemsGrabbed: 0,
		searchedItems: [],
		grabbedItems: [],
		message: `Unsupported service type: ${service}`,
		status: "error",
		apiCallsMade: apiCallCounter.count,
	};
}

/**
 * Check queue threshold using SDK.
 * Returns ok: false if check fails to prevent overloading queue on connectivity issues.
 */
async function checkQueueThresholdWithSdk(
	client: QueueCapableClient,
	threshold: number,
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<{ ok: boolean; message: string }> {
	if (threshold <= 0) {
		return { ok: true, message: "Queue threshold check disabled" };
	}

	try {
		counter.count++;
		const queue = await client.queue.get({ pageSize: 1 });
		const queueCount = queue.totalRecords ?? 0;

		if (queueCount >= threshold) {
			return {
				ok: false,
				message: `Queue (${queueCount}) exceeds threshold (${threshold})`,
			};
		}

		return { ok: true, message: `Queue (${queueCount}) below threshold (${threshold})` };
	} catch (error) {
		// Fail safely - if we can't check the queue, don't proceed to avoid overloading
		logger.warn(
			{ err: error, threshold },
			"Queue threshold check failed - skipping hunt to prevent potential queue overload",
		);
		return {
			ok: false,
			message: `Queue check failed: ${error instanceof Error ? error.message : "Unknown error"}. Please verify instance connectivity.`,
		};
	}
}

/**
 * Execute Sonarr hunt using SDK
 */
async function executeSonarrHuntWithSdk(
	client: SonarrClient,
	type: "missing" | "upgrade",
	batchSize: number,
	filters: ParsedFilters,
	historyManager: SearchHistoryManager,
	counter: ApiCallCounter,
	logger: HuntLogger,
	preferSeasonPacks: boolean,
): Promise<HuntResultWithoutApiCount> {
	try {
		// First, get all series to have filter data available
		counter.count++;
		const allSeries = await client.series.getAll();
		const seriesMap = new Map(allSeries.map((s) => [s.id ?? 0, s]));

		// Get wanted episodes with page rotation
		const fetchSize = Math.max(batchSize * 5, 50);

		const records = await fetchWantedWithWrapAround(
			(page) => {
				const params = { page, pageSize: fetchSize, sortKey: "airDateUtc" as const, sortDirection: "descending" as const };
				return type === "missing"
					? client.wanted.missing(params)
					: client.wanted.cutoff(params);
			},
			{ recentSearchCount: historyManager.getRecentSearchCount(), fetchSize, counter, logger },
		);

		if (records.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: `No ${type === "missing" ? "missing" : "upgradeable"} episodes found`,
				status: "completed",
			};
		}

		// Apply all filters
		const filteredEpisodes = records.filter((ep) => {
			if (!isContentReleased(ep.airDateUtc)) return false;

			const series = seriesMap.get(ep.seriesId ?? 0);
			if (!series) return false;

			return passesFilters(
				{
					tags: series.tags ?? [],
					qualityProfileId: series.qualityProfileId ?? 0,
					status: series.status ?? "",
					year: series.year ?? 0,
					monitored: (ep.monitored ?? false) && (series.monitored ?? false),
					releaseDate: ep.airDateUtc ?? undefined,
				},
				filters,
			);
		});

		const eligibleEpisodes = shuffleArray(filteredEpisodes);

		if (eligibleEpisodes.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: "No episodes match the current filters",
				status: "completed",
			};
		}

		// Group episodes by series + season
		const seasonGroups = new Map<string, typeof eligibleEpisodes>();
		for (const ep of eligibleEpisodes) {
			const key = `${ep.seriesId}-${ep.seasonNumber}`;
			const group = seasonGroups.get(key) ?? [];
			group.push(ep);
			seasonGroups.set(key, group);
		}

		// Separate into season searches and individual episode searches
		const seasonSearches: {
			seriesId: number;
			seasonNumber: number;
			episodeCount: number;
			title: string;
		}[] = [];
		const individualEpisodes: typeof eligibleEpisodes = [];

		// Use threshold of 1 when preferSeasonPacks is enabled, otherwise use default (3)
		const seasonThreshold = preferSeasonPacks ? 1 : SEASON_SEARCH_THRESHOLD;

		for (const [, episodes] of seasonGroups) {
			if (episodes.length >= seasonThreshold) {
				const firstEp = episodes[0];
				if (!firstEp) continue;
				const series = seriesMap.get(firstEp.seriesId ?? 0);
				const title = series?.title ?? "Unknown";

				const wasSearched = historyManager.wasRecentlySearched({
					mediaType: "season",
					mediaId: firstEp.seriesId ?? 0,
					seasonNumber: firstEp.seasonNumber ?? 0,
					title: `${title} S${String(firstEp.seasonNumber ?? 0).padStart(2, "0")}`,
				});

				if (!wasSearched) {
					seasonSearches.push({
						seriesId: firstEp.seriesId ?? 0,
						seasonNumber: firstEp.seasonNumber ?? 0,
						episodeCount: episodes.length,
						title,
					});
				}
			} else {
				for (const ep of episodes) {
					const series = seriesMap.get(ep.seriesId ?? 0);
					const wasSearched = historyManager.wasRecentlySearched({
						mediaType: "episode",
						mediaId: ep.id ?? 0,
						title: `${series?.title ?? "Unknown"} S${String(ep.seasonNumber ?? 0).padStart(2, "0")}E${String(ep.episodeNumber ?? 0).padStart(2, "0")}`,
					});
					if (!wasSearched) {
						individualEpisodes.push(ep);
					}
				}
			}
		}

		if (seasonSearches.length === 0 && individualEpisodes.length === 0) {
			const skippedCount = historyManager.getFilteredCount();
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message:
					skippedCount > 0
						? `All ${skippedCount} eligible items were recently searched`
						: "No episodes match the current filters",
				status: "completed",
			};
		}

		const searchStartTime = new Date();

		// Apply batch size limit
		let remainingBudget = batchSize;
		const seasonSearchesToExecute: typeof seasonSearches = [];
		const episodesToSearch: typeof individualEpisodes = [];
		const searchedItemNames: string[] = [];
		const searchedHistoryItems: SearchedItem[] = [];
		const searchedSeriesIds: number[] = [];
		const searchedEpisodeIds: number[] = [];

		for (const seasonSearch of seasonSearches) {
			if (remainingBudget <= 0) break;
			seasonSearchesToExecute.push(seasonSearch);
			remainingBudget -= seasonSearch.episodeCount;
			searchedItemNames.push(
				`${seasonSearch.title} Season ${seasonSearch.seasonNumber} (${seasonSearch.episodeCount} episodes)`,
			);
			searchedSeriesIds.push(seasonSearch.seriesId);
			searchedHistoryItems.push({
				mediaType: "season",
				mediaId: seasonSearch.seriesId,
				seasonNumber: seasonSearch.seasonNumber,
				title: `${seasonSearch.title} S${String(seasonSearch.seasonNumber).padStart(2, "0")}`,
			});
		}

		for (const ep of individualEpisodes) {
			if (remainingBudget <= 0) break;
			episodesToSearch.push(ep);
			remainingBudget--;
			const series = seriesMap.get(ep.seriesId ?? 0);
			const title = series?.title ?? "Unknown";
			searchedItemNames.push(
				`${title} S${String(ep.seasonNumber ?? 0).padStart(2, "0")}E${String(ep.episodeNumber ?? 0).padStart(2, "0")}`,
			);
			searchedSeriesIds.push(ep.seriesId ?? 0);
			searchedEpisodeIds.push(ep.id ?? 0);
			searchedHistoryItems.push({
				mediaType: "episode",
				mediaId: ep.id ?? 0,
				title: `${title} S${String(ep.seasonNumber ?? 0).padStart(2, "0")}E${String(ep.episodeNumber ?? 0).padStart(2, "0")}`,
			});
		}

		// Execute searches
		let searchErrors = 0;

		for (let i = 0; i < seasonSearchesToExecute.length; i++) {
			const seasonSearch = seasonSearchesToExecute[i];
			if (!seasonSearch) continue;

			if (i > 0) {
				await delay(SEARCH_DELAY_MS);
			}

			try {
				counter.count++;
				await client.command.execute({
					name: "SeasonSearch",
					seriesId: seasonSearch.seriesId,
					seasonNumber: seasonSearch.seasonNumber,
				});
			} catch (error) {
				searchErrors++;
				logger.error(
					{ err: error, title: seasonSearch.title, season: seasonSearch.seasonNumber },
					"Failed to execute season search",
				);
			}
		}

		for (let i = 0; i < episodesToSearch.length; i++) {
			const ep = episodesToSearch[i];
			if (!ep) continue;

			if (i > 0 || seasonSearchesToExecute.length > 0) {
				await delay(SEARCH_DELAY_MS);
			}

			try {
				counter.count++;
				await client.command.execute({
					name: "EpisodeSearch",
					episodeIds: [ep.id ?? 0],
				});
			} catch (error) {
				searchErrors++;
				const series = seriesMap.get(ep.seriesId ?? 0);
				logger.error(
					{ err: error, title: series?.title, season: ep.seasonNumber, episode: ep.episodeNumber },
					"Failed to execute episode search",
				);
			}
		}

		await historyManager.recordSearches(searchedHistoryItems);

		const grabbedItems = await detectGrabbedItemsFromHistoryWithSdk(
			client,
			searchStartTime,
			[],
			[...new Set(searchedSeriesIds)],
			searchedEpisodeIds,
			counter,
			logger,
		);

		const totalSearched =
			seasonSearchesToExecute.reduce((sum, s) => sum + s.episodeCount, 0) + episodesToSearch.length;
		const searchSummary = [];
		if (seasonSearchesToExecute.length > 0) {
			searchSummary.push(`${seasonSearchesToExecute.length} season(s)`);
		}
		if (episodesToSearch.length > 0) {
			searchSummary.push(`${episodesToSearch.length} episode(s)`);
		}

		const grabSummary = grabbedItems.length > 0 ? ` - ${grabbedItems.length} grabbed` : "";
		const errorSummary = searchErrors > 0 ? ` (${searchErrors} search errors)` : "";

		return {
			itemsSearched: totalSearched - searchErrors,
			itemsGrabbed: grabbedItems.length,
			searchedItems: searchedItemNames,
			grabbedItems,
			message: `Triggered search for ${searchSummary.join(" and ")}${grabSummary}${errorSummary}`,
			status: searchErrors > 0 ? "partial" : "completed",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return {
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: `Sonarr hunt failed: ${message}`,
			status: "error",
		};
	}
}

/**
 * Execute Radarr hunt using SDK
 */
async function executeRadarrHuntWithSdk(
	client: RadarrClient,
	type: "missing" | "upgrade",
	batchSize: number,
	filters: ParsedFilters,
	historyManager: SearchHistoryManager,
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<HuntResultWithoutApiCount> {
	try {
		const fetchSize = Math.max(batchSize * 5, 50);

		const movies = await fetchWantedWithWrapAround(
			(page) => {
				const params = { page, pageSize: fetchSize, sortKey: "digitalRelease" as const, sortDirection: "descending" as const };
				return type === "missing"
					? client.wanted.missing(params)
					: client.wanted.cutoff(params);
			},
			{ recentSearchCount: historyManager.getRecentSearchCount(), fetchSize, counter, logger },
		);

		if (movies.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: `No ${type === "missing" ? "missing" : "upgradeable"} movies found`,
				status: "completed",
			};
		}

		const filteredMovies = movies.filter((movie) => {
			const releaseDate = movie.digitalRelease || movie.physicalRelease || movie.inCinemas;
			if (!isContentReleased(releaseDate)) return false;

			return passesFilters(
				{
					tags: movie.tags ?? [],
					qualityProfileId: movie.qualityProfileId ?? 0,
					status: movie.status ?? "",
					year: movie.year ?? 0,
					monitored: movie.monitored ?? false,
					releaseDate: releaseDate ?? undefined,
				},
				filters,
			);
		});

		// Filter to only movies with valid id and title (required for search and history tracking)
		const validMovies = filteredMovies.filter(
			(movie): movie is typeof movie & { id: number; title: string } =>
				movie.id !== undefined && movie.title !== undefined && movie.title !== null,
		);

		const eligibleMovies = shuffleArray(validMovies);

		if (eligibleMovies.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: "No movies match the current filters",
				status: "completed",
			};
		}

		const notRecentlySearched = historyManager.filterRecentlySearched(eligibleMovies, (movie) => ({
			mediaType: "movie",
			mediaId: movie.id,
			title: `${movie.title} (${movie.year ?? "?"})`,
		}));

		if (notRecentlySearched.length === 0) {
			const skippedCount = historyManager.getFilteredCount();
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message:
					skippedCount > 0
						? `All ${skippedCount} eligible movies were recently searched`
						: "No movies match the current filters",
				status: "completed",
			};
		}

		const searchStartTime = new Date();

		const moviesToSearch = notRecentlySearched.slice(0, batchSize);
		const searchedItemNames = moviesToSearch.map((m) => `${m.title} (${m.year ?? "?"})`);
		const searchedMovieIds = moviesToSearch.map((m) => m.id);

		let searchErrors = 0;
		for (let i = 0; i < moviesToSearch.length; i++) {
			const movie = moviesToSearch[i];
			if (!movie) continue;

			if (i > 0) {
				await delay(SEARCH_DELAY_MS);
			}

			try {
				counter.count++;
				await client.command.execute({
					name: "MoviesSearch",
					movieIds: [movie.id],
				});
			} catch (error) {
				searchErrors++;
				logger.error(
					{ err: error, title: movie.title, year: movie.year },
					"Failed to execute movie search",
				);
			}
		}

		await historyManager.recordSearches(
			moviesToSearch.map((m) => ({
				mediaType: "movie" as const,
				mediaId: m.id,
				title: `${m.title} (${m.year ?? "?"})`,
			})),
		);

		const grabbedItems = await detectGrabbedItemsFromHistoryWithSdk(
			client,
			searchStartTime,
			searchedMovieIds,
			[],
			[],
			counter,
			logger,
		);

		const grabSummary = grabbedItems.length > 0 ? ` - ${grabbedItems.length} grabbed` : "";
		const errorSummary = searchErrors > 0 ? ` (${searchErrors} search errors)` : "";

		return {
			itemsSearched: moviesToSearch.length - searchErrors,
			itemsGrabbed: grabbedItems.length,
			searchedItems: searchedItemNames,
			grabbedItems,
			message: `Triggered search for ${moviesToSearch.length} movies${grabSummary}${errorSummary}`,
			status: searchErrors > 0 ? "partial" : "completed",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return {
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: `Radarr hunt failed: ${message}`,
			status: "error",
		};
	}
}

/**
 * Execute Lidarr hunt using SDK.
 * Searches for missing albums or albums needing quality upgrades.
 */
async function executeLidarrHuntWithSdk(
	client: LidarrClient,
	type: "missing" | "upgrade",
	batchSize: number,
	filters: ParsedFilters,
	historyManager: SearchHistoryManager,
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<HuntResultWithoutApiCount> {
	try {
		// First, get all artists to have filter data available
		counter.count++;
		const allArtists = await client.artist.getAll();
		const artistMap = new Map(allArtists.map((a) => [(a as { id?: number }).id ?? 0, a]));

		const fetchSize = Math.max(batchSize * 5, 50);

		const albums = await fetchWantedWithWrapAround(
			(page) => {
				const params = { page, pageSize: fetchSize, sortKey: "releaseDate" as const, sortDirection: "descending" as const };
				return type === "missing"
					? client.wanted.getMissing(params)
					: client.wanted.getCutoffUnmet(params);
			},
			{ recentSearchCount: historyManager.getRecentSearchCount(), fetchSize, counter, logger },
		);

		if (albums.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: `No ${type === "missing" ? "missing" : "upgradeable"} albums found`,
				status: "completed",
			};
		}

		// Apply filters
		const filteredAlbums = albums.filter((album) => {
			const albumAny = album as Record<string, unknown>;
			const releaseDate = albumAny.releaseDate as string | undefined;
			if (!isContentReleased(releaseDate)) return false;

			const artist = artistMap.get((albumAny.artistId as number) ?? 0);
			if (!artist) return false;

			const artistAny = artist as Record<string, unknown>;
			return passesFilters(
				{
					tags: (artistAny.tags as number[]) ?? [],
					qualityProfileId: (artistAny.qualityProfileId as number) ?? 0,
					status: (artistAny.status as string) ?? "",
					year: Number((releaseDate ?? "").slice(0, 4)) || 0,
					monitored: Boolean(albumAny.monitored) && Boolean(artistAny.monitored),
					releaseDate,
				},
				filters,
			);
		});

		const validAlbums = filteredAlbums.filter(
			(album): album is typeof album & { id: number; title: string } => {
				const a = album as Record<string, unknown>;
				return a.id !== undefined && a.title !== undefined;
			},
		);

		const eligibleAlbums = shuffleArray(validAlbums);

		if (eligibleAlbums.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: "No albums match the current filters",
				status: "completed",
			};
		}

		const notRecentlySearched = historyManager.filterRecentlySearched(eligibleAlbums, (album) => {
			const albumAny = album as Record<string, unknown>;
			const artist = artistMap.get((albumAny.artistId as number) ?? 0) as Record<string, unknown> | undefined;
			const artistName = (artist?.artistName as string) ?? "Unknown Artist";
			return {
				mediaType: "album",
				mediaId: album.id,
				title: `${artistName} - ${album.title}`,
			};
		});

		if (notRecentlySearched.length === 0) {
			const skippedCount = historyManager.getFilteredCount();
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message:
					skippedCount > 0
						? `All ${skippedCount} eligible albums were recently searched`
						: "No albums match the current filters",
				status: "completed",
			};
		}

		const albumsToSearch = notRecentlySearched.slice(0, batchSize);
		const searchedItemNames = albumsToSearch.map((album) => {
			const albumAny = album as Record<string, unknown>;
			const artist = artistMap.get((albumAny.artistId as number) ?? 0) as Record<string, unknown> | undefined;
			const artistName = (artist?.artistName as string) ?? "Unknown Artist";
			return `${artistName} - ${album.title}`;
		});

		let searchErrors = 0;
		for (let i = 0; i < albumsToSearch.length; i++) {
			const album = albumsToSearch[i];
			if (!album) continue;

			if (i > 0) {
				await delay(SEARCH_DELAY_MS);
			}

			try {
				counter.count++;
				await client.command.execute({
					name: "AlbumSearch",
					albumIds: [album.id],
				});
			} catch (error) {
				searchErrors++;
				logger.error(
					{ err: error, title: album.title },
					"Failed to execute album search",
				);
			}
		}

		await historyManager.recordSearches(
			albumsToSearch.map((album) => {
				const albumAny = album as Record<string, unknown>;
				const artist = artistMap.get((albumAny.artistId as number) ?? 0) as Record<string, unknown> | undefined;
				const artistName = (artist?.artistName as string) ?? "Unknown Artist";
				return {
					mediaType: "album" as const,
					mediaId: album.id,
					title: `${artistName} - ${album.title}`,
				};
			}),
		);

		const errorSummary = searchErrors > 0 ? ` (${searchErrors} search errors)` : "";

		return {
			itemsSearched: albumsToSearch.length - searchErrors,
			itemsGrabbed: 0, // Grab detection not implemented for Lidarr yet
			searchedItems: searchedItemNames,
			grabbedItems: [],
			message: `Triggered search for ${albumsToSearch.length} albums${errorSummary}`,
			status: searchErrors > 0 ? "partial" : "completed",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return {
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: `Lidarr hunt failed: ${message}`,
			status: "error",
		};
	}
}

/**
 * Execute Readarr hunt using SDK.
 * Searches for missing books or books needing quality upgrades.
 */
async function executeReadarrHuntWithSdk(
	client: ReadarrClient,
	type: "missing" | "upgrade",
	batchSize: number,
	filters: ParsedFilters,
	historyManager: SearchHistoryManager,
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<HuntResultWithoutApiCount> {
	try {
		// First, get all authors to have filter data available
		counter.count++;
		const allAuthors = await client.author.getAll();
		const authorMap = new Map(allAuthors.map((a) => [(a as { id?: number }).id ?? 0, a]));

		const fetchSize = Math.max(batchSize * 5, 50);

		const books = await fetchWantedWithWrapAround(
			(page) => {
				const params = { page, pageSize: fetchSize, sortKey: "releaseDate" as const, sortDirection: "descending" as const };
				return type === "missing"
					? client.wanted.getMissing(params)
					: client.wanted.getCutoffUnmet(params);
			},
			{ recentSearchCount: historyManager.getRecentSearchCount(), fetchSize, counter, logger },
		);

		if (books.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: `No ${type === "missing" ? "missing" : "upgradeable"} books found`,
				status: "completed",
			};
		}

		// Apply filters
		const filteredBooks = books.filter((book) => {
			const bookAny = book as Record<string, unknown>;
			const releaseDate = bookAny.releaseDate as string | undefined;
			if (!isContentReleased(releaseDate)) return false;

			const author = authorMap.get((bookAny.authorId as number) ?? 0);
			if (!author) return false;

			const authorAny = author as Record<string, unknown>;
			return passesFilters(
				{
					tags: (authorAny.tags as number[]) ?? [],
					qualityProfileId: (authorAny.qualityProfileId as number) ?? 0,
					status: (authorAny.status as string) ?? "",
					year: Number((releaseDate ?? "").slice(0, 4)) || 0,
					monitored: Boolean(bookAny.monitored) && Boolean(authorAny.monitored),
					releaseDate,
				},
				filters,
			);
		});

		const validBooks = filteredBooks.filter(
			(book): book is typeof book & { id: number; title: string } => {
				const b = book as Record<string, unknown>;
				return b.id !== undefined && b.title !== undefined;
			},
		);

		const eligibleBooks = shuffleArray(validBooks);

		if (eligibleBooks.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: "No books match the current filters",
				status: "completed",
			};
		}

		const notRecentlySearched = historyManager.filterRecentlySearched(eligibleBooks, (book) => {
			const bookAny = book as Record<string, unknown>;
			const author = authorMap.get((bookAny.authorId as number) ?? 0) as Record<string, unknown> | undefined;
			const authorName = (author?.authorName as string) ?? "Unknown Author";
			return {
				mediaType: "book",
				mediaId: book.id,
				title: `${authorName} - ${book.title}`,
			};
		});

		if (notRecentlySearched.length === 0) {
			const skippedCount = historyManager.getFilteredCount();
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message:
					skippedCount > 0
						? `All ${skippedCount} eligible books were recently searched`
						: "No books match the current filters",
				status: "completed",
			};
		}

		const booksToSearch = notRecentlySearched.slice(0, batchSize);
		const searchedItemNames = booksToSearch.map((book) => {
			const bookAny = book as Record<string, unknown>;
			const author = authorMap.get((bookAny.authorId as number) ?? 0) as Record<string, unknown> | undefined;
			const authorName = (author?.authorName as string) ?? "Unknown Author";
			return `${authorName} - ${book.title}`;
		});

		let searchErrors = 0;
		for (let i = 0; i < booksToSearch.length; i++) {
			const book = booksToSearch[i];
			if (!book) continue;

			if (i > 0) {
				await delay(SEARCH_DELAY_MS);
			}

			try {
				counter.count++;
				await client.command.execute({
					name: "BookSearch",
					bookIds: [book.id],
				});
			} catch (error) {
				searchErrors++;
				logger.error(
					{ err: error, title: book.title },
					"Failed to execute book search",
				);
			}
		}

		await historyManager.recordSearches(
			booksToSearch.map((book) => {
				const bookAny = book as Record<string, unknown>;
				const author = authorMap.get((bookAny.authorId as number) ?? 0) as Record<string, unknown> | undefined;
				const authorName = (author?.authorName as string) ?? "Unknown Author";
				return {
					mediaType: "book" as const,
					mediaId: book.id,
					title: `${authorName} - ${book.title}`,
				};
			}),
		);

		const errorSummary = searchErrors > 0 ? ` (${searchErrors} search errors)` : "";

		return {
			itemsSearched: booksToSearch.length - searchErrors,
			itemsGrabbed: 0, // Grab detection not implemented for Readarr yet
			searchedItems: searchedItemNames,
			grabbedItems: [],
			message: `Triggered search for ${booksToSearch.length} books${errorSummary}`,
			status: searchErrors > 0 ? "partial" : "completed",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown error";
		return {
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: `Readarr hunt failed: ${message}`,
			status: "error",
		};
	}
}
