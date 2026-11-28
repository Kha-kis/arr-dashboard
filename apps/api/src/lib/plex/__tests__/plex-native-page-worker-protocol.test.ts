import { describe, expect, it } from "vitest";
import {
	parsePlexNativePageWorkerRequest,
	parsePlexNativePageWorkerResult,
} from "../plex-native-page-worker-protocol.js";
import { executePlexNativePage } from "../plex-native-page-worker.js";

const input = {
	version: 1,
	baseUrl: "http://synthetic.invalid",
	apiKey: "KEY_SENTINEL",
	httpAuthHeaders: {},
	domain: "episode" as const,
	sectionId: "1",
	startIndex: 0,
	limit: 2,
	deadlineAt: Date.now() + 10_000,
	requestTimeoutMs: 1_000,
};
const episode = {
	ratingKey: "e1",
	type: "episode",
	title: "",
	grandparentRatingKey: "s1",
	seasonNumber: 0,
	episodeNumber: 1,
};
const page = {
	status: "page",
	domain: "episode",
	startIndex: 0,
	totalRecordCount: 2,
	items: [
		episode,
		{
			...episode,
			ratingKey: "e2",
			grandparentRatingKey: null,
			seasonNumber: null,
			episodeNumber: null,
		},
	],
};

describe("Plex native page protocol", () => {
	it("preserves normalized episode coordinates and null metadata", () => {
		expect(parsePlexNativePageWorkerRequest(input)).toEqual(input);
		expect(parsePlexNativePageWorkerResult(page, input)).toEqual(page);
	});
	it("preserves movies, shows, collections and normalized external IDs", () => {
		const library = {
			...page,
			domain: "library",
			totalRecordCount: 3,
			items: [
				{ ratingKey: "m1", type: "movie", title: "", externalIds: { tmdb: [101], tvdb: [202] } },
				{ ratingKey: "s1", type: "show", title: "Synthetic" },
				{ ratingKey: "c1", type: "collection", title: "Synthetic" },
			],
		};
		expect(
			parsePlexNativePageWorkerResult(library, { ...input, domain: "library", limit: 3 }),
		).toEqual(library);
	});
	it("preserves the existing 100000-row Plex coverage limit", () => {
		expect(parsePlexNativePageWorkerResult({ ...page, totalRecordCount: 100_000 }, input)).toEqual({
			...page,
			totalRecordCount: 100_000,
		});
		expect(
			parsePlexNativePageWorkerResult({ ...page, totalRecordCount: 100_001 }, input),
		).toBeNull();
	});
	it.each([{ ids: ["101"] }, { ids: [0] }, { ids: [101, 101] }, { ids: [202, 101] }])(
		"rejects external IDs that the native client has not normalized",
		({ ids }) => {
			const library = {
				...page,
				domain: "library",
				items: [{ ratingKey: "m1", type: "movie", title: "", externalIds: { tmdb: ids } }],
			};
			expect(parsePlexNativePageWorkerResult(library, { ...input, domain: "library" })).toBeNull();
		},
	);
	it.each(["deadline-exceeded", "provider-unavailable", "coverage-incomplete"])(
		"preserves %s without provider text",
		(reason) => {
			expect(parsePlexNativePageWorkerResult({ status: "unavailable", reason }, input)).toEqual({
				status: "unavailable",
				reason,
			});
		},
	);
	it.each([
		{ ...input, method: "DELETE" },
		{ ...input, userId: "private" },
		{ ...input, domain: "watch" },
		{ ...input, requestTimeoutMs: 15_001 },
		{ ...input, sectionId: "" },
		{ ...input, sectionId: "a\0b" },
		{ ...input, limit: 501 },
		{ ...input, baseUrl: "file:///private" },
		{ ...input, httpAuthHeaders: { Authorization: 1 } },
	])("rejects invalid or expanded requests", async (request) => {
		expect(parsePlexNativePageWorkerRequest(request)).toBeNull();
		await expect(executePlexNativePage(request)).resolves.toEqual({
			status: "failed",
			category: "invalid-request",
		});
	});
	it.each([
		{ ...page, domain: "library" },
		{ ...page, startIndex: 1 },
		{ ...page, totalRecordCount: 1 },
		{ ...page, items: [episode, episode] },
		{ ...page, items: [] },
		{ ...page, items: [{ ...episode, played: true }] },
		{ ...page, items: [{ ...episode, ratingKey: "a\0b" }] },
		{ ...page, items: [{ ...episode, grandparentRatingKey: " " }] },
		{ ...page, items: [{ ...episode, seasonNumber: "1" }] },
		{ ...page, items: [{ ...episode, episodeNumber: -1 }] },
		{ ...page, items: [{ ratingKey: "e1", type: "episode", title: "" }] },
		{ status: "failed", category: "provider-unavailable", error: "SECRET_SENTINEL" },
		{ status: "page", page },
	])("rejects malformed, duplicate, unnormalized or expanded results", (value) => {
		expect(parsePlexNativePageWorkerResult(value, input)).toBeNull();
	});
	it("rejects hostile descriptors without invoking getters or leaking trap failures", () => {
		let invoked = false;
		const hostile = {
			...page,
			get items() {
				invoked = true;
				throw new Error("SECRET_SENTINEL");
			},
		};
		expect(parsePlexNativePageWorkerResult(hostile, input)).toBeNull();
		const request = {
			...input,
			get apiKey() {
				invoked = true;
				throw new Error("SECRET_SENTINEL");
			},
		};
		expect(parsePlexNativePageWorkerRequest(request)).toBeNull();
		const array = [episode];
		Object.defineProperty(array, "0", {
			get() {
				invoked = true;
				return episode;
			},
		});
		expect(parsePlexNativePageWorkerResult({ ...page, items: array }, input)).toBeNull();
		expect(invoked).toBe(false);
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error("SECRET_SENTINEL");
				},
			},
		);
		expect(parsePlexNativePageWorkerRequest(proxy)).toBeNull();
		expect(parsePlexNativePageWorkerResult(proxy, input)).toBeNull();
	});
});
