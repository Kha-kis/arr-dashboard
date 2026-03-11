"use client";

import type { TautulliHomeStat, TautulliHomeStatRow } from "@arr/shared";
import {
	Activity,
	Clock,
	Film,
	Laptop,
	Music,
	Play,
	TrendingUp,
	Tv,
	User,
	Users,
} from "lucide-react";
import { useMemo, useState } from "react";
import { PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useTautulliPlaysByDate, useTautulliStats } from "../../../hooks/api/useTautulli";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { Sparkline, MiniStatCard } from "./chart-primitives";
import { TranscodeChart } from "./transcode-chart";
import { BandwidthChart } from "./bandwidth-chart";
import { UserAnalyticsChart } from "./user-analytics-chart";
import { WatchHistoryWidget } from "./watch-history-widget";
import { CodecChart } from "./codec-chart";
import { DeviceChart } from "./device-chart";
import { CollectionStatsChart } from "./collection-stats-chart";
import { QualityScoreChart } from "./quality-score-chart";
import { ForecastChart } from "./forecast-chart";

// ============================================================================
// Bar Chart Component
// ============================================================================

interface BarChartProps {
	items: Array<{ label: string; value: number; secondaryLabel?: string }>;
	color: string;
	maxBars?: number;
}

const BarChart = ({ items, color, maxBars = 8 }: BarChartProps) => {
	const visible = items.slice(0, maxBars);
	const max = Math.max(...visible.map((i) => i.value), 1);

	return (
		<div className="space-y-2">
			{visible.map((item, i) => (
				<div key={item.label} className="flex items-center gap-3 text-sm">
					<span className="w-28 truncate text-muted-foreground text-right" title={item.label}>
						{item.label}
					</span>
					<div className="flex-1 h-5 rounded-full bg-muted/30 overflow-hidden">
						<div
							className="h-full rounded-full transition-all duration-500"
							style={{
								width: `${(item.value / max) * 100}%`,
								background: `linear-gradient(90deg, ${color}, ${color}bb)`,
								animationDelay: `${i * 50}ms`,
							}}
						/>
					</div>
					<span className="w-16 text-right font-medium tabular-nums">
						{item.value.toLocaleString()}
					</span>
					{item.secondaryLabel && (
						<span className="w-16 text-right text-xs text-muted-foreground">
							{item.secondaryLabel}
						</span>
					)}
				</div>
			))}
		</div>
	);
};

// ============================================================================
// Duration Formatter
// ============================================================================

function formatDuration(seconds: number): string {
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	const hours = Math.floor(seconds / 3600);
	const mins = Math.round((seconds % 3600) / 60);
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remH = hours % 24;
		return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
	}
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

// ============================================================================
// Per-Media Sparkline Colors
// ============================================================================

const MEDIA_TYPE_COLORS: Record<
	string,
	{ color: string; icon: React.ComponentType<{ className?: string }>; label: string }
> = {
	TV: { color: SERVICE_GRADIENTS.sonarr.from, icon: Tv, label: "TV Shows" },
	Movies: { color: SERVICE_GRADIENTS.radarr.from, icon: Film, label: "Movies" },
	Music: { color: SERVICE_GRADIENTS.lidarr.from, icon: Music, label: "Music" },
};

// ============================================================================
// Plex Tab Main Component
// ============================================================================

const TIME_RANGES = [7, 14, 30] as const;

export const PlexTab = () => {
	const [timeRange, setTimeRange] = useState<number>(30);
	const { gradient } = useThemeGradient();

	const statsQuery = useTautulliStats(timeRange);
	const playsQuery = useTautulliPlaysByDate(timeRange);

	const stats = statsQuery.data;
	const plays = playsQuery.data;

	// Aggregate totals from plays-by-date
	const totalPlays = useMemo((): number => {
		if (!plays?.series) return 0;
		return plays.series.reduce(
			(acc: number, s: { data: number[] }) =>
				acc + s.data.reduce((a: number, b: number) => a + b, 0),
			0,
		);
	}, [plays]);

	// Combined time series (all media types summed per day)
	const combinedDailyPlays = useMemo(() => {
		if (!plays?.series || !plays.categories) return [];
		const combined = new Array<number>(plays.categories.length).fill(0);
		for (const series of plays.series) {
			for (let i = 0; i < series.data.length; i++) {
				combined[i]! += series.data[i] ?? 0;
			}
		}
		return combined;
	}, [plays]);

	// Per-media-type series for individual sparklines
	const perMediaSeries = useMemo(() => {
		if (!plays?.series) return [];
		return plays.series
			.filter((s) => s.data.some((v) => v > 0))
			.map((s) => ({
				name: s.name,
				data: s.data,
				total: s.data.reduce((a, b) => a + b, 0),
				...(MEDIA_TYPE_COLORS[s.name] ?? {
					color: gradient.from,
					icon: Play,
					label: s.name,
				}),
			}));
	}, [plays, gradient.from]);

	// Total watch time from user stats
	const totalDuration = useMemo((): number => {
		if (!stats?.userStats) return 0;
		return stats.userStats.reduce(
			(acc: number, u: { totalDuration: number }) => acc + u.totalDuration,
			0,
		);
	}, [stats]);

	// Top users by plays
	const topUsers = useMemo(() => {
		if (!stats?.userStats) return [];
		return [...stats.userStats]
			.sort((a: { totalPlays: number }, b: { totalPlays: number }) => b.totalPlays - a.totalPlays)
			.map((u: { friendlyName: string; totalPlays: number; totalDuration: number }) => ({
				label: u.friendlyName,
				value: u.totalPlays,
				secondaryLabel: formatDuration(u.totalDuration),
			}));
	}, [stats]);

	// Categorize home stats by statId prefix into meaningful groups
	// Tautulli returns stat_ids like: top_movies, popular_movies, top_tv, popular_tv,
	// top_music, popular_music, top_platforms, top_users, last_watched, most_concurrent, etc.
	const homeStatSections = useMemo(() => {
		if (!stats?.homeStats) return [];

		// Map statId patterns to icons and colors for visual clarity
		const STAT_STYLE: Record<
			string,
			{
				icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
				color: string;
			}
		> = {
			movie: { icon: Film, color: SERVICE_GRADIENTS.radarr.from },
			tv: { icon: Tv, color: SERVICE_GRADIENTS.sonarr.from },
			music: { icon: Music, color: SERVICE_GRADIENTS.lidarr.from },
			platform: { icon: Laptop, color: SERVICE_GRADIENTS.plex.from },
			user: { icon: User, color: SERVICE_GRADIENTS.plex.from },
		};

		function getStatStyle(statId: string) {
			for (const [key, style] of Object.entries(STAT_STYLE)) {
				if (statId.includes(key)) return style;
			}
			return { icon: Play, color: SERVICE_GRADIENTS.plex.from };
		}

		return stats.homeStats
			.filter((s: TautulliHomeStat) => s.rows.length > 0)
			.map((s: TautulliHomeStat) => {
				const style = getStatStyle(s.statId);
				const isPlatform = s.statId.includes("platform");
				return {
					statId: s.statId,
					title: s.statTitle, // Use the human-readable title from Tautulli API
					icon: style.icon,
					color: style.color,
					items: s.rows.map((r: TautulliHomeStatRow) => ({
						label: isPlatform ? r.platform || r.title : r.title,
						value: r.totalPlays,
						secondaryLabel: r.totalDuration > 0 ? formatDuration(r.totalDuration) : undefined,
					})),
				};
			});
	}, [stats]);

	const isLoading = statsQuery.isLoading || playsQuery.isLoading;
	const isError = statsQuery.isError && playsQuery.isError;

	if (isLoading) {
		return (
			<div className="space-y-6 animate-in fade-in duration-500">
				<div className="grid gap-4 md:grid-cols-4">
					{[0, 1, 2, 3].map((i) => (
						<div key={i} className="rounded-xl border border-border/30 bg-card/30 p-4">
							<PremiumSkeleton
								variant="line"
								className="h-8 w-16 mb-2"
								style={{ animationDelay: `${i * 50}ms` }}
							/>
							<PremiumSkeleton
								variant="line"
								className="h-5 w-24"
								style={{ animationDelay: `${i * 50 + 25}ms` }}
							/>
						</div>
					))}
				</div>
				<div className="rounded-xl border border-border/30 bg-card/30 p-6">
					<PremiumSkeleton variant="line" className="h-[60px] w-full" />
				</div>
			</div>
		);
	}

	const noData = !stats && !plays;
	if (isError || noData) {
		return (
			<div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
				<Activity className="h-12 w-12 mb-4 opacity-30" />
				<p className="text-lg font-medium">
					{isError ? "Failed to load Tautulli data" : "No Tautulli data available"}
				</p>
				<p className="text-sm mt-1">
					{isError
						? "Check that your Tautulli instance is running and accessible."
						: "Configure a Tautulli instance to see watch statistics."}
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-6 animate-in fade-in duration-300">
			{/* Time Range Selector */}
			<div className="flex items-center justify-between">
				<h2 className="text-lg font-semibold flex items-center gap-2">
					<TrendingUp className="h-5 w-5" style={{ color: gradient.from }} />
					Watch Statistics
				</h2>
				<div className="inline-flex rounded-lg bg-muted/30 border border-border/50 p-1">
					{TIME_RANGES.map((range) => (
						<button
							key={range}
							type="button"
							onClick={() => setTimeRange(range)}
							className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
								timeRange === range
									? "bg-card text-foreground shadow-sm"
									: "text-muted-foreground hover:text-foreground"
							}`}
						>
							{range}d
						</button>
					))}
				</div>
			</div>

			{/* Summary Cards */}
			<div className="grid gap-4 md:grid-cols-4">
				<MiniStatCard
					icon={Play}
					label="Total Plays"
					value={totalPlays.toLocaleString()}
					color={gradient.from}
				/>
				<MiniStatCard
					icon={Clock}
					label="Watch Time"
					value={formatDuration(totalDuration)}
					color={gradient.to}
				/>
				<MiniStatCard
					icon={Users}
					label="Active Users"
					value={stats?.userStats?.length ?? 0}
					color={gradient.from}
				/>
				<MiniStatCard
					icon={Activity}
					label="Daily Average"
					value={timeRange > 0 ? Math.round(totalPlays / timeRange).toLocaleString() : "0"}
					color={gradient.to}
				/>
			</div>

			{/* Per-Media-Type Sparklines */}
			{perMediaSeries.length > 1 ? (
				<div className="grid gap-4 md:grid-cols-3">
					{perMediaSeries.map((series) => {
						const Icon = series.icon;
						return (
							<div
								key={series.name}
								className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-4"
							>
								<div className="flex items-center justify-between mb-3">
									<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
										<Icon className="h-4 w-4" style={{ color: series.color }} />
										{series.label}
									</h3>
									<span className="text-lg font-bold tabular-nums" style={{ color: series.color }}>
										{series.total.toLocaleString()}
									</span>
								</div>
								<Sparkline
									data={series.data}
									width={280}
									height={50}
									color={series.color}
									fillColor={series.color}
								/>
								{plays?.categories && plays.categories.length > 1 && (
									<div className="flex justify-between text-[10px] text-muted-foreground mt-1">
										<span>{plays.categories[0]}</span>
										<span>{plays.categories[plays.categories.length - 1]}</span>
									</div>
								)}
							</div>
						);
					})}
				</div>
			) : (
				/* Single combined sparkline fallback */
				combinedDailyPlays.length > 1 && (
					<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
						<h3 className="text-sm font-medium text-muted-foreground mb-4">
							Plays Over Time ({timeRange} days)
						</h3>
						<div className="flex justify-center">
							<Sparkline
								data={combinedDailyPlays}
								width={600}
								height={80}
								color={gradient.from}
								fillColor={gradient.from}
							/>
						</div>
						{plays?.categories && plays.categories.length > 1 && (
							<div className="flex justify-between text-xs text-muted-foreground mt-2 px-1">
								<span>{plays.categories[0]}</span>
								<span>{plays.categories[plays.categories.length - 1]}</span>
							</div>
						)}
					</div>
				)
			)}

			{/* Top Users */}
			{topUsers.length > 0 && (
				<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
					<h3 className="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
						<Users className="h-4 w-4" />
						Top Users
					</h3>
					<BarChart items={topUsers} color={gradient.from} />
				</div>
			)}

			{/* Leaderboards — dynamically rendered from all available home stats */}
			{homeStatSections.length > 0 && (
				<div className="grid gap-6 md:grid-cols-2">
					{homeStatSections.map((section) => {
						const Icon = section.icon;
						return (
							<div
								key={section.statId}
								className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6"
							>
								<h3 className="text-sm font-medium text-muted-foreground mb-4 flex items-center gap-2">
									<Icon className="h-4 w-4" style={{ color: section.color }} />
									{section.title}
								</h3>
								<BarChart items={section.items} color={section.color} />
							</div>
						);
					})}
				</div>
			)}

			{/* Session Snapshot Analytics */}
			<TranscodeChart days={timeRange} enabled={!isLoading} />
			<BandwidthChart days={timeRange} enabled={!isLoading} />

			{/* Tier 1: User Analytics + Watch History */}
			<UserAnalyticsChart days={timeRange} enabled={!isLoading} />
			<WatchHistoryWidget days={timeRange} enabled={!isLoading} />

			{/* Tier 1/2: Codec + Device Analytics */}
			<div className="grid gap-6 md:grid-cols-2">
				<CodecChart days={timeRange} enabled={!isLoading} />
				<DeviceChart days={timeRange} enabled={!isLoading} />
			</div>

			{/* Tier 2: Collection Stats */}
			<CollectionStatsChart enabled={!isLoading} />

			{/* Tier 3: Quality Score + Forecast */}
			<QualityScoreChart days={timeRange} enabled={!isLoading} />
			<ForecastChart days={timeRange} enabled={!isLoading} />
		</div>
	);
};
