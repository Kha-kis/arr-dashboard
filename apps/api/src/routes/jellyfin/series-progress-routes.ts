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

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true, label: true, service: true },
		});

		if (jellyfinInstances.length === 0) {
			const response: SeriesProgressResponse = { configured: false, progress: {} };
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
		const statuses = displayEvidence.providerStatus?.sources ?? [];
		const sources = displayInstances.map((instance) => {
			const statusEntries = statuses.filter(
				(source) => source.instanceId === instance.id && source.cacheType === "jellyfin_episode",
			);
			const rowsEntries = displayEvidence.sources.filter(
				(source) => source.instanceId === instance.id,
			);
			const status = statusEntries.length === 1 ? statusEntries[0]!.status : undefined;
			const admitted =
				status &&
				["current", "last-known", "partial"].includes(status.availability) &&
				["complete", "positive-only"].includes(status.evidence) &&
				rowsEntries.length === 1;
			return {
				complete: Boolean(
					admitted && status.availability === "current" && status.evidence === "complete",
				),
				rows: admitted ? rowsEntries[0]!.rows : [],
			};
		});
		const progressMap = aggregateSeriesProgress(
			sources.flatMap((source) => source.rows),
			tmdbIds,
			sources.every((source) => source.complete),
		);

		const response: SeriesProgressResponse = {
			configured: true,
			progress: progressMap,
			providerStatus: displayEvidence.providerStatus,
		};
		return reply.send(response);
	});
}
