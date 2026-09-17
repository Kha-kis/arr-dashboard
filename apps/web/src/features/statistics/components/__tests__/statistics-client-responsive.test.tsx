import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefreshState = vi.hoisted(() => vi.fn());
const mockServicesQuery = vi.hoisted(() => vi.fn());
const mockStatisticsData = vi.hoisted(() => vi.fn());

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: mockServicesQuery,
}));

vi.mock("../../../../hooks/useRefreshState", () => ({
	useRefreshState: mockRefreshState,
}));

vi.mock("../../../../hooks/useThemeGradient", () => ({
	useThemeGradient: () => ({
		gradient: {
			from: "#2563eb",
			to: "#7c3aed",
			glow: "rgba(37, 99, 235, 0.3)",
			fromLight: "rgba(37, 99, 235, 0.1)",
			fromMuted: "rgba(37, 99, 235, 0.2)",
		},
	}),
}));

vi.mock("../../hooks/useStatisticsData", () => ({
	useStatisticsData: mockStatisticsData,
}));

vi.mock("../arr-service-tab", () => ({
	ArrServiceTab: ({ serviceType }: { serviceType: string }) => (
		<div data-testid={`${serviceType}-content`}>{serviceType} content</div>
	),
}));

vi.mock("../jellyfin-tab", () => ({
	JellyfinTab: () => <div data-testid="jellyfin-content">Jellyfin content</div>,
}));

vi.mock("../plex-tab", () => ({
	PlexTab: () => <div data-testid="plex-content">Plex content</div>,
}));

vi.mock("../prowlarr-tab", () => ({
	ProwlarrTab: () => <div data-testid="prowlarr-content">Prowlarr content</div>,
}));

vi.mock("../overview-tab", () => ({
	OverviewTab: ({ hasTautulli }: { hasTautulli: boolean }) => (
		<div data-testid="overview-content">
			{hasTautulli ? "Tautulli warning" : "Overview content"}
		</div>
	),
}));

import { StatisticsClient } from "../statistics-client";

const statisticsData = {
	isLoading: false,
	isFetching: false,
	error: null,
	refetch: vi.fn(),
	sonarrRows: [{ instanceId: "sonarr-1" }],
	radarrRows: [{ instanceId: "radarr-1" }],
	prowlarrRows: [{ instanceId: "prowlarr-1" }],
	lidarrRows: [{ instanceId: "lidarr-1" }],
	readarrRows: [{ instanceId: "readarr-1" }],
	sonarrTotals: {},
	radarrTotals: {},
	prowlarrTotals: {},
	lidarrTotals: {},
	readarrTotals: {},
	combinedDisk: {},
	allHealthIssues: [],
};

describe("StatisticsClient responsive navigation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockServicesQuery.mockReturnValue({
			data: [
				{ service: "sonarr", enabled: true },
				{ service: "radarr", enabled: true },
				{ service: "lidarr", enabled: true },
				{ service: "readarr", enabled: true },
				{ service: "prowlarr", enabled: true },
				{ service: "plex", enabled: true },
				{ service: "jellyfin", enabled: true },
				{ service: "tautulli", enabled: true },
			],
		});
		mockRefreshState.mockReturnValue([false, vi.fn()]);
		mockStatisticsData.mockReturnValue(statisticsData);
	});

	it("wraps every service tab and keeps the refresh control reachable with the warning state", () => {
		render(<StatisticsClient />);

		const overviewTab = screen.getByRole("button", { name: /^Overview$/ });
		const tabStrip = overviewTab.parentElement;
		expect(tabStrip).toHaveClass("inline-flex", "max-w-full", "flex-wrap");
		expect(tabStrip).not.toHaveClass("overflow-hidden", "overflow-x-auto");

		for (const label of [
			"Overview",
			"Sonarr",
			"Radarr",
			"Lidarr",
			"Readarr",
			"Prowlarr",
			"Plex",
			"Jellyfin",
		]) {
			expect(screen.getByRole("button", { name: new RegExp(`^${label}`) })).toBeVisible();
		}

		const header = screen.getByRole("heading", { name: "Statistics" }).parentElement?.parentElement;
		expect(header).toHaveClass("flex-wrap");
		expect(header?.firstElementChild).toHaveClass("min-w-0");
		expect(screen.getByRole("button", { name: /^Refresh$/ })).toBeVisible();
		expect(screen.getByTestId("overview-content")).toHaveTextContent("Tautulli warning");
	});

	it("preserves navigation when selecting a service tab", () => {
		render(<StatisticsClient />);

		fireEvent.click(screen.getByRole("button", { name: /^Jellyfin/ }));

		expect(screen.getByTestId("jellyfin-content")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /^Overview$/ })).toBeInTheDocument();
	});
});
