/**
 * Plex Series Progress Routes
 *
 * Aggregates PlexEpisodeCache watch data into per-series progress percentages.
 * Used for showing "15/24 (63%)" progress bars on library cards.
 */

import type { SeriesProgressResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	hasCompleteAuthoritativePlexEvidence,
	isCurrentAuthoritativePlexEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
import { PlexAuthorityService } from "../../lib/plex/plex-authority-service.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateSeriesProgress, type EpisodeInput } from "./lib/series-progress-helpers.js";

const progressQuery = z.object({
	tmdbIds: z.string().min(1),
});

const MAX_BATCH_SIZE = 200;

export async function registerSeriesProgressRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/plex/series-progress?tmdbIds=123,456
	 *
	 * Returns watched/total episode counts for each series TMDB ID.
	 */
	app.get("/", async (request, reply) => {
		const { tmdbIds: tmdbIdsRaw } = validateRequest(progressQuery, request.query);
		const tmdbIds = [
			...new Set(
				tmdbIdsRaw
					.split(",")
					.map(Number)
					.filter((id) => Number.isSafeInteger(id) && id > 0),
			),
		];
		const userId = request.currentUser!.id;

		if (tmdbIds.length > MAX_BATCH_SIZE) {
			return reply.status(400).send({ error: `Max ${MAX_BATCH_SIZE} items per request` });
		}

		// Get user's Plex instances
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			select: { id: true },
		});

		if (plexInstances.length === 0) {
			const response: SeriesProgressResponse = { configured: false, progress: {} };
			return reply.send(response);
		}

		const evidence = [];
		const episodes: EpisodeInput[] = [];
		const authority = new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		});
		for (const instance of plexInstances) {
			const exact = await authority.readInstanceSelectedEpisodes({
				userId,
				instanceId: instance.id,
				showTmdbIds: tmdbIds,
			});
			evidence.push(exact);
			if (exact.available && isCurrentAuthoritativePlexEvidence(exact.evidence)) {
				episodes.push(...exact.rows);
			} else {
				const positive = await authority.readPositiveEpisodeDisplayEvidence({
					userId,
					instanceId: instance.id,
				});
				if (positive.available)
					episodes.push(...positive.rows.filter((row) => row.watched === true));
			}
		}
		const summary = summarizePlexEvidence(evidence);
		const progressMap = aggregateSeriesProgress(
			episodes,
			tmdbIds,
			hasCompleteAuthoritativePlexEvidence(evidence),
		);

		const response: SeriesProgressResponse = {
			configured: true,
			progress: progressMap,
			evidence: summary,
		};
		return reply.send(response);
	});
}
