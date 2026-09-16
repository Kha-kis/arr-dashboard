import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useMultiInstanceHistoryQuery = vi.hoisted(() => vi.fn());
const mockHistoryData = vi.hoisted(() => vi.fn());
const rendererIncognito = vi.hoisted(() => ({ enabled: false }));
const historyStateMock = vi.hoisted(() => ({
	state: {
		limit: 25,
		startDate: "",
		endDate: "",
		searchTerm: "",
		serviceFilter: "all",
		instanceFilter: "all",
		statusFilter: "",
		groupByDownload: true,
		viewMode: "timeline" as const,
		timeRangePreset: "all" as const,
		hideProwlarrRss: true,
		chainRevision: 0,
		dateValidationError: null,
		eventTypeValidationError: null as string | null,
	},
	actions: {
		setLimit: vi.fn((value: number) => {
			historyStateMock.state.limit = value;
		}),
		setStartDate: vi.fn(),
		setEndDate: vi.fn(),
		setSearchTerm: vi.fn(),
		setServiceFilter: vi.fn(),
		setInstanceFilter: vi.fn(),
		setStatusFilter: vi.fn((value: string) => {
			const canonical = value.trim().toLowerCase();
			if (
				canonical.length > 128 ||
				Array.from(canonical).some((character) => {
					const code = character.charCodeAt(0);
					return code < 32 || code === 127;
				}) ||
				/(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:data|mailto|magnet):)/i.test(canonical)
			) {
				historyStateMock.state.eventTypeValidationError = "Enter a valid event type.";
				return;
			}
			historyStateMock.state.eventTypeValidationError = null;
			historyStateMock.state.statusFilter = canonical;
		}),
		setGroupByDownload: vi.fn((value: boolean) => {
			historyStateMock.state.groupByDownload = value;
		}),
		setViewMode: vi.fn(),
		setTimeRangePreset: vi.fn(),
		setHideProwlarrRss: vi.fn((value: boolean) => {
			historyStateMock.state.hideProwlarrRss = value;
		}),
		restartPagination: vi.fn(() => {
			historyStateMock.state.chainRevision += 1;
		}),
	},
}));

vi.mock("../../../../lib/incognito", () => ({
	getLinuxInstanceName: () => "Masked instance",
	getLinuxIsoName: () => "Masked title",
	getLinuxIndexer: () => "Masked indexer",
	getLinuxDownloadClient: () => "Masked client",
	useIncognitoMode: () => [rendererIncognito.enabled],
}));

vi.mock("../../../../hooks/api/useDashboard", () => ({
	useMultiInstanceHistoryQuery: (params: unknown) => useMultiInstanceHistoryQuery(params),
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
	useHistoryState: () => historyStateMock,
}));

vi.mock("../../hooks/use-history-data", () => ({
	useHistoryData: (...args: unknown[]) => mockHistoryData(...args),
}));

vi.mock("../history-timeline", () => ({
	HistoryTimeline: () => <div>History timeline</div>,
}));

vi.mock("../history-table", () => ({
	HistoryTable: () => <div>History table</div>,
}));

import { HistoryClient } from "../history-client";

describe("HistoryClient v2 cutover", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		rendererIncognito.enabled = false;
		Object.assign(historyStateMock.state, {
			limit: 25,
			startDate: "",
			endDate: "",
			searchTerm: "",
			serviceFilter: "all",
			instanceFilter: "all",
			statusFilter: "",
			groupByDownload: true,
			viewMode: "timeline",
			timeRangePreset: "all",
			hideProwlarrRss: true,
			chainRevision: 0,
			dateValidationError: null,
			eventTypeValidationError: null,
		});
		mockHistoryData.mockReturnValue({
			allItems: [],
			groupedItems: [],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 0, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: "No retained observations match the active filters.",
			sources: [],
			matchingObservedCount: 0,
			hasNextPage: false,
		});
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: {
				pages: [
					{
						version: 2,
						items: [
							{
								id: "retained",
								instanceId: "i",
								instanceName: "Private Host",
								service: "sonarr",
								providerEventId: 1,
								eventAt: "2026-09-01T00:00:00.000Z",
								eventType: "grabbed",
								title: "Private Title",
							},
						],
						sources: [],
						pageInfo: { nextCursor: "opaque", hasNextPage: true, matchingObservedCount: 1 },
					},
				],
			},
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: true,
			error: null,
			refetch: vi.fn(),
			fetchNextPage: vi.fn(),
		});
	});

	it("renders retained v2 observations and an opaque Load more control", () => {
		mockHistoryData.mockReturnValue({
			allItems: [{ id: "retained" }],
			groupedItems: [{ items: [{ id: "retained" }] }],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 0, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources: [],
			matchingObservedCount: 1,
			hasNextPage: true,
		});
		render(<HistoryClient />);

		expect(screen.getByText("History timeline")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Load more" })).toBeInTheDocument();
		expect(
			screen.queryByText(/page \d+ of \d+|total coverage|all history/i),
		).not.toBeInTheDocument();
	});

	it("masks instance filter labels in incognito while preserving option values", () => {
		mockHistoryData.mockReturnValue({
			allItems: [],
			groupedItems: [],
			groupedByDay: [],
			instanceOptions: [{ value: "instance-1", label: "Private Host" }],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 0, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: "No retained observations match the active filters.",
			sources: [],
			matchingObservedCount: 0,
			hasNextPage: false,
		});
		rendererIncognito.enabled = true;
		const { rerender } = render(<HistoryClient />);
		fireEvent.click(screen.getByRole("button", { name: "Filters" }));

		const instanceFilter = screen.getByLabelText("Instance");
		expect(screen.getByRole("option", { name: "Masked instance" })).toHaveValue("instance-1");
		expect(screen.queryByRole("option", { name: "Private Host" })).not.toBeInTheDocument();
		expect(instanceFilter).toHaveValue("all");

		rendererIncognito.enabled = false;
		rerender(<HistoryClient />);
		expect(screen.getByRole("option", { name: "Private Host" })).toHaveValue("instance-1");
	});

	it.each([
		["no configured sources", "No History sources are configured.", []],
		[
			"all unavailable",
			"History sources are currently unavailable.",
			[
				{
					instanceId: "i",
					instanceName: "Private Host",
					retainedObservationCount: 0,
					providerStatus: { availability: "unavailable" },
				},
			],
		],
		[
			"no matching rows",
			"No retained observations match the active filters.",
			[
				{
					instanceId: "i",
					instanceName: "Private Host",
					retainedObservationCount: 4,
					providerStatus: { availability: "last-known" },
				},
			],
		],
	] as const)("renders truthful %s state", (_name, message, sources) => {
		mockHistoryData.mockReturnValue({
			allItems: [],
			groupedItems: [],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 0, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources,
			matchingObservedCount: 0,
			hasNextPage: false,
		});
		render(<HistoryClient />);
		expect(screen.getByText(message)).toBeInTheDocument();
	});

	it("keeps the successful zero-item shell actionable with controls and reset", () => {
		mockHistoryData.mockReturnValue({
			allItems: [],
			groupedItems: [],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 0, imports: 0, failures: 0 },
			filtersActive: true,
			emptyMessage: undefined,
			sources: [
				{
					instanceId: "i",
					instanceName: "Private Host",
					retainedObservationCount: 0,
					providerStatus: { availability: "last-known" },
				},
			],
			matchingObservedCount: 0,
			hasNextPage: false,
		});
		render(<HistoryClient />);
		expect(screen.getByText("Download History")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
		expect(screen.getByText("Private Host")).toBeInTheDocument();
		expect(
			screen.getByText("No retained observations match the active filters."),
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Filters" }));
		expect(screen.getByLabelText("Items per page")).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Hide Prowlarr RSS" })).toBeInTheDocument();
		expect(screen.getByRole("switch", { name: "Group by download" })).toBeInTheDocument();
		expect(screen.getByLabelText("Event type")).toHaveValue("");
		expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Reset" }));
		expect(historyStateMock.actions.setLimit).toHaveBeenCalledWith(25);
		expect(historyStateMock.actions.setHideProwlarrRss).toHaveBeenCalledWith(true);
		expect(historyStateMock.actions.setGroupByDownload).toHaveBeenCalledWith(true);
	});

	it("uses an exact controlled event type input and forwards canonical values", () => {
		mockHistoryData.mockReturnValue({
			allItems: [{ id: "loaded", eventType: "grabbed" }],
			groupedItems: [{ items: [{ id: "loaded", eventType: "grabbed" }] }],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 1, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources: [],
			matchingObservedCount: 1,
			hasNextPage: false,
		});
		render(<HistoryClient />);
		fireEvent.click(screen.getByRole("button", { name: "Filters" }));
		const eventType = screen.getByLabelText("Event type");
		fireEvent.change(eventType, { target: { value: "  CUSTOM_UNSEEN  " } });
		expect(historyStateMock.actions.setStatusFilter).toHaveBeenCalledWith("  CUSTOM_UNSEEN  ");
		expect(eventType).toHaveAttribute("type", "text");
	});

	it("rebuilds server requests for query controls but keeps grouping local", () => {
		mockHistoryData.mockReturnValue({
			allItems: [{ id: "loaded" }],
			groupedItems: [{ items: [{ id: "loaded" }] }],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 1, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources: [],
			matchingObservedCount: 1,
			hasNextPage: false,
		});
		const { rerender } = render(<HistoryClient />);
		const firstRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		fireEvent.click(screen.getByRole("button", { name: "Filters" }));
		fireEvent.change(screen.getByLabelText("Items per page"), { target: { value: "100" } });
		rerender(<HistoryClient />);
		const limitRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		expect(limitRequest).toMatchObject({ limit: 100, cursor: null });
		expect(limitRequest).not.toEqual(firstRequest);
		fireEvent.click(screen.getByRole("switch", { name: "Hide Prowlarr RSS" }));
		rerender(<HistoryClient />);
		const rssRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		expect(rssRequest).toMatchObject({ limit: 100, hideProwlarrRss: false, cursor: null });
		fireEvent.change(screen.getByLabelText("Event type"), { target: { value: " ALL " } });
		rerender(<HistoryClient />);
		const eventRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		expect(eventRequest).toMatchObject({ eventType: "all", cursor: null });
		const maxEventType = "e".repeat(128);
		const eventInput = screen.getByLabelText("Event type");
		expect(eventInput).toHaveAttribute("maxLength", "128");
		fireEvent.change(eventInput, { target: { value: maxEventType } });
		rerender(<HistoryClient />);
		const maxEventRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		expect(maxEventRequest).toMatchObject({ eventType: maxEventType, cursor: null });
		fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "z".repeat(129) } });
		rerender(<HistoryClient />);
		expect(useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0]).toEqual(maxEventRequest);
		expect(screen.getByText("Enter a valid event type.")).toBeInTheDocument();
		for (const invalidEventType of [
			"safe data:text/plain,private",
			"safe mailto:private@example.invalid",
			"safe magnet:?xt=urn:private",
		]) {
			fireEvent.change(screen.getByLabelText("Event type"), {
				target: { value: invalidEventType },
			});
			rerender(<HistoryClient />);
			expect(useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0]).toEqual(maxEventRequest);
		}
		fireEvent.change(screen.getByLabelText("Event type"), { target: { value: "alliance" } });
		rerender(<HistoryClient />);
		expect(useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0]).toMatchObject({
			eventType: "alliance",
			cursor: null,
		});
		const allianceRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		fireEvent.click(screen.getByRole("switch", { name: "Group by download" }));
		rerender(<HistoryClient />);
		const groupedRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		expect(groupedRequest).toEqual(allianceRequest);
		expect(mockHistoryData.mock.calls.at(-1)?.[2]).toBe(false);
	});

	it("increments the chain for Refresh and later-page Restart", () => {
		mockHistoryData.mockReturnValue({
			allItems: [{ id: "loaded" }],
			groupedItems: [{ items: [{ id: "loaded" }] }],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 1, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources: [],
			matchingObservedCount: 1,
			hasNextPage: true,
		});
		const { rerender } = render(<HistoryClient />);
		const initialRevision = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0].chainRevision;
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		rerender(<HistoryClient />);
		const refreshedRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		expect(refreshedRequest).toMatchObject({ chainRevision: initialRevision + 1, cursor: null });
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: { pages: [] },
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: true,
			isError: true,
			error: new Error("cursor stale"),
			refetch: vi.fn(),
			fetchNextPage: vi.fn(),
		});
		rerender(<HistoryClient />);
		fireEvent.click(screen.getByRole("button", { name: /restart pagination/i }));
		rerender(<HistoryClient />);
		const restartedRequest = useMultiInstanceHistoryQuery.mock.calls.at(-1)?.[0];
		expect(restartedRequest).toMatchObject({ chainRevision: initialRevision + 2, cursor: null });
	});

	it("forwards limit, RSS, and grouping controls through responsive wrapping", () => {
		mockHistoryData.mockReturnValue({
			allItems: [{ id: "loaded" }],
			groupedItems: [{ items: [{ id: "loaded" }] }],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 1, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources: [],
			matchingObservedCount: 1,
			hasNextPage: false,
		});
		const { container } = render(<HistoryClient />);
		fireEvent.click(screen.getByRole("button", { name: "Filters" }));
		fireEvent.change(screen.getByLabelText("Items per page"), { target: { value: "100" } });
		fireEvent.click(screen.getByRole("switch", { name: "Hide Prowlarr RSS" }));
		fireEvent.click(screen.getByRole("switch", { name: "Group by download" }));
		expect(historyStateMock.actions.setLimit).toHaveBeenCalledWith(100);
		expect(historyStateMock.actions.setHideProwlarrRss).toHaveBeenCalledWith(false);
		expect(historyStateMock.actions.setGroupByDownload).toHaveBeenCalledWith(false);
		expect(container.querySelector(".flex.min-w-0.flex-wrap")).not.toBeNull();
	});

	it("shows a visible loading state and generic initial failure", () => {
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: undefined,
			isLoading: true,
			isFetchingNextPage: false,
			hasNextPage: false,
			error: null,
			refetch: vi.fn(),
			fetchNextPage: vi.fn(),
		});
		render(<HistoryClient />);
		expect(screen.getByText(/loading retained observations/i)).toBeInTheDocument();
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: { pages: [] },
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: false,
			isError: true,
			error: new Error("private provider payload"),
			refetch: vi.fn(),
			fetchNextPage: vi.fn(),
		});
		mockHistoryData.mockReturnValue({
			...mockHistoryData.mock.results.at(-1)?.value,
			allItems: [],
		});
		// A fresh render exercises the generic initial error boundary without exposing provider text.
		render(<HistoryClient />);
		expect(screen.getByText("History is temporarily unavailable.")).toBeInTheDocument();
		expect(screen.queryByText("private provider payload")).not.toBeInTheDocument();
	});

	it("invokes Load more and disables it while the continuation is pending", () => {
		mockHistoryData.mockReturnValue({
			allItems: [{ id: "loaded" }],
			groupedItems: [{ items: [{ id: "loaded" }] }],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 1, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources: [],
			matchingObservedCount: 1,
			hasNextPage: true,
		});
		const fetchNextPage = vi.fn();
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: { pages: [] },
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: true,
			error: null,
			refetch: vi.fn(),
			fetchNextPage,
		});
		render(<HistoryClient />);
		fireEvent.click(screen.getByRole("button", { name: "Load more" }));
		expect(fetchNextPage).toHaveBeenCalledTimes(1);
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: { pages: [] },
			isLoading: false,
			isFetchingNextPage: true,
			hasNextPage: true,
			error: null,
			refetch: vi.fn(),
			fetchNextPage,
		});
		render(<HistoryClient />);
		expect(screen.getByRole("button", { name: "Loading more" })).toBeDisabled();
	});

	it("Refresh restarts the local chain without invoking provider refresh semantics", () => {
		mockHistoryData.mockReturnValue({
			allItems: [{ id: "loaded" }],
			groupedItems: [{ items: [{ id: "loaded" }] }],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 1, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources: [],
			matchingObservedCount: 1,
			hasNextPage: false,
		});
		const refetch = vi.fn();
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: { pages: [] },
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: false,
			error: null,
			refetch,
			fetchNextPage: vi.fn(),
		});
		render(<HistoryClient />);
		fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
		expect(historyStateMock.actions.restartPagination).toHaveBeenCalledTimes(1);
		expect(refetch).not.toHaveBeenCalled();
	});

	it("keeps loaded rows visible when a later page fails and offers restart", () => {
		mockHistoryData.mockReturnValue({
			allItems: [{ id: "loaded" }],
			groupedItems: [{ items: [{ id: "loaded" }] }],
			groupedByDay: [],
			instanceOptions: [],
			serviceSummary: new Map(),
			statusSummary: [],
			activitySummary: { grabs: 0, imports: 0, failures: 0 },
			filtersActive: false,
			emptyMessage: undefined,
			sources: [],
			matchingObservedCount: 1,
			hasNextPage: true,
		});
		useMultiInstanceHistoryQuery.mockReturnValue({
			data: { pages: [] },
			isLoading: false,
			isFetchingNextPage: false,
			hasNextPage: true,
			error: new Error("cursor stale"),
			refetch: vi.fn(),
			fetchNextPage: vi.fn(),
		});
		render(<HistoryClient />);
		expect(screen.getByText("History timeline")).toBeInTheDocument();
		expect(screen.getByText(/could not load more/i)).toBeInTheDocument();
		expect(screen.getByRole("button", { name: /restart pagination/i })).toBeInTheDocument();
	});

	it("derives the three non-error empty states from sources and loaded rows", async () => {
		const { getHistoryEmptyState } = await import("../history-client");
		expect(getHistoryEmptyState([], [])).toMatchObject({ title: "No History Sources" });
		expect(
			getHistoryEmptyState(
				[{ instanceId: "i", providerStatus: { availability: "unavailable" } } as never],
				[],
			),
		).toMatchObject({ title: "History Sources Unavailable" });
		expect(
			getHistoryEmptyState(
				[{ instanceId: "i", providerStatus: { availability: "last-known" } } as never],
				[],
			),
		).toMatchObject({ title: "No Matching Observations" });
	});

	it("keeps external links safe normally and removes host/slug/href from table, timeline, and grouped sub-events in incognito", async () => {
		const { HistoryTable } =
			await vi.importActual<typeof import("../history-table")>("../history-table");
		const { HistoryTimeline } =
			await vi.importActual<typeof import("../history-timeline")>("../history-timeline");
		const item = {
			id: "local-1",
			instanceId: "i",
			instanceName: "Private Host",
			providerEventId: 1,
			service: "sonarr" as const,
			eventAt: "2026-09-01T00:00:00.000Z",
			eventType: "grabbed",
			title: "Private Title",
			seriesSlug: "private-title",
			downloadId: "download-1",
			indexer: "Private Indexer",
		};
		const serviceMap = new Map([
			[
				"i",
				{
					id: "i",
					baseUrl: "https://private.example",
					externalUrl: "https://private.example",
				} as never,
			],
		]);
		const group = {
			items: [
				item,
				{ ...item, id: "local-2", eventAt: "2026-09-01T01:00:00.000Z", eventType: "imported" },
			],
		};
		const { container, rerender } = render(
			<HistoryTable groups={[group]} groupingEnabled={true} serviceMap={serviceMap} />,
		);
		const normalLink = container.querySelector(
			'a[href="https://private.example/series/private-title"]',
		);
		expect(normalLink).toHaveAttribute("target", "_blank");
		expect(normalLink).toHaveAttribute("rel", "noopener noreferrer");
		rendererIncognito.enabled = true;
		rerender(<HistoryTable groups={[group]} groupingEnabled={true} serviceMap={serviceMap} />);
		expect(container.querySelector("a")).toBeNull();
		expect(container.textContent).not.toContain("private.example");
		expect(container.textContent).not.toContain("private-title");
		render(
			<HistoryTimeline
				groupedByDay={[{ date: "2026-09-01", label: "Today", items: [group] }]}
				serviceMap={serviceMap}
				groupingEnabled={true}
			/>,
		);
		expect(document.body.querySelector("a")).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "2 events" }));
		expect(document.body.querySelector("[href]")).toBeNull();
		expect(document.body.textContent).not.toContain("private.example");
		expect(document.body.textContent).not.toContain("private-title");
	});
});
