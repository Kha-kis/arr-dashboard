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
