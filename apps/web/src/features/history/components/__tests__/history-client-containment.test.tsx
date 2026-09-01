import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useMultiInstanceHistoryQuery = vi.fn();

vi.mock("../../../../hooks/api/useDashboard", () => ({
	useMultiInstanceHistoryQuery: () => useMultiInstanceHistoryQuery(),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: [] }),
}));

vi.mock("../../../../hooks/useRefreshState", () => ({
	useRefreshState: (callback: () => Promise<void>) => [false, callback],
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

vi.mock("../../hooks/use-history-state", () => ({
	useHistoryState: () => ({
		state: {
			page: 1,
			pageSize: 25,
			startDate: "",
			endDate: "",
			searchTerm: "",
			serviceFilter: "all",
			instanceFilter: "all",
			statusFilter: "all",
			groupByDownload: true,
			viewMode: "timeline",
			timeRangePreset: "all",
			hideProwlarrRss: true,
		},
		actions: {
			setPage: vi.fn(),
			setPageSize: vi.fn(),
			setStartDate: vi.fn(),
			setEndDate: vi.fn(),
			setSearchTerm: vi.fn(),
			setServiceFilter: vi.fn(),
			setInstanceFilter: vi.fn(),
			setStatusFilter: vi.fn(),
			setGroupByDownload: vi.fn(),
			setViewMode: vi.fn(),
			setTimeRangePreset: vi.fn(),
			setHideProwlarrRss: vi.fn(),
		},
	}),
}));

vi.mock("../../hooks/use-history-data", () => ({
	useHistoryData: () => ({
		allItems: [
			{
				id: "stale-history",
				date: "2026-08-31T12:00:00.000Z",
				eventType: "grabbed",
			},
		],
		groupedItems: [
			{
				id: "stale-group",
				items: [
					{
						id: "stale-history",
						date: "2026-08-31T12:00:00.000Z",
						eventType: "grabbed",
					},
				],
			},
		],
		instanceOptions: [],
		statusOptions: [],
		serviceSummary: {},
		statusSummary: {},
		activitySummary: { grabs: 0, imports: 0, failures: 0 },
		filtersActive: false,
		emptyMessage: "No history found",
	}),
}));

vi.mock("../history-timeline", () => ({
	HistoryTimeline: () => <div>History timeline</div>,
}));

vi.mock("../history-table", () => ({
	HistoryTable: () => <div>History table</div>,
}));

import { HistoryClient } from "../history-client";

describe("HistoryClient containment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: {
				instances: [],
				aggregated: [{ id: "stale-history" }],
				totalCount: 1,
			},
			isLoading: false,
			error: new Error("Service Unavailable"),
			refetch: vi.fn(),
		});
	});

	it("explains that History is temporarily unavailable", () => {
		render(<HistoryClient />);

		expect(
			screen.getByText(
				"History is temporarily unavailable while safe, bounded pagination is restored.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("stale-history")).not.toBeInTheDocument();
		expect(screen.queryByText("No history found")).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Timeline" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Table" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Refresh" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Filters" })).not.toBeInTheDocument();
	});
});
