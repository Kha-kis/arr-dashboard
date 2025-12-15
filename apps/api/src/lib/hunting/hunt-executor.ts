import type { HuntConfig, ServiceInstance } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { createInstanceFetcher, type InstanceFetcher } from "../arr/arr-fetcher.js";
import { SEASON_SEARCH_THRESHOLD, SEARCH_DELAY_MS, GRAB_CHECK_DELAY_MS } from "./constants.js";
import { createSearchHistoryManager, type SearchHistoryManager, type SearchedItem } from "./search-history.js";

/**
 * Delay helper - waits for the specified milliseconds
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
	searchedItems: string[];  // Names of items we searched for
	grabbedItems: GrabbedItem[];  // Items that were actually grabbed/downloaded
	message: string;
	status: "completed" | "partial" | "skipped" | "error";
}

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
 * @returns A ParsedFilters object with parsed include/exclude tag and quality profile arrays, includeStatuses, expandedStatuses, year range, ageThresholdDays, filterLogic, and monitoredOnly flag
 */
function parseFilters(config: HuntConfig, service: "sonarr" | "radarr"): ParsedFilters {
	const parseJsonArray = (value: string | null | undefined): number[] | string[] => {
		if (!value) return [];
		try {
			return JSON.parse(value);
		} catch {
			return [];
		}
	};

	const includeStatuses = parseJsonArray(config.includeStatuses) as string[];

	return {
		filterLogic: (config.filterLogic as "AND" | "OR") || "AND",
		monitoredOnly: config.monitoredOnly ?? true,
		includeTags: parseJsonArray(config.includeTags) as number[],
		excludeTags: parseJsonArray(config.excludeTags) as number[],
		includeQualityProfiles: parseJsonArray(config.includeQualityProfiles) as number[],
		excludeQualityProfiles: parseJsonArray(config.excludeQualityProfiles) as number[],
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
	item: { tags: number[]; qualityProfileId: number; status: string; year: number; monitored: boolean; releaseDate?: string },
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
	item: { tags: number[]; qualityProfileId: number; status: string; year: number; monitored: boolean; releaseDate?: string },
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

	const includeResults = includeConditions.map((condition) => checkFilterCondition(item, filters, condition));

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

/**
 * Orchestrates a hunt run against a Sonarr or Radarr instance to search for missing content or quality upgrades.
 *
 * Performs queue threshold validation, parses and applies configured filters, avoids recently searched items,
 * executes service-specific search flows (season/episode searches for Sonarr, movie searches for Radarr),
 * records searches in history, and detects grabbed items after searches.
 *
 * @returns A HuntResult summarizing the hunt, including counts of searched and grabbed items, arrays of searched and grabbed item details, a human-readable message, and a status of `completed`, `partial`, `skipped`, or `error`.
 */
export async function executeHunt(
	app: FastifyInstance,
	instance: ServiceInstance,
	config: HuntConfig,
	type: "missing" | "upgrade",
): Promise<HuntResult> {
	const fetcher = createInstanceFetcher(app, instance);
	const service = instance.service.toLowerCase() as "sonarr" | "radarr";
	const filters = parseFilters(config, service);

	// Check queue threshold first
	const queueCheck = await checkQueueThreshold(fetcher, config.queueThreshold);
	if (!queueCheck.ok) {
		return {
			itemsSearched: 0,
			itemsGrabbed: 0,
			searchedItems: [],
			grabbedItems: [],
			message: queueCheck.message,
			status: "skipped",
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
		return executeSonarrHunt(fetcher, type, batchSize, filters, historyManager);
	}
	if (service === "radarr") {
		return executeRadarrHunt(fetcher, type, batchSize, filters, historyManager);
	}

	return {
		itemsSearched: 0,
		itemsGrabbed: 0,
		searchedItems: [],
		grabbedItems: [],
		message: `Unsupported service type: ${service}`,
		status: "error",
	};
}

/**
 * Determine whether the service instance's queue is below a configured threshold.
 *
 * If `threshold` is less than or equal to zero the check is treated as disabled and considered passing.
 *
 * @param threshold - The maximum allowed number of items in the instance queue; when the queue count is greater than or equal to this value the check fails
 * @returns An object with `ok` set to `true` when the queue is considered below the threshold (or the check is disabled or failed to be performed), `false` when the queue meets or exceeds the threshold, and a `message` describing the observed state
 */
async function checkQueueThreshold(
	fetcher: InstanceFetcher,
	threshold: number,
): Promise<{ ok: boolean; message: string }> {
	if (threshold <= 0) {
		return { ok: true, message: "Queue threshold check disabled" };
	}

	try {
		const response = await fetcher("/api/v3/queue?pageSize=1");
		const data = (await response.json()) as QueueResponse;
		const queueCount = data.totalRecords ?? 0;

		if (queueCount >= threshold) {
			return {
				ok: false,
				message: `Queue (${queueCount}) exceeds threshold (${threshold})`,
			};
		}

		return { ok: true, message: `Queue (${queueCount}) below threshold (${threshold})` };
	} catch (error) {
		// If we can't check the queue, proceed anyway
		console.warn("[HuntExecutor] Failed to check queue:", error);
		return { ok: true, message: "Queue check failed, proceeding anyway" };
	}
}

/**
 * Detects which of the recently searched items were grabbed by inspecting the service history.
 *
 * Queries the service history for "grabbed" events occurring after searchStartTime and returns matching grabbed items for any searched movie, series, or episode IDs; if history lookup fails, falls back to queue-based detection.
 *
 * @param fetcher - Function to call the instance API endpoints
 * @param searchStartTime - The earliest event time to consider when matching grabbed records
 * @param searchedMovieIds - Movie IDs that were searched during this run
 * @param searchedSeriesIds - Series IDs that were searched during this run
 * @param searchedEpisodeIds - Episode IDs that were searched during this run
 * @returns An array of GrabbedItem objects describing matched grabs (title, optional quality, indexer, and size)
 */
async function detectGrabbedItemsFromHistory(
	fetcher: InstanceFetcher,
	searchStartTime: Date,
	searchedMovieIds: number[],
	searchedSeriesIds: number[],
	searchedEpisodeIds: number[],
): Promise<GrabbedItem[]> {
	try {
		// Wait for grabs to appear in history
		// Even with history-based detection, we need a small delay for indexer responses
		// and Sonarr/Radarr to process and record the grab event
		await delay(GRAB_CHECK_DELAY_MS);

		// Query history for grabbed events
		// Sonarr/Radarr use numeric event types: 1 = Grabbed
		// We filter by date in-memory since API date filtering varies by version
		const response = await fetcher(
			"/api/v3/history?pageSize=100&sortKey=date&sortDirection=descending&eventType=1"
		);
		const data = (await response.json()) as HistoryResponse;
		const grabbedItems: GrabbedItem[] = [];

		for (const record of data.records ?? []) {
			// Skip events that happened before our searches started
			const eventDate = new Date(record.date);
			if (eventDate < searchStartTime) continue;

			// Check if this grab matches something we searched for
			const isMatchingMovie = record.movieId && searchedMovieIds.includes(record.movieId);
			const isMatchingSeries = record.seriesId && searchedSeriesIds.includes(record.seriesId);
			const isMatchingEpisode = record.episodeId && searchedEpisodeIds.includes(record.episodeId);

			if (isMatchingMovie || isMatchingSeries || isMatchingEpisode) {
				// Cast to unknown first, then to Record to access potential alternate field locations
				const anyRecord = record as unknown as Record<string, unknown>;
				const dataObj = (anyRecord.data ?? {}) as Record<string, unknown>;

				// Parse size - could be in data.size (string) or root size (number)
				let size: number | undefined;
				const sizeValue = dataObj.size ?? anyRecord.size;
				if (typeof sizeValue === "number") {
					size = sizeValue;
				} else if (typeof sizeValue === "string") {
					const parsed = Number.parseInt(sizeValue, 10);
					if (!Number.isNaN(parsed)) {
						size = parsed;
					}
				}

				// Extract quality - could be nested or flat
				let qualityName: string | undefined;
				if (record.quality?.quality?.name) {
					qualityName = record.quality.quality.name;
				} else if (typeof (anyRecord.quality as Record<string, unknown>)?.name === "string") {
					qualityName = (anyRecord.quality as Record<string, unknown>).name as string;
				}

				// Extract indexer - could be in data or root
				const indexer = (dataObj.indexer ?? anyRecord.indexer) as string | undefined;

				// Extract title - could be sourceTitle or in data
				const title = (record.sourceTitle ?? dataObj.releaseTitle ?? dataObj.title ?? "Unknown") as string;

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
		console.warn("[HuntExecutor] Failed to detect grabbed items from history:", error);
		// Fallback to queue-based detection if history fails
		return detectGrabbedItemsFromQueue(
			fetcher,
			searchedMovieIds,
			searchedSeriesIds,
			searchedEpisodeIds,
		);
	}
}

/**
 * Detect grabbed items by scanning the service queue for entries that match previously searched IDs.
 *
 * @param fetcher - Function used to call the instance API
 * @param searchedMovieIds - Movie IDs that were searched
 * @param searchedSeriesIds - Series IDs that were searched
 * @param searchedEpisodeIds - Episode IDs that were searched
 * @returns An array of `GrabbedItem` objects for queue entries that match the provided searched IDs
 */
async function detectGrabbedItemsFromQueue(
	fetcher: InstanceFetcher,
	searchedMovieIds: number[],
	searchedSeriesIds: number[],
	searchedEpisodeIds: number[],
): Promise<GrabbedItem[]> {
	try {
		const response = await fetcher("/api/v3/queue?pageSize=1000");
		const data = (await response.json()) as FullQueueResponse;
		const grabbedItems: GrabbedItem[] = [];

		for (const item of data.records ?? []) {
			// Check if this item matches something we searched for
			const isMatchingMovie = item.movieId && searchedMovieIds.includes(item.movieId);
			const isMatchingSeries = item.seriesId && searchedSeriesIds.includes(item.seriesId);
			const isMatchingEpisode = item.episodeId && searchedEpisodeIds.includes(item.episodeId);

			if (isMatchingMovie || isMatchingSeries || isMatchingEpisode) {
				grabbedItems.push({
					title: item.title,
					quality: item.quality?.quality?.name,
					indexer: item.indexer,
					size: item.size,
				});
			}
		}

		return grabbedItems;
	} catch (error) {
		console.warn("[HuntExecutor] Queue fallback also failed:", error);
		return [];
	}
}

/**
 * Orchestrates a Sonarr hunt: selects episodes to search based on filters and history, triggers season/episode searches, records the searches, and detects any resulting grabs.
 *
 * @param fetcher - Function to perform authenticated HTTP requests against the Sonarr instance.
 * @param type - Hunt type: `"missing"` searches wanted/missing episodes, `"upgrade"` searches wanted/cutoff episodes.
 * @param batchSize - Maximum number of episodes to search (season searches count as their episode totals toward this limit).
 * @param filters - Parsed filter criteria that determine which series/episodes are eligible for searching.
 * @param historyManager - Manager used to avoid recently searched items and to record new searches.
 * @returns A HuntResult summarizing the run, including counts of items searched and grabbed, lists of searched and grabbed items, a human-readable message, and a final status (`"completed" | "partial" | "skipped" | "error"`).
 */
async function executeSonarrHunt(
	fetcher: InstanceFetcher,
	type: "missing" | "upgrade",
	batchSize: number,
	filters: ParsedFilters,
	historyManager: SearchHistoryManager,
): Promise<HuntResult> {
	try {
		// First, get all series to have filter data available
		const seriesResponse = await fetcher("/api/v3/series");
		const allSeries = (await seriesResponse.json()) as SonarrSeries[];
		const seriesMap = new Map(allSeries.map((s) => [s.id, s]));

		// Get wanted episodes (fetch more than needed to account for filtering)
		const fetchSize = Math.max(batchSize * 5, 50);
		const endpoint = type === "missing" ? "/api/v3/wanted/missing" : "/api/v3/wanted/cutoff";
		const response = await fetcher(`${endpoint}?pageSize=${fetchSize}&sortKey=airDateUtc&sortDirection=descending`);
		const data = (await response.json()) as WantedResponse<SonarrEpisode>;

		if (!data.records || data.records.length === 0) {
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
		const filteredEpisodes = data.records.filter((ep) => {
			// Always skip future/unaired episodes first (cannot download what hasn't aired)
			if (!isContentReleased(ep.airDateUtc)) return false;

			// Get series data for filtering
			const series = seriesMap.get(ep.seriesId);
			if (!series) return false;

			// Apply filters based on series properties
			return passesFilters(
				{
					tags: series.tags,
					qualityProfileId: series.qualityProfileId,
					status: series.status,
					year: series.year,
					monitored: ep.monitored && series.monitored,
					releaseDate: ep.airDateUtc,
				},
				filters,
			);
		});

		// Randomize order to avoid always searching the same items
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

		// Group episodes by series + season to determine search strategy
		const seasonGroups = new Map<string, SonarrEpisode[]>();
		for (const ep of eligibleEpisodes) {
			const key = `${ep.seriesId}-${ep.seasonNumber}`;
			const group = seasonGroups.get(key) ?? [];
			group.push(ep);
			seasonGroups.set(key, group);
		}

		// Separate into season searches (3+ episodes) and individual episode searches
		// Also filter out recently searched items
		const seasonSearches: { seriesId: number; seasonNumber: number; episodeCount: number; title: string }[] = [];
		const individualEpisodes: SonarrEpisode[] = [];

		for (const [, episodes] of seasonGroups) {
			if (episodes.length >= SEASON_SEARCH_THRESHOLD) {
				// Use season search for this group - check if season was recently searched
				const firstEp = episodes[0];
				if (!firstEp) continue; // Should never happen since we checked length
				const series = seriesMap.get(firstEp.seriesId);
				const title = series?.title ?? "Unknown";

				const wasSearched = historyManager.wasRecentlySearched({
					mediaType: "season",
					mediaId: firstEp.seriesId,
					seasonNumber: firstEp.seasonNumber,
					title: `${title} S${String(firstEp.seasonNumber).padStart(2, "0")}`,
				});

				if (!wasSearched) {
					seasonSearches.push({
						seriesId: firstEp.seriesId,
						seasonNumber: firstEp.seasonNumber,
						episodeCount: episodes.length,
						title,
					});
				}
			} else {
				// Add to individual episode search - filter out recently searched episodes
				for (const ep of episodes) {
					const series = seriesMap.get(ep.seriesId);
					const wasSearched = historyManager.wasRecentlySearched({
						mediaType: "episode",
						mediaId: ep.id,
						title: `${series?.title ?? "Unknown"} S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`,
					});
					if (!wasSearched) {
						individualEpisodes.push(ep);
					}
				}
			}
		}

		// Check if everything was filtered due to recent searches
		if (seasonSearches.length === 0 && individualEpisodes.length === 0) {
			const skippedCount = historyManager.getFilteredCount();
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: skippedCount > 0
					? `All ${skippedCount} eligible items were recently searched`
					: "No episodes match the current filters",
				status: "completed",
			};
		}

		// Record search start time for history-based grab detection
		const searchStartTime = new Date();

		// Apply batch size limit across both search types
		// Count each season search as equivalent to its episode count for fair batching
		let remainingBudget = batchSize;
		const seasonSearchesToExecute: typeof seasonSearches = [];
		const episodesToSearch: SonarrEpisode[] = [];
		const searchedItemNames: string[] = [];
		const searchedHistoryItems: SearchedItem[] = [];
		// Track IDs for grab detection
		const searchedSeriesIds: number[] = [];
		const searchedEpisodeIds: number[] = [];

		// Prioritize season searches (more efficient for finding season packs)
		for (const seasonSearch of seasonSearches) {
			if (remainingBudget <= 0) break;
			seasonSearchesToExecute.push(seasonSearch);
			remainingBudget -= seasonSearch.episodeCount;
			searchedItemNames.push(`${seasonSearch.title} Season ${seasonSearch.seasonNumber} (${seasonSearch.episodeCount} episodes)`);
			// Track for grab detection
			searchedSeriesIds.push(seasonSearch.seriesId);
			// Track for history
			searchedHistoryItems.push({
				mediaType: "season",
				mediaId: seasonSearch.seriesId,
				seasonNumber: seasonSearch.seasonNumber,
				title: `${seasonSearch.title} S${String(seasonSearch.seasonNumber).padStart(2, "0")}`,
			});
		}

		// Then add individual episodes
		for (const ep of individualEpisodes) {
			if (remainingBudget <= 0) break;
			episodesToSearch.push(ep);
			remainingBudget--;
			const series = seriesMap.get(ep.seriesId);
			const title = series?.title ?? "Unknown";
			searchedItemNames.push(`${title} S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`);
			// Track for grab detection
			searchedSeriesIds.push(ep.seriesId);
			searchedEpisodeIds.push(ep.id);
			// Track for history
			searchedHistoryItems.push({
				mediaType: "episode",
				mediaId: ep.id,
				title: `${title} S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`,
			});
		}

		// Execute season searches with delay between each
		let searchErrors = 0;
		const totalSearches = seasonSearchesToExecute.length + episodesToSearch.length;
		let searchIndex = 0;

		for (let i = 0; i < seasonSearchesToExecute.length; i++) {
			const seasonSearch = seasonSearchesToExecute[i];
			if (!seasonSearch) continue;
			const { seriesId, seasonNumber, title } = seasonSearch;
			searchIndex++;

			// Add delay before search (except for the first one)
			if (i > 0) {
				await delay(SEARCH_DELAY_MS);
			}

			try {
				await fetcher("/api/v3/command", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: "SeasonSearch",
						seriesId,
						seasonNumber,
					}),
				});
			} catch (error) {
				searchErrors++;
				console.error(`[HuntExecutor] Failed to search for "${title} S${seasonNumber}":`, error instanceof Error ? error.message : error);
			}
		}

		// Execute episode searches individually with delay between each
		// This prevents overwhelming indexers with simultaneous requests
		for (let i = 0; i < episodesToSearch.length; i++) {
			const ep = episodesToSearch[i];
			if (!ep) continue;
			const series = seriesMap.get(ep.seriesId);
			const epTitle = `${series?.title ?? "Unknown"} S${String(ep.seasonNumber).padStart(2, "0")}E${String(ep.episodeNumber).padStart(2, "0")}`;
			searchIndex++;

			// Add delay before search (and after any season searches)
			if (i > 0 || seasonSearchesToExecute.length > 0) {
				await delay(SEARCH_DELAY_MS);
			}

			try {
				await fetcher("/api/v3/command", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: "EpisodeSearch",
						episodeIds: [ep.id],
					}),
				});
			} catch (error) {
				searchErrors++;
				console.error(`[HuntExecutor] Failed to search for "${epTitle}":`, error instanceof Error ? error.message : error);
			}
		}

		// Record the searches in history
		await historyManager.recordSearches(searchedHistoryItems);

		// Detect what was actually grabbed using history API (more reliable)
		const grabbedItems = await detectGrabbedItemsFromHistory(
			fetcher,
			searchStartTime,
			[], // No movie IDs for Sonarr
			[...new Set(searchedSeriesIds)], // Dedupe series IDs
			searchedEpisodeIds,
		);

		const totalSearched = seasonSearchesToExecute.reduce((sum, s) => sum + s.episodeCount, 0) + episodesToSearch.length;
		const searchSummary = [];
		if (seasonSearchesToExecute.length > 0) {
			searchSummary.push(`${seasonSearchesToExecute.length} season(s)`);
		}
		if (episodesToSearch.length > 0) {
			searchSummary.push(`${episodesToSearch.length} episode(s)`);
		}

		const grabSummary = grabbedItems.length > 0
			? ` - ${grabbedItems.length} grabbed`
			: "";
		const errorSummary = searchErrors > 0
			? ` (${searchErrors} search errors)`
			: "";

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
 * Run a hunt on a Radarr instance to trigger searches for missing or upgradeable movies.
 *
 * Applies configured filters, skips recently searched movies, triggers up to `batchSize`
 * MoviesSearch commands (throttled with delays), records the searches in history, and
 * detects what was actually grabbed via Radarr history.
 *
 * @param fetcher - Function used to call the Radarr HTTP API for this instance
 * @param type - Hunt type: `"missing"` to search for missing movies, `"upgrade"` to search for movies below quality cutoff
 * @param batchSize - Maximum number of movies to trigger searches for in this run
 * @param filters - Parsed filter set to apply to candidate movies
 * @param historyManager - Manager used to filter recently searched items and record new searches
 * @returns A HuntResult summarizing items searched and grabbed, the searched titles and grabbed item details, a human-readable message, and a status (`"completed"`, `"partial"`, or `"error"`)
 */
async function executeRadarrHunt(
	fetcher: InstanceFetcher,
	type: "missing" | "upgrade",
	batchSize: number,
	filters: ParsedFilters,
	historyManager: SearchHistoryManager,
): Promise<HuntResult> {
	try {
		let movies: RadarrMovie[] = [];

		// Fetch more than needed to account for filtering
		const fetchSize = Math.max(batchSize * 5, 50);

		if (type === "missing") {
			// Use wanted/missing endpoint - returns monitored movies without files
			// Same data as shown on /wanted/missing page in Radarr UI
			const response = await fetcher(`/api/v3/wanted/missing?pageSize=${fetchSize}&sortKey=digitalRelease&sortDirection=descending`);
			const data = (await response.json()) as WantedResponse<RadarrMovie>;
			movies = data.records ?? [];
		} else {
			// For upgrades, use wanted/cutoff endpoint - returns movies that don't meet quality cutoff
			const response = await fetcher(`/api/v3/wanted/cutoff?pageSize=${fetchSize}&sortKey=digitalRelease&sortDirection=descending`);
			const data = (await response.json()) as WantedResponse<RadarrMovie>;
			movies = data.records ?? [];
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

		// Apply all filters
		const filteredMovies = movies.filter((movie) => {
			// Determine release date - prefer digital > physical > theatrical
			const releaseDate = movie.digitalRelease || movie.physicalRelease || movie.inCinemas;

			// Always skip unreleased movies first (cannot download what hasn't released)
			if (!isContentReleased(releaseDate)) return false;

			// Apply filters
			return passesFilters(
				{
					tags: movie.tags,
					qualityProfileId: movie.qualityProfileId,
					status: movie.status,
					year: movie.year,
					monitored: movie.monitored,
					releaseDate,
				},
				filters,
			);
		});

		// Randomize order to avoid always searching the same items
		const eligibleMovies = shuffleArray(filteredMovies);

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

		// Filter out recently searched movies
		const notRecentlySearched = historyManager.filterRecentlySearched(
			eligibleMovies,
			(movie) => ({
				mediaType: "movie",
				mediaId: movie.id,
				title: `${movie.title} (${movie.year ?? "?"})`,
			}),
		);

		if (notRecentlySearched.length === 0) {
			const skippedCount = historyManager.getFilteredCount();
			return {
				itemsSearched: 0,
				itemsGrabbed: 0,
				searchedItems: [],
				grabbedItems: [],
				message: skippedCount > 0
					? `All ${skippedCount} eligible movies were recently searched`
					: "No movies match the current filters",
				status: "completed",
			};
		}

		// Record search start time for history-based grab detection
		const searchStartTime = new Date();

		// Trigger search for eligible movies with delay between each
		// This prevents overwhelming indexers with simultaneous requests
		const moviesToSearch = notRecentlySearched.slice(0, batchSize);
		const searchedItemNames = moviesToSearch.map((m) => `${m.title} (${m.year ?? "?"})`);
		const searchedMovieIds = moviesToSearch.map((m) => m.id);

		let searchErrors = 0;
		for (let i = 0; i < moviesToSearch.length; i++) {
			const movie = moviesToSearch[i];
			if (!movie) continue;

			// Add delay before search (except for the first one)
			if (i > 0) {
				await delay(SEARCH_DELAY_MS);
			}

			try {
				await fetcher("/api/v3/command", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						name: "MoviesSearch",
						movieIds: [movie.id],
					}),
				});
			} catch (error) {
				// Log error but continue with remaining searches
				searchErrors++;
				console.error(`[HuntExecutor] Failed to search for "${movie.title}":`, error instanceof Error ? error.message : error);
			}
		}

		// Record the searches in history
		await historyManager.recordSearches(
			moviesToSearch.map((m) => ({
				mediaType: "movie" as const,
				mediaId: m.id,
				title: `${m.title} (${m.year ?? "?"})`,
			})),
		);

		// Detect what was actually grabbed using history API (more reliable)
		const grabbedItems = await detectGrabbedItemsFromHistory(
			fetcher,
			searchStartTime,
			searchedMovieIds,
			[], // No series IDs for Radarr
			[], // No episode IDs for Radarr
		);

		const grabSummary = grabbedItems.length > 0
			? ` - ${grabbedItems.length} grabbed`
			: "";
		const errorSummary = searchErrors > 0
			? ` (${searchErrors} search errors)`
			: "";

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