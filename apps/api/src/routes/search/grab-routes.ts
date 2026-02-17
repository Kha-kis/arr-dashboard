import type { FastifyPluginCallback } from "fastify";
import { searchGrabRequestSchema } from "@arr/shared";
import { getClientForInstance, isProwlarrClient } from "../../lib/arr/client-helpers.js";
import { grabProwlarrReleaseWithSdk } from "../../lib/search/prowlarr-api.js";

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
		const payload = searchGrabRequestSchema.parse(request.body ?? {});

		const clientResult = await getClientForInstance(app, request, payload.instanceId);
		if (!clientResult.success) {
			reply.status(clientResult.statusCode);
			return { success: false, message: clientResult.error };
		}

		const { client } = clientResult;

		if (!isProwlarrClient(client)) {
			reply.status(400);
			return { success: false, message: "Instance is not a Prowlarr instance" };
		}

		await grabProwlarrReleaseWithSdk(client, payload.result);
		reply.status(204);
		return null;
	});

	done();
};
