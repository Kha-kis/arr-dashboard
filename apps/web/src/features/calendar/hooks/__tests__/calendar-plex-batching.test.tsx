import type { PlexEvidenceSummary, WatchEnrichmentItem } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isCurrentAuthoritativePlexEvidence } from "../../../../lib/plex-evidence";
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
const partialEvidence: PlexEvidenceSummary = {
	availability: "last-known",
	authority: "unavailable",
	attemptState: "error",
	publicationLevel: "positive-only",
	completeness: "partial",
	reasonCodes: ["latest_attempt_failed"],
};
const positive: WatchEnrichmentItem = {
	lastWatchedAt: null,
	watchCount: null,
	watchCountSemantics: "unknown",
	watchedByUsers: [],
	onDeck: null,
	userRating: null,
	source: "plex",
	ratingKey: "synthetic-key",
	instanceId: "synthetic-plex",
	collections: [],
	labels: [],
};
const item = (
	tmdbId: number,
	service: "radarr" | "sonarr" = "radarr",
): DeduplicatedCalendarItem => ({
	id: tmdbId,
	title: "Synthetic schedule",
	service,
	type: service === "radarr" ? "movie" : "episode",
	tmdbId,
	airDate: "2026-10-19",
	instanceId: "synthetic-arr",
	instanceName: "Synthetic ARR",
	allInstances: [{ instanceId: "synthetic-arr", instanceName: "Synthetic ARR" }],
});
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const clients: QueryClient[] = [];
let requests: Array<{ ids: number[]; types: string[] }>;
let failedStarts: Set<number>;
let partialStarts: Set<number>;
let identityUnavailable: boolean;
let active: number;
let maximumActive: number;
let held: Map<number, Promise<void>>;
let release: Array<() => void>;
function wrapper({ children }: { children: ReactNode }) {
	return (
		<QueryClientProvider client={clients[clients.length - 1]!}>{children}</QueryClientProvider>
	);
}
beforeEach(() => {
	requests = [];
	failedStarts = new Set();
	partialStarts = new Set();
	identityUnavailable = false;
	active = 0;
	maximumActive = 0;
	held = new Map();
	release = [];
	clients.push(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
	vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = new URL(String(input), "http://synthetic.invalid");
		if (url.pathname === "/api/plex/identity") {
			if (identityUnavailable) return json({ error: "Synthetic identity unavailable" }, 503);
			return json({
				servers: [
					{
						instanceId: "synthetic-plex",
						instanceName: "Synthetic Plex",
						machineId: "synthetic-machine",
						version: "synthetic",
						friendlyName: "Synthetic",
						platform: "synthetic",
					},
				],
			});
		}
		if (url.pathname !== "/api/plex/watch-enrichment") throw new Error("Unexpected synthetic read");
		const ids = url.searchParams.get("tmdbIds")!.split(",").map(Number);
		const types = url.searchParams.get("types")!.split(",");
		requests.push({ ids, types });
		if (ids.length > 200) return json({ error: "Max 200 items per request" }, 400);
		if (ids.length !== types.length || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
			return json({ error: "Invalid targets" }, 400);
		}
		active++;
		maximumActive = Math.max(maximumActive, active);
		try {
			await held.get(ids[0]!);
			if (failedStarts.has(ids[0]!)) return json({ error: "Synthetic batch unavailable" }, 503);
			return json({
				items: Object.fromEntries(
					ids.map((id, index) => [
						`${types[index]}:${id}`,
						{ ...positive, ratingKey: `${types[index]}-${id}` },
					]),
				),
				evidence: partialStarts.has(ids[0]!) ? partialEvidence : currentEvidence,
			});
		} finally {
			active--;
		}
	});
});
afterEach(() => {
	for (const unblock of release) unblock();
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.restoreAllMocks();
});

describe("Calendar Plex batch capacity and recovery through real query/API code", () => {
	it.each([0, 1, 200, 201, 401])(
		"keeps every link for %s valid targets within the 200-target read contract",
		async (count) => {
			const events = Array.from({ length: count }, (_, index) => item(index + 1));
			const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
			await waitFor(() => expect(result.current.plexUrlMap.size).toBe(count));
			expect(requests.map((request) => request.ids.length)).toEqual(
				count === 401 ? [200, 200, 1] : count === 201 ? [200, 1] : count === 0 ? [] : [count],
			);
			expect(requests.flatMap((request) => request.ids)).toEqual(
				events.map((event) => event.tmdbId),
			);
			expect(result.current.error).toBeNull();
		},
	);
	it("serializes reads and does not discard a sibling when the middle batch fails", async () => {
		failedStarts.add(201);
		held.set(1, new Promise<void>((resolve) => release.push(resolve)));
		const events = Array.from({ length: 401 }, (_, index) => item(index + 1));
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(requests).toHaveLength(1));
		expect(active).toBe(1);
		await act(async () => release[0]!());
		await waitFor(() => expect(result.current.plexUrlMap.size).toBe(201));
		expect(result.current.plexUrlMap.has("movie:1")).toBe(true);
		expect(result.current.plexUrlMap.has("movie:201")).toBe(false);
		expect(result.current.plexUrlMap.has("movie:401")).toBe(true);
		expect(result.current.error).not.toBeNull();
		expect(isCurrentAuthoritativePlexEvidence(result.current.evidence)).toBe(false);
		expect(maximumActive).toBe(1);
	});
	it("continues to the next batch after the first fails and recovers by refetch", async () => {
		failedStarts.add(1);
		const events = Array.from({ length: 201 }, (_, index) => item(index + 1));
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(result.current.plexUrlMap.has("movie:201")).toBe(true));
		expect(result.current.plexUrlMap.size).toBe(1);
		expect(result.current.error).not.toBeNull();
		failedStarts.clear();
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(result.current.plexUrlMap.size).toBe(201));
		expect(result.current.error).toBeNull();
		expect(requests.every((request) => request.ids.length <= 200)).toBe(true);
	});
	it("retains last-known batch positives after failed refetch without claiming current authority", async () => {
		const events = Array.from({ length: 201 }, (_, index) => item(index + 1));
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(result.current.plexUrlMap.size).toBe(201));
		failedStarts.add(201);
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(result.current.error).not.toBeNull());
		expect(result.current.plexUrlMap.size).toBe(201);
		expect(isCurrentAuthoritativePlexEvidence(result.current.evidence)).toBe(false);
	});
	it("retains actual degraded evidence rather than promoting it from a healthy sibling", async () => {
		partialStarts.add(201);
		const events = Array.from({ length: 201 }, (_, index) => item(index + 1));
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(result.current.plexUrlMap.size).toBe(201));
		expect(result.current.evidence).toEqual(partialEvidence);
		expect(isCurrentAuthoritativePlexEvidence(result.current.evidence)).toBe(false);
	});
	it("retains cached degraded evidence when a later refetch fails without an evidence payload", async () => {
		partialStarts.add(201);
		const events = Array.from({ length: 201 }, (_, index) => item(index + 1));
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(result.current.plexUrlMap.size).toBe(201));
		expect(result.current.evidence).toEqual(partialEvidence);
		failedStarts.add(201);
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(result.current.error).not.toBeNull());
		expect(result.current.plexUrlMap.size).toBe(201);
		expect(result.current.evidence).toEqual(partialEvidence);
		expect(isCurrentAuthoritativePlexEvidence(result.current.evidence)).toBe(false);
	});
	it("keeps same-number movie and series identities separate across the batch boundary", async () => {
		const events = [
			...Array.from({ length: 200 }, (_, index) => item(index + 1)),
			item(1, "sonarr"),
			item(1),
			item(0),
		];
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(result.current.plexUrlMap.size).toBe(201));
		expect(requests.map((request) => request.ids.length)).toEqual([200, 1]);
		expect(requests[1]).toEqual({ ids: [1], types: ["series"] });
		expect(result.current.plexUrlMap.get("movie:1")).not.toBe(
			result.current.plexUrlMap.get("series:1"),
		);
		expect(result.current.invalidLinkItemCount).toBe(1);
	});
	it("drops old-selection links and cancels queued reads when targets change", async () => {
		held.set(1, new Promise<void>((resolve) => release.push(resolve)));
		const { result, rerender } = renderHook(({ events }) => useCalendarPlexLinks(events, true), {
			initialProps: { events: Array.from({ length: 401 }, (_, index) => item(index + 1)) },
			wrapper,
		});
		await waitFor(() => expect(requests).toHaveLength(1));
		rerender({ events: [item(9000)] });
		await act(async () => release[0]!());
		await waitFor(() => expect(result.current.plexUrlMap.has("movie:9000")).toBe(true));
		expect([...result.current.plexUrlMap.keys()]).toEqual(["movie:9000"]);
		expect(requests.map((request) => request.ids[0])).toEqual([1, 9000]);
		expect(maximumActive).toBe(1);
	});
	it("exposes identity failure and recovers links through the same refetch action", async () => {
		identityUnavailable = true;
		const events = [item(42)];
		const { result } = renderHook(() => useCalendarPlexLinks(events, true), { wrapper });
		await waitFor(() => expect(result.current.error).not.toBeNull());
		expect(result.current.plexUrlMap.size).toBe(0);
		identityUnavailable = false;
		await act(async () => {
			await result.current.refetch();
		});
		await waitFor(() => expect(result.current.plexUrlMap.has("movie:42")).toBe(true));
		expect(result.current.error).toBeNull();
	});
	it("clears cached identity errors and performs no reads after Plex is removed", async () => {
		identityUnavailable = true;
		const events = [item(42)];
		const { result, rerender } = renderHook(
			({ enabled }) => useCalendarPlexLinks(events, enabled),
			{
				initialProps: { enabled: true },
				wrapper,
			},
		);
		await waitFor(() => expect(result.current.error).not.toBeNull());
		rerender({ enabled: false });
		expect(result.current.error).toBeNull();
		expect(result.current.plexUrlMap.size).toBe(0);
		const reads = requests.length;
		await act(async () => {
			await result.current.refetch();
		});
		expect(requests).toHaveLength(reads);
	});
});
