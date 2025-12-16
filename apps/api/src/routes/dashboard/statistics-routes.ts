import { dashboardStatisticsResponseSchema } from "@arr/shared";
import type { DashboardStatisticsResponse } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import {
	aggregateProwlarrStatistics,
	aggregateRadarrStatistics,
	aggregateSonarrStatistics,
	emptyProwlarrStatistics,
	emptyRadarrStatistics,
	emptySonarrStatistics,
	fetchProwlarrStatistics,
	fetchRadarrStatistics,
	fetchSonarrStatistics,
} from "../../lib/statistics/dashboard-statistics.js";

/**
 * Statistics-related routes for the dashboard
 */
export const statisticsRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * GET /dashboard/statistics
	 * Fetches aggregated statistics from all enabled instances
	 */
	app.get("/dashboard/statistics", async (request, reply) => {
		const instances = await app.prisma.serviceInstance.findMany({
			where: { enabled: true, userId: request.currentUser?.id },
		});

		// Fetch all instances in parallel for better performance
		const fetchResults = await Promise.all(
			instances.map(async (instance) => {
				const service = instance.service.toLowerCase();
				const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

				if (service === "sonarr") {
					try {
						const data = await fetchSonarrStatistics(
							fetcher,
							instance.id,
							instance.label,
							instance.baseUrl,
						);
						return { service: "sonarr" as const, instanceId: instance.id, instanceName: instance.label, data };
					} catch (error) {
						request.log.error(
							{ err: error, instance: instance.id },
							"sonarr statistics fetch failed",
						);
						return { service: "sonarr" as const, instanceId: instance.id, instanceName: instance.label, data: emptySonarrStatistics };
					}
				}

				if (service === "radarr") {
					try {
						const data = await fetchRadarrStatistics(
							fetcher,
							instance.id,
							instance.label,
							instance.baseUrl,
						);
						return { service: "radarr" as const, instanceId: instance.id, instanceName: instance.label, data };
					} catch (error) {
						request.log.error(
							{ err: error, instance: instance.id },
							"radarr statistics fetch failed",
						);
						return { service: "radarr" as const, instanceId: instance.id, instanceName: instance.label, data: emptyRadarrStatistics };
					}
				}

				if (service === "prowlarr") {
					try {
						const data = await fetchProwlarrStatistics(
							fetcher,
							instance.id,
							instance.label,
							instance.baseUrl,
						);
						return { service: "prowlarr" as const, instanceId: instance.id, instanceName: instance.label, data };
					} catch (error) {
						request.log.error(
							{ err: error, instance: instance.id },
							"prowlarr statistics fetch failed",
						);
						return { service: "prowlarr" as const, instanceId: instance.id, instanceName: instance.label, data: emptyProwlarrStatistics };
					}
				}

				request.log.warn(
					{ service: instance.service, instanceId: instance.id },
					"unknown service type for statistics",
				);
				return null;
			}),
		);

		// Group results by service type
		const sonarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			data: DashboardStatisticsResponse["sonarr"]["instances"][number]["data"];
		}> = [];
		const radarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			data: DashboardStatisticsResponse["radarr"]["instances"][number]["data"];
		}> = [];
		const prowlarrInstances: Array<{
			instanceId: string;
			instanceName: string;
			data: DashboardStatisticsResponse["prowlarr"]["instances"][number]["data"];
		}> = [];

		for (const result of fetchResults) {
			if (!result) continue;

			if (result.service === "sonarr") {
				sonarrInstances.push({
					instanceId: result.instanceId,
					instanceName: result.instanceName,
					data: result.data,
				});
			} else if (result.service === "radarr") {
				radarrInstances.push({
					instanceId: result.instanceId,
					instanceName: result.instanceName,
					data: result.data,
				});
			} else if (result.service === "prowlarr") {
				prowlarrInstances.push({
					instanceId: result.instanceId,
					instanceName: result.instanceName,
					data: result.data,
				});
			}
		}

		const payload: DashboardStatisticsResponse = {
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
		};

		return reply.send(dashboardStatisticsResponseSchema.parse(payload));
	});

	done();
};
