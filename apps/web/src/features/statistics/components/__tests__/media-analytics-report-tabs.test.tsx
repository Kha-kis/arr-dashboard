import type { MediaAnalyticsReport, TopMediaResponse, TopMediaType } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { JellyfinTab } from "../jellyfin-tab";
import { PlexTab } from "../plex-tab";

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [] }),
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({ gradient: { from: "#2563eb", to: "#2563eb" } }),
}));

const clients: QueryClient[] = [];

function mount(ui: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	clients.push(client);
	const view = render(
		<QueryClientProvider client={client}>
			<IncognitoProvider>{ui}</IncognitoProvider>
		</QueryClientProvider>,
	);
	return { client, ...view };
}

function report(provider: "plex" | "jellyfin", days: number, title: string): MediaAnalyticsReport {
	const collection = {
		activeSnapshots: 1,
		idleSnapshots: 0,
		failedSnapshots: 1,
		legacySnapshots: 0,
		invalidSnapshots: 0,
	};
	const measurement = { version: 1 as const, configuredSources: 1, collection };
	const leaderboard = (mediaType: TopMediaType, label: string): TopMediaResponse => ({
		measurement,
		items: [
			{
				title: `${title} ${label}`,
				mediaType,
				playCount: 1,
				distinctUserCount: 1,
				unattributedSessions: 0,
				unidentifiedPlaybackSessions: 0,
				totalDurationMinutes: 5,
				lastWatchedAt: "2026-11-07T12:00:00Z",
			},
		],
	});
	return {
		version: 1,
		provider,
		days,
		generatedAt: "2026-11-07T12:00:00Z",
		transcode: {
			directPlay: 1,
			directStream: 0,
			transcode: 0,
			unknown: 0,
			totalSessions: 1,
			dailyBreakdown: [],
			measurement: {
				...measurement,
				methodAxis: "video",
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				invalidDetailSnapshots: 0,
			},
		},
		bandwidth: {
			peakConcurrent: 1,
			peakBandwidth: null,
			avgBandwidth: null,
			timeSeries: [],
			measurement: {
				...measurement,
				status: "unavailable",
				bandwidthBasis: null,
				observedSessions: 1,
				observedSnapshots: 1,
				measuredSessions: 0,
				measuredSnapshots: 0,
			},
		},
		userAnalytics: { users: [], dailyBreakdown: [] },
		watchHistory: {
			measurement,
			events: [
				{
					user: "Synthetic viewer",
					title: `${title} history`,
					timestamp: "2026-11-07T12:00:00Z",
					platform: null,
					videoDecision: null,
				},
			],
		},
		codec: { videoCodecs: [], audioCodecs: [], resolutions: [], totalSessions: 0 },
		devices: { platforms: [], players: [], totalSessions: 0 },
		qualityScore: {
			overallScore: null,
			breakdown: { directPlayScore: null, resolutionScore: null, transcodeScore: null },
			trend: [],
			perUser: [],
		},
		forecast: { historicalDaily: [], forecast: [], peakHours: [], trend: "unknown" },
		topMedia: {
			movie: leaderboard("movie", "top movie"),
			series: leaderboard("series", "top show"),
			music: leaderboard("music", "top music"),
		},
		popularMedia: {
			movie: leaderboard("movie", "popular movie"),
			series: leaderboard("series", "popular show"),
			music: leaderboard("music", "popular music"),
		},
	};
}

function response(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	cleanup();
	for (const client of clients) client.clear();
	clients.length = 0;
	vi.unstubAllGlobals();
});

describe("consistent Statistics report consumers", () => {
	it.each([
		["plex", PlexTab],
		["jellyfin", JellyfinTab],
	] as const)("requests one %s report for all fourteen widgets", async (provider, Tab) => {
		// Restoring any legacy per-widget hook must break this network-boundary check.
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return new Response(JSON.stringify({ message: "Synthetic report unavailable" }), {
				status: 503,
				headers: { "content-type": "application/json" },
			});
		});
		const { client } = mount(<Tab />);
		await waitFor(() => expect(client.isFetching()).toBe(0));
		expect(requests).toHaveLength(1);
		expect(requests).toEqual([`/api/${provider}/analytics/report?days=30`]);
	});

	it.each([
		["plex", PlexTab],
		["jellyfin", JellyfinTab],
	] as const)(
		"retains the complete %s report with an updating/failed notice and recovers atomically",
		async (provider, Tab) => {
			let outcome: "initial" | "updating" | "recovered" = "initial";
			let finishRefresh: (value: Response) => void = () => {
				throw new Error("No refresh pending");
			};
			vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
				if (String(input) !== `/api/${provider}/analytics/report?days=30`)
					throw new Error("Unexpected route");
				if (outcome === "updating")
					return new Promise<Response>((resolve) => {
						finishRefresh = resolve;
					});
				return response(report(provider, 30, outcome === "recovered" ? "Recovered" : "Retained"));
			});
			const { client } = mount(<Tab />);
			await waitFor(() => expect(screen.getByText("Retained history")).toBeVisible());
			for (const label of [
				"top movie",
				"top show",
				"top music",
				"popular movie",
				"popular show",
				"popular music",
			]) {
				expect(screen.getByText(`Retained ${label}`)).toBeVisible();
			}
			for (const heading of [
				"Video Processing",
				"Sampled User Activity",
				"Recent Watch History",
				"Codec & Resolution",
				provider === "jellyfin" ? "Clients & Device Labels" : "Devices & Platforms",
				"Video Processing & Resolution",
				"Bandwidth Forecast",
			]) {
				expect(screen.getByText(heading)).toBeVisible();
			}
			expect(screen.getByText("Peak Observed Concurrent").closest(".rounded-xl")).toHaveTextContent(
				"1",
			);
			for (const label of ["Peak Known Bandwidth", "Avg Known Bandwidth"]) {
				expect(screen.getByText(label).closest(".rounded-xl")).toHaveTextContent("Unknown");
			}
			expect(screen.queryByText("0 kbps")).not.toBeInTheDocument();
			const keys = provider === "plex" ? plexKeys : jellyfinKeys;
			outcome = "updating";
			let refresh: Promise<void> | undefined;
			act(() => {
				refresh = client.invalidateQueries({ queryKey: keys.analyticsReport(30) });
			});
			await waitFor(() =>
				expect(screen.getByText(/last-known Statistics report while updating/i)).toBeVisible(),
			);
			expect(screen.getByText("Retained history")).toBeVisible();
			await act(async () => {
				finishRefresh(response({ message: "Synthetic private database error" }, 503));
				await refresh;
			});
			await waitFor(() =>
				expect(screen.getByText(/last-known Statistics report; refresh failed/i)).toBeVisible(),
			);
			expect(screen.getByText("Retained history")).toBeVisible();
			expect(screen.getByText("Retained top movie")).toBeVisible();
			expect(screen.getByText("Video Processing")).toBeVisible();
			expect(screen.queryByText(/Synthetic private database error/i)).not.toBeInTheDocument();
			outcome = "updating";
			fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
			await waitFor(() =>
				expect(screen.getByText(/last-known Statistics report while updating/i)).toBeVisible(),
			);
			expect(screen.getByText("Retained history")).toBeVisible();
			expect(screen.getByRole("button", { name: "Retry report" })).toBeDisabled();
			await act(async () => {
				outcome = "recovered";
				finishRefresh(response(report(provider, 30, "Recovered")));
			});
			await waitFor(() => expect(screen.getByText("Recovered history")).toBeVisible());
			expect(screen.queryByText("Retained history")).not.toBeInTheDocument();
			expect(screen.queryByText(/last-known Statistics report/i)).not.toBeInTheDocument();
		},
	);

	it.each([
		["plex", PlexTab],
		["jellyfin", JellyfinTab],
	] as const)(
		"shows unavailable for an initial %s failure and recovers without inventing empty measurements",
		async (provider, Tab) => {
			let failed = true;
			let finishRetry: (value: Response) => void = () => {
				throw new Error("No retry pending");
			};
			const requests: Array<{ url: string; method: string | undefined }> = [];
			vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
				requests.push({ url: String(input), method: options?.method });
				if (failed) return response({ message: "Synthetic failure" }, 503);
				return new Promise<Response>((resolve) => {
					finishRetry = resolve;
				});
			});
			mount(<Tab />);
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(/Statistics report unavailable/i),
			);
			expect(screen.getByRole("alert")).not.toHaveTextContent(/connection/i);
			expect(screen.queryByText("No Matching Sampled Observations")).not.toBeInTheDocument();
			expect(screen.queryByText("0 kbps")).not.toBeInTheDocument();
			failed = false;
			fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
			await waitFor(() => expect(requests).toHaveLength(2));
			expect(screen.getByRole("button", { name: "Retry report" })).toBeDisabled();
			expect(requests).toEqual([
				{ url: `/api/${provider}/analytics/report?days=30`, method: "GET" },
				{ url: `/api/${provider}/analytics/report?days=30`, method: "GET" },
			]);
			await act(async () => {
				finishRetry(response(report(provider, 30, "Recovered")));
			});
			await waitFor(() => expect(screen.getByText("Recovered history")).toBeVisible());
			expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		},
	);

	it.each([
		["plex", PlexTab],
		["jellyfin", JellyfinTab],
	] as const)(
		"treats wrong-scope successful %s responses as unavailable or last-known",
		async (provider, Tab) => {
			let body = report(provider === "plex" ? "jellyfin" : "plex", 30, "Wrong provider");
			vi.stubGlobal("fetch", async () => response(body));
			const { client } = mount(<Tab />);
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(/report unavailable/i),
			);
			expect(screen.queryByText("Wrong provider history")).not.toBeInTheDocument();
			body = report(provider, 30, "Retained");
			fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
			await waitFor(() => expect(screen.getByText("Retained history")).toBeVisible());
			body = report(provider, 7, "Wrong period");
			const keys = provider === "plex" ? plexKeys : jellyfinKeys;
			await act(async () => {
				await client.invalidateQueries({ queryKey: keys.analyticsReport(30) });
			});
			await waitFor(() =>
				expect(screen.getByText(/last-known Statistics report; refresh failed/i)).toBeVisible(),
			);
			expect(screen.getByText("Retained history")).toBeVisible();
			expect(screen.queryByText("Wrong period history")).not.toBeInTheDocument();
		},
	);

	it.each([
		["plex", PlexTab],
		["jellyfin", JellyfinTab],
	] as const)(
		"rejects truncated successful %s reports before rendering incomplete widgets",
		async (provider, Tab) => {
			let body: unknown = { ...report(provider, 30, "Truncated"), forecast: undefined };
			vi.stubGlobal("fetch", async () => response(body));
			const { client } = mount(<Tab />);
			await waitFor(() =>
				expect(screen.getByRole("alert")).toHaveTextContent(/report unavailable/i),
			);
			expect(screen.queryByText("Truncated history")).not.toBeInTheDocument();
			body = report(provider, 30, "Retained");
			fireEvent.click(screen.getByRole("button", { name: "Retry report" }));
			await waitFor(() => expect(screen.getByText("Retained history")).toBeVisible());
			body = { ...report(provider, 30, "Truncated"), topMedia: undefined };
			const keys = provider === "plex" ? plexKeys : jellyfinKeys;
			await act(async () => {
				await client.invalidateQueries({ queryKey: keys.analyticsReport(30) });
			});
			await waitFor(() =>
				expect(screen.getByText(/last-known Statistics report; refresh failed/i)).toBeVisible(),
			);
			expect(screen.getByText("Retained history")).toBeVisible();
			expect(screen.getByText("Retained top movie")).toBeVisible();
			expect(screen.queryByText("Truncated history")).not.toBeInTheDocument();
		},
	);

	it.each([
		["plex", PlexTab],
		["jellyfin", JellyfinTab],
	] as const)(
		"clears the retired %s period and ignores its late response during rapid selection",
		async (provider, Tab) => {
			const pending: Array<{
				signal: AbortSignal | null | undefined;
				finish: (value: Response) => void;
			}> = [];
			vi.stubGlobal("fetch", (input: RequestInfo | URL, options?: RequestInit) => {
				if (String(input) === `/api/${provider}/analytics/report?days=30`)
					return Promise.resolve(response(report(provider, 30, "Previous")));
				return new Promise<Response>((finish) => {
					pending.push({ signal: options?.signal, finish });
				});
			});
			mount(<Tab />);
			await waitFor(() => expect(screen.getByText("Previous history")).toBeVisible());
			fireEvent.click(screen.getByRole("button", { name: "7d" }));
			await waitFor(() => expect(pending).toHaveLength(1));
			expect(screen.queryByText("Previous history")).not.toBeInTheDocument();
			fireEvent.click(screen.getByRole("button", { name: "14d" }));
			await waitFor(() => expect(pending).toHaveLength(2));
			expect(pending[0]?.signal?.aborted).toBe(true);
			await act(async () => {
				pending[0]?.finish(response(report(provider, 7, "Retired")));
			});
			expect(screen.queryByText("Retired history")).not.toBeInTheDocument();
			await act(async () => {
				pending[1]?.finish(response(report(provider, 14, "Selected")));
			});
			await waitFor(() => expect(screen.getByText("Selected history")).toBeVisible());
			expect(screen.queryByText("Previous history")).not.toBeInTheDocument();
			expect(screen.queryByText("Retired history")).not.toBeInTheDocument();
		},
	);
});
