import { describe, expect, it, vi } from "vitest";
import { createPlexNativeJobAdapter } from "../plex-native-inventory.js";

function section(scannedAt = 10) {
	return {
		key: "shows",
		uuid: "uuid-shows",
		title: "Synthetic",
		type: "show",
		refreshing: false,
		scannedAt,
		updatedAt: 10,
	};
}

describe("Plex durable paired native adapter", () => {
	it("probes settled catalog and maps both domains without watch dependencies", async () => {
		const getActivities = vi.fn().mockResolvedValue([]);
		const getLibrarySettlementSections = vi.fn().mockResolvedValue([section()]);
		const readNativeInventoryPage = vi
			.fn()
			.mockResolvedValueOnce({
				status: "page",
				domain: "library",
				startIndex: 0,
				totalRecordCount: 2,
				items: [
					{ ratingKey: "show-1", type: "show", title: "Synthetic", externalIds: { tvdb: [101] } },
					{ ratingKey: "collection-1", type: "collection", title: "Synthetic" },
				],
			})
			.mockResolvedValueOnce({
				status: "page",
				domain: "episode",
				startIndex: 0,
				totalRecordCount: 1,
				items: [
					{
						ratingKey: "episode-1",
						type: "episode",
						title: "Synthetic",
						grandparentRatingKey: null,
						seasonNumber: null,
						episodeNumber: null,
					},
				],
			});
		const adapter = createPlexNativeJobAdapter({
			getActivities,
			getLibrarySettlementSections,
			readNativeInventoryPage,
		});
		const deadlineAt = Date.now() + 5_000;
		const discovery = await adapter.discoverScopes(deadlineAt);
		expect(discovery).toMatchObject({
			status: "ready",
			scopes: [
				{ domain: "library", scopeKey: '["shows","uuid-shows","show"]' },
				{ domain: "episode", scopeKey: '["shows","uuid-shows","show"]' },
			],
		});
		if (discovery.status !== "ready") return;
		expect(await adapter.readPage(discovery.scopes[0]!, 0, 2, deadlineAt)).toMatchObject({
			status: "page",
			domain: "library",
			rawNativeIds: ["show-1", "collection-1"],
			comparisonKeys: ['["show"]', null],
			rows: [{ nativeId: "show-1", mediaType: "series" }],
		});
		expect(await adapter.readPage(discovery.scopes[1]!, 0, 2, deadlineAt)).toMatchObject({
			status: "page",
			domain: "episode",
			rawNativeIds: ["episode-1"],
			rows: [
				{ nativeId: "episode-1", parentNativeId: null, seasonNumber: null, episodeNumber: null },
			],
		});
		expect(getActivities).toHaveBeenCalledWith({ uncached: true, timeoutMs: expect.any(Number) });
	});

	it("rejects a changed or unsettled catalog before reading pages", async () => {
		const getActivities = vi.fn().mockResolvedValue([]);
		const getLibrarySettlementSections = vi
			.fn()
			.mockResolvedValueOnce([section(10)])
			.mockResolvedValueOnce([section(11)])
			.mockResolvedValueOnce([{ ...section(11), refreshing: true }]);
		const readNativeInventoryPage = vi.fn();
		const adapter = createPlexNativeJobAdapter({
			getActivities,
			getLibrarySettlementSections,
			readNativeInventoryPage,
		});
		const deadlineAt = Date.now() + 5_000;
		const first = await adapter.discoverScopes(deadlineAt);
		const second = await adapter.discoverScopes(deadlineAt);
		expect(first).toMatchObject({ status: "ready" });
		expect(second).toMatchObject({ status: "ready" });
		if (first.status !== "ready" || second.status !== "ready") return;
		expect(first.catalogIdentity).not.toBe(second.catalogIdentity);
		expect(await adapter.discoverScopes(deadlineAt)).toEqual({
			status: "unavailable",
			reason: "coverage-incomplete",
		});
		expect(readNativeInventoryPage).not.toHaveBeenCalled();
	});
});
