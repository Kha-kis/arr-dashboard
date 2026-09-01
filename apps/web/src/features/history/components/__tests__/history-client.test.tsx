import type {
	HistoryItem,
	MultiInstanceHistoryResponse,
	ServiceInstanceSummary,
} from "@arr/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setPage = vi.fn();
const useMultiInstanceHistoryQuery = vi.fn();
const serviceInstances: ServiceInstanceSummary[] = [];

vi.mock("../../../../hooks/api/useDashboard", () => ({
	useMultiInstanceHistoryQuery: (...args: unknown[]) => useMultiInstanceHistoryQuery(...args),
}));

vi.mock("../../../../hooks/api/useServicesQuery", () => ({
	useServicesQuery: () => ({ data: serviceInstances }),
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
	useHistoryState: () => {
		const [page, setCurrentPage] = useState(1);
		return {
			state: {
				page,
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
				setPage: (value: number) => {
					setPage(value);
					setCurrentPage(value);
				},
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
		};
	},
}));

vi.mock("../history-timeline", () => ({
	HistoryTimeline: ({
		groupedByDay,
	}: {
		groupedByDay: Array<{ items: Array<{ items: HistoryItem[] }> }>;
	}) => (
		<div data-testid="history-items">
			{groupedByDay
				.flatMap((day) => day.items)
				.flatMap((group) => group.items)
				.map((entry) => entry.id)
				.join(",") || "none"}
		</div>
	),
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

const lifecycleItem = (id: string, date: string): HistoryItem => ({
	id,
	eventType: id === "page-1" ? "grabbed" : "downloadFolderImported",
	downloadId: "download-id-longer-than-ten",
	date,
	instanceId: "sonarr-1",
	instanceName: "Sonarr",
	service: "sonarr",
});

const historyPage = (
	aggregated: HistoryItem[],
	nextCursor: string | null,
): MultiInstanceHistoryResponse => ({
	version: 2,
	instances: [],
	aggregated,
	totalCount: null,
	pagination: {
		pageSize: 25,
		nextCursor,
		hasMore: nextCursor !== null,
		incomplete: false,
		sortKey: "date",
		sortDirection: "descending",
		budgetUsed: aggregated.length,
	},
});

const serviceInstance = (id: string, label: string): ServiceInstanceSummary => ({
	id,
	service: "sonarr",
	label,
	baseUrl: `http://${id}.example.test`,
	externalUrl: null,
	enabled: true,
	isDefault: false,
	hasApiKey: true,
	storageGroupId: null,
	hasLocalFilesystemAccess: false,
	pathPrefix: null,
	identity: {
		status: "unverified",
		kind: null,
		fingerprint: null,
		verifiedAt: null,
		lastCheckedAt: null,
	},
	createdAt: "2026-08-31T00:00:00.000Z",
	updatedAt: "2026-08-31T00:00:00.000Z",
	tags: [],
});

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("HistoryClient bounded continuation", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		serviceInstances.length = 0;
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

	it("keeps all enabled History instances selectable when the response is filtered", () => {
		serviceInstances.push(
			serviceInstance("sonarr-1", "Sonarr One"),
			serviceInstance("sonarr-2", "Sonarr Two"),
		);

		render(<HistoryClient />, { wrapper });
		fireEvent.click(screen.getByRole("button", { name: "Filters" }));

		expect(screen.getByRole("option", { name: "Sonarr One" })).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "Sonarr Two" })).toBeInTheDocument();
	});

	it("persists rendered ownership while navigating a lifecycle across three pages", () => {
		const pages = new Map<string | undefined, MultiInstanceHistoryResponse>([
			[undefined, historyPage([lifecycleItem("page-1", "2026-08-31T12:00:00.000Z")], "cursor-2")],
			["cursor-2", historyPage([lifecycleItem("page-2", "2026-08-31T11:00:00.000Z")], "cursor-3")],
			["cursor-3", historyPage([lifecycleItem("page-3", "2026-08-31T10:00:00.000Z")], null)],
		]);
		useMultiInstanceHistoryQuery.mockImplementation((params: { cursor?: string }) => ({
			data: pages.get(params.cursor),
			isLoading: false,
			error: null,
		}));

		render(<HistoryClient />, { wrapper });

		expect(screen.getByTestId("history-items")).toHaveTextContent("page-1,page-2");
		fireEvent.click(screen.getByRole("button", { name: /next/i }));
		expect(screen.getByTestId("history-items")).toHaveTextContent("none");
		fireEvent.click(screen.getByRole("button", { name: /next/i }));
		expect(screen.getByTestId("history-items")).toHaveTextContent("page-3");
	});
});
