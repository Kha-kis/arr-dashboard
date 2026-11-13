import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { quiKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { IndexersClient } from "../../../indexers/components/indexers-client";
import { QuiActivityClient } from "../../../qui-activity/components/qui-activity-client";
import { QueueCleanerStatistics } from "../../../queue-cleaner/components/queue-cleaner-statistics";
import { DiscoverDetailModal } from "../discover-detail-modal";
import { ExternalLinksSection } from "../media-detail-sections";

// Next navigation is an unrelated framework effect; target components/hooks/clients run.
vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: vi.fn() }),
	usePathname: () => "/indexers",
}));
const clients: QueryClient[] = [];
const violations: string[] = [];
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	expect(violations.splice(0)).toEqual([]);
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	localStorage.clear();
});
function mount(component: ReactNode) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, retryDelay: 0, gcTime: 0, refetchOnWindowFocus: false },
		},
	});
	clients.push(client);
	return {
		client,
		...render(
			<QueryClientProvider client={client}>
				<ColorThemeProvider>
					<IncognitoProvider>{component}</IncognitoProvider>
				</ColorThemeProvider>
			</QueryClientProvider>,
		),
	};
}
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function transport(allowed: string[], handler: (url: URL) => Response | Promise<Response>) {
	const calls: string[] = [];
	vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
		const url = new URL(String(input), "https://synthetic.invalid");
		if (
			url.origin !== "https://synthetic.invalid" ||
			init?.method !== "GET" ||
			!allowed.includes(url.pathname)
		) {
			violations.push((init?.method ?? "GET") + " " + url.pathname);
			throw Error("Unexpected synthetic read");
		}
		calls.push(url.pathname + url.search);
		return handler(url);
	});
	return calls;
}
function deferred() {
	let resolve!: (value: Response) => void;
	return {
		promise: new Promise<Response>((r) => {
			resolve = r;
		}),
		resolve: (value: Response) => resolve(value),
	};
}
const event = (id: string) => ({
	id,
	userId: "synthetic-user",
	serviceInstanceId: "synthetic-qui",
	serviceInstanceLabel: "Synthetic Receiver",
	eventType: id,
	torrentHash: null,
	payload: {},
	receivedAt: "2026-10-30T12:00:00.000Z",
	timestamp: "2026-10-30T12:00:00.000Z",
});
function events(handler: (url: URL) => Response | Promise<Response>) {
	return transport(["/api/services", "/api/qui/activity", "/api/qui/events"], (url) =>
		url.pathname === "/api/services"
			? json({
					services: [
						{ id: "synthetic-qui", service: "qui", enabled: true, label: "Synthetic Receiver" },
					],
				})
			: url.pathname === "/api/qui/activity"
				? json({ events: [], nextCursor: null })
				: handler(url),
	);
}
async function openEvents() {
	const view = mount(<QuiActivityClient />);
	fireEvent.click(await screen.findByRole("tab", { name: "My Events" }));
	return view;
}
describe("My Events read recovery", () => {
	// Break: initial error strands the operator without a local recovery control.
	it("retries a cold failure locally and preserves verified empty after recovery", async () => {
		let fail = true;
		events(() =>
			fail
				? json({ message: "Synthetic unavailable" }, 503)
				: json({ entries: [], nextCursor: null }),
		);
		await openEvents();
		await screen.findByRole("alert");
		expect(screen.queryByText("No webhook events yet")).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		expect(await screen.findByText("No webhook events yet")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
	});
	// Break: failed refresh hides known rows and removes recovery.
	it("retains known rows through a background failure and Refresh recovers", async () => {
		let fail = false;
		const pending = deferred();
		let recovering = false;
		events(() =>
			recovering
				? pending.promise
				: fail
					? json({ message: "Synthetic unavailable" }, 503)
					: json({ entries: [event("known event")], nextCursor: null }),
		);
		const { client } = await openEvents();
		await screen.findByText("known event ·");
		fail = true;
		await act(async () => {
			await client.invalidateQueries({ queryKey: quiKeys.events });
		});
		await screen.findByRole("alert");
		expect(screen.getByText("known event ·")).toBeInTheDocument();
		recovering = true;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled());
		expect(screen.getByText("known event ·")).toBeInTheDocument();
		await act(async () =>
			pending.resolve(json({ entries: [event("new event")], nextCursor: null })),
		);
		expect(await screen.findByText("new event ·")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
	// Break: restarting a failed multi-page read discards known older rows or reuses an expired cursor.
	it("retains every known page on failed Refresh and derives fresh cursors on Retry", async () => {
		let phase: "initial" | "failed" | "recovered" = "initial";
		const calls = events((url) => {
			if (phase === "failed") return json({ message: "Synthetic unavailable" }, 503);
			if (!url.searchParams.has("cursor"))
				return json({
					entries: [event(phase === "initial" ? "known event" : "latest event")],
					nextCursor: phase === "initial" ? "old cursor" : "fresh cursor",
				});
			return json({
				entries: [event(phase === "initial" ? "known older event" : "fresh older event")],
				nextCursor: null,
			});
		});
		await openEvents();
		fireEvent.click(await screen.findByRole("button", { name: "Load older events" }));
		await screen.findByText("known older event ·");
		phase = "failed";
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await screen.findByRole("alert");
		expect(screen.getByText("known event ·")).toBeInTheDocument();
		expect(screen.getByText("known older event ·")).toBeInTheDocument();
		phase = "recovered";
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await screen.findByText("fresh older event ·");
		expect(screen.getByText("latest event ·")).toBeInTheDocument();
		expect(screen.queryByText("known older event ·")).not.toBeInTheDocument();
		expect(calls.slice(-2)).toEqual([
			"/api/qui/events?limit=50",
			"/api/qui/events?cursor=fresh+cursor&limit=50",
		]);
	});
	// Break: an expired cursor loses rows or requires leaving the selected tab.
	it.each([400, 503])(
		"keeps rows on older-page %s and restarts from latest in place",
		async (status) => {
			let latest = 0;
			const calls = events((url) =>
				url.searchParams.has("cursor")
					? json({ message: "Synthetic cursor unavailable" }, status)
					: json({
							entries: [event(++latest === 1 ? "known event" : "latest event")],
							nextCursor: latest === 1 ? "expired cursor" : null,
						}),
			);
			await openEvents();
			fireEvent.click(await screen.findByRole("button", { name: "Load older events" }));
			await screen.findByRole("alert");
			expect(screen.getByText("known event ·")).toBeInTheDocument();
			expect(screen.getByRole("tab", { name: "My Events" })).toHaveAttribute(
				"aria-selected",
				"true",
			);
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			expect(await screen.findByText("latest event ·")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(calls.filter((c) => c.startsWith("/api/qui/events"))).toEqual([
				"/api/qui/events?limit=50",
				"/api/qui/events?cursor=expired+cursor&limit=50",
				"/api/qui/events?limit=50",
			]);
		},
	);
});
const selection = (mediaType: "movie" | "tv") => ({
	id: 101,
	mediaType,
	title: "Synthetic selection",
	name: "Synthetic selection",
	overview: "Synthetic list summary",
	posterPath: undefined,
	backdropPath: undefined,
	voteAverage: 7,
	genreIds: [],
	originalLanguage: "en",
});
const detail = (mediaType: "movie" | "tv") => ({
	id: 101,
	title: "Synthetic hydrated movie",
	name: "Synthetic hydrated TV",
	overview: "Synthetic hydrated overview",
	posterPath: null,
	backdropPath: null,
	genres: [],
	credits: { cast: [], crew: [] },
	externalIds: {},
	relatedVideos: [],
	recommendations: { results: [] },
	similar: { results: [] },
	seasons: [],
	keywords: [],
	mediaType,
});
describe("Discover selected details", () => {
	// Break: query failure is silent, Retry targets inactive type, or known summary disappears.
	it.each(["movie", "tv"] as const)(
		"recovers only the selected %s detail and retains its summary",
		async (mediaType) => {
			let fail = true;
			const route = "/api/seerr/discover/synthetic-seerr/" + mediaType + "/101";
			const calls = transport([route], () =>
				fail ? json({ message: "Synthetic unavailable" }, 503) : json(detail(mediaType)),
			);
			mount(
				<DiscoverDetailModal
					item={selection(mediaType)}
					instanceId="synthetic-seerr"
					onClose={() => {}}
					onSelectItem={() => {}}
					onRequest={() => {}}
				/>,
			);
			expect(await screen.findByRole("alert")).toHaveTextContent(/unavailable/i);
			expect(screen.getByRole("heading", { name: "Synthetic selection" })).toBeInTheDocument();
			expect(screen.getByText("Synthetic list summary")).toBeInTheDocument();
			fail = false;
			fireEvent.click(screen.getByRole("button", { name: "Retry" }));
			expect(await screen.findByText("Synthetic hydrated overview")).toBeInTheDocument();
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
			expect(calls).toEqual([route, route]);
		},
	);
	// Break: failed refresh discards last-known hydrated details.
	it("shows background failure alongside hydrated data and retries it", async () => {
		let fail = false;
		const route = "/api/seerr/discover/synthetic-seerr/movie/101";
		transport([route], () => (fail ? json({}, 503) : json(detail("movie"))));
		const { client } = mount(
			<DiscoverDetailModal
				item={selection("movie")}
				instanceId="synthetic-seerr"
				onClose={() => {}}
				onSelectItem={() => {}}
				onRequest={() => {}}
			/>,
		);
		await screen.findByText("Synthetic hydrated overview");
		fail = true;
		await act(async () => {
			await client.invalidateQueries();
		});
		await screen.findByRole("alert");
		expect(screen.getByText("Synthetic hydrated overview")).toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
	});
});
describe("Indexer inventory availability", () => {
	// Break: unknown list is labeled as no configured instances.
	it("does not infer unconfigured on failed read and Refresh recovers verified empty", async () => {
		let fail = true;
		transport(["/api/services", "/api/search/indexers"], (url) =>
			url.pathname === "/api/services"
				? json({ services: [] })
				: fail
					? json({}, 503)
					: json({ aggregated: [], instances: [], totalCount: 0, failedInstanceCount: 0 }),
		);
		mount(<IndexersClient />);
		await screen.findByText("Unable to load indexers. Check your Prowlarr settings.");
		expect(screen.queryByText("No Prowlarr Instances Configured")).not.toBeInTheDocument();
		fail = false;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(await screen.findByText("No Prowlarr Instances Configured")).toBeInTheDocument();
	});
});
describe("Media-server destination availability", () => {
	// Break: supplied invalid destination enables Watch or conceals unavailability.
	it.each(["javascript:synthetic()", "data:text/plain,synthetic", "not a URL", "   ", ""])(
		"does not enable Watch for %s",
		(url) => {
			const opened = vi.spyOn(window, "open").mockReturnValue(null);
			mount(<ExternalLinksSection mediaType="movie" plexUrl={url} mediaServerLabel="Jellyfin" />);
			expect(screen.queryByRole("button", { name: "Watch in Jellyfin" })).not.toBeInTheDocument();
			expect(screen.getByText(/watch link unavailable/i)).toBeInTheDocument();
			expect(opened).not.toHaveBeenCalled();
		},
	);
	// Break: valid HTTP(S) behavior or execution guard is lost.
	it.each(["https://media.synthetic.invalid/items/41", "http://media.synthetic.invalid/items/41"])(
		"keeps valid navigation for %s",
		(url) => {
			const opened = vi.spyOn(window, "open").mockReturnValue(null);
			mount(<ExternalLinksSection mediaType="movie" plexUrl={url} mediaServerLabel="Jellyfin" />);
			fireEvent.click(screen.getByRole("button", { name: "Watch in Jellyfin" }));
			expect(opened).toHaveBeenCalledWith(url, "_blank", "noopener,noreferrer");
		},
	);
});
// Break: a retained 90-day total is presented as complete all-time history.
it("labels queue statistics with their retained 90-day scope", async () => {
	transport(["/api/queue-cleaner/statistics"], () =>
		json({
			totals: {
				itemsCleaned: 19,
				itemsSkipped: 0,
				itemsWarned: 0,
				totalRuns: 8,
				completedRuns: 6,
				errorRuns: 2,
				averageDurationMs: 65000,
				successRate: 75,
			},
			daily: [],
			weekly: [],
			ruleBreakdown: {},
			instanceBreakdown: [],
			recentActivity: [],
		}),
	);
	mount(<QueueCleanerStatistics />);
	const total = await screen.findByRole("button", { name: /Total Cleaned/ });
	expect(total).toHaveTextContent("19");
	expect(total).toHaveTextContent(/retained.*90 days/i);
	expect(screen.queryByText(/all time/i)).not.toBeInTheDocument();
});
