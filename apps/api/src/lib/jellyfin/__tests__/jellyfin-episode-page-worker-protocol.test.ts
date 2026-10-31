import { describe, expect, it, vi } from "vitest";
import {
	parseJellyfinEpisodePageWorkerRequest,
	parseJellyfinEpisodePageWorkerResult,
} from "../jellyfin-episode-page-worker-protocol.js";

const coordinates = { startIndex: 2, limit: 2 };
const row = {
	id: "native-episode",
	name: "",
	type: "Episode",
	seriesId: "native-series",
	seasonNumber: 0,
	episodeNumber: 0,
	played: false,
	playCount: null,
	lastPlayedDate: null,
};
const result = {
	status: "page",
	page: {
		startIndex: 2,
		totalRecordCount: 4,
		items: [row, { id: "excluded", type: "Episode", excludedReason: "missing-episode-metadata" }],
	},
};
const request = {
	version: 1,
	baseUrl: "http://127.0.0.1:1/base",
	apiKey: "secret",
	httpAuthHeaders: {},
	userId: "user",
	libraryId: "library",
	startIndex: 2,
	limit: 2,
	requestTimeoutMs: 15000,
};

describe("one-page worker protocol", () => {
	// Catches invented defaults that turn unknown count/date into zero or drop exclusions.
	it("preserves false, nulls, metadata exclusions, and raw page coordinates", () => {
		expect(parseJellyfinEpisodePageWorkerResult(result, coordinates)).toEqual({
			status: "page",
			page: {
				startIndex: 2,
				totalRecordCount: 4,
				items: [
					{
						id: "native-episode",
						name: "",
						type: "Episode",
						seriesId: "native-series",
						seasonNumber: 0,
						episodeNumber: 0,
						played: false,
						playCount: null,
						lastPlayedDate: null,
					},
					{ id: "excluded", type: "Episode", excludedReason: "missing-episode-metadata" },
				],
			},
		});
	});

	it.each([
		{ ...result, extra: "private" },
		{ status: "failed", category: "private-error" },
		{ status: "failed", category: "provider-unavailable", message: "private" },
		{ ...result, page: { ...result.page, startIndex: 0 } },
		{ ...result, page: { ...result.page, totalRecordCount: 100001 } },
		{ ...result, page: { ...result.page, totalRecordCount: 3 } },
		...[
			{ id: " " },
			{ type: "Movie" },
			{ seriesId: "" },
			{ seasonNumber: -1 },
			{ episodeNumber: 1.2 },
			{ played: null },
			{ played: undefined },
			{ playCount: -1 },
			{ playCount: undefined },
			{ lastPlayedDate: undefined },
			{ lastPlayedDate: "invalid" },
			{ excludedReason: "missing-episode-metadata" },
		].map((change) => ({
			status: "page",
			page: { startIndex: 2, totalRecordCount: 3, items: [{ ...row, ...change }] },
		})),
		{ status: "page", page: { startIndex: 2, totalRecordCount: 4, items: [row, row] } },
		{
			status: "page",
			page: {
				startIndex: 2,
				totalRecordCount: 3000,
				items: Array.from({ length: 2001 }, (_, i) => ({ ...row, id: String(i) })),
			},
		},
	])("rejects malformed envelopes or normalized rows %#", (value) => {
		expect(parseJellyfinEpisodePageWorkerResult(value, coordinates)).toBeNull();
	});

	it("never invokes getters or stringify hooks in unexpected messages", () => {
		const hook = vi.fn(() => {
			throw new Error("private");
		});
		const value = {
			toJSON: hook,
			get status() {
				return hook();
			},
		};
		expect(parseJellyfinEpisodePageWorkerResult(value, coordinates)).toBeNull();
		expect(hook).not.toHaveBeenCalled();
	});

	it("accepts only a fixed one-page request", () => {
		expect(parseJellyfinEpisodePageWorkerRequest(request)).toEqual(request);
	});
	it.each([
		{ method: "POST" },
		{ path: "/Library/Refresh" },
		{ version: 2 },
		{ userId: " " },
		{ libraryId: "" },
		{ startIndex: -1 },
		{ startIndex: 100001 },
		{ limit: 0 },
		{ limit: 2001 },
		{ requestTimeoutMs: 0 },
		{ requestTimeoutMs: 15001 },
		{ baseUrl: "file:///private" },
		{ httpAuthHeaders: { Authorization: 4 } },
	])("rejects unsafe request coordinates and arbitrary operations %#", (change) => {
		expect(parseJellyfinEpisodePageWorkerRequest({ ...request, ...change })).toBeNull();
	});
});
