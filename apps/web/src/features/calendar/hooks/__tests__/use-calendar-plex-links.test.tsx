import type { PlexEvidenceSummary, WatchEnrichmentItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeduplicatedCalendarItem } from "../use-calendar-data";
import { useCalendarPlexLinks } from "../use-calendar-plex-links";

const currentEvidence: PlexEvidenceSummary = {
	availability: "current",
	authority: "authoritative",
	attemptState: "success",
	publicationLevel: "authoritative",
	completeness: "complete",
	reasonCodes: [],
};
const positive: WatchEnrichmentItem = {
	lastWatchedAt: null,
	watchCount: null,
	watchCountSemantics: "unknown",
	watchedByUsers: [],
	onDeck: null,
	userRating: null,
	source: "plex",
	ratingKey: "movie-key",
	instanceId: "plex-north",
	collections: [],
	labels: [],
};
const movieUrl =
	"https://app.plex.tv/desktop/#!/server/synthetic-machine/details?key=%2Flibrary%2Fmetadata%2Fmovie-key";
const seriesUrl =
	"https://app.plex.tv/desktop/#!/server/synthetic-machine/details?key=%2Flibrary%2Fmetadata%2Fseries-key";
const item = (
	tmdbId: number | null | undefined,
	service: DeduplicatedCalendarItem["service"] = "radarr",
): DeduplicatedCalendarItem => ({
	id: 31,
	title: "Synthetic schedule",
	service,
	type: service === "sonarr" ? "episode" : "movie",
	// Exercise null metadata at runtime despite the optional-number static contract.
	tmdbId: tmdbId as number | undefined,
	airDate: "2026-10-19",
	instanceId: "arr-north",
	instanceName: "Synthetic ARR",
	allInstances: [{ instanceId: "arr-north", instanceName: "Synthetic ARR" }],
});
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
let emitted: Array<{ ids: string; types: string }>;
let identityReads: number;
const clients: QueryClient[] = [];
function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={clients[clients.length - 1]!}>{children}</QueryClientProvider>
	);
}
beforeEach(() => {
	emitted = [];
	identityReads = 0;
	clients.push(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(String(input), "http://synthetic.invalid");
		if (url.pathname === "/api/plex/identity") {
			identityReads++;
			return json({
				servers: [
					{
						instanceId: "plex-north",
						instanceName: "Synthetic Plex",
						machineId: "synthetic-machine",
						version: "synthetic",
						friendlyName: "Synthetic",
						platform: "synthetic",
					},
				],
			});
		}
		if (url.pathname === "/api/plex/watch-enrichment") {
			const ids = url.searchParams.get("tmdbIds")!;
			const types = url.searchParams.get("types")!;
			emitted.push({ ids, types });
			const tokens = ids.split(",").map(Number);
			if (tokens.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
				return json({ error: "All tmdbIds must be positive integers" }, 400);
			}
			const items: Record<string, WatchEnrichmentItem> = {};
			for (const [index, type] of types.split(",").entries()) {
				items[`${type}:${tokens[index]}`] = { ...positive, ratingKey: `${type}-key` };
			}
			return json({ items, evidence: currentEvidence });
		}
		throw new Error("Unexpected synthetic read");
	});
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.restoreAllMocks();
});

describe("Calendar Plex target admission through the real API client", () => {
	it("keeps valid movie and series links when a nonpositive target would reject the batch", async () => {
		const events = [item(42), item(0), item(42, "sonarr"), item(42)];
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(emitted).toHaveLength(1));
		expect(emitted).toEqual([{ ids: "42,42", types: "movie,series" }]);
		await waitFor(() => expect(result.current.plexUrlMap.get("movie:42")).toBe(movieUrl));
		expect(result.current.plexUrlMap.get("series:42")).toBe(seriesUrl);
		expect(result.current.plexUrlMap.size).toBe(2);
		expect(result.current.error).toBeNull();
		expect(result.current.invalidLinkItemCount).toBe(1);
		expect(emitted).toEqual([{ ids: "42,42", types: "movie,series" }]);
		expect(events).toHaveLength(4);
	});
	it.each([
		0,
		-1,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
		1.5,
		Number.MAX_SAFE_INTEGER + 1,
		null,
		undefined,
	])("counts invalid metadata %s per eligible item and never sends it", async (invalid) => {
		const events = [
			item(42),
			item(invalid),
			item(invalid),
			item(invalid, "sonarr"),
			item(invalid, "lidarr"),
		];
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(result.current.plexUrlMap.get("movie:42")).toBe(movieUrl));
		expect(result.current.invalidLinkItemCount).toBe(3);
		expect(emitted).toEqual([{ ids: "42", types: "movie" }]);
	});
	it("retains the largest positive safe-integer target", async () => {
		const events = [item(Number.MAX_SAFE_INTEGER)];
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() =>
			expect(result.current.plexUrlMap.get("movie:9007199254740991")).toBe(movieUrl),
		);
		expect(result.current.invalidLinkItemCount).toBe(0);
		expect(emitted).toEqual([{ ids: "9007199254740991", types: "movie" }]);
	});
	it("sends no enrichment request for only invalid or unsupported events", async () => {
		const events = [item(0), item(null), item(8, "lidarr")];
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(identityReads).toBe(1));
		expect(result.current.invalidLinkItemCount).toBe(2);
		expect(result.current.plexUrlMap.size).toBe(0);
		expect(emitted).toEqual([]);
	});
	it("has no Plex requests or invalid-item warning when Plex is absent", () => {
		const { result } = renderHook(() => useCalendarPlexLinks([item(42), item(0)], false), {
			wrapper,
		});
		expect(result.current.invalidLinkItemCount).toBe(0);
		expect(result.current.plexUrlMap.size).toBe(0);
		expect(emitted).toEqual([]);
		expect(identityReads).toBe(0);
	});
	it("updates lookup and clears the derived count after metadata repair", async () => {
		const { result, rerender } = renderHook(({ events }) => useCalendarPlexLinks(events, true), {
			initialProps: { events: [item(0)] },
			wrapper,
		});
		expect(result.current.invalidLinkItemCount).toBe(1);
		rerender({ events: [item(42)] });
		await waitFor(() => expect(result.current.plexUrlMap.get("movie:42")).toBe(movieUrl));
		expect(result.current.invalidLinkItemCount).toBe(0);
		expect(emitted).toEqual([{ ids: "42", types: "movie" }]);
	});
	it("retains the valid query when only invalid metadata or duplicate tuples change", async () => {
		const { result, rerender } = renderHook(({ events }) => useCalendarPlexLinks(events, true), {
			initialProps: { events: [item(42), item(0)] },
			wrapper,
		});
		await waitFor(() => expect(result.current.plexUrlMap.get("movie:42")).toBe(movieUrl));
		rerender({ events: [item(42), item(42), item(null), item(-1)] });
		expect(result.current.invalidLinkItemCount).toBe(2);
		expect(result.current.plexUrlMap.get("movie:42")).toBe(movieUrl);
		expect(emitted).toEqual([{ ids: "42", types: "movie" }]);
	});
});
