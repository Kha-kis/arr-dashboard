import { describe, expect, it, vi } from "vitest";
import { libraryPosterPath, libraryPosterUrl, readLibraryPoster } from "../poster-delivery.js";

describe("Library poster cache-key projection", () => {
	it("uses authoritative cache keys, encodes instance IDs, and never exposes the cached origin", () => {
		const row = { instanceId: "instance/one", itemType: "movie", arrItemId: 42 };
		const poster = "http://private.example.test/MediaCover/999/poster.jpg?secret=synthetic";
		const url = libraryPosterUrl(row, poster);
		expect(url).toMatch(/^\/api\/library\/poster\/instance%2Fone\/movie\/42\?v=[a-f0-9]{16}$/);
		expect(url).not.toContain("private");
		expect(url).not.toContain("secret");
		expect(libraryPosterUrl(row, poster)).toBe(url);
		expect(libraryPosterUrl(row, `${poster}-changed`)).not.toBe(url);
	});

	it.each([null, undefined, "", " ", 42])("keeps missing artwork %s unavailable", (poster) => {
		expect(
			libraryPosterUrl({ instanceId: "instance", itemType: "movie", arrItemId: 42 }, poster),
		).toBeUndefined();
	});

	it.each(["movie", "series", "artist", "author"] as const)(
		"builds a fixed %s root cover path",
		(itemType) => {
			expect(libraryPosterPath(itemType, 42, "{}")).toBe("/MediaCover/42/poster.jpg");
		},
	);

	it.each(["movie", "series"] as const)(
		"keeps %s JPEG even when remote artwork has a different suffix",
		(itemType) => {
			expect(
				libraryPosterPath(itemType, 42, JSON.stringify({ poster: "https://synthetic.test/x.png" })),
			).toBe("/MediaCover/42/poster.jpg");
		},
	);

	it.each(["artist", "author"] as const)(
		"retains only recognized raster suffixes for %s",
		(itemType) => {
			expect(
				libraryPosterPath(
					itemType,
					42,
					JSON.stringify({ poster: "https://synthetic.test/x.PNG?token=synthetic" }),
				),
			).toBe("/MediaCover/42/poster.PNG");
			for (const poster of [
				"https://synthetic.test/x.svg",
				"../../private",
				"data:image/png;base64,abc",
				"https://synthetic.test/x.jpg/../../other",
			])
				expect(libraryPosterPath(itemType, 42, JSON.stringify({ poster }))).toBe(
					"/MediaCover/42/poster.jpg",
				);
			expect(libraryPosterPath(itemType, 42, "not JSON")).toBe("/MediaCover/42/poster.jpg");
		},
	);
});

describe("bounded raster poster reads", () => {
	it.each(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"])(
		"accepts %s with bounded bytes",
		async (contentType) => {
			expect(
				await readLibraryPoster(
					new Response("synthetic", { headers: { "content-type": `${contentType}; synthetic=1` } }),
				),
			).toEqual({ bytes: Buffer.from("synthetic"), contentType });
		},
	);

	it("cancels a declared oversized body without pulling it to completion", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream({ cancel });
		expect(
			await readLibraryPoster(
				new Response(body, {
					headers: { "content-type": "image/jpeg", "content-length": String(4 * 1024 * 1024 + 1) },
				}),
			),
		).toBeNull();
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("rejects empty bodies and propagates body-read failures to the sanitized route", async () => {
		expect(
			await readLibraryPoster(new Response(null, { headers: { "content-type": "image/jpeg" } })),
		).toBeNull();
		expect(
			await readLibraryPoster(new Response("", { headers: { "content-type": "image/jpeg" } })),
		).toBeNull();
		await expect(
			readLibraryPoster(
				new Response(
					new ReadableStream({
						start(controller) {
							controller.error(new Error("synthetic read failure"));
						},
					}),
					{ headers: { "content-type": "image/jpeg" } },
				),
			),
		).rejects.toThrow("synthetic read failure");
	});
});
