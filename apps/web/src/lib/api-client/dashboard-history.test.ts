import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchMultiInstanceHistory } from "./dashboard";

const emptyHistoryResponse = {
	version: 2,
	instances: [],
	aggregated: [],
	totalCount: 0,
	pagination: {
		pageSize: 50,
		nextCursor: null,
		hasMore: false,
		incomplete: false,
		sortKey: "date",
		sortDirection: "ascending",
		budgetUsed: 0,
	},
};

describe("fetchMultiInstanceHistory", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("serializes the cursor and every server-owned History filter", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(JSON.stringify(emptyHistoryResponse), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await fetchMultiInstanceHistory({
			startDate: "2026-08-01",
			endDate: "2026-08-31",
			cursor: "opaque cursor",
			pageSize: 50,
			sortDirection: "ascending",
			service: "sonarr",
			instanceId: "instance-1",
			status: "grabbed",
			searchTerm: "release title",
			hideProwlarrRss: true,
		});

		const [requestUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
		const url = new URL(requestUrl, "http://arr.test");
		expect(url.pathname).toBe("/api/dashboard/history");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			startDate: "2026-08-01",
			endDate: "2026-08-31",
			cursor: "opaque cursor",
			pageSize: "50",
			sortDirection: "ascending",
			service: "sonarr",
			instanceId: "instance-1",
			status: "grabbed",
			searchTerm: "release title",
			hideProwlarrRss: "true",
		});
	});

	it("returns a versioned empty response after authentication loss", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 401 })));

		await expect(
			fetchMultiInstanceHistory({ pageSize: 100, sortDirection: "descending" }),
		).resolves.toEqual({
			version: 2,
			instances: [],
			aggregated: [],
			totalCount: 0,
			pagination: {
				pageSize: 100,
				nextCursor: null,
				hasMore: false,
				incomplete: false,
				sortKey: "date",
				sortDirection: "descending",
				budgetUsed: 0,
			},
		});
	});
});
