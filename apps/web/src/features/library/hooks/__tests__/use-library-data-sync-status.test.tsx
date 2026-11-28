import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { libraryQuery, syncStatusQuery } = vi.hoisted(() => ({
	libraryQuery: vi.fn(),
	syncStatusQuery: vi.fn(),
}));

vi.mock("../../../../hooks/api/useLibrary", () => ({
	useLibraryQuery: libraryQuery,
	useLibrarySyncStatus: syncStatusQuery,
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
	torrentStateFilter: "all" as const,
	sortBy: "sortTitle" as const,
	sortOrder: "asc" as const,
	page: 1,
	pageSize: 50,
};

describe("Library sync status projection", () => {
	beforeEach(() => {
		libraryQuery.mockReset().mockReturnValue({
			data: {
				items: [],
				syncStatus: {
					isCached: true,
					lastSync: "2026-09-27T20:00:00Z",
					syncInProgress: true,
					totalCachedItems: 1559,
				},
			},
			isLoading: false,
			isError: false,
			dataUpdatedAt: 100,
		});
		syncStatusQuery.mockReset().mockReturnValue({
			data: {
				instances: [
					{ syncStatus: { syncInProgress: false, lastError: "private provider detail" } },
				],
			},
			isError: false,
			dataUpdatedAt: 200,
		});
	});

	it("lets the newer per-instance status end a stale library spinner", () => {
		const { result } = renderHook(() => useLibraryData(params));

		expect(result.current.isSyncing).toBe(false);
		expect(result.current.hasSyncError).toBe(true);
	});

	it("retains a genuine active sync reported by the per-instance status", () => {
		syncStatusQuery.mockReturnValue({
			data: { instances: [{ syncStatus: { syncInProgress: true, lastError: null } }] },
			isError: false,
			dataUpdatedAt: 200,
		});

		const { result } = renderHook(() => useLibraryData(params));

		expect(result.current.isSyncing).toBe(true);
		expect(result.current.hasSyncError).toBe(false);
	});

	it("honors a newer active library response over an older idle status response", () => {
		libraryQuery.mockReturnValue({
			data: {
				items: [],
				syncStatus: {
					isCached: true,
					lastSync: "2026-09-27T20:00:00Z",
					syncInProgress: true,
					totalCachedItems: 1559,
				},
			},
			isLoading: false,
			isError: false,
			dataUpdatedAt: 300,
		});

		const { result } = renderHook(() => useLibraryData(params));

		expect(result.current.isSyncing).toBe(true);
	});
});
