import { afterEach, describe, expect, it, vi } from "vitest";

import { UnauthorizedError } from "../base";
import {
	fetchSearchIndexerDetails,
	fetchSearchIndexers,
	performManualSearch,
	updateSearchIndexer,
} from "../search";

describe("Search API authorization", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("propagates unauthorized indexer and search reads instead of returning empty data", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
		for (const read of [
			() => fetchSearchIndexers(),
			() => fetchSearchIndexerDetails("p-1", 1),
			() => performManualSearch({ query: "synthetic", type: "all" }),
		]) {
			await expect(read()).rejects.toBeInstanceOf(UnauthorizedError);
		}
	});

	it("sends only explicit indexer changes to the URL-selected target", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ status: "applied-unverified" }), {
				status: 202,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		await expect(updateSearchIndexer("owned-instance", 7, { enable: false })).resolves.toEqual({
			status: "applied-unverified",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/search/indexers/owned-instance/7",
			expect.objectContaining({
				method: "PUT",
				body: JSON.stringify({ changes: { enable: false } }),
			}),
		);
	});
});
