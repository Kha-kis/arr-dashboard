import type { SearchResult } from "@arr/shared";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type SearchDataFilters, useSearchData } from "../use-search-data";

const defaults: SearchDataFilters = {
	protocolFilter: "all",
	minSeedersInput: "",
	maxAgeInput: "",
	hideRejected: false,
	sortKey: "seeders",
	sortDirection: "asc",
};
const unknown: SearchResult = {
	id: "unknown",
	title: "Synthetic Release",
	indexer: "Synthetic Indexer",
	indexerId: 7,
	protocol: "torrent",
	instanceId: "synthetic-instance",
	instanceName: "Synthetic Prowlarr",
	metadataIncomplete: true,
};
const zero: SearchResult = {
	...unknown,
	id: "zero",
	metadataIncomplete: false,
	seeders: 0,
	size: 0,
	ageHours: 0,
	publishDate: "2026-10-07T04:00:00.000Z",
};
const high: SearchResult = {
	...unknown,
	id: "high",
	metadataIncomplete: false,
	seeders: 5,
	size: 1024,
	ageHours: 2,
	publishDate: "2026-10-07T02:00:00.000Z",
};
const rows = [unknown, zero, high];

afterEach(cleanup);

describe("useSearchData unknown metadata", () => {
	it.each([
		["seeders", "asc", ["zero", "high", "unknown"]],
		["seeders", "desc", ["high", "zero", "unknown"]],
		["size", "asc", ["zero", "high", "unknown"]],
		["size", "desc", ["high", "zero", "unknown"]],
		["publishDate", "asc", ["high", "zero", "unknown"]],
		["publishDate", "desc", ["zero", "high", "unknown"]],
		["age", "asc", ["zero", "high", "unknown"]],
		["age", "desc", ["high", "zero", "unknown"]],
	] as const)("sorts unknown %s last in %s order", (sortKey, sortDirection, expected) => {
		const { result } = renderHook(() =>
			useSearchData(rows, { ...defaults, sortKey, sortDirection }),
		);
		expect(result.current.results.map((row) => row.id)).toEqual(expected);
		expect(result.current.hidden).toBe(0);
	});

	it("requires known seeders even for an explicit zero minimum", () => {
		const { result } = renderHook(() => useSearchData(rows, { ...defaults, minSeedersInput: "0" }));
		expect(result.current.results.map((row) => row.id)).toEqual(["zero", "high"]);
		expect(result.current.hidden).toBe(1);
		expect(result.current.filtersActive).toBe(true);
	});

	it("retains unknown rows when no numeric filter is active", () => {
		const { result } = renderHook(() => useSearchData(rows, defaults));
		expect(result.current.results.map((row) => row.id).sort()).toEqual(["high", "unknown", "zero"]);
		expect(result.current.hidden).toBe(0);
		expect(result.current.filtersActive).toBe(false);
	});

	it("retains the known positive seeder threshold behavior", () => {
		const { result } = renderHook(() => useSearchData(rows, { ...defaults, minSeedersInput: "1" }));
		expect(result.current.results.map((row) => row.id)).toEqual(["high"]);
		expect(result.current.hidden).toBe(2);
	});

	it("requires known age for a maximum age filter while retaining zero", () => {
		const { result } = renderHook(() => useSearchData(rows, { ...defaults, maxAgeInput: "0" }));
		expect(result.current.results.map((row) => row.id)).toEqual(["zero"]);
		expect(result.current.hidden).toBe(2);
	});

	it.each(["asc", "desc"] as const)(
		"puts unknown seeders last when breaking tied titles in %s order",
		(sortDirection) => {
			const { result } = renderHook(() =>
				useSearchData(rows, { ...defaults, sortKey: "title", sortDirection }),
			);
			expect(result.current.results.map((row) => row.id)).toEqual(
				sortDirection === "asc" ? ["zero", "high", "unknown"] : ["high", "zero", "unknown"],
			);
		},
	);

	it.each(["asc", "desc"] as const)(
		"puts unknown dates last when breaking tied titles and seeders in %s order",
		(sortDirection) => {
			const tied = rows.map((row) => ({ ...row, seeders: 1 }));
			const { result } = renderHook(() =>
				useSearchData(tied, { ...defaults, sortKey: "title", sortDirection }),
			);
			expect(result.current.results.map((row) => row.id)).toEqual(
				sortDirection === "asc" ? ["high", "zero", "unknown"] : ["zero", "high", "unknown"],
			);
		},
	);

	it.each(["asc", "desc"] as const)(
		"treats an invalid publish date as unknown in %s order",
		(sortDirection) => {
			const invalid = { ...unknown, id: "invalid", publishDate: "not-a-date" };
			const { result } = renderHook(() =>
				useSearchData([invalid, zero], { ...defaults, sortKey: "publishDate", sortDirection }),
			);
			expect(result.current.results.map((row) => row.id)).toEqual(["zero", "invalid"]);
		},
	);

	it("uses each metric rather than rejecting all incomplete metadata", () => {
		const partial = { ...unknown, seeders: 2 };
		const { result } = renderHook(() =>
			useSearchData([partial, zero], { ...defaults, minSeedersInput: "1" }),
		);
		expect(result.current.results.map((row) => row.id)).toEqual(["unknown"]);
	});

	it("preserves stable order for entirely unknown tied rows", () => {
		const tied = [unknown, { ...unknown, id: "second" }];
		const { result } = renderHook(() =>
			useSearchData(tied, { ...defaults, sortDirection: "desc" }),
		);
		expect(result.current.results.map((row) => row.id)).toEqual(["unknown", "second"]);
	});

	it("preserves ordinary title ordering before metric tie-breakers", () => {
		const titled = [
			{ ...unknown, title: "Alpha" },
			{ ...zero, title: "Beta" },
		];
		const { result } = renderHook(() =>
			useSearchData(titled, { ...defaults, sortKey: "title", sortDirection: "desc" }),
		);
		expect(result.current.results.map((row) => row.id)).toEqual(["zero", "unknown"]);
	});

	it("preserves protocol and rejection filters on unknown metrics", () => {
		const mixed = [unknown, { ...zero, protocol: "usenet" as const }, { ...high, rejected: true }];
		const { result } = renderHook(() =>
			useSearchData(mixed, { ...defaults, protocolFilter: "torrent", hideRejected: true }),
		);
		expect(result.current.results.map((row) => row.id)).toEqual(["unknown"]);
		expect(result.current.hidden).toBe(2);
	});

	it("does not mutate the provider rows or their input order", () => {
		const input = rows.map((row) => Object.freeze({ ...row }));
		Object.freeze(input);
		const { result } = renderHook(() => useSearchData(input, defaults));
		expect(result.current.results).not.toBe(input);
		expect(input.map((row) => row.id)).toEqual(["unknown", "zero", "high"]);
		expect(input[0]?.seeders).toBeUndefined();
	});

	it("restores unknown rows after clearing a numeric filter", () => {
		const { result, rerender } = renderHook(
			({ minimum }) => useSearchData(rows, { ...defaults, minSeedersInput: minimum }),
			{ initialProps: { minimum: "0" } },
		);
		expect(result.current.results.map((row) => row.id)).toEqual(["zero", "high"]);
		rerender({ minimum: "" });
		expect(result.current.results.map((row) => row.id)).toEqual(["zero", "high", "unknown"]);
		expect(result.current.hidden).toBe(0);
		expect(result.current.filtersActive).toBe(false);
	});
});
