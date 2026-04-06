/**
 * Jellyfin Image Proxy Routes
 *
 * Proxies Jellyfin thumbnail images through the API server,
 * injecting the API key server-side so the browser
 * doesn't need direct access to Jellyfin.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireJellyfinClient } from "../../lib/jellyfin/jellyfin-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const thumbParams = z.object({
	instanceId: z.string().min(1),
});

const thumbQuery = z.object({
	itemId: z.string().min(1).refine((v) => !v.includes("..") && !v.includes("/"), "Invalid item ID"),
	imageType: z
		.enum(["Primary", "Backdrop", "Thumb", "Logo", "Banner", "Art", "Disc", "Box", "Screenshot", "Chapter", "Profile"])
		.optional()
		.default("Primary"),
	maxWidth: z
		.string()
		.optional()
		.transform((val) => {
			const n = val ? Number.parseInt(val, 10) : 300;
			return Number.isFinite(n) && n > 0 ? Math.min(n, 1920) : 300;
		}),
});

export async function registerImageProxyRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/thumb/:instanceId?itemId=X&imageType=Primary&maxWidth=300
	 *
	 * Proxies a Jellyfin item image with proper authentication.
	 */
	app.get("/:instanceId", async (request, reply) => {
		const { instanceId } = validateRequest(thumbParams, request.params);
		const { itemId, imageType, maxWidth } = validateRequest(thumbQuery, request.query);
		const userId = request.currentUser!.id;

		const { client } = await requireJellyfinClient(app, userId, instanceId);

		const imageResponse = await client.fetchImage(itemId, imageType, maxWidth);

		const contentType = imageResponse.headers.get("content-type") ?? "image/jpeg";

		reply.header("Content-Type", contentType);
		reply.header("Cache-Control", "public, max-age=86400, immutable");

		const buffer = Buffer.from(await imageResponse.arrayBuffer());
		return reply.send(buffer);
	});
}
