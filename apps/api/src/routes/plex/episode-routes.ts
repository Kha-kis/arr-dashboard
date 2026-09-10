/**
 * Plex Episode Watch Status Routes
 *
 * Returns per-episode watch status from PlexEpisodeCache.
 */

import type { PlexEpisodeStatus, PlexEpisodeStatusResponse } from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import {
	isCurrentAuthoritativePlexEvidence,
	PlexAuthorityService,
	summarizePlexEvidence,
} from "../../lib/plex/plex-authority-service.js";
import { validateRequest } from "../../lib/utils/validate.js";

const episodeQuery = z.object({
	instanceId: z.string().min(1),
	showTmdbId: z
		.string()
		.min(1)
		.transform((val) => {
			const n = Number(val);
			if (!Number.isSafeInteger(n) || n <= 0) return 0;
			return n;
		})
		.pipe(z.number().positive()),
});

function parseWatchedByUsers(value: string): string[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")
			? parsed
			: [];
	} catch {
		return [];
	}
}

function serializeLastWatchedAt(value: Date | null): string | null {
	return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

export async function registerEpisodeRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	/**
	 * GET /api/plex/episodes?instanceId=X&showTmdbId=123
	 *
	 * Returns episode watch status from the PlexEpisodeCache.
	 */
	app.get("/", async (request, reply) => {
		const { instanceId, showTmdbId } = validateRequest(episodeQuery, request.query);
		const userId = request.currentUser!.id;

		const authority = new PlexAuthorityService({
			prisma: app.prisma,
			encryptor: app.encryptor,
			log: request.log,
		});
		const exactEvidence = await authority.readInstanceSelectedEpisodes({
			userId,
			instanceId,
			showTmdbIds: [showTmdbId],
		});

		let summary = summarizePlexEvidence([exactEvidence]);
		let episodes: Array<{
			seasonNumber: number;
			episodeNumber: number;
			title: string;
			watched: boolean;
			watchedByUsers: string;
			lastWatchedAt: Date | null;
		}> = [];
		if (exactEvidence.available && isCurrentAuthoritativePlexEvidence(exactEvidence.evidence)) {
			episodes = exactEvidence.rows;
		} else {
			const positiveEvidence = await authority.readPositiveEpisodeDisplayEvidence({
				userId,
				instanceId,
			});
			if (!positiveEvidence.available) {
				summary = summarizePlexEvidence([positiveEvidence]);
				return reply
					.status(503)
					.send({ error: "Plex cache evidence is unavailable", evidence: summary });
			}
			summary = summarizePlexEvidence([positiveEvidence]);
			episodes = positiveEvidence.rows.filter((episode) => episode.showTmdbId === showTmdbId);
		}

		episodes.sort(
			(left, right) =>
				left.seasonNumber - right.seasonNumber || left.episodeNumber - right.episodeNumber,
		);

		const items: PlexEpisodeStatus[] = episodes.map((e) => {
			return {
				seasonNumber: e.seasonNumber,
				episodeNumber: e.episodeNumber,
				title: e.title,
				watched: e.watched,
				watchedByUsers: parseWatchedByUsers(e.watchedByUsers),
				lastWatchedAt: serializeLastWatchedAt(e.lastWatchedAt),
			};
		});

		const response: PlexEpisodeStatusResponse = {
			showTmdbId,
			episodes: items,
			evidence: summary,
		};

		return reply.send(response);
	});
}
