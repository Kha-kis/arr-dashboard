"use client";

import { HISTORY_EVENT_TYPE_MAX_LENGTH, type ServiceInstanceSummary } from "@arr/shared";
import { Filter, History, LayoutList, RefreshCw, RotateCcw, Table2 } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";
import {
	FilterSelect,
	PremiumEmptyState,
	PremiumPageHeader,
	StatCard,
} from "../../../components/layout";
import { ToggleSwitch } from "../../../components/layout/config-primitives";
import { Alert, AlertDescription } from "../../../components/ui";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useMultiInstanceHistoryQuery } from "../../../hooks/api/useDashboard";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { useRefreshState } from "../../../hooks/useRefreshState";
import { getLinuxInstanceName, useIncognitoMode } from "../../../lib/incognito";
import { cn } from "../../../lib/utils";
import { useHistoryData } from "../hooks/use-history-data";
import { useHistoryState } from "../hooks/use-history-state";
import { localDateInputValue, type TimeRangePreset } from "../lib/date-utils";
import { SERVICE_FILTERS } from "../lib/history-utils";
import { HistorySourceStatus } from "./history-source-status";
import { HistoryTable } from "./history-table";
import { HistoryTimeline } from "./history-timeline";

const PRESETS: Array<{ value: TimeRangePreset; label: string }> = [
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7 days" },
	{ value: "30d", label: "30 days" },
	{ value: "all", label: "All" },
];

export const getHistoryEmptyState = (
	sources: Array<{ providerStatus: { availability: string } }>,
	items: unknown[],
) => {
	if (sources.length === 0)
		return { title: "No History Sources", description: "No History sources are configured." };
	if (
		sources.every((source) => source.providerStatus.availability === "unavailable") &&
		items.length === 0
	)
		return {
			title: "History Sources Unavailable",
			description: "History sources are currently unavailable.",
		};
	return {
		title: "No Matching Observations",
		description: "No retained observations match the active filters.",
	};
};

export const HistoryClient = () => {
	const { state, actions } = useHistoryState();
	const [incognitoMode] = useIncognitoMode();
	const [filtersOpen, setFiltersOpen] = useState(false);
	const deferredSearch = useDeferredValue(state.searchTerm);
	const request = {
		limit: state.limit,
		cursor: null,
		startDate: state.startDate || null,
		endDate: state.endDate || null,
		search: deferredSearch.trim() || null,
		service: state.serviceFilter === "all" ? null : state.serviceFilter,
		instanceId: state.instanceFilter === "all" ? null : state.instanceFilter,
		eventType: state.statusFilter || null,
		hideProwlarrRss: state.hideProwlarrRss,
		chainRevision: state.chainRevision,
	};
	const query = useMultiInstanceHistoryQuery(request);
	const [isRefreshing, refresh] = useRefreshState(async () => {
		actions.restartPagination();
	});
	const { data: services } = useServicesQuery();
	const serviceMap = useMemo(
		() =>
			new Map(
				(services ?? []).map(
					(service) => [service.id, service] as [string, ServiceInstanceSummary],
				),
			),
		[services],
	);
	const history = useHistoryData(
		query.data,
		{
			searchTerm: deferredSearch,
			serviceFilter: state.serviceFilter,
			instanceFilter: state.instanceFilter,
			statusFilter: state.statusFilter,
			startDate: state.startDate,
			endDate: state.endDate,
		},
		state.groupByDownload,
		state.hideProwlarrRss,
	);
	const displayInstanceOptions = useMemo(
		() =>
			history.instanceOptions.map((option) => ({
				...option,
				label: incognitoMode ? getLinuxInstanceName(option.label) : option.label,
			})),
		[history.instanceOptions, incognitoMode],
	);
	const initialError = query.isError && history.allItems.length === 0;
	if (query.isLoading && !query.data)
		return (
			<div className="min-w-0 space-y-6" role="status" aria-label="Loading history">
				<span className="text-sm text-muted-foreground">Loading retained observations…</span>
			</div>
		);
	if (initialError)
		return (
			<div className="min-w-0 space-y-6">
				<PremiumPageHeader
					label="Activity"
					labelIcon={History}
					title="Download History"
					gradientTitle
				/>
				<Alert variant="danger">
					<AlertDescription>History is temporarily unavailable.</AlertDescription>
				</Alert>
			</div>
		);
	const emptyState = getHistoryEmptyState(history.sources, history.allItems);
	const hasLoadedRows = history.allItems.length > 0;
	return (
		<div className="min-w-0 space-y-6">
			<PremiumPageHeader
				label="Activity"
				labelIcon={History}
				title="Download History"
				gradientTitle
				description="Review loaded retained observations from configured sources."
				actions={
					<div className="flex min-w-0 flex-wrap items-center gap-2">
						<div className="flex shrink-0 overflow-hidden rounded-lg border border-border/50">
							<button
								type="button"
								onClick={() => actions.setViewMode("timeline")}
								className={cn(
									"flex items-center gap-1.5 px-3 py-1.5 text-xs",
									state.viewMode === "timeline" && "text-foreground",
								)}
							>
								<LayoutList className="h-3.5 w-3.5" />
								Timeline
							</button>
							<button
								type="button"
								onClick={() => actions.setViewMode("table")}
								className={cn(
									"flex items-center gap-1.5 border-l border-border/50 px-3 py-1.5 text-xs",
									state.viewMode === "table" && "text-foreground",
								)}
							>
								<Table2 className="h-3.5 w-3.5" />
								Table
							</button>
						</div>
						<Button
							variant="secondary"
							onClick={() => void refresh()}
							disabled={isRefreshing}
							className="shrink-0"
						>
							<RefreshCw className={cn("mr-2 h-4 w-4", isRefreshing && "animate-spin")} />
							{isRefreshing ? "Refreshing" : "Refresh"}
						</Button>
					</div>
				}
			/>
			<div className="flex min-w-0 flex-wrap items-center gap-2">
				{PRESETS.map((preset) => (
					<button
						key={preset.value}
						type="button"
						onClick={() => actions.setTimeRangePreset(preset.value)}
						className={cn(
							"rounded-full border px-4 py-1.5 text-xs",
							state.timeRangePreset === preset.value && "border-primary",
						)}
					>
						{preset.label}
					</button>
				))}
			</div>
			{state.dateValidationError && (
				<Alert variant="warning" role="alert">
					<AlertDescription>{state.dateValidationError}</AlertDescription>
				</Alert>
			)}
			{state.eventTypeValidationError && (
				<Alert variant="warning" role="alert">
					<AlertDescription>{state.eventTypeValidationError}</AlertDescription>
				</Alert>
			)}
			<div className="grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-4">
				{history.sources.map((source) => (
					<HistorySourceStatus key={source.instanceId} source={source} />
				))}
			</div>
			{hasLoadedRows && (
				<div className="grid min-w-0 gap-4 md:grid-cols-3">
					<StatCard
						value={history.activitySummary.grabs}
						label="Loaded grabs"
						description="Loaded"
						icon={History}
					/>
					<StatCard
						value={history.activitySummary.imports}
						label="Loaded imports"
						description="Loaded"
						icon={History}
					/>
					<StatCard
						value={history.activitySummary.failures}
						label="Loaded failures"
						description="Loaded"
						icon={History}
					/>
				</div>
			)}
			<div className="min-w-0 overflow-hidden rounded-xl border border-border/50">
				<button
					type="button"
					onClick={() => setFiltersOpen((open) => !open)}
					className="flex w-full min-w-0 items-center gap-2 px-4 py-3 text-left"
				>
					<Filter className="h-4 w-4" />
					Filters
				</button>
				{filtersOpen && (
					<div className="grid min-w-0 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-4">
						<FilterSelect
							value={String(state.limit)}
							onChange={(value) => actions.setLimit(Number(value))}
							options={[25, 50, 100].map((value) => ({
								value: String(value),
								label: `${value} per page`,
							}))}
							label="Items per page"
						/>
						<label className="min-w-0 text-xs" htmlFor="history-start-date">
							From date
							<Input
								id="history-start-date"
								type="date"
								value={localDateInputValue(state.startDate)}
								onChange={(event) => actions.setStartDate(event.target.value)}
							/>
						</label>
						<label className="min-w-0 text-xs" htmlFor="history-end-date">
							To date
							<Input
								id="history-end-date"
								type="date"
								value={localDateInputValue(state.endDate)}
								onChange={(event) => actions.setEndDate(event.target.value)}
							/>
						</label>
						<label className="min-w-0 text-xs" htmlFor="history-search">
							Search
							<Input
								id="history-search"
								value={state.searchTerm}
								onChange={(event) => actions.setSearchTerm(event.target.value)}
							/>
						</label>
						<FilterSelect
							value={state.serviceFilter}
							onChange={(value) => actions.setServiceFilter(value as typeof state.serviceFilter)}
							options={SERVICE_FILTERS}
							label="Service"
						/>
						<FilterSelect
							value={state.instanceFilter}
							onChange={actions.setInstanceFilter}
							options={[{ value: "all", label: "All instances" }, ...displayInstanceOptions]}
							label="Instance"
						/>
						<label className="min-w-0 text-xs" htmlFor="history-event-type">
							Event type
							<Input
								id="history-event-type"
								type="text"
								maxLength={HISTORY_EVENT_TYPE_MAX_LENGTH}
								value={state.statusFilter}
								onChange={(event) => actions.setStatusFilter(event.target.value)}
							/>
						</label>
						<div className="flex min-w-0 flex-wrap items-center gap-3 sm:col-span-2">
							<div className="flex min-w-0 items-center gap-2 text-xs">
								<span>Hide Prowlarr RSS</span>
								<ToggleSwitch
									checked={state.hideProwlarrRss}
									onChange={actions.setHideProwlarrRss}
									label="Hide Prowlarr RSS"
								/>
							</div>
							<div className="flex min-w-0 items-center gap-2 text-xs">
								<span>Group by download</span>
								<ToggleSwitch
									checked={state.groupByDownload}
									onChange={actions.setGroupByDownload}
									label="Group by download"
								/>
							</div>
						</div>
						<Button
							variant="ghost"
							onClick={() => {
								actions.setLimit(25);
								actions.setSearchTerm("");
								actions.setServiceFilter("all");
								actions.setInstanceFilter("all");
								actions.setStatusFilter("");
								actions.setHideProwlarrRss(true);
								actions.setGroupByDownload(true);
								actions.setTimeRangePreset("7d");
							}}
						>
							<RotateCcw className="mr-2 h-4 w-4" />
							Reset
						</Button>
					</div>
				)}
			</div>
			{!hasLoadedRows ? (
				<PremiumEmptyState
					icon={History}
					title={emptyState.title}
					description={emptyState.description}
				/>
			) : (
				<>
					{query.error && history.allItems.length > 0 && (
						<Alert variant="warning">
							<AlertDescription>
								Could not load more retained observations.{" "}
								<button type="button" onClick={actions.restartPagination} className="underline">
									Restart pagination
								</button>
							</AlertDescription>
						</Alert>
					)}
					{state.viewMode === "timeline" ? (
						<HistoryTimeline
							groupedByDay={history.groupedByDay}
							serviceMap={serviceMap}
							emptyMessage={history.emptyMessage}
							groupingEnabled={state.groupByDownload}
						/>
					) : (
						<HistoryTable
							groups={history.groupedItems}
							loading={false}
							emptyMessage={history.emptyMessage}
							groupingEnabled={state.groupByDownload}
							serviceMap={serviceMap}
						/>
					)}
					<div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
						<span className="text-sm text-muted-foreground">
							{history.matchingObservedCount} exact local retained matches;{" "}
							{history.allItems.length} loaded retained observations
						</span>
						{history.hasNextPage && (
							<Button
								onClick={() => void query.fetchNextPage()}
								disabled={query.isFetchingNextPage}
							>
								{query.isFetchingNextPage ? "Loading more" : "Load more"}
							</Button>
						)}
					</div>
				</>
			)}
		</div>
	);
};
