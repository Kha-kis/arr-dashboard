import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { LibraryInsightsSection } from "../library-insights-section";

vi.mock("next/navigation", () => ({
	useSearchParams: () => new URLSearchParams(),
}));

const unavailablePayload = {
	error: "Plex cache evidence is unavailable",
	evidence: {
		availability: "last-known",
		authority: "unavailable",
		attemptState: "error",
		publicationLevel: "unavailable",
		completeness: "unknown",
		reasonCodes: ["latest_attempt_failed"],
	},
};

const insightPaths = [
	"/api/library/insights/disk-waste",
	"/api/library/insights/watched-monitored",
	"/api/library/insights/requested-unwatched",
] as const;

function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	return new URL(raw, "http://localhost").pathname;
}

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("LibraryInsightsSection request bounds", () => {
	it("does not remount failed insight queries after the configured retry settles", async () => {
		const counts = new Map<string, number>();
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const path = requestPath(input);
			if (!insightPaths.includes(path as (typeof insightPaths)[number])) {
				throw new Error(`Unexpected request path: ${path}`);
			}
			counts.set(path, (counts.get(path) ?? 0) + 1);
			return new Response(JSON.stringify(unavailablePayload), {
				status: 503,
				headers: { "content-type": "application/json" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);

		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: 1, retryDelay: 0, gcTime: Infinity },
			},
		});

		render(
			<QueryClientProvider client={queryClient}>
				<IncognitoProvider>
					<LibraryInsightsSection />
				</IncognitoProvider>
			</QueryClientProvider>,
		);

		await waitFor(() => {
			for (const path of insightPaths) expect(counts.get(path) ?? 0).toBeGreaterThanOrEqual(2);
		});

		await new Promise((resolve) => setTimeout(resolve, 50));
		for (const path of insightPaths) expect(counts.get(path)).toBe(2);
		expect(screen.getByText("Showing last-known Plex values")).toBeInTheDocument();
		expect(
			screen.getByText(/No Plex rows are being shown; absence remains unknown/i),
		).toBeInTheDocument();
		queryClient.clear();
	});

	it("renders successful insight panels alongside an unavailable peer", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const path = requestPath(input);
			if (path === "/api/library/insights/watched-monitored") {
				return new Response(JSON.stringify(unavailablePayload), {
					status: 503,
					headers: { "content-type": "application/json" },
				});
			}
			if (path === "/api/library/insights/disk-waste") {
				return Response.json({
					success: true,
					data: {
						items: [
							{
								arrItemId: 101,
								instanceId: "disk-instance",
								instanceName: "Disk Fixture",
								service: "radarr",
								title: "Fractional Disk Fixture",
								year: null,
								sizeOnDisk: 1.5 * 1024 * 1024 * 1024,
								addedDaysAgo: 45,
								monitored: true,
								qualityProfileName: null,
							},
						],
						totalWastedBytes: 1.5 * 1024 * 1024 * 1024,
						hasPlexData: true,
						hasWatchData: true,
					},
				});
			}
			if (path === "/api/library/insights/requested-unwatched") {
				return Response.json({
					success: true,
					data: {
						items: [
							{
								arrItemId: 202,
								instanceId: "request-instance",
								instanceName: "Request Fixture",
								service: "sonarr",
								title: "Requested Fixture",
								year: null,
								sizeOnDisk: 0,
								addedDaysAgo: 12,
								requestedBy: "requester-fixture",
								requestedAt: "2026-01-01T00:00:00.000Z",
							},
						],
						hasSeerrData: true,
						hasPlexData: true,
						hasWatchData: true,
					},
				});
			}
			throw new Error(`Unexpected request path: ${path}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		const queryClient = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: Infinity } },
		});
		render(
			<QueryClientProvider client={queryClient}>
				<IncognitoProvider>
					<LibraryInsightsSection />
				</IncognitoProvider>
			</QueryClientProvider>,
		);

		await screen.findByText("Showing last-known Plex values");
		const diskPanel = screen.getByRole("button", { name: /1 unwatched item using 1\.5 GB/i });
		const requestedPanel = screen.getByRole("button", {
			name: /1 requested item never watched/i,
		});

		fireEvent.click(diskPanel);
		expect(screen.getByText("Fractional Disk Fixture")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Unmonitor" })).toHaveAttribute(
			"title",
			"Stop monitoring this item",
		);

		expect(requestedPanel).toBeInTheDocument();
		queryClient.clear();
	});
});
