/**
 * Jellyfin Watch Enrichment Routes
 *
 * Batch endpoint to fetch watch status for library items from JellyfinCache + TautulliCache.
 * No live API calls — reads exclusively from cached data.
 */

import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { validateRequest } from "../../lib/utils/validate.js";

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
});

const MAX_BATCH_SIZE = 200;

export async function registerWatchEnrichmentRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	/**
	 * GET /api/jellyfin/watch-enrichment?tmdbIds=123,456&types=movie,series
	 *
	 * Reads JellyfinCache + optionally TautulliCache to return watch data.
	 * Keys in response are "movie:123" or "series:456".
	 */
	app.get("/", async (request, reply) => {
		const { tmdbIds: tmdbIdsRaw, types } = validateRequest(enrichmentQuery, request.query);
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

		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			select: { id: true },
		});
		const tautulliInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "TAUTULLI", enabled: true },
			select: { id: true },
		});

		const jellyfinInstanceIds = jellyfinInstances.map((i) => i.id);
		const tautulliInstanceIds = tautulliInstances.map((i) => i.id);

		const [jellyfinEntries, tautulliEntries] = await Promise.all([
			jellyfinInstanceIds.length > 0
				? app.prisma.jellyfinCache.findMany({
						where: {
							instanceId: { in: jellyfinInstanceIds },
							tmdbId: { in: tmdbIdList },
						},
					})
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

		// Aggregate enrichment data
		const items: Record<
			string,
			{
				lastWatchedAt: string | null;
				watchCount: number;
				watchedByUsers: string[];
				onDeck: boolean;
				userRating: number | null;
				source: string;
				jellyfinId: string | null;
				instanceId: string | null;
				collections: string[];
			}
		> = {};

		// Index Jellyfin entries by key
		for (const entry of jellyfinEntries) {
			const key = `${entry.mediaType}:${entry.tmdbId}`;
			if (!uniqueKeys.has(key)) continue;

			let watchedByUsers: string[] = [];
			try {
				watchedByUsers = JSON.parse(entry.watchedByUsers) as string[];
			} catch {
				// Skip malformed JSON
			}

			let collections: string[] = [];
			try {
				collections = JSON.parse(entry.collections) as string[];
			} catch {
				// Skip malformed JSON
			}

			const existing = items[key];
			if (!existing || entry.watchCount > existing.watchCount) {
				items[key] = {
					lastWatchedAt: entry.lastWatchedAt?.toISOString() ?? null,
					watchCount: entry.watchCount,
					watchedByUsers,
					onDeck: entry.onDeck,
					userRating: entry.userRating,
					source: "jellyfin",
					jellyfinId: entry.jellyfinId,
					instanceId: entry.instanceId,
					collections,
				};
			}
		}

		// Supplement with Tautulli data where Jellyfin has no watch info
		for (const entry of tautulliEntries) {
			const key = `${entry.mediaType}:${entry.tmdbId}`;
			if (!uniqueKeys.has(key)) continue;

			const existing = items[key];
			if (existing && existing.watchCount > 0) continue;

			let watchedByUsers: string[] = [];
			try {
				watchedByUsers = JSON.parse(entry.watchedByUsers) as string[];
			} catch {
				// Skip malformed JSON
			}

			items[key] = {
				lastWatchedAt: entry.lastWatchedAt?.toISOString() ?? null,
				watchCount: entry.watchCount,
				watchedByUsers,
				onDeck: existing?.onDeck ?? false,
				userRating: existing?.userRating ?? null,
				source: "tautulli",
				jellyfinId: existing?.jellyfinId ?? null,
				instanceId: existing?.instanceId ?? null,
				collections: existing?.collections ?? [],
			};
		}

		return reply.send({ items });
	});
}
