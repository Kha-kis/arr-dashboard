import type { ProviderNativeInventoryResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useProviderNativeInventory } from "../useProviderNativeInventory";

const response: ProviderNativeInventoryResponse = {
	status: "available",
	generationId: "synthetic-generation",
	observedAt: "2026-11-10T12:00:00.000Z",
	itemCount: 0,
	scopeCount: 1,
	lastAttemptAt: "2026-11-10T12:00:00.000Z",
	lastAttemptResult: "success",
	lastAttemptReason: null,
	freshness: "current",
	complete: true,
	rows: [],
	nextNativeId: null,
};

const clients: QueryClient[] = [];

function fixture() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	clients.push(client);
	const requests: {
		path: string;
		signal: AbortSignal | null | undefined;
		complete: () => void;
	}[] = [];
	vi.stubGlobal(
		"fetch",
		(path: string, options?: RequestInit) =>
			new Promise<Response>((resolve, reject) => {
				const signal = options?.signal;
				const abort = () => reject(new DOMException("Aborted", "AbortError"));
				const complete = () => {
					signal?.removeEventListener("abort", abort);
					resolve(Response.json(response));
				};
				requests.push({ path, signal, complete });
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			}),
	);
	function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	}
	return { requests, Wrapper };
}

afterEach(() => {
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

describe("native inventory read cancellation", () => {
	it("cancels abandoned source/domain reads and starts a fresh request when returning", async () => {
		const { requests, Wrapper } = fixture();
		const { result, rerender } = renderHook(
			(props: { instanceId: string; domain: "library" | "episode" }) =>
				useProviderNativeInventory(props),
			{
				initialProps: { instanceId: "synthetic-first", domain: "library" as "library" | "episode" },
				wrapper: Wrapper,
			},
		);
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(requests[0]!.signal?.aborted).toBe(false);

		rerender({ instanceId: "synthetic-second", domain: "library" });
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(requests[0]!.signal?.aborted).toBe(true);
		expect(requests[1]!.signal?.aborted).toBe(false);

		rerender({ instanceId: "synthetic-second", domain: "episode" });
		await waitFor(() => expect(requests).toHaveLength(3));
		expect(requests[1]!.signal?.aborted).toBe(true);
		expect(requests[2]!.path).toBe(
			"/api/library/provider-inventory?instanceId=synthetic-second&domain=episode&limit=100",
		);
		await act(async () => requests[2]!.complete());
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
		expect(result.current.data).toEqual(response);

		rerender({ instanceId: "synthetic-first", domain: "library" });
		await waitFor(() => expect(requests).toHaveLength(4));
		expect(result.current.isError).toBe(false);
		expect(result.current.data).toBeUndefined();
		expect(requests[3]!.signal?.aborted).toBe(false);
		await act(async () => requests[3]!.complete());
		await waitFor(() => expect(result.current.isSuccess).toBe(true));
	});

	it("keeps a shared read until its last consumer unmounts", async () => {
		const { requests, Wrapper } = fixture();
		const useInventoryPage = () =>
			useProviderNativeInventory({ instanceId: "synthetic-first", domain: "episode" });
		const first = renderHook(useInventoryPage, { wrapper: Wrapper });
		const second = renderHook(useInventoryPage, { wrapper: Wrapper });
		await waitFor(() => expect(requests).toHaveLength(1));
		first.unmount();
		expect(requests[0]!.signal?.aborted).toBe(false);
		second.unmount();
		expect(requests[0]!.signal?.aborted).toBe(true);
	});
});
