import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const log = { warn: vi.fn() };

describe("JellyfinClient image fetching", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("reports an upstream missing image as a typed not-found error", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
		const client = new JellyfinClient(
			"https://jellyfin.example.test",
			"private-token",
			log as never,
		);

		await expect(client.fetchImage("missing-item")).rejects.toMatchObject({
			name: "JellyfinImageNotFoundError",
			code: "JELLYFIN_IMAGE_NOT_FOUND",
			statusCode: 404,
		});
	});

	it.each([401, 403, 500])("keeps upstream HTTP %s as a non-not-found error", async (status) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status })));
		const client = new JellyfinClient(
			"https://jellyfin.example.test",
			"private-token",
			log as never,
		);

		await expect(client.fetchImage("item")).rejects.toThrow(`HTTP ${status}`);
	});

	it("returns successful image responses unchanged", async () => {
		const response = new Response("image-bytes", {
			status: 200,
			headers: { "Content-Type": "image/jpeg" },
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
		const client = new JellyfinClient(
			"https://jellyfin.example.test",
			"private-token",
			log as never,
		);

		expect(await client.fetchImage("item")).toBe(response);
	});
});
