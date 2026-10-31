import type { LibraryItem } from "@arr/shared";
import { onlineManager, type QueryClient, useQueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { RootProviders } from "../../../../providers/root-providers";
import { EnrichedDetailModal } from "../enriched-detail-modal";

// Real query, API, notices, and modal; only the external HTTP boundary is synthetic.
type Provider = "plex" | "jellyfin";
const item = {
	id: 1,
	type: "series",
	title: "Synthetic series",
	sortTitle: "Synthetic series",
	instanceId: "",
	instanceName: "Synthetic Sonarr",
	service: "sonarr",
	monitored: true,
	remoteIds: { tmdbId: 101 },
	seasons: [{ seasonNumber: 1, monitored: true, episodeCount: 12, episodeFileCount: 12 }],
} as unknown as LibraryItem;
const response = (status: number, payload: unknown) =>
	new Response(JSON.stringify(payload), {
		status,
		headers: { "content-type": "application/json" },
	});
const unavailable = () => response(503, { message: "Synthetic unavailable" });
const route = (provider: Provider, instance = "native", tmdb = 101) =>
	`/api/${provider}/episodes?instanceId=${instance}&showTmdbId=${tmdb}`;
const queryKey = (provider: Provider, instance = "native", tmdb = 101) =>
	(provider === "plex" ? plexKeys : jellyfinKeys).episodes(instance, tmdb);
function data(provider: Provider, count = 2, current = false) {
	return {
		showTmdbId: 101,
		episodes: Array.from({ length: count }, (_, index) => ({
			seasonNumber: 1,
			episodeNumber: index + 1,
			title: `Synthetic observed episode ${index + 1}`,
			watched: true,
			watchedByUsers: [],
			lastWatchedAt: null,
		})),
		...(provider === "plex"
			? {
					evidence: {
						availability: "current",
						publicationLevel: current ? "authoritative" : "positive-only",
						completeness: current ? "complete" : "partial",
						attemptState: "success",
						reasonCodes: [],
					},
				}
			: {
					providerStatus: {
						availability: current ? "current" : "partial",
						sources: [
							{
								instanceId: "native",
								service: "jellyfin",
								cacheType: "jellyfin_episode",
								status: {
									availability: current ? "current" : "partial",
									evidence: current ? "complete" : "positive-only",
									observedAt: "2026-10-15T00:00:00.000Z",
									ageSeconds: 0,
									latestAttempt: "successful",
									reasonCodes: current ? [] : ["coverage-incomplete"],
								},
							},
						],
					},
				}),
	};
}
let client: QueryClient;
let calls: { route: string; method: string }[];
let plans: Map<string, (() => Response | Promise<Response>)[]>;
function CaptureClient() {
	client = useQueryClient();
	return null;
}
function tree(provider: Provider, instance: string | undefined = "native", selectedItem = item) {
	return (
		<RootProviders>
			<CaptureClient />
			<EnrichedDetailModal
				item={selectedItem}
				seerrInstanceId=""
				onClose={() => {}}
				episodeProvider={provider}
				plexData={
					instance
						? { instanceId: instance, ratingKey: null, collections: [], labels: [] }
						: undefined
				}
			/>
		</RootProviders>
	);
}
async function tick(ms = 1) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1);
	});
}
const retry = () => screen.getByRole("button", { name: "Retry episode data" });
function assertRows(count = 2) {
	expect(screen.getByText(`(Observed watched episodes: ${count})`)).toBeInTheDocument();
	for (let index = 1; index <= count; index++) {
		expect(screen.getByText(`Synthetic observed episode ${index}`)).toBeInTheDocument();
	}
	expect(screen.queryByText(/\d+\/\d+ watched|unwatched|0 watched/i)).not.toBeInTheDocument();
}
function assertOnlyReads(provider: Provider, expected: number, instance = "native", tmdb = 101) {
	expect(
		calls.filter(
			(call) => call.route !== "/api/library/episodes?instanceId=&seriesId=1&seasonNumber=1",
		),
	).toEqual(
		Array.from({ length: expected }, () => ({
			route: route(provider, instance, tmdb),
			method: "GET",
		})),
	);
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-15T00:00:00.000Z"));
	onlineManager.setOnline(true);
	localStorage.clear();
	calls = [];
	plans = new Map();
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({ matches: false, addListener() {}, removeListener() {} })),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			calls.push({ route: input, method: init?.method ?? "GET" });
			if (input === "/api/library/episodes?instanceId=&seriesId=1&seasonNumber=1")
				return response(200, { episodes: [] });
			const plan = plans.get(input);
			if (!plan?.length) throw new Error(`Unexpected synthetic request: ${input}`);
			return plan.shift()!();
		}),
	);
});
afterEach(() => {
	cleanup();
	client?.clear();
	onlineManager.setOnline(true);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
describe.each(["plex", "jellyfin"] as const)("%s episode read recovery", (provider) => {
	it.each([
		{ phase: "before-click", retained: false },
		{ phase: "retry-backoff", retained: false },
		{ phase: "before-click", retained: true },
		{ phase: "retry-backoff", retained: true },
	] as const)(
		"preserves the notice and disables a paused retry $phase (retained rows: $retained)",
		async ({ phase, retained }) => {
			plans.set(route(provider), [
				...(retained ? [() => response(200, data(provider))] : []),
				unavailable,
				unavailable,
				...(phase === "retry-backoff" ? [unavailable] : []),
				() => response(200, data(provider, 3, true)),
			]);
			render(tree(provider));
			const query = client.getQueryCache().find({ queryKey: queryKey(provider), exact: true });
			expect(query?.options).toMatchObject({ retry: 1, staleTime: 300000 });
			await tick();
			if (retained) {
				fireEvent.click(screen.getByRole("button", { name: /Season 1/ }));
				await tick();
				assertRows();
				act(() => {
					void client.invalidateQueries({ queryKey: queryKey(provider), exact: true });
				});
				await tick();
			}
			await tick(1010);
			const exhaustedCalls = retained ? 3 : 2;
			expect(client.getQueryState(queryKey(provider))).toMatchObject({
				status: "error",
				fetchStatus: "idle",
			});
			expect(retry()).toBeEnabled();
			if (phase === "before-click") {
				act(() => {
					onlineManager.setOnline(false);
				});
				fireEvent.click(retry());
				await tick();
			} else {
				fireEvent.click(retry());
				await tick();
				expect(client.getQueryState(queryKey(provider))).toMatchObject({
					fetchStatus: "fetching",
					fetchFailureCount: 1,
				});
				act(() => {
					onlineManager.setOnline(false);
				});
				await tick(1010);
			}
			const pausedCalls = exhaustedCalls + (phase === "retry-backoff" ? 1 : 0);
			expect(client.getQueryState(queryKey(provider))).toMatchObject({ fetchStatus: "paused" });
			expect(screen.getByRole("status")).toBeInTheDocument();
			expect(retry()).toBeDisabled();
			expect(retry()).toHaveAttribute("aria-busy", "true");
			fireEvent.click(retry());
			await tick(30000);
			assertOnlyReads(provider, pausedCalls);
			expect(screen.getByRole("status")).toBeInTheDocument();
			expect(retry()).toBeDisabled();
			if (retained) assertRows();
			else
				expect(
					screen.queryByText(/Observed watched episodes|unwatched|0 watched/),
				).not.toBeInTheDocument();
			act(() => {
				onlineManager.setOnline(true);
			});
			await tick();
			expect(client.getQueryCache().find({ queryKey: queryKey(provider), exact: true })).toBe(
				query,
			);
			expect(client.getQueryState(queryKey(provider))).toMatchObject({
				status: "success",
				fetchStatus: "idle",
				error: null,
			});
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
			expect(screen.queryByRole("button", { name: "Retry episode data" })).not.toBeInTheDocument();
			if (!retained) {
				fireEvent.click(screen.getByRole("button", { name: /Season 1/ }));
				await tick();
			}
			assertRows(3);
			assertOnlyReads(provider, pausedCalls + 1);
		},
	);
	it("recovers an exhausted cold read on the same mounted query without duplicate pending reads", async () => {
		let resolve!: (value: Response) => void;
		plans.set(route(provider), [
			unavailable,
			unavailable,
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		]);
		render(tree(provider));
		const query = client.getQueryCache().find({ queryKey: queryKey(provider), exact: true });
		expect(query?.options).toMatchObject({ retry: 1, staleTime: 300000 });
		await tick();
		expect(screen.queryByRole("button", { name: "Retry episode data" })).not.toBeInTheDocument();
		await tick(1010);
		expect(client.getQueryState(queryKey(provider))).toMatchObject({
			status: "error",
			fetchStatus: "idle",
			data: undefined,
		});
		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(retry()).toBeEnabled();
		await tick(30 * 60_000);
		assertOnlyReads(provider, 2);
		act(() => {
			fireEvent.click(retry());
			fireEvent.click(retry());
		});
		await tick();
		expect(retry()).toBeDisabled();
		expect(screen.getByRole("status")).toBeInTheDocument();
		expect(
			screen.queryByText(/Observed watched episodes|unwatched|0 watched/),
		).not.toBeInTheDocument();
		assertOnlyReads(provider, 3);
		await act(async () => {
			resolve(response(200, data(provider, 3, true)));
		});
		await tick();
		expect(client.getQueryCache().find({ queryKey: queryKey(provider), exact: true })).toBe(query);
		expect(client.getQueryState(queryKey(provider))).toMatchObject({
			status: "success",
			error: null,
		});
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Retry episode data" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Season 1/ }));
		await tick();
		assertRows(3);
		assertOnlyReads(provider, 3);
	});
	it("retains observed rows and an honest notice through background error, retry failure, and recovery", async () => {
		plans.set(route(provider), [
			() => response(200, data(provider)),
			unavailable,
			unavailable,
			unavailable,
			unavailable,
			() => response(200, data(provider, 3, true)),
		]);
		render(tree(provider));
		await tick();
		expect(screen.queryByRole("button", { name: "Retry episode data" })).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: /Season 1/ }));
		await tick();
		assertRows();
		const retained = screen.getByText("Synthetic observed episode 1");
		act(() => {
			void client.invalidateQueries({ queryKey: queryKey(provider), exact: true });
		});
		await tick();
		await tick(1010);
		expect(retry()).toBeEnabled();
		assertRows();
		expect(screen.getByRole("status")).toHaveTextContent(
			provider === "plex" ? "omitted rows remain unknown" : "not presented as current",
		);
		act(() => {
			fireEvent.click(retry());
			fireEvent.click(retry());
		});
		await tick();
		expect(retry()).toBeDisabled();
		assertRows();
		expect(screen.getByText("Synthetic observed episode 1")).toBe(retained);
		expect(screen.getByRole("status")).toBeInTheDocument();
		await tick(1010);
		expect(retry()).toBeEnabled();
		assertRows();
		assertOnlyReads(provider, 5);
		fireEvent.click(retry());
		await tick();
		assertRows(3);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		assertOnlyReads(provider, 6);
	});
	it("does not expose retry or query for missing inputs or movies", async () => {
		const view = render(tree(provider, ""));
		await tick();
		expect(screen.queryByRole("button", { name: "Retry episode data" })).not.toBeInTheDocument();
		view.rerender(tree(provider, "native", { ...item, remoteIds: {} }));
		await tick();
		expect(screen.queryByRole("button", { name: "Retry episode data" })).not.toBeInTheDocument();
		view.rerender(tree(provider, "native", { ...item, type: "movie" }));
		await tick();
		expect(screen.queryByRole("button", { name: "Retry episode data" })).not.toBeInTheDocument();
		expect(calls).toEqual([]);
	});
	it.each(["provider", "instance", "series"] as const)(
		"isolates an in-flight retry when the %s changes",
		async (changed) => {
			let resolve!: (value: Response) => void;
			const other = changed === "provider" ? (provider === "plex" ? "jellyfin" : "plex") : provider;
			const instance = changed === "instance" ? "other" : "native";
			const tmdb = changed === "series" ? 202 : 101;
			plans.set(route(provider), [
				unavailable,
				unavailable,
				() =>
					new Promise((done) => {
						resolve = done;
					}),
			]);
			plans.set(route(other, instance, tmdb), [
				() => response(200, { ...data(other, 1, true), showTmdbId: tmdb }),
			]);
			const view = render(tree(provider));
			await tick();
			await tick(1010);
			fireEvent.click(retry());
			await tick();
			view.rerender(tree(other, instance, { ...item, remoteIds: { tmdbId: tmdb } }));
			await tick();
			expect(screen.queryByRole("button", { name: "Retry episode data" })).not.toBeInTheDocument();
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
			await act(async () => {
				resolve(response(200, data(provider, 3, true)));
			});
			await tick();
			fireEvent.click(screen.getByRole("button", { name: /Season 1/ }));
			await tick();
			assertRows(1);
			expect(screen.queryByText("Synthetic observed episode 2")).not.toBeInTheDocument();
			expect(client.getQueryData(queryKey(other, instance, tmdb))).toMatchObject({
				showTmdbId: tmdb,
				episodes: [expect.objectContaining({ episodeNumber: 1 })],
			});
			expect(calls.filter((call) => call.route === route(other, instance, tmdb))).toEqual([
				{ route: route(other, instance, tmdb), method: "GET" },
			]);
			expect(calls.filter((call) => !call.route.startsWith("/api/library/episodes?"))).toEqual([
				{ route: route(provider), method: "GET" },
				{ route: route(provider), method: "GET" },
				{ route: route(provider), method: "GET" },
				{ route: route(other, instance, tmdb), method: "GET" },
			]);
			expect(calls.every((call) => call.method === "GET" && !call.route.includes("refresh"))).toBe(
				true,
			);
		},
	);
});
