import type {
	DashboardStatisticsEnvelope,
	TautulliStatsResponse,
	TranscodeAnalytics,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useJellyfinTranscodeAnalytics } from "../../../../hooks/api/useJellyfin";
import { useTranscodeAnalytics } from "../../../../hooks/api/usePlex";
import { tautulliKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { StatisticsClient } from "../statistics-client";

const snapshot: DashboardStatisticsEnvelope = {
	availability: "current",
	observedAt: new Date().toISOString(),
	data: {
		sonarr: { instances: [] },
		radarr: { instances: [] },
		lidarr: { instances: [] },
		readarr: { instances: [] },
		prowlarr: { instances: [] },
	},
};
const complete = { status: "complete" as const, configuredSources: 1, availableSources: 1 };
const privateError = "Synthetic private provider URL and account must not render";
let plays = 7;
let enabledServices: Array<{ service: string; enabled: boolean }>;
let failed: Set<string>;
let partial: boolean;
let empty: boolean;
let nativePlays: number;
let gates: Map<string, Promise<void>>;
let requests: string[];
const clients: QueryClient[] = [];

function response(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function mount(options: { setup?: (client: QueryClient) => void; extra?: React.ReactNode } = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: 1, retryDelay: 1, refetchOnWindowFocus: false, gcTime: Infinity },
		},
	});
	clients.push(client);
	options.setup?.(client);
	render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>
					<StatisticsClient />
					{options.extra}
				</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
	return client;
}

function transcode(): TranscodeAnalytics {
	return {
		directPlay: nativePlays,
		directStream: 0,
		transcode: 0,
		unknown: 0,
		totalSessions: nativePlays,
		dailyBreakdown: [],
		measurement: {
			version: 1,
			methodAxis: "video",
			status: "complete",
			observedSessions: nativePlays,
			measuredSessions: nativePlays,
			invalidDetailSnapshots: 0,
			configuredSources: 1,
			collection: {
				activeSnapshots: 1,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		},
	};
}

function stats(): TautulliStatsResponse {
	return {
		homeStats: [],
		userStats: empty
			? []
			: [{ userId: 1, friendlyName: "Synthetic viewer", totalPlays: plays, totalDuration: 7200 }],
		timeRange: 30,
		availability: partial
			? { status: "partial", configuredSources: 2, availableSources: 1 }
			: complete,
	};
}

function defer(path: string) {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	gates.set(path, promise);
	return resolve;
}

async function refresh() {
	const button = screen.getByRole("button", { name: /^Refresh$/ });
	await waitFor(() => expect(button).toBeEnabled());
	fireEvent.click(button);
	return button;
}

// Keep a nonselected source active and the selected source's 14d range
// disabled. Neither should be included in the page's Refresh action.
function AdditionalNativeReads({ selected }: { selected: "plex" | "jellyfin" }) {
	useTranscodeAnalytics(14, selected !== "plex");
	useJellyfinTranscodeAnalytics(14, selected !== "jellyfin");
	return null;
}

function value(label: string) {
	return screen.getByText(label, { exact: true }).nextElementSibling?.textContent;
}

beforeEach(() => {
	plays = 7;
	nativePlays = 2;
	enabledServices = [{ service: "tautulli", enabled: true }];
	failed = new Set();
	partial = false;
	empty = false;
	gates = new Map();
	requests = [];
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = String(input);
		requests.push(url);
		const path = url.split("?")[0]!;
		await gates.get(path);
		if (failed.has(path)) return response({ error: privateError }, 503);
		if (url === "/api/services") return response({ services: enabledServices });
		if (url === "/api/dashboard/statistics/snapshot") return response(snapshot);
		if (url === "/api/tautulli/stats?timeRange=30") {
			return response(stats());
		}
		if (url === "/api/tautulli/stats/plays-by-date?timeRange=30")
			return response({
				categories: ["2026-09-01"],
				series: empty ? [] : [{ name: "Synthetic series", data: [plays] }],
				timeRange: 30,
				availability: partial
					? { status: "partial", configuredSources: 2, availableSources: 1 }
					: complete,
			});
		if (/^\/api\/(plex|jellyfin)\/analytics\//.test(path)) {
			const kind = path.split("/").at(-1);
			switch (kind) {
				case "transcode":
					return response(transcode());
				case "bandwidth":
					return response({
						peakConcurrent: null,
						peakBandwidth: null,
						avgBandwidth: null,
						timeSeries: [],
					});
				case "users":
					return response({ users: [], dailyBreakdown: [] });
				case "history":
					return response({ events: [] });
				case "codec":
					return response({ videoCodecs: [], audioCodecs: [], resolutions: [], totalSessions: 0 });
				case "devices":
					return response({ platforms: [], players: [], totalSessions: 0 });
				case "quality-score":
					return response({
						overallScore: null,
						breakdown: { directPlayScore: null, resolutionScore: null, transcodeScore: null },
						trend: [],
						perUser: [],
					});
				case "forecast":
					return response({ historicalDaily: [], forecast: [], peakHours: [], trend: "unknown" });
				case "top-media":
				case "popular-media":
					return response({ items: [] });
			}
		}
		throw new Error(`Unexpected synthetic request: ${url}`);
	});
});
afterEach(() => {
	cleanup();
	for (const client of clients.splice(0)) client.clear();
	vi.unstubAllGlobals();
});

describe("Statistics header Refresh recovery", () => {
	it("updates the displayed Tautulli values through the actual Refresh button", async () => {
		mount();
		await waitFor(() => expect(value("Total Plays")).toBe("7"));
		plays = 11;
		fireEvent.click(screen.getByRole("button", { name: /^Refresh$/ }));
		await waitFor(() => expect(value("Total Plays")).toBe("11"));
	});

	it.each(["both", "stats", "plays"] as const)(
		"retains warm values on %s failure and recovers with a subsequent click",
		async (source) => {
			mount();
			await waitFor(() => expect(value("Total Plays")).toBe("7"));
			if (source !== "plays") failed.add("/api/tautulli/stats");
			if (source !== "stats") failed.add("/api/tautulli/stats/plays-by-date");
			await refresh();
			await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/failed.*stale/i));
			expect(value("Total Plays")).toBe("7");
			expect(value("Active Users")).toBe("1");
			expect(value("Watch Time")).toBe("2h");
			expect(screen.queryByText(privateError)).not.toBeInTheDocument();
			for (const path of failed)
				expect(requests.filter((url) => url.split("?")[0] === path)).toHaveLength(3);
			failed.clear();
			plays = 11;
			await refresh();
			await waitFor(() => expect(value("Total Plays")).toBe("11"));
			expect(screen.queryByRole("status")).not.toBeInTheDocument();
		},
	);

	it("recovers a cold failure without presenting missing values as empty totals", async () => {
		failed.add("/api/tautulli/stats");
		failed.add("/api/tautulli/stats/plays-by-date");
		mount();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/unavailable/i));
		expect(value("Total Plays")).toBe("—");
		expect(value("Active Users")).toBe("—");
		failed.clear();
		empty = true;
		await refresh();
		await waitFor(() => expect(value("Total Plays")).toBe("0"));
		expect(value("Active Users")).toBe("0");
		expect(value("Watch Time")).toBe("0m");
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("retains a partial-source disclosure until the button obtains complete data", async () => {
		partial = true;
		empty = true;
		mount();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/incomplete/i));
		expect(value("Total Plays")).toBe("—");
		partial = false;
		empty = false;
		await refresh();
		await waitFor(() => expect(value("Total Plays")).toBe("7"));
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("does not request disabled optional sources or unrelated enabled native sources", async () => {
		enabledServices = [
			{ service: "tautulli", enabled: false },
			{ service: "plex", enabled: true },
			{ service: "jellyfin", enabled: true },
		];
		mount();
		await screen.findByRole("button", { name: /^Plex$/ });
		await refresh();
		await waitFor(() =>
			expect(requests.filter((url) => url === "/api/dashboard/statistics/snapshot")).toHaveLength(
				2,
			),
		);
		expect(requests.filter((url) => /\/api\/(tautulli|plex|jellyfin)\//.test(url))).toEqual([]);
	});

	it("stays disabled after the fast snapshot settles until the selected source settles", async () => {
		mount();
		await waitFor(() => expect(value("Total Plays")).toBe("7"));
		const resolve = defer("/api/tautulli/stats/plays-by-date");
		plays = 11;
		const button = await refresh();
		await waitFor(() =>
			expect(requests.filter((url) => url === "/api/dashboard/statistics/snapshot")).toHaveLength(
				2,
			),
		);
		await act(async () => {
			await new Promise((done) => setTimeout(done, 550));
		});
		expect(button).toBeDisabled();
		expect(value("Total Plays")).toBe("7");
		fireEvent.click(button);
		expect(requests.filter((url) => url.includes("plays-by-date"))).toHaveLength(2);
		await act(async () => {
			resolve();
		});
		await waitFor(() => expect(value("Total Plays")).toBe("11"));
		await waitFor(() => expect(button).toBeEnabled());
	});

	it("joins a warm source read already in flight rather than cancelling and refiring it", async () => {
		const resolve = defer("/api/tautulli/stats");
		const client = mount({
			setup: (queryClient) =>
				queryClient.setQueryData(tautulliKeys.stats(30), stats(), { updatedAt: 1 }),
		});
		await waitFor(() => expect(value("Total Plays")).toBe("7"));
		expect(client.isFetching({ queryKey: tautulliKeys.stats(30) })).toBe(1);
		const button = await refresh();
		await waitFor(() =>
			expect(requests.filter((url) => url === "/api/dashboard/statistics/snapshot")).toHaveLength(
				2,
			),
		);
		expect(requests.filter((url) => url === "/api/tautulli/stats?timeRange=30")).toHaveLength(1);
		expect(button).toBeDisabled();
		await act(async () => {
			resolve();
		});
		await waitFor(() => expect(button).toBeEnabled());
	});

	it("waits for the other source read after one rejects and preserves the failed query's values", async () => {
		mount();
		await waitFor(() => expect(value("Total Plays")).toBe("7"));
		failed.add("/api/tautulli/stats");
		const resolve = defer("/api/tautulli/stats/plays-by-date");
		plays = 11;
		const button = await refresh();
		await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/failed.*stale/i));
		await act(async () => {
			await new Promise((done) => setTimeout(done, 550));
		});
		expect(button).toBeDisabled();
		expect(value("Total Plays")).toBe("7");
		await act(async () => {
			resolve();
		});
		await waitFor(() => expect(value("Total Plays")).toBe("11"));
		expect(value("Watch Time")).toBe("2h");
		expect(screen.getByRole("status")).toHaveTextContent(/failed.*stale/i);
		await waitFor(() => expect(button).toBeEnabled());
	});

	it("settles independent source reads after a snapshot rejection", async () => {
		mount();
		await waitFor(() => expect(value("Total Plays")).toBe("7"));
		failed.add("/api/dashboard/statistics/snapshot");
		plays = 11;
		const button = await refresh();
		await waitFor(() => expect(value("Total Plays")).toBe("11"));
		expect(screen.getByText(/unable to confirm current statistics/i)).toBeInTheDocument();
		await waitFor(() => expect(button).toBeEnabled());
	});

	it.each(["plex", "jellyfin", "emby"] as const)(
		"refreshes selected %s native analytics without Tautulli and preserves its active range",
		async (service) => {
			enabledServices = [
				{ service, enabled: true },
				{ service: service === "plex" ? "jellyfin" : "plex", enabled: true },
			];
			const family = service === "plex" ? "plex" : "jellyfin";
			const label = family === "plex" ? "Plex" : "Jellyfin";
			mount({ extra: <AdditionalNativeReads selected={family} /> });
			fireEvent.click(await screen.findByRole("button", { name: label }));
			await screen.findByRole("img", { name: /2 direct play/i });
			fireEvent.click(screen.getByRole("button", { name: "7d" }));
			await waitFor(() => expect(clients[0]!.isFetching()).toBe(0));
			requests = [];
			nativePlays = 5;
			await refresh();
			await screen.findByRole("img", { name: /5 direct play/i });
			const analytics = requests.filter((url) => url.includes("/analytics/"));
			expect(analytics).toHaveLength(14);
			expect(
				analytics.every((url) => url.startsWith(`/api/${family}/`) && url.includes("days=7")),
			).toBe(true);
			expect(requests.some((url) => url.includes("tautulli"))).toBe(false);
			expect(screen.getByRole("button", { name: "7d" })).toHaveClass("bg-card");
		},
	);

	it.each(["plex", "jellyfin"] as const)(
		"retains %s native observations through failure and replaces them after button recovery",
		async (service) => {
			enabledServices = [{ service, enabled: true }];
			mount();
			fireEvent.click(
				await screen.findByRole("button", {
					name: service === "plex" ? "Plex" : "Jellyfin",
				}),
			);
			await screen.findByRole("img", { name: /2 direct play/i });
			failed.add(`/api/${service}/analytics/transcode`);
			await refresh();
			await screen.findByText(/last-known historical data retained; refresh failed/i);
			expect(screen.getByRole("img", { name: /2 direct play/i })).toBeInTheDocument();
			expect(screen.queryByText(privateError)).not.toBeInTheDocument();
			failed.clear();
			nativePlays = 5;
			await refresh();
			await screen.findByRole("img", { name: /5 direct play/i });
			expect(
				screen.queryByText(/last-known historical data retained; refresh failed/i),
			).not.toBeInTheDocument();
		},
	);
});
