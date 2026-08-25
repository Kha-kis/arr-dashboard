import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PlexClient } from "../plex-client.js";
import { collectPositivePlexEpisodeLiveEvidence } from "../plex-episode-live-collector.js";

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

function parent(showTmdbId: number, ratingKey: string) {
	return {
		instanceId: "plex-1",
		generationId: "parent-generation-1",
		showTmdbId,
		sectionId: "shows",
		sectionUuid: "shows-uuid",
		mediaType: "series" as const,
		tvdbId: showTmdbId + 1000,
		ratingKey,
	};
}

function client(getEpisodes: PlexClient["getEpisodes"]): PlexClient {
	return { getEpisodes } as unknown as PlexClient;
}

describe("collectPositivePlexEpisodeLiveEvidence", () => {
	it("collects a sole live parent without history or episode TMDB metadata and omits zero", async () => {
		const getEpisodes = vi.fn().mockResolvedValue([
			{
				ratingKey: "episode-positive",
				title: "Pilot",
				seasonNumber: 1,
				episodeNumber: 1,
				viewCount: 2,
			},
			{
				ratingKey: "episode-zero",
				title: "Second",
				seasonNumber: 1,
				episodeNumber: 2,
				viewCount: 0,
			},
		]);

		const result = await collectPositivePlexEpisodeLiveEvidence(
			client(getEpisodes),
			[parent(42, "show-1")],
			log,
			"connection-fingerprint",
		);

		expect(getEpisodes).toHaveBeenCalledWith("show-1");
		expect(result).toMatchObject({
			kind: "positive-observation",
			eligibleShows: 1,
			refreshedShows: 1,
			errors: 0,
			rows: [
				{
					instanceId: "plex-1",
					showTmdbId: 42,
					ratingKey: "episode-positive",
					seasonNumber: 1,
					episodeNumber: 1,
					watchCount: 2,
					sourceFingerprint: "connection-fingerprint",
				},
			],
		});
		expect(result.rows?.map((row) => row.ratingKey)).not.toContain("episode-zero");
	});

	it("excludes every duplicate parent group without summing and still collects a separate sole show", async () => {
		const getEpisodes = vi.fn().mockResolvedValue([
			{
				ratingKey: "unique-episode",
				title: "Pilot",
				seasonNumber: 1,
				episodeNumber: 1,
				viewCount: 1,
			},
		]);

		const result = await collectPositivePlexEpisodeLiveEvidence(
			client(getEpisodes),
			[parent(42, "show-copy-a"), parent(42, "show-copy-b"), parent(43, "show-unique")],
			log,
			"connection-fingerprint",
		);

		expect(getEpisodes).toHaveBeenCalledTimes(1);
		expect(getEpisodes).toHaveBeenCalledWith("show-unique");
		expect(result).toMatchObject({
			kind: "positive-observation",
			eligibleShows: 1,
			refreshedShows: 1,
			partialReasons: [{ code: "ambiguous_episode_parent_targets", count: 2 }],
			rows: [expect.objectContaining({ showTmdbId: 43, watchCount: 1 })],
		});
	});
});
