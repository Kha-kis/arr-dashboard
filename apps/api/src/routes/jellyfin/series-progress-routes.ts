/**
 * Jellyfin Series Progress Routes
 *
 * Aggregates owned Jellyfin episode observations into per-series progress percentages.
 * Reuses the same helper as Plex since the data shape is identical.
 */

import type { SeriesProgressResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { withIsolatedRuntimePrismaBulkReadClient } from "../../lib/backup/restore-runtime-client.js";
import {
	type JellyfinDisplayInstance,
	type JellyfinEpisodeDisplayEvidence,
	readOwnedJellyfinEpisodeDisplaySources,
} from "../../lib/jellyfin/jellyfin-display-evidence.js";
import { withJellyfinDisplayReadTiming } from "../../lib/jellyfin/jellyfin-display-read-timing.js";
import {
	jellyfinMappedSeriesProgressProof,
	jellyfinSeriesProgressProof,
} from "../../lib/jellyfin/jellyfin-generation-scoped-display.js";
import { validateRequest } from "../../lib/utils/validate.js";
import { aggregateSeriesProgress, type EpisodeInput } from "../plex/lib/series-progress-helpers.js";

const progressQuery = z.object({
	tmdbIds: z.string().min(1),
});

export const MAX_SERIES_PROGRESS_BATCH_SIZE = 200;

export function parseSeriesProgressIds(raw: string): number[] {
	return [
		...new Set(
			raw
				.split(",")
				.map(Number)
				.filter((id) => Number.isSafeInteger(id) && id > 0),
		),
	];
}

export function projectJellyfinSeriesProgress(
	instances: readonly JellyfinDisplayInstance[],
	displayEvidence: JellyfinEpisodeDisplayEvidence,
	tmdbIds: readonly number[],
): SeriesProgressResponse {
	if (instances.length === 0) return { configured: false, progress: {} };
	const statuses = displayEvidence.providerStatus?.sources ?? [];
	const sources = instances.map((instance) => {
		const statusEntries = statuses.filter(
			(source) => source.instanceId === instance.id && source.cacheType === "jellyfin_episode",
		);
		const rowsEntries = displayEvidence.sources.filter(
			(source) => source.instanceId === instance.id,
		);
		const expectedService = instance.service === "EMBY" ? "emby" : "jellyfin";
		const status =
			statusEntries.length === 1 && statusEntries[0]!.service === expectedService
				? statusEntries[0]!.status
				: undefined;
		const source = rowsEntries.length === 1 ? rowsEntries[0] : undefined;
		if (
			!status ||
			!source ||
			!["current", "last-known", "partial"].includes(status.availability) ||
			!["complete", "positive-only"].includes(status.evidence) ||
			source.rows.some((row) => row.instanceId !== instance.id)
		)
			return { complete: false, rows: [], proof: undefined, mapped: undefined, observedAt: NaN };

		const complete = status.availability === "current" && status.evidence === "complete";
		const scopeDegraded =
			status.availability === "partial" &&
			status.evidence === "positive-only" &&
			status.reasonCodes.includes("coverage-incomplete");
		const observedAt = status.observedAt ? Date.parse(status.observedAt) : NaN;
		const mapped = source[jellyfinMappedSeriesProgressProof];
		return {
			complete,
			rows: source.rows,
			proof: complete || scopeDegraded ? source[jellyfinSeriesProgressProof] : undefined,
			mapped:
				status.evidence === "positive-only" &&
				!status.reasonCodes.includes("publication-stale") &&
				mapped &&
				mapped.observedAt === status.observedAt
					? mapped.coordinatesByShow
					: undefined,
			observedAt,
		};
	});
	const rows: EpisodeInput[] = sources.flatMap((source) => source.rows);
	const uniqueInstances = new Set(instances.map(({ id }) => id)).size === instances.length;
	const allComplete = uniqueInstances && sources.every((source) => source.complete);
	const completeShows = new Set<number>();
	const mappedObservedAt = new Map<number, string>();
	if (
		!allComplete &&
		uniqueInstances &&
		(sources.some((source) => source.mapped) || sources.every((source) => source.proof))
	) {
		for (const showTmdbId of tmdbIds) {
			const exact = sources.every((source) => source.proof?.has(showTmdbId));
			if (!exact) {
				// A matched denominator needs positive or negative evidence from
				// every source and must carry the oldest observation it uses.
				if (
					!sources.some((source) => source.mapped?.has(showTmdbId)) ||
					!sources.every(
						(source) =>
							Number.isFinite(source.observedAt) &&
							(source.complete || source.proof?.has(showTmdbId) || source.mapped?.has(showTmdbId)),
					)
				)
					continue;
				const oldest = Math.min(...sources.map((source) => source.observedAt));
				mappedObservedAt.set(showTmdbId, new Date(oldest).toISOString());
			}
			completeShows.add(showTmdbId);
			for (const source of sources) {
				const coordinates = source.proof?.get(showTmdbId) ?? source.mapped?.get(showTmdbId) ?? [];
				for (const coordinate of coordinates) {
					rows.push({ showTmdbId, ...coordinate });
				}
			}
		}
	}
	const progressMap = aggregateSeriesProgress(rows, tmdbIds, allComplete || completeShows);
	for (const [showTmdbId, observedAt] of mappedObservedAt) {
		const progress = progressMap[showTmdbId];
		if (progress?.status === "exact") {
			progressMap[showTmdbId] = {
				...progress,
				status: "mapped",
				watchedSemantics: "matched",
				observedAt,
			};
		}
	}

	return {
		configured: true,
		progress: progressMap,
		providerStatus: displayEvidence.providerStatus,
	};
}

export async function registerSeriesProgressRoutes(
	app: FastifyInstance,
	_opts: FastifyPluginOptions,
) {
	app.get("/", async (request, reply) => {
		const { tmdbIds: tmdbIdsRaw } = validateRequest(progressQuery, request.query);
		const tmdbIds = parseSeriesProgressIds(tmdbIdsRaw);
		const userId = request.currentUser!.id;

		if (tmdbIds.length > MAX_SERIES_PROGRESS_BATCH_SIZE) {
			return reply
				.status(400)
				.send({ error: `Max ${MAX_SERIES_PROGRESS_BATCH_SIZE} items per request` });
		}

		return withJellyfinDisplayReadTiming(
			() =>
				withIsolatedRuntimePrismaBulkReadClient(
					app.prisma,
					async (prisma) => {
						const jellyfinInstances = await prisma.serviceInstance.findMany({
							where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
							select: { id: true, label: true, service: true },
						});

						if (jellyfinInstances.length === 0) {
							const response: SeriesProgressResponse = { configured: false, progress: {} };
							return reply.send(response);
						}

						const displayInstances: JellyfinDisplayInstance[] = jellyfinInstances.flatMap(
							(instance) =>
								instance.service === "JELLYFIN" || instance.service === "EMBY"
									? [{ id: instance.id, label: instance.label, service: instance.service }]
									: [],
						);
						const displayEvidence = await readOwnedJellyfinEpisodeDisplaySources({
							prisma,
							userId,
							instances: displayInstances,
							showTmdbIds: tmdbIds,
							includeSeriesProgressProof: true,
						});
						return reply.send(
							projectJellyfinSeriesProgress(displayInstances, displayEvidence, tmdbIds),
						);
					},
					{ lease: "phase" },
				),
			(timing) =>
				app.log.info(
					{
						category: "jellyfin-display-read-timing",
						kind: "progress",
						spansOverlap: true,
						...timing,
					},
					"Jellyfin display read timing",
				),
		);
	});
}
