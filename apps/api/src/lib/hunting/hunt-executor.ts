import type { HuntConfig, ServiceInstance } from "../../lib/prisma.js";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { SonarrClient } from "arr-sdk/sonarr";
import type { RadarrClient } from "arr-sdk/radarr";
import { SEASON_SEARCH_THRESHOLD, SEARCH_DELAY_MS, GRAB_CHECK_DELAY_MS } from "./constants.js";
import {
	createSearchHistoryManager,
	type SearchHistoryManager,
	type SearchedItem,
} from "./search-history.js";

/**
 * Logger type for hunt executor functions
 * Uses Fastify's base logger for structured logging
 */
type HuntLogger = FastifyBaseLogger;

/**
 * Delay helper - waits for the specified milliseconds
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * API call counter for tracking actual API usage during hunts
 */
interface ApiCallCounter {
	count: number;
}

/**
 * Hunt Executor
 *
 * Executes hunts against Sonarr/Radarr instances to find missing content
 * and trigger quality upgrade searches. Supports filtering by tags,
 * quality profiles, status, year range, and age threshold.
 */

export interface GrabbedItem {
	title: string;
	quality?: string;
	indexer?: string;
	size?: number;
}

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

// Sonarr types
interface SonarrSeries {
	id: number;
	title: string;
	status: string; // "continuing", "ended", "upcoming", "deleted"
	year: number;
	monitored: boolean;
	tags: number[];
	qualityProfileId: number;
}

interface SonarrEpisode {
	id: number;
	seriesId: number;
	episodeNumber: number;
	seasonNumber: number;
	title: string;
	airDateUtc?: string;
	monitored: boolean;
	series?: SonarrSeries;
}

// Radarr types
interface RadarrMovie {
	id: number;
	title: string;
	year: number;
	status: string; // "tba", "announced", "inCinemas", "released", "deleted"
	monitored: boolean;
	hasFile: boolean;
	tags: number[];
	qualityProfileId: number;
	digitalRelease?: string;
	physicalRelease?: string;
	inCinemas?: string;
}

interface WantedResponse<T> {
	page: number;
	pageSize: number;
	totalRecords: number;
	records: T[];
}

interface QueueResponse {
	totalRecords: number;
}

// Extended queue response for grab detection
interface QueueItem {
	id: number;
	title: string;
	size: number;
	quality?: { quality?: { name?: string } };
	indexer?: string;
	// Sonarr fields
	seriesId?: number;
	episodeId?: number;
	seasonNumber?: number;
	// Radarr fields
	movieId?: number;
}

interface FullQueueResponse {
	totalRecords: number;
	records: QueueItem[];
}

// History response for grab detection (more reliable than queue)
interface HistoryRecord {
	id: number;
	date: string;
	eventType: string;
	sourceTitle?: string;
	quality?: { quality?: { name?: string } };
	data?: {
		indexer?: string;
		size?: string;
		nzbInfoUrl?: string;
		downloadClient?: string;
		releaseGroup?: string;
	};
	// Sonarr fields
	seriesId?: number;
	episodeId?: number;
	// Radarr fields
	movieId?: number;
}

interface HistoryResponse {
	page: number;
	pageSize: number;
	totalRecords: number;
	records: HistoryRecord[];
}

// Filter configuration parsed from HuntConfig
interface ParsedFilters {
	filterLogic: "AND" | "OR";
	monitoredOnly: boolean;
	includeTags: number[];
	excludeTags: number[];
	includeQualityProfiles: number[];
	excludeQualityProfiles: number[];
	includeStatuses: string[];
	expandedStatuses: Set<string>; // Pre-expanded for hierarchical matching
	yearMin: number | null;
	yearMax: number | null;
	ageThresholdDays: number | null;
}

/**
 * Randomizes the order of elements in an array.
 *
 * @param array - The input array to shuffle
 * @returns A new array containing the elements of `array` in randomized order
 */
function shuffleArray<T>(array: T[]): T[] {
	const shuffled = [...array];
	for (let i = shuffled.length - 1; i > 0; i--) {
		const j = Math.floor(Math.random() * (i + 1));
		const temp = shuffled[i];
		shuffled[i] = shuffled[j] as T;
		shuffled[j] = temp as T;
	}
	return shuffled;
}

/**
 * Determine whether a release date is in the past or present.
 *
 * @param releaseDate - The release or air date as an ISO date string, or `null`/`undefined` if unknown
 * @returns `true` if `releaseDate` is present and not in the future, `false` otherwise
 */
function isContentReleased(releaseDate: string | undefined | null): boolean {
	if (!releaseDate) return false; // No release date = treat as unreleased
	const release = new Date(releaseDate);
	const now = new Date();
	return release <= now;
}

/**
 * Radarr status hierarchy for filtering
 * Selecting a status includes all statuses further in the release pipeline
 * Order: tba → announced → inCinemas → released
 */
const RADARR_STATUS_HIERARCHY: Record<string, string[]> = {
	tba: ["tba", "announced", "inCinemas", "released"],
	announced: ["announced", "inCinemas", "released"],
	inCinemas: ["inCinemas", "released"],
	released: ["released"],
};

/**
 * Sonarr status hierarchy for filtering
 * Selecting a status includes all statuses further in the lifecycle
 * Order: upcoming → continuing → ended
 */
const SONARR_STATUS_HIERARCHY: Record<string, string[]> = {
	upcoming: ["upcoming", "continuing", "ended"],
	continuing: ["continuing", "ended"],
	ended: ["ended"],
};

/**
 * Expand a list of status keys to include lifecycle-related statuses for the specified service.
 *
 * Unknown statuses are preserved (converted to lowercase) so they can still be matched.
 *
 * @param statuses - Status keys selected by the user
 * @param service - Either `"sonarr"` or `"radarr"`, which determines the expansion hierarchy
 * @returns A `Set` of lowercased statuses containing the original statuses and any hierarchically related statuses
 */
function expandStatusFilters(statuses: string[], service: "sonarr" | "radarr"): Set<string> {
	const hierarchy = service === "sonarr" ? SONARR_STATUS_HIERARCHY : RADARR_STATUS_HIERARCHY;
	const expanded = new Set<string>();

	for (const status of statuses) {
		const related = hierarchy[status.toLowerCase()];
		if (related) {
			for (const s of related) {
				expanded.add(s);
			}
		} else {
			// Unknown status, include as-is
			expanded.add(status.toLowerCase());
		}
	}

	return expanded;
}

/**
 * Create a ParsedFilters object from a HuntConfig by parsing JSON-encoded arrays and expanding statuses for the target service.
 *
 * @param config - Hunt configuration containing raw filter values (JSON arrays encoded as strings and scalar filter settings)
 * @param service - Target service ("sonarr" or "radarr") used to expand provided statuses into the service-specific status hierarchy
 * @param logger - Fastify logger for structured logging
 * @returns A ParsedFilters object with parsed include/exclude tag and quality profile arrays, includeStatuses, expandedStatuses, year range, ageThresholdDays, filterLogic, and monitoredOnly flag
 */
function parseFilters(
	config: HuntConfig,
	service: "sonarr" | "radarr",
	logger: HuntLogger,
): ParsedFilters {
	const parseJsonArray = (
		value: string | null | undefined,
		fieldName: string,
	): number[] | string[] => {
		if (!value) return [];
		try {
			return JSON.parse(value);
		} catch (error) {
			logger.warn(
				{ err: error, field: fieldName, value, configId: config.id },
				"Failed to parse hunt filter JSON - filter will be ignored",
			);
			return [];
		}
	};

	const includeStatuses = parseJsonArray(config.includeStatuses, "includeStatuses") as string[];

	return {
		filterLogic: (config.filterLogic as "AND" | "OR") || "AND",
		monitoredOnly: config.monitoredOnly ?? true,
		includeTags: parseJsonArray(config.includeTags, "includeTags") as number[],
		excludeTags: parseJsonArray(config.excludeTags, "excludeTags") as number[],
		includeQualityProfiles: parseJsonArray(
			config.includeQualityProfiles,
			"includeQualityProfiles",
		) as number[],
		excludeQualityProfiles: parseJsonArray(
			config.excludeQualityProfiles,
			"excludeQualityProfiles",
		) as number[],
		includeStatuses,
		expandedStatuses: expandStatusFilters(includeStatuses, service),
		yearMin: config.yearMin,
		yearMax: config.yearMax,
		ageThresholdDays: config.ageThresholdDays,
	};
}

/**
 * Evaluate whether a single filter condition is satisfied for a candidate item.
 *
 * @param item - Candidate item's relevant fields: `tags`, `qualityProfileId`, `status`, `year`, `monitored`, and optional `releaseDate`
 * @param filters - ParsedFilters containing the filter criteria to evaluate against
 * @param conditionName - The filter condition to check. Accepted values:
 *   - "monitored"
 *   - "includeTags"
 *   - "excludeTags"
 *   - "includeQualityProfiles"
 *   - "excludeQualityProfiles"
 *   - "includeStatuses"
 *   - "yearMin"
 *   - "yearMax"
 *   - "ageThreshold"
 * @returns `true` if the item satisfies the specified condition, `false` otherwise.
 */
function checkFilterCondition(
	item: {
		tags: number[];
		qualityProfileId: number;
		status: string;
		year: number;
		monitored: boolean;
		releaseDate?: string;
	},
	filters: ParsedFilters,
	conditionName: string,
): boolean {
	switch (conditionName) {
		case "monitored":
			return !filters.monitoredOnly || item.monitored;

		case "includeTags":
			if (filters.includeTags.length === 0) return true;
			return filters.includeTags.some((tagId) => item.tags.includes(tagId));

		case "excludeTags":
			if (filters.excludeTags.length === 0) return true;
			return !filters.excludeTags.some((tagId) => item.tags.includes(tagId));

		case "includeQualityProfiles":
			if (filters.includeQualityProfiles.length === 0) return true;
			return filters.includeQualityProfiles.includes(item.qualityProfileId);

		case "excludeQualityProfiles":
			if (filters.excludeQualityProfiles.length === 0) return true;
			return !filters.excludeQualityProfiles.includes(item.qualityProfileId);

		case "includeStatuses":
			if (filters.includeStatuses.length === 0) return true;
			// Use expanded statuses for hierarchical matching
			return filters.expandedStatuses.has(item.status.toLowerCase());

		case "yearMin":
			if (filters.yearMin === null) return true;
			return item.year >= filters.yearMin;

		case "yearMax":
			if (filters.yearMax === null) return true;
			return item.year <= filters.yearMax;

		case "ageThreshold": {
			if (filters.ageThresholdDays === null || !item.releaseDate) return true;
			const releaseDate = new Date(item.releaseDate);
			const thresholdDate = new Date();
			thresholdDate.setDate(thresholdDate.getDate() - filters.ageThresholdDays);
			return releaseDate <= thresholdDate; // Only hunt content older than threshold
		}

		default:
			return true;
	}
}

/**
 * Determine whether a media item satisfies the provided filters.
 *
 * @param item - Metadata for the media item used for filtering: `tags` (tag IDs), `qualityProfileId`, `status`, `year`, `monitored`, and optional `releaseDate` (ISO string).
 * @param filters - ParsedFilters that define inclusion/exclusion criteria and filter logic.
 * @returns `true` if the item passes the filters and is not excluded, `false` otherwise.
 */
function passesFilters(
	item: {
		tags: number[];
		qualityProfileId: number;
		status: string;
		year: number;
		monitored: boolean;
		releaseDate?: string;
	},
	filters: ParsedFilters,
): boolean {
	const conditions = [
		"monitored",
		"includeTags",
		"excludeTags",
		"includeQualityProfiles",
		"excludeQualityProfiles",
		"includeStatuses",
		"yearMin",
		"yearMax",
		"ageThreshold",
	];

	const results = conditions.map((condition) => checkFilterCondition(item, filters, condition));

	// Exclude conditions always use AND logic (they're blockers)
	const excludeResults = [
		checkFilterCondition(item, filters, "excludeTags"),
		checkFilterCondition(item, filters, "excludeQualityProfiles"),
	];

	if (!excludeResults.every((r) => r)) {
		return false; // Excluded items are always filtered out
	}

	// For include filters, apply the selected logic
	const includeConditions = [
		"monitored",
		"includeTags",
		"includeQualityProfiles",
		"includeStatuses",
		"yearMin",
		"yearMax",
		"ageThreshold",
	];

	const includeResults = includeConditions.map((condition) =>
		checkFilterCondition(item, filters, condition),
	);

	if (filters.filterLogic === "OR") {
		// At least one condition must pass (but skip conditions that have no filter set)
		const activeConditions = includeConditions.filter((condition) => {
			switch (condition) {
				case "monitored":
					return filters.monitoredOnly;
				case "includeTags":
					return filters.includeTags.length > 0;
				case "includeQualityProfiles":
					return filters.includeQualityProfiles.length > 0;
				case "includeStatuses":
					return filters.includeStatuses.length > 0;
				case "yearMin":
					return filters.yearMin !== null;
				case "yearMax":
					return filters.yearMax !== null;
				case "ageThreshold":
					return filters.ageThresholdDays !== null;
				default:
					return false;
			}
		});

		if (activeConditions.length === 0) return true; // No active filters
		return activeConditions.some((condition) => checkFilterCondition(item, filters, condition));
	}

	// AND logic: all conditions must pass
	return includeResults.every((r) => r);
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
	const client = app.arrClientFactory.create(instance);
	const apiCallCounter: ApiCallCounter = { count: 0 };

	const service = instance.service.toLowerCase() as "sonarr" | "radarr";
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
 * Check queue threshold using SDK
 * Returns ok: false if check fails to prevent overloading queue on connectivity issues
 */
async function checkQueueThresholdWithSdk(
	client: SonarrClient | RadarrClient,
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
 * Detect grabbed items from history using SDK
 */
async function detectGrabbedItemsFromHistoryWithSdk(
	client: SonarrClient | RadarrClient,
	searchStartTime: Date,
	searchedMovieIds: number[],
	searchedSeriesIds: number[],
	searchedEpisodeIds: number[],
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<GrabbedItem[]> {
	try {
		await delay(GRAB_CHECK_DELAY_MS);

		counter.count++;
		const history = await client.history.get({
			pageSize: 100,
			sortKey: "date",
			sortDirection: "descending",
			eventType: "grabbed",
		});

		const grabbedItems: GrabbedItem[] = [];

		for (const record of history.records ?? []) {
			const eventDate = new Date(record.date ?? "");
			if (eventDate < searchStartTime) continue;

			const recordAny = record as Record<string, unknown>;
			const isMatchingMovie =
				recordAny.movieId && searchedMovieIds.includes(recordAny.movieId as number);
			const isMatchingSeries =
				recordAny.seriesId && searchedSeriesIds.includes(recordAny.seriesId as number);
			const isMatchingEpisode =
				recordAny.episodeId && searchedEpisodeIds.includes(recordAny.episodeId as number);

			if (isMatchingMovie || isMatchingSeries || isMatchingEpisode) {
				const dataObj = (recordAny.data ?? {}) as Record<string, unknown>;

				let size: number | undefined;
				const sizeValue = dataObj.size ?? recordAny.size;
				if (typeof sizeValue === "number") {
					size = sizeValue;
				} else if (typeof sizeValue === "string") {
					const parsed = Number.parseInt(sizeValue, 10);
					if (!Number.isNaN(parsed)) {
						size = parsed;
					}
				}

				const qualityObj = recordAny.quality as Record<string, unknown> | undefined;
				const qualityName =
					((qualityObj?.quality as Record<string, unknown>)?.name as string | undefined) ??
					(qualityObj?.name as string | undefined);

				const indexer = (dataObj.indexer ?? recordAny.indexer) as string | undefined;
				const title = (recordAny.sourceTitle ??
					dataObj.releaseTitle ??
					dataObj.title ??
					"Unknown") as string;

				grabbedItems.push({
					title,
					quality: qualityName,
					indexer,
					size,
				});
			}
		}

		return grabbedItems;
	} catch (error) {
		logger.warn(
			{ err: error },
			"History-based grab detection failed, falling back to queue detection",
		);
		return detectGrabbedItemsFromQueueWithSdk(
			client,
			searchedMovieIds,
			searchedSeriesIds,
			searchedEpisodeIds,
			counter,
			logger,
		);
	}
}

/**
 * Detect grabbed items from queue using SDK (fallback)
 * Note: Returns empty array on failure since the hunt searches were still triggered,
 * we just couldn't verify what was grabbed. The hunt result will still be accurate
 * for itemsSearched, just not for itemsGrabbed.
 */
async function detectGrabbedItemsFromQueueWithSdk(
	client: SonarrClient | RadarrClient,
	searchedMovieIds: number[],
	searchedSeriesIds: number[],
	searchedEpisodeIds: number[],
	counter: ApiCallCounter,
	logger: HuntLogger,
): Promise<GrabbedItem[]> {
	try {
		counter.count++;
		const queue = await client.queue.get({ pageSize: 1000 });
		const grabbedItems: GrabbedItem[] = [];

		for (const item of queue.records ?? []) {
			const itemAny = item as Record<string, unknown>;
			const isMatchingMovie =
				itemAny.movieId && searchedMovieIds.includes(itemAny.movieId as number);
			const isMatchingSeries =
				itemAny.seriesId && searchedSeriesIds.includes(itemAny.seriesId as number);
			const isMatchingEpisode =
				itemAny.episodeId && searchedEpisodeIds.includes(itemAny.episodeId as number);

			if (isMatchingMovie || isMatchingSeries || isMatchingEpisode) {
				const qualityObj = itemAny.quality as Record<string, unknown> | undefined;
				grabbedItems.push({
					title: itemAny.title as string,
					quality: (qualityObj?.quality as Record<string, unknown>)?.name as string | undefined,
					indexer: itemAny.indexer as string | undefined,
					size: itemAny.size as number | undefined,
				});
			}
		}

		return grabbedItems;
	} catch (error) {
		// Both history and queue detection failed - log as error since this is unexpected
		logger.error(
			{ err: error },
			"Grab detection failed completely (both history and queue methods) - grabbed items count will be inaccurate",
		);
		return [];
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
): Promise<HuntResultWithoutApiCount> {
	try {
		// First, get all series to have filter data available
		counter.count++;
		const allSeries = await client.series.getAll();
		const seriesMap = new Map(allSeries.map((s) => [s.id ?? 0, s]));

		// Get wanted episodes
		const fetchSize = Math.max(batchSize * 5, 50);

		// Calculate page offset based on recently searched items to rotate through large libraries
		// This prevents getting "stuck" when all items on page 1 have been searched
		const recentSearchCount = historyManager.getRecentSearchCount();
		let pageOffset = Math.floor(recentSearchCount / fetchSize) + 1;

		counter.count++;
		let wantedData =
			type === "missing"
				? await client.wanted.missing({
						page: pageOffset,
						pageSize: fetchSize,
						sortKey: "airDateUtc",
						sortDirection: "descending",
					})
				: await client.wanted.cutoff({
						page: pageOffset,
						pageSize: fetchSize,
						sortKey: "airDateUtc",
						sortDirection: "descending",
					});

		let records = wantedData.records ?? [];

		// If no records on calculated page and we're past page 1, wrap around to page 1
		// This handles the case where recentSearchCount exceeds total available items
		if (records.length === 0 && pageOffset > 1) {
			logger.debug(
				{ pageOffset, recentSearchCount, fetchSize },
				"No records on calculated page, wrapping to page 1",
			);
			pageOffset = 1;
			counter.count++;
			wantedData =
				type === "missing"
					? await client.wanted.missing({
							page: 1,
							pageSize: fetchSize,
							sortKey: "airDateUtc",
							sortDirection: "descending",
						})
					: await client.wanted.cutoff({
							page: 1,
							pageSize: fetchSize,
							sortKey: "airDateUtc",
							sortDirection: "descending",
						});
			records = wantedData.records ?? [];
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
				message: `No episodes match the current filters`,
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

		for (const [, episodes] of seasonGroups) {
			if (episodes.length >= SEASON_SEARCH_THRESHOLD) {
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

		// Calculate page offset based on recently searched items to rotate through large libraries
		// This prevents getting "stuck" when all items on page 1 have been searched
		const recentSearchCount = historyManager.getRecentSearchCount();
		let pageOffset = Math.floor(recentSearchCount / fetchSize) + 1;

		counter.count++;
		let wantedData =
			type === "missing"
				? await client.wanted.missing({
						page: pageOffset,
						pageSize: fetchSize,
						sortKey: "digitalRelease",
						sortDirection: "descending",
					})
				: await client.wanted.cutoff({
						page: pageOffset,
						pageSize: fetchSize,
						sortKey: "digitalRelease",
						sortDirection: "descending",
					});

		let movies = wantedData.records ?? [];

		// If no records on calculated page and we're past page 1, wrap around to page 1
		// This handles the case where recentSearchCount exceeds total available items
		if (movies.length === 0 && pageOffset > 1) {
			logger.debug(
				{ pageOffset, recentSearchCount, fetchSize },
				"No records on calculated page, wrapping to page 1",
			);
			pageOffset = 1;
			counter.count++;
			wantedData =
				type === "missing"
					? await client.wanted.missing({
							page: 1,
							pageSize: fetchSize,
							sortKey: "digitalRelease",
							sortDirection: "descending",
						})
					: await client.wanted.cutoff({
							page: 1,
							pageSize: fetchSize,
							sortKey: "digitalRelease",
							sortDirection: "descending",
						});
			movies = wantedData.records ?? [];
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
				message: `No movies match the current filters`,
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
