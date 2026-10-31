import type { LibraryItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SearchParamsContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { libraryKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { LibraryClient } from "../library-client";

// Real LibraryClient/dialog/query/hooks. Only read-only API responses are synthetic;
// no mutation is sent, so fresh-list behavior cannot be hidden by a monitor fix.
const selected: LibraryItem = {
	id: 41,
	instanceId: "sonarr-b",
	instanceName: "Synthetic instance",
	service: "sonarr",
	type: "series",
	title: "Synthetic same title",
	monitored: true,
	remoteIds: { tmdbId: 1041 },
	seasons: [{ seasonNumber: 2, monitored: true, episodeCount: 8, episodeFileCount: 3 }],
};
let items: LibraryItem[], client: QueryClient, calls: { path: string; method: string }[];
const response = (payload: unknown) =>
	new Response(JSON.stringify(payload), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
beforeEach(() => {
	localStorage.clear();
	items = [structuredClone(selected)];
	calls = [];
	client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
	});
	vi.stubGlobal("fetch", async (input: string, options?: RequestInit) => {
		const url = new URL(input, "http://synthetic.invalid"),
			p = url.pathname,
			method = options?.method ?? "GET";
		calls.push({ path: p, method });
		if (p === "/api/services")
			return response({
				services: [
					{ id: "sonarr-b", service: "sonarr", enabled: true, label: "Synthetic instance" },
					{
						id: "synthetic-seerr",
						service: "seerr",
						enabled: true,
						isDefault: true,
						label: "Synthetic enrichment",
					},
				],
			});
		if (p === "/api/library")
			return response({
				items,
				pagination: { page: 1, limit: 50, totalItems: items.length, totalPages: 1 },
				syncStatus: { isCached: true, syncInProgress: false, totalCachedItems: items.length },
			});
		if (p === "/api/library/by-tmdb/1041") return response({ item: selected });
		if (p === "/api/library/sync/status") return response({ instances: [] });
		if (p === "/api/plex/identity") return response({ servers: [] });
		if (p === "/api/jellyfin/identity") return response([]);
		if (p === "/api/qui/tracker-icons") return response({ trackers: {} });
		if (p === "/api/qui/library-seeding-summary")
			return response({ status: "not-configured", summaries: {} });
		if (p.startsWith("/api/library/insights/"))
			return response({ data: { items: [], unknownItems: [] } });
		if (p.endsWith("/watch-enrichment")) return response({ configured: false, items: {} });
		if (p.endsWith("/series-progress")) return response({ configured: false, progress: {} });
		if (p === "/api/seerr/library-enrichment/synthetic-seerr")
			return response({ items: {}, issueCountsAvailable: true });
		if (p === "/api/seerr/discover/synthetic-seerr/tv/1041")
			return response({
				id: 1041,
				name: "Synthetic same title",
				seasons: [],
				genres: [],
				credits: { cast: [], crew: [] },
				recommendations: { results: [] },
				similar: { results: [] },
			});
		if (/^\/api\/qui\/(series|movie)\//.test(p))
			return response({
				status: "not-configured",
				clusters: [],
				seasonGroups: [],
				actionItems: [],
				totalEpisodes: 0,
				monitoredEpisodes: 0,
				downloadedEpisodes: 0,
			});
		throw Error(`Unexpected read-only fixture request: ${method} ${p}`);
	});
});
afterEach(async () => {
	cleanup();
	await client.cancelQueries();
	client.clear();
	vi.unstubAllGlobals();
});
function mount(deepLink = false) {
	return render(
		<QueryClientProvider client={client}>
			<SearchParamsContext.Provider value={new URLSearchParams(deepLink ? "tmdbId=1041" : "")}>
				<ColorThemeProvider>
					<IncognitoProvider>
						<LibraryClient />
					</IncognitoProvider>
				</ColorThemeProvider>
			</SearchParamsContext.Provider>
		</QueryClientProvider>,
	);
}
async function open() {
	mount();
	await screen.findByRole("button", { name: "Synthetic same title" });
	fireEvent.click(screen.getByRole("button", { name: "Details" }));
	return seasonRow();
}
async function seasonRow() {
	const dialog = await screen.findByRole("dialog"),
		season = await within(dialog).findByRole("button", { name: /Season 2/ });
	return season.parentElement!.parentElement!.parentElement!;
}
async function refresh(next: LibraryItem[]) {
	items = next;
	await act(async () => {
		await client.invalidateQueries({ queryKey: libraryKeys.all });
	});
}
describe("open selected Library detail freshness", () => {
	it("reflects independent fresh-list unmonitor and monitor without closing the detail", async () => {
		const row = await open();
		expect(within(row).getByRole("button", { name: /^Unmonitor$/ })).toBeEnabled();
		await refresh([
			{
				...selected,
				seasons: [{ seasonNumber: 2, monitored: false, episodeCount: 8, episodeFileCount: 3 }],
			},
		]);
		expect(await within(row).findByRole("button", { name: /^Monitor$/ })).toBeEnabled();
		await refresh([structuredClone(selected)]);
		expect(await within(row).findByRole("button", { name: /^Unmonitor$/ })).toBeEnabled();
		expect(calls.filter((c) => c.path.startsWith("/api/library/") && c.method !== "GET")).toEqual(
			[],
		);
	});
	it.each([
		{ instanceId: "sonarr-a" },
		{ service: "radarr" as const, type: "movie" as const },
		{ id: 42 },
	])("never substitutes a same-title collision with $instanceId $service $id", async (mismatch) => {
		const row = await open(),
			other = { ...selected, ...mismatch, seasons: [{ seasonNumber: 2, monitored: false }] };
		await refresh([other]);
		expect(within(row).getByRole("button", { name: /^Unmonitor$/ })).toBeEnabled();
		await refresh([other, { ...selected, seasons: [{ seasonNumber: 2, monitored: false }] }]);
		expect(await within(row).findByRole("button", { name: /^Monitor$/ })).toBeEnabled();
	});
	it("retains the selected off-page snapshot when the current list no longer contains it", async () => {
		const row = await open();
		await refresh([]);
		expect(within(row).getByRole("button", { name: /^Unmonitor$/ })).toBeEnabled();
	});
	it("preserves a deep-linked off-page selection until its exact fresh item is available", async () => {
		items = [];
		mount(true);
		const row = await seasonRow();
		expect(within(row).getByRole("button", { name: /^Unmonitor$/ })).toBeEnabled();
		await refresh([{ ...selected, seasons: [{ seasonNumber: 2, monitored: false }] }]);
		expect(await within(row).findByRole("button", { name: /^Monitor$/ })).toBeEnabled();
	});
});
