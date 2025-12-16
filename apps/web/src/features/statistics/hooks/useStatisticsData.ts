/**
 * Statistics Data Hook
 *
 * Handles data aggregation and transformation for statistics dashboard.
 * Centralizes business logic for computing totals across service instances.
 */

import { useMemo } from "react";
import type {
	SonarrStatistics,
	RadarrStatistics,
	ProwlarrStatistics,
	HealthIssue,
	CombinedDiskStats,
} from "@arr/shared";
import { useDashboardStatisticsQuery } from "../../../hooks/api/useDashboard";

/**
 * Generic sum utility for reducing instance data
 */
const sum = <T,>(rows: Array<{ data: T }>, selector: (value: T) => number | undefined) =>
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
 * Hook for statistics data aggregation and transformation
 *
 * @returns Aggregated statistics and table rows for all service types
 */
export const useStatisticsData = () => {
	const { data, isLoading, isFetching, error, refetch } = useDashboardStatisticsQuery();

	// Memoize instance arrays to prevent dependency changes on every render
	const sonarrInstances = useMemo(() => data?.sonarr.instances ?? [], [data?.sonarr.instances]);
	const radarrInstances = useMemo(() => data?.radarr.instances ?? [], [data?.radarr.instances]);
	const prowlarrInstances = useMemo(() => data?.prowlarr.instances ?? [], [data?.prowlarr.instances]);

	const sonarrRows = useMemo(() => buildSonarrRows(sonarrInstances), [sonarrInstances]);
	const radarrRows = useMemo(() => buildRadarrRows(radarrInstances), [radarrInstances]);
	const prowlarrRows = useMemo(() => buildProwlarrRows(prowlarrInstances), [prowlarrInstances]);

	const sonarrAggregate = data?.sonarr.aggregate;
	const radarrAggregate = data?.radarr.aggregate;
	const prowlarrAggregate = data?.prowlarr.aggregate;

	// Sonarr totals with fallback aggregation
	const sonarrTotals = useMemo(
		() => ({
			totalSeries: sonarrAggregate?.totalSeries ?? sum(sonarrInstances, (stats) => stats.totalSeries),
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
					Math.max(sum(sonarrInstances, (stats) => stats.totalEpisodes), 1),
				),
			diskUsed: sonarrAggregate?.diskUsed ?? sum(sonarrInstances, (stats) => stats.diskUsed),
			diskTotal: sonarrAggregate?.diskTotal ?? sum(sonarrInstances, (stats) => stats.diskTotal),
			diskPercent:
				sonarrAggregate?.diskUsagePercent ??
				calculatePercent(
					sum(sonarrInstances, (stats) => stats.diskUsed),
					Math.max(sum(sonarrInstances, (stats) => stats.diskTotal), 1),
				),
			healthIssues:
				sonarrAggregate?.healthIssues ?? sum(sonarrInstances, (stats) => stats.healthIssues),
			continuingSeries:
				sonarrAggregate?.continuingSeries ?? sum(sonarrInstances, (stats) => stats.continuingSeries),
			endedSeries: sonarrAggregate?.endedSeries ?? sum(sonarrInstances, (stats) => stats.endedSeries),
			cutoffUnmetCount:
				sonarrAggregate?.cutoffUnmetCount ?? sum(sonarrInstances, (stats) => stats.cutoffUnmetCount),
			averageEpisodeSize: sonarrAggregate?.averageEpisodeSize,
			qualityBreakdown: sonarrAggregate?.qualityBreakdown,
			tagBreakdown: sonarrAggregate?.tagBreakdown,
			recentlyAdded7Days:
				sonarrAggregate?.recentlyAdded7Days ?? sum(sonarrInstances, (stats) => stats.recentlyAdded7Days),
			recentlyAdded30Days:
				sonarrAggregate?.recentlyAdded30Days ?? sum(sonarrInstances, (stats) => stats.recentlyAdded30Days),
		}),
		[sonarrAggregate, sonarrInstances],
	);

	// Radarr totals with fallback aggregation
	const radarrTotals = useMemo(
		() => ({
			totalMovies: radarrAggregate?.totalMovies ?? sum(radarrInstances, (stats) => stats.totalMovies),
			monitoredMovies:
				radarrAggregate?.monitoredMovies ?? sum(radarrInstances, (stats) => stats.monitoredMovies),
			downloadedMovies:
				radarrAggregate?.downloadedMovies ?? sum(radarrInstances, (stats) => stats.downloadedMovies),
			missingMovies:
				radarrAggregate?.missingMovies ?? sum(radarrInstances, (stats) => stats.missingMovies),
			downloadPercent:
				radarrAggregate?.downloadedPercentage ??
				calculatePercent(
					sum(radarrInstances, (stats) => stats.downloadedMovies),
					Math.max(sum(radarrInstances, (stats) => stats.monitoredMovies), 1),
				),
			diskUsed: radarrAggregate?.diskUsed ?? sum(radarrInstances, (stats) => stats.diskUsed),
			diskTotal: radarrAggregate?.diskTotal ?? sum(radarrInstances, (stats) => stats.diskTotal),
			diskPercent:
				radarrAggregate?.diskUsagePercent ??
				calculatePercent(
					sum(radarrInstances, (stats) => stats.diskUsed),
					Math.max(sum(radarrInstances, (stats) => stats.diskTotal), 1),
				),
			healthIssues:
				radarrAggregate?.healthIssues ?? sum(radarrInstances, (stats) => stats.healthIssues),
			cutoffUnmetCount:
				radarrAggregate?.cutoffUnmetCount ?? sum(radarrInstances, (stats) => stats.cutoffUnmetCount),
			averageMovieSize: radarrAggregate?.averageMovieSize,
			qualityBreakdown: radarrAggregate?.qualityBreakdown,
			tagBreakdown: radarrAggregate?.tagBreakdown,
			recentlyAdded7Days:
				radarrAggregate?.recentlyAdded7Days ?? sum(radarrInstances, (stats) => stats.recentlyAdded7Days),
			recentlyAdded30Days:
				radarrAggregate?.recentlyAdded30Days ?? sum(radarrInstances, (stats) => stats.recentlyAdded30Days),
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
				prowlarrAggregate?.activeIndexers ?? sum(prowlarrInstances, (stats) => stats.activeIndexers),
			pausedIndexers:
				prowlarrAggregate?.pausedIndexers ?? sum(prowlarrInstances, (stats) => stats.pausedIndexers),
			totalQueries:
				prowlarrAggregate?.totalQueries ?? sum(prowlarrInstances, (stats) => stats.totalQueries),
			totalGrabs: prowlarrAggregate?.totalGrabs ?? sum(prowlarrInstances, (stats) => stats.totalGrabs),
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

	// Collect all health issues across services
	const allHealthIssues: HealthIssue[] = useMemo(() => {
		const issues: HealthIssue[] = [];
		if (sonarrAggregate?.healthIssuesList) {
			issues.push(...sonarrAggregate.healthIssuesList);
		}
		if (radarrAggregate?.healthIssuesList) {
			issues.push(...radarrAggregate.healthIssuesList);
		}
		if (prowlarrAggregate?.healthIssuesList) {
			issues.push(...prowlarrAggregate.healthIssuesList);
		}
		return issues;
	}, [
		sonarrAggregate?.healthIssuesList,
		radarrAggregate?.healthIssuesList,
		prowlarrAggregate?.healthIssuesList,
	]);

	const totalHealthIssues =
		sonarrTotals.healthIssues + radarrTotals.healthIssues + prowlarrTotals.healthIssues;

	// Combined disk stats with proper cross-service deduplication
	// Falls back to summing aggregates if combinedDisk is not available (backward compatibility)
	const combinedDisk: CombinedDiskStats = useMemo(() => {
		if (data?.combinedDisk) {
			return data.combinedDisk;
		}
		// Fallback for backward compatibility (shouldn't happen with updated API)
		const diskTotal = (sonarrAggregate?.diskTotal ?? 0) + (radarrAggregate?.diskTotal ?? 0);
		const diskUsed = (sonarrAggregate?.diskUsed ?? 0) + (radarrAggregate?.diskUsed ?? 0);
		const diskFree = (sonarrAggregate?.diskFree ?? 0) + (radarrAggregate?.diskFree ?? 0);
		return {
			diskTotal,
			diskFree,
			diskUsed,
			diskUsagePercent: diskTotal > 0 ? (diskUsed / diskTotal) * 100 : 0,
		};
	}, [data?.combinedDisk, sonarrAggregate, radarrAggregate]);

	return {
		// Query state
		isLoading,
		isFetching,
		error,
		refetch,

		// Table rows
		sonarrRows,
		radarrRows,
		prowlarrRows,

		// Aggregated totals
		sonarrTotals,
		radarrTotals,
		prowlarrTotals,

		// Combined disk (properly deduplicated across all services)
		combinedDisk,

		// Health
		allHealthIssues,
		totalHealthIssues,
	};
};
