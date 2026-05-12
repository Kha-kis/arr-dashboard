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

		type RadarrMovieRecord = Awaited<ReturnType<typeof fetchRadarrWanted>>[number];

		let movies: RadarrMovieRecord[];

		if (type === "missing") {
			movies = await fetchRadarrWanted("missing");
		} else {
			// Upgrade mode — include monitored items if upgradeSearchAll is enabled
			const wantedMovies = await fetchRadarrWanted("cutoff");

			let monitoredMovies: RadarrMovieRecord[] = [];
			if (upgradeSearchAll) {
				counter.count++;
				// Stream the movie list and filter inline. The downstream loop
				// reads many movie fields, so we keep the full record per
				// matching item — peak memory is bounded by `# of monitored
				// hasFile movies` rather than the full library size (issue #427).
				if (streamingDeps) {
					for await (const raw of streamLibraryItems(
						streamingDeps.factory,
						streamingDeps.instance,
						streamingDeps.log,
					)) {
						const m = raw as Record<string, unknown>;
						if ((m.monitored ?? false) && (m.hasFile ?? false)) {
							monitoredMovies.push(m as unknown as RadarrMovieRecord);
						}
					}
				} else {
					const allMovies = await client.movie.getAll();
					monitoredMovies = allMovies.filter(
						(m) => (m.monitored ?? false) && (m.hasFile ?? false),
					) as RadarrMovieRecord[];
				}
			}

			// Merge and deduplicate by movie ID
			const movieMap = new Map<number, RadarrMovieRecord>();
			for (const m of wantedMovies) movieMap.set(m.id ?? 0, m);
			for (const m of monitoredMovies) {
				if (!movieMap.has(m.id ?? 0)) movieMap.set(m.id ?? 0, m);
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
			const releaseDate = movie.digitalRelease || movie.physicalRelease || movie.inCinemas;
			if (!isContentReleased(releaseDate) && !(movie.hasFile ?? false)) return false;

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

		type LidarrAlbumRecord = Awaited<ReturnType<typeof fetchLidarrWanted>>[number];

		let albums: LidarrAlbumRecord[];

		if (type === "missing") {
			albums = await fetchLidarrWanted("missing");
		} else {
			// Upgrade mode — include monitored items if upgradeSearchAll is enabled
			const wantedAlbums = await fetchLidarrWanted("cutoff");

			let monitoredAlbums: LidarrAlbumRecord[] = [];
			if (upgradeSearchAll) {
				counter.count++;
				// Stream `/api/v1/album` and filter inline — same shape as the
				// Radarr movie callsite. The path override is required because
				// the default LIDARR bulk endpoint is `/api/v1/artist`.
				if (streamingDeps) {
					for await (const raw of streamLibraryItems(
						streamingDeps.factory,
						streamingDeps.instance,
						streamingDeps.log,
						{ path: "/api/v1/album" },
					)) {
						const albumAny = raw as Record<string, unknown>;
						const stats = albumAny.statistics as Record<string, unknown> | undefined;
						if (Boolean(albumAny.monitored) && ((stats?.trackFileCount as number) ?? 0) > 0) {
							monitoredAlbums.push(albumAny as unknown as LidarrAlbumRecord);
						}
					}
				} else {
					const allAlbums = await client.album.getAll();
					monitoredAlbums = allAlbums.filter((a) => {
						const albumAny = a as Record<string, unknown>;
						const stats = albumAny.statistics as Record<string, unknown> | undefined;
						return Boolean(albumAny.monitored) && ((stats?.trackFileCount as number) ?? 0) > 0;
					}) as LidarrAlbumRecord[];
				}
			}

			// Merge and deduplicate
			const albumMap = new Map<number, LidarrAlbumRecord>();
			for (const a of wantedAlbums) {
				const id = (a as Record<string, unknown>).id as number | undefined;
				if (id != null) albumMap.set(id, a);
			}
			for (const a of monitoredAlbums) {
				const id = ((a as Record<string, unknown>).id as number) ?? 0;
				if (!albumMap.has(id)) albumMap.set(id, a);
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

		// Apply filters
		const filteredAlbums = albums.filter((album) => {
			const albumAny = album as Record<string, unknown>;
			const releaseDate = albumAny.releaseDate as string | undefined;
			const stats = (album as Record<string, unknown>).statistics as
				| Record<string, unknown>
				| undefined;
			const hasFiles = ((stats?.trackFileCount as number) ?? 0) > 0;
			if (!isContentReleased(releaseDate) && !hasFiles) return false;

			const artist = artistMap.get((albumAny.artistId as number) ?? 0);
			if (!artist) return false;

			return passesFilters(
				{
					tags: artist.tags,
					qualityProfileId: artist.qualityProfileId,
					status: artist.status,
					year: Number((releaseDate ?? "").slice(0, 4)) || 0,
					monitored: Boolean(albumAny.monitored) && artist.monitored,
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
				message: `Fetched ${albums.length} albums, ${albums.length - eligibleAlbums.length} filtered out — 0 eligible`,
				status: "completed",
			};
		}

		const notRecentlySearched = historyManager.filterRecentlySearched(eligibleAlbums, (album) => {
			const albumAny = album as Record<string, unknown>;
			const artist = artistMap.get((albumAny.artistId as number) ?? 0);
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
			const albumAny = album as Record<string, unknown>;
			const artist = artistMap.get((albumAny.artistId as number) ?? 0);
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
				const albumAny = album as Record<string, unknown>;
				const artist = artistMap.get((albumAny.artistId as number) ?? 0) as
					| Record<string, unknown>
					| undefined;
				const artistName = (artist?.artistName as string) ?? "Unknown Artist";
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

		type ReadarrBookRecord = Awaited<ReturnType<typeof fetchReadarrWanted>>[number];

		let books: ReadarrBookRecord[];

		if (type === "missing") {
			books = await fetchReadarrWanted("missing");
		} else {
			// Upgrade mode — include monitored items if upgradeSearchAll is enabled
			const wantedBooks = await fetchReadarrWanted("cutoff");

			let monitoredBooks: ReadarrBookRecord[] = [];
			if (upgradeSearchAll) {
				counter.count++;
				// Stream `/api/v1/book` and filter inline. Path override is
				// required because the default READARR bulk endpoint is
				// `/api/v1/author`.
				if (streamingDeps) {
					for await (const raw of streamLibraryItems(
						streamingDeps.factory,
						streamingDeps.instance,
						streamingDeps.log,
						{ path: "/api/v1/book" },
					)) {
						const bookAny = raw as Record<string, unknown>;
						const stats = bookAny.statistics as Record<string, unknown> | undefined;
						if (Boolean(bookAny.monitored) && ((stats?.bookFileCount as number) ?? 0) > 0) {
							monitoredBooks.push(bookAny as unknown as ReadarrBookRecord);
						}
					}
				} else {
					const allBooks = await client.book.getAll();
					monitoredBooks = allBooks.filter((b) => {
						const bookAny = b as Record<string, unknown>;
						const stats = bookAny.statistics as Record<string, unknown> | undefined;
						return Boolean(bookAny.monitored) && ((stats?.bookFileCount as number) ?? 0) > 0;
					}) as ReadarrBookRecord[];
				}
			}

			// Merge and deduplicate
			const bookMap = new Map<number, ReadarrBookRecord>();
			for (const b of wantedBooks) {
				const id = (b as Record<string, unknown>).id as number | undefined;
				if (id != null) bookMap.set(id, b);
			}
			for (const b of monitoredBooks) {
				const id = ((b as Record<string, unknown>).id as number) ?? 0;
				if (!bookMap.has(id)) bookMap.set(id, b);
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

		// Apply filters
		const filteredBooks = books.filter((book) => {
			const bookAny = book as Record<string, unknown>;
			const releaseDate = bookAny.releaseDate as string | undefined;
			const bookStats = (book as Record<string, unknown>).statistics as
				| Record<string, unknown>
				| undefined;
			const bookHasFiles = ((bookStats?.bookFileCount as number) ?? 0) > 0;
			if (!isContentReleased(releaseDate) && !bookHasFiles) return false;

			const author = authorMap.get((bookAny.authorId as number) ?? 0);
			if (!author) return false;

			return passesFilters(
				{
					tags: author.tags,
					qualityProfileId: author.qualityProfileId,
					status: author.status,
					year: Number((releaseDate ?? "").slice(0, 4)) || 0,
					monitored: Boolean(bookAny.monitored) && author.monitored,
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
				message: `Fetched ${books.length} books, ${books.length - eligibleBooks.length} filtered out — 0 eligible`,
				status: "completed",
			};
		}

		const notRecentlySearched = historyManager.filterRecentlySearched(eligibleBooks, (book) => {
			const bookAny = book as Record<string, unknown>;
			const author = authorMap.get((bookAny.authorId as number) ?? 0);
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
			const bookAny = book as Record<string, unknown>;
			const author = authorMap.get((bookAny.authorId as number) ?? 0);
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
				const bookAny = book as Record<string, unknown>;
				const author = authorMap.get((bookAny.authorId as number) ?? 0) as
					| Record<string, unknown>
					| undefined;
				const authorName = (author?.authorName as string) ?? "Unknown Author";
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
// retargeted to main 2026-05-12
