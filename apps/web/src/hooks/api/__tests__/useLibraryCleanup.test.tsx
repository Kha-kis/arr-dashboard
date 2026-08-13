import type { CleanupExplainResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/api-client/library-cleanup", () => ({
	libraryCleanupApi: {
		explain: vi.fn(),
	},
}));

import { libraryCleanupApi } from "../../../lib/api-client/library-cleanup";
import { useCleanupExplain } from "../useLibraryCleanup";

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
