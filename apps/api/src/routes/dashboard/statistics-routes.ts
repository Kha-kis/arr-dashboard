import { dashboardStatisticsResponseSchema } from "@arr/shared";
import type { DashboardStatisticsResponse } from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher";
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
	/**
	 * GET /dashboard/statistics
	 * Fetches aggregated statistics from all enabled instances
	 */
	app.get("/dashboard/statistics", async (request, reply) => {
		if (!request.currentUser) {
			reply.status(401);
			return dashboardStatisticsResponseSchema.parse({
				sonarr: { instances: [], aggregate: emptySonarrStatistics },
				radarr: { instances: [], aggregate: emptyRadarrStatistics },
				prowlarr: { instances: [], aggregate: emptyProwlarrStatistics },
			});
		}

		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId: request.currentUser.id, enabled: true },
		});

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

		for (const instance of instances) {
			const service = instance.service.toLowerCase();
			const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

			if (service === "sonarr") {
				try {
					const data = await fetchSonarrStatistics(fetcher, instance.id, instance.label, instance.baseUrl);
					sonarrInstances.push({
						instanceId: instance.id,
						instanceName: instance.label,
						data,
					});
				} catch (error) {
					request.log.error(
						{ err: error, instance: instance.id },
						"sonarr statistics fetch failed",
					);
					sonarrInstances.push({
						instanceId: instance.id,
						instanceName: instance.label,
						data: emptySonarrStatistics,
					});
				}
				continue;
			}

			if (service === "radarr") {
				try {
					const data = await fetchRadarrStatistics(fetcher, instance.id, instance.label, instance.baseUrl);
					radarrInstances.push({
						instanceId: instance.id,
						instanceName: instance.label,
						data,
					});
				} catch (error) {
					request.log.error(
						{ err: error, instance: instance.id },
						"radarr statistics fetch failed",
					);
					radarrInstances.push({
						instanceId: instance.id,
						instanceName: instance.label,
						data: emptyRadarrStatistics,
					});
				}
				continue;
			}

			try {
				const data = await fetchProwlarrStatistics(fetcher, instance.id, instance.label, instance.baseUrl);
				prowlarrInstances.push({
					instanceId: instance.id,
					instanceName: instance.label,
					data,
				});
			} catch (error) {
				request.log.error(
					{ err: error, instance: instance.id },
					"prowlarr statistics fetch failed",
				);
				prowlarrInstances.push({
					instanceId: instance.id,
					instanceName: instance.label,
					data: emptyProwlarrStatistics,
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
