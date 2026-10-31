import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useLabelSyncRules } from "../useLabelSync";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it("updates persisted recovery during an open view without user refresh or provider mutation", async () => {
	vi.useFakeTimers();
	let observed = false;
	vi.stubGlobal("fetch", async (url: string, options: RequestInit) => {
		if (url !== "/api/label-sync/rules" || options.method !== "GET")
			throw new Error("Unexpected synthetic request");
		return new Response(
			JSON.stringify({
				rules: [
					{
						id: "synthetic",
						recovery: observed
							? {
									availability: "known",
									state: "reconciled",
									heldCount: 0,
									reconciledCount: 1,
									lastCheckAt: "2026-10-07T12:00:00.000Z",
								}
							: {
									availability: "known",
									state: "restored-held",
									heldCount: 1,
									reconciledCount: 0,
									lastCheckAt: null,
								},
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	});
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const { result, unmount } = renderHook(() => useLabelSyncRules(), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	try {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1);
		});
		expect(result.current.data?.[0]?.recovery).toMatchObject({
			availability: "known",
			state: "restored-held",
		});
		observed = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(29_000);
		});
		expect(result.current.data?.[0]?.recovery).toMatchObject({
			availability: "known",
			state: "restored-held",
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1_010);
		});
		expect(result.current.data?.[0]?.recovery).toEqual({
			availability: "known",
			state: "reconciled",
			heldCount: 0,
			reconciledCount: 1,
			lastCheckAt: "2026-10-07T12:00:00.000Z",
		});
	} finally {
		unmount();
		client.clear();
	}
});
