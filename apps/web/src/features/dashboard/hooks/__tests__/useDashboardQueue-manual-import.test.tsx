import type { QueueItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authKeys } from "../../../../lib/query-keys";
import { useDashboardQueue } from "../useDashboardQueue";

const item = { instanceId: "instance", downloadId: "source", service: "radarr" } as QueueItem;
afterEach(() => vi.unstubAllGlobals());
function show(owner: string | null) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	client.setQueryData(authKeys.currentUser, owner ? { id: owner, username: "Synthetic" } : null);
	const requests: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			requests.push(url);
			return new Response(JSON.stringify({ candidates: [], total: 0 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	const hook = renderHook(() => useDashboardQueue(), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	return { ...hook, client, requests };
}
describe("Dashboard owned Manual Import prefetch", () => {
	it("retains every distinct selected source without submitting and deduplicates canonical torrent hashes only within a connection", () => {
		const view = show("owner");
		const first = { ...item, instanceName: "Synthetic", downloadId: "A".repeat(40) };
		act(() =>
			view.result.current.openManualImports([
				first,
				{ ...first, id: 2, downloadId: "a".repeat(40) },
				{ ...first, instanceId: "other" },
				{ ...first, downloadId: "UsenetSource" },
				{ ...first, downloadId: "usenetsource" },
			]),
		);
		expect(view.result.current.manualImportContext.sources).toHaveLength(4);
		expect(view.result.current.manualImportContext.sources[0]?.downloadId).toBe("A".repeat(40));
		expect(view.result.current.manualImportContext.open).toBe(true);
		expect(view.requests).toHaveLength(0);
	});
	it("rejects the whole selection when one source is missing rather than silently dropping it", () => {
		const view = show("owner");
		act(() => view.result.current.openManualImports([item, { ...item, downloadId: undefined }]));
		expect(view.result.current.manualImportContext.open).toBe(false);
		expect(view.result.current.queueActionsError?.message).toMatch(/selected.*source/i);
		expect(view.requests).toHaveLength(0);
	});
	it("does not open a source review without a known owner", () => {
		const view = show(null);
		act(() => view.result.current.openManualImports([item]));
		expect(view.result.current.manualImportContext.open).toBe(false);
		expect(view.result.current.queueActionsError?.message).toMatch(/sign in/i);
	});
	it("prefetches into the owner-scoped modal candidate cache without duplicate hover reads", async () => {
		const view = show("owner");
		act(() => view.result.current.prefetchManualImport(item));
		const key = [
			"manual-import",
			"candidates",
			"owner",
			{
				instanceId: "instance",
				service: "radarr",
				downloadId: "source",
				filterExistingFiles: true,
			},
		];
		await waitFor(() =>
			expect(view.client.getQueryData(key)).toEqual({ candidates: [], total: 0 }),
		);
		act(() => view.result.current.prefetchManualImport(item));
		expect(view.requests).toHaveLength(1);
		expect(
			view.client.getQueryData(["manual-import", "candidates", "other", key[3]]),
		).toBeUndefined();
	});
	it("does not prefetch when current owner identity is unavailable", async () => {
		const view = show(null);
		act(() => view.result.current.prefetchManualImport(item));
		await act(async () => {
			await Promise.resolve();
		});
		expect(view.requests).toHaveLength(0);
	});
});
