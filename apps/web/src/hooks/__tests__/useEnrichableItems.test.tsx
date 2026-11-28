import type { LibraryItem } from "@arr/shared";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useEnrichableItems } from "../useEnrichableItems";

function item(
	tmdbId: number | undefined,
	service: LibraryItem["service"] = "radarr",
	type: LibraryItem["type"] = "movie",
): LibraryItem {
	return {
		id: 1,
		instanceId: "synthetic-instance",
		instanceName: "Synthetic",
		service,
		type,
		title: "Synthetic",
		remoteIds: { tmdbId },
	};
}

afterEach(cleanup);

describe("enrichment request identity admission", () => {
	it("keeps valid neighbors when one upstream item has a negative sentinel ID", () => {
		const { result } = renderHook(() =>
			useEnrichableItems([item(42), item(-1), item(52, "sonarr", "series")], {
				movie: "movie",
				series: "series",
			}),
		);
		expect(result.current).toEqual({
			tmdbIds: [42, 52],
			types: ["movie", "series"],
			key: "movie:42,series:52",
			hasItems: true,
		});
	});

	it.each([
		-1,
		0,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
		undefined,
	])("does not admit invalid TMDB identity %s or enable an empty request", (invalid) => {
		const { result } = renderHook(() => useEnrichableItems([item(invalid)]));
		expect(result.current).toEqual({ tmdbIds: [], types: [], key: "", hasItems: false });
	});

	it("preserves Seerr type mapping and same-number movie/series identity separation", () => {
		const { result } = renderHook(() =>
			useEnrichableItems([item(42), item(-1, "sonarr", "series"), item(42, "sonarr", "series")]),
		);
		expect(result.current).toEqual({
			tmdbIds: [42, 42],
			types: ["movie", "tv"],
			key: "movie:42,tv:42",
			hasItems: true,
		});
	});

	it("preserves large valid integers and excludes unsupported service items", () => {
		const { result } = renderHook(() =>
			useEnrichableItems([item(Number.MAX_SAFE_INTEGER), item(62, "lidarr", "artist")]),
		);
		expect(result.current).toEqual({
			tmdbIds: [Number.MAX_SAFE_INTEGER],
			types: ["movie"],
			key: "movie:9007199254740991",
			hasItems: true,
		});
	});

	it("updates aligned request arrays and keys when item identities recover", () => {
		const { result, rerender } = renderHook(
			({ items }) => useEnrichableItems(items, { movie: "movie", series: "series" }),
			{ initialProps: { items: [item(-1)] } },
		);
		expect(result.current.hasItems).toBe(false);
		rerender({ items: [item(42, "sonarr", "series")] });
		expect(result.current).toEqual({
			tmdbIds: [42],
			types: ["series"],
			key: "series:42",
			hasItems: true,
		});
	});
});
