"use client";

import { useMemo } from "react";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useUserAnalytics } from "../../../hooks/api/usePlex";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Clock, Users } from "lucide-react";

// ============================================================================
// Bar Chart (reusable horizontal bars)
// ============================================================================

interface BarItem {
	label: string;
	value: number;
	secondaryLabel?: string;
}

const HorizontalBarChart = ({
	items,
	color,
	maxBars = 10,
}: {
	items: BarItem[];
	color: string;
	maxBars?: number;
}) => {
	const visible = items.slice(0, maxBars);
	const max = Math.max(...visible.map((i) => i.value), 1);

	return (
		<div className="space-y-2">
			{visible.map((item, i) => (
				<div key={item.label} className="flex items-center gap-3 text-sm">
					<span className="w-24 truncate text-muted-foreground text-right" title={item.label}>
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
						<span className="w-20 text-right text-xs text-muted-foreground">
							{item.secondaryLabel}
						</span>
					)}
				</div>
			))}
		</div>
	);
};

// ============================================================================
// Stacked Area Sparkline for daily user breakdown
// ============================================================================

const UserDailySparkline = ({
	dailyBreakdown,
	topUsers,
	colors,
}: {
	dailyBreakdown: Array<{ date: string; userSessions: Record<string, number> }>;
	topUsers: string[];
	colors: string[];
}) => {
	if (dailyBreakdown.length < 2 || topUsers.length === 0) return null;

	const width = 600;
	const height = 80;

	// Compute max total per day
	const maxTotal = Math.max(
		...dailyBreakdown.map((d) => Object.values(d.userSessions).reduce((s, v) => s + v, 0)),
		1,
	);

	return (
		<div>
			<h4 className="text-xs text-muted-foreground mb-3">Daily Activity by User</h4>
			<div className="flex items-end gap-[2px]" style={{ height }}>
				{dailyBreakdown.map((day) => {
					const total = Object.values(day.userSessions).reduce((s, v) => s + v, 0);
					const barH = (total / maxTotal) * height;

					return (
						<div
							key={day.date}
							className="flex flex-col justify-end"
							style={{
								width: Math.max(4, Math.floor(width / dailyBreakdown.length) - 2),
								height: "100%",
							}}
							title={`${day.date}: ${total} sessions`}
						>
							{topUsers.map((user, ui) => {
								const count = day.userSessions[user] ?? 0;
								const segH = total > 0 ? (count / total) * barH : 0;
								if (segH <= 0) return null;
								return (
									<div
										key={user}
										className={ui === 0 ? "rounded-t-sm" : ""}
										style={{ height: segH, backgroundColor: colors[ui % colors.length] }}
									/>
								);
							})}
						</div>
					);
				})}
			</div>
			{dailyBreakdown.length > 1 && (
				<div className="flex justify-between text-[10px] text-muted-foreground mt-1">
					<span>{dailyBreakdown[0]?.date}</span>
					<span>{dailyBreakdown[dailyBreakdown.length - 1]?.date}</span>
				</div>
			)}
			{/* Legend */}
			<div className="flex flex-wrap gap-3 mt-2">
				{topUsers.map((user, i) => (
					<div key={user} className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
						<div
							className="h-2 w-2 rounded-full"
							style={{ backgroundColor: colors[i % colors.length] }}
						/>
						{user}
					</div>
				))}
			</div>
		</div>
	);
};

// ============================================================================
// User Analytics Chart
// ============================================================================

function formatWatchTime(minutes: number): string {
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours >= 24) {
		const days = Math.floor(hours / 24);
		const remH = hours % 24;
		return remH > 0 ? `${days}d ${remH}h` : `${days}d`;
	}
	const mins = minutes % 60;
	return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

interface UserAnalyticsChartProps {
	days: number;
	enabled: boolean;
}

export const UserAnalyticsChart = ({ days, enabled }: UserAnalyticsChartProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useUserAnalytics(days, enabled);

	const userColors = useMemo(
		() => [
			gradient.from,
			gradient.to,
			SERVICE_GRADIENTS.plex.from,
			SERVICE_GRADIENTS.sonarr.from,
			SERVICE_GRADIENTS.radarr.from,
		],
		[gradient.from, gradient.to],
	);

	const barItems = useMemo((): BarItem[] => {
		if (!data?.users) return [];
		return data.users.map(
			(u: { username: string; totalSessions: number; estimatedWatchTimeMinutes: number }) => ({
				label: u.username,
				value: u.totalSessions,
				secondaryLabel: formatWatchTime(u.estimatedWatchTimeMinutes),
			}),
		);
	}, [data]);

	const topUsers = useMemo(
		() => data?.users.slice(0, 5).map((u: { username: string }) => u.username) ?? [],
		[data],
	);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<PremiumSkeleton variant="line" className="h-[120px] w-full" />
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={Users}
				title="Failed to Load User Analytics"
				description="Could not fetch user analytics data."
			/>
		);
	}

	if (!data || data.users.length === 0) {
		return (
			<PremiumEmptyState
				icon={Users}
				title="No User Data Yet"
				description="User analytics appear once session snapshots are captured during active streams."
			/>
		);
	}

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Users className="h-4 w-4" style={{ color: gradient.from }} />
				User Analytics
			</h3>

			{/* Top users bar chart */}
			<HorizontalBarChart items={barItems} color={gradient.from} />

			{/* Summary */}
			<div className="flex gap-4 text-xs text-muted-foreground border-t border-border/30 pt-3">
				<span className="flex items-center gap-1">
					<Users className="h-3 w-3" />
					{data.users.length} users
				</span>
				<span className="flex items-center gap-1">
					<Clock className="h-3 w-3" />
					{formatWatchTime(
						data.users.reduce(
							(s: number, u: { estimatedWatchTimeMinutes: number }) =>
								s + u.estimatedWatchTimeMinutes,
							0,
						),
					)}{" "}
					total
				</span>
			</div>

			{/* Daily breakdown sparkline */}
			{data.dailyBreakdown.length > 1 && (
				<UserDailySparkline
					dailyBreakdown={data.dailyBreakdown}
					topUsers={topUsers}
					colors={userColors}
				/>
			)}
		</div>
	);
};
