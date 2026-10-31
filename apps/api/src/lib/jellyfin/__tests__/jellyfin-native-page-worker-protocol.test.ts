import { describe, expect, it } from "vitest";
import {
	parseJellyfinNativePageWorkerRequest,
	parseJellyfinNativePageWorkerResult,
} from "../jellyfin-native-page-worker-protocol.js";

const input = {
	version: 1,
	baseUrl: "http://synthetic.invalid",
	apiKey: "KEY_SENTINEL",
	httpAuthHeaders: {},
	domain: "episode" as const,
	libraryId: "library-1",
	startIndex: 0,
	limit: 2,
	deadlineAt: Date.now() + 10_000,
	requestTimeoutMs: 1_000,
};
const page = {
	status: "page",
	domain: "episode",
	startIndex: 0,
	totalRecordCount: 2,
	items: [
		{
			id: "e1",
			type: "Episode",
			name: "",
			seriesId: "series-1",
			seasonNumber: 0,
			episodeNumber: 1,
		},
		{ id: "e2", type: "Episode", name: "" },
	],
};

describe("native page protocol", () => {
	it("retains native episode metadata and legitimate missing coordinates", () => {
		expect(parseJellyfinNativePageWorkerRequest(input)).toEqual(input);
		expect(parseJellyfinNativePageWorkerResult(page, input)).toEqual(page);
	});
	it("retains native library types and normalized external IDs", () => {
		const library = {
			status: "page",
			domain: "library",
			startIndex: 0,
			totalRecordCount: 2,
			items: [
				{ id: "m1", type: "Movie", name: "", externalIds: { tmdb: [101], tvdb: [202] } },
				{ id: "b1", type: "BoxSet", name: "Synthetic" },
			],
		};
		expect(parseJellyfinNativePageWorkerResult(library, { ...input, domain: "library" })).toEqual(
			library,
		);
	});
	it.each(["deadline-exceeded", "provider-unavailable", "coverage-incomplete"])(
		"preserves %s without provider text",
		(reason) => {
			expect(parseJellyfinNativePageWorkerResult({ status: "unavailable", reason }, input)).toEqual(
				{ status: "unavailable", reason },
			);
		},
	);
	it.each([
		{ ...input, method: "DELETE" },
		{ ...input, userId: "user-specific" },
		{ ...input, domain: "watch" },
		{ ...input, requestTimeoutMs: 15_001 },
		{ ...input, libraryId: "" },
		{ ...input, includeItemTypes: "Audio" },
		{ ...input, limit: 2_001 },
		{ ...input, baseUrl: "file:///private" },
	])("rejects invalid or expanded requests", (request) => {
		expect(parseJellyfinNativePageWorkerRequest(request)).toBeNull();
	});
	it.each([
		{ ...page, domain: "library" },
		{ ...page, startIndex: 1 },
		{ ...page, totalRecordCount: 100_001 },
		{ ...page, totalRecordCount: 1 },
		{ ...page, items: [page.items[0], page.items[0]] },
		{ ...page, items: [] },
		{ ...page, items: [{ ...page.items[0], played: true }] },
		{ status: "page", page },
		{ status: "failed", category: "provider-unavailable", error: "SECRET_SENTINEL" },
	])("rejects ambiguous, canonical, or malformed results", (value) => {
		expect(parseJellyfinNativePageWorkerResult(value, input)).toBeNull();
	});
	it("never invokes descriptor getters or proxy traps outside its guarded parser", () => {
		let invoked = false;
		const hostile = {
			...page,
			get items() {
				invoked = true;
				throw new Error("SECRET_SENTINEL");
			},
		};
		expect(parseJellyfinNativePageWorkerResult(hostile, input)).toBeNull();
		expect(invoked).toBe(false);
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("SECRET_SENTINEL");
				},
			},
		);
		expect(parseJellyfinNativePageWorkerResult(proxy, input)).toBeNull();
		expect(parseJellyfinNativePageWorkerRequest(proxy)).toBeNull();
	});
});
