import type { FastifyPluginCallback } from "fastify";
import { searchGrabRequestSchema } from "@arr/shared";
import { createInstanceFetcher } from "../../lib/arr/arr-fetcher";
import { grabProwlarrRelease } from "../../lib/search/prowlarr-api";

/**
 * Registers grab/download routes for Prowlarr.
 *
 * Routes:
 * - POST /search/grab - Grab a search result and send it to the download client
 */
export const registerGrabRoutes: FastifyPluginCallback = (app, _opts, done) => {
  /**
   * POST /search/grab
   * Grabs a search result and sends it to the configured download client in Prowlarr.
   */
  app.post("/search/grab", async (request, reply) => {
    if (!request.currentUser) {
      reply.status(401);

      return { success: false };
    }

    const payload = searchGrabRequestSchema.parse(request.body ?? {});

    const userId = request.currentUser.id;

    const instance = await app.prisma.serviceInstance.findFirst({
      where: {
        userId,
        enabled: true,
        service: "PROWLARR",
        id: payload.instanceId,
      },
    });

    if (!instance) {
      reply.status(404);

      return { success: false, message: "Prowlarr instance not found" };
    }

    const fetcherInstance = createInstanceFetcher(app, instance);

    try {
      await grabProwlarrRelease(fetcherInstance, payload.result);

      reply.status(204);

      return null;
    } catch (error) {
      request.log.error(
        { err: error, instance: instance.id },
        "prowlarr grab failed",
      );

      reply.status(502);

      return {
        success: false,
        message:
          error instanceof Error ? error.message : "Failed to grab release",
      };
    }
  });

  done();
};
