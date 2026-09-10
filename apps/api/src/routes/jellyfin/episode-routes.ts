/**
 * Jellyfin Episode Watch Status Routes
 *
 * Returns per-episode watch status from owned Jellyfin observations.
 */

import type { PlexEpisodeStatus, ProviderObservationStatusEnvelope } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	type JellyfinDisplayInstance,
	readOwnedJellyfinEpisodeDisplaySources,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";
import { validateRequest } from "../../lib/utils/validate.js";

const episodeQuery = z.object({
	instanceId: z.string().min(1),
	showTmdbId: z
		.string()
		.min(1)
		.transform((val) => {
			const n = Number(val);
			if (!Number.isFinite(n) || n <= 0) return 0;
			return n;
		})
		.pipe(z.number().positive()),
});

type JellyfinEpisodeStatusResponse = {
	showTmdbId: number;
	episodes: PlexEpisodeStatus[];
	providerStatus?: ProviderObservationStatusEnvelope;
};

export async function registerEpisodeRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/jellyfin/episodes?instanceId=X&showTmdbId=123
	 *
	 * Returns episode watch status from an owned Jellyfin observation.
	 */
	app.get("/", async (request, reply) => {
		const { instanceId, showTmdbId } = validateRequest(episodeQuery, request.query);
		const userId = request.currentUser!.id;

		// Verify instance ownership
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true, label: true, service: true },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Instance not found or access denied" });
		}

		if (instance.service !== "JELLYFIN" && instance.service !== "EMBY") {
			return reply.status(404).send({ error: "Instance not found or access denied" });
		}
		const displayInstance: JellyfinDisplayInstance = {
			id: instance.id,
			label: instance.label,
			service: instance.service,
		};
		const displayEvidence = await readOwnedJellyfinEpisodeDisplaySources({
			prisma: app.prisma,
			userId,
			instances: [displayInstance],
		});
		const episodes = displayEvidence.sources
			.flatMap((source) => source.rows)
			.filter((episode) => episode.showTmdbId === showTmdbId)
			.sort(
				(left, right) =>
					left.seasonNumber - right.seasonNumber ||
					left.episodeNumber - right.episodeNumber ||
					left.id.localeCompare(right.id),
			);

		const items: PlexEpisodeStatus[] = episodes.map((e) => {
			let watchedByUsers: string[] = [];
			try {
				const parsed: unknown = JSON.parse(e.watchedByUsers);
				if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
					watchedByUsers = parsed;
				}
			} catch {
				// Skip malformed JSON
			}

			return {
				seasonNumber: e.seasonNumber,
				episodeNumber: e.episodeNumber,
				title: e.title,
				watched: e.watched,
				watchedByUsers,
				lastWatchedAt: e.lastWatchedAt?.toISOString() ?? null,
			};
		});

		const response: JellyfinEpisodeStatusResponse = {
			showTmdbId,
			episodes: items,
			providerStatus: displayEvidence.providerStatus,
		};
		return reply.send(response);
	});
}
