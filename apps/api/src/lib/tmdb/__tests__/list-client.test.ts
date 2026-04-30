/**
 * TMDb v3 list client unit tests.
 *
 * Mocks `fetch` to verify request shape (URL + auth) and response
 * parsing without hitting TMDb's API. Schema-validation-failure path is
 * pinned because real-world TMDb responses can drift and we want a clear
 * signal rather than silent breakage.
 */

import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTmdbV3Client } from "../list-client.js";

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

describe("createTmdbV3Client", () => {
	it("calls /list/{id} with the api_key in query, parses items, drops persons", async () => {
		mockFetch({
			id: "8068",
			name: "Test list",
			items: [
				{ id: 100, media_type: "movie", title: "Movie A" },
				{ id: 200, media_type: "tv", name: "Show B" },
				{ id: 300, media_type: "person", name: "Some Actor" }, // dropped
				{ id: 400, media_type: "movie", title: "Movie C" },
			],
		});
		const client = createTmdbV3Client("test-api-key", log);
		const items = await client.getListItems("8068");

		expect(items).toEqual([
			{ tmdbId: 100, mediaType: "movie", title: "Movie A" },
			{ tmdbId: 200, mediaType: "series", title: "Show B" },
			{ tmdbId: 400, mediaType: "movie", title: "Movie C" },
		]);

		// Verify the URL: api_key in query, list id is URL-encoded
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
		expect(String(calledUrl)).toContain("/list/8068");
		expect(String(calledUrl)).toContain("api_key=test-api-key");
	});

	it("URL-encodes special characters in api_key + listId", async () => {
		mockFetch({ id: "abc/def", items: [] });
		const client = createTmdbV3Client("key with spaces & symbols", log);
		await client.getListItems("abc/def");

		const calledUrl = String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
		expect(calledUrl).toContain("/list/abc%2Fdef");
		// Check that the API key is properly URL-encoded
		expect(calledUrl).toContain("api_key=key%20with%20spaces%20%26%20symbols");
	});

	it("throws on non-OK HTTP status with informative message", async () => {
		mockFetch({}, false, 401);
		const client = createTmdbV3Client("bad-key", log);
		await expect(client.getListItems("8068")).rejects.toThrow(/HTTP 401/);
	});

	it("throws + warns on schema-validation failure (drift detection)", async () => {
		mockFetch({ totally: "wrong", shape: true }); // missing required `items`
		const client = createTmdbV3Client("test-key", log);
		await expect(client.getListItems("8068")).rejects.toThrow(/malformed response/);
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ listId: "8068", issues: expect.any(Array) }),
			expect.stringMatching(/schema validation/),
		);
	});

	it("falls back to '(untitled)' when both title and name are missing", async () => {
		mockFetch({
			id: "1",
			items: [{ id: 100, media_type: "movie" }], // no title, no name
		});
		const client = createTmdbV3Client("k", log);
		const items = await client.getListItems("1");
		expect(items).toEqual([{ tmdbId: 100, mediaType: "movie", title: "(untitled)" }]);
	});

	it("treats absent media_type as movie (default)", async () => {
		mockFetch({
			id: "1",
			items: [{ id: 100, title: "Untyped Movie" }], // no media_type field
		});
		const client = createTmdbV3Client("k", log);
		const items = await client.getListItems("1");
		expect(items[0]?.mediaType).toBe("movie");
	});
});
