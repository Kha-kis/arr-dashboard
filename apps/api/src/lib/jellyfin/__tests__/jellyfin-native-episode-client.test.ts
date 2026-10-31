import type { FastifyBaseLogger } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JellyfinClient } from "../jellyfin-client.js";
import { collectJellyfinNativeEpisodeInventory } from "../jellyfin-native-episode-inventory.js";

const log = { warn: vi.fn(), info: vi.fn() } as unknown as FastifyBaseLogger;

function response(body: Record<string, unknown>, startIndex = 0): Response {
	const payload = "StartIndex" in body ? body : { ...body, StartIndex: startIndex };
	return new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function episode(index: number, overrides: Record<string, unknown> = {}) {
	return {
		Id: `episode-${index}`,
		Name: `Episode ${index}`,
		Type: "Episode",
		SeriesId: "series-1",
		ParentIndexNumber: 1,
		IndexNumber: index,
		...overrides,
	};
}

function waitForAbort(_input: string | URL | Request, options?: RequestInit): Promise<Response> {
	return new Promise((_resolve, reject) => {
		const signal = options?.signal;
		if (!signal) return reject(new Error("request signal missing"));
		if (signal.aborted) return reject(signal.reason);
		signal.addEventListener("abort", () => reject(signal.reason), { once: true });
	});
}

describe("JellyfinClient native episode inventory", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("requests recursive Episode pages without watch or mapping fields", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(response({ Items: [episode(1)], TotalRecordCount: 1 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		const result = await client.getNativeEpisodeItemsWithCoverage("library/id");

		expect(result).toMatchObject({
			items: [
				{
					id: "episode-1",
					type: "Episode",
					name: "Episode 1",
					seriesId: "series-1",
					seasonNumber: 1,
					episodeNumber: 1,
				},
			],
			expectedRawCount: 1,
			rawObserved: 1,
			reason: null,
		});
		const requestUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
		expect(requestUrl.pathname).toBe("/Items");
		expect(requestUrl.searchParams.get("ParentId")).toBe("library/id");
		expect(requestUrl.searchParams.get("IncludeItemTypes")).toBe("Episode");
		expect(requestUrl.searchParams.get("Recursive")).toBe("true");
		expect(requestUrl.searchParams.get("CollapseBoxSetItems")).toBe("false");
		expect(requestUrl.searchParams.get("StartIndex")).toBe("0");
		expect(requestUrl.searchParams.get("Limit")).toBe("2000");
		expect(requestUrl.searchParams.get("EnableUserData")).toBe("false");
		expect(requestUrl.searchParams.get("EnableImages")).toBe("false");
		expect(requestUrl.searchParams.get("Fields")).toBeNull();
		expect(log.info).toHaveBeenCalledTimes(1);
		const [loggedFields] = vi.mocked(log.info).mock.calls[0]!;
		const fields = loggedFields as Record<string, unknown>;
		expect(Object.keys(fields).sort()).toEqual(
			["category", "elapsedMs", "page", "rows", "status"].sort(),
		);
		expect(fields).toMatchObject({
			category: "native-episode-page-timing",
			page: 1,
			rows: 1,
			status: "complete",
		});
		expect(fields.elapsedMs).toBeGreaterThanOrEqual(0);
	});

	it("paginates an empty native episode inventory as complete", async () => {
		const fetchMock = vi.fn().mockResolvedValue(response({ Items: [], TotalRecordCount: 0 }));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 0,
			rawObserved: 0,
			pagesAttempted: 1,
			pagesCompleted: 1,
			reason: null,
		});
	});

	it("advances the native episode cursor after a full 2000-row page", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				response({
					Items: Array.from({ length: 2000 }, (_, index) => episode(index + 1)),
					TotalRecordCount: 2001,
				}),
			)
			.mockResolvedValueOnce(response({ Items: [episode(2001)], TotalRecordCount: 2001 }, 2000));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			expectedRawCount: 2001,
			rawObserved: 2001,
			pagesAttempted: 2,
			pagesCompleted: 2,
			reason: null,
		});
		const cursors = fetchMock.mock.calls.map(([url]) =>
			new URL(String(url)).searchParams.get("StartIndex"),
		);
		expect(cursors).toEqual(["0", "2000"]);
	});

	it("discards partial native episode rows when the read budget expires", async () => {
		let clockMs = 0;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => clockMs);
		const fetchMock = vi.fn(async () => {
			clockMs = 1_001;
			return response({
				Items: Array.from({ length: 2000 }, (_, index) => episode(index + 1)),
				TotalRecordCount: 2001,
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
		try {
			await expect(
				client.getNativeEpisodeItemsWithCoverage("library", 1_000),
			).resolves.toMatchObject({
				items: [],
				reason: "page-failure",
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
		} finally {
			clock.mockRestore();
		}
	});

	it("caps an in-flight native episode request at its remaining budget", async () => {
		const fetchMock = vi.fn(waitForAbort);
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log, 500);
		const startedAt = performance.now();

		await expect(client.getNativeEpisodeItemsWithCoverage("library", 25)).resolves.toMatchObject({
			items: [],
			reason: "page-failure",
		});
		expect(performance.now() - startedAt).toBeLessThan(300);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("caps native folder discovery at its remaining budget", async () => {
		const fetchMock = vi.fn(waitForAbort);
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log, 500);
		const startedAt = performance.now();

		await expect(client.getNativeMediaFolders({ timeoutMs: 25 })).rejects.toThrow();
		expect(performance.now() - startedAt).toBeLessThan(300);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("retains native identity when optional metadata is malformed or absent", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				response({
					Items: [
						episode(1, {
							Name: 42,
							SeriesId: null,
							ParentIndexNumber: "unknown",
							IndexNumber: -1,
						}),
					],
					TotalRecordCount: 1,
				}),
			),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [
				{
					id: "episode-1",
					type: "Episode",
					name: "",
				},
			],
			reason: null,
		});
	});

	it("keeps failed native episode page timing free of response details", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(response({ Items: "private synthetic response", TotalRecordCount: 1 })),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			reason: "page-failure",
		});
		expect(log.info).toHaveBeenCalledTimes(1);
		const [loggedFields] = vi.mocked(log.info).mock.calls[0]!;
		const fields = loggedFields as Record<string, unknown>;
		expect(Object.keys(fields).sort()).toEqual(
			["category", "elapsedMs", "page", "rows", "status"].sort(),
		);
		expect(fields).toMatchObject({
			category: "native-episode-page-timing",
			page: 1,
			rows: 0,
			status: "failed",
		});
		expect(JSON.stringify(vi.mocked(log.info).mock.calls)).not.toContain(
			"private synthetic response",
		);
	});

	it("does not fail a native episode read when timing telemetry throws", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(response({ Items: [episode(1)], TotalRecordCount: 1 }));
		vi.stubGlobal("fetch", fetchMock);
		const brokenLog = {
			warn: vi.fn(),
			info: vi.fn(() => {
				throw new Error("timing logger unavailable");
			}),
		} as unknown as FastifyBaseLogger;
		const client = new JellyfinClient("http://jellyfin.test", "api-key", brokenLog);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			reason: null,
			rawObserved: 1,
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		["wrong type", episode(1, { Type: "Movie" })],
		["blank ID", episode(1, { Id: " " })],
		["duplicate IDs", [episode(1), episode(1)]],
	] as const)("rejects %s without exposing a partial inventory", async (_name, invalid) => {
		const items = Array.isArray(invalid) ? invalid : [invalid];
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => response({ Items: items, TotalRecordCount: items.length })),
		);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			reason: "page-failure",
		});
	});

	it("rejects cursor drift and total changes across pages", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: [episode(1)], TotalRecordCount: 2 }))
			.mockResolvedValueOnce(response({ Items: [episode(2)], TotalRecordCount: 3 }, 1))
			.mockResolvedValueOnce(response({ Items: [episode(1)], TotalRecordCount: 2 }))
			.mockResolvedValueOnce(response({ Items: [episode(2)], TotalRecordCount: 3 }, 1));
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 2,
			rawObserved: 1,
			reason: "page-failure",
		});
	});

	it("rejects a page whose reported cursor does not match the requested offset", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(response({ Items: [episode(1)], TotalRecordCount: 2 }))
			.mockResolvedValueOnce(
				response({ Items: [episode(2)], StartIndex: 0, TotalRecordCount: 2 }, 1),
			);
		vi.stubGlobal("fetch", fetchMock);
		const client = new JellyfinClient("http://jellyfin.test", "api-key", log);

		await expect(client.getNativeEpisodeItemsWithCoverage("library")).resolves.toMatchObject({
			items: [],
			expectedRawCount: 2,
			rawObserved: 1,
			reason: "page-failure",
		});
	});
	it.each(["timeout", "total drift", "duplicate window"])(
		"publishes complete collector evidence after recovering from a late-page %s",
		async (failure) => {
			const firstPage = Array.from({ length: 1000 }, (_, index) => episode(index + 1));
			let nativeRequests = 0;
			const cursors: number[] = [];
			const fetchMock = vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.pathname === "/Library/MediaFolders") {
					return response({
						Items: [{ Id: "library", Type: "CollectionFolder", CollectionType: "tvshows" }],
						TotalRecordCount: 1,
					});
				}
				expect(url.pathname).toBe("/Items");
				const cursor = Number(url.searchParams.get("StartIndex"));
				cursors.push(cursor);
				nativeRequests++;
				if (nativeRequests === 2) {
					if (failure === "timeout") throw new DOMException("request timed out", "TimeoutError");
					if (failure === "total drift")
						return response({ Items: [episode(1001)], TotalRecordCount: 1002 }, 1000);
					return response({ Items: [episode(1)], TotalRecordCount: 1001 }, 1000);
				}
				const items = cursor === 0 ? [...firstPage] : [episode(1001)];
				if (nativeRequests === 1 && failure !== "timeout") items[999] = episode(9999);
				return response({ Items: items, TotalRecordCount: 1001 }, cursor);
			});
			vi.stubGlobal("fetch", fetchMock);
			const client = new JellyfinClient("http://jellyfin.test", "api-key", log);
			const scopes = vi.spyOn(client, "getNativeEpisodeItemsWithCoverage");
			const result = await collectJellyfinNativeEpisodeInventory(client);
			expect(result.complete).toBe(true);
			if (!result.complete) throw new Error("recovered collector did not complete");
			expect(result.snapshots[0].rows).toHaveLength(1001);
			expect(result.snapshots[0].rows.some((row) => row.nativeId === "episode-9999")).toBe(false);
			expect(scopes).toHaveBeenCalledTimes(2);
			for (const call of scopes.mock.results) {
				expect(await call.value).toMatchObject({
					reason: null,
					pagesAttempted: 2,
					pagesCompleted: 2,
					rawObserved: 1001,
				});
			}
			expect(cursors).toEqual(
				failure === "timeout" ? [0, 1000, 1000, 0, 1000] : [0, 1000, 0, 1000, 0, 1000],
			);
		},
	);
});
