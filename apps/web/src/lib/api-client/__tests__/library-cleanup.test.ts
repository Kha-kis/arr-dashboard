import type { CleanupExplainResponse } from "@arr/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { libraryCleanupApi } from "../library-cleanup";

const explainResponse: CleanupExplainResponse = {
	item: {
		title: "Signal Harbor",
		year: 2026,
		instanceId: "sonarr-main",
		itemType: "series",
		targetScope: "episode",
		arrEpisodeId: 9001,
		seasonNumber: 1,
		episodeNumber: 2,
		episodeTitle: "First Light",
	},
	results: [],
	retentionProtected: false,
};

function mockExplainResponse() {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response(JSON.stringify(explainResponse), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		}),
	);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("libraryCleanupApi.explain", () => {
	it("serializes arrEpisodeId for an exact episode request", async () => {
		const fetchMock = mockExplainResponse();

		await libraryCleanupApi.explain({
			instanceId: "sonarr-main",
			arrItemId: 42,
			arrEpisodeId: 9001,
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/library-cleanup/explain",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					instanceId: "sonarr-main",
					arrItemId: 42,
					arrEpisodeId: 9001,
				}),
			}),
		);
	});

	it("keeps the series request body unchanged", async () => {
		const fetchMock = mockExplainResponse();

		await libraryCleanupApi.explain({ instanceId: "sonarr-main", arrItemId: 42 });

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/library-cleanup/explain",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ instanceId: "sonarr-main", arrItemId: 42 }),
			}),
		);
	});
});

describe("libraryCleanupApi activity", () => {
	it("requests a bounded page of action timelines", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ items: [], total: 0, page: 2, pageSize: 25 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await libraryCleanupApi.getActivity(2, 25);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/library-cleanup/activity?page=2&pageSize=25",
			expect.objectContaining({ method: "GET", credentials: "include" }),
		);
	});

	it("encodes the action id and durable older-event cursor", async () => {
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ items: [], olderEventsCursor: null }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await libraryCleanupApi.getActivityEvents("approval/one", "251", 100);

		expect(fetchMock).toHaveBeenCalledWith(
			"/api/library-cleanup/activity/approval%2Fone/events?cursor=251&pageSize=100",
			expect.objectContaining({ method: "GET", credentials: "include" }),
		);
	});
});
