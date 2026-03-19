/**
 * Seerr Library Enrichment Routes
 *
 * Batch endpoint to fetch TMDB ratings + open issue counts for library items.
 * Used by the frontend to enrich library cards with Seerr data.
 */

import type { LibraryEnrichmentItem, LibraryEnrichmentResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireSeerrClient } from "../../lib/seerr/seerr-client.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { runWithConcurrency } from "./lib/enrichment-helpers.js";

const instanceIdParams = z.object({ instanceId: z.string().min(1) });

const enrichmentQuery = z.object({
	tmdbIds: z.string().min(1),
	types: z
		.string()
		.min(1)
		.transform((val, ctx) => {
			const parts = val.split(",");
			for (const t of parts) {
				if (t !== "movie" && t !== "tv") {
					ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid type: ${t}` });
					return z.NEVER;
				}
			}
			return parts as ("movie" | "tv")[];
		}),
});

/** Max items per batch request */
const MAX_BATCH_SIZE = 100;

/** Concurrency limit for parallel Seerr calls */
const CONCURRENCY_LIMIT = 10;

export async function registerLibraryEnrichmentRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/seerr/library-enrichment/:instanceId?tmdbIds=123,456&types=movie,tv
	 *
	 * Fetches TMDB vote average + backdrop for each item, plus aggregated open issue counts.
	 * tmdbIds and types are parallel arrays (same length, same order).
	 */
	app.get("/:instanceId", async (request, reply) => {
		const { instanceId } = validateRequest(instanceIdParams, request.params);
		const { tmdbIds: tmdbIdsRaw, types } = validateRequest(enrichmentQuery, request.query);

		const tmdbIds = tmdbIdsRaw.split(",").map(Number);

		if (tmdbIds.length !== types.length) {
			return reply.status(400).send({ error: "tmdbIds and types must have equal length" });
		}
		if (tmdbIds.length > MAX_BATCH_SIZE) {
			return reply.status(400).send({ error: `Max ${MAX_BATCH_SIZE} items per request` });
		}
		if (tmdbIds.some((id) => !Number.isFinite(id) || id <= 0)) {
			return reply.status(400).send({ error: "All tmdbIds must be positive integers" });
		}

		const client = await requireSeerrClient(app, request.currentUser!.id, instanceId);

		// Deduplicate items by key (same tmdbId+type may appear multiple times across instances)
		const uniqueItems = new Map<string, { type: "movie" | "tv"; tmdbId: number }>();
		for (let i = 0; i < tmdbIds.length; i++) {
			const key = `${types[i]}:${tmdbIds[i]}`;
			if (!uniqueItems.has(key)) {
				uniqueItems.set(key, { type: types[i]!, tmdbId: tmdbIds[i]! });
			}
		}

		// Fetch media summaries in parallel with concurrency limit
		const entries = [...uniqueItems.entries()];
		const summaryResults = await runWithConcurrency(
			entries.map(
				([, { type, tmdbId }]) =>
					() =>
						client.getMediaSummary(type, tmdbId),
			),
			CONCURRENCY_LIMIT,
		);

		// Fetch open issue counts (single paginated walk)
		let issueCounts = new Map<string, number>();
		let issueCountsAvailable = true;
		try {
			issueCounts = await client.getOpenIssueCounts();
		} catch (err) {
			issueCountsAvailable = false;
			request.log.warn({ err }, "Failed to fetch Seerr issue counts for library enrichment");
		}

		// Assemble response
		const items: Record<string, LibraryEnrichmentItem> = {};
		let enrichmentFailures = 0;
		let firstError: unknown;

		for (let i = 0; i < entries.length; i++) {
			const key = entries[i]![0];
			const result = summaryResults[i]!;
			if (result.status === "fulfilled") {
				items[key] = {
					voteAverage: result.value.voteAverage,
					backdropPath: result.value.backdropPath,
					posterPath: result.value.posterPath,
					openIssueCount: issueCounts.get(key) ?? 0,
				};
			} else {
				enrichmentFailures++;
				firstError ??= result.reason;
			}
		}

		if (enrichmentFailures > 0) {
			request.log.warn(
				{ err: firstError },
				`Seerr library enrichment: ${enrichmentFailures}/${entries.length} lookups failed`,
			);
		}

		const response: LibraryEnrichmentResponse = {
			items,
			...(!issueCountsAvailable ? { issueCountsAvailable: false } : {}),
			...(enrichmentFailures > 0 ? { enrichmentFailures } : {}),
		};
		return reply.send(response);
	});
}
