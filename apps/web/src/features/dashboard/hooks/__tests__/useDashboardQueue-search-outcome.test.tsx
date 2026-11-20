import type { QueueItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useDashboardQueue } from "../useDashboardQueue";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
it("keeps partial-search feedback through import success timer and unrelated action until explicit dismissal", async () => {
	vi.useFakeTimers();
	const client = new QueryClient({
		defaultOptions: { queries: { gcTime: Infinity }, mutations: { gcTime: Infinity } },
	});
	const value = {
		id: 11,
		instanceId: "radarr",
		instanceName: "Synthetic",
		service: "radarr",
		movieId: 101,
	} as QueueItem;
	let partial = true;
	vi.stubGlobal("fetch", async () =>
		partial
			? Response.json({ removal: "completed", search: "unconfirmed" })
			: new Response(null, { status: 204 }),
	);
	const view = renderHook(() => useDashboardQueue(), {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	await act(async () => {
		await view.result.current.handleQueueRemove([value], { search: true });
	});
	expect(view.result.current.queueSearchWarning).toBe("unconfirmed");
	act(() => view.result.current.handleManualImportCompleted({ imported: 1 }));
	await act(async () => {
		vi.advanceTimersByTime(6100);
	});
	expect(view.result.current.queueMessage).toBeNull();
	expect(view.result.current.queueSearchWarning).toBe("unconfirmed");
	partial = false;
	await act(async () => {
		await view.result.current.handleQueueRemove([value]);
	});
	expect(view.result.current.queueSearchWarning).toBe("unconfirmed");
	act(() => view.result.current.clearQueueSearchWarning());
	expect(view.result.current.queueSearchWarning).toBeNull();
	view.unmount();
	client.clear();
});
