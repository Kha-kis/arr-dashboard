/**
 * Plex Series Progress Routes
 *
 * Aggregates PlexEpisodeCache watch data into per-series progress percentages.
 * Used for showing "15/24 (63%)" progress bars on library cards.
 */

import type { SeriesProgressResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { withIsolatedRuntimePrismaBulkReadClient } from "../../lib/backup/restore-runtime-client.js";
import { withRuntimeReadTiming } from "../../lib/backup/restore-runtime-read-timing.js";
import {
	hasCompleteAuthoritativePlexEvidence,
	isCurrentAuthoritativePlexEvidence,
	PlexAuthorityService,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
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

		const startedAt = performance.now();
		const readProgress = () =>
			withIsolatedRuntimePrismaBulkReadClient(
				app.prisma,
				async (prisma) => {
					// Get user's Plex instances
					const plexInstances = await prisma.serviceInstance.findMany({
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
						prisma,
						readParentObservation:
							app.dbProvider === "sqlite"
								? (operation) => withIsolatedRuntimePrismaBulkReadClient(app.prisma, operation)
								: undefined,
						encryptor: app.encryptor,
						log: request.log,
					});
					for (const instance of plexInstances) {
						const exact = await authority.readInstanceSelectedEpisodeDisplay({
							userId,
							instanceId: instance.id,
							showTmdbIds: tmdbIds,
						});
						if (exact.available && isCurrentAuthoritativePlexEvidence(exact.evidence)) {
							evidence.push(exact);
							episodes.push(...exact.rows);
						} else {
							const positive = await authority.readPositiveEpisodeDisplayEvidence({
								userId,
								instanceId: instance.id,
							});
							evidence.push(positive);
							if (positive.available)
								episodes.push(...positive.rows.filter((row) => row.watched === true));
						}
					}
					const summary = summarizePlexEvidence(evidence);
					// Usable cached rows do not make a retained or failed refresh current.
					if (evidence.length > 1 && evidence.every((entry) => entry.available)) {
						if (evidence.some((entry) => entry.evidence.availability === "last-known"))
							summary.availability = "last-known";
						if (evidence.some((entry) => entry.evidence.attemptState === "in_progress"))
							summary.attemptState = "in_progress";
						else if (evidence.some((entry) => entry.evidence.attemptState === "error"))
							summary.attemptState = "error";
					}
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
				},
				{ lease: "phase" },
			);
		return withRuntimeReadTiming(readProgress, (stages) => {
			app.log.info(
				{
					category: "plex-series-progress-runtime-timing",
					elapsedMs: Math.round(performance.now() - startedAt),
					spansOverlap: true,
					stages,
				},
				"Plex series progress runtime timing",
			);
		});
	});
}
