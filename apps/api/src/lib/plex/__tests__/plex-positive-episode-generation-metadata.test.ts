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

const validV4 = {
	...valid,
	version: 4,
	parentMetadataVersion: 5,
} as const;

const validV5 = {
	...valid,
	version: 5,
	parentMetadataVersion: 6,
	parentPublicationLevel: "authoritative",
	partialReasons: [],
	coverageReceipt: {
		version: 2,
		provider: "plex_episode",
		attemptStartedAt: "2026-09-06T00:00:00.000Z",
		observedAt: "2026-09-06T00:01:00.000Z",
		evidence: "positive-only",
		units: [
			{
				scopeKey: "plex-episode-unit:0",
				expectedRawCount: null,
				pagesAttempted: 1,
				pagesCompleted: 1,
				rawObserved: 1,
				sourceBindings: 1,
				canonicalEntities: 1,
				acceptedSkips: [],
				fatalCount: 0,
			},
		],
		publishedCanonicalEntities: 1,
		domains: [
			{
				domain: "episode-inventory",
				evidence: "positive-only",
				valueSemantics: "lower-bound",
				units: [
					{
						scopeKey: "plex-episode-unit:0",
						expectedRawCount: null,
						pagesAttempted: 1,
						pagesCompleted: 1,
						rawObserved: 1,
						sourceBindings: 1,
						canonicalEntities: 1,
						acceptedSkips: [],
						fatalCount: 0,
					},
				],
				publishedCanonicalEntities: 1,
			},
			{
				domain: "watch-count",
				evidence: "positive-only",
				valueSemantics: "lower-bound",
				units: [
					{
						scopeKey: "plex-episode-unit:0",
						expectedRawCount: null,
						pagesAttempted: 1,
						pagesCompleted: 1,
						rawObserved: 1,
						sourceBindings: 1,
						canonicalEntities: 1,
						acceptedSkips: [],
						fatalCount: 0,
					},
				],
				publishedCanonicalEntities: 1,
			},
		],
	},
} as const;

describe("positive Plex episode generation metadata", () => {
	it("accepts only the named lower-bound positive envelope", () => {
		const encoded = encodePlexPositiveEpisodeGenerationMetadata(valid);

		expect(decodePlexPositiveEpisodeGenerationMetadata(encoded)).toEqual({
			ok: true,
			metadata: valid,
		});
	});

	it("accepts a V4 lower-bound envelope explicitly bound to a V5 parent", () => {
		const encoded = encodePlexPositiveEpisodeGenerationMetadata(validV4);

		expect(decodePlexPositiveEpisodeGenerationMetadata(encoded)).toEqual({
			ok: true,
			metadata: validV4,
		});
	});

	it.each(["authoritative", "positive-only"] as const)(
		"accepts V5 only for the actual V6 %s parent level",
		(parentPublicationLevel) => {
			const metadata = { ...validV5, parentPublicationLevel };
			expect(decodePlexPositiveEpisodeGenerationMetadata(JSON.stringify(metadata))).toEqual({
				ok: true,
				metadata,
			});
		},
	);

	it("rejects a V5 receipt with no persisted unit conservation", () => {
		const empty = { ...validV5, coverageReceipt: { ...validV5.coverageReceipt, units: [] } };
		expect(decodePlexPositiveEpisodeGenerationMetadata(JSON.stringify(empty))).toEqual({
			ok: false,
		});
	});

	it.each([
		["a non-ISO attempt timestamp", { attemptStartedAt: "2026-09-06" }],
		[
			"an observation before the attempt",
			{
				attemptStartedAt: "2026-09-06T00:01:00.000Z",
				observedAt: "2026-09-06T00:00:00.000Z",
			},
		],
		["a published count below the largest unit", { publishedCanonicalEntities: 0 }],
		["a published count above aggregate canonical entities", { publishedCanonicalEntities: 2 }],
	])("rejects %s in a V5 receipt", (_description, receiptOverrides) => {
		const coverageReceipt = { ...validV5.coverageReceipt, ...receiptOverrides };
		const metadata = { ...validV5, coverageReceipt };
		expect(decodePlexPositiveEpisodeGenerationMetadata(JSON.stringify(metadata))).toEqual({
			ok: false,
		});
	});

	it.each([
		["an authoritative publication level", { ...valid, publicationLevel: "authoritative" }],
		["a broader operator", { ...valid, capability: { ...valid.capability, operator: "equals" } }],
		["an unexplained partial publication", { ...valid, partialReasons: [] }],
		["an unsorted reason list", { ...valid, partialReasons: [...valid.partialReasons].reverse() }],
		["a missing exact parent target digest", { ...valid, parentTargetDigest: "not-a-digest" }],
		["a V3 envelope claiming a V5 parent", { ...valid, parentMetadataVersion: 5 }],
		["a V4 envelope claiming a V4 parent", { ...validV4, parentMetadataVersion: 4 }],
	])("rejects %s", (_description, metadata) => {
		expect(decodePlexPositiveEpisodeGenerationMetadata(JSON.stringify(metadata))).toEqual({
			ok: false,
		});
	});
});
