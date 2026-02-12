"use client";

import { useDeferredValue, useMemo, useState } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import { useMultiInstanceHistoryQuery } from "../../../hooks/api/useDashboard";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Alert, AlertDescription, Pagination } from "../../../components/ui";
import {
	PremiumPageHeader,
	StatCard,
	PremiumSkeleton,
	FilterSelect,
	ServiceBadge,
} from "../../../components/layout";
import { HistoryTable } from "./history-table";
import { HistoryTimeline } from "./history-timeline";
import { SERVICE_FILTERS } from "../lib/history-utils";
import { useHistoryState } from "../hooks/use-history-state";
import { useHistoryData } from "../hooks/use-history-data";
import type { TimeRangePreset } from "../lib/date-utils";
import { groupByDay } from "../lib/date-utils";
import {
	History,
	RefreshCw,
	Filter,
	RotateCcw,
	LayoutList,
	Table2,
	ArrowDownToLine,
	Package,
	AlertTriangle,
	ChevronDown,
	ChevronUp,
	X,
} from "lucide-react";
import { SERVICE_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { cn } from "../../../lib/utils";

const TIME_RANGE_PRESETS: Array<{ value: TimeRangePreset; label: string }> = [
	{ value: "24h", label: "24h" },
	{ value: "7d", label: "7 days" },
	{ value: "30d", label: "30 days" },
	{ value: "all", label: "All" },
];

export const HistoryClient = () => {
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [showServiceBreakdown, setShowServiceBreakdown] = useState(false);
	const [filtersOpen, setFiltersOpen] = useState(false);
	const [dismissedFailureAlert, setDismissedFailureAlert] = useState(false);
	const { gradient: themeGradient } = useThemeGradient();

	const { state, actions } = useHistoryState();
	const {
		page,
		pageSize,
		startDate,
		endDate,
		searchTerm,
		serviceFilter,
		instanceFilter,
		statusFilter,
		groupByDownload,
		viewMode,
		timeRangePreset,
		hideProwlarrRss,
	} = state;

	const { data, isLoading, error, refetch } = useMultiInstanceHistoryQuery({
		startDate: startDate || undefined,
		endDate: endDate || undefined,
	});

	const { data: services } = useServicesQuery();

	// Build service lookup map for external links
	const serviceMap = useMemo(() => {
		const map = new Map<string, ServiceInstanceSummary>();
		for (const instance of services ?? []) {
			map.set(instance.id, instance);
		}
		return map;
	}, [services]);

	// Defer the search term to avoid re-filtering 10k+ items on every keystroke
	const deferredSearchTerm = useDeferredValue(searchTerm);

	const historyData = useHistoryData(
		data,
		{
			searchTerm: deferredSearchTerm,
			serviceFilter,
			instanceFilter,
			statusFilter,
			startDate,
			endDate,
		},
		groupByDownload,
		hideProwlarrRss,
	);

	const {
		allItems,
		groupedItems,
		instanceOptions,
		statusOptions,
		serviceSummary,
		statusSummary,
		activitySummary,
		filtersActive,
		emptyMessage,
	} = historyData;

	const totalRecords = groupedItems.length;

	const paginatedGroups = useMemo(() => {
		const startIndex = (page - 1) * pageSize;
		return groupedItems.slice(startIndex, startIndex + pageSize);
	}, [groupedItems, page, pageSize]);

	// Group paginated items by day for timeline view
	const paginatedGroupedByDay = useMemo(
		() => groupByDay(paginatedGroups, (group) => group.items[0]?.date),
		[paginatedGroups],
	);

	// Extract recent failure titles for the spotlight alert
	const recentFailureTitles = useMemo(() => {
		if (activitySummary.failures === 0) return [];
		const cutoff = Date.now() - 24 * 60 * 60 * 1000;
		const titles: string[] = [];
		for (const item of allItems) {
			if (titles.length >= 3) break;
			const dateMs = item.date ? new Date(item.date).getTime() : 0;
			if (dateMs < cutoff) continue;
			const eventType = (item.eventType ?? item.status ?? "").toLowerCase();
			if (eventType.includes("fail") || eventType.includes("error") || eventType.includes("reject")) {
				const title = item.title ?? item.sourceTitle ?? "Unknown";
				if (!titles.includes(title)) {
					titles.push(title);
				}
			}
		}
		return titles;
	}, [allItems, activitySummary.failures]);

	const handleResetFilters = () => {
		actions.setSearchTerm("");
		actions.setServiceFilter("all");
		actions.setInstanceFilter("all");
		actions.setStatusFilter("all");
		actions.setTimeRangePreset("7d");
		actions.setHideProwlarrRss(true);
	};

	const handleRefresh = async () => {
		setIsRefreshing(true);
		await refetch();
		setTimeout(() => setIsRefreshing(false), 500);
	};

	// Loading skeleton
	if (isLoading) {
		return (
			<div className="space-y-8 animate-in fade-in duration-500">
				<div className="space-y-4">
					<PremiumSkeleton variant="line" className="h-8 w-48" />
					<PremiumSkeleton variant="line" className="h-10 w-64" style={{ animationDelay: "50ms" }} />
				</div>
				<div className="grid gap-4 md:grid-cols-3">
					{[0, 1, 2].map((i) => (
						<div
							key={i}
							className="relative overflow-hidden rounded-2xl border border-border/30 bg-card/30 p-6"
						>
							<PremiumSkeleton variant="card" className="h-12 w-12 rounded-xl mb-4" style={{ animationDelay: `${(i + 2) * 50}ms` }} />
							<PremiumSkeleton variant="line" className="h-8 w-16 mb-2" style={{ animationDelay: `${(i + 3) * 50}ms` }} />
							<PremiumSkeleton variant="line" className="h-4 w-24" style={{ animationDelay: `${(i + 4) * 50}ms` }} />
						</div>
					))}
				</div>
			</div>
		);
	}

	return (
		<>
			{/* Header */}
			<PremiumPageHeader
				label="Activity"
				labelIcon={History}
				title="Download History"
				gradientTitle
				description="Review recent activity from all configured instances."
				highlightStat={
					allItems.length > 0
						? { value: allItems.length, label: "events tracked" }
						: undefined
				}
				actions={
					<div className="flex items-center gap-2">
						{/* View Mode Toggle */}
						<div className="flex rounded-lg border border-border/50 overflow-hidden">
							<button
								type="button"
								onClick={() => actions.setViewMode("timeline")}
								className={cn(
									"flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all",
									viewMode === "timeline"
										? "text-foreground"
										: "text-muted-foreground hover:text-foreground"
								)}
								style={viewMode === "timeline" ? {
									backgroundColor: themeGradient.fromLight,
									color: themeGradient.from,
								} : undefined}
							>
								<LayoutList className="h-3.5 w-3.5" />
								Timeline
							</button>
							<button
								type="button"
								onClick={() => actions.setViewMode("table")}
								className={cn(
									"flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-all border-l border-border/50",
									viewMode === "table"
										? "text-foreground"
										: "text-muted-foreground hover:text-foreground"
								)}
								style={viewMode === "table" ? {
									backgroundColor: themeGradient.fromLight,
									color: themeGradient.from,
								} : undefined}
							>
								<Table2 className="h-3.5 w-3.5" />
								Table
							</button>
						</div>
						<Button
							variant="secondary"
							onClick={() => void handleRefresh()}
							className={cn(
								"relative overflow-hidden transition-all duration-300",
								isRefreshing && "pointer-events-none"
							)}
						>
							<RefreshCw
								className={cn(
									"h-4 w-4 mr-2 transition-transform duration-500",
									isRefreshing && "animate-spin"
								)}
							/>
							Refresh
							{isRefreshing && (
								<div
									className="absolute inset-0 animate-shimmer"
									style={{
										background: `linear-gradient(90deg, transparent, ${themeGradient.glow}, transparent)`,
									}}
								/>
							)}
						</Button>
					</div>
				}
			/>

			{/* Time Range Presets */}
			<div
				className="flex flex-wrap items-center gap-2 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "50ms", animationFillMode: "backwards" }}
			>
				<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide mr-1">
					Time Range
				</span>
				{TIME_RANGE_PRESETS.map((preset) => {
					const isActive = timeRangePreset === preset.value;
					return (
						<button
							key={preset.value}
							type="button"
							onClick={() => actions.setTimeRangePreset(preset.value)}
							className={cn(
								"rounded-full px-4 py-1.5 text-xs font-medium transition-all duration-200 border",
								isActive
									? "border-transparent shadow-sm"
									: "border-border/50 bg-card/30 text-muted-foreground hover:text-foreground hover:border-border/80"
							)}
							style={isActive ? {
								backgroundColor: themeGradient.fromLight,
								color: themeGradient.from,
								borderColor: themeGradient.fromMuted,
								boxShadow: `0 0 12px ${themeGradient.glow}`,
							} : undefined}
						>
							{preset.label}
						</button>
					);
				})}
			</div>

			{/* Activity Summary Cards */}
			<div
				className="space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
			>
				<div className="grid gap-4 md:grid-cols-3">
					<StatCard
						value={activitySummary.grabs}
						label="Grabs"
						description="Last 24 hours"
						icon={Package}
						animationDelay={100}
					/>
					<StatCard
						value={activitySummary.imports}
						label="Imports"
						description="Last 24 hours"
						icon={ArrowDownToLine}
						gradient={{
							from: SEMANTIC_COLORS.success.text,
							to: SEMANTIC_COLORS.success.text,
							glow: `${SEMANTIC_COLORS.success.text}40`,
						}}
						animationDelay={200}
					/>
					<StatCard
						value={activitySummary.failures}
						label="Failures"
						description="Last 24 hours"
						icon={AlertTriangle}
						gradient={activitySummary.failures > 0 ? {
							from: SEMANTIC_COLORS.error.text,
							to: SEMANTIC_COLORS.error.text,
							glow: `${SEMANTIC_COLORS.error.text}40`,
						} : undefined}
						animationDelay={300}
					/>
				</div>

				{/* Service Breakdown (Collapsible) */}
				<button
					type="button"
					onClick={() => setShowServiceBreakdown(!showServiceBreakdown)}
					className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
				>
					{showServiceBreakdown ? (
						<ChevronUp className="h-3.5 w-3.5" />
					) : (
						<ChevronDown className="h-3.5 w-3.5" />
					)}
					By Service
				</button>
				{showServiceBreakdown && (
					<div className="flex flex-wrap gap-2 animate-in fade-in duration-200">
						{(["sonarr", "radarr", "prowlarr", "lidarr", "readarr"] as const).map((service) => {
							const count = serviceSummary.get(service) ?? 0;
							if (count === 0) return null;
							const gradient = SERVICE_GRADIENTS[service];
							const isActive = serviceFilter === service;
							return (
								<button
									key={service}
									type="button"
									onClick={() => {
										actions.setServiceFilter(isActive ? "all" : service);
										actions.setPage(1);
									}}
									className={cn(
										"flex items-center gap-2 rounded-lg border px-3 py-2 transition-all duration-200 cursor-pointer",
										isActive
											? "ring-1 shadow-sm"
											: "border-border/50 bg-card/30 hover:border-border/80"
									)}
									style={isActive ? {
										borderColor: gradient.from,
										backgroundColor: `${gradient.from}15`,
										boxShadow: `0 0 8px ${gradient.glow}`,
									} : undefined}
								>
									<ServiceBadge service={service} />
									<span
										className="text-sm font-semibold"
										style={{ color: gradient.from }}
									>
										{count}
									</span>
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* Filters Card (Collapsible) */}
			<div
				className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "400ms", animationFillMode: "backwards" }}
			>
				{/* Clickable Header */}
				<button
					type="button"
					onClick={() => setFiltersOpen(!filtersOpen)}
					className="flex items-center gap-3 w-full px-5 py-3 text-left hover:bg-muted/10 transition-colors"
				>
					<Filter className="h-4 w-4 text-muted-foreground" />
					<span className="text-sm font-medium text-foreground">Filters</span>
					{filtersActive && !filtersOpen && (
						<span
							className="text-xs font-medium rounded-full px-2 py-0.5"
							style={{
								backgroundColor: themeGradient.fromLight,
								color: themeGradient.from,
							}}
						>
							Active
						</span>
					)}
					<div className="ml-auto">
						{filtersOpen ? (
							<ChevronUp className="h-4 w-4 text-muted-foreground" />
						) : (
							<ChevronDown className="h-4 w-4 text-muted-foreground" />
						)}
					</div>
				</button>

				{/* Active Filter Chips (shown when collapsed) */}
				{!filtersOpen && filtersActive && (
					<div className="flex flex-wrap gap-2 px-5 pb-3 animate-in fade-in duration-200">
						{deferredSearchTerm && (
							<ActiveFilterChip
								label={`Search: "${deferredSearchTerm}"`}
								onRemove={() => actions.setSearchTerm("")}
								gradient={themeGradient}
							/>
						)}
						{serviceFilter !== "all" && (
							<ActiveFilterChip
								label={`Service: ${serviceFilter}`}
								onRemove={() => actions.setServiceFilter("all")}
								gradient={themeGradient}
							/>
						)}
						{instanceFilter !== "all" && (
							<ActiveFilterChip
								label={`Instance: ${instanceOptions.find(o => o.value === instanceFilter)?.label ?? instanceFilter}`}
								onRemove={() => actions.setInstanceFilter("all")}
								gradient={themeGradient}
							/>
						)}
						{statusFilter !== "all" && (
							<ActiveFilterChip
								label={`Status: ${statusFilter}`}
								onRemove={() => actions.setStatusFilter("all")}
								gradient={themeGradient}
							/>
						)}
					</div>
				)}

				{/* Expanded Filter Controls */}
				{filtersOpen && (
					<div className="px-5 pb-5 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
						<div className="flex flex-wrap items-end gap-4">
							<div className="flex min-w-[140px] flex-col gap-1.5">
								<label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor="history-start-date">
									From Date
								</label>
								<Input
									id="history-start-date"
									type="date"
									value={startDate ? startDate.slice(0, 10) : ""}
									onChange={(event) => {
										actions.setStartDate(event.target.value);
										actions.setPage(1);
									}}
									className="bg-background/50 border-border/50 focus:border-primary"
								/>
							</div>
							<div className="flex min-w-[140px] flex-col gap-1.5">
								<label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor="history-end-date">
									To Date
								</label>
								<Input
									id="history-end-date"
									type="date"
									value={endDate}
									onChange={(event) => {
										actions.setEndDate(event.target.value);
										actions.setPage(1);
									}}
									className="bg-background/50 border-border/50 focus:border-primary"
								/>
							</div>
							<div className="flex min-w-[200px] flex-1 flex-col gap-1.5">
								<label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor="history-search">
									Search
								</label>
								<Input
									id="history-search"
									value={searchTerm}
									onChange={(event) => actions.setSearchTerm(event.target.value)}
									placeholder="Search title, client, or indexer"
									className="bg-background/50 border-border/50 focus:border-primary"
								/>
							</div>
							<FilterSelect
								value={serviceFilter}
								onChange={(value) =>
									actions.setServiceFilter(
										value as (typeof SERVICE_FILTERS)[number]["value"],
									)
								}
								options={SERVICE_FILTERS}
								label="Service"
								className="min-w-[140px]"
							/>
							<FilterSelect
								value={instanceFilter}
								onChange={(value) => actions.setInstanceFilter(value)}
								options={[{ value: "all", label: "All instances" }, ...instanceOptions]}
								label="Instance"
								className="min-w-[180px]"
							/>
							<FilterSelect
								value={statusFilter}
								onChange={(value) => actions.setStatusFilter(value)}
								options={[{ value: "all", label: "All statuses" }, ...statusOptions]}
								label="Status"
								className="min-w-[160px]"
							/>
						</div>
						<div className="flex items-center gap-4 pt-1">
							<label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
								<input
									type="checkbox"
									checked={groupByDownload}
									onChange={(e) => {
										actions.setGroupByDownload(e.target.checked);
										actions.setPage(1);
									}}
									className="rounded border-border/50 bg-background/50 text-primary focus:ring-primary/20"
								/>
								Group by download
							</label>
							<label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
								<input
									type="checkbox"
									checked={hideProwlarrRss}
									onChange={(e) => {
										actions.setHideProwlarrRss(e.target.checked);
										actions.setPage(1);
									}}
									className="rounded border-border/50 bg-background/50 text-primary focus:ring-primary/20"
								/>
								Hide RSS events
							</label>
							<div className="ml-auto">
								<Button
									variant="ghost"
									size="sm"
									onClick={handleResetFilters}
									disabled={!filtersActive}
									className="gap-2"
								>
									<RotateCcw className="h-4 w-4" />
									Reset
								</Button>
							</div>
						</div>
					</div>
				)}
			</div>

			{/* Status Summary Pills */}
			{statusSummary.length > 0 && (
				<div
					className="flex flex-wrap gap-2 animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "500ms", animationFillMode: "backwards" }}
				>
					{statusSummary.map(([label, count], index) => (
						<div
							key={`${index}-${label}`}
							className="flex items-center gap-2 rounded-full border border-border/50 bg-card/30 backdrop-blur-xs px-4 py-2 text-sm"
						>
							<span className="text-muted-foreground">{label}</span>
							<span
								className="font-semibold"
								style={{ color: themeGradient.from }}
							>
								{count}
							</span>
						</div>
					))}
				</div>
			)}

			{/* Pagination */}
			{totalRecords > 0 && (
				<Pagination
					currentPage={page}
					totalItems={totalRecords}
					pageSize={pageSize}
					onPageChange={(newPage) => actions.setPage(newPage)}
					onPageSizeChange={(newPageSize) => {
						actions.setPageSize(newPageSize);
						actions.setPage(1);
					}}
					pageSizeOptions={[25, 50, 100]}
				/>
			)}

			{/* Error Alert */}
			{error && (
				<Alert variant="danger">
					<AlertDescription>
						Unable to load history data. Please refresh and try again.
					</AlertDescription>
				</Alert>
			)}

			{/* Failure Spotlight Alert */}
			{activitySummary.failures > 0 && !dismissedFailureAlert && (
				<div
					className="flex items-start gap-3 rounded-xl border px-4 py-3 animate-in fade-in slide-in-from-top-2 duration-300"
					style={{
						borderColor: SEMANTIC_COLORS.error.border,
						backgroundColor: SEMANTIC_COLORS.error.bg,
					}}
				>
					<AlertTriangle
						className="h-4 w-4 mt-0.5 shrink-0"
						style={{ color: SEMANTIC_COLORS.error.text }}
					/>
					<div className="flex-1 min-w-0 space-y-1">
						<p
							className="text-sm font-medium"
							style={{ color: SEMANTIC_COLORS.error.text }}
						>
							{activitySummary.failures} failure{activitySummary.failures !== 1 ? "s" : ""} in the last 24 hours
						</p>
						{recentFailureTitles.length > 0 && (
							<p className="text-xs text-muted-foreground truncate">
								{recentFailureTitles.join(", ")}
								{activitySummary.failures > recentFailureTitles.length && " ..."}
							</p>
						)}
					</div>
					<button
						type="button"
						onClick={() => setDismissedFailureAlert(true)}
						className="rounded-full p-1 text-muted-foreground hover:text-foreground transition-colors shrink-0"
					>
						<X className="h-3.5 w-3.5" />
					</button>
				</div>
			)}

			{/* Content: Timeline or Table */}
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "600ms", animationFillMode: "backwards" }}
			>
				{viewMode === "timeline" ? (
					<HistoryTimeline
						groupedByDay={paginatedGroupedByDay}
						serviceMap={serviceMap}
						emptyMessage={emptyMessage}
						groupingEnabled={groupByDownload}
					/>
				) : (
					<HistoryTable
						groups={paginatedGroups}
						loading={isLoading}
						emptyMessage={emptyMessage}
						groupingEnabled={groupByDownload}
						serviceMap={serviceMap}
					/>
				)}
			</div>
		</>
	);
};

interface ActiveFilterChipProps {
	label: string;
	onRemove: () => void;
	gradient: { from: string; fromLight: string; fromMuted: string };
}

const ActiveFilterChip = ({ label, onRemove, gradient }: ActiveFilterChipProps) => (
	<span
		className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium"
		style={{
			backgroundColor: gradient.fromLight,
			color: gradient.from,
			border: `1px solid ${gradient.fromMuted}`,
		}}
	>
		{label}
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				onRemove();
			}}
			className="rounded-full p-0.5 transition-colors hover:bg-white/20"
		>
			<X className="h-3 w-3" />
		</button>
	</span>
);
