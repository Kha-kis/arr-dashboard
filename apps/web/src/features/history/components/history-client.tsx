"use client";

import { useMemo, useState, useEffect } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import { useMultiInstanceHistoryQuery } from "../../../hooks/api/useDashboard";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { Alert, AlertDescription, Pagination } from "../../../components/ui";
import { AmbientGlow, PremiumPageHeader, PremiumCard, StatCard } from "../../../components/layout";
import { HistoryTable } from "./history-table";
import { SERVICE_FILTERS } from "../lib/history-utils";
import { useHistoryState } from "../hooks/use-history-state";
import { useHistoryData } from "../hooks/use-history-data";
import { History, RefreshCw, Tv, Film, Search as SearchIcon, Filter, RotateCcw } from "lucide-react";
import { THEME_GRADIENTS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import { cn } from "../../../lib/utils";

export const HistoryClient = () => {
	const [mounted, setMounted] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	useEffect(() => {
		setMounted(true);
	}, []);

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

	const historyData = useHistoryData(
		data,
		{
			searchTerm,
			serviceFilter,
			instanceFilter,
			statusFilter,
			startDate,
			endDate,
		},
		groupByDownload,
	);

	const {
		allItems,
		groupedItems,
		instanceOptions,
		statusOptions,
		serviceSummary,
		statusSummary,
		filtersActive,
		emptyMessage,
	} = historyData;

	const totalRecords = groupedItems.length;
	const totalPages = Math.ceil(totalRecords / pageSize);
	const showingFrom = totalRecords > 0 ? (page - 1) * pageSize + 1 : 0;
	const showingTo = Math.min(page * pageSize, totalRecords);

	const paginatedGroups = useMemo(() => {
		const startIndex = (page - 1) * pageSize;
		return groupedItems.slice(startIndex, startIndex + pageSize);
	}, [groupedItems, page, pageSize]);

	const handleResetFilters = () => {
		actions.setSearchTerm("");
		actions.setServiceFilter("all");
		actions.setInstanceFilter("all");
		actions.setStatusFilter("all");
		actions.setStartDate("");
		actions.setEndDate("");
		actions.setPage(1);
	};

	const handleRefresh = async () => {
		setIsRefreshing(true);
		await refetch();
		setTimeout(() => setIsRefreshing(false), 500);
	};

	// Loading skeleton
	if (!mounted || isLoading) {
		return (
			<section className="relative flex flex-col gap-8">
				<AmbientGlow />
				<div className="space-y-8 animate-in fade-in duration-500">
					<div className="space-y-4">
						<div className="h-8 w-48 rounded-lg bg-muted/50 animate-pulse" />
						<div className="h-10 w-64 rounded-lg bg-muted/30 animate-pulse" />
					</div>
					<div className="grid gap-4 md:grid-cols-3">
						{[0, 1, 2].map((i) => (
							<div
								key={i}
								className="relative overflow-hidden rounded-2xl border border-border/30 bg-card/30 p-6"
							>
								<div className="h-12 w-12 rounded-xl bg-muted/30 animate-pulse mb-4" />
								<div className="h-8 w-16 rounded bg-muted/40 animate-pulse mb-2" />
								<div className="h-4 w-24 rounded bg-muted/20 animate-pulse" />
							</div>
						))}
					</div>
				</div>
			</section>
		);
	}

	// Get service-specific counts
	const sonarrCount = serviceSummary.get("sonarr") ?? 0;
	const radarrCount = serviceSummary.get("radarr") ?? 0;
	const prowlarrCount = serviceSummary.get("prowlarr") ?? 0;

	return (
		<section className="relative flex flex-col gap-8">
			{/* Ambient background glow */}
			<AmbientGlow />

			{/* Header */}
			<PremiumPageHeader
				label="Activity"
				labelIcon={History}
				title="Download History"
				gradientTitle
				description={`Review recent activity from all configured instances.`}
				highlightStat={
					allItems.length > 0
						? { value: allItems.length, label: `events tracked` }
						: undefined
				}
				actions={
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
				}
			/>

			{/* Service Stats Grid */}
			<div
				className="grid gap-4 md:grid-cols-3 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
			>
				<StatCard
					value={sonarrCount}
					label="Sonarr"
					description="TV show events"
					icon={Tv}
					gradient={SERVICE_GRADIENTS.sonarr}
					animationDelay={100}
				/>
				<StatCard
					value={radarrCount}
					label="Radarr"
					description="Movie events"
					icon={Film}
					gradient={SERVICE_GRADIENTS.radarr}
					animationDelay={200}
				/>
				<StatCard
					value={prowlarrCount}
					label="Prowlarr"
					description="Indexer events"
					icon={SearchIcon}
					gradient={SERVICE_GRADIENTS.prowlarr}
					animationDelay={300}
				/>
			</div>

			{/* Filters Card */}
			<PremiumCard
				title="Filters"
				description="Narrow down your search"
				icon={Filter}
				gradientIcon={false}
				animationDelay={400}
			>
				<div className="flex flex-wrap items-end gap-4">
					<div className="flex min-w-[140px] flex-col gap-1.5">
						<label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor="history-start-date">
							From Date
						</label>
						<Input
							id="history-start-date"
							type="date"
							value={startDate}
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
					<div className="flex min-w-[140px] flex-col gap-1.5">
						<label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor="history-service-filter">
							Service
						</label>
						<select
							id="history-service-filter"
							value={serviceFilter}
							onChange={(event) =>
								actions.setServiceFilter(
									event.target.value as (typeof SERVICE_FILTERS)[number]["value"],
								)
							}
							className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 [&>option]:bg-background [&>option]:text-foreground"
						>
							{SERVICE_FILTERS.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					<div className="flex min-w-[180px] flex-col gap-1.5">
						<label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor="history-instance-filter">
							Instance
						</label>
						<select
							id="history-instance-filter"
							value={instanceFilter}
							onChange={(event) => actions.setInstanceFilter(event.target.value)}
							className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 [&>option]:bg-background [&>option]:text-foreground"
						>
							<option value="all">All instances</option>
							{instanceOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					<div className="flex min-w-[160px] flex-col gap-1.5">
						<label className="text-xs font-medium text-muted-foreground uppercase tracking-wide" htmlFor="history-status-filter">
							Status
						</label>
						<select
							id="history-status-filter"
							value={statusFilter}
							onChange={(event) => actions.setStatusFilter(event.target.value)}
							className="rounded-lg border border-border/50 bg-background/50 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary/20 [&>option]:bg-background [&>option]:text-foreground"
						>
							<option value="all">All statuses</option>
							{statusOptions.map((option) => (
								<option key={option.value} value={option.value}>
									{option.label}
								</option>
							))}
						</select>
					</div>
					<div className="ml-auto flex items-center gap-4">
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
			</PremiumCard>

			{/* Status Summary Pills */}
			{statusSummary.length > 0 && (
				<div
					className="flex flex-wrap gap-2 animate-in fade-in slide-in-from-bottom-4 duration-500"
					style={{ animationDelay: "500ms", animationFillMode: "backwards" }}
				>
					{statusSummary.map(([label, count], index) => (
						<div
							key={`${index}-${label}`}
							className="flex items-center gap-2 rounded-full border border-border/50 bg-card/30 backdrop-blur-sm px-4 py-2 text-sm"
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

			{/* History Table */}
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "600ms", animationFillMode: "backwards" }}
			>
				<HistoryTable
					groups={paginatedGroups}
					loading={isLoading}
					emptyMessage={emptyMessage}
					groupingEnabled={groupByDownload}
					serviceMap={serviceMap}
				/>
			</div>
		</section>
	);
};
