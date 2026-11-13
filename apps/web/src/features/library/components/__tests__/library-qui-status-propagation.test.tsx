import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryClient } from "../library-client";
let client: QueryClient;
afterEach(async () => {
	cleanup();
	await client?.cancelQueries();
	client?.clear();
	vi.unstubAllGlobals();
	localStorage.clear();
	window.history.replaceState({}, "", "/");
});
describe("LibraryClient qUI status propagation and effective selection", () => {
	it("reconciles unavailable qUI selections and URL once without a query loop or blocking useful Library", async () => {
		window.history.replaceState(
			{},
			"",
			"/library?torrentState=paused&service=radarr&quality=cutoff-unmet#library-items",
		);
		client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
		});
		const requests: Array<Record<string, string>> = [],
			unexpected: string[] = [];
		let unavailable = false;
		const json = (value: unknown) =>
			new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
		vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
			const url = new URL(input, "http://synthetic.invalid"),
				path = url.pathname;
			if (options?.method === "POST" && path === "/api/qui/library-seeding-summary")
				return json({ status: "not-configured", summaries: {} });
			if (options?.method && options.method !== "GET") {
				unexpected.push(options.method + " " + path);
				throw new Error("Unexpected mutation");
			}
			if (path === "/api/services")
				return json({
					services: [
						{ id: "arr", service: "RADARR", label: "Synthetic", enabled: true },
						{ id: "qui", service: "QUI", label: "Synthetic", enabled: true },
					],
				});
			if (path === "/api/library") {
				const query = Object.fromEntries(url.searchParams);
				requests.push(query);
				if (query.sortBy === "torrentRatio") unavailable = true;
				return json({
					items: [
						{
							id: 1,
							instanceId: "arr",
							instanceName: "Synthetic",
							service: "radarr",
							type: "movie",
							title: "Useful Library",
							monitored: false,
							torrentState: unavailable ? null : "paused",
							torrentRatio: unavailable ? null : 2,
						},
					],
					pagination: { page: 1, limit: 50, totalItems: 1, totalPages: 1 },
					appliedFilters: {
						torrentState: unavailable ? "all" : query.torrentState,
						sortBy: unavailable ? "sortTitle" : query.sortBy,
					},
					quiObservationStatus: {
						status: unavailable ? "unavailable" : "available",
						observedAt: unavailable ? null : "2026-10-25T10:00:00Z",
					},
					syncStatus: {
						isCached: true,
						lastSync: null,
						syncInProgress: false,
						totalCachedItems: 1,
					},
				});
			}
			if (path === "/api/library/sync/status") return json({ instances: [] });
			if (path === "/api/plex/identity") return json({ servers: [] });
			if (path === "/api/jellyfin/identity") return json([]);
			if (path === "/api/qui/tracker-icons") return json({ trackers: {} });
			if (path.startsWith("/api/library/insights/")) return json({ data: { items: [] } });
			if (path.endsWith("/watch-enrichment")) return json({ configured: false, items: {} });
			if (path.endsWith("/series-progress")) return json({ configured: false, progress: {} });
			unexpected.push(path);
			throw new Error("Unexpected fixture path " + path);
		});
		render(
			<QueryClientProvider client={client}>
				<SearchParamsContext.Provider
					value={new URLSearchParams("torrentState=paused&service=radarr")}
				>
					<ColorThemeProvider>
						<IncognitoProvider>
							<LibraryClient />
						</IncognitoProvider>
					</ColorThemeProvider>
				</SearchParamsContext.Provider>
			</QueryClientProvider>,
		);
		expect(await screen.findByLabelText("Torrent: Paused, ratio 2.00")).toBeInTheDocument();
		fireEvent.change(screen.getByRole("combobox", { name: "Sort By" }), {
			target: { value: "torrentRatio" },
		});
		expect(
			await screen.findByText(/Torrent status is unavailable until a complete qUI sync/),
		).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByRole("combobox", { name: "Torrent state" })).toHaveValue("all");
			expect(screen.getByRole("combobox", { name: "Sort By" })).toHaveValue("sortTitle");
		});
		expect(await screen.findByRole("button", { name: "Monitor" })).toBeEnabled();
		expect(screen.getByText("Useful Library")).toBeInTheDocument();
		expect(screen.queryByLabelText(/Torrent:/)).not.toBeInTheDocument();
		expect(new URL(window.location.href).searchParams.has("torrentState")).toBe(false);
		expect(new URL(window.location.href).searchParams.get("service")).toBe("radarr");
		expect(new URL(window.location.href).searchParams.get("quality")).toBe("cutoff-unmet");
		expect(window.location.hash).toBe("#library-items");
		await waitFor(() => {
			expect(requests.at(-1)?.torrentState ?? "all").toBe("all");
			expect(requests.at(-1)?.sortBy ?? "sortTitle").toBe("sortTitle");
		});
		const settled = requests.length;
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(requests).toHaveLength(settled);
		expect(requests.filter((query) => query.sortBy === "torrentRatio")).toHaveLength(1);
		expect(unexpected).toEqual([]);
	});
});
