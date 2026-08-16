import type { CleanupExplainResponse, PaginatedCleanupAuditTimelines } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/api-client/library-cleanup", () => ({
	libraryCleanupApi: {
		explain: vi.fn(),
		execute: vi.fn(),
		getActivity: vi.fn(),
		getActivityEvents: vi.fn(),
	},
}));

import { libraryCleanupApi } from "../../../lib/api-client/library-cleanup";
import { libraryCleanupKeys } from "../../../lib/query-keys";
import {
	useCleanupActivity,
	useCleanupActivityEvents,
	useCleanupExecute,
	useCleanupExplain,
} from "../useLibraryCleanup";

function createWrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

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

describe("useCleanupExplain", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("forwards the exact episode identity to the API client", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		vi.mocked(libraryCleanupApi.explain).mockResolvedValue(explainResponse);
		const request = {
			instanceId: "sonarr-main",
			arrItemId: 42,
			arrEpisodeId: 9001,
		};

		const { result } = renderHook(() => useCleanupExplain(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate(request);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(libraryCleanupApi.explain).toHaveBeenCalledWith(request);
		client.clear();
	});
});

describe("cleanup activity hooks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("loads a bounded action-history page", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		const response: PaginatedCleanupAuditTimelines = {
			items: [],
			total: 0,
			page: 2,
			pageSize: 25,
		};
		vi.mocked(libraryCleanupApi.getActivity).mockResolvedValue(response);

		const { result } = renderHook(() => useCleanupActivity(2, 25), {
			wrapper: createWrapper(client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(libraryCleanupApi.getActivity).toHaveBeenCalledWith(2, 25);
		client.clear();
	});

	it("starts older-event pagination from the durable database cursor", async () => {
		const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		vi.mocked(libraryCleanupApi.getActivityEvents).mockResolvedValue({
			items: [],
			olderEventsCursor: null,
		});

		const { result } = renderHook(() => useCleanupActivityEvents("approval-1", "251", 100), {
			wrapper: createWrapper(client),
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(libraryCleanupApi.getActivityEvents).toHaveBeenCalledWith("approval-1", "251", 100);
		client.clear();
	});

	it("invalidates action history after a cleanup execution", async () => {
		const client = new QueryClient({
			defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
		});
		const invalidateQueries = vi.spyOn(client, "invalidateQueries");
		vi.mocked(libraryCleanupApi.execute).mockResolvedValue({
			isDryRun: false,
			status: "completed",
			itemsEvaluated: 1,
			itemsFlagged: 1,
			itemsRemoved: 1,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 1,
			itemsSkipped: 0,
			durationMs: 100,
		});

		const { result } = renderHook(() => useCleanupExecute(), {
			wrapper: createWrapper(client),
		});
		result.current.mutate();

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(invalidateQueries).toHaveBeenCalledWith({
			queryKey: libraryCleanupKeys.activityAll,
		});
		client.clear();
	});
});
