/**
 * Plex Episode Watch Status Routes
 *
 * Returns per-episode watch status from PlexEpisodeCache.
 */

import type { PlexEpisodeStatus, PlexEpisodeStatusResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	isCurrentAuthoritativePlexEvidence,
	loadInstanceEpisodeEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-evidence-repository.js";
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

export async function registerEpisodeRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/episodes?instanceId=X&showTmdbId=123
	 *
	 * Returns episode watch status from the PlexEpisodeCache.
	 */
	app.get("/", async (request, reply) => {
		const { instanceId, showTmdbId } = validateRequest(episodeQuery, request.query);
		const userId = request.currentUser!.id;

		const evidence = await loadInstanceEpisodeEvidence(app.prisma, { userId, instanceId });
		const summary = summarizePlexEvidence([evidence]);
		if (!evidence.available || !isCurrentAuthoritativePlexEvidence(evidence.evidence)) {
			return reply
				.status(503)
				.send({ error: "Plex cache evidence is unavailable", evidence: summary });
		}
		const episodes = evidence.rows
			.filter((episode) => episode.showTmdbId === showTmdbId)
			.sort(
				(left, right) =>
					left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber,
			);

		const items: PlexEpisodeStatus[] = episodes.map((e) => {
			let watchedByUsers: string[] = [];
			try {
				watchedByUsers = JSON.parse(e.watchedByUsers) as string[];
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

		const response: PlexEpisodeStatusResponse = {
			showTmdbId,
			episodes: items,
			evidence: summary,
		};

		return reply.send(response);
	});
}
