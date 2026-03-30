"use client";

import type { HealthIssue, QueueItem } from "@arr/shared";
import { motion } from "framer-motion";
import {
	Activity,
	AlertCircle,
	AlertTriangle,
	BookOpen,
	ChevronDown,
	ChevronRight,
	Film,
	ListOrdered,
	Music,
	RefreshCw,
	Search,
	Server,
	Tv,
	Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, lazy, useCallback, useMemo, useState } from "react";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import { springs } from "../../../components/motion";
import { QueueFilters, ServiceInstancesTable } from "../../../components/presentational";
import {
	Alert,
	AlertDescription,
	AlertTitle,
	Button,
	EmptyState,
	Pagination,
	Typography,
} from "../../../components/ui";
import { useDashboardStatisticsQuery } from "../../../hooks/api/useDashboard";
import { useNowPlaying } from "../../../hooks/api/usePlex";
import { useTautulliActivity } from "../../../hooks/api/useTautulli";
import { useRefreshState } from "../../../hooks/useRefreshState";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { anonymizeHealthMessage, getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { POLLING_REALTIME, POLLING_STANDARD } from "../../../lib/polling-intervals";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { cn } from "../../../lib/utils";
const ManualImportModal = lazy(() => import("../../manual-import/components/manual-import-modal"));
import { useQueueGrouping } from "../hooks";
import { useDashboardData } from "../hooks/useDashboardData";
import { useDashboardFilters } from "../hooks/useDashboardFilters";
import { useDashboardQueue } from "../hooks/useDashboardQueue";
import { CacheHealthBanner } from "./cache-health-banner";
import { type DashboardTab, DashboardTabs } from "./dashboard-tabs";
import { NowPlayingWidget } from "./now-playing-widget";
import { OnDeckWidget } from "./on-deck-widget";
import { PlexServerInfoWidget } from "./plex-server-info-widget";
import { QueueTable } from "./queue-table";
import { RecentlyAddedWidget } from "./recently-added-widget";
import { SeerrRequestsWidget } from "./seerr-requests-widget";
import { WatchHistorySection } from "./watch-history-section";

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
	lidarr: { ...SERVICE_GRADIENTS.lidarr, icon: Music, label: "Lidarr" },
	readarr: { ...SERVICE_GRADIENTS.readarr, icon: BookOpen, label: "Readarr" },
} as const;

/** Build a human-readable health warning string from the issues list */
function formatHealthWarning(
	count: number | undefined,
	issues: HealthIssue[] | undefined,
): string | undefined {
	if (!count) return undefined;
	const first = issues?.[0];
	if (count === 1 && first) return first.message;
	return `${count} health issue${count !== 1 ? "s" : ""}`;
}

/**
 * Animated Service Stat Card
 * Premium stat card with service-specific or theme-based styling
 */
const ServiceStatCard = ({
	service,
	value,
	description,
	subtitle,
	detail,
	warningLine,
	healthWarning,
	onClick,
	isQueue = false,
	animationDelay = 0,
	themeGradient,
}: {
	service: keyof typeof SERVICE_CONFIG | "queue";
	value: number;
	description: string;
	subtitle?: string;
	detail?: string;
	warningLine?: string;
	healthWarning?: string;
	onClick?: () => void;
	isQueue?: boolean;
	animationDelay?: number;
	themeGradient?: { from: string; to: string; glow: string };
}) => {
	// Use theme gradient for queue, service-specific for others
	const config =
		isQueue && themeGradient
			? { ...themeGradient, icon: ListOrdered, label: "Queue" }
			: service !== "queue"
				? SERVICE_CONFIG[service]
				: {
						from: SEMANTIC_COLORS.success.from,
						to: SEMANTIC_COLORS.success.to,
						glow: SEMANTIC_COLORS.success.glow,
						icon: ListOrdered,
						label: "Queue",
					};

	const Icon = config.icon;
	const hasItems = isQueue && value > 0;

	return (
		<motion.button
			type="button"
			onClick={onClick}
			disabled={!onClick}
			className={cn(
				"group relative overflow-hidden rounded-2xl border border-border/50 bg-card/50 p-6 text-left transition-colors duration-300",
				onClick && "cursor-pointer hover:border-border",
				!onClick && "cursor-default",
			)}
			initial={{ opacity: 0, y: 20 }}
			animate={{ opacity: 1, y: 0 }}
			transition={{
				...springs.soft,
				delay: animationDelay / 1000,
			}}
			whileHover={
				onClick
					? {
							y: -4,
							scale: 1.02,
							boxShadow: `0 20px 40px -12px ${config.glow}`,
							transition: springs.soft,
						}
					: undefined
			}
			whileTap={
				onClick
					? {
							scale: 0.98,
							transition: springs.quick,
						}
					: undefined
			}
		>
			{/* Ambient glow on hover */}
			<div
				className={cn(
					"pointer-events-none absolute -inset-4 opacity-0 blur-2xl transition-opacity duration-500",
					onClick && "group-hover:opacity-40",
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
					<div className="relative">
						<div
							className={cn(
								"flex h-12 w-12 items-center justify-center rounded-xl transition-all duration-300",
								onClick && "group-hover:scale-110",
							)}
							style={{
								background: `linear-gradient(135deg, ${config.from}, ${config.to})`,
								boxShadow: `0 8px 24px -8px ${config.glow}`,
							}}
						>
							<Icon className="h-6 w-6 text-white" />
						</div>

						{/* Health issue dot indicator */}
						{healthWarning && (
							<div
								className="absolute -top-0.5 -right-0.5 h-2.5 w-2.5 rounded-full"
								style={{
									backgroundColor: SEMANTIC_COLORS.error.text,
									boxShadow: `0 0 6px ${SEMANTIC_COLORS.error.glow}`,
								}}
							/>
						)}
					</div>

					{/* Arrow indicator for clickable cards */}
					{onClick && (
						<ChevronRight
							className={cn(
								"h-5 w-5 text-muted-foreground transition-all duration-300",
								"opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0",
							)}
						/>
					)}
				</div>

				{/* Value with animated counter effect */}
				<div className="mb-1">
					<span
						className={cn(
							"text-4xl font-bold tracking-tight transition-all duration-300",
							onClick && "group-hover:translate-x-1",
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
				<p className="mt-1 text-xs text-muted-foreground">{description}</p>

				{/* Subtitle — stat detail line */}
				{subtitle && <p className="mt-1 text-xs text-muted-foreground/80">{subtitle}</p>}

				{/* Warning line — missing items indicator */}
				{warningLine && (
					<p className="mt-1 text-xs font-medium" style={{ color: SEMANTIC_COLORS.warning.text }}>
						{warningLine}
					</p>
				)}

				{/* Health warning — links to /statistics for full details */}
				{healthWarning && (
					<Link
						href="/statistics"
						onClick={(e) => e.stopPropagation()}
						className="mt-1 flex items-center gap-1 text-xs font-medium hover:underline"
						style={{ color: SEMANTIC_COLORS.error.text }}
					>
						<AlertTriangle className="h-3 w-3 flex-shrink-0" />
						{healthWarning}
					</Link>
				)}

				{/* Detail — instance count note */}
				{detail && <p className="mt-1.5 text-xs text-muted-foreground/50">{detail}</p>}

				{/* Active indicator line */}
				<div
					className={cn(
						"absolute bottom-0 left-0 h-0.5 transition-all duration-500",
						onClick ? "w-0 group-hover:w-full" : "w-8",
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
	const [instancesExpanded, setInstancesExpanded] = useState(false);
	const router = useRouter();

	// Get the user's selected color theme
	const { gradient: themeGradient } = useThemeGradient();

	// Statistics data
	const statsQuery = useDashboardStatisticsQuery();
	const stats = statsQuery.data;

	// Data hooks
	const {
		currentUser,
		userLoading: _userLoading,
		userError,
		services,
		enabledServices,
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

	// Find first enabled Seerr instance for dashboard widget
	const seerrInstance = useMemo(
		() => services.find((s) => s.service.toLowerCase() === "seerr" && s.enabled),
		[services],
	);

	// Detect Plex/Tautulli instances for Now Playing widget
	const hasPlexInstances = useMemo(
		() => services.some((s) => s.service.toLowerCase() === "plex" && s.enabled),
		[services],
	);
	const hasTautulliInstances = useMemo(
		() => services.some((s) => s.service.toLowerCase() === "tautulli" && s.enabled),
		[services],
	);
	const hasMediaServer = hasPlexInstances || hasTautulliInstances;

	// Session count for Activity tab badge
	const isMediaTab = activeTab === "overview" || activeTab === "activity";
	const plexNowPlaying = useNowPlaying(hasPlexInstances, isMediaTab ? POLLING_REALTIME : POLLING_STANDARD);
	const tautulliActivity = useTautulliActivity(hasTautulliInstances, isMediaTab ? POLLING_REALTIME : POLLING_STANDARD);
	const sessionCount = useMemo(() => {
		if (!hasMediaServer) return undefined;
		const plexCount = plexNowPlaying.data?.sessions?.length ?? 0;
		const tautulliCount = tautulliActivity.data?.sessions?.length ?? 0;
		// Use max (they overlap — Tautulli monitors same Plex)
		return Math.max(plexCount, tautulliCount);
	}, [hasMediaServer, plexNowPlaying.data, tautulliActivity.data]);

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

	// Manual import handler - extracts first item and opens modal (memoized)
	const handleManualImport = useCallback(
		(items: QueueItem[]) => {
			const [first] = items;
			if (first) {
				openManualImport(first);
			}
		},
		[openManualImport],
	);

	// Refresh handler with animation
	const refetchAll = useCallback(
		() => Promise.all([servicesRefetch(), queueRefetch()]),
		[servicesRefetch, queueRefetch],
	);
	const [isRefreshing, handleRefresh] = useRefreshState(refetchAll);

	if (isLoading) {
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

	// Calculate total enabled instances
	const totalInstances = enabledServices.length;

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
								Hi, {incognitoMode ? getLinuxUsername(currentUser.username) : currentUser.username}
							</span>
						</h1>
						<p className="text-muted-foreground max-w-xl">
							Your media server command center. {totalInstances} active instance
							{totalInstances !== 1 ? "s" : ""}
							{totalInstances === 0 && services.length > 0 ? ` (${services.length} disabled)` : ""}
							{totalQueueItems > 0 && (
								<span className="font-medium" style={{ color: themeGradient.from }}>
									{" "}
									with {totalQueueItems} items in queue
								</span>
							)}
						</p>
					</div>

					<Button
						variant="secondary"
						onClick={() => void handleRefresh()}
						className={cn(
							"relative overflow-hidden transition-all duration-300",
							isRefreshing && "pointer-events-none",
						)}
					>
						<RefreshCw
							className={cn(
								"h-4 w-4 mr-2 transition-transform duration-500",
								isRefreshing && "animate-spin",
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

			{/* Cache Health Banner */}
			<CacheHealthBanner enabled={hasMediaServer} />

			{/* Tabs */}
			<DashboardTabs
				activeTab={activeTab}
				onTabChange={setActiveTab}
				queueCount={totalQueueItems}
				sessionCount={sessionCount}
				themeGradient={themeGradient}
			/>

			{/* Tab Content */}
			<div className="relative min-h-[400px]">
				{/* Overview Tab */}
				{activeTab === "overview" && (
					<div className="flex flex-col gap-10 animate-in fade-in duration-300">
						{/* Service Stats Grid — enriched with real statistics */}
						<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
							{(Object.keys(SERVICE_CONFIG) as (keyof typeof SERVICE_CONFIG)[])
								.filter((key) => (groupedByService[key] ?? 0) > 0)
								.map((key, index) => {
									const instanceCount = groupedByService[key] ?? 0;
									const instanceNote = `${instanceCount} instance${instanceCount !== 1 ? "s" : ""}`;
									let statValue = instanceCount;
									let description = "";
									let subtitle: string | undefined;
									let warningLine: string | undefined;
									let healthWarning: string | undefined;
									let cardOnClick: (() => void) | undefined;

									if (key === "sonarr" && stats?.sonarr?.aggregate) {
										const agg = stats.sonarr.aggregate;
										statValue = agg.totalSeries;
										description = "TV series";
										const parts = [
											`${agg.monitoredSeries} monitored`,
											`${Math.round(agg.downloadedPercentage)}% downloaded`,
										];
										if (agg.recentlyAdded7Days)
											parts.push(`${agg.recentlyAdded7Days} new this week`);
										subtitle = parts.join(" · ");
										if (agg.missingEpisodes > 0)
											warningLine = `${agg.missingEpisodes} missing episode${agg.missingEpisodes !== 1 ? "s" : ""}`;
										healthWarning = formatHealthWarning(agg.healthIssues, agg.healthIssuesList);
										cardOnClick = () => router.push("/library?service=sonarr");
									} else if (key === "radarr" && stats?.radarr?.aggregate) {
										const agg = stats.radarr.aggregate;
										statValue = agg.totalMovies;
										description = "Movies";
										const parts = [
											`${agg.monitoredMovies} monitored`,
											`${Math.round(agg.downloadedPercentage)}% downloaded`,
										];
										if (agg.recentlyAdded7Days)
											parts.push(`${agg.recentlyAdded7Days} new this week`);
										subtitle = parts.join(" · ");
										if (agg.missingMovies > 0)
											warningLine = `${agg.missingMovies} missing movie${agg.missingMovies !== 1 ? "s" : ""}`;
										healthWarning = formatHealthWarning(agg.healthIssues, agg.healthIssuesList);
										cardOnClick = () => router.push("/library?service=radarr");
									} else if (key === "prowlarr" && stats?.prowlarr?.aggregate) {
										const agg = stats.prowlarr.aggregate;
										statValue = agg.totalIndexers;
										description = "Indexers";
										subtitle = `${agg.activeIndexers} active · ${agg.pausedIndexers} paused`;
										healthWarning = formatHealthWarning(agg.healthIssues, agg.healthIssuesList);
										cardOnClick = () => router.push("/indexers");
									} else if (key === "lidarr" && stats?.lidarr?.aggregate) {
										const agg = stats.lidarr.aggregate;
										statValue = agg.totalArtists;
										description = "Artists";
										const parts = [
											`${agg.monitoredArtists} monitored`,
											`${Math.round(agg.downloadedPercentage)}% downloaded`,
										];
										if (agg.recentlyAdded7Days)
											parts.push(`${agg.recentlyAdded7Days} new this week`);
										subtitle = parts.join(" · ");
										if (agg.missingTracks > 0)
											warningLine = `${agg.missingTracks} missing track${agg.missingTracks !== 1 ? "s" : ""}`;
										healthWarning = formatHealthWarning(agg.healthIssues, agg.healthIssuesList);
										cardOnClick = () => router.push("/library?service=lidarr");
									} else if (key === "readarr" && stats?.readarr?.aggregate) {
										const agg = stats.readarr.aggregate;
										statValue = agg.totalAuthors;
										description = "Authors";
										const parts = [
											`${agg.monitoredAuthors} monitored`,
											`${Math.round(agg.downloadedPercentage)}% downloaded`,
										];
										if (agg.recentlyAdded7Days)
											parts.push(`${agg.recentlyAdded7Days} new this week`);
										subtitle = parts.join(" · ");
										if (agg.missingBooks > 0)
											warningLine = `${agg.missingBooks} missing book${agg.missingBooks !== 1 ? "s" : ""}`;
										healthWarning = formatHealthWarning(agg.healthIssues, agg.healthIssuesList);
										cardOnClick = () => router.push("/library?service=readarr");
									} else {
										const fallbacks: Record<keyof typeof SERVICE_CONFIG, string> = {
											sonarr: "Active TV show instances",
											radarr: "Active movie instances",
											lidarr: "Active music instances",
											readarr: "Active book instances",
											prowlarr: "Indexer management instances",
										};
										description = fallbacks[key];
									}

									return (
										<ServiceStatCard
											key={key}
											service={key}
											value={statValue}
											description={description}
											subtitle={subtitle}
											warningLine={warningLine}
											healthWarning={healthWarning ? (incognitoMode ? anonymizeHealthMessage(healthWarning) : healthWarning) : undefined}
											detail={instanceNote}
											onClick={cardOnClick}
											animationDelay={100 + index * 50}
										/>
									);
								})}
							<ServiceStatCard
								service="queue"
								value={totalQueueItems}
								description="Items across all queues"
								onClick={() => setActiveTab("queue")}
								isQueue
								animationDelay={100 + Object.keys(groupedByService).length * 50}
								themeGradient={themeGradient}
							/>
						</div>

						{/* Two-column widget grid for media widgets + storage */}
						{(seerrInstance || hasMediaServer || stats?.combinedDisk) && (
							<div className="grid gap-6 lg:grid-cols-2">
								{/* Left column */}
								<div className="space-y-6">
									{seerrInstance && (
										<SeerrRequestsWidget instanceId={seerrInstance.id} animationDelay={400} />
									)}
									{hasMediaServer && sessionCount !== undefined && sessionCount > 0 && (
										<NowPlayingWidget
											hasPlexInstances={hasPlexInstances}
											hasTautulliInstances={hasTautulliInstances}
											animationDelay={450}
											variant="compact"
										/>
									)}
								</div>
								{/* Right column */}
								<div className="space-y-6">
									<PlexServerInfoWidget
										enabled={hasPlexInstances}
										animationDelay={475}
										variant="compact"
									/>
								</div>
							</div>
						)}

						{/* Full-width media carousels */}
						<OnDeckWidget enabled={hasPlexInstances} animationDelay={500} />
						<RecentlyAddedWidget enabled={hasPlexInstances} animationDelay={525} />

						{/* Configured Instances Section — collapsible */}
						<div
							className="animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "550ms", animationFillMode: "backwards" }}
						>
							<div className="rounded-2xl border border-border/30 bg-muted/10 overflow-hidden">
								<button
									type="button"
									onClick={() => setInstancesExpanded((v) => !v)}
									className="w-full flex items-center justify-between gap-3 px-6 py-4 hover:bg-card/50 transition-colors duration-200"
								>
									<div className="flex items-center gap-3">
										<div
											className="flex h-10 w-10 items-center justify-center rounded-xl"
											style={{
												background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
												border: `1px solid ${themeGradient.from}30`,
											}}
										>
											<Server className="h-5 w-5" style={{ color: themeGradient.from }} />
										</div>
										<div className="text-left">
											<h2 className="text-lg font-semibold">Configured Instances</h2>
											{!instancesExpanded && enabledServices.length > 0 ? (
												<p className="text-sm text-muted-foreground">
													{enabledServices.length} active service
													{enabledServices.length !== 1 ? "s" : ""} across{" "}
													{[
														...new Set(
															enabledServices.map(
																(s) => s.service.charAt(0).toUpperCase() + s.service.slice(1),
															),
														),
													].join(", ")}
												</p>
											) : (
												<p className="text-sm text-muted-foreground">
													{enabledServices.length > 0
														? `${enabledServices.length} active service${enabledServices.length !== 1 ? "s" : ""}`
														: services.length > 0
															? `${services.length} instance${services.length !== 1 ? "s" : ""} disabled`
															: "No instances configured"}
												</p>
											)}
										</div>
									</div>
									<ChevronDown
										className={cn(
											"h-5 w-5 text-muted-foreground transition-transform duration-300",
											instancesExpanded && "rotate-180",
										)}
									/>
								</button>

								{instancesExpanded && (
									<div className="border-t border-border/50">
										<div className="p-6">
											{enabledServices.length === 0 ? (
												<div className="text-center py-12">
													<div
														className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full"
														style={{
															background: `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}10)`,
														}}
													>
														<Zap className="h-8 w-8" style={{ color: themeGradient.from }} />
													</div>
													{services.length > 0 ? (
														<>
															<h3 className="text-lg font-medium mb-1">All instances disabled</h3>
															<p className="text-sm text-muted-foreground max-w-sm mx-auto">
																Enable instances from the{" "}
																<Link
																	href="/settings"
																	className="underline hover:text-foreground transition-colors"
																>
																	Settings
																</Link>{" "}
																page to see them here.
															</p>
														</>
													) : (
														<>
															<h3 className="text-lg font-medium mb-1">No instances configured</h3>
															<p className="text-sm text-muted-foreground max-w-sm mx-auto">
																Add a Sonarr, Radarr, Lidarr, Readarr, or Prowlarr instance from{" "}
																<Link
																	href="/settings"
																	className="underline hover:text-foreground transition-colors"
																>
																	Settings
																</Link>{" "}
																to begin monitoring.
															</p>
														</>
													)}
												</div>
											) : (
												<ServiceInstancesTable
													instances={enabledServices}
													incognitoMode={incognitoMode}
												/>
											)}
										</div>
									</div>
								)}
							</div>
						</div>
					</div>
				)}

				{/* Queue Tab */}
				{activeTab === "queue" && (
					<div className="animate-in fade-in duration-300">
						<div className="rounded-2xl border border-border/30 bg-muted/10 overflow-hidden">
							<div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-border/50">
								<div className="flex items-center gap-3">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-xl"
										style={{
											background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
											boxShadow:
												totalQueueItems > 0 ? `0 8px 24px -8px ${themeGradient.glow}` : undefined,
										}}
									>
										<ListOrdered className="h-5 w-5 text-white" />
									</div>
									<div>
										<h2 className="text-lg font-semibold">Active Queue</h2>
										<p className="text-sm text-muted-foreground">
											Monitoring {queueInstances.length} instance
											{queueInstances.length === 1 ? "" : "s"}
										</p>
									</div>
								</div>

								<div className="flex items-center gap-3">
									{/* Problematic items link to Queue Cleaner */}
									{problematicCount > 0 && (
										<Button variant="secondary" size="sm" asChild className="gap-2">
											<Link href="/queue-cleaner">
												<AlertTriangle className="h-4 w-4 text-amber-500" />
												{problematicCount} Problematic
												<ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
											</Link>
										</Button>
									)}

									<Typography variant="caption" className="text-muted-foreground">
										Showing {paginatedRows.length} of {allSummaryRows.length} cards (
										{filteredItems.length} items)
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
									onManualImport={handleManualImport}
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

				{/* Activity Tab */}
				{activeTab === "activity" && hasMediaServer && (
					<div className="animate-in fade-in duration-300 space-y-6">
						<NowPlayingWidget
							hasPlexInstances={hasPlexInstances}
							hasTautulliInstances={hasTautulliInstances}
							variant="full"
						/>
						<OnDeckWidget enabled={hasPlexInstances} animationDelay={100} />
						<WatchHistorySection enabled={hasTautulliInstances} />
					</div>
				)}
			</div>

			{manualImportContext.open && (
				<Suspense fallback={null}>
					<ManualImportModal
						instanceId={manualImportContext.instanceId}
						instanceName={manualImportContext.instanceName}
						service={manualImportContext.service}
						downloadId={manualImportContext.downloadId}
						open={manualImportContext.open}
						onOpenChange={handleManualImportOpenChange}
						onCompleted={handleManualImportCompleted}
					/>
				</Suspense>
			)}
		</>
	);
};
