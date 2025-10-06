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
} from "../dashboard-statistics";

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
      data: unknown;
    }> = [];
    const radarrInstances: Array<{
      instanceId: string;
      instanceName: string;
      data: unknown;
    }> = [];
    const prowlarrInstances: Array<{
      instanceId: string;
      instanceName: string;
      data: unknown;
    }> = [];

    for (const instance of instances) {
      const service = instance.service.toLowerCase();
      const fetcher = createInstanceFetcher(app, instance as ServiceInstance);

      if (service === "sonarr") {
        try {
          const data = await fetchSonarrStatistics(fetcher);
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
          const data = await fetchRadarrStatistics(fetcher);
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
        const data = await fetchProwlarrStatistics(fetcher);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        aggregate: aggregateSonarrStatistics(sonarrInstances as any),
      },
      radarr: {
        instances: radarrInstances,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        aggregate: aggregateRadarrStatistics(radarrInstances as any),
      },
      prowlarr: {
        instances: prowlarrInstances,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        aggregate: aggregateProwlarrStatistics(prowlarrInstances as any),
      },
    };

    return reply.send(dashboardStatisticsResponseSchema.parse(payload));
  });

  done();
};
