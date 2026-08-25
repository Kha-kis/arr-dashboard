import { describe, expect, it } from "vitest";
import {
	decodePlexPositiveEpisodeGenerationMetadata,
	encodePlexPositiveEpisodeGenerationMetadata,
} from "../plex-positive-episode-generation-metadata.js";

const valid = {
	version: 3,
	publicationLevel: "positive-only",
	completeness: "partial",
	itemCount: 1,
	canonicalizationVersion: 1,
	capability: {
		domain: "episodes",
		field: "watchCount",
		semantics: "lower-bound",
		operator: "greater_than",
	},
	parentPlexGenerationId: "parent-generation-1",
	parentMetadataVersion: 4,
	parentPublicationLevel: "positive-only",
	parentTargetDigest: "a".repeat(64),
	episodeDigest: "b".repeat(64),
	partialReasons: [
		{ code: "ambiguous_episode_parent_targets", count: 2 },
		{ code: "currentItemsWithoutTmdbMetadata", count: 1 },
	],
	connectionGeneration: 7,
	identityGeneration: 11,
} as const;

describe("positive Plex episode generation metadata", () => {
	it("accepts only the named lower-bound positive envelope", () => {
		const encoded = encodePlexPositiveEpisodeGenerationMetadata(valid);

		expect(decodePlexPositiveEpisodeGenerationMetadata(encoded)).toEqual({
			ok: true,
			metadata: valid,
		});
	});

	it.each([
		["an authoritative publication level", { ...valid, publicationLevel: "authoritative" }],
		["a broader operator", { ...valid, capability: { ...valid.capability, operator: "equals" } }],
		["an unexplained partial publication", { ...valid, partialReasons: [] }],
		["an unsorted reason list", { ...valid, partialReasons: [...valid.partialReasons].reverse() }],
		["a missing exact parent target digest", { ...valid, parentTargetDigest: "not-a-digest" }],
	])("rejects %s", (_description, metadata) => {
		expect(decodePlexPositiveEpisodeGenerationMetadata(JSON.stringify(metadata))).toEqual({
			ok: false,
		});
	});
});
