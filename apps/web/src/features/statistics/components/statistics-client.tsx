"use client";

import { useState, useEffect } from "react";
import type { ProwlarrIndexerStat } from "@arr/shared";
import { Button } from "../../../components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "../../../components/ui";
import { AmbientGlow, PremiumCard, StatCard } from "../../../components/layout";
import {
	useIncognitoMode,
	getLinuxIndexer,
	getLinuxInstanceName,
	anonymizeHealthMessage,
	getLinuxUrl,
} from "../../../lib/incognito";
import { useStatisticsData } from "../hooks/useStatisticsData";
import { QualityBreakdown } from "../../../components/presentational/quality-breakdown";
import { formatBytes, formatPercent, formatRuntime } from "../lib/formatters";
import { THEME_GRADIENTS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import { cn } from "../../../lib/utils";
import {
	BarChart3,
	Tv,
	Film,
	Globe,
	RefreshCw,
	AlertTriangle,
	CheckCircle2,
	HardDrive,
	ExternalLink,
	TrendingUp,
	Activity,
} from "lucide-react";

const integer = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 1,
});

type StatisticsTab = "overview" | "sonarr" | "radarr" | "prowlarr";

export const StatisticsClient = () => {
	const [mounted, setMounted] = useState(false);
	const [activeTab, setActiveTab] = useState<StatisticsTab>("overview");
	const [isRefreshing, setIsRefreshing] = useState(false);
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	useEffect(() => {
		setMounted(true);
	}, []);

	const {
		isLoading,
		isFetching,
		error,
		refetch,
		sonarrRows,
		radarrRows,
		prowlarrRows,
		sonarrTotals,
		radarrTotals,
		prowlarrTotals,
		combinedDisk,
		allHealthIssues,
	} = useStatisticsData();

	const [incognitoMode] = useIncognitoMode();

	const handleRefresh = async () => {
		setIsRefreshing(true);
		await refetch();
		setTimeout(() => setIsRefreshing(false), 500);
	};

	const tabs: Array<{ id: StatisticsTab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number; gradient?: { from: string; to: string; glow: string } }> = [
		{ id: "overview", label: "Overview", icon: BarChart3 },
		{ id: "sonarr", label: "Sonarr", icon: Tv, count: sonarrRows.length, gradient: SERVICE_GRADIENTS.sonarr },
		{ id: "radarr", label: "Radarr", icon: Film, count: radarrRows.length, gradient: SERVICE_GRADIENTS.radarr },
		{ id: "prowlarr", label: "Prowlarr", icon: Globe, count: prowlarrRows.length, gradient: SERVICE_GRADIENTS.prowlarr },
	];

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
					<div className="grid gap-4 md:grid-cols-4">
						{[0, 1, 2, 3].map((i) => (
							<div
								key={i}
								className="rounded-2xl border border-border/30 bg-card/30 p-6"
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

	return (
		<section className="relative flex flex-col gap-8">
			{/* Ambient background glow */}
			<AmbientGlow />

			{/* Header */}
			<header
				className="relative animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationFillMode: "backwards" }}
			>
				<div className="flex items-start justify-between gap-4">
					<div className="space-y-1">
						{/* Label with icon */}
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<BarChart3 className="h-4 w-4" />
							<span>Systems Overview</span>
						</div>

						{/* Gradient title */}
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

						{/* Description */}
						<p className="text-muted-foreground max-w-xl">
							Aggregated health and library metrics across all configured instances
						</p>
					</div>

					{/* Refresh Button */}
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
				<div className="inline-flex rounded-xl bg-card/30 backdrop-blur-sm border border-border/50 p-1.5">
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

			{/* Overview Tab */}
			{activeTab === "overview" && (
				<div className="flex flex-col gap-8">
					{/* Health Status */}
					{allHealthIssues.length > 0 ? (
						<PremiumCard
							title={`${allHealthIssues.length} Health ${allHealthIssues.length === 1 ? "Issue" : "Issues"} Detected`}
							description="Review and resolve issues across your instances"
							icon={AlertTriangle}
							gradientIcon
							animationDelay={200}
						>
							<div className="space-y-4">
								{allHealthIssues.map((issue, idx) => (
									<div
										key={`${issue.service}-${issue.instanceId}-${issue.type}-${issue.message}`}
										className={cn(
											"flex flex-col gap-3 p-4 rounded-xl bg-background/50 border border-border/50",
											idx < allHealthIssues.length - 1 && "mb-3"
										)}
									>
										<div className="flex items-start justify-between gap-4">
											<div className="flex items-center gap-3">
												<span
													className="px-2 py-1 rounded-lg text-xs font-medium uppercase"
													style={{
														background: `linear-gradient(135deg, ${SERVICE_GRADIENTS[issue.service as keyof typeof SERVICE_GRADIENTS]?.from ?? themeGradient.from}20, ${SERVICE_GRADIENTS[issue.service as keyof typeof SERVICE_GRADIENTS]?.to ?? themeGradient.to}20)`,
														color: SERVICE_GRADIENTS[issue.service as keyof typeof SERVICE_GRADIENTS]?.from ?? themeGradient.from,
													}}
												>
													{issue.service}
												</span>
												<span className="text-sm text-muted-foreground">
													{incognitoMode ? getLinuxInstanceName(issue.instanceName) : issue.instanceName}
												</span>
											</div>
											<a
												href={`${incognitoMode ? getLinuxUrl(issue.instanceBaseUrl) : issue.instanceBaseUrl}/system/status`}
												target="_blank"
												rel="noopener noreferrer"
												className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-border/50 bg-background/50 hover:bg-background transition-colors"
											>
												View
												<ExternalLink className="h-3 w-3" />
											</a>
										</div>
										<p className="text-sm">
											{incognitoMode ? anonymizeHealthMessage(issue.message) : issue.message}
										</p>
										{issue.source && (
											<p className="text-xs text-muted-foreground">Source: {issue.source}</p>
										)}
									</div>
								))}
							</div>
						</PremiumCard>
					) : (
						<div
							className="flex items-center gap-4 p-6 rounded-2xl border border-border/50 bg-emerald-500/10 backdrop-blur-sm animate-in fade-in slide-in-from-bottom-4 duration-500"
							style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
						>
							<div
								className="flex h-12 w-12 items-center justify-center rounded-xl"
								style={{
									background: "linear-gradient(135deg, #10b981, #059669)",
									boxShadow: "0 8px 24px -8px rgba(16, 185, 129, 0.5)",
								}}
							>
								<CheckCircle2 className="h-6 w-6 text-white" />
							</div>
							<div>
								<h3 className="text-lg font-semibold text-emerald-400">All Systems Healthy</h3>
								<p className="text-sm text-muted-foreground">
									No health issues detected across all configured instances
								</p>
							</div>
						</div>
					)}

					{/* Summary Stats Grid */}
					<div
						className="grid gap-4 md:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
					>
						<StatCard
							value={sonarrRows.length}
							label="Sonarr"
							description={`${sonarrTotals.totalSeries} series total`}
							icon={Tv}
							gradient={SERVICE_GRADIENTS.sonarr}
							onClick={() => setActiveTab("sonarr")}
							animationDelay={300}
						/>
						<StatCard
							value={radarrRows.length}
							label="Radarr"
							description={`${radarrTotals.totalMovies} movies total`}
							icon={Film}
							gradient={SERVICE_GRADIENTS.radarr}
							onClick={() => setActiveTab("radarr")}
							animationDelay={400}
						/>
						<StatCard
							value={prowlarrRows.length}
							label="Prowlarr"
							description={`${prowlarrTotals.totalIndexers} indexers total`}
							icon={Globe}
							gradient={SERVICE_GRADIENTS.prowlarr}
							onClick={() => setActiveTab("prowlarr")}
							animationDelay={500}
						/>
						<StatCard
							value={formatBytes(combinedDisk.diskUsed)}
							label="Storage"
							description={`of ${formatBytes(combinedDisk.diskTotal)} available`}
							icon={HardDrive}
							animationDelay={600}
						/>
					</div>

					{/* Service Quick Stats */}
					<div
						className="grid gap-6 lg:grid-cols-3 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "400ms", animationFillMode: "backwards" }}
					>
						{/* Sonarr Card */}
						<div className="group relative rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-6 overflow-hidden transition-all duration-300 hover:border-border">
							<div
								className="absolute inset-0 opacity-0 group-hover:opacity-20 transition-opacity duration-500"
								style={{ background: `radial-gradient(circle at 50% 0%, ${SERVICE_GRADIENTS.sonarr.glow}, transparent 70%)` }}
							/>
							<div className="relative">
								<div className="flex items-center gap-3 mb-4">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-xl"
										style={{
											background: `linear-gradient(135deg, ${SERVICE_GRADIENTS.sonarr.from}, ${SERVICE_GRADIENTS.sonarr.to})`,
											boxShadow: `0 4px 12px -4px ${SERVICE_GRADIENTS.sonarr.glow}`,
										}}
									>
										<Tv className="h-5 w-5 text-white" />
									</div>
									<h3 className="text-lg font-semibold">Sonarr</h3>
								</div>
								<div className="space-y-3">
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Series</span>
										<span className="font-medium">{integer.format(sonarrTotals.totalSeries)}</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Downloaded</span>
										<span className="font-medium" style={{ color: SERVICE_GRADIENTS.sonarr.from }}>
											{formatPercent(sonarrTotals.downloadPercent)}
										</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Missing</span>
										<span className="font-medium">{integer.format(sonarrTotals.missingEpisodes)}</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Disk Usage</span>
										<span className="font-medium">{formatPercent(sonarrTotals.diskPercent)}</span>
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									className="w-full mt-4 border border-border/50"
									onClick={() => setActiveTab("sonarr")}
								>
									View Details
								</Button>
							</div>
						</div>

						{/* Radarr Card */}
						<div className="group relative rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-6 overflow-hidden transition-all duration-300 hover:border-border">
							<div
								className="absolute inset-0 opacity-0 group-hover:opacity-20 transition-opacity duration-500"
								style={{ background: `radial-gradient(circle at 50% 0%, ${SERVICE_GRADIENTS.radarr.glow}, transparent 70%)` }}
							/>
							<div className="relative">
								<div className="flex items-center gap-3 mb-4">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-xl"
										style={{
											background: `linear-gradient(135deg, ${SERVICE_GRADIENTS.radarr.from}, ${SERVICE_GRADIENTS.radarr.to})`,
											boxShadow: `0 4px 12px -4px ${SERVICE_GRADIENTS.radarr.glow}`,
										}}
									>
										<Film className="h-5 w-5 text-white" />
									</div>
									<h3 className="text-lg font-semibold">Radarr</h3>
								</div>
								<div className="space-y-3">
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Movies</span>
										<span className="font-medium">{integer.format(radarrTotals.totalMovies)}</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Downloaded</span>
										<span className="font-medium" style={{ color: SERVICE_GRADIENTS.radarr.from }}>
											{formatPercent(radarrTotals.downloadPercent)}
										</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Missing</span>
										<span className="font-medium">{integer.format(radarrTotals.missingMovies)}</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Disk Usage</span>
										<span className="font-medium">{formatPercent(radarrTotals.diskPercent)}</span>
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									className="w-full mt-4 border border-border/50"
									onClick={() => setActiveTab("radarr")}
								>
									View Details
								</Button>
							</div>
						</div>

						{/* Prowlarr Card */}
						<div className="group relative rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-6 overflow-hidden transition-all duration-300 hover:border-border">
							<div
								className="absolute inset-0 opacity-0 group-hover:opacity-20 transition-opacity duration-500"
								style={{ background: `radial-gradient(circle at 50% 0%, ${SERVICE_GRADIENTS.prowlarr.glow}, transparent 70%)` }}
							/>
							<div className="relative">
								<div className="flex items-center gap-3 mb-4">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-xl"
										style={{
											background: `linear-gradient(135deg, ${SERVICE_GRADIENTS.prowlarr.from}, ${SERVICE_GRADIENTS.prowlarr.to})`,
											boxShadow: `0 4px 12px -4px ${SERVICE_GRADIENTS.prowlarr.glow}`,
										}}
									>
										<Globe className="h-5 w-5 text-white" />
									</div>
									<h3 className="text-lg font-semibold">Prowlarr</h3>
								</div>
								<div className="space-y-3">
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Indexers</span>
										<span className="font-medium">{integer.format(prowlarrTotals.totalIndexers)}</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Active</span>
										<span className="font-medium" style={{ color: SERVICE_GRADIENTS.prowlarr.from }}>
											{integer.format(prowlarrTotals.activeIndexers)}
										</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Total Queries</span>
										<span className="font-medium">{integer.format(prowlarrTotals.totalQueries)}</span>
									</div>
									<div className="flex justify-between text-sm">
										<span className="text-muted-foreground">Grab Rate</span>
										<span className="font-medium">{formatPercent(prowlarrTotals.grabRate)}</span>
									</div>
								</div>
								<Button
									variant="ghost"
									size="sm"
									className="w-full mt-4 border border-border/50"
									onClick={() => setActiveTab("prowlarr")}
								>
									View Details
								</Button>
							</div>
						</div>
					</div>
				</div>
			)}

			{/* Sonarr Tab */}
			{activeTab === "sonarr" && (
				<div className="flex flex-col gap-6">
					{/* Stats Grid */}
					<div
						className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
					>
						<StatCard value={sonarrTotals.totalSeries} label="Series" icon={Tv} gradient={SERVICE_GRADIENTS.sonarr} animationDelay={200} />
						<StatCard value={sonarrTotals.monitoredSeries} label="Monitored" icon={Activity} gradient={SERVICE_GRADIENTS.sonarr} animationDelay={250} />
						<StatCard value={sonarrTotals.continuingSeries} label="Continuing" icon={TrendingUp} gradient={SERVICE_GRADIENTS.sonarr} animationDelay={300} />
						<StatCard value={sonarrTotals.endedSeries} label="Ended" icon={CheckCircle2} gradient={SERVICE_GRADIENTS.sonarr} animationDelay={350} />
					</div>

					<div
						className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
					>
						<StatCard value={sonarrTotals.downloadedEpisodes} label="Downloaded" description="Episodes" animationDelay={400} />
						<StatCard value={sonarrTotals.missingEpisodes} label="Missing" description="Episodes" animationDelay={450} />
						<StatCard value={formatPercent(sonarrTotals.downloadPercent)} label="Complete" description="Download progress" animationDelay={500} />
						<StatCard value={sonarrTotals.cutoffUnmetCount} label="Cutoff Unmet" description="Eligible for upgrade" animationDelay={550} />
					</div>

					{/* Quality & Tags */}
					<div
						className="grid gap-6 lg:grid-cols-2 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "400ms", animationFillMode: "backwards" }}
					>
						<PremiumCard title="Quality Distribution" icon={BarChart3} gradientIcon={false} showHeader>
							<QualityBreakdown breakdown={sonarrTotals.qualityBreakdown} />
						</PremiumCard>
						{sonarrTotals.tagBreakdown && Object.keys(sonarrTotals.tagBreakdown).length > 0 && (
							<PremiumCard title="Tag Distribution" icon={BarChart3} gradientIcon={false} showHeader>
								<QualityBreakdown breakdown={sonarrTotals.tagBreakdown} />
							</PremiumCard>
						)}
					</div>

					{/* Instance Table */}
					<PremiumCard
						title="Instance Details"
						description="Per-instance breakdown of your Sonarr servers"
						icon={Tv}
						gradientIcon={false}
						animationDelay={500}
					>
						{sonarrRows.length === 0 ? (
							<p className="text-muted-foreground text-center py-8">No Sonarr instances configured.</p>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b border-border/50">
											<th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Instance</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Series</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Monitored</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Downloaded</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Missing</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Progress</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-border/30">
										{sonarrRows.map((row: any) => (
											<tr key={row.instanceId} className="hover:bg-muted/20 transition-colors">
												<td className="py-3 px-4 font-medium">
													{incognitoMode ? getLinuxInstanceName(row.instanceName) : row.instanceName}
												</td>
												<td className="py-3 px-4 text-right">{integer.format(row.totalSeries)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.monitoredSeries)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.downloadedEpisodes)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.missingEpisodes)}</td>
												<td className="py-3 px-4 text-right">
													<span style={{ color: SERVICE_GRADIENTS.sonarr.from }}>
														{formatPercent(row.downloadedPercentage)}
													</span>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</PremiumCard>
				</div>
			)}

			{/* Radarr Tab */}
			{activeTab === "radarr" && (
				<div className="flex flex-col gap-6">
					{/* Stats Grid */}
					<div
						className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
					>
						<StatCard value={radarrTotals.totalMovies} label="Movies" icon={Film} gradient={SERVICE_GRADIENTS.radarr} animationDelay={200} />
						<StatCard value={radarrTotals.monitoredMovies} label="Monitored" icon={Activity} gradient={SERVICE_GRADIENTS.radarr} animationDelay={250} />
						<StatCard value={radarrTotals.downloadedMovies} label="Downloaded" icon={CheckCircle2} gradient={SERVICE_GRADIENTS.radarr} animationDelay={300} />
						<StatCard value={radarrTotals.missingMovies} label="Missing" icon={AlertTriangle} gradient={SERVICE_GRADIENTS.radarr} animationDelay={350} />
					</div>

					<div
						className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
					>
						<StatCard value={formatPercent(radarrTotals.downloadPercent)} label="Complete" description="Download progress" animationDelay={400} />
						<StatCard value={radarrTotals.cutoffUnmetCount} label="Cutoff Unmet" description="Eligible for upgrade" animationDelay={450} />
						<StatCard value={formatBytes(radarrTotals.averageMovieSize)} label="Avg Size" description="Per movie" animationDelay={500} />
						<StatCard value={formatRuntime(radarrTotals.totalRuntime)} label="Runtime" description="Total duration" animationDelay={550} />
					</div>

					{/* Quality & Tags */}
					<div
						className="grid gap-6 lg:grid-cols-2 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "400ms", animationFillMode: "backwards" }}
					>
						<PremiumCard title="Quality Distribution" icon={BarChart3} gradientIcon={false} showHeader>
							<QualityBreakdown breakdown={radarrTotals.qualityBreakdown} />
						</PremiumCard>
						{radarrTotals.tagBreakdown && Object.keys(radarrTotals.tagBreakdown).length > 0 && (
							<PremiumCard title="Tag Distribution" icon={BarChart3} gradientIcon={false} showHeader>
								<QualityBreakdown breakdown={radarrTotals.tagBreakdown} />
							</PremiumCard>
						)}
					</div>

					{/* Instance Table */}
					<PremiumCard
						title="Instance Details"
						description="Per-instance breakdown of your Radarr servers"
						icon={Film}
						gradientIcon={false}
						animationDelay={500}
					>
						{radarrRows.length === 0 ? (
							<p className="text-muted-foreground text-center py-8">No Radarr instances configured.</p>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b border-border/50">
											<th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Instance</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Movies</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Monitored</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Downloaded</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Missing</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Progress</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-border/30">
										{radarrRows.map((row: any) => (
											<tr key={row.instanceId} className="hover:bg-muted/20 transition-colors">
												<td className="py-3 px-4 font-medium">
													{incognitoMode ? getLinuxInstanceName(row.instanceName) : row.instanceName}
												</td>
												<td className="py-3 px-4 text-right">{integer.format(row.totalMovies)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.monitoredMovies)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.downloadedMovies)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.missingMovies)}</td>
												<td className="py-3 px-4 text-right">
													<span style={{ color: SERVICE_GRADIENTS.radarr.from }}>
														{formatPercent(row.downloadedPercentage)}
													</span>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</PremiumCard>
				</div>
			)}

			{/* Prowlarr Tab */}
			{activeTab === "prowlarr" && (
				<div className="flex flex-col gap-6">
					{/* Stats Grid */}
					<div
						className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "200ms", animationFillMode: "backwards" }}
					>
						<StatCard value={prowlarrTotals.totalIndexers} label="Indexers" icon={Globe} gradient={SERVICE_GRADIENTS.prowlarr} animationDelay={200} />
						<StatCard value={prowlarrTotals.activeIndexers} label="Active" icon={CheckCircle2} gradient={SERVICE_GRADIENTS.prowlarr} animationDelay={250} />
						<StatCard value={prowlarrTotals.pausedIndexers} label="Paused" icon={AlertTriangle} gradient={SERVICE_GRADIENTS.prowlarr} animationDelay={300} />
						<StatCard
							value={prowlarrTotals.averageResponseTime ? `${percentFormatter.format(prowlarrTotals.averageResponseTime)} ms` : "-"}
							label="Avg Response"
							icon={Activity}
							gradient={SERVICE_GRADIENTS.prowlarr}
							animationDelay={350}
						/>
					</div>

					<div
						className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
						style={{ animationDelay: "300ms", animationFillMode: "backwards" }}
					>
						<StatCard value={prowlarrTotals.totalQueries} label="Queries" description="Total searches" animationDelay={400} />
						<StatCard value={prowlarrTotals.successfulQueries ?? "-"} label="Successful" description="Queries" animationDelay={450} />
						<StatCard value={prowlarrTotals.totalGrabs} label="Total Grabs" animationDelay={500} />
						<StatCard value={formatPercent(prowlarrTotals.grabRate)} label="Grab Rate" animationDelay={550} />
					</div>

					{/* Top Indexers */}
					{prowlarrTotals.indexers.length > 0 && (
						<PremiumCard
							title="Top Indexers"
							description="Performance breakdown by indexer"
							icon={TrendingUp}
							gradientIcon={false}
							animationDelay={400}
						>
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b border-border/50">
											<th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Name</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Queries</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Grabs</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Success Rate</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-border/30">
										{prowlarrTotals.indexers.map((indexer: ProwlarrIndexerStat, index: number) => (
											<tr key={`${index}-${indexer.name}`} className="hover:bg-muted/20 transition-colors">
												<td className="py-3 px-4 font-medium">
													{incognitoMode ? getLinuxIndexer(indexer.name) : indexer.name}
												</td>
												<td className="py-3 px-4 text-right text-muted-foreground">{integer.format(indexer.queries)}</td>
												<td className="py-3 px-4 text-right text-muted-foreground">{integer.format(indexer.grabs)}</td>
												<td className="py-3 px-4 text-right">
													<span style={{ color: SERVICE_GRADIENTS.prowlarr.from }}>
														{formatPercent(indexer.successRate)}
													</span>
												</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						</PremiumCard>
					)}

					{/* Instance Table */}
					<PremiumCard
						title="Instance Details"
						description="Per-instance breakdown of your Prowlarr servers"
						icon={Globe}
						gradientIcon={false}
						animationDelay={500}
					>
						{prowlarrRows.length === 0 ? (
							<p className="text-muted-foreground text-center py-8">No Prowlarr instances configured.</p>
						) : (
							<div className="overflow-x-auto">
								<table className="w-full text-sm">
									<thead>
										<tr className="border-b border-border/50">
											<th className="text-left py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Instance</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Indexers</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Active</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Paused</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Queries</th>
											<th className="text-right py-3 px-4 text-xs font-medium text-muted-foreground uppercase tracking-wide">Grabs</th>
										</tr>
									</thead>
									<tbody className="divide-y divide-border/30">
										{prowlarrRows.map((row: any) => (
											<tr key={row.instanceId} className="hover:bg-muted/20 transition-colors">
												<td className="py-3 px-4 font-medium">
													{incognitoMode ? getLinuxInstanceName(row.instanceName) : row.instanceName}
												</td>
												<td className="py-3 px-4 text-right">{integer.format(row.totalIndexers)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.activeIndexers)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.pausedIndexers)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.totalQueries)}</td>
												<td className="py-3 px-4 text-right">{integer.format(row.totalGrabs)}</td>
											</tr>
										))}
									</tbody>
								</table>
							</div>
						)}
					</PremiumCard>
				</div>
			)}
		</section>
	);
};
