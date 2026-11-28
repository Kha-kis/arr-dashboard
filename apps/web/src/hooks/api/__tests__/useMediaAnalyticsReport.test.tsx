import type { MediaAnalyticsReport } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaAnalyticsReport } from "../useMediaAnalyticsReport";

function report(provider: "plex" | "jellyfin", days: number): MediaAnalyticsReport {
	return {
		version: 1,
		provider,
		days,
		generatedAt: "2026-11-07T12:00:00Z",
		transcode: {
			directPlay: 0,
			directStream: 0,
			transcode: 0,
			totalSessions: 0,
			dailyBreakdown: [],
		},
		bandwidth: { peakConcurrent: null, peakBandwidth: null, avgBandwidth: null, timeSeries: [] },
		userAnalytics: { users: [], dailyBreakdown: [] },
		watchHistory: { events: [] },
		codec: { videoCodecs: [], audioCodecs: [], resolutions: [], totalSessions: 0 },
		devices: { platforms: [], players: [], totalSessions: 0 },
		qualityScore: {
			overallScore: null,
			breakdown: { directPlayScore: null, resolutionScore: null, transcodeScore: null },
			trend: [],
			perUser: [],
		},
		forecast: { historicalDaily: [], forecast: [], peakHours: [], trend: "unknown" },
		topMedia: { movie: { items: [] }, series: { items: [] }, music: { items: [] } },
		popularMedia: { movie: { items: [] }, series: { items: [] }, music: { items: [] } },
	};
}

function response(provider: "plex" | "jellyfin", days: number) {
	return new Response(JSON.stringify(report(provider, days)), {
		headers: { "content-type": "application/json" },
	});
}

const clients: QueryClient[] = [];

function wrapper() {
	const client = new QueryClient({
		// A global keep-previous policy must not leak a retired scope into this report.
		defaultOptions: {
			queries: { retry: false, gcTime: 0, placeholderData: (previous: unknown) => previous },
		},
	});
	clients.push(client);
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

afterEach(() => {
	cleanup();
	for (const client of clients) client.clear();
	clients.length = 0;
	vi.unstubAllGlobals();
});

describe("consistent media report query", () => {
	it.each([
		["null envelope", null],
		["unknown version", { ...report("plex", 30), version: 2 }],
		["wrong provider", report("jellyfin", 30)],
		["wrong period", report("plex", 7)],
		["missing top media", { ...report("plex", 30), topMedia: undefined }],
		[
			"missing popular media type",
			{ ...report("plex", 30), popularMedia: { movie: { items: [] }, series: { items: [] } } },
		],
		["missing forecast", { ...report("plex", 30), forecast: undefined }],
		["array instead of section", { ...report("plex", 30), bandwidth: [] }],
	] as const)(
		"rejects a successful response with %s through the real transport",
		async (_name, body) => {
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(JSON.stringify(body), {
						headers: { "content-type": "application/json" },
					}),
			);
			const { result } = renderHook(() => useMediaAnalyticsReport("plex", 30), {
				wrapper: wrapper(),
			});
			await waitFor(() => expect(result.current.isError).toBe(true));
			expect(result.current.data).toBeUndefined();
		},
	);

	it("deduplicates same-scope consumers through the real client and transport", async () => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
			requests.push(String(input));
			return response("plex", 30);
		});
		const { result } = renderHook(
			() => [useMediaAnalyticsReport("plex", 30), useMediaAnalyticsReport("plex", 30)],
			{ wrapper: wrapper() },
		);
		await waitFor(() => expect(result.current.every((query) => query.isSuccess)).toBe(true));
		expect(requests).toEqual(["/api/plex/analytics/report?days=30"]);
		expect(result.current[0]?.data?.bandwidth.peakBandwidth).toBeNull();
	});

	it("never supplies another period or provider as placeholder data and aborts retired requests", async () => {
		const requests: Array<{
			url: string;
			signal: AbortSignal | null | undefined;
			resolve: (value: Response) => void;
		}> = [];
		vi.stubGlobal(
			"fetch",
			(input: RequestInfo | URL, options?: RequestInit) =>
				new Promise<Response>((resolve) => {
					requests.push({ url: String(input), signal: options?.signal, resolve });
				}),
		);
		const { result, rerender } = renderHook(
			({ provider, days }: { provider: "plex" | "jellyfin"; days: number }) =>
				useMediaAnalyticsReport(provider, days),
			{ wrapper: wrapper(), initialProps: { provider: "plex", days: 30 } },
		);
		await waitFor(() => expect(requests).toHaveLength(1));
		await act(async () => requests[0]?.resolve(response("plex", 30)));
		await waitFor(() => expect(result.current.data?.days).toBe(30));

		rerender({ provider: "plex", days: 7 });
		await waitFor(() => expect(requests).toHaveLength(2));
		expect(result.current.data).toBeUndefined();
		expect(result.current.isLoading).toBe(true);
		expect(requests[1]?.url).toBe("/api/plex/analytics/report?days=7");
		expect(requests[1]?.signal).toBeInstanceOf(AbortSignal);

		rerender({ provider: "jellyfin", days: 7 });
		await waitFor(() => expect(requests).toHaveLength(3));
		expect(requests[1]?.signal?.aborted).toBe(true);
		expect(result.current.data).toBeUndefined();
		expect(requests[2]?.url).toBe("/api/jellyfin/analytics/report?days=7");
		await act(async () => requests[1]?.resolve(response("plex", 7)));
		expect(result.current.data).toBeUndefined();
		await act(async () => requests[2]?.resolve(response("jellyfin", 7)));
		await waitFor(() => expect(result.current.data?.provider).toBe("jellyfin"));
		expect(result.current.data?.days).toBe(7);
	});
});
