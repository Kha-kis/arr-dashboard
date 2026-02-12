import { dashboardStatisticsResponseSchema } from "@arr/shared";
import type { DashboardStatisticsResponse } from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { SonarrClient, RadarrClient, ProwlarrClient, LidarrClient, ReadarrClient } from "arr-sdk";
import {
	aggregateProwlarrStatistics,
	aggregateRadarrStatistics,
	aggregateSonarrStatistics,
	aggregateLidarrStatistics,
	aggregateReadarrStatistics,
	emptyProwlarrStatistics,
	emptyRadarrStatistics,
	emptySonarrStatistics,
	emptyLidarrStatistics,
	emptyReadarrStatistics,
	fetchSonarrStatisticsWithSdk,
	fetchRadarrStatisticsWithSdk,
	fetchProwlarrStatisticsWithSdk,
	fetchLidarrStatisticsWithSdk,
	fetchReadarrStatisticsWithSdk,
} from "../../lib/statistics/dashboard-statistics.js";

/**
 * Statistics-related routes for the dashboard
 */
export const statisticsRoutes: FastifyPluginCallback = (app, _opts, done) => {
	/**
	 * GET /dashboard/statistics
	 * Fetches aggregated statistics from all enabled instances
	 */
	app.get("/dashboard/statistics", async (request, reply) => {
		const instances = await app.prisma.serviceInstance.findMany({
			where: { enabled: true, userId: request.currentUser!.id },
		});

		// Fetch all instances in parallel for better performance
		const fetchResults = await Promise.all(
			instances.map(async (instance) => {
				const service = instance.service.toLowerCase();
				const client = app.arrClientFactory.create(instance);

				if (service === "sonarr" && client instanceof SonarrClient) {
					try {
						const data = await fetchSonarrStatisticsWithSdk(
							client,
							instance.id,
							instance.label,
							instance.baseUrl,
						);
						return {
							service: "sonarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							storageGroupId: instance.storageGroupId,
							data,
							error: false,
						};
					} catch (error) {
						request.log.error(
							{ err: error, instance: instance.id },
							"sonarr statistics fetch failed",
						);
						return {
							service: "sonarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							storageGroupId: instance.storageGroupId,
							data: emptySonarrStatistics,
							error: true,
						};
					}
				}

				if (service === "radarr" && client instanceof RadarrClient) {
					try {
						const data = await fetchRadarrStatisticsWithSdk(
							client,
							instance.id,
							instance.label,
							instance.baseUrl,
						);
						return {
							service: "radarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							storageGroupId: instance.storageGroupId,
							data,
							error: false,
						};
					} catch (error) {
						request.log.error(
							{ err: error, instance: instance.id },
							"radarr statistics fetch failed",
						);
						return {
							service: "radarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							storageGroupId: instance.storageGroupId,
							data: emptyRadarrStatistics,
							error: true,
						};
					}
				}

				if (service === "prowlarr" && client instanceof ProwlarrClient) {
					try {
						const data = await fetchProwlarrStatisticsWithSdk(
							client,
							instance.id,
							instance.label,
							instance.baseUrl,
						);
						return {
							service: "prowlarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							data,
							error: false,
						};
					} catch (error) {
						request.log.error(
							{ err: error, instance: instance.id },
							"prowlarr statistics fetch failed",
						);
						return {
							service: "prowlarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							data: emptyProwlarrStatistics,
							error: true,
						};
					}
				}

				if (service === "lidarr" && client instanceof LidarrClient) {
					try {
						const data = await fetchLidarrStatisticsWithSdk(
							client,
							instance.id,
							instance.label,
							instance.baseUrl,
						);
						return {
							service: "lidarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							storageGroupId: instance.storageGroupId,
							data,
							error: false,
						};
					} catch (error) {
						request.log.error(
							{ err: error, instance: instance.id },
							"lidarr statistics fetch failed",
						);
						return {
							service: "lidarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							storageGroupId: instance.storageGroupId,
							data: emptyLidarrStatistics,
							error: true,
						};
					}
				}

				if (service === "readarr" && client instanceof ReadarrClient) {
					try {
						const data = await fetchReadarrStatisticsWithSdk(
							client,
							instance.id,
							instance.label,
							instance.baseUrl,
						);
						return {
							service: "readarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							storageGroupId: instance.storageGroupId,
							data,
							error: false,
						};
					} catch (error) {
						request.log.error(
							{ err: error, instance: instance.id },
							"readarr statistics fetch failed",
						);
						return {
							service: "readarr" as const,
							instanceId: instance.id,
							instanceName: instance.label,
							storageGroupId: instance.storageGroupId,
							data: emptyReadarrStatistics,
							error: true,
						};
					}
				}

				request.log.warn(
					{ service: instance.service, instanceId: instance.id },
					"unknown service type for statistics",
				);
				return null;
			}),
		);

		// Track storage groups GLOBALLY across all service types for disk deduplication
		// This ensures that if Sonarr and Radarr share the same storage group,
		// disk stats are only counted once total (not once per service type)
		const globalSeenStorageGroups = new Set<string>();

		// Group results by service type and mark which should count disk stats
		const sonarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			storageGroupId: string | null;
			shouldCountDisk: boolean;
			data: DashboardStatisticsResponse["sonarr"]["instances"][number]["data"];
			error?: boolean;
		}> = [];
		const radarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			storageGroupId: string | null;
			shouldCountDisk: boolean;
			data: DashboardStatisticsResponse["radarr"]["instances"][number]["data"];
			error?: boolean;
		}> = [];
		const prowlarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			data: DashboardStatisticsResponse["prowlarr"]["instances"][number]["data"];
			error?: boolean;
		}> = [];
		const lidarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			storageGroupId: string | null;
			shouldCountDisk: boolean;
			data: DashboardStatisticsResponse["lidarr"]["instances"][number]["data"];
			error?: boolean;
		}> = [];
		const readarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			storageGroupId: string | null;
			shouldCountDisk: boolean;
			data: DashboardStatisticsResponse["readarr"]["instances"][number]["data"];
			error?: boolean;
		}> = [];

		// Track combined disk stats (properly deduplicated across all services)
		let combinedDiskTotal = 0;
		let combinedDiskFree = 0;
		let combinedDiskUsed = 0;

		for (const result of fetchResults) {
			if (!result) continue;

			if (result.service === "sonarr") {
				// Determine if this instance should count disk stats
				const storageGroupId = result.storageGroupId;
				const shouldCountDisk = !storageGroupId || !globalSeenStorageGroups.has(storageGroupId);
				if (storageGroupId) {
					globalSeenStorageGroups.add(storageGroupId);
				}

				// Add to combined disk stats if this instance should count
				if (shouldCountDisk) {
					combinedDiskTotal += result.data.diskTotal ?? 0;
					combinedDiskFree += result.data.diskFree ?? 0;
					combinedDiskUsed += result.data.diskUsed ?? 0;
				}

				sonarrInstances.push({
					instanceId: result.instanceId,
					instanceName: result.instanceName,
					storageGroupId: result.storageGroupId,
					shouldCountDisk,
					data: result.data,
					error: result.error,
				});
			} else if (result.service === "radarr") {
				// Determine if this instance should count disk stats
				const storageGroupId = result.storageGroupId;
				const shouldCountDisk = !storageGroupId || !globalSeenStorageGroups.has(storageGroupId);
				if (storageGroupId) {
					globalSeenStorageGroups.add(storageGroupId);
				}

				// Add to combined disk stats if this instance should count
				if (shouldCountDisk) {
					combinedDiskTotal += result.data.diskTotal ?? 0;
					combinedDiskFree += result.data.diskFree ?? 0;
					combinedDiskUsed += result.data.diskUsed ?? 0;
				}

				radarrInstances.push({
					instanceId: result.instanceId,
					instanceName: result.instanceName,
					storageGroupId: result.storageGroupId,
					shouldCountDisk,
					data: result.data,
					error: result.error,
				});
			} else if (result.service === "prowlarr") {
				prowlarrInstances.push({
					instanceId: result.instanceId,
					instanceName: result.instanceName,
					data: result.data,
					error: result.error,
				});
			} else if (result.service === "lidarr") {
				// Determine if this instance should count disk stats
				const storageGroupId = result.storageGroupId;
				const shouldCountDisk = !storageGroupId || !globalSeenStorageGroups.has(storageGroupId);
				if (storageGroupId) {
					globalSeenStorageGroups.add(storageGroupId);
				}

				// Add to combined disk stats if this instance should count
				if (shouldCountDisk) {
					combinedDiskTotal += result.data.diskTotal ?? 0;
					combinedDiskFree += result.data.diskFree ?? 0;
					combinedDiskUsed += result.data.diskUsed ?? 0;
				}

				lidarrInstances.push({
					instanceId: result.instanceId,
					instanceName: result.instanceName,
					storageGroupId: result.storageGroupId,
					shouldCountDisk,
					data: result.data,
					error: result.error,
				});
			} else if (result.service === "readarr") {
				// Determine if this instance should count disk stats
				const storageGroupId = result.storageGroupId;
				const shouldCountDisk = !storageGroupId || !globalSeenStorageGroups.has(storageGroupId);
				if (storageGroupId) {
					globalSeenStorageGroups.add(storageGroupId);
				}

				// Add to combined disk stats if this instance should count
				if (shouldCountDisk) {
					combinedDiskTotal += result.data.diskTotal ?? 0;
					combinedDiskFree += result.data.diskFree ?? 0;
					combinedDiskUsed += result.data.diskUsed ?? 0;
				}

				readarrInstances.push({
					instanceId: result.instanceId,
					instanceName: result.instanceName,
					storageGroupId: result.storageGroupId,
					shouldCountDisk,
					data: result.data,
					error: result.error,
				});
			}
		}

		// Calculate combined disk usage percentage
		const combinedDiskUsagePercent =
			combinedDiskTotal > 0
				? Math.min(100, Math.max(0, (combinedDiskUsed / combinedDiskTotal) * 100))
				: 0;

		const payload = {
			sonarr: {
				instances: sonarrInstances,
				aggregate: aggregateSonarrStatistics(sonarrInstances),
			},
			radarr: {
				instances: radarrInstances,
				aggregate: aggregateRadarrStatistics(radarrInstances),
			},
			prowlarr: {
				instances: prowlarrInstances,
				aggregate: aggregateProwlarrStatistics(prowlarrInstances),
			},
			lidarr: {
				instances: lidarrInstances,
				aggregate: aggregateLidarrStatistics(lidarrInstances),
			},
			readarr: {
				instances: readarrInstances,
				aggregate: aggregateReadarrStatistics(readarrInstances),
			},
			// Combined disk stats with proper cross-service storage group deduplication
			combinedDisk:
				combinedDiskTotal > 0
					? {
							diskTotal: combinedDiskTotal,
							diskFree: combinedDiskFree,
							diskUsed: combinedDiskUsed,
							diskUsagePercent: combinedDiskUsagePercent,
						}
					: undefined,
		};

		return reply.send(dashboardStatisticsResponseSchema.parse(payload));
	});

	done();
};
