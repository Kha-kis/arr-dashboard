"use client";

import {
	BarChart3,
	Trash2,
	CheckCircle2,
	AlertTriangle,
	Clock,
	TrendingUp,
	Activity,
	Sparkles,
} from "lucide-react";
import {
	StatCard,
	PremiumSection,
	PremiumEmptyState,
	GlassmorphicCard,
	ServiceBadge,
} from "../../../components/layout";
import { PremiumSkeleton } from "../../../components/layout/premium-components";
import { getServiceGradient, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useQueueCleanerStatistics } from "../hooks/useQueueCleanerStatistics";
import type { PeriodStats, InstanceBreakdown, RecentActivity } from "../lib/queue-cleaner-types";
import { RULE_LABELS, RULE_COLORS, DEFAULT_RULE_COLOR } from "../lib/constants";

export const QueueCleanerStatistics = () => {
	const { statistics, isLoading, error } = useQueueCleanerStatistics();
	const { gradient: themeGradient } = useThemeGradient();

	if (isLoading) {
		return (
			<div className="space-y-8">
				<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
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

	if (error) {
		return (
			<PremiumEmptyState
				icon={AlertTriangle}
				title="Failed to load statistics"
				description="Unable to fetch queue cleaner statistics. Please try again later."
			/>
		);
	}

	if (!statistics || statistics.totals.totalRuns === 0) {
		return (
			<PremiumEmptyState
				icon={BarChart3}
				title="No statistics yet"
				description="Statistics will appear here after the queue cleaner has been run at least once."
			/>
		);
	}

	return (
		<div className="flex flex-col gap-10">
			{/* Data Quality Warning */}
			{statistics.dataQuality && (
				<div
					className="flex items-center gap-3 rounded-lg border px-4 py-3 animate-in fade-in slide-in-from-top-2 duration-300"
					style={{
						backgroundColor: "rgba(245, 158, 11, 0.1)",
						borderColor: "rgba(245, 158, 11, 0.3)",
					}}
				>
					<AlertTriangle className="h-4 w-4 flex-shrink-0" style={{ color: SEMANTIC_COLORS.warning.from }} />
					<p className="text-sm text-amber-200">
						{statistics.dataQuality.warning}
					</p>
				</div>
			)}

			{/* Summary Stats */}
			<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
				<StatCard
					icon={Trash2}
					value={statistics.totals.itemsCleaned}
					label="Total Cleaned"
					description="Items removed all time"
					animationDelay={0}
				/>
				<StatCard
					icon={TrendingUp}
					value={statistics.daily.reduce((sum, d) => sum + d.itemsCleaned, 0)}
					label="Cleaned This Week"
					description="Last 7 days"
					animationDelay={50}
				/>
				<StatCard
					icon={CheckCircle2}
					value={`${statistics.totals.successRate}%`}
					label="Success Rate"
					description={`${statistics.totals.completedRuns} of ${statistics.totals.totalRuns} runs`}
					gradient={statistics.totals.successRate >= 90 ? SEMANTIC_COLORS.success : undefined}
					animationDelay={100}
				/>
				<StatCard
					icon={Clock}
					value={formatDuration(statistics.totals.averageDurationMs)}
					label="Avg Duration"
					description="Per clean run"
					animationDelay={150}
				/>
			</div>

			{/* Rule Breakdown and Daily Trend side by side */}
			<div className="grid gap-6 lg:grid-cols-2">
				{/* Rule Breakdown */}
				<PremiumSection
					title="Rule Breakdown"
					description="Items cleaned by detection rule"
					icon={BarChart3}
					animationDelay={200}
				>
					<RuleBreakdownChart ruleBreakdown={statistics.ruleBreakdown} />
				</PremiumSection>

				{/* Daily Trend */}
				<PremiumSection
					title="Daily Trend"
					description="Items cleaned over the last 7 days"
					icon={Activity}
					animationDelay={250}
				>
					<DailyTrendChart daily={statistics.daily} themeColor={themeGradient.from} />
				</PremiumSection>
			</div>

			{/* Instance Breakdown and Recent Activity */}
			<div className="grid gap-6 lg:grid-cols-2">
				{/* Instance Breakdown */}
				<PremiumSection
					title="Instance Breakdown"
					description="Activity per configured instance"
					icon={Trash2}
					animationDelay={300}
				>
					<InstanceBreakdownList instances={statistics.instanceBreakdown} />
				</PremiumSection>

				{/* Recent Activity */}
				<PremiumSection
					title="Recent Activity"
					description="Last 10 clean runs"
					icon={Clock}
					animationDelay={350}
				>
					<RecentActivityList activities={statistics.recentActivity} />
				</PremiumSection>
			</div>
		</div>
	);
};

// Helper to format duration
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

// Rule Breakdown Chart Component
const RuleBreakdownChart = ({
	ruleBreakdown,
}: {
	ruleBreakdown: Record<string, number>;
}) => {
	const entries = Object.entries(ruleBreakdown).sort((a, b) => b[1] - a[1]);
	const total = entries.reduce((sum, [, count]) => sum + count, 0);

	if (entries.length === 0) {
		return (
			<div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
				No rule data available
			</div>
		);
	}

	const maxValue = Math.max(...entries.map(([, count]) => count));

	return (
		<div className="space-y-3">
			{entries.map(([rule, count], index) => {
				const percentage = total > 0 ? (count / total) * 100 : 0;
				const barWidth = maxValue > 0 ? (count / maxValue) * 100 : 0;
				const color = RULE_COLORS[rule] ?? DEFAULT_RULE_COLOR;

				return (
					<div
						key={rule}
						className="animate-in fade-in slide-in-from-left-2 duration-300"
						style={{ animationDelay: `${index * 50}ms`, animationFillMode: "backwards" }}
					>
						<div className="flex items-center justify-between mb-1">
							<span className="text-sm font-medium text-foreground">
								{RULE_LABELS[rule] ?? rule}
							</span>
							<span className="text-xs text-muted-foreground">
								{count} ({percentage.toFixed(1)}%)
							</span>
						</div>
						<div className="h-2 rounded-full bg-card/50 overflow-hidden">
							<div
								className="h-full rounded-full transition-all duration-500"
								style={{
									width: `${barWidth}%`,
									backgroundColor: color.text,
								}}
							/>
						</div>
					</div>
				);
			})}
		</div>
	);
};

// Daily Trend Chart Component
const DailyTrendChart = ({
	daily,
	themeColor,
}: {
	daily: PeriodStats[];
	themeColor: string; // Used in bar gradient
}) => {
	const maxValue = Math.max(...daily.map((d) => d.itemsCleaned), 1);

	return (
		<div className="flex items-end gap-2 h-40">
			{daily.map((day, index) => {
				const height = maxValue > 0 ? (day.itemsCleaned / maxValue) * 100 : 0;
				const date = new Date(day.period);
				const dayLabel = date.toLocaleDateString(undefined, { weekday: "short" });
				const dateLabel = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });

				return (
					<div
						key={day.period}
						className="flex-1 flex flex-col items-center gap-1 animate-in fade-in slide-in-from-bottom-2 duration-300"
						style={{ animationDelay: `${index * 50}ms`, animationFillMode: "backwards" }}
					>
						<div className="w-full flex flex-col items-center justify-end flex-1">
							<div className="text-xs text-muted-foreground mb-1">
								{day.itemsCleaned}
							</div>
							<div
								className="w-full rounded-t-sm transition-all duration-500"
								style={{
									height: `${Math.max(height, 4)}%`,
									background: `linear-gradient(180deg, ${themeColor}, ${themeColor}80)`,
									minHeight: day.itemsCleaned > 0 ? "8px" : "4px",
									opacity: day.itemsCleaned > 0 ? 1 : 0.3,
								}}
							/>
						</div>
						<div className="text-center">
							<div className="text-[10px] font-medium text-foreground">{dayLabel}</div>
							<div className="text-[9px] text-muted-foreground">{dateLabel}</div>
						</div>
					</div>
				);
			})}
		</div>
	);
};

// Instance Breakdown List
const InstanceBreakdownList = ({
	instances,
}: {
	instances: InstanceBreakdown[];
}) => {
	if (instances.length === 0) {
		return (
			<div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
				No instance data available
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{instances.map((instance, index) => {
				const gradient = getServiceGradient(instance.service);
				return (
					<GlassmorphicCard
						key={instance.instanceId}
						padding="sm"
						className="animate-in fade-in slide-in-from-bottom-2 duration-300"
						style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
					>
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-3">
								<div
									className="flex h-8 w-8 items-center justify-center rounded-lg"
									style={{
										background: `linear-gradient(135deg, ${gradient.from}20, ${gradient.to}10)`,
										border: `1px solid ${gradient.from}30`,
									}}
								>
									<Sparkles className="h-4 w-4" style={{ color: gradient.from }} />
								</div>
								<div>
									<div className="flex items-center gap-2">
										<span className="text-sm font-medium text-foreground">
											{instance.instanceName}
										</span>
										<ServiceBadge service={instance.service} />
									</div>
									<div className="text-xs text-muted-foreground">
										{instance.totalRuns} runs
									</div>
								</div>
							</div>
							<div className="text-right">
								<div className="text-lg font-semibold text-foreground">
									{instance.itemsCleaned}
								</div>
								<div className="text-xs text-muted-foreground">items cleaned</div>
							</div>
						</div>
					</GlassmorphicCard>
				);
			})}
		</div>
	);
};

// Recent Activity List
const RecentActivityList = ({
	activities,
}: {
	activities: RecentActivity[];
}) => {
	if (activities.length === 0) {
		return (
			<div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
				No recent activity
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{activities.map((activity, index) => {
				const gradient = getServiceGradient(activity.service);
				const date = new Date(activity.startedAt);
				const statusColor =
					activity.status === "completed"
						? SEMANTIC_COLORS.success
						: activity.status === "error"
							? SEMANTIC_COLORS.error
							: { bg: "rgba(148, 163, 184, 0.1)", text: "#94a3b8", border: "rgba(148, 163, 184, 0.2)" };

				return (
					<div
						key={activity.id}
						className="flex items-center justify-between rounded-lg border border-border/30 bg-card/30 p-3 animate-in fade-in slide-in-from-bottom-2 duration-300"
						style={{ animationDelay: `${index * 30}ms`, animationFillMode: "backwards" }}
					>
						<div className="flex items-center gap-3">
							<div
								className="flex h-7 w-7 items-center justify-center rounded-md"
								style={{
									background: `linear-gradient(135deg, ${gradient.from}20, ${gradient.to}10)`,
									border: `1px solid ${gradient.from}30`,
								}}
							>
								<Sparkles className="h-3.5 w-3.5" style={{ color: gradient.from }} />
							</div>
							<div>
								<div className="text-sm font-medium text-foreground">
									{activity.instanceName}
								</div>
								<div className="text-xs text-muted-foreground">
									{date.toLocaleString(undefined, {
										month: "short",
										day: "numeric",
										hour: "2-digit",
										minute: "2-digit",
									})}
								</div>
							</div>
						</div>
						<div className="flex items-center gap-3">
							<div className="text-right">
								<div className="text-sm font-medium text-foreground">
									{activity.itemsCleaned} cleaned
								</div>
								{activity.isDryRun && (
									<span className="text-[10px] text-amber-400">Dry Run</span>
								)}
							</div>
							<span
								className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium capitalize"
								style={{
									backgroundColor: statusColor.bg,
									color: statusColor.text,
									border: `1px solid ${statusColor.border}`,
								}}
							>
								{activity.status}
							</span>
						</div>
					</div>
				);
			})}
		</div>
	);
};
