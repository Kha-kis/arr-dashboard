import { afterEach, describe, expect, it, vi } from "vitest";
import { createJellyfinClient } from "../jellyfin-client.js";

const encryptedCredentials = JSON.stringify({ v: 1, username: "proxy", password: "secret" });
const encryptor = {
	decrypt: vi.fn(({ value }: { value: string }) =>
		value === "encrypted-api-key" ? "api-key" : encryptedCredentials,
	),
};
const log = { warn: vi.fn() };

const instance = (service: "JELLYFIN" | "EMBY", withHttpAuth: boolean) => ({
	id: "media-1",
	baseUrl: "https://media.example.test",
	encryptedApiKey: "encrypted-api-key",
	encryptionIv: "api-iv",
	encryptedHttpAuthCredentials: withHttpAuth ? "encrypted-http-auth" : null,
	httpAuthEncryptionIv: withHttpAuth ? "http-iv" : null,
	service,
});

describe("JellyfinClient HTTP authentication", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("uses modern Authorization authentication when no proxy Basic Auth is configured", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
			);
		vi.stubGlobal("fetch", fetchSpy);
		const client = createJellyfinClient(
			encryptor as never,
			instance("JELLYFIN", false),
			log as never,
		);

		await client.getUsers();

		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers.Authorization).toContain("MediaBrowser");
		expect(headers["X-Emby-Token"]).toBeUndefined();
	});

	it("rejects proxy Basic Auth for Jellyfin instead of using deprecated auth headers", () => {
		expect(() =>
			createJellyfinClient(encryptor as never, instance("JELLYFIN", true), log as never),
		).toThrow(/cannot be combined with modern Jellyfin authentication/i);
	});

	it("retains the alternate Emby headers when its proxy uses Basic Auth", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
			);
		vi.stubGlobal("fetch", fetchSpy);
		const client = createJellyfinClient(encryptor as never, instance("EMBY", true), log as never);

		await client.getUsers();

		const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Basic cHJveHk6c2VjcmV0");
		expect(headers["X-Emby-Token"]).toBe("api-key");
	});

	it("paginates library inventory until TotalRecordCount is exhausted", async () => {
		const makeItem = (index: number) => ({
			Id: `item-${index}`,
			Name: `Item ${index}`,
			Type: "Movie",
			ProviderIds: { Tmdb: String(index + 1) },
			UserData: {},
		});
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						Items: Array.from({ length: 1_000 }, (_, index) => makeItem(index)),
						TotalRecordCount: 1_001,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ Items: [makeItem(1_000)], TotalRecordCount: 1_001 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchSpy);
		const client = createJellyfinClient(
			encryptor as never,
			instance("JELLYFIN", false),
			log as never,
		);

		const items = await client.getLibraryItems("user-1", "library-1");

		expect(items).toHaveLength(1_001);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("StartIndex=0");
		expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("StartIndex=1000");
	});

	it("paginates episode inventory until TotalRecordCount is exhausted", async () => {
		const makeEpisode = (index: number) => ({
			Id: `episode-${index}`,
			Name: `Episode ${index}`,
			Type: "Episode",
			ParentIndexNumber: 1,
			IndexNumber: index + 1,
			UserData: {},
		});
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						Items: Array.from({ length: 1_000 }, (_, index) => makeEpisode(index)),
						TotalRecordCount: 1_001,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ Items: [makeEpisode(1_000)], TotalRecordCount: 1_001 }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchSpy);
		const client = createJellyfinClient(
			encryptor as never,
			instance("JELLYFIN", false),
			log as never,
		);

		const episodes = await client.getEpisodes("user-1", "series-1");

		expect(episodes).toHaveLength(1_001);
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("StartIndex=0");
		expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("StartIndex=1000");
	});

	it.each([
		[
			"a changing total",
			{ Items: [{ Id: "episode-1", Name: "One", Type: "Episode" }], TotalRecordCount: 2 },
			{ Items: [{ Id: "episode-2", Name: "Two", Type: "Episode" }], TotalRecordCount: 3 },
			/changed while/i,
		],
		[
			"an empty continuation page",
			{ Items: [{ Id: "episode-1", Name: "One", Type: "Episode" }], TotalRecordCount: 2 },
			{ Items: [], TotalRecordCount: 2 },
			/ended before/i,
		],
		[
			"a duplicate episode identity",
			{ Items: [{ Id: "episode-1", Name: "One", Type: "Episode" }], TotalRecordCount: 2 },
			{ Items: [{ Id: "episode-1", Name: "One again", Type: "Episode" }], TotalRecordCount: 2 },
			/duplicate/i,
		],
	])("rejects %s while paging episodes", async (_label, firstPage, secondPage, expected) => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify(firstPage), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify(secondPage), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchSpy);
		const client = createJellyfinClient(
			encryptor as never,
			instance("JELLYFIN", false),
			log as never,
		);

		await expect(client.getEpisodes("user-1", "series-1")).rejects.toThrow(expected);
	});
});
