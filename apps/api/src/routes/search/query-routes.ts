import type { FastifyPluginCallback } from "fastify";
import type { SearchRequest, SearchResult } from "@arr/shared";
import {
  multiInstanceSearchResponseSchema,
  searchRequestSchema,
} from "@arr/shared";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher";
import { performProwlarrSearch } from "../../lib/search/prowlarr-api";

/**
 * Registers search query routes for Prowlarr.
 *
 * Routes:
 * - POST /search/query - Perform a manual search across Prowlarr instances
 */
export const registerQueryRoutes: FastifyPluginCallback = (
  app,
  _opts,
  done,
) => {
  /**
   * POST /search/query
   * Performs a manual search query across one or more Prowlarr instances.
   * Supports filtering by indexer IDs and categories per instance.
   */
  app.post("/search/query", async (request, reply) => {
    if (!request.currentUser) {
      reply.status(401);

      return multiInstanceSearchResponseSchema.parse({
        instances: [],

        aggregated: [],

        totalCount: 0,
      });
    }

    const payload = searchRequestSchema.parse(request.body ?? {});

    const userId = request.currentUser.id;

    const instances = await app.prisma.serviceInstance.findMany({
      where: { userId, enabled: true, service: "PROWLARR" },
    });

    if (instances.length === 0) {
      return multiInstanceSearchResponseSchema.parse({
        instances: [],

        aggregated: [],

        totalCount: 0,
      });
    }

    const instanceMap = new Map(
      instances.map((instance) => [instance.id, instance] as const),
    );

    const filters: Array<{
      instanceId: string;
      indexerIds?: number[];
      categories?: number[];
    }> =
      payload.filters && payload.filters.length > 0
        ? payload.filters
        : instances.map((instance) => ({ instanceId: instance.id }));

    const results: Array<{
      instanceId: string;
      instanceName: string;
      data: SearchResult[];
    }> = [];

    const aggregated: SearchResult[] = [];

    for (const filter of filters) {
      const instance = instanceMap.get(filter.instanceId);

      if (!instance) {
        continue;
      }

      const fetcherInstance = createInstanceFetcher(app, instance);

      try {
        const data = await performProwlarrSearch(fetcherInstance, instance, {
          query: payload.query,

          type: payload.type,

          limit: payload.limit ?? 100,

          indexerIds: filter.indexerIds,

          categories: filter.categories,
        });

        results.push({
          instanceId: instance.id,

          instanceName: instance.label,

          data,
        });

        aggregated.push(...data);
      } catch (error) {
        request.log.error(
          { err: error, instance: instance.id },
          "prowlarr search failed",
        );

        results.push({
          instanceId: instance.id,

          instanceName: instance.label,

          data: [],
        });
      }
    }

    return multiInstanceSearchResponseSchema.parse({
      instances: results,

      aggregated,

      totalCount: aggregated.length,
    });
  });

  done();
};
