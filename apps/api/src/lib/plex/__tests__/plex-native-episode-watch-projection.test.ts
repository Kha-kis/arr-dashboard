import { describe, expect, it } from "vitest";
import type { PositiveEpisodeDisplayAuthority } from "../plex-authority-service.js";
import { projectPlexNativeEpisodeWatchPage } from "../plex-native-episode-watch-projection.js";

const publishedAt = "2026-09-27T12:00:00.000Z";
const evidence: PositiveEpisodeDisplayAuthority = {
	available: true,
	instanceId: "plex-a",
	generationId: "episode-generation",
	connectionGeneration: 1,
	identityGeneration: 1,
	capability: {
		domain: "episodes",
		field: "watchCount",
		semantics: "lower-bound",
		operator: "greater_than",
	},
	partialReasons: [],
	provenance: {
		publicationLevel: "positive-only",
		completeness: "partial",
		connectionGeneration: 1,
		identityGeneration: 1,
		parentPlexGenerationId: "parent-generation",
		parentTargetDigest: "a".repeat(64),
		parentTargetCount: 1,
		episodeGenerationId: "episode-generation",
		episodeDigest: "b".repeat(64),
		publishedAt,
	},
	rows: [
		{
			showTmdbId: 42,
			seasonNumber: 1,
			episodeNumber: 1,
			ratingKey: "episode-a",
			title: "Synthetic episode",
			watched: true,
			watchedByUsers: "[]",
			lastWatchedAt: null,
			soleParentTarget: {
				instanceId: "plex-a",
				generationId: "parent-generation",
				showTmdbId: 42,
				sectionId: "shows",
				sectionUuid: "shows-uuid",
				mediaType: "series",
				tvdbId: null,
				ratingKey: "show-a",
			},
		},
	],
	evidence: {
		publicationLevel: "positive-only",
		completeness: "partial",
		reasonCodes: [],
		availability: "current",
		authority: "positive-only",
		attemptState: "partial",
	},
};

const parent = {
	nativeId: "show-a",
	mediaType: "series" as const,
	libraryIds: ["shows"],
	parentNativeId: null,
	seasonNumber: null,
	episodeNumber: null,
	title: "Synthetic series",
	externalIds: { tmdb: [42] },
};
const episode = {
	nativeId: "episode-a",
	mediaType: "episode" as const,
	libraryIds: ["shows"],
	parentNativeId: "show-a",
	seasonNumber: 1,
	episodeNumber: 1,
	title: "Synthetic episode",
};

describe("Plex native episode positive projection", () => {
	it.each([
		{
			name: "reassigned episode parent",
			rows: [{ ...episode, parentNativeId: "replacement-show" }],
			parents: [parent],
		},
		{
			name: "changed episode section",
			rows: [{ ...episode, libraryIds: ["other-section"] }],
			parents: [parent],
		},
		{
			name: "changed parent section",
			rows: [episode],
			parents: [{ ...parent, libraryIds: ["other-section"] }],
		},
		{
			name: "changed season coordinate",
			rows: [{ ...episode, seasonNumber: 2 }],
			parents: [parent],
		},
		{
			name: "changed episode coordinate",
			rows: [{ ...episode, episodeNumber: 2 }],
			parents: [parent],
		},
		{
			name: "deleted native episode ID",
			rows: [{ ...episode, nativeId: "replacement-episode" }],
			parents: [parent],
		},
		{
			name: "ambiguous current parent TMDB identity",
			rows: [episode],
			parents: [{ ...parent, externalIds: { tmdb: [42, 99] } }],
		},
		{
			name: "same-title parent with another native ID",
			rows: [episode],
			parents: [{ ...parent, nativeId: "other-copy" }],
		},
	])("keeps retained display unknown for $name", ({ rows, parents }) => {
		// Retaining old proof must not bypass any existing native identity or coordinate check.
		const result = projectPlexNativeEpisodeWatchPage({
			rows,
			parents,
			evidence: {
				...evidence,
				evidence: { ...evidence.evidence, availability: "last-known", authority: "unavailable" },
			},
			inventoryFreshness: "current",
			parentFreshness: "current",
			inventoryObservedAt: new Date(publishedAt),
			parentObservedAt: new Date(publishedAt),
		});
		expect([...result.values()]).toEqual([
			{ state: "unknown", freshness: "unavailable", valueSemantics: "unknown", observedAt: null },
		]);
	});

	it("does not map retained positives with duplicate episode IDs or a crossed source instance", () => {
		for (const rows of [
			[evidence.rows[0]!, evidence.rows[0]!],
			[
				{
					...evidence.rows[0]!,
					soleParentTarget: { ...evidence.rows[0]!.soleParentTarget, instanceId: "other-instance" },
				},
			],
		]) {
			const result = projectPlexNativeEpisodeWatchPage({
				rows: [episode],
				parents: [parent],
				evidence: {
					...evidence,
					rows,
					evidence: { ...evidence.evidence, availability: "last-known", authority: "unavailable" },
				},
				inventoryFreshness: "current",
				parentFreshness: "current",
				inventoryObservedAt: new Date(publishedAt),
				parentObservedAt: new Date(publishedAt),
			});
			expect(result.get("episode-a")?.state).toBe("unknown");
		}
	});
	it("marks a positive as last-known when native inventory is newer than watch evidence", () => {
		const result = projectPlexNativeEpisodeWatchPage({
			rows: [episode],
			parents: [parent],
			evidence,
			inventoryFreshness: "current",
			parentFreshness: "current",
			inventoryObservedAt: new Date("2026-09-27T12:01:00.000Z"),
			parentObservedAt: new Date(publishedAt),
		});
		expect(result.get("episode-a")).toMatchObject({
			state: "watched",
			freshness: "last-known",
			valueSemantics: "lower-bound",
		});
	});

	it("does not transfer a positive across an unmatched native parent", () => {
		const result = projectPlexNativeEpisodeWatchPage({
			rows: [{ ...episode, parentNativeId: "different-show" }],
			parents: [parent],
			evidence,
			inventoryFreshness: "current",
			parentFreshness: "current",
			inventoryObservedAt: new Date(publishedAt),
			parentObservedAt: new Date(publishedAt),
		});
		expect(result.get("episode-a")).toMatchObject({
			state: "unknown",
			valueSemantics: "unknown",
		});
	});
});
