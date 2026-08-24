/**
 * Plex Watch Enrichment Routes
 *
 * Batch endpoint to fetch watch status for library items from PlexCache + TautulliCache.
 * No live API calls — reads exclusively from cached data refreshed on a 6h schedule.
 */

import type { WatchEnrichmentResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	hasAuthoritativeSelectedPlexEvidence,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
import { PlexAuthorityService } from "../../lib/plex/plex-authority-service.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateWatchEnrichment } from "./lib/watch-enrichment-helpers.js";

const enrichmentQuery = z.object({
	tmdbIds: z.string().min(1),
	types: z
		.string()
		.min(1)
		.transform((val, ctx) => {
			const parts = val.split(",");
			for (const t of parts) {
				if (t !== "movie" && t !== "series") {
					ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid type: ${t}` });
					return z.NEVER;
				}
			}
			return parts as ("movie" | "series")[];
		}),
	filterUser: z.string().max(255).optional(),
});

const MAX_BATCH_SIZE = 200;

export async function registerWatchEnrichmentRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/plex/watch-enrichment?tmdbIds=123,456&types=movie,series
	 *
	 * Reads PlexCache + TautulliCache to return watch count, last watched, on-deck, rating.
	 * tmdbIds and types are parallel arrays (same length, same order).
	 */
	app.get("/", async (request, reply) => {
		const {
			tmdbIds: tmdbIdsRaw,
			types,
			filterUser,
		} = validateRequest(enrichmentQuery, request.query);
		const tmdbIds = tmdbIdsRaw.split(",").map(Number);
		const userId = request.currentUser!.id;

		if (tmdbIds.length !== types.length) {
			return reply.status(400).send({ error: "tmdbIds and types must have equal length" });
		}
		if (tmdbIds.length > MAX_BATCH_SIZE) {
			return reply.status(400).send({ error: `Max ${MAX_BATCH_SIZE} items per request` });
		}
		if (tmdbIds.some((id) => !Number.isFinite(id) || id <= 0)) {
			return reply.status(400).send({ error: "All tmdbIds must be positive integers" });
		}

		// Deduplicate by key
		const uniqueKeys = new Map<string, { tmdbId: number; mediaType: string }>();
		for (let i = 0; i < tmdbIds.length; i++) {
			const key = `${types[i]}:${tmdbIds[i]}`;
			if (!uniqueKeys.has(key)) {
				uniqueKeys.set(key, { tmdbId: tmdbIds[i]!, mediaType: types[i]! });
			}
		}

		const tmdbIdList = [...new Set(tmdbIds)];

		const plexEvidence = await new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		}).readUserSelected({
			userId,
			selection: {
				kind: "targets",
				targets: tmdbIdList.flatMap((tmdbId) => [
					{ tmdbId, mediaType: "movie" as const },
					{ tmdbId, mediaType: "series" as const },
				]),
			},
			domains: ["membership", "display", "labels", "collections", "watch", "on-deck"],
		});
		const evidenceSummary = summarizePlexEvidence(plexEvidence);
		if (plexEvidence.length > 0 && !hasAuthoritativeSelectedPlexEvidence(plexEvidence)) {
			return reply.status(503).send({
				error: "Plex cache evidence is unavailable",
				evidence: evidenceSummary,
			});
		}
		const tautulliInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "TAUTULLI", enabled: true },
			select: { id: true },
		});

		const tautulliInstanceIds = tautulliInstances.map((i) => i.id);

		// Query PlexCache and TautulliCache in parallel
		const [plexEntries, tautulliEntries] = await Promise.all([
			hasAuthoritativeSelectedPlexEvidence(plexEvidence)
				? plexEvidence.flatMap((entry) => entry.rows)
				: [],
			tautulliInstanceIds.length > 0
				? app.prisma.tautulliCache.findMany({
						where: {
							instanceId: { in: tautulliInstanceIds },
							tmdbId: { in: tmdbIdList },
						},
					})
				: [],
		]);

		// Aggregate into enrichment items using extracted pure helper
		const items = aggregateWatchEnrichment(
			uniqueKeys,
			plexEntries,
			tautulliEntries,
			filterUser,
			request.log,
		);

		const response: WatchEnrichmentResponse = {
			items,
			...(plexEvidence.length > 0 ? { evidence: evidenceSummary } : {}),
		};
		return reply.send(response);
	});
}
