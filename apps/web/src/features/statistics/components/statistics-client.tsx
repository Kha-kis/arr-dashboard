"use client";

import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription } from "../../../components/ui";
import { PremiumSkeleton } from "../../../components/layout";
import { useStatisticsData } from "../hooks/useStatisticsData";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { cn } from "../../../lib/utils";
import { BarChart3, Tv, Film, Globe, RefreshCw, Music, BookOpen } from "lucide-react";
import { OverviewTab } from "./overview-tab";
import { ArrServiceTab } from "./arr-service-tab";
import { ProwlarrTab } from "./prowlarr-tab";
import type { StatisticsTab } from "./statistics-tabs";

export const StatisticsClient = () => {
	const [activeTab, setActiveTab] = useState<StatisticsTab>("overview");
	const [isRefreshing, setIsRefreshing] = useState(false);
	const { gradient: themeGradient } = useThemeGradient();

	const {
		isLoading,
		isFetching,
		error,
		refetch,
		sonarrRows,
		radarrRows,
		prowlarrRows,
		lidarrRows,
		readarrRows,
		sonarrTotals,
		radarrTotals,
		prowlarrTotals,
		lidarrTotals,
		readarrTotals,
		combinedDisk,
		allHealthIssues,
	} = useStatisticsData();

	const handleRefresh = async () => {
		setIsRefreshing(true);
		await refetch();
		setTimeout(() => setIsRefreshing(false), 500);
	};

	const tabs: Array<{ id: StatisticsTab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number; gradient?: { from: string; to: string; glow: string } }> = [
		{ id: "overview", label: "Overview", icon: BarChart3 },
		{ id: "sonarr", label: "Sonarr", icon: Tv, count: sonarrRows.length, gradient: SERVICE_GRADIENTS.sonarr },
		{ id: "radarr", label: "Radarr", icon: Film, count: radarrRows.length, gradient: SERVICE_GRADIENTS.radarr },
		{ id: "lidarr", label: "Lidarr", icon: Music, count: lidarrRows.length, gradient: SERVICE_GRADIENTS.lidarr },
		{ id: "readarr", label: "Readarr", icon: BookOpen, count: readarrRows.length, gradient: SERVICE_GRADIENTS.readarr },
		{ id: "prowlarr", label: "Prowlarr", icon: Globe, count: prowlarrRows.length, gradient: SERVICE_GRADIENTS.prowlarr },
	];

	// Loading skeleton
	if (isLoading) {
		return (
			<div className="space-y-8 animate-in fade-in duration-500">
				<div className="space-y-4">
					<PremiumSkeleton variant="line" className="h-8 w-48" />
					<PremiumSkeleton variant="line" className="h-10 w-64" />
				</div>
				<div className="grid gap-4 md:grid-cols-4">
					{[0, 1, 2, 3].map((i) => (
						<div
							key={i}
							className="rounded-2xl border border-border/30 bg-card/30 p-6"
						>
							<PremiumSkeleton variant="circle" className="h-12 w-12 rounded-xl mb-4" style={{ animationDelay: `${i * 50}ms` }} />
							<PremiumSkeleton variant="line" className="h-8 w-16 mb-2" style={{ animationDelay: `${i * 50 + 25}ms` }} />
							<PremiumSkeleton variant="line" className="h-4 w-24" style={{ animationDelay: `${i * 50 + 50}ms` }} />
						</div>
					))}
				</div>
			</div>
		);
	}

	return (
		<>
			{/* Header */}
			<header
				className="relative animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationFillMode: "backwards" }}
			>
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<BarChart3 className="h-4 w-4" />
							<span>Systems Overview</span>
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
								Statistics
							</span>
						</h1>
						<p className="text-muted-foreground max-w-xl">
							Aggregated health and library metrics across all configured instances
						</p>
					</div>

					<Button
						variant="secondary"
						onClick={() => void handleRefresh()}
						disabled={isFetching}
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

			{/* Tab Navigation */}
			<div
				className="animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: "100ms", animationFillMode: "backwards" }}
			>
				<div className="inline-flex rounded-xl bg-card/30 backdrop-blur-xs border border-border/50 p-1.5">
					{tabs.map((tab) => {
						const Icon = tab.icon;
						const isActive = activeTab === tab.id;
						const gradient = tab.gradient ?? themeGradient;

						return (
							<button
								key={tab.id}
								type="button"
								onClick={() => setActiveTab(tab.id)}
								className={cn(
									"relative flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg transition-all duration-300",
									isActive ? "text-white" : "text-muted-foreground hover:text-foreground"
								)}
							>
								{isActive && (
									<div
										className="absolute inset-0 rounded-lg"
										style={{
											background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
											boxShadow: `0 4px 12px -4px ${gradient.glow}`,
										}}
									/>
								)}
								<Icon className={cn("h-4 w-4 relative z-10", !isActive && "opacity-70")} />
								<span className="relative z-10">{tab.label}</span>
								{tab.count !== undefined && (
									<span
										className={cn(
											"relative z-10 ml-1 px-2 py-0.5 rounded-full text-xs font-medium",
											isActive
												? "bg-white/20 text-white"
												: "bg-muted/50 text-muted-foreground"
										)}
									>
										{tab.count}
									</span>
								)}
							</button>
						);
					})}
				</div>
			</div>

			{/* Error Alert */}
			{error && (
				<Alert variant="danger">
					<AlertDescription>
						Unable to refresh one or more instances. Showing last known values.
					</AlertDescription>
				</Alert>
			)}

			{/* Tab Content */}
			{activeTab === "overview" && (
				<OverviewTab
					allHealthIssues={allHealthIssues}
					combinedDisk={combinedDisk}
					sonarrRows={sonarrRows}
					radarrRows={radarrRows}
					lidarrRows={lidarrRows}
					readarrRows={readarrRows}
					prowlarrRows={prowlarrRows}
					sonarrTotals={sonarrTotals}
					radarrTotals={radarrTotals}
					lidarrTotals={lidarrTotals}
					readarrTotals={readarrTotals}
					prowlarrTotals={prowlarrTotals}
					onSwitchTab={setActiveTab}
				/>
			)}

			{activeTab === "sonarr" && (
				<ArrServiceTab serviceType="sonarr" icon={Tv} gradient={SERVICE_GRADIENTS.sonarr} totals={sonarrTotals} rows={sonarrRows} />
			)}

			{activeTab === "radarr" && (
				<ArrServiceTab serviceType="radarr" icon={Film} gradient={SERVICE_GRADIENTS.radarr} totals={radarrTotals} rows={radarrRows} />
			)}

			{activeTab === "lidarr" && (
				<ArrServiceTab serviceType="lidarr" icon={Music} gradient={SERVICE_GRADIENTS.lidarr} totals={lidarrTotals} rows={lidarrRows} />
			)}

			{activeTab === "readarr" && (
				<ArrServiceTab serviceType="readarr" icon={BookOpen} gradient={SERVICE_GRADIENTS.readarr} totals={readarrTotals} rows={readarrRows} />
			)}

			{activeTab === "prowlarr" && (
				<ProwlarrTab prowlarrTotals={prowlarrTotals} prowlarrRows={prowlarrRows} />
			)}
		</>
	);
};
