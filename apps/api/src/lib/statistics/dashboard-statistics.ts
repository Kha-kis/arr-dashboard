import {
	type ProwlarrIndexerStat,
	type ProwlarrStatistics,
	type RadarrStatistics,
	type SonarrStatistics,
	type LidarrStatistics,
	type ReadarrStatistics,
	prowlarrIndexerStatSchema,
	prowlarrStatisticsSchema,
	radarrStatisticsSchema,
	sonarrStatisticsSchema,
	lidarrStatisticsSchema,
	readarrStatisticsSchema,
} from "@arr/shared";
import type { SonarrClient } from "arr-sdk/sonarr";
import type { RadarrClient } from "arr-sdk/radarr";
import type { ProwlarrClient } from "arr-sdk/prowlarr";
import type { LidarrClient } from "arr-sdk/lidarr";
import type { ReadarrClient } from "arr-sdk/readarr";

/**
 * Interface for API response from cutoff/wanted endpoints
 */
interface CutoffUnmetResponse {
	totalRecords?: unknown;
}

/**
 * Interface for series statistics from Sonarr API
 */
interface SeriesStatistics {
	totalEpisodeCount?: unknown;
	episodeCount?: unknown;
	episodeFileCount?: unknown;
	sizeOnDisk?: unknown;
}

/**
 * Interface for movie statistics from Radarr API (reuses similar fields)
 */
interface _MovieStatistics {
	sizeOnDisk?: unknown;
}

/**
 * Interface for disk space entries
 */
interface DiskSpaceEntry {
	totalSpace?: unknown;
	freeSpace?: unknown;
}

/**
 * Interface for health check entries
 */
interface HealthEntry {
	type?: unknown;
}

/**
 * Interface for history pagination response
 */
interface _HistoryResponse {
	records?: unknown;
	totalRecords?: unknown;
}

/**
 * Interface for indexer entries
 */
interface IndexerEntry {
	enable?: unknown;
}

/**
 * Interface for Prowlarr indexer stats response from /api/v1/indexerstats
 */
interface IndexerStatsResponse {
	indexers?: IndexerStatEntry[];
	userAgents?: unknown[];
	hosts?: unknown[];
}

/**
 * Interface for individual indexer statistics from Prowlarr
 */
interface IndexerStatEntry {
	indexerId?: unknown;
	indexerName?: unknown;
	averageResponseTime?: unknown;
	averageGrabResponseTime?: unknown;
	numberOfQueries?: unknown;
	numberOfRssQueries?: unknown;
	numberOfAuthQueries?: unknown;
	numberOfGrabs?: unknown;
	numberOfFailedQueries?: unknown;
	numberOfFailedGrabs?: unknown;
	numberOfFailedRssQueries?: unknown;
	numberOfFailedAuthQueries?: unknown;
}

const _sumNumbers = (values: Array<number | undefined>): number => {
	let total = 0;
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) {
			total += value;
		}
	}
	return total;
};

const clampPercentage = (value: number): number => {
	if (!Number.isFinite(value)) {
		return 0;
	}
	if (value < 0) {
		return 0;
	}
	if (value > 100) {
		return 100;
	}
	return value;
};

const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
};

const toStringValue = (value: unknown): string | undefined => {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return value.toString();
	}
	return undefined;
};

const safeRequestJson = async <T>(
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	path: string,
	init?: RequestInit,
): Promise<T | undefined> => {
	try {
		const response = await fetcher(path, init);
		return (await response.json()) as T;
	} catch (_error) {
		return undefined;
	}
};

export const emptySonarrStatistics: SonarrStatistics = sonarrStatisticsSchema.parse({
	totalSeries: 0,
	monitoredSeries: 0,
	continuingSeries: 0,
	endedSeries: 0,
	totalEpisodes: 0,
	episodeFileCount: 0,
	downloadedEpisodes: 0,
	missingEpisodes: 0,
	downloadedPercentage: 0,
	cutoffUnmetCount: 0,
	qualityBreakdown: {},
	tagBreakdown: {},
	recentlyAdded7Days: 0,
	recentlyAdded30Days: 0,
	averageEpisodeSize: 0,
	diskTotal: 0,
	diskFree: 0,
	diskUsed: 0,
	diskUsagePercent: 0,
	healthIssues: 0,
	healthIssuesList: [],
});

export const emptyRadarrStatistics: RadarrStatistics = radarrStatisticsSchema.parse({
	totalMovies: 0,
	monitoredMovies: 0,
	downloadedMovies: 0,
	missingMovies: 0,
	downloadedPercentage: 0,
	cutoffUnmetCount: 0,
	qualityBreakdown: {},
	tagBreakdown: {},
	recentlyAdded7Days: 0,
	recentlyAdded30Days: 0,
	totalRuntime: 0,
	averageMovieSize: 0,
	diskTotal: 0,
	diskFree: 0,
	diskUsed: 0,
	diskUsagePercent: 0,
	healthIssues: 0,
	healthIssuesList: [],
});

export const emptyProwlarrStatistics: ProwlarrStatistics = prowlarrStatisticsSchema.parse({
	totalIndexers: 0,
	activeIndexers: 0,
	pausedIndexers: 0,
	totalQueries: 0,
	totalGrabs: 0,
	successfulQueries: 0,
	failedQueries: 0,
	successfulGrabs: 0,
	failedGrabs: 0,
	grabRate: 0,
	averageResponseTime: undefined,
	healthIssues: 0,
	healthIssuesList: [],
	indexers: [],
});

export const emptyLidarrStatistics: LidarrStatistics = lidarrStatisticsSchema.parse({
	totalArtists: 0,
	monitoredArtists: 0,
	totalAlbums: 0,
	monitoredAlbums: 0,
	totalTracks: 0,
	downloadedTracks: 0,
	missingTracks: 0,
	downloadedPercentage: 0,
	cutoffUnmetCount: 0,
	qualityBreakdown: {},
	tagBreakdown: {},
	recentlyAdded7Days: 0,
	recentlyAdded30Days: 0,
	averageTrackSize: 0,
	diskTotal: 0,
	diskFree: 0,
	diskUsed: 0,
	diskUsagePercent: 0,
	healthIssues: 0,
	healthIssuesList: [],
});

export const emptyReadarrStatistics: ReadarrStatistics = readarrStatisticsSchema.parse({
	totalAuthors: 0,
	monitoredAuthors: 0,
	totalBooks: 0,
	monitoredBooks: 0,
	downloadedBooks: 0,
	missingBooks: 0,
	downloadedPercentage: 0,
	cutoffUnmetCount: 0,
	qualityBreakdown: {},
	tagBreakdown: {},
	recentlyAdded7Days: 0,
	recentlyAdded30Days: 0,
	averageBookSize: 0,
	diskTotal: 0,
	diskFree: 0,
	diskUsed: 0,
	diskUsagePercent: 0,
	healthIssues: 0,
	healthIssuesList: [],
});

export const fetchSonarrStatistics = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<SonarrStatistics> => {
	// Fetch all API endpoints in parallel for better performance
	const [series, diskspace, health, cutoffUnmet, qualityProfiles, tags] = await Promise.all([
		safeRequestJson<unknown[]>(fetcher, "/api/v3/series").then((r) => r ?? []),
		safeRequestJson<unknown[]>(fetcher, "/api/v3/diskspace").then((r) => r ?? []),
		safeRequestJson<unknown[]>(fetcher, "/api/v3/health").then((r) => r ?? []),
		safeRequestJson<CutoffUnmetResponse>(fetcher, "/api/v3/wanted/cutoff?page=1&pageSize=1").then(
			(r) => r ?? {},
		),
		safeRequestJson<unknown[]>(fetcher, "/api/v3/qualityprofile").then((r) => r ?? []),
		safeRequestJson<unknown[]>(fetcher, "/api/v3/tag").then((r) => r ?? []),
	]);

	// Build a map of profile ID to profile name
	const profileIdToName = new Map<number, string>();
	for (const profile of qualityProfiles) {
		if (profile && typeof profile === "object") {
			const profileId = toNumber((profile as { id?: unknown }).id);
			const profileName = toStringValue((profile as { name?: unknown }).name);

			if (profileId !== undefined && profileName) {
				profileIdToName.set(profileId, profileName);
			}
		}
	}

	// Build a map of tag ID to tag label
	const tagIdToLabel = new Map<number, string>();
	for (const tag of tags) {
		if (tag && typeof tag === "object") {
			const tagId = toNumber((tag as { id?: unknown }).id);
			const tagLabel = toStringValue((tag as { label?: unknown }).label);

			if (tagId !== undefined && tagLabel) {
				tagIdToLabel.set(tagId, tagLabel);
			}
		}
	}

	// Calculate time thresholds for recently added
	const now = Date.now();
	const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	let totalSeries = 0;
	let monitoredSeries = 0;
	let continuingSeries = 0;
	let endedSeries = 0;
	let totalEpisodes = 0;
	let episodeFileCount = 0;
	let downloadedEpisodes = 0;
	let missingEpisodes = 0;
	let totalFileSize = 0;
	let recentlyAdded7Days = 0;
	let recentlyAdded30Days = 0;

	// Track quality distribution based on quality profiles
	const qualityBreakdown: Record<string, number> = {};
	// Track tag distribution
	const tagBreakdown: Record<string, number> = {};

	for (const entry of series) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		totalSeries += 1;
		if ((entry as { monitored?: unknown }).monitored !== false) {
			monitoredSeries += 1;
		}

		const status = toStringValue((entry as { status?: unknown }).status);
		if (status === "continuing") {
			continuingSeries += 1;
		} else if (status === "ended") {
			endedSeries += 1;
		}

		// Check added date for recently added
		const addedStr = toStringValue((entry as { added?: unknown }).added);
		if (addedStr) {
			const addedTime = new Date(addedStr).getTime();
			if (!Number.isNaN(addedTime)) {
				if (addedTime >= sevenDaysAgo) {
					recentlyAdded7Days += 1;
				}
				if (addedTime >= thirtyDaysAgo) {
					recentlyAdded30Days += 1;
				}
			}
		}

		// Process tags
		const entryTags = (entry as { tags?: unknown[] }).tags;
		if (Array.isArray(entryTags)) {
			for (const tagId of entryTags) {
				const tagIdNum = toNumber(tagId);
				if (tagIdNum !== undefined && tagIdToLabel.has(tagIdNum)) {
					const tagLabel = tagIdToLabel.get(tagIdNum);
					if (tagLabel !== undefined) {
						tagBreakdown[tagLabel] = (tagBreakdown[tagLabel] ?? 0) + 1;
					}
				}
			}
		}

		const stats: SeriesStatistics = ((entry as { statistics?: unknown }).statistics ??
			{}) as SeriesStatistics;
		const episodesTotal = toNumber(stats.totalEpisodeCount ?? stats.episodeCount) ?? 0;
		const episodesWithFile = toNumber(stats.episodeFileCount) ?? 0;
		const sizeOnDisk = toNumber(stats.sizeOnDisk) ?? 0;

		totalEpisodes += episodesTotal;
		episodeFileCount += episodesWithFile;
		downloadedEpisodes += episodesWithFile;
		missingEpisodes += Math.max(0, episodesTotal - episodesWithFile);
		totalFileSize += sizeOnDisk;

		// Count episodes by quality profile (for series with files)
		if (episodesWithFile > 0) {
			const qualityProfileId = toNumber((entry as { qualityProfileId?: unknown }).qualityProfileId);

			// Look up the profile name
			if (qualityProfileId !== undefined && profileIdToName.has(qualityProfileId)) {
				const profileName = profileIdToName.get(qualityProfileId);
				if (profileName !== undefined) {
					qualityBreakdown[profileName] = (qualityBreakdown[profileName] ?? 0) + episodesWithFile;
				}
			} else {
				qualityBreakdown.Unknown = (qualityBreakdown.Unknown ?? 0) + episodesWithFile;
			}
		}
	}

	const cutoffUnmetCount = toNumber(cutoffUnmet?.totalRecords) ?? 0;
	const averageEpisodeSize =
		downloadedEpisodes > 0 ? totalFileSize / downloadedEpisodes : undefined;

	const diskTotals = diskspace.reduce(
		(acc: { total: number; free: number }, entry: unknown) => {
			const diskEntry = entry as DiskSpaceEntry;
			acc.total += toNumber(diskEntry?.totalSpace) ?? 0;
			acc.free += toNumber(diskEntry?.freeSpace) ?? 0;
			return acc;
		},
		{ total: 0, free: 0 },
	);

	const diskUsed = Math.max(0, diskTotals.total - diskTotals.free);
	const diskUsagePercent =
		diskTotals.total > 0 ? clampPercentage((diskUsed / diskTotals.total) * 100) : 0;

	const healthIssuesList = Array.isArray(health)
		? health
				.filter((item) => {
					const healthItem = item as HealthEntry;
					const type = toStringValue(healthItem?.type);
					return type === "error" || type === "warning";
				})
				.map((item) => {
					const healthItem = item as Record<string, unknown>;
					const type = toStringValue(healthItem?.type) as "error" | "warning";
					const message = toStringValue(healthItem?.message) ?? "Unknown health issue";
					const source = toStringValue(healthItem?.source);
					const wikiUrl = toStringValue(healthItem?.wikiUrl);
					return {
						type,
						message,
						source,
						wikiUrl,
						instanceId,
						instanceName,
						instanceBaseUrl,
						service: "sonarr" as const,
					};
				})
		: [];
	const healthIssues = healthIssuesList.length;

	return sonarrStatisticsSchema.parse({
		totalSeries,
		monitoredSeries,
		continuingSeries,
		endedSeries,
		totalEpisodes,
		episodeFileCount,
		downloadedEpisodes,
		missingEpisodes,
		downloadedPercentage:
			totalEpisodes > 0 ? clampPercentage((downloadedEpisodes / totalEpisodes) * 100) : 0,
		cutoffUnmetCount,
		qualityBreakdown,
		tagBreakdown,
		recentlyAdded7Days,
		recentlyAdded30Days,
		averageEpisodeSize,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskUsed || undefined,
		diskUsagePercent,
		healthIssues,
		healthIssuesList,
	});
};

export const fetchRadarrStatistics = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<RadarrStatistics> => {
	// Fetch all API endpoints in parallel for better performance
	const [movies, diskspace, health, cutoffUnmet, qualityProfiles, tags] = await Promise.all([
		safeRequestJson<unknown[]>(fetcher, "/api/v3/movie").then((r) => r ?? []),
		safeRequestJson<unknown[]>(fetcher, "/api/v3/diskspace").then((r) => r ?? []),
		safeRequestJson<unknown[]>(fetcher, "/api/v3/health").then((r) => r ?? []),
		safeRequestJson<CutoffUnmetResponse>(fetcher, "/api/v3/wanted/cutoff?page=1&pageSize=1").then(
			(r) => r ?? {},
		),
		safeRequestJson<unknown[]>(fetcher, "/api/v3/qualityprofile").then((r) => r ?? []),
		safeRequestJson<unknown[]>(fetcher, "/api/v3/tag").then((r) => r ?? []),
	]);

	// Build a map of profile ID to profile name
	const profileIdToName = new Map<number, string>();
	for (const profile of qualityProfiles) {
		if (profile && typeof profile === "object") {
			const profileId = toNumber((profile as { id?: unknown }).id);
			const profileName = toStringValue((profile as { name?: unknown }).name);

			if (profileId !== undefined && profileName) {
				profileIdToName.set(profileId, profileName);
			}
		}
	}

	// Build tag ID to label map
	const tagIdToLabel = new Map<number, string>();
	for (const tag of tags) {
		if (tag && typeof tag === "object") {
			const tagId = toNumber((tag as { id?: unknown }).id);
			const tagLabel = toStringValue((tag as { label?: unknown }).label);
			if (tagId !== undefined && tagLabel) {
				tagIdToLabel.set(tagId, tagLabel);
			}
		}
	}

	// Calculate time thresholds for recently added
	const now = Date.now();
	const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	let monitoredMovies = 0;
	let downloadedMovies = 0;
	let totalFileSize = 0;
	let recentlyAdded7Days = 0;
	let recentlyAdded30Days = 0;
	let totalRuntime = 0;

	const qualityBreakdown: Record<string, number> = {};
	const tagBreakdown: Record<string, number> = {};

	for (const movie of movies) {
		if (!movie || typeof movie !== "object") {
			continue;
		}

		// Check added date for recently added counts
		const addedStr = toStringValue((movie as { added?: unknown }).added);
		if (addedStr) {
			const addedTime = new Date(addedStr).getTime();
			if (!Number.isNaN(addedTime)) {
				if (addedTime >= sevenDaysAgo) {
					recentlyAdded7Days += 1;
				}
				if (addedTime >= thirtyDaysAgo) {
					recentlyAdded30Days += 1;
				}
			}
		}

		// Process tags for tag breakdown
		const movieTags = (movie as { tags?: unknown[] }).tags;
		if (Array.isArray(movieTags)) {
			for (const tagId of movieTags) {
				const numericTagId = toNumber(tagId);
				if (numericTagId !== undefined && tagIdToLabel.has(numericTagId)) {
					const tagLabel = tagIdToLabel.get(numericTagId);
					if (tagLabel) {
						tagBreakdown[tagLabel] = (tagBreakdown[tagLabel] ?? 0) + 1;
					}
				}
			}
		}

		// Accumulate total runtime (in minutes)
		const runtime = toNumber((movie as { runtime?: unknown }).runtime);
		if (runtime !== undefined && runtime > 0) {
			totalRuntime += runtime;
		}

		if ((movie as { monitored?: unknown }).monitored !== false) {
			monitoredMovies += 1;
		}
		if ((movie as { hasFile?: unknown }).hasFile) {
			downloadedMovies += 1;

			const sizeOnDisk = toNumber((movie as { sizeOnDisk?: unknown }).sizeOnDisk) ?? 0;
			totalFileSize += sizeOnDisk;

			// Use quality profile to categorize
			const qualityProfileId = toNumber((movie as { qualityProfileId?: unknown }).qualityProfileId);

			// Look up the profile name
			if (qualityProfileId !== undefined && profileIdToName.has(qualityProfileId)) {
				const profileName = profileIdToName.get(qualityProfileId);
				if (profileName !== undefined) {
					qualityBreakdown[profileName] = (qualityBreakdown[profileName] ?? 0) + 1;
				}
			} else {
				qualityBreakdown.Unknown = (qualityBreakdown.Unknown ?? 0) + 1;
			}
		}
	}

	const totalMovies = movies.length;
	const missingMovies = Math.max(0, monitoredMovies - downloadedMovies);
	const cutoffUnmetCount = toNumber(cutoffUnmet?.totalRecords) ?? 0;
	const averageMovieSize = downloadedMovies > 0 ? totalFileSize / downloadedMovies : undefined;

	const diskTotals = diskspace.reduce(
		(acc: { total: number; free: number }, entry: unknown) => {
			const diskEntry = entry as DiskSpaceEntry;
			acc.total += toNumber(diskEntry?.totalSpace) ?? 0;
			acc.free += toNumber(diskEntry?.freeSpace) ?? 0;
			return acc;
		},
		{ total: 0, free: 0 },
	);

	const diskUsed = Math.max(0, diskTotals.total - diskTotals.free);
	const diskUsagePercent =
		diskTotals.total > 0 ? clampPercentage((diskUsed / diskTotals.total) * 100) : 0;

	const healthIssuesList = Array.isArray(health)
		? health
				.filter((item) => {
					const healthItem = item as HealthEntry;
					const type = toStringValue(healthItem?.type);
					return type === "error" || type === "warning";
				})
				.map((item) => {
					const healthItem = item as Record<string, unknown>;
					const type = toStringValue(healthItem?.type) as "error" | "warning";
					const message = toStringValue(healthItem?.message) ?? "Unknown health issue";
					const source = toStringValue(healthItem?.source);
					const wikiUrl = toStringValue(healthItem?.wikiUrl);
					return {
						type,
						message,
						source,
						wikiUrl,
						instanceId,
						instanceName,
						instanceBaseUrl,
						service: "radarr" as const,
					};
				})
		: [];
	const healthIssues = healthIssuesList.length;

	return radarrStatisticsSchema.parse({
		totalMovies,
		monitoredMovies,
		downloadedMovies,
		missingMovies,
		downloadedPercentage:
			monitoredMovies > 0 ? clampPercentage((downloadedMovies / monitoredMovies) * 100) : 0,
		cutoffUnmetCount,
		qualityBreakdown,
		tagBreakdown,
		recentlyAdded7Days,
		recentlyAdded30Days,
		totalRuntime: totalRuntime > 0 ? totalRuntime : undefined,
		averageMovieSize,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskUsed || undefined,
		diskUsagePercent,
		healthIssues,
		healthIssuesList,
	});
};

export const fetchProwlarrStatistics = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<ProwlarrStatistics> => {
	const indexers = (await safeRequestJson<unknown[]>(fetcher, "/api/v1/indexer")) ?? [];
	const health = (await safeRequestJson<unknown[]>(fetcher, "/api/v1/health")) ?? [];

	// Use the dedicated indexerstats endpoint for accurate statistics
	// This matches what Prowlarr's own Statistics page uses
	const indexerStats: IndexerStatsResponse =
		(await safeRequestJson<IndexerStatsResponse>(fetcher, "/api/v1/indexerstats")) ?? {};

	const totalIndexers = indexers.length;
	const activeIndexers = indexers.filter((entry) => {
		const indexerEntry = entry as IndexerEntry;
		return entry && indexerEntry.enable !== false;
	}).length;
	const pausedIndexers = totalIndexers - activeIndexers;

	// Process indexer statistics from the dedicated endpoint
	const statsEntries = Array.isArray(indexerStats.indexers) ? indexerStats.indexers : [];

	// Aggregate totals from all indexers
	let totalQueries = 0;
	let totalGrabs = 0;
	let successfulQueries = 0;
	let failedQueries = 0;
	let successfulGrabs = 0;
	let failedGrabs = 0;
	let totalResponseTime = 0;
	let responseTimeCount = 0;

	const normalizedStats: ProwlarrIndexerStat[] = [];

	for (const entry of statsEntries) {
		if (!entry || typeof entry !== "object") {
			continue;
		}

		const name = toStringValue(entry.indexerName) ?? "Unknown";

		// Get query counts (numberOfQueries excludes RSS and Auth which are tracked separately)
		const queries = toNumber(entry.numberOfQueries) ?? 0;
		const grabs = toNumber(entry.numberOfGrabs) ?? 0;
		const failed = toNumber(entry.numberOfFailedQueries) ?? 0;
		const failedGrabCount = toNumber(entry.numberOfFailedGrabs) ?? 0;
		const avgResponseTime = toNumber(entry.averageResponseTime);

		// Aggregate totals
		totalQueries += queries;
		totalGrabs += grabs;
		failedQueries += failed;
		failedGrabs += failedGrabCount;

		// Successful = total - failed
		const successfulQueryCount = Math.max(0, queries - failed);
		const successfulGrabCount = Math.max(0, grabs - failedGrabCount);
		successfulQueries += successfulQueryCount;
		successfulGrabs += successfulGrabCount;

		// Track response times for average calculation
		if (avgResponseTime !== undefined && avgResponseTime > 0) {
			totalResponseTime += avgResponseTime;
			responseTimeCount += 1;
		}

		// Calculate success rate based on queries
		const totalAttempts = queries + grabs;
		const totalSuccessful = successfulQueryCount + successfulGrabCount;
		const successRate =
			totalAttempts > 0 ? clampPercentage((totalSuccessful / totalAttempts) * 100) : 100;

		// Only include indexers with activity
		if (queries > 0 || grabs > 0) {
			normalizedStats.push(
				prowlarrIndexerStatSchema.parse({
					name,
					queries,
					grabs,
					successRate,
				}),
			);
		}
	}

	// Calculate grab rate (grabs / queries)
	const grabRate = totalQueries > 0 ? clampPercentage((totalGrabs / totalQueries) * 100) : 0;

	// Calculate average response time across all indexers
	const averageResponseTime =
		responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : undefined;

	// Process health issues
	const healthIssuesList = Array.isArray(health)
		? health
				.filter((item) => {
					const healthItem = item as HealthEntry;
					const type = toStringValue(healthItem?.type);
					return type === "error" || type === "warning";
				})
				.map((item) => {
					const healthItem = item as Record<string, unknown>;
					const type = toStringValue(healthItem?.type) as "error" | "warning";
					const message = toStringValue(healthItem?.message) ?? "Unknown health issue";
					const source = toStringValue(healthItem?.source);
					const wikiUrl = toStringValue(healthItem?.wikiUrl);
					return {
						type,
						message,
						source,
						wikiUrl,
						instanceId,
						instanceName,
						instanceBaseUrl,
						service: "prowlarr" as const,
					};
				})
		: [];
	const healthIssues = healthIssuesList.length;

	// Sort by queries descending and take top 10
	const topIndexers = normalizedStats.sort((a, b) => b.queries - a.queries).slice(0, 10);

	return prowlarrStatisticsSchema.parse({
		totalIndexers,
		activeIndexers,
		pausedIndexers,
		totalQueries,
		totalGrabs,
		successfulQueries,
		failedQueries,
		successfulGrabs,
		failedGrabs,
		grabRate,
		averageResponseTime,
		healthIssues,
		healthIssuesList,
		indexers: topIndexers,
	});
};

// ============================================================================
// SDK-based functions (arr-sdk 0.3.0)
// ============================================================================

/**
 * Safely execute an SDK call and return undefined on error
 */
const safeRequest = async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
	try {
		return await operation();
	} catch {
		return undefined;
	}
};

/**
 * Fetches Sonarr statistics using the SDK
 */
export const fetchSonarrStatisticsWithSdk = async (
	client: SonarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<SonarrStatistics> => {
	// Fetch all API endpoints in parallel for better performance
	const [series, diskspace, health, cutoffUnmet, qualityProfiles, tags] = await Promise.all([
		safeRequest(() => client.series.getAll()).then((r) => r ?? []),
		safeRequest(() => client.diskSpace.getAll()).then((r) => r ?? []),
		safeRequest(() => client.health.getAll()).then((r) => r ?? []),
		safeRequest(() => client.wanted.cutoff({ page: 1, pageSize: 1 })).then(
			(r) => r ?? { totalRecords: 0 },
		),
		safeRequest(() => client.qualityProfile.getAll()).then((r) => r ?? []),
		safeRequest(() => client.tag.getAll()).then((r) => r ?? []),
	]);

	// Build a map of profile ID to profile name
	const profileIdToName = new Map<number, string>();
	for (const profile of qualityProfiles) {
		if (profile?.id !== undefined && profile?.name) {
			profileIdToName.set(profile.id, profile.name);
		}
	}

	// Build a map of tag ID to tag label
	const tagIdToLabel = new Map<number, string>();
	for (const tag of tags) {
		if (tag?.id !== undefined && tag?.label) {
			tagIdToLabel.set(tag.id, tag.label);
		}
	}

	// Calculate time thresholds for recently added
	const now = Date.now();
	const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	let totalSeries = 0;
	let monitoredSeries = 0;
	let continuingSeries = 0;
	let endedSeries = 0;
	let totalEpisodes = 0;
	let episodeFileCount = 0;
	let downloadedEpisodes = 0;
	let missingEpisodes = 0;
	let totalFileSize = 0;
	let recentlyAdded7Days = 0;
	let recentlyAdded30Days = 0;

	// Track quality distribution based on quality profiles
	const qualityBreakdown: Record<string, number> = {};
	// Track tag distribution
	const tagBreakdown: Record<string, number> = {};

	for (const entry of series) {
		if (!entry) continue;
		totalSeries += 1;
		if (entry.monitored !== false) {
			monitoredSeries += 1;
		}

		const status = entry.status;
		if (status === "continuing") {
			continuingSeries += 1;
		} else if (status === "ended") {
			endedSeries += 1;
		}

		// Check added date for recently added
		const addedStr = entry.added;
		if (addedStr) {
			const addedTime = new Date(addedStr).getTime();
			if (!Number.isNaN(addedTime)) {
				if (addedTime >= sevenDaysAgo) {
					recentlyAdded7Days += 1;
				}
				if (addedTime >= thirtyDaysAgo) {
					recentlyAdded30Days += 1;
				}
			}
		}

		// Process tags
		const entryTags = entry.tags;
		if (Array.isArray(entryTags)) {
			for (const tagId of entryTags) {
				if (typeof tagId === "number" && tagIdToLabel.has(tagId)) {
					const tagLabel = tagIdToLabel.get(tagId);
					if (tagLabel !== undefined) {
						tagBreakdown[tagLabel] = (tagBreakdown[tagLabel] ?? 0) + 1;
					}
				}
			}
		}

		const stats = entry.statistics;
		const episodesTotal = stats?.totalEpisodeCount ?? stats?.episodeCount ?? 0;
		const episodesWithFile = stats?.episodeFileCount ?? 0;
		const sizeOnDisk = stats?.sizeOnDisk ?? 0;

		totalEpisodes += episodesTotal;
		episodeFileCount += episodesWithFile;
		downloadedEpisodes += episodesWithFile;
		missingEpisodes += Math.max(0, episodesTotal - episodesWithFile);
		totalFileSize += sizeOnDisk;

		// Count episodes by quality profile (for series with files)
		if (episodesWithFile > 0) {
			const qualityProfileId = entry.qualityProfileId;

			// Look up the profile name
			if (qualityProfileId !== undefined && profileIdToName.has(qualityProfileId)) {
				const profileName = profileIdToName.get(qualityProfileId);
				if (profileName !== undefined) {
					qualityBreakdown[profileName] = (qualityBreakdown[profileName] ?? 0) + episodesWithFile;
				}
			} else {
				qualityBreakdown.Unknown = (qualityBreakdown.Unknown ?? 0) + episodesWithFile;
			}
		}
	}

	const cutoffUnmetCount = cutoffUnmet?.totalRecords ?? 0;
	const averageEpisodeSize =
		downloadedEpisodes > 0 ? totalFileSize / downloadedEpisodes : undefined;

	const diskTotals = diskspace.reduce(
		(acc: { total: number; free: number }, entry) => {
			acc.total += entry?.totalSpace ?? 0;
			acc.free += entry?.freeSpace ?? 0;
			return acc;
		},
		{ total: 0, free: 0 },
	);

	const diskUsed = Math.max(0, diskTotals.total - diskTotals.free);
	const diskUsagePercent =
		diskTotals.total > 0 ? clampPercentage((diskUsed / diskTotals.total) * 100) : 0;

	const healthIssuesList = health
		.filter((item) => {
			const type = item?.type;
			return type === "error" || type === "warning";
		})
		.map((item) => ({
			type: item.type as "error" | "warning",
			message: item.message ?? "Unknown health issue",
			source: item.source,
			wikiUrl: item.wikiUrl,
			instanceId,
			instanceName,
			instanceBaseUrl,
			service: "sonarr" as const,
		}));
	const healthIssues = healthIssuesList.length;

	return sonarrStatisticsSchema.parse({
		totalSeries,
		monitoredSeries,
		continuingSeries,
		endedSeries,
		totalEpisodes,
		episodeFileCount,
		downloadedEpisodes,
		missingEpisodes,
		downloadedPercentage:
			totalEpisodes > 0 ? clampPercentage((downloadedEpisodes / totalEpisodes) * 100) : 0,
		cutoffUnmetCount,
		qualityBreakdown,
		tagBreakdown,
		recentlyAdded7Days,
		recentlyAdded30Days,
		averageEpisodeSize,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskUsed || undefined,
		diskUsagePercent,
		healthIssues,
		healthIssuesList,
	});
};

/**
 * Fetches Radarr statistics using the SDK
 */
export const fetchRadarrStatisticsWithSdk = async (
	client: RadarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<RadarrStatistics> => {
	// Fetch all API endpoints in parallel for better performance
	const [movies, diskspace, health, cutoffUnmet, qualityProfiles, tags] = await Promise.all([
		safeRequest(() => client.movie.getAll()).then((r) => r ?? []),
		safeRequest(() => client.diskSpace.getAll()).then((r) => r ?? []),
		safeRequest(() => client.health.getAll()).then((r) => r ?? []),
		safeRequest(() => client.wanted.cutoff({ page: 1, pageSize: 1 })).then(
			(r) => r ?? { totalRecords: 0 },
		),
		safeRequest(() => client.qualityProfile.getAll()).then((r) => r ?? []),
		safeRequest(() => client.tag.getAll()).then((r) => r ?? []),
	]);

	// Build a map of profile ID to profile name
	const profileIdToName = new Map<number, string>();
	for (const profile of qualityProfiles) {
		if (profile?.id !== undefined && profile?.name) {
			profileIdToName.set(profile.id, profile.name);
		}
	}

	// Build tag ID to label map
	const tagIdToLabel = new Map<number, string>();
	for (const tag of tags) {
		if (tag?.id !== undefined && tag?.label) {
			tagIdToLabel.set(tag.id, tag.label);
		}
	}

	// Calculate time thresholds for recently added
	const now = Date.now();
	const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	let monitoredMovies = 0;
	let downloadedMovies = 0;
	let totalFileSize = 0;
	let recentlyAdded7Days = 0;
	let recentlyAdded30Days = 0;
	let totalRuntime = 0;

	const qualityBreakdown: Record<string, number> = {};
	const tagBreakdown: Record<string, number> = {};

	for (const movie of movies) {
		if (!movie) continue;

		// Check added date for recently added counts
		const addedStr = movie.added;
		if (addedStr) {
			const addedTime = new Date(addedStr).getTime();
			if (!Number.isNaN(addedTime)) {
				if (addedTime >= sevenDaysAgo) {
					recentlyAdded7Days += 1;
				}
				if (addedTime >= thirtyDaysAgo) {
					recentlyAdded30Days += 1;
				}
			}
		}

		// Process tags for tag breakdown
		const movieTags = movie.tags;
		if (Array.isArray(movieTags)) {
			for (const tagId of movieTags) {
				if (typeof tagId === "number" && tagIdToLabel.has(tagId)) {
					const tagLabel = tagIdToLabel.get(tagId);
					if (tagLabel) {
						tagBreakdown[tagLabel] = (tagBreakdown[tagLabel] ?? 0) + 1;
					}
				}
			}
		}

		// Accumulate total runtime (in minutes)
		const runtime = movie.runtime;
		if (typeof runtime === "number" && runtime > 0) {
			totalRuntime += runtime;
		}

		if (movie.monitored !== false) {
			monitoredMovies += 1;
		}
		if (movie.hasFile) {
			downloadedMovies += 1;

			const sizeOnDisk = movie.sizeOnDisk ?? 0;
			totalFileSize += sizeOnDisk;

			// Use quality profile to categorize
			const qualityProfileId = movie.qualityProfileId;

			// Look up the profile name
			if (qualityProfileId !== undefined && profileIdToName.has(qualityProfileId)) {
				const profileName = profileIdToName.get(qualityProfileId);
				if (profileName !== undefined) {
					qualityBreakdown[profileName] = (qualityBreakdown[profileName] ?? 0) + 1;
				}
			} else {
				qualityBreakdown.Unknown = (qualityBreakdown.Unknown ?? 0) + 1;
			}
		}
	}

	const totalMovies = movies.length;
	const missingMovies = Math.max(0, monitoredMovies - downloadedMovies);
	const cutoffUnmetCount = cutoffUnmet?.totalRecords ?? 0;
	const averageMovieSize = downloadedMovies > 0 ? totalFileSize / downloadedMovies : undefined;

	const diskTotals = diskspace.reduce(
		(acc: { total: number; free: number }, entry) => {
			acc.total += entry?.totalSpace ?? 0;
			acc.free += entry?.freeSpace ?? 0;
			return acc;
		},
		{ total: 0, free: 0 },
	);

	const diskUsed = Math.max(0, diskTotals.total - diskTotals.free);
	const diskUsagePercent =
		diskTotals.total > 0 ? clampPercentage((diskUsed / diskTotals.total) * 100) : 0;

	const healthIssuesList = health
		.filter((item) => {
			const type = item?.type;
			return type === "error" || type === "warning";
		})
		.map((item) => ({
			type: item.type as "error" | "warning",
			message: item.message ?? "Unknown health issue",
			source: item.source,
			wikiUrl: item.wikiUrl,
			instanceId,
			instanceName,
			instanceBaseUrl,
			service: "radarr" as const,
		}));
	const healthIssues = healthIssuesList.length;

	return radarrStatisticsSchema.parse({
		totalMovies,
		monitoredMovies,
		downloadedMovies,
		missingMovies,
		downloadedPercentage:
			monitoredMovies > 0 ? clampPercentage((downloadedMovies / monitoredMovies) * 100) : 0,
		cutoffUnmetCount,
		qualityBreakdown,
		tagBreakdown,
		recentlyAdded7Days,
		recentlyAdded30Days,
		totalRuntime: totalRuntime > 0 ? totalRuntime : undefined,
		averageMovieSize,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskUsed || undefined,
		diskUsagePercent,
		healthIssues,
		healthIssuesList,
	});
};

/**
 * Fetches Prowlarr statistics using the SDK
 */
export const fetchProwlarrStatisticsWithSdk = async (
	client: ProwlarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<ProwlarrStatistics> => {
	const [indexers, health, indexerStats] = await Promise.all([
		safeRequest(() => client.indexer.getAll()).then((r) => r ?? []),
		safeRequest(() => client.health.getAll()).then((r) => r ?? []),
		safeRequest(() => client.indexerStats.get({})).then((r) => r ?? { indexers: [] }),
	]);

	const totalIndexers = indexers.length;
	const activeIndexers = indexers.filter((entry) => entry?.enable !== false).length;
	const pausedIndexers = totalIndexers - activeIndexers;

	// Process indexer statistics from the dedicated endpoint
	const statsEntries = Array.isArray(indexerStats.indexers) ? indexerStats.indexers : [];

	// Aggregate totals from all indexers
	let totalQueries = 0;
	let totalGrabs = 0;
	let successfulQueries = 0;
	let failedQueries = 0;
	let successfulGrabs = 0;
	let failedGrabs = 0;
	let totalResponseTime = 0;
	let responseTimeCount = 0;

	const normalizedStats: ProwlarrIndexerStat[] = [];

	for (const entry of statsEntries) {
		if (!entry) continue;

		const name = entry.indexerName ?? "Unknown";

		// Get query counts
		const queries = entry.numberOfQueries ?? 0;
		const grabs = entry.numberOfGrabs ?? 0;
		const failed = entry.numberOfFailedQueries ?? 0;
		const failedGrabCount = entry.numberOfFailedGrabs ?? 0;
		const avgResponseTime = entry.averageResponseTime;

		// Aggregate totals
		totalQueries += queries;
		totalGrabs += grabs;
		failedQueries += failed;
		failedGrabs += failedGrabCount;

		// Successful = total - failed
		const successfulQueryCount = Math.max(0, queries - failed);
		const successfulGrabCount = Math.max(0, grabs - failedGrabCount);
		successfulQueries += successfulQueryCount;
		successfulGrabs += successfulGrabCount;

		// Track response times for average calculation
		if (typeof avgResponseTime === "number" && avgResponseTime > 0) {
			totalResponseTime += avgResponseTime;
			responseTimeCount += 1;
		}

		// Calculate success rate based on queries
		const totalAttempts = queries + grabs;
		const totalSuccessful = successfulQueryCount + successfulGrabCount;
		const successRate =
			totalAttempts > 0 ? clampPercentage((totalSuccessful / totalAttempts) * 100) : 100;

		// Only include indexers with activity
		if (queries > 0 || grabs > 0) {
			normalizedStats.push(
				prowlarrIndexerStatSchema.parse({
					name,
					queries,
					grabs,
					successRate,
				}),
			);
		}
	}

	// Calculate grab rate (grabs / queries)
	const grabRate = totalQueries > 0 ? clampPercentage((totalGrabs / totalQueries) * 100) : 0;

	// Calculate average response time across all indexers
	const averageResponseTime =
		responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : undefined;

	// Process health issues
	const healthIssuesList = health
		.filter((item) => {
			const type = item?.type;
			return type === "error" || type === "warning";
		})
		.map((item) => ({
			type: item.type as "error" | "warning",
			message: item.message ?? "Unknown health issue",
			source: item.source,
			wikiUrl: item.wikiUrl,
			instanceId,
			instanceName,
			instanceBaseUrl,
			service: "prowlarr" as const,
		}));
	const healthIssues = healthIssuesList.length;

	// Sort by queries descending and take top 10
	const topIndexers = normalizedStats.sort((a, b) => b.queries - a.queries).slice(0, 10);

	return prowlarrStatisticsSchema.parse({
		totalIndexers,
		activeIndexers,
		pausedIndexers,
		totalQueries,
		totalGrabs,
		successfulQueries,
		failedQueries,
		successfulGrabs,
		failedGrabs,
		grabRate,
		averageResponseTime,
		healthIssues,
		healthIssuesList,
		indexers: topIndexers,
	});
};

/**
 * Fetches Lidarr statistics using the SDK
 */
export const fetchLidarrStatisticsWithSdk = async (
	client: LidarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<LidarrStatistics> => {
	// Fetch all API endpoints in parallel for better performance
	// Note: Lidarr SDK uses get() instead of getAll() for some resources
	const [artists, diskspace, health, cutoffUnmetResult, qualityProfiles, tags] = await Promise.all([
		safeRequest(() => client.artist.getAll()).then((r) => r ?? []),
		safeRequest(() => client.diskSpace.get()).then((r) => r ?? []),
		safeRequest(() => client.health.get()).then((r) => r ?? []),
		safeRequest(() => client.wanted.getCutoffUnmet({ page: 1, pageSize: 1 })),
		safeRequest(() => client.qualityProfile.getAll()).then((r) => r ?? []),
		safeRequest(() => client.tag.getAll()).then((r) => r ?? []),
	]);
	const cutoffUnmet = cutoffUnmetResult ?? { totalRecords: 0 };

	// Build a map of profile ID to profile name
	const profileIdToName = new Map<number, string>();
	for (const profile of qualityProfiles) {
		if (profile?.id !== undefined && profile?.name) {
			profileIdToName.set(profile.id, profile.name);
		}
	}

	// Build a map of tag ID to tag label
	const tagIdToLabel = new Map<number, string>();
	for (const tag of tags) {
		if (tag?.id !== undefined && tag?.label) {
			tagIdToLabel.set(tag.id, tag.label);
		}
	}

	// Calculate time thresholds for recently added
	const now = Date.now();
	const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	let totalArtists = 0;
	let monitoredArtists = 0;
	let totalAlbums = 0;
	let monitoredAlbums = 0;
	let totalTracks = 0;
	let downloadedTracks = 0;
	let missingTracks = 0;
	let totalFileSize = 0;
	let recentlyAdded7Days = 0;
	let recentlyAdded30Days = 0;

	// Track quality distribution based on quality profiles
	const qualityBreakdown: Record<string, number> = {};
	// Track tag distribution
	const tagBreakdown: Record<string, number> = {};

	for (const artist of artists) {
		if (!artist) continue;
		totalArtists += 1;
		if (artist.monitored !== false) {
			monitoredArtists += 1;
		}

		// Check added date for recently added
		const addedStr = artist.added;
		if (addedStr) {
			const addedTime = new Date(addedStr).getTime();
			if (!Number.isNaN(addedTime)) {
				if (addedTime >= sevenDaysAgo) {
					recentlyAdded7Days += 1;
				}
				if (addedTime >= thirtyDaysAgo) {
					recentlyAdded30Days += 1;
				}
			}
		}

		// Process tags
		const artistTags = artist.tags;
		if (Array.isArray(artistTags)) {
			for (const tagId of artistTags) {
				if (typeof tagId === "number" && tagIdToLabel.has(tagId)) {
					const tagLabel = tagIdToLabel.get(tagId);
					if (tagLabel !== undefined) {
						tagBreakdown[tagLabel] = (tagBreakdown[tagLabel] ?? 0) + 1;
					}
				}
			}
		}

		// Get artist statistics
		const stats = artist.statistics;
		const albumCount = stats?.albumCount ?? 0;
		const trackCount = stats?.totalTrackCount ?? 0;
		const trackFileCount = stats?.trackFileCount ?? 0;
		const sizeOnDisk = stats?.sizeOnDisk ?? 0;

		totalAlbums += albumCount;
		totalTracks += trackCount;
		downloadedTracks += trackFileCount;
		missingTracks += Math.max(0, trackCount - trackFileCount);
		totalFileSize += sizeOnDisk;

		// Count by quality profile
		if (trackFileCount > 0) {
			const qualityProfileId = artist.qualityProfileId;
			if (qualityProfileId !== undefined && profileIdToName.has(qualityProfileId)) {
				const profileName = profileIdToName.get(qualityProfileId);
				if (profileName !== undefined) {
					qualityBreakdown[profileName] = (qualityBreakdown[profileName] ?? 0) + trackFileCount;
				}
			} else {
				qualityBreakdown.Unknown = (qualityBreakdown.Unknown ?? 0) + trackFileCount;
			}
		}
	}

	// Calculate monitored albums (approximate from artist monitored status)
	monitoredAlbums = Math.round(totalAlbums * (monitoredArtists / Math.max(totalArtists, 1)));

	const cutoffUnmetCount = toNumber(cutoffUnmet?.totalRecords) ?? 0;
	const averageTrackSize = downloadedTracks > 0 ? totalFileSize / downloadedTracks : undefined;

	const diskTotals = diskspace.reduce(
		(acc: { total: number; free: number }, entry) => {
			acc.total += entry?.totalSpace ?? 0;
			acc.free += entry?.freeSpace ?? 0;
			return acc;
		},
		{ total: 0, free: 0 },
	);

	const diskUsed = Math.max(0, diskTotals.total - diskTotals.free);
	const diskUsagePercent =
		diskTotals.total > 0 ? clampPercentage((diskUsed / diskTotals.total) * 100) : 0;

	const healthIssuesList = health
		.filter((item) => {
			const type = item?.type;
			return type === "error" || type === "warning";
		})
		.map((item) => ({
			type: item.type as "error" | "warning",
			message: item.message ?? "Unknown health issue",
			source: item.source,
			wikiUrl: item.wikiUrl,
			instanceId,
			instanceName,
			instanceBaseUrl,
			service: "lidarr" as const,
		}));
	const healthIssues = healthIssuesList.length;

	return lidarrStatisticsSchema.parse({
		totalArtists,
		monitoredArtists,
		totalAlbums,
		monitoredAlbums,
		totalTracks,
		downloadedTracks,
		missingTracks,
		downloadedPercentage:
			totalTracks > 0 ? clampPercentage((downloadedTracks / totalTracks) * 100) : 0,
		cutoffUnmetCount,
		qualityBreakdown,
		tagBreakdown: Object.keys(tagBreakdown).length > 0 ? tagBreakdown : undefined,
		recentlyAdded7Days,
		recentlyAdded30Days,
		averageTrackSize,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskUsed || undefined,
		diskUsagePercent,
		healthIssues,
		healthIssuesList,
	});
};

/**
 * Fetches Readarr statistics using the SDK
 */
export const fetchReadarrStatisticsWithSdk = async (
	client: ReadarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<ReadarrStatistics> => {
	// Fetch all API endpoints in parallel for better performance
	const [authors, diskspace, health, cutoffUnmetResult, qualityProfiles, tags] = await Promise.all([
		safeRequest(() => client.author.getAll()).then((r) => r ?? []),
		safeRequest(() => client.diskSpace.getAll()).then((r) => r ?? []),
		safeRequest(() => client.health.getAll()).then((r) => r ?? []),
		safeRequest(() => client.wanted.getCutoffUnmet({ page: 1, pageSize: 1 })),
		safeRequest(() => client.qualityProfile.getAll()).then((r) => r ?? []),
		safeRequest(() => client.tag.getAll()).then((r) => r ?? []),
	]);
	const cutoffUnmet = cutoffUnmetResult ?? { totalRecords: 0 };

	// Build a map of profile ID to profile name
	const profileIdToName = new Map<number, string>();
	for (const profile of qualityProfiles) {
		if (profile?.id !== undefined && profile?.name) {
			profileIdToName.set(profile.id, profile.name);
		}
	}

	// Build a map of tag ID to tag label
	const tagIdToLabel = new Map<number, string>();
	for (const tag of tags) {
		if (tag?.id !== undefined && tag?.label) {
			tagIdToLabel.set(tag.id, tag.label);
		}
	}

	// Calculate time thresholds for recently added
	const now = Date.now();
	const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
	const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

	let totalAuthors = 0;
	let monitoredAuthors = 0;
	let totalBooks = 0;
	let monitoredBooks = 0;
	let downloadedBooks = 0;
	let missingBooks = 0;
	let totalFileSize = 0;
	let recentlyAdded7Days = 0;
	let recentlyAdded30Days = 0;

	// Track quality distribution based on quality profiles
	const qualityBreakdown: Record<string, number> = {};
	// Track tag distribution
	const tagBreakdown: Record<string, number> = {};

	for (const author of authors) {
		if (!author) continue;
		totalAuthors += 1;
		if (author.monitored !== false) {
			monitoredAuthors += 1;
		}

		// Check added date for recently added
		const addedStr = author.added;
		if (addedStr) {
			const addedTime = new Date(addedStr).getTime();
			if (!Number.isNaN(addedTime)) {
				if (addedTime >= sevenDaysAgo) {
					recentlyAdded7Days += 1;
				}
				if (addedTime >= thirtyDaysAgo) {
					recentlyAdded30Days += 1;
				}
			}
		}

		// Process tags
		const authorTags = author.tags;
		if (Array.isArray(authorTags)) {
			for (const tagId of authorTags) {
				if (typeof tagId === "number" && tagIdToLabel.has(tagId)) {
					const tagLabel = tagIdToLabel.get(tagId);
					if (tagLabel !== undefined) {
						tagBreakdown[tagLabel] = (tagBreakdown[tagLabel] ?? 0) + 1;
					}
				}
			}
		}

		// Get author statistics
		const stats = author.statistics;
		const bookCount = stats?.bookCount ?? 0;
		const bookFileCount = stats?.bookFileCount ?? 0;
		const sizeOnDisk = stats?.sizeOnDisk ?? 0;

		totalBooks += bookCount;
		downloadedBooks += bookFileCount;
		missingBooks += Math.max(0, bookCount - bookFileCount);
		totalFileSize += sizeOnDisk;

		// Track monitored books (approximate based on author monitored status)
		if (author.monitored !== false) {
			monitoredBooks += bookCount;
		}

		// Count by quality profile
		if (bookFileCount > 0) {
			const qualityProfileId = author.qualityProfileId;
			if (qualityProfileId !== undefined && profileIdToName.has(qualityProfileId)) {
				const profileName = profileIdToName.get(qualityProfileId);
				if (profileName !== undefined) {
					qualityBreakdown[profileName] = (qualityBreakdown[profileName] ?? 0) + bookFileCount;
				}
			} else {
				qualityBreakdown.Unknown = (qualityBreakdown.Unknown ?? 0) + bookFileCount;
			}
		}
	}

	const cutoffUnmetCount = toNumber(cutoffUnmet?.totalRecords) ?? 0;
	const averageBookSize = downloadedBooks > 0 ? totalFileSize / downloadedBooks : undefined;

	const diskTotals = diskspace.reduce(
		(acc: { total: number; free: number }, entry) => {
			acc.total += entry?.totalSpace ?? 0;
			acc.free += entry?.freeSpace ?? 0;
			return acc;
		},
		{ total: 0, free: 0 },
	);

	const diskUsed = Math.max(0, diskTotals.total - diskTotals.free);
	const diskUsagePercent =
		diskTotals.total > 0 ? clampPercentage((diskUsed / diskTotals.total) * 100) : 0;

	const healthIssuesList = health
		.filter((item) => {
			const type = item?.type;
			return type === "error" || type === "warning";
		})
		.map((item) => ({
			type: item.type as "error" | "warning",
			message: item.message ?? "Unknown health issue",
			source: item.source,
			wikiUrl: item.wikiUrl,
			instanceId,
			instanceName,
			instanceBaseUrl,
			service: "readarr" as const,
		}));
	const healthIssues = healthIssuesList.length;

	return readarrStatisticsSchema.parse({
		totalAuthors,
		monitoredAuthors,
		totalBooks,
		monitoredBooks,
		downloadedBooks,
		missingBooks,
		downloadedPercentage:
			monitoredBooks > 0 ? clampPercentage((downloadedBooks / monitoredBooks) * 100) : 0,
		cutoffUnmetCount,
		qualityBreakdown,
		tagBreakdown: Object.keys(tagBreakdown).length > 0 ? tagBreakdown : undefined,
		recentlyAdded7Days,
		recentlyAdded30Days,
		averageBookSize,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskUsed || undefined,
		diskUsagePercent,
		healthIssues,
		healthIssuesList,
	});
};

export const aggregateSonarrStatistics = (
	instances: Array<{
		storageGroupId?: string | null;
		shouldCountDisk?: boolean;
		data: SonarrStatistics;
	}>,
): SonarrStatistics | undefined => {
	if (instances.length === 0) {
		return undefined;
	}

	const totals = instances.reduce(
		(acc, entry) => {
			const data = entry.data;
			acc.totalSeries += data.totalSeries;
			acc.monitoredSeries += data.monitoredSeries;
			acc.continuingSeries += data.continuingSeries ?? 0;
			acc.endedSeries += data.endedSeries ?? 0;
			acc.totalEpisodes += data.totalEpisodes;
			acc.episodeFileCount += data.episodeFileCount;
			acc.downloadedEpisodes += data.downloadedEpisodes;
			acc.missingEpisodes += data.missingEpisodes;
			acc.cutoffUnmetCount += data.cutoffUnmetCount ?? 0;
			acc.recentlyAdded7Days += data.recentlyAdded7Days ?? 0;
			acc.recentlyAdded30Days += data.recentlyAdded30Days ?? 0;

			// Use pre-computed shouldCountDisk flag for cross-service deduplication
			// If not provided (backward compatibility), default to counting disk
			const shouldCountDisk = entry.shouldCountDisk ?? true;

			if (shouldCountDisk) {
				acc.diskTotal += data.diskTotal ?? 0;
				acc.diskFree += data.diskFree ?? 0;
				acc.diskUsed += data.diskUsed ?? 0;
			}

			acc.healthIssues += data.healthIssues ?? 0;
			if (data.healthIssuesList) {
				acc.healthIssuesList?.push(...data.healthIssuesList);
			}
			if (data.qualityBreakdown) {
				for (const [profileName, count] of Object.entries(data.qualityBreakdown)) {
					acc.qualityBreakdown[profileName] = (acc.qualityBreakdown[profileName] ?? 0) + count;
				}
			}
			if (data.tagBreakdown) {
				for (const [tagName, count] of Object.entries(data.tagBreakdown)) {
					acc.tagBreakdown[tagName] = (acc.tagBreakdown[tagName] ?? 0) + count;
				}
			}
			if (data.averageEpisodeSize) {
				acc.totalFileSize += data.averageEpisodeSize * data.episodeFileCount;
				acc.totalFiles += data.episodeFileCount;
			}
			return acc;
		},
		{
			totalSeries: 0,
			monitoredSeries: 0,
			continuingSeries: 0,
			endedSeries: 0,
			totalEpisodes: 0,
			episodeFileCount: 0,
			downloadedEpisodes: 0,
			missingEpisodes: 0,
			cutoffUnmetCount: 0,
			recentlyAdded7Days: 0,
			recentlyAdded30Days: 0,
			diskTotal: 0,
			diskFree: 0,
			diskUsed: 0,
			healthIssues: 0,
			healthIssuesList: [] as SonarrStatistics["healthIssuesList"],
			qualityBreakdown: {} as Record<string, number>,
			tagBreakdown: {} as Record<string, number>,
			totalFileSize: 0,
			totalFiles: 0,
		},
	);

	const downloadedPercentage =
		totals.totalEpisodes > 0
			? clampPercentage((totals.downloadedEpisodes / totals.totalEpisodes) * 100)
			: 0;
	const diskUsagePercent =
		totals.diskTotal > 0 ? clampPercentage((totals.diskUsed / totals.diskTotal) * 100) : 0;
	const averageEpisodeSize =
		totals.totalFiles > 0 ? totals.totalFileSize / totals.totalFiles : undefined;

	return sonarrStatisticsSchema.parse({
		totalSeries: totals.totalSeries,
		monitoredSeries: totals.monitoredSeries,
		continuingSeries: totals.continuingSeries,
		endedSeries: totals.endedSeries,
		totalEpisodes: totals.totalEpisodes,
		episodeFileCount: totals.episodeFileCount,
		downloadedEpisodes: totals.downloadedEpisodes,
		missingEpisodes: totals.missingEpisodes,
		downloadedPercentage,
		cutoffUnmetCount: totals.cutoffUnmetCount,
		qualityBreakdown: totals.qualityBreakdown,
		tagBreakdown: Object.keys(totals.tagBreakdown).length > 0 ? totals.tagBreakdown : undefined,
		recentlyAdded7Days: totals.recentlyAdded7Days,
		recentlyAdded30Days: totals.recentlyAdded30Days,
		averageEpisodeSize,
		diskTotal: totals.diskTotal || undefined,
		diskFree: totals.diskFree || undefined,
		diskUsed: totals.diskUsed || undefined,
		diskUsagePercent,
		healthIssues: totals.healthIssues,
		healthIssuesList: totals.healthIssuesList,
	});
};

export const aggregateRadarrStatistics = (
	instances: Array<{
		storageGroupId?: string | null;
		shouldCountDisk?: boolean;
		data: RadarrStatistics;
	}>,
): RadarrStatistics | undefined => {
	if (instances.length === 0) {
		return undefined;
	}

	const totals = instances.reduce(
		(acc, entry) => {
			const data = entry.data;
			acc.totalMovies += data.totalMovies;
			acc.monitoredMovies += data.monitoredMovies;
			acc.downloadedMovies += data.downloadedMovies;
			acc.missingMovies += data.missingMovies;
			acc.cutoffUnmetCount += data.cutoffUnmetCount ?? 0;
			acc.recentlyAdded7Days += data.recentlyAdded7Days ?? 0;
			acc.recentlyAdded30Days += data.recentlyAdded30Days ?? 0;
			acc.totalRuntime += data.totalRuntime ?? 0;

			// Use pre-computed shouldCountDisk flag for cross-service deduplication
			// If not provided (backward compatibility), default to counting disk
			const shouldCountDisk = entry.shouldCountDisk ?? true;

			if (shouldCountDisk) {
				acc.diskTotal += data.diskTotal ?? 0;
				acc.diskFree += data.diskFree ?? 0;
				acc.diskUsed += data.diskUsed ?? 0;
			}

			acc.healthIssues += data.healthIssues ?? 0;
			if (data.healthIssuesList) {
				acc.healthIssuesList?.push(...data.healthIssuesList);
			}
			if (data.qualityBreakdown) {
				for (const [profileName, count] of Object.entries(data.qualityBreakdown)) {
					acc.qualityBreakdown[profileName] = (acc.qualityBreakdown[profileName] ?? 0) + count;
				}
			}
			if (data.tagBreakdown) {
				for (const [tagName, count] of Object.entries(data.tagBreakdown)) {
					acc.tagBreakdown[tagName] = (acc.tagBreakdown[tagName] ?? 0) + count;
				}
			}
			if (data.averageMovieSize) {
				acc.totalFileSize += data.averageMovieSize * data.downloadedMovies;
				acc.totalFiles += data.downloadedMovies;
			}
			return acc;
		},
		{
			totalMovies: 0,
			monitoredMovies: 0,
			downloadedMovies: 0,
			missingMovies: 0,
			cutoffUnmetCount: 0,
			recentlyAdded7Days: 0,
			recentlyAdded30Days: 0,
			totalRuntime: 0,
			diskTotal: 0,
			diskFree: 0,
			diskUsed: 0,
			healthIssues: 0,
			healthIssuesList: [] as RadarrStatistics["healthIssuesList"],
			qualityBreakdown: {} as Record<string, number>,
			tagBreakdown: {} as Record<string, number>,
			totalFileSize: 0,
			totalFiles: 0,
		},
	);

	const downloadedPercentage =
		totals.monitoredMovies > 0
			? clampPercentage((totals.downloadedMovies / totals.monitoredMovies) * 100)
			: 0;
	const diskUsagePercent =
		totals.diskTotal > 0 ? clampPercentage((totals.diskUsed / totals.diskTotal) * 100) : 0;
	const averageMovieSize =
		totals.totalFiles > 0 ? totals.totalFileSize / totals.totalFiles : undefined;

	return radarrStatisticsSchema.parse({
		totalMovies: totals.totalMovies,
		monitoredMovies: totals.monitoredMovies,
		downloadedMovies: totals.downloadedMovies,
		missingMovies: totals.missingMovies,
		downloadedPercentage,
		cutoffUnmetCount: totals.cutoffUnmetCount,
		qualityBreakdown: totals.qualityBreakdown,
		tagBreakdown: Object.keys(totals.tagBreakdown).length > 0 ? totals.tagBreakdown : undefined,
		recentlyAdded7Days: totals.recentlyAdded7Days,
		recentlyAdded30Days: totals.recentlyAdded30Days,
		totalRuntime: totals.totalRuntime > 0 ? totals.totalRuntime : undefined,
		averageMovieSize,
		diskTotal: totals.diskTotal || undefined,
		diskFree: totals.diskFree || undefined,
		diskUsed: totals.diskUsed || undefined,
		diskUsagePercent,
		healthIssues: totals.healthIssues,
		healthIssuesList: totals.healthIssuesList,
	});
};

export const aggregateProwlarrStatistics = (
	instances: Array<{ data: ProwlarrStatistics }>,
): ProwlarrStatistics | undefined => {
	if (instances.length === 0) {
		return undefined;
	}

	const totals = instances.reduce(
		(acc, entry) => {
			const data = entry.data;
			acc.totalIndexers += data.totalIndexers;
			acc.activeIndexers += data.activeIndexers;
			acc.pausedIndexers += data.pausedIndexers;
			acc.totalQueries += data.totalQueries;
			acc.totalGrabs += data.totalGrabs;
			acc.successfulQueries += data.successfulQueries ?? 0;
			acc.failedQueries += data.failedQueries ?? 0;
			acc.successfulGrabs += data.successfulGrabs ?? 0;
			acc.failedGrabs += data.failedGrabs ?? 0;
			acc.healthIssues += data.healthIssues ?? 0;
			if (data.healthIssuesList) {
				acc.healthIssuesList?.push(...data.healthIssuesList);
			}
			const response = data.averageResponseTime;
			if (typeof response === "number" && Number.isFinite(response)) {
				acc.responseTimes.push(response);
			}
			acc.indexers.push(...data.indexers);
			return acc;
		},
		{
			totalIndexers: 0,
			activeIndexers: 0,
			pausedIndexers: 0,
			totalQueries: 0,
			totalGrabs: 0,
			successfulQueries: 0,
			failedQueries: 0,
			successfulGrabs: 0,
			failedGrabs: 0,
			healthIssues: 0,
			healthIssuesList: [] as ProwlarrStatistics["healthIssuesList"],
			responseTimes: [] as number[],
			indexers: [] as ProwlarrIndexerStat[],
		},
	);

	const averageResponseTime =
		totals.responseTimes.length > 0
			? totals.responseTimes.reduce((sum, value) => sum + value, 0) / totals.responseTimes.length
			: undefined;
	const grabRate =
		totals.totalQueries > 0 ? clampPercentage((totals.totalGrabs / totals.totalQueries) * 100) : 0;

	const aggregatedIndexers = totals.indexers.reduce(
		(
			map: Map<
				string,
				{
					displayName: string;
					queries: number;
					grabs: number;
					successRateSum: number;
					count: number;
				}
			>,
			entry,
		) => {
			const trimmedName = entry.name.trim();
			const key = (trimmedName || "indexer").toLowerCase();
			const existing = map.get(key);
			if (existing) {
				existing.queries += entry.queries;
				existing.grabs += entry.grabs;
				existing.successRateSum += entry.successRate;
				existing.count += 1;
			} else {
				map.set(key, {
					displayName: trimmedName.length > 0 ? trimmedName : "Indexer",
					queries: entry.queries,
					grabs: entry.grabs,
					successRateSum: entry.successRate,
					count: 1,
				});
			}
			return map;
		},
		new Map<
			string,
			{
				displayName: string;
				queries: number;
				grabs: number;
				successRateSum: number;
				count: number;
			}
		>(),
	);

	const indexers = Array.from(aggregatedIndexers.values())
		.map((aggregate) =>
			prowlarrIndexerStatSchema.parse({
				name: aggregate.displayName,
				queries: aggregate.queries,
				grabs: aggregate.grabs,
				successRate: clampPercentage(aggregate.successRateSum / Math.max(aggregate.count, 1)),
			}),
		)
		.sort((a, b) => b.queries - a.queries)
		.slice(0, 10);

	return prowlarrStatisticsSchema.parse({
		totalIndexers: totals.totalIndexers,
		activeIndexers: totals.activeIndexers,
		pausedIndexers: totals.pausedIndexers,
		totalQueries: totals.totalQueries,
		totalGrabs: totals.totalGrabs,
		successfulQueries: totals.successfulQueries,
		failedQueries: totals.failedQueries,
		successfulGrabs: totals.successfulGrabs,
		failedGrabs: totals.failedGrabs,
		grabRate,
		averageResponseTime: averageResponseTime ?? undefined,
		healthIssues: totals.healthIssues,
		healthIssuesList: totals.healthIssuesList,
		indexers,
	});
};

export const aggregateLidarrStatistics = (
	instances: Array<{
		storageGroupId?: string | null;
		shouldCountDisk?: boolean;
		data: LidarrStatistics;
	}>,
): LidarrStatistics | undefined => {
	if (instances.length === 0) {
		return undefined;
	}

	const totals = instances.reduce(
		(acc, entry) => {
			const data = entry.data;
			acc.totalArtists += data.totalArtists;
			acc.monitoredArtists += data.monitoredArtists;
			acc.totalAlbums += data.totalAlbums;
			acc.monitoredAlbums += data.monitoredAlbums;
			acc.totalTracks += data.totalTracks;
			acc.downloadedTracks += data.downloadedTracks;
			acc.missingTracks += data.missingTracks;
			acc.cutoffUnmetCount += data.cutoffUnmetCount ?? 0;
			acc.recentlyAdded7Days += data.recentlyAdded7Days ?? 0;
			acc.recentlyAdded30Days += data.recentlyAdded30Days ?? 0;

			// Use pre-computed shouldCountDisk flag for cross-service deduplication
			const shouldCountDisk = entry.shouldCountDisk ?? true;

			if (shouldCountDisk) {
				acc.diskTotal += data.diskTotal ?? 0;
				acc.diskFree += data.diskFree ?? 0;
				acc.diskUsed += data.diskUsed ?? 0;
			}

			acc.healthIssues += data.healthIssues ?? 0;
			if (data.healthIssuesList) {
				acc.healthIssuesList?.push(...data.healthIssuesList);
			}
			if (data.qualityBreakdown) {
				for (const [profileName, count] of Object.entries(data.qualityBreakdown)) {
					acc.qualityBreakdown[profileName] = (acc.qualityBreakdown[profileName] ?? 0) + count;
				}
			}
			if (data.tagBreakdown) {
				for (const [tagName, count] of Object.entries(data.tagBreakdown)) {
					acc.tagBreakdown[tagName] = (acc.tagBreakdown[tagName] ?? 0) + count;
				}
			}
			if (data.averageTrackSize) {
				acc.totalFileSize += data.averageTrackSize * data.downloadedTracks;
				acc.totalFiles += data.downloadedTracks;
			}
			return acc;
		},
		{
			totalArtists: 0,
			monitoredArtists: 0,
			totalAlbums: 0,
			monitoredAlbums: 0,
			totalTracks: 0,
			downloadedTracks: 0,
			missingTracks: 0,
			cutoffUnmetCount: 0,
			recentlyAdded7Days: 0,
			recentlyAdded30Days: 0,
			diskTotal: 0,
			diskFree: 0,
			diskUsed: 0,
			healthIssues: 0,
			healthIssuesList: [] as LidarrStatistics["healthIssuesList"],
			qualityBreakdown: {} as Record<string, number>,
			tagBreakdown: {} as Record<string, number>,
			totalFileSize: 0,
			totalFiles: 0,
		},
	);

	const downloadedPercentage =
		totals.totalTracks > 0
			? clampPercentage((totals.downloadedTracks / totals.totalTracks) * 100)
			: 0;
	const diskUsagePercent =
		totals.diskTotal > 0 ? clampPercentage((totals.diskUsed / totals.diskTotal) * 100) : 0;
	const averageTrackSize =
		totals.totalFiles > 0 ? totals.totalFileSize / totals.totalFiles : undefined;

	return lidarrStatisticsSchema.parse({
		totalArtists: totals.totalArtists,
		monitoredArtists: totals.monitoredArtists,
		totalAlbums: totals.totalAlbums,
		monitoredAlbums: totals.monitoredAlbums,
		totalTracks: totals.totalTracks,
		downloadedTracks: totals.downloadedTracks,
		missingTracks: totals.missingTracks,
		downloadedPercentage,
		cutoffUnmetCount: totals.cutoffUnmetCount,
		qualityBreakdown: totals.qualityBreakdown,
		tagBreakdown: Object.keys(totals.tagBreakdown).length > 0 ? totals.tagBreakdown : undefined,
		recentlyAdded7Days: totals.recentlyAdded7Days,
		recentlyAdded30Days: totals.recentlyAdded30Days,
		averageTrackSize,
		diskTotal: totals.diskTotal || undefined,
		diskFree: totals.diskFree || undefined,
		diskUsed: totals.diskUsed || undefined,
		diskUsagePercent,
		healthIssues: totals.healthIssues,
		healthIssuesList: totals.healthIssuesList,
	});
};

export const aggregateReadarrStatistics = (
	instances: Array<{
		storageGroupId?: string | null;
		shouldCountDisk?: boolean;
		data: ReadarrStatistics;
	}>,
): ReadarrStatistics | undefined => {
	if (instances.length === 0) {
		return undefined;
	}

	const totals = instances.reduce(
		(acc, entry) => {
			const data = entry.data;
			acc.totalAuthors += data.totalAuthors;
			acc.monitoredAuthors += data.monitoredAuthors;
			acc.totalBooks += data.totalBooks;
			acc.monitoredBooks += data.monitoredBooks;
			acc.downloadedBooks += data.downloadedBooks;
			acc.missingBooks += data.missingBooks;
			acc.cutoffUnmetCount += data.cutoffUnmetCount ?? 0;
			acc.recentlyAdded7Days += data.recentlyAdded7Days ?? 0;
			acc.recentlyAdded30Days += data.recentlyAdded30Days ?? 0;

			// Use pre-computed shouldCountDisk flag for cross-service deduplication
			const shouldCountDisk = entry.shouldCountDisk ?? true;

			if (shouldCountDisk) {
				acc.diskTotal += data.diskTotal ?? 0;
				acc.diskFree += data.diskFree ?? 0;
				acc.diskUsed += data.diskUsed ?? 0;
			}

			acc.healthIssues += data.healthIssues ?? 0;
			if (data.healthIssuesList) {
				acc.healthIssuesList?.push(...data.healthIssuesList);
			}
			if (data.qualityBreakdown) {
				for (const [profileName, count] of Object.entries(data.qualityBreakdown)) {
					acc.qualityBreakdown[profileName] = (acc.qualityBreakdown[profileName] ?? 0) + count;
				}
			}
			if (data.tagBreakdown) {
				for (const [tagName, count] of Object.entries(data.tagBreakdown)) {
					acc.tagBreakdown[tagName] = (acc.tagBreakdown[tagName] ?? 0) + count;
				}
			}
			if (data.averageBookSize) {
				acc.totalFileSize += data.averageBookSize * data.downloadedBooks;
				acc.totalFiles += data.downloadedBooks;
			}
			return acc;
		},
		{
			totalAuthors: 0,
			monitoredAuthors: 0,
			totalBooks: 0,
			monitoredBooks: 0,
			downloadedBooks: 0,
			missingBooks: 0,
			cutoffUnmetCount: 0,
			recentlyAdded7Days: 0,
			recentlyAdded30Days: 0,
			diskTotal: 0,
			diskFree: 0,
			diskUsed: 0,
			healthIssues: 0,
			healthIssuesList: [] as ReadarrStatistics["healthIssuesList"],
			qualityBreakdown: {} as Record<string, number>,
			tagBreakdown: {} as Record<string, number>,
			totalFileSize: 0,
			totalFiles: 0,
		},
	);

	const downloadedPercentage =
		totals.monitoredBooks > 0
			? clampPercentage((totals.downloadedBooks / totals.monitoredBooks) * 100)
			: 0;
	const diskUsagePercent =
		totals.diskTotal > 0 ? clampPercentage((totals.diskUsed / totals.diskTotal) * 100) : 0;
	const averageBookSize =
		totals.totalFiles > 0 ? totals.totalFileSize / totals.totalFiles : undefined;

	return readarrStatisticsSchema.parse({
		totalAuthors: totals.totalAuthors,
		monitoredAuthors: totals.monitoredAuthors,
		totalBooks: totals.totalBooks,
		monitoredBooks: totals.monitoredBooks,
		downloadedBooks: totals.downloadedBooks,
		missingBooks: totals.missingBooks,
		downloadedPercentage,
		cutoffUnmetCount: totals.cutoffUnmetCount,
		qualityBreakdown: totals.qualityBreakdown,
		tagBreakdown: Object.keys(totals.tagBreakdown).length > 0 ? totals.tagBreakdown : undefined,
		recentlyAdded7Days: totals.recentlyAdded7Days,
		recentlyAdded30Days: totals.recentlyAdded30Days,
		averageBookSize,
		diskTotal: totals.diskTotal || undefined,
		diskFree: totals.diskFree || undefined,
		diskUsed: totals.diskUsed || undefined,
		diskUsagePercent,
		healthIssues: totals.healthIssues,
		healthIssuesList: totals.healthIssuesList,
	});
};
