/**
 * Plex Watch Enrichment Routes
 *
 * Batch endpoint to fetch confirmed positive watch status for library items.
 * Each provider is projected independently so one unavailable cache cannot hide
 * current positives from another; omitted rows always remain unknown.
 */

import type { WatchEnrichmentResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	listDisplayableSelectedPlexEvidence,
	PlexAuthorityService,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
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
	 * Returns confirmed positive Plex watch observations. Provider status describes incomplete or
	 * unavailable Plex evidence; an omitted item is unknown rather than unwatched.
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
		}).readUserSelectedDisplay({
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
		const displayablePlexEvidence = listDisplayableSelectedPlexEvidence(plexEvidence);
		const plexEntries = displayablePlexEvidence.flatMap((entry) =>
			entry.rows.map((row) => ({ ...row, providerStatus: entry.providerStatus })),
		);

		// Aggregate into enrichment items using extracted pure helper
		const items = aggregateWatchEnrichment(uniqueKeys, plexEntries, [], filterUser, request.log);

		const response: WatchEnrichmentResponse = {
			items,
			...(plexEvidence.length > 0 ? { evidence: evidenceSummary } : {}),
		};
		return reply.send(response);
	});
}
