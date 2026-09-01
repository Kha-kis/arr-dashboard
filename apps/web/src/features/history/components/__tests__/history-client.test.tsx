import type { MultiInstanceHistoryResponse } from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setPage = vi.fn();
const useMultiInstanceHistoryQuery = vi.fn();

vi.mock("../../../../hooks/api/useDashboard", () => ({
	useMultiInstanceHistoryQuery: (...args: unknown[]) => useMultiInstanceHistoryQuery(...args),
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
			setPage,
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

vi.mock("../history-timeline", () => ({
	HistoryTimeline: () => <div>History timeline</div>,
}));

vi.mock("../history-table", () => ({
	HistoryTable: () => <div>History table</div>,
}));

import { HistoryClient } from "../history-client";

const incompletePage: MultiInstanceHistoryResponse = {
	version: 2,
	instances: [],
	aggregated: [],
	totalCount: null,
	pagination: {
		pageSize: 25,
		nextCursor: "next-cursor",
		hasMore: true,
		incomplete: true,
		sortKey: "date",
		sortDirection: "descending",
		budgetUsed: 10_000,
	},
};

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("HistoryClient bounded continuation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		useMultiInstanceHistoryQuery.mockImplementation(
			(params: { cursor?: string }, options?: { enabled?: boolean }) => {
				if (options?.enabled && params.cursor === "next-cursor") return { data: undefined };
				return { data: incompletePage, isLoading: false, error: null };
			},
		);
	});

	it("keeps a zero-item capped page actionable and advances its cursor", () => {
		render(<HistoryClient />, { wrapper });

		expect(screen.getByText(/history results are incomplete/i)).toBeInTheDocument();
		const next = screen.getByRole("button", { name: /next/i });
		expect(next).toBeEnabled();
		fireEvent.click(next);
		expect(setPage).toHaveBeenCalledWith(2);
	});
});
