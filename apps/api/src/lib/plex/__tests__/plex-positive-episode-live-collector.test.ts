import type { FastifyBaseLogger } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { PlexClient } from "../plex-client.js";
import {
	collectPlexEpisodeUnit,
	collectPositivePlexEpisodeLiveEvidence,
} from "../plex-episode-live-collector.js";
import { planPlexEpisodeRefresh } from "../plex-episode-refresh-plan.js";

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

describe("collectPlexEpisodeUnit", () => {
	it("collects one bounded unit without history or account access and preserves provenance", async () => {
		const parents = Array.from({ length: 50 }, (_, index) =>
			parent(index + 1, `show-${index + 1}`),
		);
		const unit = planPlexEpisodeRefresh(parents).units[0]!;
		const getEpisodes = vi.fn(async (ratingKey: string) => [
			{
				ratingKey: `episode-${ratingKey}`,
				title: "Pilot",
				seasonNumber: 1,
				episodeNumber: 1,
				viewCount: 2,
			},
		]);
		const getHistory = vi.fn();
		const getAccounts = vi.fn();

		const result = await collectPlexEpisodeUnit(
			{ getEpisodes, getHistory, getAccounts } as unknown as PlexClient,
			unit,
			{
				instanceId: "plex-1",
				generationId: "parent-generation-1",
				connectionGeneration: 7,
				identityGeneration: 11,
				sourceFingerprint: "fingerprint-1",
			},
		);

		expect(getEpisodes).toHaveBeenCalledTimes(50);
		expect(getHistory).not.toHaveBeenCalled();
		expect(getAccounts).not.toHaveBeenCalled();
		expect(result).toMatchObject({ complete: true, refreshedTargets: 50 });
		expect(result.rows).toHaveLength(50);
		expect(result.rows[0]).toMatchObject({
			parentRatingKey: "show-1",
			sourceFingerprint: "fingerprint-1",
			watchCount: 2,
		});
	});

	it("rejects direct units above the bounded target limit before provider I/O", async () => {
		const parents = Array.from({ length: 51 }, (_, index) =>
			parent(index + 1, `show-${index + 1}`),
		);
		const oversized = {
			...planPlexEpisodeRefresh(parents.slice(0, 50)).units[0]!,
			targets: parents,
		};
		const getEpisodes = vi.fn();

		const result = await collectPlexEpisodeUnit(
			{ getEpisodes } as unknown as PlexClient,
			oversized,
			{
				instanceId: "plex-1",
				generationId: "parent-generation-1",
				connectionGeneration: 7,
				identityGeneration: 11,
				sourceFingerprint: "fingerprint-1",
			},
		);

		expect(getEpisodes).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			complete: false,
			refreshedTargets: 0,
			rows: [],
			reasonCode: "coverage-incomplete",
		});
	});

	it("returns no rows and a sanitized reason when one target fails or has duplicate coordinates", async () => {
		const parents = [parent(1, "show-1"), parent(2, "show-2")];
		const unit = planPlexEpisodeRefresh(parents).units[0]!;
		const providerFailure = await collectPlexEpisodeUnit(
			{
				getEpisodes: vi.fn().mockRejectedValue(new Error("secret provider detail")),
			} as unknown as PlexClient,
			unit,
			{
				instanceId: "plex-1",
				generationId: "parent-generation-1",
				connectionGeneration: 7,
				identityGeneration: 11,
				sourceFingerprint: "fingerprint-1",
			},
		);
		expect(providerFailure).toMatchObject({
			complete: false,
			rows: [],
			reasonCode: "provider-unavailable",
		});
		expect(JSON.stringify(providerFailure)).not.toContain("secret provider detail");

		const duplicateCoordinates = await collectPlexEpisodeUnit(
			{
				getEpisodes: vi.fn().mockResolvedValue([
					{
						ratingKey: "episode-a",
						title: "Pilot",
						seasonNumber: 1,
						episodeNumber: 1,
						viewCount: 1,
					},
					{
						ratingKey: "episode-b",
						title: "Pilot again",
						seasonNumber: 1,
						episodeNumber: 1,
						viewCount: 2,
					},
				]),
			} as unknown as PlexClient,
			unit,
			{
				instanceId: "plex-1",
				generationId: "parent-generation-1",
				connectionGeneration: 7,
				identityGeneration: 11,
				sourceFingerprint: "fingerprint-1",
			},
		);
		expect(duplicateCoordinates).toMatchObject({
			complete: false,
			rows: [],
			reasonCode: "rows-inconsistent",
		});

		const invalidCount = await collectPlexEpisodeUnit(
			{
				getEpisodes: vi.fn().mockResolvedValue([
					{
						ratingKey: "episode-invalid",
						title: "Pilot",
						seasonNumber: 1,
						episodeNumber: 1,
						viewCount: -1,
					},
				]),
			} as unknown as PlexClient,
			unit,
			{
				instanceId: "plex-1",
				generationId: "parent-generation-1",
				connectionGeneration: 7,
				identityGeneration: 11,
				sourceFingerprint: "fingerprint-1",
			},
		);
		expect(invalidCount).toMatchObject({
			complete: false,
			rows: [],
			reasonCode: "rows-inconsistent",
		});
	});

	it("rejects a target/context mismatch before the first provider call", async () => {
		const unit = planPlexEpisodeRefresh([parent(1, "show-1")]).units[0]!;
		const getEpisodes = vi.fn();

		const result = await collectPlexEpisodeUnit({ getEpisodes } as unknown as PlexClient, unit, {
			instanceId: "plex-other",
			generationId: "parent-generation-1",
			connectionGeneration: 7,
			identityGeneration: 11,
			sourceFingerprint: "fingerprint-1",
		});

		expect(getEpisodes).not.toHaveBeenCalled();
		expect(result).toMatchObject({ complete: false, rows: [], reasonCode: "identity-changed" });
	});

	it("rejects an ordinal relabel before provider I/O", async () => {
		const targets = Array.from({ length: 51 }, (_, index) =>
			parent(index + 1, `show-${index + 1}`),
		);
		const planned = planPlexEpisodeRefresh(targets);
		const secondUnit = planned.units[1]!;
		const relabeled = {
			...secondUnit,
			ordinal: 0,
			scopeKey: "plex-episode-unit:0",
		};
		const getEpisodes = vi.fn();

		const result = await collectPlexEpisodeUnit(
			{ getEpisodes } as unknown as PlexClient,
			relabeled,
			{
				instanceId: "plex-1",
				generationId: "parent-generation-1",
				connectionGeneration: 7,
				identityGeneration: 11,
				sourceFingerprint: "fingerprint-1",
			},
		);

		expect(getEpisodes).not.toHaveBeenCalled();
		expect(result).toMatchObject({ complete: false, rows: [], reasonCode: "coverage-incomplete" });
	});

	it("rejects scope-key and scope-digest tampering before provider I/O", async () => {
		const unit = planPlexEpisodeRefresh([parent(1, "show-1")]).units[0]!;
		const context = {
			instanceId: "plex-1",
			generationId: "parent-generation-1",
			connectionGeneration: 7,
			identityGeneration: 11,
			sourceFingerprint: "fingerprint-1",
		};
		for (const tampered of [
			{ ...unit, scopeKey: "plex-episode-unit:1" },
			{ ...unit, scopeDigest: "0".repeat(64) },
		]) {
			const getEpisodes = vi.fn();
			const result = await collectPlexEpisodeUnit(
				{ getEpisodes } as unknown as PlexClient,
				tampered,
				context,
			);
			expect(getEpisodes).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				complete: false,
				rows: [],
				reasonCode: "coverage-incomplete",
			});
		}
	});

	it("collects duplicate TMDB copies across units with distinct parent provenance", async () => {
		const targets = [
			...Array.from({ length: 49 }, (_, index) => parent(index + 1, `show-${index + 1}`)),
			parent(999, "copy-a"),
			parent(999, "copy-b"),
		];
		const planned = planPlexEpisodeRefresh(targets);
		expect(planned.units).toHaveLength(2);
		expect(planned.units[0]!.targets.at(-1)!.ratingKey).toBe("copy-a");
		expect(planned.units[1]!.targets[0]!.ratingKey).toBe("copy-b");

		const context = {
			instanceId: "plex-1",
			generationId: "parent-generation-1",
			connectionGeneration: 7,
			identityGeneration: 11,
			sourceFingerprint: "fingerprint-1",
		};
		const first = await collectPlexEpisodeUnit(
			{
				getEpisodes: vi.fn(async (ratingKey: string) => [
					{
						ratingKey: `episode-${ratingKey}`,
						title: "Pilot",
						seasonNumber: 1,
						episodeNumber: 1,
						viewCount: 2,
					},
				]),
			} as unknown as PlexClient,
			planned.units[0]!,
			context,
		);
		const second = await collectPlexEpisodeUnit(
			{
				getEpisodes: vi.fn(async (ratingKey: string) => [
					{
						ratingKey: `episode-${ratingKey}`,
						title: "Pilot",
						seasonNumber: 1,
						episodeNumber: 1,
						viewCount: 3,
					},
				]),
			} as unknown as PlexClient,
			planned.units[1]!,
			context,
		);

		expect(first.complete).toBe(true);
		expect(second.complete).toBe(true);
		const firstCopy = first.rows.find((row) => row.parentRatingKey === "copy-a");
		const secondCopy = second.rows.find((row) => row.parentRatingKey === "copy-b");
		expect(firstCopy).toMatchObject({ parentRatingKey: "copy-a", watchCount: 2 });
		expect(secondCopy).toMatchObject({ parentRatingKey: "copy-b", watchCount: 3 });
	});

	it("discards earlier rows when the second target fails", async () => {
		const unit = planPlexEpisodeRefresh([parent(1, "show-1"), parent(2, "show-2")]).units[0]!;
		const getEpisodes = vi
			.fn()
			.mockResolvedValueOnce([
				{
					ratingKey: "episode-one",
					title: "Pilot",
					seasonNumber: 1,
					episodeNumber: 1,
					viewCount: 2,
				},
			])
			.mockRejectedValueOnce(new Error("secret provider detail"));

		const result = await collectPlexEpisodeUnit({ getEpisodes } as unknown as PlexClient, unit, {
			instanceId: "plex-1",
			generationId: "parent-generation-1",
			connectionGeneration: 7,
			identityGeneration: 11,
			sourceFingerprint: "fingerprint-1",
		});

		expect(getEpisodes).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({
			complete: false,
			refreshedTargets: 1,
			rows: [],
			reasonCode: "provider-unavailable",
		});
		expect(JSON.stringify(result)).not.toContain("secret provider detail");
	});
});
