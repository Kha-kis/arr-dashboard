"use client";

import { useMemo, useState, useEffect } from "react";
import { motion } from "framer-motion";
import type { ServiceInstanceSummary, QueueItem } from "@arr/shared";
import {
	Button,
	Alert,
	AlertTitle,
	AlertDescription,
	EmptyState,
	Pagination,
	Typography,
} from "../../../components/ui";
import { Section } from "../../../components/layout";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import {
	AlertCircle,
	AlertTriangle,
	RefreshCw,
	Tv,
	Film,
	Search,
	ListOrdered,
	Activity,
	Zap,
	Server,
	ChevronRight
} from "lucide-react";
import { springs } from "../../../components/motion";
import { QueueTable } from "./queue-table";
import { DashboardTabs, type DashboardTab } from "./dashboard-tabs";
import ManualImportModal from "../../manual-import/components/manual-import-modal";
import { BulkClearModal } from "./bulk-clear-modal";
import { ServiceInstancesTable, QueueFilters } from "../../../components/presentational";
import { useDashboardData } from "../hooks/useDashboardData";
import { useDashboardFilters } from "../hooks/useDashboardFilters";
import { useDashboardQueue } from "../hooks/useDashboardQueue";
import { useQueueGrouping } from "../hooks";
import { filterProblematicItems } from "../lib/queue-utils";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import { useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { cn } from "../../../lib/utils";

/** Map of instanceId to baseUrl for linking to instances */
export type InstanceUrlMap = Map<string, string>;

/**
 * Service-specific config combining imported gradients with icons
 * Icons are kept local since they're component-specific imports
 */
const SERVICE_CONFIG = {
	sonarr: { ...SERVICE_GRADIENTS.sonarr, icon: Tv, label: "Sonarr" },
	radarr: { ...SERVICE_GRADIENTS.radarr, icon: Film, label: "Radarr" },
	prowlarr: { ...SERVICE_GRADIENTS.prowlarr, icon: Search, label: "Prowlarr" },
} as const;

/**
 * Animated Service Stat Card
 * Premium stat card with service-specific or theme-based styling
 */
const ServiceStatCard = ({
	service,
	value,
	description,
	onClick,
	isQueue = false,
	animationDelay = 0,
	themeGradient,
}: {
	service: keyof typeof SERVICE_CONFIG | "queue";
	value: number;
	description: string;
	onClick?: () => void;
	isQueue?: boolean;
	animationDelay?: number;
	themeGradient?: { from: string; to: string; glow: string };
}) => {
	// Use theme gradient for queue, service-specific for others
	const config = isQueue && themeGradient
		? { ...themeGradient, icon: ListOrdered, label: "Queue" }
		: service !== "queue"
			? SERVICE_CONFIG[service]
			: { from: SEMANTIC_COLORS.success.from, to: SEMANTIC_COLORS.success.to, glow: SEMANTIC_COLORS.success.glow, icon: ListOrdered, label: "Queue" };

	const Icon = config.icon;
	const hasItems = isQueue && value > 0;

	return (
		<motion.button
			type="button"
			onClick={onClick}
			disabled={!onClick}
			className={cn(
				"group relative overflow-hidden rounded-2xl border border-border/50 bg-card/50 backdrop-blur-xs p-6 text-left transition-colors duration-300",
				onClick && "cursor-pointer hover:border-border",
				!onClick && "cursor-default"
			)}
			initial={{ opacity: 0, y: 20 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{
				...springs.soft,
				delay: animationDelay / 1000,
			}}
			whileHover={onClick ? {
				y: -4,
				scale: 1.02,
				boxShadow: `0 20px 40px -12px ${config.glow}`,
				transition: springs.soft,
			} : undefined}
			whileTap={onClick ? {
				scale: 0.98,
				transition: springs.quick,
			} : undefined}
		>
			{/* Ambient glow on hover */}
			<div
				className={cn(
					"pointer-events-none absolute -inset-4 opacity-0 blur-2xl transition-opacity duration-500",
					onClick && "group-hover:opacity-40"
				)}
				style={{ backgroundColor: config.glow }}
			/>

			{/* Pulse effect for queue with items */}
			{hasItems && (
				<div
					className="pointer-events-none absolute -inset-2 animate-ping rounded-2xl opacity-20"
					style={{
						backgroundColor: config.glow,
						animationDuration: "3s",
					}}
				/>
			)}

			<div className="relative">
				{/* Icon with gradient background */}
				<div className="mb-4 flex items-center justify-between">
					<div
						className={cn(
							"flex h-12 w-12 items-center justify-center rounded-xl transition-all duration-300",
							onClick && "group-hover:scale-110"
						)}
						style={{
							background: `linear-gradient(135deg, ${config.from}, ${config.to})`,
							boxShadow: `0 8px 24px -8px ${config.glow}`,
						}}
					>
						<Icon className="h-6 w-6 text-white" />
					</div>

					{/* Arrow indicator for clickable cards */}
					{onClick && (
						<ChevronRight
							className={cn(
								"h-5 w-5 text-muted-foreground transition-all duration-300",
								"opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0"
							)}
						/>
					)}
				</div>

				{/* Value with animated counter effect */}
				<div className="mb-1">
					<span
						className={cn(
							"text-4xl font-bold tracking-tight transition-all duration-300",
							onClick && "group-hover:translate-x-1"
						)}
						style={{
							background: `linear-gradient(135deg, ${config.from}, ${config.to})`,
							WebkitBackgroundClip: "text",
							WebkitTextFillColor: "transparent",
							backgroundClip: "text",
						}}
					>
						{value}
					</span>
				</div>

				{/* Label */}
				<p className="text-sm font-medium text-foreground uppercase tracking-wide">
					{config.label}
				</p>

				{/* Description */}
				<p className="mt-1 text-xs text-muted-foreground">
					{description}
				</p>

				{/* Active indicator line */}
				<div
					className={cn(
						"absolute bottom-0 left-0 h-0.5 transition-all duration-500",
						onClick ? "w-0 group-hover:w-full" : "w-8"
					)}
					style={{
						background: `linear-gradient(90deg, ${config.from}, ${config.to})`,
					}}
				/>
			</div>
		</motion.button>
	);
};

/**
 * Loading Skeleton with animated gradient
 */
const DashboardSkeleton = () => (
	<div className="space-y-8 animate-in fade-in duration-500">
		{/* Header skeleton */}
		<div className="space-y-4">
			<PremiumSkeleton variant="line" className="h-8 w-48" />
			<PremiumSkeleton variant="line" className="h-10 w-64" />
			<PremiumSkeleton variant="line" className="h-4 w-96" />
		</div>

		{/* Stats skeleton */}
		<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
			{Array.from({ length: 4 }).map((_, i) => (
				<PremiumSkeleton
					key={i}
					variant="card"
					className="h-40"
					style={{ animationDelay: `${i * 50}ms` }}
				/>
			))}
		</div>
	</div>
);

export const DashboardClient = () => {
	const [incognitoMode] = useIncognitoMode();
	const [activeTab, setActiveTab] = useState<DashboardTab>("overview");
	const [mounted, setMounted] = useState(false);
	const [isRefreshing, setIsRefreshing] = useState(false);
	const [bulkClearOpen, setBulkClearOpen] = useState(false);

	// Get the user's selected color theme
	const { gradient: themeGradient } = useThemeGradient();

	useEffect(() => {
		setMounted(true);
	}, []);

	// Data hooks
	const {
		currentUser,
		userLoading,
		userError,
		services,
		servicesRefetch,
		groupedByService,
		queueAggregated,
		queueInstances,
		totalQueueItems,
		queueLoading,
		queueRefetch,
		instanceOptions,
		statusOptions,
		isLoading,
	} = useDashboardData();

	// Filter hooks
	const filterState = useDashboardFilters(queueAggregated);

	// Group FILTERED items into summary rows
	const allSummaryRows = useQueueGrouping(filterState.filteredItems);

	// Build instanceId → baseUrl map
	const instanceUrlMap = useMemo<InstanceUrlMap>(() => {
		const map = new Map<string, string>();
		for (const service of services) {
			map.set(service.id, service.baseUrl);
		}
		return map;
	}, [services]);

	// Pagination
	const paginatedRows = useMemo(() => {
		const start = (filterState.page - 1) * filterState.pageSize;
		return allSummaryRows.slice(start, start + filterState.pageSize);
	}, [allSummaryRows, filterState.page, filterState.pageSize]);

	const paginatedItems = useMemo(() => {
		return paginatedRows.flatMap((row) => row.items);
	}, [paginatedRows]);

	// Destructure filter state
	const {
		serviceFilter,
		setServiceFilter,
		instanceFilter,
		setInstanceFilter,
		statusFilter,
		setStatusFilter,
		sortBy,
		setSortBy,
		page,
		setPage,
		pageSize,
		setPageSize,
		filteredItems,
		filtersActive,
		emptyMessage,
		resetFilters,
		problematicCount,
		SERVICE_FILTERS,
		SORT_OPTIONS,
	} = filterState;

	// Build enhanced status options with "Problematic" at the top
	const enhancedStatusOptions = useMemo(() => {
		const problematicOption = {
			value: "problematic",
			label: problematicCount > 0 ? `⚠ Problematic (${problematicCount})` : "⚠ Problematic",
		};
		return [problematicOption, ...statusOptions];
	}, [statusOptions, problematicCount]);

	// Queue action hooks
	const {
		handleQueueRetry,
		handleQueueRemove,
		handleQueueChangeCategory,
		queueActionsPending,
		queueActionsError,
		openManualImport,
		prefetchManualImport,
		manualImportContext,
		handleManualImportOpenChange,
		handleManualImportCompleted,
		queueMessage,
		clearQueueMessage,
	} = useDashboardQueue(queueRefetch);

	// Refresh handler with animation
	const handleRefresh = async () => {
		setIsRefreshing(true);
		await Promise.all([servicesRefetch(), queueRefetch()]);
		setTimeout(() => setIsRefreshing(false), 500);
	};

	// Get problematic items for bulk clear modal
	const problematicItems = useMemo(
		() => filterProblematicItems(queueAggregated),
		[queueAggregated]
	);

	// Bulk clear execute handler
	const handleBulkClearExecute = async (
		itemsToRemove: { item: QueueItem; options: QueueActionOptions }[],
		itemsToRetry: QueueItem[]
	) => {
		// Group items by options for efficient batching
		const optionsGroups = new Map<string, { items: QueueItem[]; options: QueueActionOptions }>();

		for (const { item, options } of itemsToRemove) {
			const key = JSON.stringify(options);
			const group = optionsGroups.get(key);
			if (group) {
				group.items.push(item);
			} else {
				optionsGroups.set(key, { items: [item], options });
			}
		}

		// Execute all remove operations in parallel
		const removePromises = Array.from(optionsGroups.values()).map(({ items, options }) =>
			handleQueueRemove(items, options)
		);

		// Execute retry operations
		const retryPromise = itemsToRetry.length > 0
			? handleQueueRetry(itemsToRetry)
			: Promise.resolve();

		await Promise.all([...removePromises, retryPromise]);

		// Refetch queue data
		await queueRefetch();
	};

	if (isLoading || !mounted) {
		return <DashboardSkeleton />;
	}

	if (userError) {
		return (
			<Alert variant="danger">
				<AlertTitle>Failed to load user session</AlertTitle>
				<AlertDescription>Please refresh the page and try again.</AlertDescription>
			</Alert>
		);
	}

	if (!currentUser) {
		return (
			<EmptyState
				icon={AlertCircle}
				title="Sign in required"
				description="You are not authenticated. Log in through the dashboard API to manage Sonarr, Radarr, and Prowlarr instances."
			/>
		);
	}

	// Calculate total instances
	const totalInstances = (groupedByService.sonarr ?? 0) + (groupedByService.radarr ?? 0) + (groupedByService.prowlarr ?? 0);

	return (
		<>
			{/* Header */}
			<header
				className="relative animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "0ms" }}
			>
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Activity className="h-4 w-4" />
							<span>Welcome back</span>
						</div>
						<h1 className="text-3xl font-bold tracking-tight">
							<span
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
									backgroundClip: "text",
								}}
							>
								Hi, {currentUser.username}
							</span>
						</h1>
						<p className="text-muted-foreground max-w-xl">
							Your media server command center. {totalInstances} instance{totalInstances !== 1 ? "s" : ""} configured
							{totalQueueItems > 0 && (
								<span
									className="font-medium"
									style={{ color: themeGradient.from }}
								>
									{" "}with {totalQueueItems} items in queue
								</span>
							)}
						</p>
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
			</header>

			{/* Tabs */}
			<DashboardTabs
				activeTab={activeTab}
				onTabChange={setActiveTab}
				queueCount={totalQueueItems}
				themeGradient={themeGradient}
			/>

			{/* Tab Content */}
			<div className="relative min-h-[400px]">
				{/* Overview Tab */}
				{activeTab === "overview" && (
					<div className="flex flex-col gap-10 animate-in fade-in duration-300">
						{/* Service Stats Grid */}
						<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
							<ServiceStatCard
								service="sonarr"
								value={groupedByService.sonarr ?? 0}
								description={
									(groupedByService.sonarr ?? 0) === 0
										? "No instances configured yet"
										: "Active TV show instances"
								}
								animationDelay={100}
							/>
							<ServiceStatCard
								service="radarr"
								value={groupedByService.radarr ?? 0}
								description={
									(groupedByService.radarr ?? 0) === 0
										? "No instances configured yet"
										: "Active movie instances"
								}
								animationDelay={200}
							/>
							<ServiceStatCard
								service="prowlarr"
								value={groupedByService.prowlarr ?? 0}
								description={
									(groupedByService.prowlarr ?? 0) === 0
										? "No instances configured yet"
										: "Indexer management instances"
								}
								animationDelay={300}
							/>
							<ServiceStatCard
								service="queue"
								value={totalQueueItems}
								description="Items across all queues"
								onClick={() => setActiveTab("queue")}
								isQueue
								animationDelay={400}
								themeGradient={themeGradient}
							/>
						</div>

						{/* Configured Instances Section */}
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "500ms", animationFillMode: "backwards" }}
						>
							<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden">
								<div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-xl"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
											border: `1px solid ${themeGradient.from}30`,
										}}
									>
										<Server className="h-5 w-5" style={{ color: themeGradient.from }} />
									</div>
									<div>
										<h2 className="text-lg font-semibold">Configured Instances</h2>
										<p className="text-sm text-muted-foreground">
											{services.length === 0
												? "Add your first instance to get started"
												: `${services.length} connected service${services.length !== 1 ? "s" : ""}`
											}
										</p>
									</div>
								</div>

								<div className="p-6">
									{services.length === 0 ? (
										<div className="text-center py-12">
											<div
												className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full"
												style={{
													background: `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}10)`,
												}}
											>
												<Zap className="h-8 w-8" style={{ color: themeGradient.from }} />
											</div>
											<h3 className="text-lg font-medium mb-1">No instances configured</h3>
											<p className="text-sm text-muted-foreground max-w-sm mx-auto">
												Add a Sonarr, Radarr, or Prowlarr instance from the Settings page to begin monitoring.
											</p>
										</div>
									) : (
										<ServiceInstancesTable instances={services} incognitoMode={incognitoMode} />
									)}
								</div>
							</div>
						</div>
					</div>
				)}

				{/* Queue Tab */}
				{activeTab === "queue" && (
					<div
						className="animate-in fade-in duration-300"
					>
						<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden">
							<div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-border/50">
								<div className="flex items-center gap-3">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-xl"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow: totalQueueItems > 0 ? `0 8px 24px -8px ${themeGradient.glow}` : undefined,
										}}
									>
										<ListOrdered className="h-5 w-5 text-white" />
									</div>
									<div>
										<h2 className="text-lg font-semibold">Active Queue</h2>
										<p className="text-sm text-muted-foreground">
											Monitoring {queueInstances.length} instance{queueInstances.length === 1 ? "" : "s"}
										</p>
									</div>
								</div>

								<div className="flex items-center gap-3">
									{/* Clear Problematic button */}
									{problematicCount > 0 && (
										<Button
											variant="secondary"
											size="sm"
											onClick={() => setBulkClearOpen(true)}
											className="gap-2"
										>
											<AlertTriangle className="h-4 w-4 text-amber-500" />
											Clear {problematicCount} Problematic
										</Button>
									)}

									<Typography variant="caption" className="text-muted-foreground">
										Showing {paginatedRows.length} of {allSummaryRows.length} cards ({filteredItems.length} items)
									</Typography>
								</div>
							</div>

							<div className="p-6 space-y-4">
								<QueueFilters
									serviceFilter={serviceFilter}
									onServiceFilterChange={(value) => setServiceFilter(value as typeof serviceFilter)}
									serviceOptions={SERVICE_FILTERS}
									instanceFilter={instanceFilter}
									onInstanceFilterChange={setInstanceFilter}
									instanceOptions={instanceOptions}
									statusFilter={statusFilter}
									onStatusFilterChange={setStatusFilter}
									statusOptions={enhancedStatusOptions}
									sortBy={sortBy}
									onSortChange={(value) => setSortBy(value as typeof sortBy)}
									sortOptions={SORT_OPTIONS}
									filtersActive={filtersActive}
									onReset={resetFilters}
								/>

								{queueMessage && (
									<Alert variant="success" dismissible onDismiss={clearQueueMessage}>
										<AlertDescription>{queueMessage.message}</AlertDescription>
									</Alert>
								)}
								{queueActionsError && (
									<Alert variant="danger">
										<AlertDescription>
											{queueActionsError.message ||
												"Failed to process the last queue action. Please try again."}
										</AlertDescription>
									</Alert>
								)}

								{allSummaryRows.length > 0 && (
									<Pagination
										currentPage={page}
										totalItems={allSummaryRows.length}
										pageSize={pageSize}
										onPageChange={setPage}
										onPageSizeChange={setPageSize}
										pageSizeOptions={[5, 10, 25, 50, 100]}
									/>
								)}

								<QueueTable
									items={paginatedItems}
									summaryRows={paginatedRows}
									instanceUrlMap={instanceUrlMap}
									loading={queueLoading}
									pending={queueActionsPending}
									onRetry={handleQueueRetry}
									onManualImport={(items) => {
										const [first] = items;
										if (first) {
											openManualImport(first);
										}
									}}
									onRemove={handleQueueRemove}
									onChangeCategory={handleQueueChangeCategory}
									onPrefetchManualImport={prefetchManualImport}
									emptyMessage={emptyMessage}
								/>

								{allSummaryRows.length > 0 && (
									<Pagination
										currentPage={page}
										totalItems={allSummaryRows.length}
										pageSize={pageSize}
										onPageChange={setPage}
										onPageSizeChange={setPageSize}
										pageSizeOptions={[5, 10, 25, 50, 100]}
									/>
								)}
							</div>
						</div>
					</div>
				)}
			</div>

			<ManualImportModal
				instanceId={manualImportContext.instanceId}
				instanceName={manualImportContext.instanceName}
				service={manualImportContext.service}
				downloadId={manualImportContext.downloadId}
				open={manualImportContext.open}
				onOpenChange={handleManualImportOpenChange}
				onCompleted={handleManualImportCompleted}
			/>

			<BulkClearModal
				open={bulkClearOpen}
				onOpenChange={setBulkClearOpen}
				items={problematicItems}
				onExecute={handleBulkClearExecute}
			/>
		</>
	);
};
