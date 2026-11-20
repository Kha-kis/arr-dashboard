import type { MultiInstanceQueueResponse, QueueItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUEUE_QUERY_KEY } from "../../../lib/query-keys";
import { useQueueActions } from "../useQueueActions";

afterEach(() => vi.unstubAllGlobals());
const item = {
	id: 7,
	instanceId: "instance",
	service: "radarr",
	downloadId: "source",
	status: "Ready",
	actions: { canRetry: true, canManualImport: true },
} as QueueItem;
function show() {
	const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
	const data = { instances: [], aggregated: [item], totalCount: 1 } as MultiInstanceQueueResponse;
	client.setQueryData(QUEUE_QUERY_KEY, data);
	const bodies: Record<string, unknown>[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, options?: RequestInit) => {
			bodies.push(JSON.parse(String(options?.body)));
			return new Response(null, { status: 204 });
		}),
	);
	const hook = renderHook(() => useQueueActions(), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	return { ...hook, client, data, bodies };
}
describe("Generic Queue actions exclude Manual Import", () => {
	it("rejects an unsupported runtime import without POST or optimistic success", async () => {
		const view = show();
		await act(async () => {
			await expect(
				view.result.current.executeAsync("manualImport" as never, [item]),
			).rejects.toThrow(/Manual Import review/i);
		});
		expect(view.bodies).toHaveLength(0);
		expect(view.client.getQueryData(QUEUE_QUERY_KEY)).toEqual(view.data);
	});
	it.each(["retry", "delete"] as const)("preserves %s and its options", async (action) => {
		const view = show();
		await act(async () => {
			await view.result.current.executeAsync(action, [item], {
				removeFromClient: false,
				blocklist: true,
				changeCategory: false,
				search: false,
			});
		});
		expect(view.bodies).toEqual([
			{
				instanceId: "instance",
				service: "radarr",
				itemId: 7,
				action,
				removeFromClient: false,
				blocklist: true,
				changeCategory: false,
				search: false,
			},
		]);
	});
});
