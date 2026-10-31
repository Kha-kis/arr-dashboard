import type { TopMediaResponse, WatchHistoryResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { useJellyfinTopMedia, useJellyfinWatchHistory } from "../../../../hooks/api/useJellyfin";
import { useTopMedia, useWatchHistory } from "../../../../hooks/api/usePlex";
import { jellyfinKeys, plexKeys } from "../../../../lib/query-keys";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";
import { TopMediaChart } from "../top-media-chart";
import { WatchHistoryWidget } from "../watch-history-widget";

type Service = "plex" | "jellyfin";
type Family = "history" | "top";

function payload(family: Family, title: string): WatchHistoryResponse | TopMediaResponse {
	return family === "history"
		? {
				events: [
					{
						user: "Synthetic viewer",
						title,
						timestamp: "2026-10-05T12:00:00Z",
						platform: null,
						videoDecision: null,
					},
				],
			}
		: {
				items: [
					{
						title,
						mediaType: "movie",
						playCount: 1,
						distinctUserCount: 1,
						totalDurationMinutes: 5,
						lastWatchedAt: "2026-10-05T12:00:00Z",
					},
				],
			};
}

function HistoryPanel({ service }: { service: Service }) {
	const plex = useWatchHistory(7, 50, service === "plex");
	const jellyfin = useJellyfinWatchHistory(7, 50, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<WatchHistoryWidget
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
			service={service}
		/>
	);
}

function TopPanel({ service }: { service: Service }) {
	const plex = useTopMedia("movie", 30, 10, service === "plex");
	const jellyfin = useJellyfinTopMedia("movie", 30, 10, service === "jellyfin");
	const query = service === "plex" ? plex : jellyfin;
	return (
		<TopMediaChart
			data={query.data}
			isLoading={query.isLoading}
			isError={query.isError}
			mediaType="movie"
			service={service}
		/>
	);
}

function providers(ui: React.ReactNode, client: QueryClient) {
	return render(
		<QueryClientProvider client={client}>
			<ColorThemeProvider>
				<IncognitoProvider>{ui}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("native History and Top Media retained-result recovery", () => {
	it.each([
		["plex", "history"],
		["jellyfin", "history"],
		["plex", "top"],
		["jellyfin", "top"],
	] as const)(
		"keeps %s %s results on refetch failure and replaces them after recovery",
		async (service, family) => {
			let outcome: "ok" | "failed" | "recovered" = "ok";
			vi.stubGlobal(
				"fetch",
				async () =>
					new Response(
						JSON.stringify(
							outcome === "failed"
								? { error: "Synthetic private upstream error" }
								: payload(
										family,
										outcome === "recovered"
											? "Recovered synthetic title"
											: "Retained synthetic title",
									),
						),
						{
							status: outcome === "failed" ? 503 : 200,
							headers: { "Content-Type": "application/json" },
						},
					),
			);
			const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
			const keys = service === "plex" ? plexKeys : jellyfinKeys;
			const queryKey =
				family === "history" ? keys.watchHistory(7, 50) : keys.topMedia("movie", 30, 10);
			try {
				providers(
					family === "history" ? (
						<HistoryPanel service={service} />
					) : (
						<TopPanel service={service} />
					),
					client,
				);
				await waitFor(() =>
					expect(screen.getByText("Retained synthetic title")).toBeInTheDocument(),
				);
				outcome = "failed";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText(/last-known.*refresh failed/i)).toBeInTheDocument(),
				);
				expect(screen.getByText("Retained synthetic title")).toBeInTheDocument();
				expect(screen.queryByText("Synthetic private upstream error")).not.toBeInTheDocument();
				outcome = "recovered";
				await act(async () => {
					await client.invalidateQueries({ queryKey });
				});
				await waitFor(() =>
					expect(screen.getByText("Recovered synthetic title")).toBeInTheDocument(),
				);
				expect(screen.queryByText("Retained synthetic title")).not.toBeInTheDocument();
				expect(screen.queryByText(/last-known.*refresh failed/i)).not.toBeInTheDocument();
			} finally {
				cleanup();
				client.clear();
			}
		},
	);
	it.each(["history", "top"] as const)(
		"uses an actionable blocking error for %s without any result",
		(family) => {
			const client = new QueryClient();
			try {
				providers(
					family === "history" ? (
						<WatchHistoryWidget data={undefined} isLoading={false} isError />
					) : (
						<TopMediaChart data={undefined} isLoading={false} isError mediaType="movie" />
					),
					client,
				);
				expect(screen.getByText(/check.*connection.*try again/i)).toBeInTheDocument();
			} finally {
				cleanup();
				client.clear();
			}
		},
	);
});
