import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../../../hooks/api/useLibrary", () => ({
	useLibraryQuery: query,
	useLibrarySyncStatus: () => ({ data: { instances: [] }, isError: false, dataUpdatedAt: 1 }),
}));
vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [] }),
}));
import { useLibraryData } from "../use-library-data";
const params = {
	serviceFilter: "all" as const,
	instanceFilter: "all",
	searchTerm: "",
	statusFilter: "all" as const,
	fileFilter: "all" as const,
	qualityFilter: "all" as const,
	torrentStateFilter: "paused" as const,
	sortBy: "torrentRatio" as const,
	sortOrder: "desc" as const,
	page: 1,
	pageSize: 50,
};
describe("Library data qUI metadata", () => {
	it("propagates explicit qUI status and normalized server filters separately from Library sync", () => {
		query.mockReturnValue({
			data: {
				items: [],
				quiObservationStatus: { status: "unavailable", observedAt: null },
				appliedFilters: { torrentState: "all", sortBy: "sortTitle" },
				syncStatus: { isCached: true, lastSync: null, syncInProgress: false, totalCachedItems: 5 },
			},
			isLoading: false,
			isError: false,
			dataUpdatedAt: 1,
		});
		const { result } = renderHook(() => useLibraryData(params));
		expect(result.current.quiObservationStatus).toEqual({
			status: "unavailable",
			observedAt: null,
		});
		expect(result.current.appliedFilters).toMatchObject({
			torrentState: "all",
			sortBy: "sortTitle",
		});
		expect(result.current.isLoading).toBe(false);
		expect(result.current.isError).toBe(false);
		expect(result.current.isSyncing).toBe(false);
	});
});
