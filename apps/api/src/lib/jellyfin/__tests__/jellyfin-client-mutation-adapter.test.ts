import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validationQuarantine } from "../../validation/validation-quarantine.js";
import { JellyfinClient } from "../jellyfin-client.js";

const log = { warn: vi.fn() } as unknown as FastifyBaseLogger;

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		Id: "movie-1",
		Name: "Private Title",
		Type: "Movie",
		ProviderIds: { Tmdb: "123", Imdb: "tt123" },
		Tags: ["existing"],
		CustomCanary: "private DTO field",
		...overrides,
	};
}

const mutationUsers = [
	{ Id: "disabled-admin", Policy: { IsAdministrator: true, IsDisabled: true } },
	{ Id: "ordinary-user", Policy: { IsAdministrator: false, IsDisabled: false } },
	{ Id: "admin-b", Policy: { IsAdministrator: true, IsDisabled: false } },
	{ Id: "admin-a", Policy: { IsAdministrator: true, IsDisabled: false } },
];

function stubRead(
	overrides: { server?: unknown; users?: unknown; item?: unknown; ancestors?: unknown } = {},
): ReturnType<typeof vi.fn> {
	const responses = [
		jsonResponse(overrides.server ?? { Id: "server-1", ServerName: "private server" }),
		jsonResponse(overrides.users ?? mutationUsers),
		jsonResponse(overrides.item ?? item()),
		jsonResponse(overrides.ancestors ?? [{ Id: "library-1", Name: "private library" }]),
	];
	const fetchMock = vi.fn();
	for (const response of responses) fetchMock.mockResolvedValueOnce(response);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

describe("JellyfinClient mutation adapter", () => {
	it.each(["read", "send"])(
		"does not forward a mutation %s to an unverified redirect target",
		async (phase) => {
			let redirectedRequests = 0;
			const destination = createServer((_req, res) => {
				redirectedRequests++;
				res.writeHead(204);
				res.end();
			});
			await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
			const redirectUrl = `http://127.0.0.1:${(destination.address() as AddressInfo).port}/unverified`;
			const source = createServer((req, res) => {
				if ((phase === "read" && req.url === "/System/Info") || req.method === "POST") {
					res.writeHead(307, { Location: redirectUrl });
					res.end();
					return;
				}
				const url = new URL(req.url!, "http://fixture");
				const body =
					url.pathname === "/System/Info"
						? { Id: "server-1" }
						: url.pathname === "/Users"
							? mutationUsers
							: url.pathname.endsWith("/Ancestors")
								? [{ Id: "library-1" }]
								: item();
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(body));
			});
			await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
			try {
				const client = new JellyfinClient(
					`http://127.0.0.1:${(source.address() as AddressInfo).port}`,
					"synthetic-token",
					log,
				);
				if (phase === "read") await expect(client.readMutationTarget("movie-1")).rejects.toThrow();
				else {
					const target = await client.readMutationTarget("movie-1");
					await expect(client.addMutationTargetTag(target, "new-tag")).rejects.toThrow();
				}
				expect(redirectedRequests).toBe(0);
			} finally {
				source.closeAllConnections();
				destination.closeAllConnections();
				await Promise.all(
					[source, destination].map(
						(server) =>
							new Promise<void>((resolve, reject) =>
								server.close((error) => (error ? reject(error) : resolve())),
							),
					),
				);
			}
		},
	);

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
		validationQuarantine.clear();
	});

	it("supplies one enabled administrator context to both Jellyfin 10.11 item reads", async () => {
		const fetchMock = vi.fn((input: string | URL) => {
			const url = new URL(String(input));
			const path = url.pathname;
			if (path === "/System/Info") {
				return Promise.resolve(jsonResponse({ Id: "server-1" }));
			}
			if (path === "/Users") return Promise.resolve(jsonResponse(mutationUsers));
			// The API-key principal has no user ID. The real 10.11 item route
			// rejects this request and ancestors omit the expected library view.
			if (url.searchParams.get("userId") !== "admin-a") {
				return Promise.resolve(new Response(null, { status: 400 }));
			}
			if (path === "/Items/movie-1") {
				return Promise.resolve(
					jsonResponse({
						Id: "movie-1",
						Type: "Movie",
						ProviderIds: { Tmdb: "123" },
						Tags: ["existing"],
					}),
				);
			}
			if (path === "/Items/movie-1/Ancestors") {
				return Promise.resolve(jsonResponse([{ Id: "library-1" }]));
			}
			return Promise.reject(new Error("unexpected path"));
		});
		vi.stubGlobal("fetch", fetchMock);

		const client = new JellyfinClient("https://media.example.test", "token", log);
		const snapshot = await client.readMutationTarget("movie-1");

		expect(snapshot).toEqual({
			serverId: "server-1",
			itemId: "movie-1",
			mediaType: "movie",
			tmdbId: 123,
			tags: ["existing"],
			ancestorIds: ["library-1"],
		});
		expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
			"/System/Info",
			"/Users",
			"/Items/movie-1",
			"/Items/movie-1/Ancestors",
		]);
	});

	it.each(
		[
			[],
			mutationUsers.slice(0, 2),
			[{ Id: "user-without-policy" }],
			[mutationUsers[2], mutationUsers[2]],
		].map((users) => [users]),
	)(
		"rejects missing or ambiguous administrator discovery before reading an item",
		async (users) => {
			const fetchMock = stubRead({ users });
			const client = new JellyfinClient("https://media.example.test", "token", log);
			await expect(client.readMutationTarget("movie-1")).rejects.toThrow(
				"Jellyfin mutation target read failed",
			);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(validationQuarantine.count).toBe(0);
		},
	);

	it("returns only a frozen bounded snapshot while retaining DTO fields privately", async () => {
		stubRead();
		const client = new JellyfinClient("https://media.example.test", "token", log);

		const snapshot = await client.readMutationTarget("movie-1");

		expect(Object.keys(snapshot)).toEqual([
			"serverId",
			"itemId",
			"mediaType",
			"tmdbId",
			"tags",
			"ancestorIds",
		]);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.tags)).toBe(true);
		expect(Object.isFrozen(snapshot.ancestorIds)).toBe(true);
		expect(snapshot).not.toHaveProperty("name");
		expect(snapshot).not.toHaveProperty("customCanary");
	});

	it("normalizes a valid Series identity without exposing provider fields", async () => {
		stubRead({
			item: item({ Id: "series-1", Type: "Series", ProviderIds: { tmdb: "456" }, Tags: [] }),
			ancestors: [],
		});
		const client = new JellyfinClient("https://media.example.test", "token", log);

		await expect(client.readMutationTarget("series-1")).resolves.toEqual({
			serverId: "server-1",
			itemId: "series-1",
			mediaType: "series",
			tmdbId: 456,
			tags: [],
			ancestorIds: [],
		});
	});

	it.each([
		["missing TMDb", { ProviderIds: { Imdb: "tt123" } }],
		["duplicate TMDb casing", { ProviderIds: { Tmdb: "123", tmdb: "123" } }],
		["padded TMDb", { ProviderIds: { Tmdb: "0123" } }],
		["unsafe TMDb", { ProviderIds: { Tmdb: "9007199254740992" } }],
		["changed item ID", { Id: "different-item" }],
		["wrong item type", { Type: "Episode" }],
		["duplicate tags", { Tags: ["existing", "existing"] }],
		["malformed tags", { Tags: ["existing", ""] }],
	] as const)(
		"rejects %s with a generic error and no quarantine entry",
		async (_label, itemOverrides) => {
			stubRead({ item: item(itemOverrides) });
			const client = new JellyfinClient("https://media.example.test", "token", log);

			await expect(client.readMutationTarget("movie-1")).rejects.toThrow(
				"Jellyfin mutation target read failed",
			);
			expect(validationQuarantine.count).toBe(0);
			expect(log.warn).not.toHaveBeenCalled();
		},
	);

	it.each([
		["duplicate ancestors", [{ Id: "library-1" }, { Id: "library-1" }]],
		["enveloped ancestors", { Items: [{ Id: "library-1" }] }],
		["malformed ancestors", [{ Name: "missing id" }]],
	] as const)("rejects %s without exposing provider details", async (_label, ancestors) => {
		stubRead({ ancestors });
		const client = new JellyfinClient("https://media.example.test", "token", log);

		await expect(client.readMutationTarget("movie-1")).rejects.toThrow(
			"Jellyfin mutation target read failed",
		);
		expect(validationQuarantine.count).toBe(0);
	});

	it("round-trips the complete validated DTO with an exact tag union", async () => {
		const complete = item({
			MediaSources: [{ Id: "source-1", Path: "/private/path" }],
			NestedCanary: { title: "private title" },
		});
		const fetchMock = stubRead({ item: complete });
		fetchMock.mockResolvedValueOnce(jsonResponse({ ...complete, Tags: ["existing", "new-tag"] }));
		const client = new JellyfinClient("https://media.example.test", "token", log);
		const snapshot = await client.readMutationTarget("movie-1");

		await expect(client.addMutationTargetTag(snapshot, "new-tag")).resolves.toBe("sent");
		expect(fetchMock).toHaveBeenCalledTimes(5);
		const [postUrl, postInit] = fetchMock.mock.calls[4] as [string, RequestInit];
		expect(new URL(postUrl).pathname).toBe("/Items/movie-1");
		expect(postInit.method).toBe("POST");
		expect(JSON.parse(String(postInit.body))).toEqual({
			...complete,
			Tags: ["existing", "new-tag"],
		});
	});

	it.each([204, 200] as const)(
		"returns sent for a successful POST with HTTP %s without reading its body",
		async (status) => {
			const fetchMock = stubRead();
			const response = {
				ok: true,
				status,
				headers: new Headers(),
				json: vi.fn(() => Promise.reject(new Error("body must not be read"))),
				text: vi.fn(() => Promise.reject(new Error("body must not be read"))),
			} as unknown as Response;
			fetchMock.mockResolvedValueOnce(response);
			const client = new JellyfinClient("https://media.example.test", "token", log);
			const snapshot = await client.readMutationTarget("movie-1");

			await expect(client.addMutationTargetTag(snapshot, "new-tag")).resolves.toBe("sent");
			expect(response.json).not.toHaveBeenCalled();
			expect(response.text).not.toHaveBeenCalled();
		},
	);

	it("accepts an unexpected successful response body without reading it", async () => {
		const fetchMock = stubRead();
		const response = {
			ok: true,
			status: 202,
			headers: new Headers({ "Content-Type": "application/json" }),
			json: vi.fn(() => Promise.reject(new Error("body must not be read"))),
			text: vi.fn(() => Promise.reject(new Error("body must not be read"))),
		} as unknown as Response;
		fetchMock.mockResolvedValueOnce(response);
		const client = new JellyfinClient("https://media.example.test", "token", log);
		const snapshot = await client.readMutationTarget("movie-1");

		await expect(client.addMutationTargetTag(snapshot, "new-tag")).resolves.toBe("sent");
		expect(response.json).not.toHaveBeenCalled();
		expect(response.text).not.toHaveBeenCalled();
	});

	it("rejects a non-2xx POST without reading its error body", async () => {
		const fetchMock = stubRead();
		const response = {
			ok: false,
			status: 502,
			headers: new Headers({ "Content-Type": "application/json" }),
			json: vi.fn(() => Promise.reject(new Error("body must not be read"))),
			text: vi.fn(() => Promise.reject(new Error("body must not be read"))),
		} as unknown as Response;
		fetchMock.mockResolvedValueOnce(response);
		const client = new JellyfinClient("https://media.example.test", "token", log);
		const snapshot = await client.readMutationTarget("movie-1");

		await expect(client.addMutationTargetTag(snapshot, "new-tag")).rejects.toThrow(
			"Jellyfin mutation target update failed",
		);
		expect(response.json).not.toHaveBeenCalled();
		expect(response.text).not.toHaveBeenCalled();
	});

	it.each(["", "   ", "x".repeat(257)] as const)(
		"rejects invalid item ID %j before any network request",
		async (itemId) => {
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			const client = new JellyfinClient("https://media.example.test", "token", log);

			await expect(client.readMutationTarget(itemId)).rejects.toThrow(
				"Jellyfin mutation target read failed",
			);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("returns noop without POST and consumes the handle", async () => {
		const fetchMock = stubRead();
		const client = new JellyfinClient("https://media.example.test", "token", log);
		const snapshot = await client.readMutationTarget("movie-1");

		await expect(client.addMutationTargetTag(snapshot, "existing")).resolves.toBe("noop");
		expect(fetchMock).toHaveBeenCalledTimes(4);
		await expect(client.addMutationTargetTag(snapshot, "new-tag")).rejects.toThrow(
			"Jellyfin mutation target handle is invalid",
		);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("rejects fabricated and cross-client handles without POST", async () => {
		const fetchMock = stubRead();
		const client = new JellyfinClient("https://media.example.test", "token", log);
		const otherClient = new JellyfinClient("https://media.example.test", "token", log);
		const snapshot = await client.readMutationTarget("movie-1");

		await expect(otherClient.addMutationTargetTag(snapshot, "new-tag")).rejects.toThrow(
			"Jellyfin mutation target handle is invalid",
		);
		await expect(client.addMutationTargetTag({} as never, "new-tag")).rejects.toThrow(
			"Jellyfin mutation target handle is invalid",
		);
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("contains transport and response failures to generic errors", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("PRIVATE_RAW_ERROR"));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("https://media.example.test", "PRIVATE_TOKEN", log);

		await expect(client.readMutationTarget("PRIVATE_ITEM")).rejects.toThrow(
			"Jellyfin mutation target read failed",
		);
		expect(String(log.warn)).not.toContain("PRIVATE_RAW_ERROR");

		const statusMock = vi.fn().mockResolvedValue(new Response("PRIVATE_BODY", { status: 502 }));
		vi.stubGlobal("fetch", statusMock);
		await expect(client.readMutationTarget("PRIVATE_ITEM")).rejects.toThrow(
			"Jellyfin mutation target read failed",
		);
	});

	it.each([
		[
			"invalid JSON",
			new Response("PRIVATE_RAW_BODY", {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		],
		[
			"non-JSON success",
			new Response("PRIVATE_RAW_BODY", { status: 200, headers: { "Content-Type": "text/plain" } }),
		],
	] as const)("rejects %s without returning the response body", async (_label, response) => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
		const client = new JellyfinClient("https://media.example.test", "token", log);

		await expect(client.readMutationTarget("movie-1")).rejects.toThrow(
			"Jellyfin mutation target read failed",
		);
	});

	it("preserves Emby proxy authentication headers on mutation reads", async () => {
		const fetchMock = stubRead();
		const client = new JellyfinClient("https://media.example.test", "PRIVATE_TOKEN", log, 15_000, {
			Authorization: "Basic PRIVATE_BASIC",
		});

		await client.readMutationTarget("movie-1");
		const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Basic PRIVATE_BASIC");
		expect(headers["X-Emby-Token"]).toBe("PRIVATE_TOKEN");
		expect(headers["X-Emby-Authorization"]).toContain("MediaBrowser");
	});
});

describe("mutation-safe native inventory reads", () => {
	it.each(["folders", "items"] as const)(
		"keeps invalid %s out of quarantine and refuses redirects",
		async (kind) => {
			const before = validationQuarantine.count;
			const fetchMock = vi
				.fn()
				.mockResolvedValue(jsonResponse({ PrivateCanary: "private-native-catalog" }));
			vi.stubGlobal("fetch", fetchMock);
			const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
			try {
				if (kind === "folders")
					await expect(
						client.getNativeMediaFolders({ mutationValidation: true }),
					).rejects.toThrow();
				else
					expect(
						(
							await client.getNativeLibraryItemsWithCoverage("library-1", {
								mutationValidation: true,
							})
						).reason,
					).toBe("page-failure");
				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "error" });
				expect(validationQuarantine.count).toBe(before);
			} finally {
				vi.unstubAllGlobals();
			}
		},
	);
});
