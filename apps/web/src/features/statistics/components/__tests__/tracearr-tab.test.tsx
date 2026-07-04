import type { TracearrActivityBundle, TracearrStatsBundle } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IncognitoProvider } from "../../../../contexts/IncognitoContext";
import { ColorThemeProvider } from "../../../../providers/color-theme-provider";

const mockUseTracearrStats = vi.fn();
const mockUseTracearrActivity = vi.fn();
// The tab renders the C2b detail panels too; stub their hooks with empty
// paginated pages so those panels render their empty states without erroring.
const emptyPage = (key: "history" | "users" | "violations") => ({
	data: {
		instanceId: "trr-1",
		instanceLabel: "Dev Tracearr",
		[key]: { data: [], meta: { total: 0, page: 1, pageSize: 25 } },
	},
	isFetching: false,
});
vi.mock("../../../../hooks/api/useTracearr", () => ({
	useTracearrStats: () => mockUseTracearrStats(),
	useTracearrActivity: (period: string) => mockUseTracearrActivity(period),
	useTracearrHistory: () => emptyPage("history"),
	useTracearrUsers: () => emptyPage("users"),
	useTracearrViolations: () => emptyPage("violations"),
}));

import { TracearrTab } from "../tracearr-tab";

function createWrapper() {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={qc}>
			<ColorThemeProvider>
				<IncognitoProvider>{children}</IncognitoProvider>
			</ColorThemeProvider>
		</QueryClientProvider>
	);
}

function statsBundle(): TracearrStatsBundle {
	return {
		instanceId: "trr-1",
		instanceLabel: "Dev Tracearr",
		stats: {
			activeStreams: 1,
			totalUsers: 5,
			totalSessions: 200,
			recentViolations: 2,
			timestamp: "2026-07-02T00:00:00.000Z",
		},
		today: {
			activeStreams: 1,
			todayPlays: 12,
			// Deliberately fractional — the card must round this for display.
			watchTimeHours: 8.3333333,
			alertsLast24h: 0,
			activeUsersToday: 3,
		},
	};
}

function activityBundle(): TracearrActivityBundle {
	return {
		instanceId: "trr-1",
		instanceLabel: "Dev Tracearr",
		activity: {
			period: "month",
			range: { start: "2026-06-01T00:00:00.000Z", end: "2026-07-01T00:00:00.000Z" },
			plays: [
				{ date: "2026-06-01", count: 3 },
				{ date: "2026-06-02", count: 7 },
			],
			concurrent: [],
			byDayOfWeek: [{ day: 1, name: "Mon", count: 4 }],
			byHourOfDay: [],
			platforms: [{ platform: "Chrome", count: 9 }],
			quality: {
				directPlay: 6,
				directStream: 2,
				transcode: 4,
				total: 12,
				directPlayPercent: 50,
				directStreamPercent: 17,
				transcodePercent: 33,
			},
		},
	};
}

beforeEach(() => {
	mockUseTracearrStats.mockReset();
	mockUseTracearrActivity.mockReset();
	mockUseTracearrStats.mockReturnValue({ data: statsBundle() });
	mockUseTracearrActivity.mockReturnValue({ data: activityBundle() });
});

describe("<TracearrTab />", () => {
	it("renders the all-time + today summary cards", () => {
		render(<TracearrTab />, { wrapper: createWrapper() });
		const cards = screen.getByTestId("tracearr-stats-cards");
		expect(cards).toHaveTextContent("12"); // plays today
		expect(cards).toHaveTextContent("5"); // total users
		expect(cards).toHaveTextContent("200"); // total sessions
		expect(cards).toHaveTextContent(/Recent violations/i);
		// watchTimeHours is fractional — it must render rounded, not as a long float.
		expect(cards).toHaveTextContent("8.3");
		expect(cards).not.toHaveTextContent("8.3333333");
	});

	it("renders the activity breakdowns (quality + platforms)", () => {
		render(<TracearrTab />, { wrapper: createWrapper() });
		const activity = screen.getByTestId("tracearr-activity");
		expect(activity).toHaveTextContent(/Transcode/i);
		expect(activity).toHaveTextContent("Chrome");
		expect(activity).toHaveTextContent("Mon");
	});

	it("discloses the source instance", () => {
		render(<TracearrTab />, { wrapper: createWrapper() });
		expect(screen.getByText(/Source: Tracearr · Dev Tracearr/i)).toBeInTheDocument();
	});

	it("shows a loading skeleton while stats load (no cards yet)", () => {
		mockUseTracearrStats.mockReturnValue({ isLoading: true });
		mockUseTracearrActivity.mockReturnValue({ isLoading: true });
		render(<TracearrTab />, { wrapper: createWrapper() });
		expect(screen.queryByTestId("tracearr-stats-cards")).not.toBeInTheDocument();
	});

	it("lets the operator switch the activity period", () => {
		render(<TracearrTab />, { wrapper: createWrapper() });
		// Default period is month; switching to year should re-query.
		fireEvent.click(screen.getByRole("button", { name: /^year$/i }));
		expect(mockUseTracearrActivity).toHaveBeenCalledWith("year");
	});
});
