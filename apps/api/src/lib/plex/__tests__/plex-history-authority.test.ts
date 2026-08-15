import { afterEach, describe, expect, it, vi } from "vitest";
import { PlexClient } from "../plex-client.js";

const log = { warn: vi.fn() } as never;

function response(MediaContainer: Record<string, unknown>): Response {
	return new Response(JSON.stringify({ MediaContainer }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function historyItem(index: number) {
	return {
		historyKey: `/status/sessions/history/${index}`,
		ratingKey: `movie-${index}`,
		title: `Movie ${index}`,
		type: "movie",
		viewedAt: 1_700_000_000 + index,
		accountID: 1,
	};
}

describe("PlexClient complete history authority", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.clearAllMocks();
	});

	it("uses the Plex-compatible single sort key while paging complete history", async () => {
		const history = Array.from({ length: 201 }, (_, index) => ({
			...historyItem(index),
			viewedAt: 1_700_000_000,
		}));
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

		await expect(
			new PlexClient("http://plex.test", "token", log).getHistory({
				maxResults: 100_000,
				requireComplete: true,
			}),
		).resolves.toHaveLength(201);
		for (const [input] of fetchMock.mock.calls) {
			const url = new URL(input instanceof Request ? input.url : input.toString());
			expect(url.searchParams.get("sort")).toBe("viewedAt:desc");
		}
	});

	it("rejects a declared history inventory larger than the safety cap", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					response({ offset: 0, size: 1, totalSize: 100_001, Metadata: [historyItem(1)] }),
				),
		);

		await expect(
			new PlexClient("http://plex.test", "token", log).getHistory({
				maxResults: 100_000,
				requireComplete: true,
			}),
		).rejects.toThrow(/exceeding the safe 100000-row limit/i);
	});

	it("rejects a repeated page instead of publishing an incomplete inventory", async () => {
		const firstPage = Array.from({ length: 200 }, (_, index) => historyItem(index));
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(
					response({ offset: 0, size: 200, totalSize: 400, Metadata: firstPage }),
				)
				.mockResolvedValueOnce(
					response({ offset: 200, size: 200, totalSize: 400, Metadata: firstPage }),
				),
		);

		await expect(
			new PlexClient("http://plex.test", "token", log).getHistory({
				maxResults: 100_000,
				requireComplete: true,
			}),
		).rejects.toThrow(/duplicate row while paging/i);
	});

	it("rejects equal-count history churn before cache publication", async () => {
		const initial = Array.from({ length: 200 }, (_, index) => historyItem(index));
		const changed = [historyItem(999), ...initial.slice(0, 199)];
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
});
