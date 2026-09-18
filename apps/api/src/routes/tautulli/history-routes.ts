/**
 * Tautulli Watch History Routes
 *
 * Recent watch history aggregated from all Tautulli instances.
 */

import type {
	SessionAvailability,
	TautulliWatchHistoryItem,
	TautulliWatchHistoryResponse,
} from "@arr/shared";
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
		const configured = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "TAUTULLI", enabled: true },
			select: { id: true },
		});

		const result = await executeOnTautulliInstances(app, userId, async (client) => {
			return client.getHistory({ length, start, include_activity: 0 });
		});
		const configuredIds = new Set(configured.map(({ id }) => id));
		const acceptedInstances = result.instances.filter(
			(instance): instance is Extract<(typeof result.instances)[number], { success: true }> =>
				instance.success && configuredIds.has(instance.instanceId),
		);
		const availability: SessionAvailability = {
			status:
				configured.length === 0
					? "not-configured"
					: acceptedInstances.length === 0
						? "unavailable"
						: acceptedInstances.length === configured.length
							? "complete"
							: "partial",
			configuredSources: configured.length,
			availableSources: acceptedInstances.length,
		};
		if (availability.status === "unavailable") {
			return reply.status(503).send({ error: "Tautulli history is unavailable", availability });
		}

		const items: TautulliWatchHistoryItem[] = [];

		for (const instanceResult of acceptedInstances) {
			const { data: historyItems } = instanceResult.data;

			for (const raw of historyItems) {
				const mediaType =
					raw.media_type === "movie" ? "movie" : raw.media_type === "episode" ? "episode" : "track";

				items.push({
					title: raw.title,
					grandparentTitle: raw.grandparent_title || undefined,
					mediaType: mediaType as "movie" | "episode" | "track",
					watchedAt: new Date(raw.date * 1000).toISOString(),
					user: raw.user,
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
			availability,
		};

		return reply.send(response);
	});
}
