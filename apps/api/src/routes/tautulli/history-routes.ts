/**
 * Tautulli Watch History Routes
 *
 * Recent watch history aggregated from all Tautulli instances.
 */

import type { TautulliWatchHistoryItem, TautulliWatchHistoryResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { executeOnTautulliInstances } from "../../lib/tautulli/tautulli-helpers.js";
import { validateRequest } from "../../lib/utils/validate.js";

const historyQuery = z.object({
	length: z
		.string()
		.optional()
		.transform((val) => {
			const n = Number(val);
			return Number.isFinite(n) && n > 0 && n <= 100 ? n : 25;
		}),
	start: z
		.string()
		.optional()
		.transform((val) => {
			const n = Number(val);
			return Number.isFinite(n) && n >= 0 ? n : 0;
		}),
});

export async function registerHistoryRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/tautulli/history?length=25&start=0
	 *
	 * Aggregated watch history from all Tautulli instances, sorted by date.
	 */
	app.get("/", async (request, reply) => {
		const { length, start } = validateRequest(historyQuery, request.query);
		const userId = request.currentUser!.id;

		const result = await executeOnTautulliInstances(app, userId, async (client) => {
			return client.getHistory({ length, start });
		});

		const items: TautulliWatchHistoryItem[] = [];

		for (const instanceResult of result.instances) {
			if (!instanceResult.success) continue;
			const { data: historyItems } = instanceResult.data;

			for (const raw of historyItems) {
				const mediaType =
					raw.media_type === "movie"
						? "movie"
						: raw.media_type === "episode"
							? "episode"
							: "track";

				items.push({
					title: raw.title,
					grandparentTitle: raw.grandparent_title || undefined,
					mediaType: mediaType as "movie" | "episode" | "track",
					watchedAt: new Date(raw.date * 1000).toISOString(),
					duration: 0,
					watchedDuration: 0,
					user: raw.user,
					platform: "",
					player: "",
					completionPercent: 0,
					ratingKey: raw.rating_key,
				});
			}
		}

		// Sort by watchedAt descending (most recent first)
		items.sort((a, b) => new Date(b.watchedAt).getTime() - new Date(a.watchedAt).getTime());

		// Apply pagination to merged results
		const paged = items.slice(start, start + length);

		const response: TautulliWatchHistoryResponse = {
			history: paged,
			totalCount: items.length,
		};

		return reply.send(response);
	});
}
