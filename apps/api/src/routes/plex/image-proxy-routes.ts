/**
 * Plex Image Proxy Routes
 *
 * Proxies Plex thumbnail images through the API server,
 * injecting the Plex token server-side so the browser
 * doesn't need direct access to Plex.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requirePlexClient } from "../../lib/plex/plex-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const thumbParams = z.object({
	instanceId: z.string().min(1),
});

const thumbQuery = z.object({
	path: z.string().startsWith("/library/metadata/"),
});

export async function registerImageProxyRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/thumb/:instanceId?path=/library/metadata/12345/thumb/1234567890
	 *
	 * Proxies a Plex thumbnail image with proper authentication.
	 * Validates that the path starts with /library/metadata/ to prevent SSRF.
	 */
	app.get("/:instanceId", async (request, reply) => {
		const { instanceId } = validateRequest(thumbParams, request.params);
		const { path } = validateRequest(thumbQuery, request.query);
		const userId = request.currentUser!.id;

		const { client } = await requirePlexClient(app, userId, instanceId);

		const imageResponse = await client.fetchImage(path);

		const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";

		reply.header("Content-Type", contentType);
		reply.header("Cache-Control", "public, max-age=86400, immutable");

		const buffer = Buffer.from(await imageResponse.arrayBuffer());
		return reply.send(buffer);
	});
}
