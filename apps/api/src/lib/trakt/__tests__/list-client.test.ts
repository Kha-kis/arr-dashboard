/**
 * Trakt list client unit tests.
 *
 * Mocks `fetch` to verify request shape (URL + auth headers + slug
 * parsing) and response parsing without hitting Trakt's API. The
 * tmdbId-required filtering is pinned — items without TMDb mapping
 * are silently dropped because our cache + evaluator are tmdbId-keyed.
 */

import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTraktClient } from "../list-client.js";

const log = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
} as unknown as FastifyBaseLogger;

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

function mockFetch(jsonBody: unknown, ok = true, status = 200) {
	globalThis.fetch = vi.fn().mockResolvedValue({
		ok,
		status,
		statusText: ok ? "OK" : "Error",
		json: async () => jsonBody,
	} as Response);
}

describe("createTraktClient", () => {
	it("throws on construction without TRAKT_CLIENT_ID", () => {
		expect(() => createTraktClient("token", "", log)).toThrow(/TRAKT_CLIENT_ID/);
	});

	it("calls users/{u}/lists/{slug}/items with bearer + trakt-api-key headers", async () => {
		mockFetch([]);
		const client = createTraktClient("user-pat-token", "app-client-id", log);
		await client.getListItems("trakt-official/oscar-winners");

		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(String(url)).toContain("/users/trakt-official/lists/oscar-winners/items");
		expect((init as RequestInit).headers).toMatchObject({
			Authorization: "Bearer user-pat-token",
			"trakt-api-key": "app-client-id",
			"trakt-api-version": "2",
		});
	});

	it("rejects malformed slug (no slash)", async () => {
		const client = createTraktClient("token", "client-id", log);
		await expect(client.getListItems("not-a-slug")).rejects.toThrow(/username\/list-slug/);
	});

	it("parses movie + show entries; drops anything without TMDb id", async () => {
		mockFetch([
			{ type: "movie", movie: { title: "Has tmdb", ids: { tmdb: 100 } } },
			{ type: "show", show: { title: "TV with tmdb", ids: { tmdb: 200 } } },
			{ type: "movie", movie: { title: "No tmdb", ids: { imdb: "tt9999" } } }, // dropped
			{ type: "season", season: { ids: { tmdb: 300 } } }, // unsupported type → dropped
			{ type: "person", person: { name: "Director" } }, // unsupported type → dropped
		]);

		const client = createTraktClient("token", "client-id", log);
		const items = await client.getListItems("user/list");

		expect(items).toEqual([
			{ tmdbId: 100, mediaType: "movie", title: "Has tmdb" },
			{ tmdbId: 200, mediaType: "series", title: "TV with tmdb" },
		]);
	});

	it("throws + warns on schema-validation failure", async () => {
		mockFetch({ not: "an-array" });
		const client = createTraktClient("token", "client-id", log);
		await expect(client.getListItems("u/l")).rejects.toThrow(/malformed response/);
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ listSlug: "u/l", issues: expect.any(Array) }),
			expect.stringMatching(/schema validation/),
		);
	});

	it("throws on non-OK HTTP status", async () => {
		mockFetch({}, false, 403);
		const client = createTraktClient("expired-token", "client-id", log);
		await expect(client.getListItems("u/l")).rejects.toThrow(/HTTP 403/);
	});
});
