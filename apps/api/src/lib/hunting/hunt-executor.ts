/**
 * Hunt Executor
 *
 * Orchestrates hunts against Sonarr/Radarr/Lidarr/Readarr instances
 * to find missing content and trigger quality upgrade searches.
 *
 * Filter evaluation, grab detection, and utility functions are
 * extracted into separate modules for maintainability.
 */

import type { LidarrClient } from "arr-sdk/lidarr";
import type { RadarrClient } from "arr-sdk/radarr";
import type { ReadarrClient } from "arr-sdk/readarr";
import type { SonarrClient } from "arr-sdk/sonarr";
import type { FastifyInstance } from "fastify";
import type { HuntConfig, ServiceInstance } from "../../lib/prisma.js";
import type { ArrClientFactory, QueueCapableClient } from "../arr/client-factory.js";
import { streamLibraryItems } from "../arr/library-stream.js";
import { delay } from "../utils/delay.js";
import { getErrorMessage } from "../utils/error-message.js";
import { SEARCH_DELAY_MS, SEASON_SEARCH_THRESHOLD } from "./constants.js";
import {
	detectGrabbedItemsFromHistoryWithSdk,
	detectLidarrGrabbedItems,
	detectReadarrGrabbedItems,
	type GrabbedItem,
} from "./grab-detector.js";
import {
	type HuntLogger,
	type HuntService,
	type ParsedFilters,
	parseFilters,
	passesFilters,
} from "./hunt-filters.js";
// Extracted modules
import { isContentReleased, shuffleArray } from "./hunt-utils.js";
import { type ApiCallCounter, fetchWantedWithWrapAround } from "./pagination-helpers.js";
import {
	createSearchHistoryManager,
	type SearchedItem,
	type SearchHistoryManager,
} from "./search-history.js";

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
	/** True when grab detection failed entirely — itemsGrabbed is unreliable */
	grabDetectionFailed?: boolean;
}

// Internal type for sub-functions (apiCallsMade added by executeHunt)
type HuntResultWithoutApiCount = Omit<HuntResult, "apiCallsMade">;

/**
 * Plumbing for the streaming JSON path (issue #427). The per-service
 * functions still take the SDK client for small / paginated endpoints
 * (queue, wanted, command, etc.) but use `factory + instance` to stream
 * the bulk-list endpoint (series/movie/artist/author and, for upgrade-all
 * mode, album/book) directly through @streamparser/json. That avoids the
 * 200-500 MB heap spike the SDK's `getAll()` triggers on large libraries.
 */
interface StreamingDeps {
	factory: ArrClientFactory;
	instance: ServiceInstance;
	log: HuntLogger;
}

/**
 * Slim projection of a Sonarr series resource. Only the fields the hunting
 * filter / search / synthetic-record code actually reads — see audit in
 * issue #427 follow-up. Keeping this shape tight is what bounds the
 * seriesMap memory on large libraries (50 MB → ~3 MB for 10k series).
 */
interface SlimSeries {
	id: number;
	title: string;
	monitored: boolean;
	tags: number[];
	qualityProfileId: number;
	status: string;
	year: number;
	/** Flattened from `series.statistics.episodeFileCount`. */
	episodeFileCount: number;
}

/** Slim projection of a Lidarr artist resource. */
interface SlimArtist {
	id: number;
	monitored: boolean;
	tags: number[];
	qualityProfileId: number;
	status: string;
	artistName: string;
}

/** Slim projection of a Readarr author resource. */
interface SlimAuthor {
	id: number;
	monitored: boolean;
	tags: number[];
	qualityProfileId: number;
	status: string;
	authorName: string;
}

/**
 * Stream-build a lookup Map keyed by `id` with each value projected to the
 * fields actually read downstream. Peak memory while building is bounded by
 * the parser buffer (~tens of KB) plus the slim Map itself — the full raw
 * record is dropped as soon as the projection fn runs.
 *
 * For Drewskieza's 50k-artist Lidarr (issue #427) this means the artistMap
 * stays at ~10 MB instead of the 200-500 MB the SDK's `getAll() + new Map`
 * pattern allocated.
 */
async function streamIntoSlimMap<TSlim>(
	deps: StreamingDeps,
	project: (raw: Record<string, unknown>) => TSlim | null,
	options?: { path?: string },
): Promise<Map<number, TSlim>> {
	const map = new Map<number, TSlim>();
	for await (const raw of streamLibraryItems(deps.factory, deps.instance, deps.log, options)) {
		const slim = project(raw);
		if (slim === null) continue;
		const id = (raw.id as number | undefined) ?? 0;
		if (id > 0) {
			map.set(id, slim);
		}
	}
	return map;
}

/**
 * SDK-fallback adapter: build the same slim Map from `await client.X.getAll()`.
 * Used when streamingDeps isn't provided (legacy callers / queue-threshold
 * tests that mock the SDK directly). Doesn't get the memory benefit, but
 * keeps the downstream code working with a uniform slim-Map shape.
 */
function buildSlimMapFromSdkArray<TSlim>(
	raw: ReadonlyArray<Record<string, unknown>>,
	project: (item: Record<string, unknown>) => TSlim | null,
): Map<number, TSlim> {
	const map = new Map<number, TSlim>();
	for (const item of raw) {
		const slim = project(item);
		if (slim === null) continue;
		const id = (item.id as number | undefined) ?? 0;
		if (id > 0) {
			map.set(id, slim);
		}
	}
	return map;
}

/** Project a raw series resource → SlimSeries; returns null when fields are missing. */
function projectSeries(raw: Record<string, unknown>): SlimSeries | null {
	const id = (raw.id as number | undefined) ?? 0;
	if (id <= 0) return null;
	const stats = raw.statistics as { episodeFileCount?: number } | undefined;
	return {
		id,
		title: (raw.title as string | undefined) ?? "",
		monitored: (raw.monitored as boolean | undefined) ?? false,
		tags: (raw.tags as number[] | undefined) ?? [],
		qualityProfileId: (raw.qualityProfileId as number | undefined) ?? 0,
		status: (raw.status as string | undefined) ?? "",
		year: (raw.year as number | undefined) ?? 0,
		episodeFileCount: stats?.episodeFileCount ?? 0,
	};
}

/** Project a raw artist resource → SlimArtist. */
function projectArtist(raw: Record<string, unknown>): SlimArtist | null {
	const id = (raw.id as number | undefined) ?? 0;
	if (id <= 0) return null;
	return {
		id,
		monitored: (raw.monitored as boolean | undefined) ?? false,
		tags: (raw.tags as number[] | undefined) ?? [],
		qualityProfileId: (raw.qualityProfileId as number | undefined) ?? 0,
		status: (raw.status as string | undefined) ?? "",
		artistName: (raw.artistName as string | undefined) ?? "",
	};
}

/** Project a raw author resource → SlimAuthor. */
function projectAuthor(raw: Record<string, unknown>): SlimAuthor | null {
	const id = (raw.id as number | undefined) ?? 0;
	if (id <= 0) return null;
	return {
		id,
		monitored: (raw.monitored as boolean | undefined) ?? false,
		tags: (raw.tags as number[] | undefined) ?? [],
		qualityProfileId: (raw.qualityProfileId as number | undefined) ?? 0,
		status: (raw.status as string | undefined) ?? "",
		authorName: (raw.authorName as string | undefined) ?? "",
	};
}

/**
 * Slim projection of a Radarr movie resource. Used for both `wanted.*`
 * (paginated) and `movie.getAll()` (streamed in upgrade-all mode) sources.
 * The downstream filter / history / search code reads all of these fields;
 * dropping the rest (overview, images[], runtime, languages, etc.) is the
 * memory win for users with 5k+ movie libraries.
 */
interface SlimMovie {
	id: number;
	title: string;
	year: number;
	monitored: boolean;
	hasFile: boolean;
	tags: number[];
	qualityProfileId: number;
	status: string;
	/** First non-empty of digitalRelease/physicalRelease/inCinemas — the
	 *  pre-flattened release date the filter uses for the released-yet check. */
	releaseDate: string | undefined;
}

/** Slim projection of a Lidarr album resource. */
interface SlimAlbum {
	id: number;
	title: string;
	monitored: boolean;
	releaseDate: string | undefined;
	artistId: number;
	/** Flattened from `statistics.trackFileCount`. */
	trackFileCount: number;
}

/** Slim projection of a Readarr book resource. */
interface SlimBook {
	id: number;
	title: string;
	monitored: boolean;
	releaseDate: string | undefined;
	authorId: number;
	/** Flattened from `statistics.bookFileCount`. */
	bookFileCount: number;
}

/** Project a raw movie record → SlimMovie. Returns null only when the id is missing. */
function projectMovie(raw: Record<string, unknown>): SlimMovie | null {
	const id = (raw.id as number | undefined) ?? 0;
	if (id <= 0) return null;
	const digital = raw.digitalRelease as string | undefined;
	const physical = raw.physicalRelease as string | undefined;
	const cinemas = raw.inCinemas as string | undefined;
	return {
		id,
		title: (raw.title as string | undefined) ?? "",
		year: (raw.year as number | undefined) ?? 0,
		monitored: (raw.monitored as boolean | undefined) ?? false,
		hasFile: (raw.hasFile as boolean | undefined) ?? false,
		tags: (raw.tags as number[] | undefined) ?? [],
		qualityProfileId: (raw.qualityProfileId as number | undefined) ?? 0,
		status: (raw.status as string | undefined) ?? "",
		releaseDate: digital || physical || cinemas,
	};
}

/** Project a raw album record → SlimAlbum. */
function projectAlbum(raw: Record<string, unknown>): SlimAlbum | null {
	const id = (raw.id as number | undefined) ?? 0;
	if (id <= 0) return null;
	const stats = raw.statistics as { trackFileCount?: number } | undefined;
	return {
		id,
		title: (raw.title as string | undefined) ?? "",
		monitored: (raw.monitored as boolean | undefined) ?? false,
		releaseDate: raw.releaseDate as string | undefined,
		artistId: (raw.artistId as number | undefined) ?? 0,
		trackFileCount: stats?.trackFileCount ?? 0,
	};
}

/** Project a raw book record → SlimBook. */
function projectBook(raw: Record<string, unknown>): SlimBook | null {
	const id = (raw.id as number | undefined) ?? 0;
	if (id <= 0) return null;
	const stats = raw.statistics as { bookFileCount?: number } | undefined;
	return {
		id,
		title: (raw.title as string | undefined) ?? "",
		monitored: (raw.monitored as boolean | undefined) ?? false,
		releaseDate: raw.releaseDate as string | undefined,
		authorId: (raw.authorId as number | undefined) ?? 0,
		bookFileCount: stats?.bookFileCount ?? 0,
	};
}

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
		service,
		config.queueThreshold,
		apiCallCounter,
		logger,
	);
	if (queueCheck.outcome !== "pass") {
		return {
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: queueCheck.message,
			// Distinguish a healthy throttle from an actionable failure so the
			// status badge and notification routing are accurate. (Issue #438.)
			status: queueCheck.outcome === "threshold-exceeded" ? "skipped" : "error",
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
	const upgradeSearchAll = config.upgradeSearchAll ?? false;

	// `streamingDeps` carries the inputs needed for the streaming JSON path
	// to bypass the SDK's buffer-then-parse `getAll()` (issue #427). Passed
	// uniformly to every per-service function so they can stream the
	// bulk-list endpoint without rebuilding the client per call.
	const streamingDeps: StreamingDeps = {
		factory: app.arrClientFactory,
		instance,
		log: logger,
	};

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
			upgradeSearchAll,
			streamingDeps,
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
			upgradeSearchAll,
			streamingDeps,
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
			upgradeSearchAll,
			streamingDeps,
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
			upgradeSearchAll,
			streamingDeps,
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
 * Statuses that count toward the queue threshold — items actively consuming
 * download capacity. Excludes "completed" (waiting to import), "failed",
 * "warning", and other stuck states which don't gate further searches.
 */
const ACTIVE_QUEUE_STATUSES = ["queued", "downloading", "paused", "delay"] as const;

type QueueCheckOutcome =
	| { outcome: "pass"; message: string }
	| { outcome: "threshold-exceeded"; message: string }
	| { outcome: "check-failed"; message: string };

/**
 * Check queue threshold using SDK.
 *
 * Counts only items in active states (queued/downloading/paused/delay) so the
 * threshold reflects actual download client load, not stuck imports or failed
 * items. (Issue #438.)
 *
 * Filter applicability by service:
 * - Sonarr/Radarr: native `status` query param, fully filtered.
 * - Lidarr: SDK forwards unknown options to the server.
 * - Readarr: arr-sdk's `QueueResource.get` enumerates known fields and DROPS
 *   unknown keys, so the `status` filter cannot be applied. We skip it there
 *   and use the unfiltered count to keep the threshold message honest;
 *   Readarr's behavior is unchanged from pre-fix.
 *
 * Outcomes:
 * - `pass` → hunt proceeds.
 * - `threshold-exceeded` → operator's queue is genuinely busy; map to "skipped".
 * - `check-failed` → connectivity / response-shape failure; map to "error" so
 *   the operator surface (status badge, notifications) reflects an actionable
 *   condition rather than a healthy throttle.
 */
async function checkQueueThresholdWithSdk(
	client: QueueCapableClient,
	service: HuntService,
	threshold: number,
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<QueueCheckOutcome> {
	if (threshold <= 0) {
		return { outcome: "pass", message: "Queue threshold check disabled" };
	}

	const filterApplicable = service !== "readarr";
	const label = filterApplicable ? "Active queue" : "Queue";

	try {
		counter.count++;
		// `client.queue.get` is a method-union across the 4 SDK clients, so
		// calling it directly requires intersected param types. Bind through a
		// permissive signature; per-service field handling happens in arr-sdk.
		const queueGet = client.queue.get.bind(client.queue) as (
			options: Record<string, unknown>,
		) => Promise<{ totalRecords?: number }>;
		const options: Record<string, unknown> = { pageSize: 1 };
		if (filterApplicable) {
			options.status = [...ACTIVE_QUEUE_STATUSES];
		}
		const queue = await queueGet(options);

		// Fail safe on a malformed response (HTML body from a misconfigured
		// reverse proxy, future SDK field rename, etc.) rather than coalescing
		// missing `totalRecords` to 0 and proceeding as if the queue were empty.
		if (typeof queue.totalRecords !== "number") {
			logger.warn(
				{ threshold, response: queue },
				"Queue check returned unexpected shape — failing safe",
			);
			return {
				outcome: "check-failed",
				message:
					"Queue check returned unexpected response shape. Verify SDK / instance compatibility.",
			};
		}

		const queueCount = queue.totalRecords;

		if (queueCount >= threshold) {
			return {
				outcome: "threshold-exceeded",
				message: `${label} (${queueCount}) exceeds threshold (${threshold})`,
			};
		}

		return {
			outcome: "pass",
			message: `${label} (${queueCount}) below threshold (${threshold})`,
		};
	} catch (error) {
		logger.warn(
			{ err: error, threshold },
			"Queue threshold check failed — surfacing as hunt error",
		);
		return {
			outcome: "check-failed",
			message: `Queue check failed: ${getErrorMessage(error, "Unknown error")}. Please verify instance connectivity.`,
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
	upgradeSearchAll = false,
	streamingDeps?: StreamingDeps,
): Promise<HuntResultWithoutApiCount> {
	try {
		// Stream the series list into a slim-projection Map (issue #427).
		// Each series is reduced to the 8 fields the downstream filter /
		// synthetic-record code reads — drops seasons[], images[], and the
		// rest of the heavy fields. For anime / long-running-show hoarders
		// with 10k+ series this is the difference between ~50 MB and ~3 MB
		// resident memory for the catalog.
		//
		// Falls back to SDK.getAll() when streamingDeps isn't provided
		// (queue-threshold tests mock the SDK directly) and rebuilds the
		// same slim shape from the buffered array.
		counter.count++;
		const seriesMap: Map<number, SlimSeries> = streamingDeps
			? await streamIntoSlimMap(streamingDeps, projectSeries)
			: buildSlimMapFromSdkArray(
					(await client.series.getAll()) as unknown as Array<Record<string, unknown>>,
					projectSeries,
				);

		// Get wanted episodes with page rotation
		// Fetch missing/cutoff records — the SDK Episode type is inferred via the generic fetcher
		const fetchSonarrWanted = (endpoint: "missing" | "cutoff") =>
			fetchWantedWithWrapAround(
				(page, pageSize) => {
					const params = {
						page,
						pageSize,
						sortKey: "airDateUtc" as const,
						sortDirection: "descending" as const,
					};
					return endpoint === "missing"
						? client.wanted.missing(params)
						: client.wanted.cutoff(params);
				},
				{ counter, logger },
			);

		type SonarrEpisodeRecord = Awaited<ReturnType<typeof fetchSonarrWanted>>[number];

		let records: SonarrEpisodeRecord[];

		if (type === "missing") {
			records = await fetchSonarrWanted("missing");
		} else {
			// Upgrade mode — include monitored items if upgradeSearchAll is enabled
			const wantedRecords = await fetchSonarrWanted("cutoff");

			if (upgradeSearchAll) {
				// When upgradeSearchAll is enabled: identify monitored series with episode files
				// and trigger series-level searches for them (Sonarr will re-evaluate all episodes)
				const monitoredSeriesWithFiles: SlimSeries[] = [];
				for (const s of seriesMap.values()) {
					if (s.monitored && s.episodeFileCount > 0) {
						monitoredSeriesWithFiles.push(s);
					}
				}

				// Build synthetic episode-like records from monitored series so they flow through
				// the same filter/batch pipeline. We use one record per series.
				const syntheticRecords: SonarrEpisodeRecord[] = monitoredSeriesWithFiles.map(
					(s) =>
						({
							id: s.id,
							seriesId: s.id,
							seasonNumber: -1, // sentinel: means "search entire series"
							episodeNumber: 0,
							title: s.title,
							airDateUtc: undefined as string | undefined,
							monitored: s.monitored,
							hasFile: true,
						}) as SonarrEpisodeRecord,
				);

				// Merge and deduplicate — for "both" mode, wanted records take priority per seriesId
				const seenSeriesIds = new Set(wantedRecords.map((r) => r.seriesId ?? 0));
				const merged: SonarrEpisodeRecord[] = [
					...wantedRecords,
					...syntheticRecords.filter((s) => !seenSeriesIds.has(s.seriesId ?? 0)),
				];
				records = merged;
			} else {
				records = wantedRecords;
			}
		}

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
		// Synthetic series-level records (seasonNumber === -1) skip airDateUtc check
		const filteredEpisodes = records.filter((ep) => {
			const isSyntheticSeriesRecord = (ep.seasonNumber ?? 0) === -1;
			if (!isSyntheticSeriesRecord && !isContentReleased(ep.airDateUtc)) return false;

			const series = seriesMap.get(ep.seriesId ?? 0);
			if (!series) return false;

			return passesFilters(
				{
					tags: series.tags ?? [],
					qualityProfileId: series.qualityProfileId ?? 0,
					status: series.status ?? "",
					year: series.year ?? 0,
					monitored: (ep.monitored ?? false) && (series.monitored ?? false),
					releaseDate: isSyntheticSeriesRecord ? undefined : (ep.airDateUtc ?? undefined),
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
				message: `Fetched ${records.length} episodes, ${records.length - filteredEpisodes.length} filtered out by release date/filters — 0 eligible`,
				status: "completed",
			};
		}

		// Separate synthetic series-level records from real episode records
		const syntheticSeriesRecords = eligibleEpisodes.filter((ep) => (ep.seasonNumber ?? 0) === -1);
		const realEpisodeRecords = eligibleEpisodes.filter((ep) => (ep.seasonNumber ?? 0) !== -1);

		// Group real episodes by series + season
		const seasonGroups = new Map<string, typeof realEpisodeRecords>();
		for (const ep of realEpisodeRecords) {
			const key = `${ep.seriesId}-${ep.seasonNumber}`;
			const group = seasonGroups.get(key) ?? [];
			group.push(ep);
			seasonGroups.set(key, group);
		}

		// Separate into series-level searches, season searches, and individual episode searches
		const seriesLevelSearches: {
			seriesId: number;
			title: string;
		}[] = [];
		const seasonSearches: {
			seriesId: number;
			seasonNumber: number;
			episodeCount: number;
			title: string;
		}[] = [];
		const individualEpisodes: typeof realEpisodeRecords = [];

		// Process synthetic series-level records (from upgradeSearchAll mode)
		for (const rec of syntheticSeriesRecords) {
			const series = seriesMap.get(rec.seriesId ?? 0);
			const title = series?.title ?? "Unknown";
			const wasSearched = historyManager.wasRecentlySearched({
				mediaType: "series",
				mediaId: rec.seriesId ?? 0,
				title,
			});
			if (!wasSearched) {
				seriesLevelSearches.push({
					seriesId: rec.seriesId ?? 0,
					title,
				});
			}
		}

		// Use threshold of 1 when preferSeasonPacks is enabled, otherwise use default (3)
		const seasonThreshold = preferSeasonPacks ? 1 : SEASON_SEARCH_THRESHOLD;
		const seriesLevelSearchIds = new Set(seriesLevelSearches.map((s) => s.seriesId));

		for (const [, episodes] of seasonGroups) {
			if (episodes.length >= seasonThreshold) {
				const firstEp = episodes[0];
				if (!firstEp) continue;
				const series = seriesMap.get(firstEp.seriesId ?? 0);
				const title = series?.title ?? "Unknown";

				// Skip if we already have a series-level search for this series
				if (seriesLevelSearchIds.has(firstEp.seriesId ?? 0)) continue;

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
					// Skip if we already have a series-level search for this series
					if (seriesLevelSearchIds.has(ep.seriesId ?? 0)) continue;

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

		if (
			seriesLevelSearches.length === 0 &&
			seasonSearches.length === 0 &&
			individualEpisodes.length === 0
		) {
			const skippedCount = historyManager.getFilteredCount();
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message:
					skippedCount > 0
						? `Fetched ${records.length} episodes → ${eligibleEpisodes.length} passed filters → all ${skippedCount} recently searched`
						: `Fetched ${records.length} episodes → 0 passed filters`,
				status: "completed",
			};
		}

		const searchStartTime = new Date();

		// Apply batch size limit
		let remainingBudget = batchSize;
		const seriesSearchesToExecute: typeof seriesLevelSearches = [];
		const seasonSearchesToExecute: typeof seasonSearches = [];
		const episodesToSearch: typeof individualEpisodes = [];
		const searchedItemNames: string[] = [];
		const searchedHistoryItems: SearchedItem[] = [];
		const searchedSeriesIds: number[] = [];
		const searchedEpisodeIds: number[] = [];

		// Series-level searches first (from upgradeSearchAll mode)
		for (const seriesSearch of seriesLevelSearches) {
			if (remainingBudget <= 0) break;
			seriesSearchesToExecute.push(seriesSearch);
			remainingBudget--; // Count as 1 search command
			searchedItemNames.push(`${seriesSearch.title} (all episodes)`);
			searchedSeriesIds.push(seriesSearch.seriesId);
			searchedHistoryItems.push({
				mediaType: "series",
				mediaId: seriesSearch.seriesId,
				title: seriesSearch.title,
			});
		}

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
		let commandIndex = 0;

		// Series-level searches (SeriesSearch command)
		for (const seriesSearch of seriesSearchesToExecute) {
			if (commandIndex > 0) {
				await delay(SEARCH_DELAY_MS);
			}
			commandIndex++;

			try {
				counter.count++;
				await client.command.execute({
					name: "SeriesSearch",
					seriesId: seriesSearch.seriesId,
				});
			} catch (error) {
				searchErrors++;
				logger.error({ err: error, title: seriesSearch.title }, "Failed to execute series search");
			}
		}

		for (let i = 0; i < seasonSearchesToExecute.length; i++) {
			const seasonSearch = seasonSearchesToExecute[i];
			if (!seasonSearch) continue;

			if (commandIndex > 0) {
				await delay(SEARCH_DELAY_MS);
			}
			commandIndex++;

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

			if (commandIndex > 0) {
				await delay(SEARCH_DELAY_MS);
			}
			commandIndex++;

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

		const grabResult = await detectGrabbedItemsFromHistoryWithSdk(
			client,
			searchStartTime,
			[],
			[...new Set(searchedSeriesIds)],
			searchedEpisodeIds,
			counter,
			logger,
		);

		const totalSearched =
			seriesSearchesToExecute.length +
			seasonSearchesToExecute.reduce((sum, s) => sum + s.episodeCount, 0) +
			episodesToSearch.length;
		const searchSummary = [];
		if (seriesSearchesToExecute.length > 0) {
			searchSummary.push(`${seriesSearchesToExecute.length} series`);
		}
		if (seasonSearchesToExecute.length > 0) {
			searchSummary.push(`${seasonSearchesToExecute.length} season(s)`);
		}
		if (episodesToSearch.length > 0) {
			searchSummary.push(`${episodesToSearch.length} episode(s)`);
		}

		const grabSummary = grabResult.items.length > 0 ? ` - ${grabResult.items.length} grabbed` : "";
		const errorSummary = searchErrors > 0 ? ` (${searchErrors} search errors)` : "";

		return {
			itemsSearched: totalSearched - searchErrors,
			itemsGrabbed: grabResult.items.length,
			searchedItems: searchedItemNames,
			grabbedItems: grabResult.items,
			grabDetectionFailed: grabResult.failed || undefined,
			message: `Triggered search for ${searchSummary.join(" and ")}${grabSummary}${errorSummary}`,
			status: searchErrors > 0 ? "partial" : "completed",
		};
	} catch (error) {
		const message = getErrorMessage(error, "Unknown error");
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
	upgradeSearchAll = false,
	streamingDeps?: StreamingDeps,
): Promise<HuntResultWithoutApiCount> {
	try {
		const fetchRadarrWanted = (endpoint: "missing" | "cutoff") =>
			fetchWantedWithWrapAround(
				(page, pageSize) => {
					const params = {
						page,
						pageSize,
						sortKey: "digitalRelease" as const,
						sortDirection: "descending" as const,
					};
					return endpoint === "missing"
						? client.wanted.missing(params)
						: client.wanted.cutoff(params);
				},
				{ counter, logger },
			);

		// Both `wanted.*` paginated records and `movie.getAll()` streamed records
		// project through the same slim shape — uniform downstream consumers,
		// 10x lower memory per item (~500 B vs ~5 KB). Issue #427 follow-up.
		const projectIntoSlim = (raw: unknown): SlimMovie | null =>
			projectMovie(raw as Record<string, unknown>);

		let movies: SlimMovie[];

		if (type === "missing") {
			const wanted = await fetchRadarrWanted("missing");
			movies = wanted.map(projectIntoSlim).filter((m): m is SlimMovie => m !== null);
		} else {
			// Upgrade mode — include monitored items if upgradeSearchAll is enabled
			const wantedMovies = (await fetchRadarrWanted("cutoff"))
				.map(projectIntoSlim)
				.filter((m): m is SlimMovie => m !== null);

			const monitoredMovies: SlimMovie[] = [];
			if (upgradeSearchAll) {
				counter.count++;
				// Stream the movie list, project to slim shape, filter inline.
				// Peak memory is bounded by `# of monitored+hasFile movies ×
				// ~500 bytes` — for a 10k-movie library that's 5 MB instead of
				// the 30-50 MB the full-record version held.
				if (streamingDeps) {
					for await (const raw of streamLibraryItems(
						streamingDeps.factory,
						streamingDeps.instance,
						streamingDeps.log,
					)) {
						const slim = projectMovie(raw);
						if (slim && slim.monitored && slim.hasFile) {
							monitoredMovies.push(slim);
						}
					}
				} else {
					const allMovies = await client.movie.getAll();
					for (const raw of allMovies) {
						const slim = projectMovie(raw as unknown as Record<string, unknown>);
						if (slim && slim.monitored && slim.hasFile) {
							monitoredMovies.push(slim);
						}
					}
				}
			}

			// Merge and deduplicate by movie ID — wanted records win on collision.
			const movieMap = new Map<number, SlimMovie>();
			for (const m of wantedMovies) movieMap.set(m.id, m);
			for (const m of monitoredMovies) {
				if (!movieMap.has(m.id)) movieMap.set(m.id, m);
			}
			movies = [...movieMap.values()];
		}

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
			if (!isContentReleased(movie.releaseDate) && !movie.hasFile) return false;

			return passesFilters(
				{
					tags: movie.tags,
					qualityProfileId: movie.qualityProfileId,
					status: movie.status,
					year: movie.year,
					monitored: movie.monitored,
					releaseDate: movie.releaseDate,
				},
				filters,
			);
		});

		// SlimMovie.id is always > 0 (projectMovie returns null otherwise) and
		// title defaults to ""; downstream only needs to skip empty titles.
		const validMovies = filteredMovies.filter((movie) => movie.title.length > 0);

		const eligibleMovies = shuffleArray(validMovies);

		if (eligibleMovies.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: `Fetched ${movies.length} movies, ${movies.length - eligibleMovies.length} filtered out — 0 eligible`,
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
						? `Fetched ${movies.length} movies → ${eligibleMovies.length} passed filters → all ${skippedCount} recently searched`
						: `Fetched ${movies.length} movies → 0 passed filters`,
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

		const grabResult = await detectGrabbedItemsFromHistoryWithSdk(
			client,
			searchStartTime,
			searchedMovieIds,
			[],
			[],
			counter,
			logger,
		);

		const grabSummary = grabResult.items.length > 0 ? ` - ${grabResult.items.length} grabbed` : "";
		const errorSummary = searchErrors > 0 ? ` (${searchErrors} search errors)` : "";

		return {
			itemsSearched: moviesToSearch.length - searchErrors,
			itemsGrabbed: grabResult.items.length,
			searchedItems: searchedItemNames,
			grabbedItems: grabResult.items,
			grabDetectionFailed: grabResult.failed || undefined,
			message: `Triggered search for ${moviesToSearch.length} movies${grabSummary}${errorSummary}`,
			status: searchErrors > 0 ? "partial" : "completed",
		};
	} catch (error) {
		const message = getErrorMessage(error, "Unknown error");
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
	upgradeSearchAll = false,
	streamingDeps?: StreamingDeps,
): Promise<HuntResultWithoutApiCount> {
	try {
		// Stream the full artist list. For users with 50k+ artists (issue #427)
		// this is the single biggest heap consumer on hunt-executor — the SDK's
		// buffer-then-parse `getAll()` allocated 200-500 MB just to build the
		// catalog. The slim-projection Map drops the heavy fields (statistics,
		// links, links[], images, etc.) and keeps only the 5 fields the
		// downstream filter / search-history code actually reads. For 50k
		// artists this is the difference between ~250 MB and ~10 MB resident.
		counter.count++;
		const artistMap: Map<number, SlimArtist> = streamingDeps
			? await streamIntoSlimMap(streamingDeps, projectArtist)
			: buildSlimMapFromSdkArray(
					(await client.artist.getAll()) as unknown as Array<Record<string, unknown>>,
					projectArtist,
				);

		const fetchLidarrWanted = (endpoint: "missing" | "cutoff") =>
			fetchWantedWithWrapAround(
				(page, pageSize) => {
					const params = {
						page,
						pageSize,
						sortKey: "releaseDate" as const,
						sortDirection: "descending" as const,
					};
					return endpoint === "missing"
						? client.wanted.getMissing(params)
						: client.wanted.getCutoffUnmet(params);
				},
				{ counter, logger },
			);

		// Project both wanted (paginated SDK) and monitored (streamed) records
		// to SlimAlbum so the downstream filter / merge / search code reads a
		// uniform shape. Memory saving is modest per-item but compounds when
		// upgrade-all is enabled against a 50k+ album library (issue #427).
		const projectAlbumLoose = (raw: unknown): SlimAlbum | null =>
			projectAlbum(raw as Record<string, unknown>);

		let albums: SlimAlbum[];

		if (type === "missing") {
			const wanted = await fetchLidarrWanted("missing");
			albums = wanted.map(projectAlbumLoose).filter((a): a is SlimAlbum => a !== null);
		} else {
			// Upgrade mode — include monitored items if upgradeSearchAll is enabled
			const wantedAlbums = (await fetchLidarrWanted("cutoff"))
				.map(projectAlbumLoose)
				.filter((a): a is SlimAlbum => a !== null);

			const monitoredAlbums: SlimAlbum[] = [];
			if (upgradeSearchAll) {
				counter.count++;
				// Stream `/api/v1/album`, project to slim, filter inline.
				// Path override required because the default LIDARR bulk
				// endpoint is `/api/v1/artist`.
				if (streamingDeps) {
					for await (const raw of streamLibraryItems(
						streamingDeps.factory,
						streamingDeps.instance,
						streamingDeps.log,
						{ path: "/api/v1/album" },
					)) {
						const slim = projectAlbum(raw);
						if (slim && slim.monitored && slim.trackFileCount > 0) {
							monitoredAlbums.push(slim);
						}
					}
				} else {
					const allAlbums = await client.album.getAll();
					for (const raw of allAlbums) {
						const slim = projectAlbum(raw as unknown as Record<string, unknown>);
						if (slim && slim.monitored && slim.trackFileCount > 0) {
							monitoredAlbums.push(slim);
						}
					}
				}
			}

			// Merge and deduplicate — wanted records win on collision.
			const albumMap = new Map<number, SlimAlbum>();
			for (const a of wantedAlbums) albumMap.set(a.id, a);
			for (const a of monitoredAlbums) {
				if (!albumMap.has(a.id)) albumMap.set(a.id, a);
			}
			albums = [...albumMap.values()];
		}

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

		// Apply filters using the slim shape — artist's filterable fields come
		// from the slim artistMap (already projected upstream).
		const filteredAlbums = albums.filter((album) => {
			const hasFiles = album.trackFileCount > 0;
			if (!isContentReleased(album.releaseDate) && !hasFiles) return false;

			const artist = artistMap.get(album.artistId);
			if (!artist) return false;

			return passesFilters(
				{
					tags: artist.tags,
					qualityProfileId: artist.qualityProfileId,
					status: artist.status,
					year: Number((album.releaseDate ?? "").slice(0, 4)) || 0,
					monitored: album.monitored && artist.monitored,
					releaseDate: album.releaseDate,
				},
				filters,
			);
		});

		const validAlbums = filteredAlbums.filter((album) => album.title.length > 0);

		const eligibleAlbums = shuffleArray(validAlbums);

		if (eligibleAlbums.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: `Fetched ${albums.length} albums, ${albums.length - eligibleAlbums.length} filtered out — 0 eligible`,
				status: "completed",
			};
		}

		const notRecentlySearched = historyManager.filterRecentlySearched(eligibleAlbums, (album) => {
			const artist = artistMap.get(album.artistId);
			const artistName = artist?.artistName ?? "Unknown Artist";
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
						? `Fetched ${albums.length} albums → ${eligibleAlbums.length} passed filters → all ${skippedCount} recently searched`
						: `Fetched ${albums.length} albums → 0 passed filters`,
				status: "completed",
			};
		}

		const albumsToSearch = notRecentlySearched.slice(0, batchSize);
		const searchedItemNames = albumsToSearch.map((album) => {
			const artist = artistMap.get(album.artistId);
			const artistName = artist?.artistName ?? "Unknown Artist";
			return `${artistName} - ${album.title}`;
		});

		const searchStartTime = new Date();
		const searchedAlbumIds: number[] = [];
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
				searchedAlbumIds.push(album.id);
			} catch (error) {
				searchErrors++;
				logger.error({ err: error, title: album.title }, "Failed to execute album search");
			}
		}

		await historyManager.recordSearches(
			albumsToSearch.map((album) => {
				const artist = artistMap.get(album.artistId);
				const artistName = artist?.artistName ?? "Unknown Artist";
				return {
					mediaType: "album" as const,
					mediaId: album.id,
					title: `${artistName} - ${album.title}`,
				};
			}),
		);

		const grabResult = await detectLidarrGrabbedItems(
			client,
			searchStartTime,
			searchedAlbumIds,
			counter,
			logger,
		);

		const grabSummary = grabResult.items.length > 0 ? ` - ${grabResult.items.length} grabbed` : "";
		const errorSummary = searchErrors > 0 ? ` (${searchErrors} search errors)` : "";

		return {
			itemsSearched: albumsToSearch.length - searchErrors,
			itemsGrabbed: grabResult.items.length,
			searchedItems: searchedItemNames,
			grabbedItems: grabResult.items,
			message: `Triggered search for ${albumsToSearch.length} albums${grabSummary}${errorSummary}`,
			status: searchErrors > 0 ? "partial" : "completed",
			...(grabResult.failed && { grabDetectionFailed: true }),
		};
	} catch (error) {
		const message = getErrorMessage(error, "Unknown error");
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
	upgradeSearchAll = false,
	streamingDeps?: StreamingDeps,
): Promise<HuntResultWithoutApiCount> {
	try {
		// Stream the full author list into a slim-projection Map. Mirror of
		// the Lidarr artist path — same memory profile (5 fields per entry
		// vs the full author resource with its embedded statistics, links,
		// images, etc.). Issue #427 follow-up.
		counter.count++;
		const authorMap: Map<number, SlimAuthor> = streamingDeps
			? await streamIntoSlimMap(streamingDeps, projectAuthor)
			: buildSlimMapFromSdkArray(
					(await client.author.getAll()) as unknown as Array<Record<string, unknown>>,
					projectAuthor,
				);

		const fetchReadarrWanted = (endpoint: "missing" | "cutoff") =>
			fetchWantedWithWrapAround(
				(page, pageSize) => {
					const params = {
						page,
						pageSize,
						sortKey: "releaseDate" as const,
						sortDirection: "descending" as const,
					};
					return endpoint === "missing"
						? client.wanted.getMissing(params)
						: client.wanted.getCutoffUnmet(params);
				},
				{ counter, logger },
			);

		// Project both wanted (paginated SDK) and monitored (streamed) records
		// to SlimBook so the downstream filter / merge / search code reads a
		// uniform shape. Mirror of the Lidarr album pattern.
		const projectBookLoose = (raw: unknown): SlimBook | null =>
			projectBook(raw as Record<string, unknown>);

		let books: SlimBook[];

		if (type === "missing") {
			const wanted = await fetchReadarrWanted("missing");
			books = wanted.map(projectBookLoose).filter((b): b is SlimBook => b !== null);
		} else {
			// Upgrade mode — include monitored items if upgradeSearchAll is enabled
			const wantedBooks = (await fetchReadarrWanted("cutoff"))
				.map(projectBookLoose)
				.filter((b): b is SlimBook => b !== null);

			const monitoredBooks: SlimBook[] = [];
			if (upgradeSearchAll) {
				counter.count++;
				// Stream `/api/v1/book`, project to slim, filter inline. Path
				// override required because the default READARR bulk endpoint
				// is `/api/v1/author`.
				if (streamingDeps) {
					for await (const raw of streamLibraryItems(
						streamingDeps.factory,
						streamingDeps.instance,
						streamingDeps.log,
						{ path: "/api/v1/book" },
					)) {
						const slim = projectBook(raw);
						if (slim && slim.monitored && slim.bookFileCount > 0) {
							monitoredBooks.push(slim);
						}
					}
				} else {
					const allBooks = await client.book.getAll();
					for (const raw of allBooks) {
						const slim = projectBook(raw as unknown as Record<string, unknown>);
						if (slim && slim.monitored && slim.bookFileCount > 0) {
							monitoredBooks.push(slim);
						}
					}
				}
			}

			// Merge and deduplicate — wanted records win on collision.
			const bookMap = new Map<number, SlimBook>();
			for (const b of wantedBooks) bookMap.set(b.id, b);
			for (const b of monitoredBooks) {
				if (!bookMap.has(b.id)) bookMap.set(b.id, b);
			}
			books = [...bookMap.values()];
		}

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

		// Apply filters using the slim shape — author's filterable fields come
		// from the slim authorMap (already projected upstream).
		const filteredBooks = books.filter((book) => {
			const bookHasFiles = book.bookFileCount > 0;
			if (!isContentReleased(book.releaseDate) && !bookHasFiles) return false;

			const author = authorMap.get(book.authorId);
			if (!author) return false;

			return passesFilters(
				{
					tags: author.tags,
					qualityProfileId: author.qualityProfileId,
					status: author.status,
					year: Number((book.releaseDate ?? "").slice(0, 4)) || 0,
					monitored: book.monitored && author.monitored,
					releaseDate: book.releaseDate,
				},
				filters,
			);
		});

		const validBooks = filteredBooks.filter((book) => book.title.length > 0);

		const eligibleBooks = shuffleArray(validBooks);

		if (eligibleBooks.length === 0) {
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: `Fetched ${books.length} books, ${books.length - eligibleBooks.length} filtered out — 0 eligible`,
				status: "completed",
			};
		}

		const notRecentlySearched = historyManager.filterRecentlySearched(eligibleBooks, (book) => {
			const author = authorMap.get(book.authorId);
			const authorName = author?.authorName ?? "Unknown Author";
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
						? `Fetched ${books.length} books → ${eligibleBooks.length} passed filters → all ${skippedCount} recently searched`
						: `Fetched ${books.length} books → 0 passed filters`,
				status: "completed",
			};
		}

		const booksToSearch = notRecentlySearched.slice(0, batchSize);
		const searchedItemNames = booksToSearch.map((book) => {
			const author = authorMap.get(book.authorId);
			const authorName = author?.authorName ?? "Unknown Author";
			return `${authorName} - ${book.title}`;
		});

		const searchStartTime = new Date();
		const searchedBookIds: number[] = [];
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
				searchedBookIds.push(book.id);
			} catch (error) {
				searchErrors++;
				logger.error({ err: error, title: book.title }, "Failed to execute book search");
			}
		}

		await historyManager.recordSearches(
			booksToSearch.map((book) => {
				const author = authorMap.get(book.authorId);
				const authorName = author?.authorName ?? "Unknown Author";
				return {
					mediaType: "book" as const,
					mediaId: book.id,
					title: `${authorName} - ${book.title}`,
				};
			}),
		);

		const grabResult = await detectReadarrGrabbedItems(
			client,
			searchStartTime,
			searchedBookIds,
			counter,
			logger,
		);

		const grabSummary = grabResult.items.length > 0 ? ` - ${grabResult.items.length} grabbed` : "";
		const errorSummary = searchErrors > 0 ? ` (${searchErrors} search errors)` : "";

		return {
			itemsSearched: booksToSearch.length - searchErrors,
			itemsGrabbed: grabResult.items.length,
			searchedItems: searchedItemNames,
			grabbedItems: grabResult.items,
			message: `Triggered search for ${booksToSearch.length} books${grabSummary}${errorSummary}`,
			status: searchErrors > 0 ? "partial" : "completed",
			...(grabResult.failed && { grabDetectionFailed: true }),
		};
	} catch (error) {
		const message = getErrorMessage(error, "Unknown error");
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
