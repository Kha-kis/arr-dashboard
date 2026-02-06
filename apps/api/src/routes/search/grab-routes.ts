import type { FastifyPluginCallback } from "fastify";
import { searchGrabRequestSchema } from "@arr/shared";
import { getClientForInstance, isProwlarrClient } from "../../lib/arr/client-helpers.js";
import { ArrError, arrErrorToHttpStatus } from "../../lib/arr/client-factory.js";
import { grabProwlarrReleaseWithSdk } from "../../lib/search/prowlarr-api.js";

/**
 * Registers grab/download routes for Prowlarr.
 *
 * Routes:
 * - POST /search/grab - Grab a search result and send it to the download client
 */
export const registerGrabRoutes: FastifyPluginCallback = (app, _opts, done) => {
	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	/**
	 * POST /search/grab
	 * Grabs a search result and sends it to the configured download client in Prowlarr.
	 */
	app.post("/search/grab", async (request, reply) => {
		const payload = searchGrabRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			reply.status(clientResult.statusCode);
			return { success: false, message: clientResult.error };
		}

		const { client, instance } = clientResult;

		if (!isProwlarrClient(client)) {
			reply.status(400);
			return { success: false, message: "Instance is not a Prowlarr instance" };
		}

		try {
			await grabProwlarrReleaseWithSdk(client, payload.result);
			reply.status(204);
			return null;
		} catch (error) {
			request.log.error({ err: error, instance: instance.id }, "prowlarr grab failed");

			if (error instanceof ArrError) {
				reply.status(arrErrorToHttpStatus(error));
			} else {
				reply.status(502);
			}

			return {
				success: false,
				message: error instanceof Error ? error.message : "Failed to grab release",
			};
		}
	});

	done();
};
