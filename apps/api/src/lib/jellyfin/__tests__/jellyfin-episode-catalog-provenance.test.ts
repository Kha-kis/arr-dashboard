import { describe, expect, it } from "vitest";
import type { ProviderCoverageReceipt } from "../../provider-observation/coverage-receipt.js";
import {
	buildJellyfinEpisodeCatalogProvenance,
	decodeJellyfinEpisodeCatalogProvenance,
	isJellyfinEpisodeCatalogCompatible,
	jellyfinEpisodeCatalogGenerationKey,
	jellyfinEpisodeCatalogScopesFromReceipt,
} from "../jellyfin-episode-catalog-provenance.js";
import type { JellyfinLibraryRowFingerprintInput } from "../jellyfin-generation-metadata.js";

const scopes = [{ userId: "user-1", libraryId: "library-1" }];

function row(
	overrides: Partial<JellyfinLibraryRowFingerprintInput> = {},
): JellyfinLibraryRowFingerprintInput {
	return {
		tmdbId: 42,
		mediaType: "series",
		libraryId: "library-1",
		libraryName: "Shows",
		title: "Series",
		jellyfinId: "series-1",
		lastWatchedAt: null,
		watchCount: 0,
		watchedByUsers: "[]",
		onDeck: false,
		userRating: null,
		collections: "[]",
		addedAt: null,
		thumb: null,
		...overrides,
	};
}

function receipt(): ProviderCoverageReceipt {
	const unit = {
		scopeKey: "user:user-1/library:library-1/inventory",
		expectedRawCount: 1,
		pagesAttempted: 1,
		pagesCompleted: 1,
		rawObserved: 1,
		sourceBindings: 1,
		canonicalEntities: 1,
		acceptedSkips: [],
		fatalCount: 0,
	};
	return {
		version: 2,
		provider: "jellyfin",
		attemptStartedAt: "2026-09-08T00:00:00.000Z",
		observedAt: "2026-09-08T00:01:00.000Z",
		evidence: "complete",
		units: [unit],
		publishedCanonicalEntities: 1,
		domains: [
			{
				domain: "library-inventory",
				evidence: "complete",
				valueSemantics: "exact",
				units: [unit],
				publishedCanonicalEntities: 1,
			},
		],
	};
}

describe("Jellyfin episode catalog provenance", () => {
	it("canonicalizes bindings and scopes and derives a versioned generation key", () => {
		const provenance = buildJellyfinEpisodeCatalogProvenance(
			[row(), row({ mediaType: "movie", jellyfinId: "movie-1" })],
			scopes,
		);
		expect(provenance).toEqual({
			version: 3,
			bindings: [{ libraryId: "library-1", seriesId: "series-1", tmdbId: 42 }],
			scopes,
		});
		expect(jellyfinEpisodeCatalogGenerationKey(provenance)).toMatch(
			/^jellyfin-episode-parent-v3:[a-f0-9]{64}$/,
		);
		expect(
			decodeJellyfinEpisodeCatalogProvenance(
				JSON.stringify({ scopes: provenance!.scopes, version: 3, bindings: provenance!.bindings }),
			),
		).toEqual(provenance);
	});

	it("rejects ambiguous canonical mappings and malformed persisted provenance", () => {
		expect(
			buildJellyfinEpisodeCatalogProvenance([row(), row({ jellyfinId: "series-2" })], scopes),
		).toBeNull();
		expect(buildJellyfinEpisodeCatalogProvenance([row(), row({ tmdbId: 84 })], scopes)).toBeNull();
		expect(
			decodeJellyfinEpisodeCatalogProvenance({
				version: 3,
				bindings: [{ libraryId: "library-1", seriesId: "series-1", tmdbId: 42, extra: true }],
				scopes,
			}),
		).toBeNull();
	});

	it("accepts only unchanged original bindings and an equal current scope set", () => {
		const provenance = buildJellyfinEpisodeCatalogProvenance([row()], scopes);
		expect(provenance).not.toBeNull();
		expect(
			isJellyfinEpisodeCatalogCompatible(
				provenance,
				[row(), row({ tmdbId: 84, jellyfinId: "series-2" })],
				scopes,
			),
		).toBe(true);
		expect(isJellyfinEpisodeCatalogCompatible(provenance, [row({ tmdbId: 84 })], scopes)).toBe(
			false,
		);
		expect(
			isJellyfinEpisodeCatalogCompatible(
				provenance,
				[row()],
				[{ userId: "user-2", libraryId: "library-1" }],
			),
		).toBe(false);
	});

	it("derives inventory scopes only from exact V2 receipt scope keys", () => {
		expect(jellyfinEpisodeCatalogScopesFromReceipt(receipt())).toEqual(scopes);
		const malformed = receipt();
		if (malformed.version !== 2) throw new Error("test fixture must be V2");
		malformed.domains[0]!.units[0]!.scopeKey = "user:user-1/library:library-1";
		expect(jellyfinEpisodeCatalogScopesFromReceipt(malformed)).toBeNull();
	});
});
