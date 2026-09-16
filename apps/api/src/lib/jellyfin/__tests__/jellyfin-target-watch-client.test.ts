import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

const users = [
	{ Id: "admin", Policy: { IsAdministrator: true, IsDisabled: false } },
	{ Id: "user", Policy: { IsAdministrator: false, IsDisabled: false } },
];

function stubTarget(
	overrides: {
		item?: Record<string, unknown>;
		user?: Record<string, unknown>;
		extraUsers?: Array<{ Id: string; Policy: { IsAdministrator: boolean; IsDisabled: boolean } }>;
		inaccessibleUser?: string;
	} = {},
) {
	const item = {
		Id: "jf-movie-1",
		Type: "Movie",
		ProviderIds: { Tmdb: "123" },
		UserData: { Played: true, PlayCount: 2 },
		...overrides.item,
	};
	const userItem = { ...item, ...(overrides.user ?? {}) };
	const fetchMock = vi.fn((input: string | URL) => {
		const url = new URL(String(input));
		if (url.pathname === "/System/Info") return Promise.resolve(json({ Id: "server-1" }));
		if (url.pathname === "/Users") {
			return Promise.resolve(json([...users, ...(overrides.extraUsers ?? [])]));
		}
		if (url.pathname === "/Items/jf-movie-1/Ancestors") {
			return Promise.resolve(json([{ Id: "library-1" }]));
		}
		if (url.pathname === "/Users/admin/Items/jf-movie-1") return Promise.resolve(json(item));
		if (url.pathname === "/Users/user/Items/jf-movie-1") return Promise.resolve(json(userItem));
		if (
			overrides.inaccessibleUser &&
			url.pathname === `/Users/${overrides.inaccessibleUser}/Items/jf-movie-1`
		) {
			return Promise.resolve(new Response("forbidden", { status: 403 }));
		}
		return Promise.reject(new Error(`unexpected path ${url.pathname}`));
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("JellyfinClient target watch adapter", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reads exact item ancestors and returns the maximum positive per-user count", async () => {
		const fetchMock = stubTarget({ user: { UserData: { Played: true, PlayCount: 4 } } });
		const client = new JellyfinClient("https://jellyfin.example", "token", log);

		await expect(
			client.readTargetWatchCount({
				itemId: "jf-movie-1",
				mediaType: "movie",
				tmdbId: 123,
				libraryId: "library-1",
			}),
		).resolves.toEqual({
			serverId: "server-1",
			itemId: "jf-movie-1",
			mediaType: "movie",
			tmdbId: 123,
			libraryId: "library-1",
			observedValue: 4,
		});
		const calls = fetchMock.mock.calls as unknown as Array<[string | URL, RequestInit | undefined]>;
		expect(calls.every(([, init]) => init?.method !== "POST")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it.each([
		["wrong provider identity", { item: { ProviderIds: { Tmdb: "999" } } }],
		["wrong item type", { item: { Type: "Series" } }],
		["fractional count", { user: { UserData: { Played: true, PlayCount: 1.5 } } }],
		["fractional unplayed count", { user: { UserData: { Played: false, PlayCount: 1.5 } } }],
		["wrong library", { item: { Id: "other-item" } }],
	] as const)("fails closed for %s", async (_name, overrides) => {
		stubTarget(overrides);
		const client = new JellyfinClient("https://jellyfin.example", "token", log);

		await expect(
			client.readTargetWatchCount({
				itemId: "jf-movie-1",
				mediaType: "movie",
				tmdbId: 123,
				libraryId: "library-1",
			}),
		).rejects.toThrow("Jellyfin target watch read failed");
	});

	it("does not turn missing user data into a positive or exact zero", async () => {
		stubTarget({ user: { UserData: undefined } });
		const client = new JellyfinClient("https://jellyfin.example", "token", log);

		await expect(
			client.readTargetWatchCount({
				itemId: "jf-movie-1",
				mediaType: "movie",
				tmdbId: 123,
				libraryId: "library-1",
			}),
		).resolves.toMatchObject({ observedValue: 2 });
	});

	it("keeps an independently observed positive user when another user is inaccessible", async () => {
		stubTarget({
			extraUsers: [{ Id: "disabled", Policy: { IsAdministrator: false, IsDisabled: true } }],
			inaccessibleUser: "disabled",
		});
		const client = new JellyfinClient("https://jellyfin.example", "token", log);

		await expect(
			client.readTargetWatchCount({
				itemId: "jf-movie-1",
				mediaType: "movie",
				tmdbId: 123,
				libraryId: "library-1",
			}),
		).resolves.toMatchObject({ observedValue: 2 });
	});
});
