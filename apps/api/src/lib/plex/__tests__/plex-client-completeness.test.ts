import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient, PlexRequestError } from "../plex-client.js";

const warn = vi.fn();
const log = { warn } as never;

function response(MediaContainer: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ MediaContainer }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function libraryItem(index: number) {
	return {
		ratingKey: `item-${index}`,
		title: `Movie ${index}`,
		type: "movie",
		Guid: [{ id: `tmdb://${index}` }],
	};
}

function historyItem(index: number) {
	return {
		historyKey: `/status/sessions/history/${index}`,
		ratingKey: `movie-${index}`,
		title: `Movie ${index}`,
		type: "movie",
		viewedAt: 1_700_000_000,
		accountID: 1,
	};
}

describe("PlexClient authoritative inventory completeness", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("paginates every library item before exposing the inventory", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => libraryItem(index + 1));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: firstPage }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 1, totalSize: 201, Metadata: [libraryItem(201)] }),
			)
			.mockResolvedValueOnce(response({ size: 200, Metadata: firstPage }))
			.mockResolvedValueOnce(response({ size: 1, Metadata: [libraryItem(201)] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const items = await client.getLibraryItems("movies");

		expect(items).toHaveLength(201);
		expect(fetchMock).toHaveBeenCalledTimes(4);
		const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
		expect(secondUrl.searchParams.get("X-Plex-Container-Start")).toBe("200");
	});

	it("enriches complete section rows with item-level labels and collections", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 1, totalSize: 1, Metadata: [libraryItem(1)] }),
			)
			.mockResolvedValueOnce(
				response({
					size: 1,
					Metadata: [
						{
							...libraryItem(1),
							Label: [{ tag: "Family" }],
							Collection: [{ tag: "Classics" }],
						},
					],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItems("movies")).resolves.toEqual([
			expect.objectContaining({
				ratingKey: "item-1",
				Label: [{ tag: "Family" }],
				Collection: [{ tag: "Classics" }],
			}),
		]);
		const metadataUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
		expect(metadataUrl.pathname).toBe("/library/metadata/item-1");
	});

	it("rejects a library page that stops before its declared total", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 1, totalSize: 2, Metadata: [libraryItem(1)] }),
			)
			.mockResolvedValueOnce(response({ offset: 1, size: 0, totalSize: 2, Metadata: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibraryItems("movies")).rejects.toThrow(/stopped before/i);
	});

	it("rejects capped history instead of exposing a partial watch inventory", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					offset: 0,
					size: 1,
					totalSize: 100_001,
					Metadata: [
						{
							ratingKey: "movie-1",
							title: "Movie",
							type: "movie",
							viewedAt: 1_700_000_000,
							accountID: 1,
						},
					],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getHistory({ maxResults: 100_000, requireComplete: true })).rejects.toThrow(
			/exceeding the safe 100000-row limit/i,
		);
	});

	it("uses a Plex-compatible single sort key for complete history", async () => {
		const history = Array.from({ length: 201 }, (_, index) => historyItem(index));
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			if (url.searchParams.get("sort") !== "viewedAt:desc") {
				return new Response(null, { status: 400, statusText: "Bad Request" });
			}
			const offset = Number(url.searchParams.get("X-Plex-Container-Start") ?? "0");
			const page = history.slice(offset, offset + 200);
			return response({ offset, size: page.length, totalSize: history.length, Metadata: page });
		});
		vi.stubGlobal("fetch", fetchMock);

		const client = new PlexClient("http://plex.test", "token", log);
		await expect(
			client.getHistory({ maxResults: 100_000, requireComplete: true }),
		).resolves.toHaveLength(201);
		for (const [input] of fetchMock.mock.calls) {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			expect(url.searchParams.get("sort")).toBe("viewedAt:desc");
		}
	});

	it("rejects a repeated history page instead of exposing an incomplete watch inventory", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: `movie-${index}`,
			title: `Movie ${index}`,
			type: "movie",
			viewedAt: 1_700_000_000,
			accountID: 1,
		}));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 400, Metadata: firstPage }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 200, totalSize: 400, Metadata: firstPage }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getHistory({ maxResults: 100_000, requireComplete: true })).rejects.toThrow(
			/duplicate row while paging/i,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("accepts distinct same-second plays and verifies the newest page before publishing", async () => {
		const history = Array.from({ length: 201 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: "movie-1",
			title: "Movie",
			type: "movie",
			viewedAt: 1_700_000_000,
			accountID: 1,
		}));
		const reordered = [...history].reverse();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: history.slice(0, 200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 1, totalSize: 201, Metadata: history.slice(200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: reordered.slice(0, 200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 1, totalSize: 201, Metadata: reordered.slice(200) }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const snapshot = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		expect(snapshot).toHaveLength(201);
		await expect(client.verifyHistorySnapshot(snapshot)).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledTimes(4);
	});

	it("rejects equal-count history churn detected by the newest-page verification", async () => {
		const initial = Array.from({ length: 200 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: `movie-${index}`,
			title: `Movie ${index}`,
			type: "movie",
			viewedAt: 1_700_000_000 + index,
			accountID: 1,
		}));
		const changed = [
			{
				historyKey: "/status/sessions/history/new",
				ratingKey: "movie-new",
				title: "New Movie",
				type: "movie",
				viewedAt: 1_800_000_000,
				accountID: 1,
			},
			...initial.slice(0, 199),
		];
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response({ offset: 0, size: 200, totalSize: 200, Metadata: initial }),
				)
				.mockResolvedValueOnce(
					response({ offset: 0, size: 200, totalSize: 200, Metadata: changed }),
				),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		const snapshot = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		await expect(client.verifyHistorySnapshot(snapshot)).rejects.toThrow(
			/changed before.*snapshot/i,
		);
	});

	it("rejects a librarySectionID change between collection and verification", async () => {
		const base = {
			historyKey: "/status/sessions/history/1",
			ratingKey: "",
			title: "Home Video",
			type: "movie",
			viewedAt: 1_700_000_000,
			accountID: 1,
		};
		const initial = [{ ...base, librarySectionID: "personal-section" }];
		const changed = [{ ...base, librarySectionID: "supported-section" }];
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(response({ offset: 0, size: 1, totalSize: 1, Metadata: initial }))
				.mockResolvedValueOnce(response({ offset: 0, size: 1, totalSize: 1, Metadata: changed })),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		const snapshot = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		await expect(client.verifyHistorySnapshot(snapshot)).rejects.toThrow(
			/changed before.*snapshot/i,
		);
	});

	it("rejects equal-count churn in a middle page during complete verification", async () => {
		const history = Array.from({ length: 401 }, (_, index) => ({
			historyKey: `/status/sessions/history/${index}`,
			ratingKey: `movie-${index}`,
			title: `Movie ${index}`,
			type: "movie",
			viewedAt: 1_700_000_000 + index,
			accountID: 1,
		}));
		const changedMiddle = history.slice(200, 400).map((item) => ({ ...item }));
		changedMiddle[50] = { ...changedMiddle[50]!, accountID: 2 };
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 401, Metadata: history.slice(0, 200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 200, totalSize: 401, Metadata: history.slice(200, 400) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 400, size: 1, totalSize: 401, Metadata: history.slice(400) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 401, Metadata: history.slice(0, 200) }),
			)
			.mockResolvedValueOnce(
				response({ offset: 200, size: 200, totalSize: 401, Metadata: changedMiddle }),
			)
			.mockResolvedValueOnce(
				response({ offset: 400, size: 1, totalSize: 401, Metadata: history.slice(400) }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const snapshot = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		await expect(client.verifyHistorySnapshot(snapshot)).rejects.toThrow(
			/changed before.*snapshot/i,
		);
		expect(fetchMock).toHaveBeenCalledTimes(6);
	});

	it("accepts endpoint-specific account and section inventories that publish size only", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ size: 1, Directory: [{ key: "1", title: "Movies", type: "movie" }] }),
			)
			.mockResolvedValueOnce(response({ size: 1, Account: [{ id: 1, name: "Admin" }] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySections()).resolves.toHaveLength(1);
		await expect(client.getAccounts()).resolves.toEqual([{ id: 1, name: "Admin" }]);
	});

	it("preserves the section agent through the wire mapping", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			response({
				size: 1,
				Directory: [
					{ key: "7", title: "Personal", type: "movie", agent: "com.plexapp.agents.none" },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySections()).resolves.toEqual([
			{ key: "7", title: "Personal", type: "movie", agent: "com.plexapp.agents.none" },
		]);
	});

	it("leaves an absent section agent undefined rather than defaulting it", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ size: 1, Directory: [{ key: "1", title: "Movies", type: "movie" }] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const sections = await client.getLibrarySections();
		expect(sections[0]).toEqual({ key: "1", title: "Movies", type: "movie" });
		expect(sections[0]?.agent).toBeUndefined();
	});

	it("coerces a numeric librarySectionID to a string through getHistory", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			response({
				offset: 0,
				size: 1,
				totalSize: 1,
				Metadata: [
					{
						historyKey: "/status/sessions/history/1",
						ratingKey: "movie-1",
						title: "Movie",
						type: "movie",
						viewedAt: 1_700_000_000,
						accountID: 1,
						librarySectionID: 7,
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const history = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		expect(history[0]?.librarySectionID).toBe("7");
	});

	it("leaves a missing librarySectionID undefined through getHistory", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			response({
				offset: 0,
				size: 1,
				totalSize: 1,
				Metadata: [
					{
						historyKey: "/status/sessions/history/1",
						ratingKey: "movie-1",
						title: "Movie",
						type: "movie",
						viewedAt: 1_700_000_000,
						accountID: 1,
					},
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const history = await client.getHistory({ maxResults: 100_000, requireComplete: true });
		expect(history[0]?.librarySectionID).toBeUndefined();
	});

	it("returns the bounded live section settlement fields", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				response({
					size: 1,
					Directory: [
						{
							key: "1",
							uuid: "movie-section-uuid",
							title: "Movies",
							type: "movie",
							agent: "tv.plex.agents.movie",
							refreshing: "0",
							scannedAt: "1777000000",
							updatedAt: 1777000100,
						},
					],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySettlementSections()).resolves.toEqual([
			{
				key: "1",
				uuid: "movie-section-uuid",
				title: "Movies",
				type: "movie",
				agent: "tv.plex.agents.movie",
				refreshing: false,
				scannedAt: 1_777_000_000,
				updatedAt: 1_777_000_100,
			},
		]);
	});

	it("preserves an uninitialized section scannedAt as unavailable live state", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				response({
					size: 1,
					Directory: [
						{
							key: "6",
							uuid: "new-movie-section-uuid",
							title: "New Movies",
							type: "movie",
							refreshing: "1",
							updatedAt: 1_777_000_100,
						},
					],
				}),
			),
		);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySettlementSections()).resolves.toEqual([
			{
				key: "6",
				uuid: "new-movie-section-uuid",
				title: "New Movies",
				type: "movie",
				refreshing: true,
				scannedAt: null,
				updatedAt: 1_777_000_100,
			},
		]);
	});

	it("sends the Plex metadata type and locks a tag field before editing it", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await client.updateMetadataTags("123", "movie", "label", "add", "Family");

		const url = new URL(fetchMock.mock.calls[0]?.[0] as string);
		expect(url.pathname).toBe("/library/metadata/123");
		expect(url.searchParams.get("type")).toBe("1");
		expect(url.searchParams.get("label.locked")).toBe("1");
		expect(url.searchParams.get("label[0].tag.tag")).toBe("Family");
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "PUT" });
	});

	it("logs only a coarse category when a metadata-tag write is rejected", async () => {
		const ratingKey = "CANARY_RATING_KEY_787";
		const label = "CANARY_LABEL_787";
		const token = "CANARY_TOKEN_787";
		const fetchMock = vi.fn().mockResolvedValueOnce(
			new Response("CANARY_RESPONSE_BODY_787", {
				status: 422,
				statusText: "CANARY_STATUS_TEXT_787",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("https://CANARY_HOST_787.invalid", token, log);

		let thrown: unknown;
		try {
			await client.updateMetadataTags(ratingKey, "movie", "label", "add", label);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(PlexRequestError);
		expect(thrown).toMatchObject({
			name: "PlexRequestError",
			code: "plex_request_failed",
			responseCategory: "client_error",
			message: "Plex API request failed",
		});
		expect(thrown).not.toHaveProperty("cause");

		expect(warn).toHaveBeenCalledWith(
			{ operation: "plex_api_request", responseCategory: "client_error" },
			"Plex API request failed",
		);
		const serialized = JSON.stringify({
			logs: warn.mock.calls,
			error: thrown,
			inspection:
				thrown instanceof Error
					? Object.fromEntries(
							Object.getOwnPropertyNames(thrown).map((key) => [
								key,
								(thrown as unknown as Record<string, unknown>)[key],
							]),
						)
					: thrown,
		});
		for (const canary of [
			ratingKey,
			label,
			token,
			"CANARY_HOST_787.invalid",
			"CANARY_RESPONSE_BODY_787",
			"CANARY_STATUS_TEXT_787",
		]) {
			expect(serialized).not.toContain(canary);
		}
	});

	it("preserves a non-label caller's rejection contract with sanitized logging", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				new Response("CANARY_NON_LABEL_BODY_787", {
					status: 503,
					statusText: "CANARY_NON_LABEL_STATUS_787",
				}),
			),
		);
		const client = new PlexClient(
			"https://CANARY_NON_LABEL_HOST_787.invalid",
			"CANARY_NON_LABEL_TOKEN_787",
			log,
		);

		let thrown: unknown;
		try {
			await client.getActivities();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(PlexRequestError);
		expect(thrown).toMatchObject({
			code: "plex_request_failed",
			responseCategory: "server_error",
			message: "Plex API request failed",
		});
		expect(warn).toHaveBeenCalledWith(
			{ operation: "plex_api_request", responseCategory: "server_error" },
			"Plex API request failed",
		);
		const serialized = JSON.stringify({
			logs: warn.mock.calls,
			error: thrown,
			text: String(thrown),
		});
		for (const canary of [
			"/activities",
			"CANARY_NON_LABEL_BODY_787",
			"CANARY_NON_LABEL_STATUS_787",
			"CANARY_NON_LABEL_HOST_787.invalid",
			"CANARY_NON_LABEL_TOKEN_787",
		]) {
			expect(serialized).not.toContain(canary);
		}
	});

	it("preserves another ordinary Plex read's non-OK rejection contract", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValueOnce(
				new Response("CANARY_SECTIONS_BODY_787", {
					status: 401,
					statusText: "CANARY_SECTIONS_STATUS_787",
				}),
			),
		);
		const client = new PlexClient(
			"https://CANARY_SECTIONS_HOST_787.invalid",
			"CANARY_SECTIONS_TOKEN_787",
			log,
		);

		let thrown: unknown;
		try {
			await client.getLibrarySections();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(PlexRequestError);
		expect(thrown).toMatchObject({
			code: "plex_request_failed",
			responseCategory: "client_error",
			message: "Plex API request failed",
		});
		expect(warn).toHaveBeenCalledWith(
			{ operation: "plex_api_request", responseCategory: "client_error" },
			"Plex API request failed",
		);
		const serialized = JSON.stringify({
			logs: warn.mock.calls,
			error: thrown,
			text: String(thrown),
		});
		for (const canary of [
			"/library/sections",
			"CANARY_SECTIONS_BODY_787",
			"CANARY_SECTIONS_STATUS_787",
			"CANARY_SECTIONS_HOST_787.invalid",
			"CANARY_SECTIONS_TOKEN_787",
		]) {
			expect(serialized).not.toContain(canary);
		}
	});

	it.each([
		["TimeoutError", "timeout"],
		["TypeError", "unavailable"],
	] as const)("bounds a %s transport failure", async (name, responseCategory) => {
		const providerError = Object.assign(
			new Error(
				"CANARY_TRANSPORT_ERROR_787 https://CANARY_TRANSPORT_HOST_787.invalid/?token=CANARY_TRANSPORT_TOKEN_787",
			),
			{ name },
		);
		vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(providerError));
		const client = new PlexClient(
			"https://CANARY_TRANSPORT_HOST_787.invalid",
			"CANARY_TRANSPORT_TOKEN_787",
			log,
		);

		let thrown: unknown;
		try {
			await client.getActivities();
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(PlexRequestError);
		expect(thrown).toMatchObject({
			code: "plex_request_failed",
			responseCategory,
			message: "Plex API request failed",
		});
		expect(warn).toHaveBeenCalledWith(
			{ operation: "plex_api_request", responseCategory },
			"Plex API request failed",
		);
		const serialized = JSON.stringify({
			logs: warn.mock.calls,
			error: thrown,
			text: String(thrown),
		});
		for (const canary of [
			"CANARY_TRANSPORT_ERROR_787",
			"CANARY_TRANSPORT_HOST_787.invalid",
			"CANARY_TRANSPORT_TOKEN_787",
		]) {
			expect(serialized).not.toContain(canary);
		}
	});

	it("loads a complete bounded activity inventory", async () => {
		const fetchMock = vi.fn().mockResolvedValueOnce(
			response({
				size: 2,
				Activity: [
					{ type: "library.update.section", Context: { librarySectionID: 1 } },
					{ type: "media.generate.bif" },
				],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getActivities()).resolves.toEqual([
			{ type: "library.update.section", Context: { librarySectionID: "1" } },
			{ type: "media.generate.bif" },
		]);
		expect(new URL(fetchMock.mock.calls[0]?.[0] as string).pathname).toBe("/activities");
	});

	it("fails closed when the activity inventory is malformed or incomplete", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ size: 1, Activity: [{ Context: {} }] }))
			.mockResolvedValueOnce(response({ size: 2, Activity: [{ type: "media.generate.bif" }] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getActivities()).rejects.toThrow();
		await expect(client.getActivities()).rejects.toThrow(/complete single-page/i);
	});

	it("shares only simultaneous ordinary activity reads and never completed results", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => response({ size: 0, Activity: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		const [first, second] = await Promise.all([client.getActivities(), client.getActivities()]);
		expect(first).toEqual([]);
		expect(second).toEqual([]);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await client.getActivities();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not coalesce uncached mutation probes", async () => {
		const fetchMock = vi.fn().mockImplementation(async () => response({ size: 0, Activity: [] }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await Promise.all([
			client.getActivities({ uncached: true }),
			client.getActivities({ uncached: true }),
		]);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects inconsistent optional pagination metadata on sections and accounts", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ size: 1, offset: 1, Directory: [{ key: "1", type: "movie" }] }),
			)
			.mockResolvedValueOnce(
				response({ size: 1, totalSize: 2, Account: [{ id: 1, name: "Admin" }] }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getLibrarySections()).rejects.toThrow(/complete single-page/i);
		await expect(client.getAccounts()).rejects.toThrow(/complete single-page/i);
	});

	it("paginates allLeaves and rejects duplicate episode coordinates", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => ({
			ratingKey: `episode-${index + 1}`,
			title: `Episode ${index + 1}`,
			parentIndex: 1,
			index: index + 1,
		}));
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({ offset: 0, size: 200, totalSize: 201, Metadata: firstPage }),
			)
			.mockResolvedValueOnce(
				response({
					offset: 200,
					size: 1,
					totalSize: 201,
					Metadata: [{ ratingKey: "episode-201", title: "Duplicate", parentIndex: 1, index: 200 }],
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new PlexClient("http://plex.test", "token", log);

		await expect(client.getEpisodes("show-1")).rejects.toThrow(/duplicate episode coordinate/i);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects duplicate rating keys and truncated allLeaves pages", async () => {
		const client = new PlexClient("http://plex.test", "token", log);
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response({
						offset: 0,
						size: 1,
						totalSize: 2,
						Metadata: [{ ratingKey: "episode-1", parentIndex: 1, index: 1 }],
					}),
				)
				.mockResolvedValueOnce(
					response({
						offset: 1,
						size: 1,
						totalSize: 2,
						Metadata: [{ ratingKey: "episode-1", parentIndex: 1, index: 2 }],
					}),
				),
		);
		await expect(client.getEpisodes("show-1")).rejects.toThrow(/duplicate item/i);

		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response({
						offset: 0,
						size: 1,
						totalSize: 2,
						Metadata: [{ ratingKey: "episode-1", parentIndex: 1, index: 1 }],
					}),
				)
				.mockResolvedValueOnce(response({ offset: 1, size: 0, totalSize: 2, Metadata: [] })),
		);
		await expect(client.getEpisodes("show-1")).rejects.toThrow(/stopped before/i);
	});
});
