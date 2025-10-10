import {
	type ProwlarrIndexerStat,
	type ProwlarrStatistics,
	type RadarrStatistics,
	type SonarrStatistics,
	prowlarrIndexerStatSchema,
	prowlarrStatisticsSchema,
	radarrStatisticsSchema,
	sonarrStatisticsSchema,
} from "@arr/shared";

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
interface MovieStatistics {
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
interface HistoryResponse {
	records?: unknown;
	totalRecords?: unknown;
}

/**
 * Interface for indexer entries
 */
interface IndexerEntry {
	enable?: unknown;
}

const sumNumbers = (values: Array<number | undefined>): number => {
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

export const fetchSonarrStatistics = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	instanceId: string,
	instanceName: string,
	instanceBaseUrl: string,
): Promise<SonarrStatistics> => {
	const series = (await safeRequestJson<unknown[]>(fetcher, "/api/v3/series")) ?? [];
	const diskspace = (await safeRequestJson<unknown[]>(fetcher, "/api/v3/diskspace")) ?? [];
	const health = (await safeRequestJson<unknown[]>(fetcher, "/api/v3/system/health")) ?? [];
	const cutoffUnmet: CutoffUnmetResponse =
		(await safeRequestJson<CutoffUnmetResponse>(
			fetcher,
			"/api/v3/wanted/cutoff?page=1&pageSize=1",
		)) ?? {};
	const qualityProfiles =
		(await safeRequestJson<unknown[]>(fetcher, "/api/v3/qualityprofile")) ?? [];

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

	let totalSeries = 0;
	let monitoredSeries = 0;
	let continuingSeries = 0;
	let endedSeries = 0;
	let totalEpisodes = 0;
	let episodeFileCount = 0;
	let downloadedEpisodes = 0;
	let missingEpisodes = 0;
	let totalFileSize = 0;

	// Track quality distribution based on quality profiles
	const qualityBreakdown: Record<string, number> = {};

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

	// Log all health items for debugging
	console.log(`[Sonarr ${instanceName}] Health check returned ${health.length} items:`, JSON.stringify(health, null, 2));

	const healthIssuesList = Array.isArray(health)
		? health
				.filter((item) => {
					const healthItem = item as HealthEntry;
					const type = toStringValue(healthItem?.type);
					console.log(`[Sonarr ${instanceName}] Health item type: "${type}"`);
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
	console.log(`[Sonarr ${instanceName}] Filtered to ${healthIssues} health issues`);

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
	const movies = (await safeRequestJson<unknown[]>(fetcher, "/api/v3/movie")) ?? [];
	const diskspace = (await safeRequestJson<unknown[]>(fetcher, "/api/v3/diskspace")) ?? [];
	const health = (await safeRequestJson<unknown[]>(fetcher, "/api/v3/system/health")) ?? [];
	const cutoffUnmet: CutoffUnmetResponse =
		(await safeRequestJson<CutoffUnmetResponse>(
			fetcher,
			"/api/v3/wanted/cutoff?page=1&pageSize=1",
		)) ?? {};
	const qualityProfiles =
		(await safeRequestJson<unknown[]>(fetcher, "/api/v3/qualityprofile")) ?? [];

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

	let monitoredMovies = 0;
	let downloadedMovies = 0;
	let totalFileSize = 0;

	const qualityBreakdown: Record<string, number> = {};

	for (const movie of movies) {
		if (!movie || typeof movie !== "object") {
			continue;
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

	// Log all health items for debugging
	console.log(`[Radarr ${instanceName}] Health check returned ${health.length} items:`, JSON.stringify(health, null, 2));

	const healthIssuesList = Array.isArray(health)
		? health
				.filter((item) => {
					const healthItem = item as HealthEntry;
					const type = toStringValue(healthItem?.type);
					console.log(`[Radarr ${instanceName}] Health item type: "${type}"`);
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
	console.log(`[Radarr ${instanceName}] Filtered to ${healthIssues} health issues`);

	return radarrStatisticsSchema.parse({
		totalMovies,
		monitoredMovies,
		downloadedMovies,
		missingMovies,
		downloadedPercentage:
			monitoredMovies > 0 ? clampPercentage((downloadedMovies / monitoredMovies) * 100) : 0,
		cutoffUnmetCount,
		qualityBreakdown,
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

	// Fetch history from last 30 days for more accurate statistics
	const thirtyDaysAgo = new Date();
	thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
	const startDate = thirtyDaysAgo.toISOString();

	// Fetch multiple pages if needed (up to 5000 records total)
	const historyRecords: unknown[] = [];
	const pageSize = 1000;
	const maxPages = 5;

	for (let page = 1; page <= maxPages; page++) {
		const history: HistoryResponse =
			(await safeRequestJson<HistoryResponse>(
				fetcher,
				`/api/v1/history?page=${page}&pageSize=${pageSize}&eventType=1&eventType=2&eventType=3`,
			)) ?? {};

		const records = Array.isArray(history.records) ? history.records : [];
		if (records.length === 0) {
			break; // No more records
		}

		historyRecords.push(...records);

		// If we got fewer records than the page size, we've reached the end
		if (records.length < pageSize) {
			break;
		}

		// Check if we've exceeded total records available
		const totalRecords = toNumber(history.totalRecords) ?? 0;
		if (historyRecords.length >= totalRecords) {
			break;
		}
	}

	const totalIndexers = indexers.length;
	const activeIndexers = indexers.filter((entry) => {
		const indexerEntry = entry as IndexerEntry;
		return entry && indexerEntry.enable !== false;
	}).length;
	const pausedIndexers = totalIndexers - activeIndexers;

	// Create indexer ID to name mapping
	const indexerIdToName = new Map<number, string>();
	for (const indexer of indexers) {
		if (indexer && typeof indexer === "object") {
			const id = toNumber((indexer as { id?: unknown }).id);
			const name = toStringValue((indexer as { name?: unknown }).name);
			if (id !== undefined && name) {
				indexerIdToName.set(id, name);
			}
		}
	}

	// Build statistics from history records
	const indexerStatsMap = new Map<string, { queries: number; grabs: number; successful: number }>();

	for (const record of historyRecords) {
		if (!record || typeof record !== "object") {
			continue;
		}

		// Try to get indexer ID and map it to name
		const indexerId = toNumber(
			(record as { indexerId?: unknown; indexer?: unknown }).indexerId ??
				(record as { indexerId?: unknown; indexer?: unknown }).indexer,
		);
		let indexerName = "Unknown";

		if (indexerId !== undefined && indexerIdToName.has(indexerId)) {
			const name = indexerIdToName.get(indexerId);
			if (name !== undefined) {
				indexerName = name;
			}
		} else {
			// Fallback to direct name field
			indexerName =
				toStringValue((record as { indexer?: unknown }).indexer) ??
				toStringValue((record as { indexerName?: unknown }).indexerName) ??
				"Unknown";
		}

		const eventType =
			toStringValue((record as { eventType?: unknown }).eventType)?.toLowerCase() ?? "";
		const successful = (record as { successful?: unknown }).successful !== false;

		if (!indexerStatsMap.has(indexerName)) {
			indexerStatsMap.set(indexerName, { queries: 0, grabs: 0, successful: 0 });
		}

		const stats = indexerStatsMap.get(indexerName);
		if (stats === undefined) {
			continue;
		}

		// Count queries (any event is a query)
		stats.queries += 1;
		if (successful) {
			stats.successful += 1;
		}

		// Count grabs (specific event type)
		if (
			eventType === "grab" ||
			eventType === "releaseGrabbed" ||
			eventType === "grabbed" ||
			eventType === "releasegrab"
		) {
			stats.grabs += 1;
		}
	}

	// Convert to normalized stats
	const normalizedStats: ProwlarrIndexerStat[] = Array.from(indexerStatsMap.entries())
		.map(([name, stats]) => {
			const successRate = stats.queries > 0 ? (stats.successful / stats.queries) * 100 : 0;

			return prowlarrIndexerStatSchema.parse({
				name,
				queries: stats.queries,
				grabs: stats.grabs,
				successRate: clampPercentage(successRate),
			});
		})
		.filter((entry) => entry.queries > 0 || entry.grabs > 0);

	const totalQueries = sumNumbers(normalizedStats.map((entry) => entry.queries));
	const totalGrabs = sumNumbers(normalizedStats.map((entry) => entry.grabs));

	let successfulQueries = 0;
	let failedQueries = 0;

	for (const stat of normalizedStats) {
		const querySuccessCount = Math.round((stat.queries * stat.successRate) / 100);
		successfulQueries += querySuccessCount;
		failedQueries += stat.queries - querySuccessCount;
	}

	const grabRate = totalQueries > 0 ? clampPercentage((totalGrabs / totalQueries) * 100) : 0;

	// Log all health items for debugging
	console.log(`[Prowlarr ${instanceName}] Health check returned ${health.length} items:`, JSON.stringify(health, null, 2));

	const healthIssuesList = Array.isArray(health)
		? health
				.filter((item) => {
					const healthItem = item as HealthEntry;
					const type = toStringValue(healthItem?.type);
					console.log(`[Prowlarr ${instanceName}] Health item type: "${type}"`);
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
	console.log(`[Prowlarr ${instanceName}] Filtered to ${healthIssues} health issues`);

	const topIndexers = normalizedStats.sort((a, b) => b.queries - a.queries).slice(0, 10);

	return prowlarrStatisticsSchema.parse({
		totalIndexers,
		activeIndexers,
		pausedIndexers,
		totalQueries,
		totalGrabs,
		successfulQueries,
		failedQueries,
		successfulGrabs: totalGrabs,
		failedGrabs: Math.max(0, totalQueries - totalGrabs),
		grabRate,
		averageResponseTime: undefined,
		healthIssues,
		healthIssuesList,
		indexers: topIndexers,
	});
};

export const aggregateSonarrStatistics = (
	instances: Array<{ data: SonarrStatistics }>,
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
			acc.diskTotal += data.diskTotal ?? 0;
			acc.diskFree += data.diskFree ?? 0;
			acc.diskUsed += data.diskUsed ?? 0;
			acc.healthIssues += data.healthIssues ?? 0;
			if (data.healthIssuesList) {
				acc.healthIssuesList?.push(...data.healthIssuesList);
			}
			if (data.qualityBreakdown) {
				for (const [profileName, count] of Object.entries(data.qualityBreakdown)) {
					acc.qualityBreakdown[profileName] = (acc.qualityBreakdown[profileName] ?? 0) + count;
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
			diskTotal: 0,
			diskFree: 0,
			diskUsed: 0,
			healthIssues: 0,
			healthIssuesList: [] as SonarrStatistics["healthIssuesList"],
			qualityBreakdown: {} as Record<string, number>,
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
	instances: Array<{ data: RadarrStatistics }>,
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
			acc.diskTotal += data.diskTotal ?? 0;
			acc.diskFree += data.diskFree ?? 0;
			acc.diskUsed += data.diskUsed ?? 0;
			acc.healthIssues += data.healthIssues ?? 0;
			if (data.healthIssuesList) {
				acc.healthIssuesList?.push(...data.healthIssuesList);
			}
			if (data.qualityBreakdown) {
				for (const [profileName, count] of Object.entries(data.qualityBreakdown)) {
					acc.qualityBreakdown[profileName] = (acc.qualityBreakdown[profileName] ?? 0) + count;
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
			diskTotal: 0,
			diskFree: 0,
			diskUsed: 0,
			healthIssues: 0,
			healthIssuesList: [] as RadarrStatistics["healthIssuesList"],
			qualityBreakdown: {} as Record<string, number>,
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
