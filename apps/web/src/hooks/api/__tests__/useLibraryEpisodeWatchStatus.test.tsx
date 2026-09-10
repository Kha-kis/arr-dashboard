import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useLibraryEpisodeWatchStatus } from "../useLibraryEpisodeWatchStatus";

const clients = vi.hoisted(() => ({ plex: vi.fn(), jellyfin: vi.fn() }));
vi.mock("../../../lib/api-client/plex", async (original) => ({
	...(await original<typeof import("../../../lib/api-client/plex")>()),
	fetchEpisodeWatchStatus: clients.plex,
}));
vi.mock("../../../lib/api-client/jellyfin", async (original) => ({
	...(await original<typeof import("../../../lib/api-client/jellyfin")>()),
	fetchJellyfinEpisodeWatchStatus: clients.jellyfin,
}));
const episode = {
	seasonNumber: 1,
	episodeNumber: 2,
	title: "Synthetic episode",
	watched: true,
	watchedByUsers: [],
	lastWatchedAt: null,
};
const queryClients: QueryClient[] = [];
function wrapper() {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	queryClients.push(client);
	return function Provider({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
	};
}
afterEach(() => {
	cleanup();
	queryClients.splice(0).forEach((client) => {
		client.clear();
	});
	vi.resetAllMocks();
});
describe("Library native episode source selection", () => {
	it.each(["plex", "jellyfin"] as const)(
		"queries only the selected %s source",
		async (provider) => {
			clients[provider].mockResolvedValue({ episodes: [episode], showTmdbId: 42 });
			const other = provider === "plex" ? "jellyfin" : "plex";
			clients[other].mockRejectedValue(new Error("must not query unrelated provider"));
			const { result } = renderHook(
				() => useLibraryEpisodeWatchStatus("native-instance", 42, provider),
				{ wrapper: wrapper() },
			);
			await waitFor(() => expect(result.current.episodes).toEqual([episode]));
			expect(clients[provider]).toHaveBeenCalledWith("native-instance", 42);
			expect(clients[other]).not.toHaveBeenCalled();
		},
	);
	it("retains Jellyfin partial status and does not fall back to Plex on failure", async () => {
		const providerStatus = { availability: "partial", sources: [] };
		clients.jellyfin.mockResolvedValueOnce({ episodes: [episode], providerStatus });
		const { result, rerender } = renderHook(
			({ id }) => useLibraryEpisodeWatchStatus(id, 42, "jellyfin"),
			{ wrapper: wrapper(), initialProps: { id: "first" } },
		);
		await waitFor(() => expect(result.current.providerStatus).toEqual(providerStatus));
		clients.jellyfin.mockRejectedValueOnce(new Error("native unavailable"));
		rerender({ id: "second" });
		await waitFor(() => expect(result.current.error).toBeTruthy());
		expect(result.current.episodes).toBeUndefined();
		expect(clients.plex).not.toHaveBeenCalled();
	});
	it("does not query episode status for a missing series or instance", () => {
		renderHook(() => useLibraryEpisodeWatchStatus(undefined, undefined, "jellyfin"), {
			wrapper: wrapper(),
		});
		expect(clients.plex).not.toHaveBeenCalled();
		expect(clients.jellyfin).not.toHaveBeenCalled();
	});
});
