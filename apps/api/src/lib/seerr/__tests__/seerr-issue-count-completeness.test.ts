import { afterEach, describe, expect, it, vi } from "vitest";
import { SeerrCache, issueCountCacheKey } from "../seerr-cache.js";
import { SeerrClient } from "../seerr-client.js";

describe("Seerr open issue count completeness", () => {
	const cache = new SeerrCache();
	afterEach(() => {
		cache.invalidateInstance("seerr-1");
		vi.restoreAllMocks();
	});

	it("rejects and does not cache a capped walk with an unseen issue page", async () => {
		const client = new SeerrClient(
			{} as ConstructorParameters<typeof SeerrClient>[0],
			{ id: "seerr-1" } as ConstructorParameters<typeof SeerrClient>[1],
			{} as ConstructorParameters<typeof SeerrClient>[2],
			undefined,
			cache,
		);
		const getIssues = vi.spyOn(client, "getIssues").mockImplementation(
			async ({ skip = 0 } = {}) =>
				({
					pageInfo: { pages: 6, pageSize: 100, results: 501, page: skip / 100 + 1 },
					results: Array.from({ length: 100 }, (_, index) => ({
						id: skip + index + 1,
						media: { tmdbId: 123, mediaType: "movie" },
					})),
				}) as Awaited<ReturnType<typeof client.getIssues>>,
		);

		await expect(client.getOpenIssueCounts()).rejects.toThrow(/pagination incomplete/);
		expect(getIssues).toHaveBeenCalledTimes(5);
		expect(cache.get(issueCountCacheKey("seerr-1"))).toBeUndefined();
	});
});
