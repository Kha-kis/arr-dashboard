/**
 * Jellyfin Series Progress Routes
 *
 * Aggregates owned Jellyfin episode observations into per-series progress percentages.
 * Reuses the same helper as Plex since the data shape is identical.
 */

import type { SeriesProgressResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	isArithmeticAuthoritativeProviderObservationStatus,
	type JellyfinDisplayInstance,
	readOwnedJellyfinEpisodeDisplaySources,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateSeriesProgress } from "../plex/lib/series-progress-helpers.js";

const progressQuery = z.object({
	tmdbIds: z.string().min(1),
});

const MAX_BATCH_SIZE = 200;

export async function registerSeriesProgressRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { tmdbIds: tmdbIdsRaw } = validateRequest(progressQuery, request.query);
		const tmdbIds = tmdbIdsRaw
			.split(",")
			.map(Number)
			.filter((id) => Number.isFinite(id) && id > 0);
		const userId = request.currentUser!.id;

		if (tmdbIds.length === 0) {
			const response: SeriesProgressResponse = { progress: {} };
			return reply.send(response);
		}

		if (tmdbIds.length > MAX_BATCH_SIZE) {
			return reply.status(400).send({ error: `Max ${MAX_BATCH_SIZE} items per request` });
		}

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true, label: true, service: true },
		});

		if (jellyfinInstances.length === 0) {
			const response: SeriesProgressResponse = { progress: {} };
			return reply.send(response);
		}

		const displayInstances: JellyfinDisplayInstance[] = jellyfinInstances.flatMap((instance) =>
			instance.service === "JELLYFIN" || instance.service === "EMBY"
				? [{ id: instance.id, label: instance.label, service: instance.service }]
				: [],
		);
		const displayEvidence = await readOwnedJellyfinEpisodeDisplaySources({
			prisma: app.prisma,
			userId,
			instances: displayInstances,
		});
		const progressMap = isArithmeticAuthoritativeProviderObservationStatus(
			displayEvidence.providerStatus,
		)
			? aggregateSeriesProgress(
					displayEvidence.sources
						.flatMap((source) => source.rows)
						.filter((episode) => tmdbIds.includes(episode.showTmdbId))
						.sort(
							(left, right) =>
								left.showTmdbId - right.showTmdbId ||
								left.instanceId.localeCompare(right.instanceId) ||
								left.seasonNumber - right.seasonNumber ||
								left.episodeNumber - right.episodeNumber ||
								left.id.localeCompare(right.id),
						),
				)
			: {};

		const response: SeriesProgressResponse = {
			progress: progressMap,
			providerStatus: displayEvidence.providerStatus,
		};
		return reply.send(response);
	});
}
