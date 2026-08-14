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
});
