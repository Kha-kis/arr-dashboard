/**
 * Jellyfin Watch Enrichment Routes
 *
 * Batch endpoint to fetch confirmed positive watch status from owned observations.
 * Each provider is projected independently; unavailable sources cannot hide
 * verified positives, and omitted rows remain unknown.
 */

import type { WatchEnrichmentItem } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	type JellyfinDisplayInstance,
	readOwnedJellyfinLibraryDisplaySources,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";
import { projectWatchDisplayEvidence } from "../../lib/provider-observation/watch-display-evidence.js";
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
	 * Returns Jellyfin/Emby positives from display-admitted observations.
	 * Provider status reports incomplete or unavailable native sources without asserting absence.
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
			select: { id: true, label: true, service: true },
		});
		const displayEvidence =
			jellyfinInstances.length > 0
				? await readOwnedJellyfinLibraryDisplaySources({
						prisma: app.prisma,
						userId,
						instances: jellyfinInstances as JellyfinDisplayInstance[],
					})
				: { sources: [], providerStatus: undefined };
		const sourceStatuses = new Map(
			displayEvidence.providerStatus?.sources.map((source) => [source.instanceId, source.status]) ??
				[],
		);
		const jellyfinEntries = displayEvidence.sources
			.flatMap((source) =>
				source.rows.map((row) => ({
					...row,
					providerStatus: sourceStatuses.get(source.instanceId),
				})),
			)
			.filter((entry) => tmdbIdList.includes(entry.tmdbId))
			.sort(
				(left, right) =>
					left.instanceId.localeCompare(right.instanceId) || left.id.localeCompare(right.id),
			);

		const items: Record<string, WatchEnrichmentItem> = {};
		for (const [key] of uniqueKeys) {
			const jellyfinMatches = jellyfinEntries.filter(
				(entry) => `${entry.mediaType}:${entry.tmdbId}` === key,
			);
			if (jellyfinMatches.length === 0) continue;
			const projections = [
				...jellyfinMatches.map((entry) => ({
					entry,
					display: projectWatchDisplayEvidence({ status: entry.providerStatus, row: entry }),
				})),
			];
			const countContributors = projections.filter(
				(candidate) =>
					candidate.display.watchCount !== null &&
					candidate.display.watchCountSemantics !== "unknown",
			);
			const preferredMedia = jellyfinMatches[0];
			const preferredDisplay = preferredMedia
				? projectWatchDisplayEvidence({
						status: preferredMedia.providerStatus,
						row: preferredMedia,
					})
				: undefined;
			const count = countContributors.reduce(
				(maximum, candidate) => Math.max(maximum, candidate.display.watchCount ?? 0),
				0,
			);
			const watchCountSemantics =
				countContributors.length === 0
					? "unknown"
					: countContributors.length === 1 &&
							countContributors[0]?.display.watchCountSemantics === "exact"
						? "exact"
						: "lower-bound";
			const zeroLowerBound = watchCountSemantics === "lower-bound" && count === 0;
			let collections: string[] = [];
			try {
				const parsed: unknown = preferredMedia ? JSON.parse(preferredMedia.collections) : [];
				if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string"))
					collections = parsed;
			} catch {
				// Malformed optional metadata is not display evidence.
			}
			items[key] = {
				lastWatchedAt: preferredDisplay?.lastWatchedAt ?? null,
				watchCount: countContributors.length === 0 || zeroLowerBound ? null : count,
				watchCountSemantics: zeroLowerBound ? "unknown" : watchCountSemantics,
				watchedByUsers: preferredDisplay?.watchedByUsers ?? [],
				onDeck: preferredMedia?.onDeck ?? false,
				userRating: preferredMedia?.userRating ?? null,
				source: "jellyfin",
				ratingKey: null,
				jellyfinId: preferredMedia?.jellyfinId ?? null,
				instanceId: preferredMedia?.instanceId ?? null,
				collections,
				labels: [],
			};
		}

		return reply.send({
			items,
			providerStatus: displayEvidence.providerStatus,
		});
	});
}
