import {
  type DiscoverSearchResult,
  discoverSearchRequestSchema,
  discoverSearchResponseSchema,
} from "@arr/shared";
import type { ServiceInstance } from "@prisma/client";
import type { FastifyPluginCallback } from "fastify";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher.js";
import {
  ensureResult,
  fetchLookupResults,
  normalizeLookupResult,
  sortSearchResults,
} from "../../lib/discover/discover-normalizer.js";

/**
 * Register discover search routes
 * - GET /discover/search - Search for movies or series across instances
 */
export const registerSearchRoutes: FastifyPluginCallback = (app, _opts, done) => {
  /**
   * GET /discover/search
   * Searches for movies or series across all enabled Sonarr/Radarr instances
   */
  app.get("/discover/search", async (request, reply) => {
    if (!request.currentUser) {
      reply.status(401);
      return discoverSearchResponseSchema.parse({ results: [], totalCount: 0 });
    }

    const parsed = discoverSearchRequestSchema.parse(request.query ?? {});
    const type = parsed.type;
    const prismaService = type === "movie" ? "RADARR" : "SONARR";

    const instances = await app.prisma.serviceInstance.findMany({
      where: {
        userId: request.currentUser.id,
        enabled: true,
        service: prismaService,
      },
    });

    if (instances.length === 0) {
      return discoverSearchResponseSchema.parse({ results: [], totalCount: 0 });
    }

    const resultMap = new Map<string, DiscoverSearchResult>();

    for (const instance of instances) {
      const service = instance.service.toLowerCase() as "sonarr" | "radarr";
      try {
        const fetcher = createInstanceFetcher(app, instance as ServiceInstance);
        const lookupResults = await fetchLookupResults(
          fetcher,
          service,
          parsed.query,
        );
        for (const raw of lookupResults) {
          const normalized = normalizeLookupResult(
            raw,
            instance as ServiceInstance,
            service,
          );
          ensureResult(resultMap, normalized);
        }
      } catch (error) {
        request.log.error(
          { err: error, instance: instance.id },
          "discover search failed",
        );
      }
    }

    const results = sortSearchResults(
      Array.from(resultMap.values()),
      parsed.query,
    );

    return discoverSearchResponseSchema.parse({
      results,
      totalCount: results.length,
    });
  });

  done();
};
