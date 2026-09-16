import type { ProviderNativeInventoryResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.hoisted(() => vi.fn());
vi.mock("../../../lib/api-client/base", () => ({ apiRequest }));

import { useProviderNativeInventory } from "../useProviderNativeInventory";

const response: ProviderNativeInventoryResponse = {
	status: "available",
	generationId: "generation-1",
	observedAt: "2026-09-14T12:00:00.000Z",
	itemCount: 1,
	scopeCount: 1,
	lastAttemptAt: "2026-09-14T12:00:00.000Z",
	lastAttemptResult: "success",
	lastAttemptReason: null,
	freshness: "current",
	complete: true,
	rows: [],
	nextNativeId: null,
};

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
}

afterEach(() => {
	apiRequest.mockReset();
});

describe("useProviderNativeInventory", () => {
	it("requests the first page and a refreshed first page with the correct boundary", async () => {
		apiRequest.mockResolvedValue(response);
		const { result, rerender } = renderHook(
			(props: { refreshKey: number }) =>
				useProviderNativeInventory({
					instanceId: "private-instance",
					domain: "library",
					refreshKey: props.refreshKey,
				}),
			{ initialProps: { refreshKey: 0 }, wrapper: createWrapper() },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(apiRequest).toHaveBeenCalledWith(
			"/api/library/provider-inventory?instanceId=private-instance&domain=library&limit=100",
		);

		rerender({ refreshKey: 1 });
		await waitFor(() => expect(apiRequest).toHaveBeenCalledTimes(2));
		expect(apiRequest).toHaveBeenLastCalledWith(
			"/api/library/provider-inventory?instanceId=private-instance&domain=library&limit=100",
		);
	});

	it("pins continuation pages to the supplied native cursor and generation", async () => {
		apiRequest.mockResolvedValue(response);
		const { result } = renderHook(
			() =>
				useProviderNativeInventory({
					instanceId: "private-instance",
					domain: "episode",
					afterNativeId: "native-100",
					expectedGenerationId: "generation-1",
				}),
			{ wrapper: createWrapper() },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(apiRequest).toHaveBeenCalledWith(
			"/api/library/provider-inventory?instanceId=private-instance&domain=episode&limit=100&afterNativeId=native-100&expectedGenerationId=generation-1",
		);
	});
});
