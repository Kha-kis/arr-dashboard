/**
 * Dashboard Statistics
 *
 * Service-specific statistics fetching and aggregation functions.
 * Uses shared utilities from statistics-utils.ts to reduce code duplication.
 */

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

import {
	type InstanceInfo,
	type HealthIssue,
	clampPercentage,
	toNumber,
	safeRequest,
	buildProfileIdToNameMap,
	buildTagIdToLabelMap,
	getTimeThresholds,
	checkRecentlyAdded,
	calculateDiskTotals,
	processHealthIssues,
	updateTagBreakdown,
	updateQualityBreakdown,
	finalizeDiskStats,
	finalizeBreakdown,
	mergeBreakdown,
} from "./statistics-utils.js";

// ============================================================================
// Empty Statistics Templates
// ============================================================================

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

// ============================================================================
// Sonarr Statistics (SDK)
// ============================================================================

export const fetchSonarrStatisticsWithSdk = async (
	client: SonarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<SonarrStatistics> => {
	const instanceInfo: InstanceInfo = { instanceId, instanceName, instanceBaseUrl };

	// Fetch all data in parallel
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

	// Build lookup maps
	const profileIdToName = buildProfileIdToNameMap(qualityProfiles);
	const tagIdToLabel = buildTagIdToLabelMap(tags);
	const thresholds = getTimeThresholds();

	// Process series
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
	const qualityBreakdown: Record<string, number> = {};
	const tagBreakdown: Record<string, number> = {};

	for (const entry of series) {
		if (!entry) continue;
		totalSeries += 1;
		if (entry.monitored !== false) monitoredSeries += 1;

		if (entry.status === "continuing") continuingSeries += 1;
		else if (entry.status === "ended") endedSeries += 1;

		const { within7Days, within30Days } = checkRecentlyAdded(entry.added, thresholds);
		if (within7Days) recentlyAdded7Days += 1;
		if (within30Days) recentlyAdded30Days += 1;

		updateTagBreakdown(entry.tags, tagIdToLabel, tagBreakdown);

		const stats = entry.statistics;
		const episodesTotal = stats?.totalEpisodeCount ?? stats?.episodeCount ?? 0;
		const episodesWithFile = stats?.episodeFileCount ?? 0;
		const sizeOnDisk = stats?.sizeOnDisk ?? 0;

		totalEpisodes += episodesTotal;
		episodeFileCount += episodesWithFile;
		downloadedEpisodes += episodesWithFile;
		missingEpisodes += Math.max(0, episodesTotal - episodesWithFile);
		totalFileSize += sizeOnDisk;

		if (episodesWithFile > 0) {
			updateQualityBreakdown(entry.qualityProfileId, profileIdToName, episodesWithFile, qualityBreakdown);
		}
	}

	const diskTotals = calculateDiskTotals(diskspace);
	const healthIssuesList = processHealthIssues(health, instanceInfo, "sonarr");

	return sonarrStatisticsSchema.parse({
		totalSeries,
		monitoredSeries,
		continuingSeries,
		endedSeries,
		totalEpisodes,
		episodeFileCount,
		downloadedEpisodes,
		missingEpisodes,
		downloadedPercentage: totalEpisodes > 0 ? clampPercentage((downloadedEpisodes / totalEpisodes) * 100) : 0,
		cutoffUnmetCount: cutoffUnmet?.totalRecords ?? 0,
		qualityBreakdown,
		tagBreakdown,
		recentlyAdded7Days,
		recentlyAdded30Days,
		averageEpisodeSize: downloadedEpisodes > 0 ? totalFileSize / downloadedEpisodes : undefined,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskTotals.used || undefined,
		diskUsagePercent: diskTotals.usagePercent,
		healthIssues: healthIssuesList.length,
		healthIssuesList,
	});
};

// ============================================================================
// Radarr Statistics (SDK)
// ============================================================================

export const fetchRadarrStatisticsWithSdk = async (
	client: RadarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<RadarrStatistics> => {
	const instanceInfo: InstanceInfo = { instanceId, instanceName, instanceBaseUrl };

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

	const profileIdToName = buildProfileIdToNameMap(qualityProfiles);
	const tagIdToLabel = buildTagIdToLabelMap(tags);
	const thresholds = getTimeThresholds();

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

		const { within7Days, within30Days } = checkRecentlyAdded(movie.added, thresholds);
		if (within7Days) recentlyAdded7Days += 1;
		if (within30Days) recentlyAdded30Days += 1;

		updateTagBreakdown(movie.tags, tagIdToLabel, tagBreakdown);

		if (typeof movie.runtime === "number" && movie.runtime > 0) {
			totalRuntime += movie.runtime;
		}

		if (movie.monitored !== false) monitoredMovies += 1;

		if (movie.hasFile) {
			downloadedMovies += 1;
			totalFileSize += movie.sizeOnDisk ?? 0;
			updateQualityBreakdown(movie.qualityProfileId, profileIdToName, 1, qualityBreakdown);
		}
	}

	const totalMovies = movies.length;
	const diskTotals = calculateDiskTotals(diskspace);
	const healthIssuesList = processHealthIssues(health, instanceInfo, "radarr");

	return radarrStatisticsSchema.parse({
		totalMovies,
		monitoredMovies,
		downloadedMovies,
		missingMovies: Math.max(0, monitoredMovies - downloadedMovies),
		downloadedPercentage: monitoredMovies > 0 ? clampPercentage((downloadedMovies / monitoredMovies) * 100) : 0,
		cutoffUnmetCount: cutoffUnmet?.totalRecords ?? 0,
		qualityBreakdown,
		tagBreakdown,
		recentlyAdded7Days,
		recentlyAdded30Days,
		totalRuntime: totalRuntime > 0 ? totalRuntime : undefined,
		averageMovieSize: downloadedMovies > 0 ? totalFileSize / downloadedMovies : undefined,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskTotals.used || undefined,
		diskUsagePercent: diskTotals.usagePercent,
		healthIssues: healthIssuesList.length,
		healthIssuesList,
	});
};

// ============================================================================
// Prowlarr Statistics (SDK)
// ============================================================================

export const fetchProwlarrStatisticsWithSdk = async (
	client: ProwlarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<ProwlarrStatistics> => {
	const instanceInfo: InstanceInfo = { instanceId, instanceName, instanceBaseUrl };

	const [indexers, health, indexerStats] = await Promise.all([
		safeRequest(() => client.indexer.getAll()).then((r) => r ?? []),
		safeRequest(() => client.health.getAll()).then((r) => r ?? []),
		safeRequest(() => client.indexerStats.get({})).then((r) => r ?? { indexers: [] }),
	]);

	const totalIndexers = indexers.length;
	const activeIndexers = indexers.filter((entry) => entry?.enable !== false).length;
	const statsEntries = Array.isArray(indexerStats.indexers) ? indexerStats.indexers : [];

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

		const queries = entry.numberOfQueries ?? 0;
		const grabs = entry.numberOfGrabs ?? 0;
		const failed = entry.numberOfFailedQueries ?? 0;
		const failedGrabCount = entry.numberOfFailedGrabs ?? 0;
		const avgResponseTime = entry.averageResponseTime;

		totalQueries += queries;
		totalGrabs += grabs;
		failedQueries += failed;
		failedGrabs += failedGrabCount;

		const successfulQueryCount = Math.max(0, queries - failed);
		const successfulGrabCount = Math.max(0, grabs - failedGrabCount);
		successfulQueries += successfulQueryCount;
		successfulGrabs += successfulGrabCount;

		if (typeof avgResponseTime === "number" && avgResponseTime > 0) {
			totalResponseTime += avgResponseTime;
			responseTimeCount += 1;
		}

		if (queries > 0 || grabs > 0) {
			const totalAttempts = queries + grabs;
			const totalSuccessful = successfulQueryCount + successfulGrabCount;
			normalizedStats.push(
				prowlarrIndexerStatSchema.parse({
					name: entry.indexerName ?? "Unknown",
					queries,
					grabs,
					successRate: totalAttempts > 0 ? clampPercentage((totalSuccessful / totalAttempts) * 100) : 100,
				}),
			);
		}
	}

	const healthIssuesList = processHealthIssues(health, instanceInfo, "prowlarr");
	const topIndexers = normalizedStats.sort((a, b) => b.queries - a.queries).slice(0, 10);

	return prowlarrStatisticsSchema.parse({
		totalIndexers,
		activeIndexers,
		pausedIndexers: totalIndexers - activeIndexers,
		totalQueries,
		totalGrabs,
		successfulQueries,
		failedQueries,
		successfulGrabs,
		failedGrabs,
		grabRate: totalQueries > 0 ? clampPercentage((totalGrabs / totalQueries) * 100) : 0,
		averageResponseTime: responseTimeCount > 0 ? Math.round(totalResponseTime / responseTimeCount) : undefined,
		healthIssues: healthIssuesList.length,
		healthIssuesList,
		indexers: topIndexers,
	});
};

// ============================================================================
// Lidarr Statistics (SDK)
// ============================================================================

export const fetchLidarrStatisticsWithSdk = async (
	client: LidarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<LidarrStatistics> => {
	const instanceInfo: InstanceInfo = { instanceId, instanceName, instanceBaseUrl };

	const [artists, diskspace, health, cutoffUnmetResult, qualityProfiles, tags] = await Promise.all([
		safeRequest(() => client.artist.getAll()).then((r) => r ?? []),
		safeRequest(() => client.diskSpace.get()).then((r) => r ?? []),
		safeRequest(() => client.health.get()).then((r) => r ?? []),
		safeRequest(() => client.wanted.getCutoffUnmet({ page: 1, pageSize: 1 })),
		safeRequest(() => client.qualityProfile.getAll()).then((r) => r ?? []),
		safeRequest(() => client.tag.getAll()).then((r) => r ?? []),
	]);
	const cutoffUnmet = cutoffUnmetResult ?? { totalRecords: 0 };

	const profileIdToName = buildProfileIdToNameMap(qualityProfiles);
	const tagIdToLabel = buildTagIdToLabelMap(tags);
	const thresholds = getTimeThresholds();

	let totalArtists = 0;
	let monitoredArtists = 0;
	let totalAlbums = 0;
	let totalTracks = 0;
	let downloadedTracks = 0;
	let missingTracks = 0;
	let totalFileSize = 0;
	let recentlyAdded7Days = 0;
	let recentlyAdded30Days = 0;
	const qualityBreakdown: Record<string, number> = {};
	const tagBreakdown: Record<string, number> = {};

	for (const artist of artists) {
		if (!artist) continue;
		totalArtists += 1;
		if (artist.monitored !== false) monitoredArtists += 1;

		const { within7Days, within30Days } = checkRecentlyAdded(artist.added, thresholds);
		if (within7Days) recentlyAdded7Days += 1;
		if (within30Days) recentlyAdded30Days += 1;

		updateTagBreakdown(artist.tags, tagIdToLabel, tagBreakdown);

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

		if (trackFileCount > 0) {
			updateQualityBreakdown(artist.qualityProfileId, profileIdToName, trackFileCount, qualityBreakdown);
		}
	}

	const monitoredAlbums = Math.round(totalAlbums * (monitoredArtists / Math.max(totalArtists, 1)));
	const diskTotals = calculateDiskTotals(diskspace);
	const healthIssuesList = processHealthIssues(health, instanceInfo, "lidarr");

	return lidarrStatisticsSchema.parse({
		totalArtists,
		monitoredArtists,
		totalAlbums,
		monitoredAlbums,
		totalTracks,
		downloadedTracks,
		missingTracks,
		downloadedPercentage: totalTracks > 0 ? clampPercentage((downloadedTracks / totalTracks) * 100) : 0,
		cutoffUnmetCount: toNumber(cutoffUnmet?.totalRecords) ?? 0,
		qualityBreakdown,
		tagBreakdown: finalizeBreakdown(tagBreakdown),
		recentlyAdded7Days,
		recentlyAdded30Days,
		averageTrackSize: downloadedTracks > 0 ? totalFileSize / downloadedTracks : undefined,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskTotals.used || undefined,
		diskUsagePercent: diskTotals.usagePercent,
		healthIssues: healthIssuesList.length,
		healthIssuesList,
	});
};

// ============================================================================
// Readarr Statistics (SDK)
// ============================================================================

export const fetchReadarrStatisticsWithSdk = async (
	client: ReadarrClient,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<ReadarrStatistics> => {
	const instanceInfo: InstanceInfo = { instanceId, instanceName, instanceBaseUrl };

	const [authors, diskspace, health, cutoffUnmetResult, qualityProfiles, tags] = await Promise.all([
		safeRequest(() => client.author.getAll()).then((r) => r ?? []),
		safeRequest(() => client.diskSpace.getAll()).then((r) => r ?? []),
		safeRequest(() => client.health.getAll()).then((r) => r ?? []),
		safeRequest(() => client.wanted.getCutoffUnmet({ page: 1, pageSize: 1 })),
		safeRequest(() => client.qualityProfile.getAll()).then((r) => r ?? []),
		safeRequest(() => client.tag.getAll()).then((r) => r ?? []),
	]);
	const cutoffUnmet = cutoffUnmetResult ?? { totalRecords: 0 };

	const profileIdToName = buildProfileIdToNameMap(qualityProfiles);
	const tagIdToLabel = buildTagIdToLabelMap(tags);
	const thresholds = getTimeThresholds();

	let totalAuthors = 0;
	let monitoredAuthors = 0;
	let totalBooks = 0;
	let monitoredBooks = 0;
	let downloadedBooks = 0;
	let missingBooks = 0;
	let totalFileSize = 0;
	let recentlyAdded7Days = 0;
	let recentlyAdded30Days = 0;
	const qualityBreakdown: Record<string, number> = {};
	const tagBreakdown: Record<string, number> = {};

	for (const author of authors) {
		if (!author) continue;
		totalAuthors += 1;
		if (author.monitored !== false) monitoredAuthors += 1;

		const { within7Days, within30Days } = checkRecentlyAdded(author.added, thresholds);
		if (within7Days) recentlyAdded7Days += 1;
		if (within30Days) recentlyAdded30Days += 1;

		updateTagBreakdown(author.tags, tagIdToLabel, tagBreakdown);

		const stats = author.statistics;
		const bookCount = stats?.bookCount ?? 0;
		const bookFileCount = stats?.bookFileCount ?? 0;
		const sizeOnDisk = stats?.sizeOnDisk ?? 0;

		totalBooks += bookCount;
		downloadedBooks += bookFileCount;
		missingBooks += Math.max(0, bookCount - bookFileCount);
		totalFileSize += sizeOnDisk;

		if (author.monitored !== false) monitoredBooks += bookCount;

		if (bookFileCount > 0) {
			updateQualityBreakdown(author.qualityProfileId, profileIdToName, bookFileCount, qualityBreakdown);
		}
	}

	const diskTotals = calculateDiskTotals(diskspace);
	const healthIssuesList = processHealthIssues(health, instanceInfo, "readarr");

	return readarrStatisticsSchema.parse({
		totalAuthors,
		monitoredAuthors,
		totalBooks,
		monitoredBooks,
		downloadedBooks,
		missingBooks,
		downloadedPercentage: monitoredBooks > 0 ? clampPercentage((downloadedBooks / monitoredBooks) * 100) : 0,
		cutoffUnmetCount: toNumber(cutoffUnmet?.totalRecords) ?? 0,
		qualityBreakdown,
		tagBreakdown: finalizeBreakdown(tagBreakdown),
		recentlyAdded7Days,
		recentlyAdded30Days,
		averageBookSize: downloadedBooks > 0 ? totalFileSize / downloadedBooks : undefined,
		diskTotal: diskTotals.total || undefined,
		diskFree: diskTotals.free || undefined,
		diskUsed: diskTotals.used || undefined,
		diskUsagePercent: diskTotals.usagePercent,
		healthIssues: healthIssuesList.length,
		healthIssuesList,
	});
};

// ============================================================================
// Aggregation Functions
// ============================================================================

export const aggregateSonarrStatistics = (
	instances: Array<{
		storageGroupId?: string | null;
		shouldCountDisk?: boolean;
		data: SonarrStatistics;
	}>,
): SonarrStatistics | undefined => {
	if (instances.length === 0) return undefined;

	const acc = {
		totalSeries: 0,
		monitoredSeries: 0,
		continuingSeries: 0,
		endedSeries: 0,
		totalEpisodes: 0,
		episodeFileCount: 0,
		downloadedEpisodes: 0,
		missingEpisodes: 0,
		diskTotal: 0,
		diskFree: 0,
		diskUsed: 0,
		healthIssues: 0,
		healthIssuesList: [] as HealthIssue[],
		qualityBreakdown: {} as Record<string, number>,
		tagBreakdown: {} as Record<string, number>,
		recentlyAdded7Days: 0,
		recentlyAdded30Days: 0,
		cutoffUnmetCount: 0,
		totalFileSize: 0,
		totalFiles: 0,
	};

	for (const entry of instances) {
		const data = entry.data;
		const shouldCountDisk = entry.shouldCountDisk ?? true;

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

		if (shouldCountDisk) {
			acc.diskTotal += data.diskTotal ?? 0;
			acc.diskFree += data.diskFree ?? 0;
			acc.diskUsed += data.diskUsed ?? 0;
		}

		acc.healthIssues += data.healthIssues ?? 0;
		if (data.healthIssuesList) acc.healthIssuesList.push(...data.healthIssuesList);
		mergeBreakdown(data.qualityBreakdown, acc.qualityBreakdown);
		mergeBreakdown(data.tagBreakdown, acc.tagBreakdown);

		if (data.averageEpisodeSize) {
			acc.totalFileSize += data.averageEpisodeSize * data.episodeFileCount;
			acc.totalFiles += data.episodeFileCount;
		}
	}

	const diskStats = finalizeDiskStats(acc);

	return sonarrStatisticsSchema.parse({
		totalSeries: acc.totalSeries,
		monitoredSeries: acc.monitoredSeries,
		continuingSeries: acc.continuingSeries,
		endedSeries: acc.endedSeries,
		totalEpisodes: acc.totalEpisodes,
		episodeFileCount: acc.episodeFileCount,
		downloadedEpisodes: acc.downloadedEpisodes,
		missingEpisodes: acc.missingEpisodes,
		downloadedPercentage: acc.totalEpisodes > 0 ? clampPercentage((acc.downloadedEpisodes / acc.totalEpisodes) * 100) : 0,
		cutoffUnmetCount: acc.cutoffUnmetCount,
		qualityBreakdown: acc.qualityBreakdown,
		tagBreakdown: finalizeBreakdown(acc.tagBreakdown),
		recentlyAdded7Days: acc.recentlyAdded7Days,
		recentlyAdded30Days: acc.recentlyAdded30Days,
		averageEpisodeSize: acc.totalFiles > 0 ? acc.totalFileSize / acc.totalFiles : undefined,
		...diskStats,
		healthIssues: acc.healthIssues,
		healthIssuesList: acc.healthIssuesList,
	});
};

export const aggregateRadarrStatistics = (
	instances: Array<{
		storageGroupId?: string | null;
		shouldCountDisk?: boolean;
		data: RadarrStatistics;
	}>,
): RadarrStatistics | undefined => {
	if (instances.length === 0) return undefined;

	const acc = {
		totalMovies: 0,
		monitoredMovies: 0,
		downloadedMovies: 0,
		missingMovies: 0,
		totalRuntime: 0,
		diskTotal: 0,
		diskFree: 0,
		diskUsed: 0,
		healthIssues: 0,
		healthIssuesList: [] as HealthIssue[],
		qualityBreakdown: {} as Record<string, number>,
		tagBreakdown: {} as Record<string, number>,
		recentlyAdded7Days: 0,
		recentlyAdded30Days: 0,
		cutoffUnmetCount: 0,
		totalFileSize: 0,
		totalFiles: 0,
	};

	for (const entry of instances) {
		const data = entry.data;
		const shouldCountDisk = entry.shouldCountDisk ?? true;

		acc.totalMovies += data.totalMovies;
		acc.monitoredMovies += data.monitoredMovies;
		acc.downloadedMovies += data.downloadedMovies;
		acc.missingMovies += data.missingMovies;
		acc.totalRuntime += data.totalRuntime ?? 0;
		acc.cutoffUnmetCount += data.cutoffUnmetCount ?? 0;
		acc.recentlyAdded7Days += data.recentlyAdded7Days ?? 0;
		acc.recentlyAdded30Days += data.recentlyAdded30Days ?? 0;

		if (shouldCountDisk) {
			acc.diskTotal += data.diskTotal ?? 0;
			acc.diskFree += data.diskFree ?? 0;
			acc.diskUsed += data.diskUsed ?? 0;
		}

		acc.healthIssues += data.healthIssues ?? 0;
		if (data.healthIssuesList) acc.healthIssuesList.push(...data.healthIssuesList);
		mergeBreakdown(data.qualityBreakdown, acc.qualityBreakdown);
		mergeBreakdown(data.tagBreakdown, acc.tagBreakdown);

		if (data.averageMovieSize) {
			acc.totalFileSize += data.averageMovieSize * data.downloadedMovies;
			acc.totalFiles += data.downloadedMovies;
		}
	}

	const diskStats = finalizeDiskStats(acc);

	return radarrStatisticsSchema.parse({
		totalMovies: acc.totalMovies,
		monitoredMovies: acc.monitoredMovies,
		downloadedMovies: acc.downloadedMovies,
		missingMovies: acc.missingMovies,
		downloadedPercentage: acc.monitoredMovies > 0 ? clampPercentage((acc.downloadedMovies / acc.monitoredMovies) * 100) : 0,
		cutoffUnmetCount: acc.cutoffUnmetCount,
		qualityBreakdown: acc.qualityBreakdown,
		tagBreakdown: finalizeBreakdown(acc.tagBreakdown),
		recentlyAdded7Days: acc.recentlyAdded7Days,
		recentlyAdded30Days: acc.recentlyAdded30Days,
		totalRuntime: acc.totalRuntime > 0 ? acc.totalRuntime : undefined,
		averageMovieSize: acc.totalFiles > 0 ? acc.totalFileSize / acc.totalFiles : undefined,
		...diskStats,
		healthIssues: acc.healthIssues,
		healthIssuesList: acc.healthIssuesList,
	});
};

export const aggregateProwlarrStatistics = (
	instances: Array<{ data: ProwlarrStatistics }>,
): ProwlarrStatistics | undefined => {
	if (instances.length === 0) return undefined;

	const acc = {
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
		healthIssuesList: [] as HealthIssue[],
		responseTimes: [] as number[],
		indexers: [] as ProwlarrIndexerStat[],
	};

	for (const entry of instances) {
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
		if (data.healthIssuesList) acc.healthIssuesList.push(...data.healthIssuesList);
		if (typeof data.averageResponseTime === "number" && Number.isFinite(data.averageResponseTime)) {
			acc.responseTimes.push(data.averageResponseTime);
		}
		acc.indexers.push(...data.indexers);
	}

	// Aggregate indexers by name (case-insensitive)
	const indexerMap = new Map<string, { displayName: string; queries: number; grabs: number; successRateSum: number; count: number }>();
	for (const entry of acc.indexers) {
		const key = (entry.name.trim() || "indexer").toLowerCase();
		const existing = indexerMap.get(key);
		if (existing) {
			existing.queries += entry.queries;
			existing.grabs += entry.grabs;
			existing.successRateSum += entry.successRate;
			existing.count += 1;
		} else {
			indexerMap.set(key, {
				displayName: entry.name.trim() || "Indexer",
				queries: entry.queries,
				grabs: entry.grabs,
				successRateSum: entry.successRate,
				count: 1,
			});
		}
	}

	const aggregatedIndexers = Array.from(indexerMap.values())
		.map((agg) => prowlarrIndexerStatSchema.parse({
			name: agg.displayName,
			queries: agg.queries,
			grabs: agg.grabs,
			successRate: clampPercentage(agg.successRateSum / Math.max(agg.count, 1)),
		}))
		.sort((a, b) => b.queries - a.queries)
		.slice(0, 10);

	return prowlarrStatisticsSchema.parse({
		totalIndexers: acc.totalIndexers,
		activeIndexers: acc.activeIndexers,
		pausedIndexers: acc.pausedIndexers,
		totalQueries: acc.totalQueries,
		totalGrabs: acc.totalGrabs,
		successfulQueries: acc.successfulQueries,
		failedQueries: acc.failedQueries,
		successfulGrabs: acc.successfulGrabs,
		failedGrabs: acc.failedGrabs,
		grabRate: acc.totalQueries > 0 ? clampPercentage((acc.totalGrabs / acc.totalQueries) * 100) : 0,
		averageResponseTime: acc.responseTimes.length > 0
			? acc.responseTimes.reduce((sum, v) => sum + v, 0) / acc.responseTimes.length
			: undefined,
		healthIssues: acc.healthIssues,
		healthIssuesList: acc.healthIssuesList,
		indexers: aggregatedIndexers,
	});
};

export const aggregateLidarrStatistics = (
	instances: Array<{
		storageGroupId?: string | null;
		shouldCountDisk?: boolean;
		data: LidarrStatistics;
	}>,
): LidarrStatistics | undefined => {
	if (instances.length === 0) return undefined;

	const acc = {
		totalArtists: 0,
		monitoredArtists: 0,
		totalAlbums: 0,
		monitoredAlbums: 0,
		totalTracks: 0,
		downloadedTracks: 0,
		missingTracks: 0,
		diskTotal: 0,
		diskFree: 0,
		diskUsed: 0,
		healthIssues: 0,
		healthIssuesList: [] as HealthIssue[],
		qualityBreakdown: {} as Record<string, number>,
		tagBreakdown: {} as Record<string, number>,
		recentlyAdded7Days: 0,
		recentlyAdded30Days: 0,
		cutoffUnmetCount: 0,
		totalFileSize: 0,
		totalFiles: 0,
	};

	for (const entry of instances) {
		const data = entry.data;
		const shouldCountDisk = entry.shouldCountDisk ?? true;

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

		if (shouldCountDisk) {
			acc.diskTotal += data.diskTotal ?? 0;
			acc.diskFree += data.diskFree ?? 0;
			acc.diskUsed += data.diskUsed ?? 0;
		}

		acc.healthIssues += data.healthIssues ?? 0;
		if (data.healthIssuesList) acc.healthIssuesList.push(...data.healthIssuesList);
		mergeBreakdown(data.qualityBreakdown, acc.qualityBreakdown);
		mergeBreakdown(data.tagBreakdown, acc.tagBreakdown);

		if (data.averageTrackSize) {
			acc.totalFileSize += data.averageTrackSize * data.downloadedTracks;
			acc.totalFiles += data.downloadedTracks;
		}
	}

	const diskStats = finalizeDiskStats(acc);

	return lidarrStatisticsSchema.parse({
		totalArtists: acc.totalArtists,
		monitoredArtists: acc.monitoredArtists,
		totalAlbums: acc.totalAlbums,
		monitoredAlbums: acc.monitoredAlbums,
		totalTracks: acc.totalTracks,
		downloadedTracks: acc.downloadedTracks,
		missingTracks: acc.missingTracks,
		downloadedPercentage: acc.totalTracks > 0 ? clampPercentage((acc.downloadedTracks / acc.totalTracks) * 100) : 0,
		cutoffUnmetCount: acc.cutoffUnmetCount,
		qualityBreakdown: acc.qualityBreakdown,
		tagBreakdown: finalizeBreakdown(acc.tagBreakdown),
		recentlyAdded7Days: acc.recentlyAdded7Days,
		recentlyAdded30Days: acc.recentlyAdded30Days,
		averageTrackSize: acc.totalFiles > 0 ? acc.totalFileSize / acc.totalFiles : undefined,
		...diskStats,
		healthIssues: acc.healthIssues,
		healthIssuesList: acc.healthIssuesList,
	});
};

export const aggregateReadarrStatistics = (
	instances: Array<{
		storageGroupId?: string | null;
		shouldCountDisk?: boolean;
		data: ReadarrStatistics;
	}>,
): ReadarrStatistics | undefined => {
	if (instances.length === 0) return undefined;

	const acc = {
		totalAuthors: 0,
		monitoredAuthors: 0,
		totalBooks: 0,
		monitoredBooks: 0,
		downloadedBooks: 0,
		missingBooks: 0,
		diskTotal: 0,
		diskFree: 0,
		diskUsed: 0,
		healthIssues: 0,
		healthIssuesList: [] as HealthIssue[],
		qualityBreakdown: {} as Record<string, number>,
		tagBreakdown: {} as Record<string, number>,
		recentlyAdded7Days: 0,
		recentlyAdded30Days: 0,
		cutoffUnmetCount: 0,
		totalFileSize: 0,
		totalFiles: 0,
	};

	for (const entry of instances) {
		const data = entry.data;
		const shouldCountDisk = entry.shouldCountDisk ?? true;

		acc.totalAuthors += data.totalAuthors;
		acc.monitoredAuthors += data.monitoredAuthors;
		acc.totalBooks += data.totalBooks;
		acc.monitoredBooks += data.monitoredBooks;
		acc.downloadedBooks += data.downloadedBooks;
		acc.missingBooks += data.missingBooks;
		acc.cutoffUnmetCount += data.cutoffUnmetCount ?? 0;
		acc.recentlyAdded7Days += data.recentlyAdded7Days ?? 0;
		acc.recentlyAdded30Days += data.recentlyAdded30Days ?? 0;

		if (shouldCountDisk) {
			acc.diskTotal += data.diskTotal ?? 0;
			acc.diskFree += data.diskFree ?? 0;
			acc.diskUsed += data.diskUsed ?? 0;
		}

		acc.healthIssues += data.healthIssues ?? 0;
		if (data.healthIssuesList) acc.healthIssuesList.push(...data.healthIssuesList);
		mergeBreakdown(data.qualityBreakdown, acc.qualityBreakdown);
		mergeBreakdown(data.tagBreakdown, acc.tagBreakdown);

		if (data.averageBookSize) {
			acc.totalFileSize += data.averageBookSize * data.downloadedBooks;
			acc.totalFiles += data.downloadedBooks;
		}
	}

	const diskStats = finalizeDiskStats(acc);

	return readarrStatisticsSchema.parse({
		totalAuthors: acc.totalAuthors,
		monitoredAuthors: acc.monitoredAuthors,
		totalBooks: acc.totalBooks,
		monitoredBooks: acc.monitoredBooks,
		downloadedBooks: acc.downloadedBooks,
		missingBooks: acc.missingBooks,
		downloadedPercentage: acc.monitoredBooks > 0 ? clampPercentage((acc.downloadedBooks / acc.monitoredBooks) * 100) : 0,
		cutoffUnmetCount: acc.cutoffUnmetCount,
		qualityBreakdown: acc.qualityBreakdown,
		tagBreakdown: finalizeBreakdown(acc.tagBreakdown),
		recentlyAdded7Days: acc.recentlyAdded7Days,
		recentlyAdded30Days: acc.recentlyAdded30Days,
		averageBookSize: acc.totalFiles > 0 ? acc.totalFileSize / acc.totalFiles : undefined,
		...diskStats,
		healthIssues: acc.healthIssues,
		healthIssuesList: acc.healthIssuesList,
	});
};
