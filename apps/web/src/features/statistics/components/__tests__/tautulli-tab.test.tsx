import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const INCOGNITO_STORAGE_KEY = "arr-dashboard-incognito-mode";
const mocks = vi.hoisted(() => ({ stats: vi.fn(), plays: vi.fn(), history: vi.fn() }));

vi.mock("../../../../hooks/api/useTautulli", () => ({
	useTautulliStats: () => mocks.stats(),
	useTautulliPlaysByDate: () => mocks.plays(),
	useTautulliHistory: () => mocks.history(),
}));

import { TautulliTab } from "../tautulli-tab";

function wrapper() {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={queryClient}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}

const response = {
	stats: {
		provider: "tautulli" as const,
		configured: true,
		timeRange: 30,
		sources: [
			{
				instanceId: "tautulli-1",
				instanceLabel: "Family Tautulli",
				reachable: true,
				homeStats: [{ stat_id: "top_movies", stat_title: "Top Movies", rows: [] }],
				userStats: [],
				rankingLimit: 10,
				userStatsComplete: true,
				failedUserCount: 0,
			},
		],
	},
	plays: {
		provider: "tautulli" as const,
		configured: true,
		timeRange: 30,
		sources: [
			{
				instanceId: "tautulli-1",
				instanceLabel: "Family Tautulli",
				reachable: true,
				categories: ["Aug 1", "Aug 2"],
				series: [{ name: "Plays", data: [2, 4] }],
			},
		],
	},
	history: {
		provider: "tautulli" as const,
		configured: true,
		pagination: { offset: 0, limit: 25, complete: true },
		sources: [
			{
				instanceId: "tautulli-1",
				instanceLabel: "Family Tautulli",
				totalCount: 1,
				complete: true as const,
				history: [
					{
						title: "Blade Runner 2049",
						mediaType: "movie" as const,
						watchedAt: "2026-08-10T00:00:00.000Z",
						user: "alice",
						ratingKey: "42",
						instanceId: "tautulli-1",
						instanceLabel: "Family Tautulli",
					},
				],
			},
		],
	},
};

describe("TautulliTab", () => {
	beforeEach(() => {
		localStorage.removeItem(INCOGNITO_STORAGE_KEY);
		mocks.stats.mockReturnValue({ data: response.stats, isLoading: false });
		mocks.plays.mockReturnValue({ data: response.plays, isLoading: false });
		mocks.history.mockReturnValue({ data: response.history, isLoading: false });
	});

	it("renders only the typed Tautulli statistics, plays-by-date, and history surfaces", () => {
		render(<TautulliTab />, { wrapper: wrapper() });
		const analytics = screen.getByTestId("tautulli-analytics");
		expect(analytics).toHaveTextContent("Top Movies");
		expect(analytics).toHaveTextContent("Plays by date");
		expect(analytics).toHaveTextContent("Blade Runner 2049");
		expect(analytics).not.toHaveTextContent(/violations|trust score/i);
	});

	it("masks Tautulli titles, usernames, and instance labels in incognito", async () => {
		localStorage.setItem(INCOGNITO_STORAGE_KEY, "true");
		render(<TautulliTab />, { wrapper: wrapper() });
		await waitFor(() => expect(screen.queryByText("Blade Runner 2049")).not.toBeInTheDocument());
		expect(screen.queryByText("alice")).not.toBeInTheDocument();
		expect(screen.queryByText("Family Tautulli")).not.toBeInTheDocument();
		expect(screen.getByTestId("tautulli-analytics")).toBeInTheDocument();
	});

	it("renders supplied empty states when all provider collections are empty", () => {
		mocks.stats.mockReturnValue({ data: { ...response.stats, sources: [] }, isLoading: false });
		mocks.plays.mockReturnValue({ data: { ...response.plays, sources: [] }, isLoading: false });
		mocks.history.mockReturnValue({ data: { ...response.history, sources: [] }, isLoading: false });

		render(<TautulliTab />, { wrapper: wrapper() });

		expect(screen.getByText("No Tautulli statistics")).toBeInTheDocument();
		expect(screen.getByText("No plays by date")).toBeInTheDocument();
		expect(screen.getByText("No Tautulli watch history")).toBeInTheDocument();
	});

	it("distinguishes incomplete Tautulli statistics sources", () => {
		mocks.stats.mockReturnValue({
			data: {
				...response.stats,
				sources: [
					{
						...response.stats.sources[0],
						incompleteReason: "source_unreachable",
					},
					{
						...response.stats.sources[0],
						instanceId: "tautulli-2",
						incompleteReason: "connection_changed",
					},
					{
						...response.stats.sources[0],
						instanceId: "tautulli-3",
						incompleteReason: "user_list_unavailable",
					},
					{
						...response.stats.sources[0],
						instanceId: "tautulli-4",
						incompleteReason: "user_stats_partial",
						failedUserCount: 2,
					},
				],
			},
			isLoading: false,
		});

		render(<TautulliTab />, { wrapper: wrapper() });

		expect(screen.getByText(/Statistics unavailable: source unreachable/i)).toBeInTheDocument();
		expect(screen.getByText(/Statistics unavailable: connection changed/i)).toBeInTheDocument();
		expect(screen.getByText(/User statistics unavailable/i)).toBeInTheDocument();
		expect(
			screen.getByText(/User statistics are partial; 2 users could not be loaded/i),
		).toBeInTheDocument();
	});

	it("surfaces per-source plays and history incompleteness without generic empty history", () => {
		mocks.plays.mockReturnValue({
			data: {
				...response.plays,
				sources: [
					{
						...response.plays.sources[0],
						incompleteReason: "connection_changed",
						series: [],
					},
				],
			},
			isLoading: false,
		});
		mocks.history.mockReturnValue({
			data: {
				...response.history,
				pagination: { ...response.history.pagination, complete: false },
				sources: [
					{
						...response.history.sources[0],
						complete: false,
						incompleteReason: "page_truncated",
						history: [],
					},
				],
			},
			isLoading: false,
		});

		render(<TautulliTab />, { wrapper: wrapper() });

		expect(screen.getByText(/Plays by date unavailable: connection changed/i)).toBeInTheDocument();
		expect(screen.getByText(/History is incomplete: page truncated/i)).toBeInTheDocument();
		expect(screen.getByText(/History pagination is incomplete/i)).toBeInTheDocument();
		expect(screen.queryByText("No Tautulli watch history")).not.toBeInTheDocument();
	});

	it("keeps distinct users with the same history item and timestamp as separate rows", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const historySource = response.history.sources[0]!;
		const historyItem = historySource.history[0]!;
		mocks.history.mockReturnValue({
			data: {
				...response.history,
				sources: [
					{
						...historySource,
						totalCount: 2,
						history: [historyItem, { ...historyItem, user: "bob" }],
					},
				],
			},
			isLoading: false,
		});

		render(<TautulliTab />, { wrapper: wrapper() });

		expect(screen.getByTestId("tautulli-analytics")).toHaveTextContent("alice");
		expect(screen.getByTestId("tautulli-analytics")).toHaveTextContent("bob");
		expect(consoleError.mock.calls.flat().join(" ")).not.toMatch(/same key|unique "key" prop/i);
		consoleError.mockRestore();
	});
});
