/**
 * Statistics Data Hook
 *
 * Handles data aggregation and transformation for statistics dashboard.
 * Centralizes business logic for computing totals across service instances.
 */

import type {
	CombinedDiskStats,
	HealthIssue,
	LidarrStatistics,
	ProwlarrStatistics,
	RadarrStatistics,
	ReadarrStatistics,
	SonarrStatistics,
} from "@arr/shared";
import { useMemo } from "react";
import { useDashboardStatisticsQuery } from "../../../hooks/api/useDashboard";
import { resolveDashboardStatisticsState } from "../../../lib/dashboard-statistics-state";

/**
 * Generic sum utility for reducing instance data
 */
const sum = <T>(rows: Array<{ data: T }>, selector: (value: T) => number | undefined) =>
	rows.reduce((total, row) => total + (selector(row.data) ?? 0), 0);

/**
 * Calculate percentage with zero-division protection
 */
const calculatePercent = (numerator: number, denominator: number) =>
	denominator > 0 ? (numerator / denominator) * 100 : 0;

/**
 * Build Sonarr table rows from instance data
 */
const buildSonarrRows = (
	instances: Array<{
		instanceId: string;
		instanceName: string;
		data: SonarrStatistics;
	}>,
) =>
	instances.map((entry) => ({
		instanceId: entry.instanceId,
		instanceName: entry.instanceName,
		...entry.data,
	}));

/**
 * Build Radarr table rows from instance data
 */
const buildRadarrRows = (
	instances: Array<{
		instanceId: string;
		instanceName: string;
		data: RadarrStatistics;
	}>,
) =>
	instances.map((entry) => ({
		instanceId: entry.instanceId,
		instanceName: entry.instanceName,
		...entry.data,
	}));

/**
 * Build Prowlarr table rows from instance data
 */
const buildProwlarrRows = (
	instances: Array<{
		instanceId: string;
		instanceName: string;
		data: ProwlarrStatistics;
	}>,
) =>
	instances.map((entry) => ({
		instanceId: entry.instanceId,
		instanceName: entry.instanceName,
		...entry.data,
	}));

/**
 * Build Lidarr table rows from instance data
 */
const buildLidarrRows = (
	instances: Array<{
		instanceId: string;
		instanceName: string;
		data: LidarrStatistics;
	}>,
) =>
	instances.map((entry) => ({
		instanceId: entry.instanceId,
		instanceName: entry.instanceName,
		...entry.data,
	}));

/**
 * Build Readarr table rows from instance data
 */
const buildReadarrRows = (
	instances: Array<{
		instanceId: string;
		instanceName: string;
		data: ReadarrStatistics;
	}>,
) =>
	instances.map((entry) => ({
		instanceId: entry.instanceId,
		instanceName: entry.instanceName,
		...entry.data,
	}));

/**
 * Hook for statistics data aggregation and transformation
 *
 * @returns Aggregated statistics and table rows for all service types
 */
export const useStatisticsData = () => {
	const { data: envelope, isLoading, isFetching, error, refetch } = useDashboardStatisticsQuery();
	const state = resolveDashboardStatisticsState(envelope, error, Date.now());
	const data = state.data;
	const incompleteServices = useMemo(() => {
		const services = ["sonarr", "radarr", "prowlarr", "lidarr", "readarr"] as const;
		return services.filter((service) => data?.[service]?.instances.some((entry) => entry.error));
	}, [data]);
	const configuredInstanceCounts = useMemo(
		() => ({
			sonarr: data?.sonarr.instances.length ?? 0,
			radarr: data?.radarr.instances.length ?? 0,
			prowlarr: data?.prowlarr.instances.length ?? 0,
			lidarr: data?.lidarr?.instances.length ?? 0,
			readarr: data?.readarr?.instances.length ?? 0,
		}),
		[data],
	);

	// Memoize instance arrays to prevent dependency changes on every render
	const sonarrInstances = useMemo(
		() => data?.sonarr.instances.filter((entry) => !entry.error) ?? [],
		[data?.sonarr.instances],
	);
	const radarrInstances = useMemo(
		() => data?.radarr.instances.filter((entry) => !entry.error) ?? [],
		[data?.radarr.instances],
	);
	const prowlarrInstances = useMemo(
		() => data?.prowlarr.instances.filter((entry) => !entry.error) ?? [],
		[data?.prowlarr.instances],
	);
	const lidarrInstances = useMemo(
		() => data?.lidarr?.instances.filter((entry) => !entry.error) ?? [],
		[data?.lidarr?.instances],
	);
	const readarrInstances = useMemo(
		() => data?.readarr?.instances.filter((entry) => !entry.error) ?? [],
		[data?.readarr?.instances],
	);

	const sonarrRows = useMemo(() => buildSonarrRows(sonarrInstances), [sonarrInstances]);
	const radarrRows = useMemo(() => buildRadarrRows(radarrInstances), [radarrInstances]);
	const prowlarrRows = useMemo(() => buildProwlarrRows(prowlarrInstances), [prowlarrInstances]);
	const lidarrRows = useMemo(() => buildLidarrRows(lidarrInstances), [lidarrInstances]);
	const readarrRows = useMemo(() => buildReadarrRows(readarrInstances), [readarrInstances]);

	const sonarrAggregate = data?.sonarr.aggregate;
	const radarrAggregate = data?.radarr.aggregate;
	const prowlarrAggregate = data?.prowlarr.aggregate;
	const lidarrAggregate = data?.lidarr?.aggregate;
	const readarrAggregate = data?.readarr?.aggregate;

	// Sonarr totals with fallback aggregation
	const sonarrTotals = useMemo(
		() => ({
			totalSeries:
				sonarrAggregate?.totalSeries ?? sum(sonarrInstances, (stats) => stats.totalSeries),
			monitoredSeries:
				sonarrAggregate?.monitoredSeries ?? sum(sonarrInstances, (stats) => stats.monitoredSeries),
			downloadedEpisodes:
				sonarrAggregate?.downloadedEpisodes ??
				sum(sonarrInstances, (stats) => stats.downloadedEpisodes),
			missingEpisodes:
				sonarrAggregate?.missingEpisodes ?? sum(sonarrInstances, (stats) => stats.missingEpisodes),
			downloadPercent:
				sonarrAggregate?.downloadedPercentage ??
				calculatePercent(
					sum(sonarrInstances, (stats) => stats.downloadedEpisodes),
					Math.max(
						sum(sonarrInstances, (stats) => stats.totalEpisodes),
						1,
					),
				),
			diskUsed: sonarrAggregate?.diskUsed ?? sum(sonarrInstances, (stats) => stats.diskUsed),
			diskTotal: sonarrAggregate?.diskTotal ?? sum(sonarrInstances, (stats) => stats.diskTotal),
			diskPercent:
				sonarrAggregate?.diskUsagePercent ??
				calculatePercent(
					sum(sonarrInstances, (stats) => stats.diskUsed),
					Math.max(
						sum(sonarrInstances, (stats) => stats.diskTotal),
						1,
					),
				),
			healthIssues:
				sonarrAggregate?.healthIssues ?? sum(sonarrInstances, (stats) => stats.healthIssues),
			continuingSeries:
				sonarrAggregate?.continuingSeries ??
				sum(sonarrInstances, (stats) => stats.continuingSeries),
			endedSeries:
				sonarrAggregate?.endedSeries ?? sum(sonarrInstances, (stats) => stats.endedSeries),
			cutoffUnmetCount:
				sonarrAggregate?.cutoffUnmetCount ??
				sum(sonarrInstances, (stats) => stats.cutoffUnmetCount),
			averageEpisodeSize: sonarrAggregate?.averageEpisodeSize,
			qualityBreakdown: sonarrAggregate?.qualityBreakdown,
			tagBreakdown: sonarrAggregate?.tagBreakdown,
			recentlyAdded7Days:
				sonarrAggregate?.recentlyAdded7Days ??
				sum(sonarrInstances, (stats) => stats.recentlyAdded7Days),
			recentlyAdded30Days:
				sonarrAggregate?.recentlyAdded30Days ??
				sum(sonarrInstances, (stats) => stats.recentlyAdded30Days),
		}),
		[sonarrAggregate, sonarrInstances],
	);

	// Radarr totals with fallback aggregation
	const radarrTotals = useMemo(
		() => ({
			totalMovies:
				radarrAggregate?.totalMovies ?? sum(radarrInstances, (stats) => stats.totalMovies),
			monitoredMovies:
				radarrAggregate?.monitoredMovies ?? sum(radarrInstances, (stats) => stats.monitoredMovies),
			downloadedMovies:
				radarrAggregate?.downloadedMovies ??
				sum(radarrInstances, (stats) => stats.downloadedMovies),
			missingMovies:
				radarrAggregate?.missingMovies ?? sum(radarrInstances, (stats) => stats.missingMovies),
			downloadPercent:
				radarrAggregate?.downloadedPercentage ??
				calculatePercent(
					sum(radarrInstances, (stats) => stats.downloadedMovies),
					Math.max(
						sum(radarrInstances, (stats) => stats.monitoredMovies),
						1,
					),
				),
			diskUsed: radarrAggregate?.diskUsed ?? sum(radarrInstances, (stats) => stats.diskUsed),
			diskTotal: radarrAggregate?.diskTotal ?? sum(radarrInstances, (stats) => stats.diskTotal),
			diskPercent:
				radarrAggregate?.diskUsagePercent ??
				calculatePercent(
					sum(radarrInstances, (stats) => stats.diskUsed),
					Math.max(
						sum(radarrInstances, (stats) => stats.diskTotal),
						1,
					),
				),
			healthIssues:
				radarrAggregate?.healthIssues ?? sum(radarrInstances, (stats) => stats.healthIssues),
			cutoffUnmetCount:
				radarrAggregate?.cutoffUnmetCount ??
				sum(radarrInstances, (stats) => stats.cutoffUnmetCount),
			averageMovieSize: radarrAggregate?.averageMovieSize,
			qualityBreakdown: radarrAggregate?.qualityBreakdown,
			tagBreakdown: radarrAggregate?.tagBreakdown,
			recentlyAdded7Days:
				radarrAggregate?.recentlyAdded7Days ??
				sum(radarrInstances, (stats) => stats.recentlyAdded7Days),
			recentlyAdded30Days:
				radarrAggregate?.recentlyAdded30Days ??
				sum(radarrInstances, (stats) => stats.recentlyAdded30Days),
			totalRuntime:
				radarrAggregate?.totalRuntime ?? sum(radarrInstances, (stats) => stats.totalRuntime),
		}),
		[radarrAggregate, radarrInstances],
	);

	// Prowlarr totals with fallback aggregation
	const prowlarrTotals = useMemo(
		() => ({
			totalIndexers:
				prowlarrAggregate?.totalIndexers ?? sum(prowlarrInstances, (stats) => stats.totalIndexers),
			activeIndexers:
				prowlarrAggregate?.activeIndexers ??
				sum(prowlarrInstances, (stats) => stats.activeIndexers),
			pausedIndexers:
				prowlarrAggregate?.pausedIndexers ??
				sum(prowlarrInstances, (stats) => stats.pausedIndexers),
			totalQueries:
				prowlarrAggregate?.totalQueries ?? sum(prowlarrInstances, (stats) => stats.totalQueries),
			totalGrabs:
				prowlarrAggregate?.totalGrabs ?? sum(prowlarrInstances, (stats) => stats.totalGrabs),
			successfulQueries:
				prowlarrAggregate?.successfulQueries ??
				sum(prowlarrInstances, (stats) => stats.successfulQueries),
			failedQueries:
				prowlarrAggregate?.failedQueries ?? sum(prowlarrInstances, (stats) => stats.failedQueries),
			successfulGrabs:
				prowlarrAggregate?.successfulGrabs ??
				sum(prowlarrInstances, (stats) => stats.successfulGrabs),
			failedGrabs:
				prowlarrAggregate?.failedGrabs ?? sum(prowlarrInstances, (stats) => stats.failedGrabs),
			grabRate: prowlarrAggregate?.grabRate,
			averageResponseTime: prowlarrAggregate?.averageResponseTime,
			healthIssues:
				prowlarrAggregate?.healthIssues ?? sum(prowlarrInstances, (stats) => stats.healthIssues),
			indexers: prowlarrAggregate?.indexers ?? [],
		}),
		[prowlarrAggregate, prowlarrInstances],
	);

	// Lidarr totals with fallback aggregation
	const lidarrTotals = useMemo(
		() => ({
			totalArtists:
				lidarrAggregate?.totalArtists ?? sum(lidarrInstances, (stats) => stats.totalArtists),
			monitoredArtists:
				lidarrAggregate?.monitoredArtists ??
				sum(lidarrInstances, (stats) => stats.monitoredArtists),
			totalAlbums:
				lidarrAggregate?.totalAlbums ?? sum(lidarrInstances, (stats) => stats.totalAlbums),
			monitoredAlbums:
				lidarrAggregate?.monitoredAlbums ?? sum(lidarrInstances, (stats) => stats.monitoredAlbums),
			totalTracks:
				lidarrAggregate?.totalTracks ?? sum(lidarrInstances, (stats) => stats.totalTracks),
			downloadedTracks:
				lidarrAggregate?.downloadedTracks ??
				sum(lidarrInstances, (stats) => stats.downloadedTracks),
			missingTracks:
				lidarrAggregate?.missingTracks ?? sum(lidarrInstances, (stats) => stats.missingTracks),
			downloadPercent:
				lidarrAggregate?.downloadedPercentage ??
				calculatePercent(
					sum(lidarrInstances, (stats) => stats.downloadedTracks),
					Math.max(
						sum(lidarrInstances, (stats) => stats.totalTracks),
						1,
					),
				),
			diskUsed: lidarrAggregate?.diskUsed ?? sum(lidarrInstances, (stats) => stats.diskUsed),
			diskTotal: lidarrAggregate?.diskTotal ?? sum(lidarrInstances, (stats) => stats.diskTotal),
			diskPercent:
				lidarrAggregate?.diskUsagePercent ??
				calculatePercent(
					sum(lidarrInstances, (stats) => stats.diskUsed),
					Math.max(
						sum(lidarrInstances, (stats) => stats.diskTotal),
						1,
					),
				),
			healthIssues:
				lidarrAggregate?.healthIssues ?? sum(lidarrInstances, (stats) => stats.healthIssues),
			cutoffUnmetCount:
				lidarrAggregate?.cutoffUnmetCount ??
				sum(lidarrInstances, (stats) => stats.cutoffUnmetCount),
			averageTrackSize: lidarrAggregate?.averageTrackSize,
			qualityBreakdown: lidarrAggregate?.qualityBreakdown,
			tagBreakdown: lidarrAggregate?.tagBreakdown,
			recentlyAdded7Days:
				lidarrAggregate?.recentlyAdded7Days ??
				sum(lidarrInstances, (stats) => stats.recentlyAdded7Days),
			recentlyAdded30Days:
				lidarrAggregate?.recentlyAdded30Days ??
				sum(lidarrInstances, (stats) => stats.recentlyAdded30Days),
		}),
		[lidarrAggregate, lidarrInstances],
	);

	// Readarr totals with fallback aggregation
	const readarrTotals = useMemo(
		() => ({
			totalAuthors:
				readarrAggregate?.totalAuthors ?? sum(readarrInstances, (stats) => stats.totalAuthors),
			monitoredAuthors:
				readarrAggregate?.monitoredAuthors ??
				sum(readarrInstances, (stats) => stats.monitoredAuthors),
			totalBooks:
				readarrAggregate?.totalBooks ?? sum(readarrInstances, (stats) => stats.totalBooks),
			monitoredBooks:
				readarrAggregate?.monitoredBooks ?? sum(readarrInstances, (stats) => stats.monitoredBooks),
			downloadedBooks:
				readarrAggregate?.downloadedBooks ??
				sum(readarrInstances, (stats) => stats.downloadedBooks),
			missingBooks:
				readarrAggregate?.missingBooks ?? sum(readarrInstances, (stats) => stats.missingBooks),
			downloadPercent:
				readarrAggregate?.downloadedPercentage ??
				calculatePercent(
					sum(readarrInstances, (stats) => stats.downloadedBooks),
					Math.max(
						sum(readarrInstances, (stats) => stats.totalBooks),
						1,
					),
				),
			diskUsed: readarrAggregate?.diskUsed ?? sum(readarrInstances, (stats) => stats.diskUsed),
			diskTotal: readarrAggregate?.diskTotal ?? sum(readarrInstances, (stats) => stats.diskTotal),
			diskPercent:
				readarrAggregate?.diskUsagePercent ??
				calculatePercent(
					sum(readarrInstances, (stats) => stats.diskUsed),
					Math.max(
						sum(readarrInstances, (stats) => stats.diskTotal),
						1,
					),
				),
			healthIssues:
				readarrAggregate?.healthIssues ?? sum(readarrInstances, (stats) => stats.healthIssues),
			cutoffUnmetCount:
				readarrAggregate?.cutoffUnmetCount ??
				sum(readarrInstances, (stats) => stats.cutoffUnmetCount),
			averageBookSize: readarrAggregate?.averageBookSize,
			qualityBreakdown: readarrAggregate?.qualityBreakdown,
			tagBreakdown: readarrAggregate?.tagBreakdown,
			recentlyAdded7Days:
				readarrAggregate?.recentlyAdded7Days ??
				sum(readarrInstances, (stats) => stats.recentlyAdded7Days),
			recentlyAdded30Days:
				readarrAggregate?.recentlyAdded30Days ??
				sum(readarrInstances, (stats) => stats.recentlyAdded30Days),
		}),
		[readarrAggregate, readarrInstances],
	);

	// Collect all health issues across services
	const allHealthIssues: HealthIssue[] = useMemo(() => {
		const issues: HealthIssue[] = [];
		issues.push(
			...(sonarrAggregate?.healthIssuesList ??
				sonarrInstances.flatMap((entry) => entry.data.healthIssuesList ?? [])),
			...(radarrAggregate?.healthIssuesList ??
				radarrInstances.flatMap((entry) => entry.data.healthIssuesList ?? [])),
			...(prowlarrAggregate?.healthIssuesList ??
				prowlarrInstances.flatMap((entry) => entry.data.healthIssuesList ?? [])),
			...(lidarrAggregate?.healthIssuesList ??
				lidarrInstances.flatMap((entry) => entry.data.healthIssuesList ?? [])),
			...(readarrAggregate?.healthIssuesList ??
				readarrInstances.flatMap((entry) => entry.data.healthIssuesList ?? [])),
		);
		return issues;
	}, [
		sonarrAggregate?.healthIssuesList,
		radarrAggregate?.healthIssuesList,
		prowlarrAggregate?.healthIssuesList,
		lidarrAggregate?.healthIssuesList,
		readarrAggregate?.healthIssuesList,
		sonarrInstances,
		radarrInstances,
		prowlarrInstances,
		lidarrInstances,
		readarrInstances,
	]);

	const totalHealthIssues =
		sonarrTotals.healthIssues +
		radarrTotals.healthIssues +
		prowlarrTotals.healthIssues +
		lidarrTotals.healthIssues +
		readarrTotals.healthIssues;

	// Combined disk stats with proper cross-service deduplication
	// Falls back to summing aggregates if combinedDisk is not available (backward compatibility)
	const combinedDisk: CombinedDiskStats = useMemo(() => {
		if (data?.combinedDisk) {
			return data.combinedDisk;
		}
		// Fallback for backward compatibility (shouldn't happen with updated API)
		const diskTotal =
			(sonarrAggregate?.diskTotal ?? 0) +
			(radarrAggregate?.diskTotal ?? 0) +
			(lidarrAggregate?.diskTotal ?? 0) +
			(readarrAggregate?.diskTotal ?? 0);
		const diskUsed =
			(sonarrAggregate?.diskUsed ?? 0) +
			(radarrAggregate?.diskUsed ?? 0) +
			(lidarrAggregate?.diskUsed ?? 0) +
			(readarrAggregate?.diskUsed ?? 0);
		const diskFree =
			(sonarrAggregate?.diskFree ?? 0) +
			(radarrAggregate?.diskFree ?? 0) +
			(lidarrAggregate?.diskFree ?? 0) +
			(readarrAggregate?.diskFree ?? 0);
		return {
			diskTotal,
			diskFree,
			diskUsed,
			diskUsagePercent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
			// Fallback path has no breakdown data — backend assembles the disks
			// array as part of combineDiskStats. Empty here keeps the shape valid
			// for the UI without inventing entries we don't actually have.
			disks: [],
		};
	}, [data?.combinedDisk, sonarrAggregate, radarrAggregate, lidarrAggregate, readarrAggregate]);

	return {
		// Query state
		statisticsState: state,
		availability: state.availability,
		observedAt: state.observedAt,
		hasStatistics: data !== null,
		isLoading,
		isFetching,
		error,
		refetch,
		incompleteServices,
		configuredInstanceCounts,

		// Table rows
		sonarrRows,
		radarrRows,
		prowlarrRows,
		lidarrRows,
		readarrRows,

		// Aggregated totals
		sonarrTotals,
		radarrTotals,
		prowlarrTotals,
		lidarrTotals,
		readarrTotals,

		// Combined disk (properly deduplicated across all services)
		combinedDisk,

		// Health
		allHealthIssues,
		totalHealthIssues,
	};
};
