import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/api-client/tautulli");

import * as tautulliApi from "../../../lib/api-client/tautulli";
import { tautulliKeys } from "../../../lib/query-keys";
import { useTautulliActivity, useTautulliCacheRefresh, useTautulliStats } from "../useTautulli";

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
	});
	return {
		queryClient,
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
	};
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("Tautulli hooks", () => {
	it("uses the provider-specific centralized activity key", async () => {
		vi.mocked(tautulliApi.fetchTautulliActivity).mockResolvedValue({
			provider: "tautulli",
			configured: false,
			sources: [],
		});
		const { wrapper, queryClient } = createWrapper();
		renderHook(() => useTautulliActivity(), { wrapper });
		await waitFor(() => expect(tautulliApi.fetchTautulliActivity).toHaveBeenCalledOnce());
		expect(queryClient.getQueryData(tautulliKeys.activity())).toBeDefined();
	});

	it("requests home statistics without the unused user enrichment fan-out", async () => {
		vi.mocked(tautulliApi.fetchTautulliStats).mockResolvedValue({
			provider: "tautulli",
			configured: false,
			sources: [],
			timeRange: 30,
		});
		const { wrapper } = createWrapper();
		renderHook(() => useTautulliStats(), { wrapper });

		await waitFor(() =>
			expect(tautulliApi.fetchTautulliStats).toHaveBeenCalledWith(30, { includeUserStats: false }),
		);
	});

	it("invalidates every Tautulli cache family after a manual refresh", async () => {
		vi.mocked(tautulliApi.refreshTautulliCache).mockResolvedValue({
			success: true,
			complete: true,
			superseded: false,
			upserted: 2,
			errors: 0,
		});
		const { wrapper, queryClient } = createWrapper();
		const invalidate = vi.spyOn(queryClient, "invalidateQueries");
		const { result } = renderHook(() => useTautulliCacheRefresh(), { wrapper });
		await act(async () => result.current.mutateAsync("tautulli-one"));
		expect(invalidate).toHaveBeenCalledWith({ queryKey: tautulliKeys.all });
	});
});
