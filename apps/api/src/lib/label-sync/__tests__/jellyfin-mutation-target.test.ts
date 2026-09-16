import { describe, expect, it } from "vitest";
import type { NativeInventoryRow } from "../../provider-observation/native-inventory.js";
import {
	createJellyfinMutationTargetIndex,
	resolveJellyfinMutationTarget,
} from "../jellyfin-mutation-target.js";

function row(overrides: Partial<NativeInventoryRow> = {}): NativeInventoryRow {
	return {
		nativeId: "movie-1",
		mediaType: "movie",
		libraryIds: ["movies"],
		parentNativeId: null,
		seasonNumber: null,
		episodeNumber: null,
		title: "Shared title",
		externalIds: { tmdb: [42] },
		...overrides,
	};
}

function catalog(rows: NativeInventoryRow[], overrides = {}) {
	return {
		status: "available" as const,
		generationId: "native-generation",
		freshness: "current" as const,
		complete: true,
		itemCount: rows.length,
		rows,
		...overrides,
	};
}

const candidate = { mediaType: "movie" as const, tmdbId: 42 };

describe("native Jellyfin mutation target resolution", () => {
	it("resolves exact media identity while retaining unrelated same-title and unmapped rows", () => {
		const rows = [
			row(),
			row({ nativeId: "show-1", mediaType: "series" }),
			row({ nativeId: "movie-2", externalIds: { tmdb: [43] } }),
			row({ nativeId: "unmapped", externalIds: undefined }),
		];
		const before = structuredClone(rows);
		const index = createJellyfinMutationTargetIndex(catalog(rows));
		expect(resolveJellyfinMutationTarget(index, candidate)).toEqual({
			available: true,
			generationId: "native-generation",
			nativeId: "movie-1",
			libraryId: "movies",
			mediaType: "movie",
			tmdbId: 42,
		});
		expect(rows).toEqual(before);
	});

	it.each(
		[
			[row(), row({ nativeId: "movie-2", libraryIds: ["other-library"] })],
			[row({ externalIds: { tmdb: [42, 43] } })],
			[row(), row({ nativeId: "conflict", externalIds: { tmdb: [42, 43] } })],
			[row({ libraryIds: ["movies", "other-library"] })],
			[row({ libraryIds: [] })],
		].map((rows) => [rows]),
	)("rejects ambiguous identity or physical library membership", (rows) => {
		expect(
			resolveJellyfinMutationTarget(createJellyfinMutationTargetIndex(catalog(rows)), candidate),
		).toEqual({ available: false, reason: "target_ambiguous" });
	});

	it.each([{ freshness: "last-known" }, { complete: false }, { itemCount: 2 }])(
		"rejects catalogs unsuitable for current write authority",
		(overrides) => {
			const index = createJellyfinMutationTargetIndex(catalog([row()], overrides));
			expect(resolveJellyfinMutationTarget(index, candidate)).toEqual({
				available: false,
				reason: "generation_changed",
			});
		},
	);

	it("does not resolve by title or use a series identity for a movie", () => {
		const index = createJellyfinMutationTargetIndex(
			catalog([row({ externalIds: undefined }), row({ nativeId: "show", mediaType: "series" })]),
		);
		expect(resolveJellyfinMutationTarget(index, candidate)).toEqual({
			available: false,
			reason: "target_missing",
		});
	});
});
