import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../../lib/api-client/qui";
import { useQuiCapabilities, useQuiCategories, useQuiTags } from "../useQui";

vi.mock("../../../lib/api-client/qui");
const clients: QueryClient[] = [];
const payload = {
	categories: { categories: [{ name: "Synthetic category", savePath: "/synthetic" }] },
	tags: { tags: ["synthetic-tag"] },
	capabilities: {
		capabilities: {
			supportsTorrentCreation: true,
			supportsTorrentExport: true,
			supportsSetTags: true,
			supportsTrackerHealth: true,
			supportsTrackerEditing: true,
			supportsRenameTorrent: true,
			supportsRenameFile: true,
			supportsRenameFolder: true,
			supportsFilePriority: true,
			supportsSubcategories: true,
			subcategoriesAlwaysEnabled: false,
			supportsTorrentTmpPath: false,
			supportsPathAutocomplete: true,
			supportsFreeSpacePathSource: true,
			supportsSetRSSFeedURL: false,
			supportsShareLimitsAction: true,
			supportsShareLimitsMode: true,
		},
	},
};
const fetchers = {
	categories: api.fetchQuiCategories,
	tags: api.fetchQuiTags,
	capabilities: api.fetchQuiCapabilities,
};
const args = { quiInstanceId: "qui-1", qbitInstanceId: 0 };
function mount() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity } },
	});
	clients.push(client);
	return renderHook(
		() => ({
			categories: useQuiCategories(args),
			tags: useQuiTags(args),
			capabilities: useQuiCapabilities(args),
		}),
		{
			wrapper: ({ children }: { children: ReactNode }) => (
				<QueryClientProvider client={client}>{children}</QueryClientProvider>
			),
		},
	);
}
beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(api.fetchQuiCategories).mockResolvedValue(payload.categories);
	vi.mocked(api.fetchQuiTags).mockResolvedValue(payload.tags);
	vi.mocked(api.fetchQuiCapabilities).mockResolvedValue(payload.capabilities);
	vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network forbidden in fixture")));
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(fetch).not.toHaveBeenCalled();
	vi.unstubAllGlobals();
});

describe.each(["categories", "tags", "capabilities"] as const)("qUI %s read recovery", (kind) => {
	it("preserves cold failure as unavailable and recovers through explicit refetch", async () => {
		const failure = new Error("Synthetic unavailable response");
		vi.mocked(fetchers[kind]).mockRejectedValueOnce(failure);
		const { result } = mount();
		await waitFor(() => expect(result.current[kind].isError).toBe(true));
		expect(result.current[kind].data).toBeUndefined();
		expect(result.current[kind].error).toBe(failure);
		expect(fetchers[kind]).toHaveBeenCalledTimes(1);
		expect(fetchers[kind]).toHaveBeenCalledWith(args);
		await act(async () => {
			await result.current[kind].refetch();
		});
		await waitFor(() => expect(result.current[kind].isSuccess).toBe(true));
		expect(result.current[kind].data).toEqual(payload[kind]);
		expect(result.current[kind].error).toBeNull();
		expect(fetchers[kind]).toHaveBeenCalledTimes(2);
	});

	it("retains last-known data through a failed refresh, then clears the error after recovery", async () => {
		const { result } = mount();
		await waitFor(() => expect(result.current[kind].isSuccess).toBe(true));
		vi.mocked(fetchers[kind]).mockRejectedValueOnce(new Error("Synthetic refresh failure"));
		await act(async () => {
			await result.current[kind].refetch();
		});
		await waitFor(() => expect(result.current[kind].isError).toBe(true));
		expect(result.current[kind].data).toEqual(payload[kind]);
		expect(result.current[kind].isSuccess).toBe(false);
		expect(fetchers[kind]).toHaveBeenCalledTimes(2);
		await act(async () => {
			await result.current[kind].refetch();
		});
		await waitFor(() => expect(result.current[kind].isSuccess).toBe(true));
		expect(result.current[kind].data).toEqual(payload[kind]);
		expect(result.current[kind].error).toBeNull();
		expect(fetchers[kind]).toHaveBeenCalledTimes(3);
		expect(api.postQuiTorrentAction).not.toHaveBeenCalled();
	});
});
