"use client";

import { formatDistanceToNow } from "date-fns";
import {
	AlertCircle,
	CheckCircle2,
	Clock,
	Play,
	RefreshCw,
	Bell,
	Hand,
	Zap,
	Database,
	AlertTriangle,
	Timer,
} from "lucide-react";
import { useSchedulerStatus, useTriggerUpdateCheck } from "../../../hooks/api/useTemplateUpdates";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Safely formats a date value as relative time (e.g., "5 minutes ago").
 * Returns fallback if the date is invalid or missing.
 */
function safeFormatDistanceToNow(
	value: string | Date | null | undefined,
	fallback = "Never",
): string {
	if (!value) return fallback;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return fallback;
	return formatDistanceToNow(date, { addSuffix: true });
}

/**
 * Premium Stat Card Component
 */
const StatCard = ({
	icon: Icon,
	label,
	value,
	color,
	subtext,
}: {
	icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
	label: string;
	value: string | number;
	color?: string;
	subtext?: string;
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const displayColor = color || themeGradient.from;

	return (
		<div
			className="rounded-xl border border-border/50 bg-card/30 backdrop-blur-sm p-4 transition-all duration-300 hover:bg-card/50"
		>
			<div className="flex items-center gap-2 mb-3">
				<div
					className="flex h-8 w-8 items-center justify-center rounded-lg"
					style={{ backgroundColor: `${displayColor}15` }}
				>
					<Icon className="h-4 w-4" style={{ color: displayColor }} />
				</div>
				<span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
					{label}
				</span>
			</div>
			<p className="text-2xl font-bold text-foreground">{value}</p>
			{subtext && (
				<p className="text-xs text-muted-foreground mt-1">{subtext}</p>
			)}
		</div>
	);
};

/**
 * Premium Scheduler Status Dashboard
 *
 * Features:
 * - Theme-aware premium styling
 * - Glassmorphic stat cards
 * - Animated status indicator
 * - Gradient accents
 */
export const SchedulerStatusDashboard = () => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const { data, isLoading, error } = useSchedulerStatus({
		refetchInterval: 60000, // Refresh every minute
	});
	const triggerCheck = useTriggerUpdateCheck();

	const handleManualTrigger = async () => {
		if (
			!confirm(
				"Manually trigger an update check? This will check for TRaSH Guides updates immediately.",
			)
		) {
			return;
		}

		try {
			await triggerCheck.mutateAsync();
		} catch (error) {
			console.error("Failed to trigger update check:", error);
			alert("Failed to trigger update check. Please try again.");
		}
	};

	// Loading State
	if (isLoading) {
		return (
			<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-8 animate-pulse">
				<div className="space-y-6">
					<div className="flex items-center justify-between">
						<div className="space-y-2">
							<div className="h-6 w-64 rounded-lg bg-muted/30" />
							<div className="h-4 w-96 rounded bg-muted/20" />
						</div>
						<div className="h-8 w-24 rounded-full bg-muted/30" />
					</div>
					<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
						{Array.from({ length: 4 }).map((_, i) => (
							<div key={i} className="h-28 rounded-xl bg-muted/20" />
						))}
					</div>
				</div>
			</div>
		);
	}

	// Error State
	if (error) {
		return (
			<div
				className="rounded-2xl border p-6 backdrop-blur-sm"
				style={{
					backgroundColor: SEMANTIC_COLORS.error.bg,
					borderColor: SEMANTIC_COLORS.error.border,
				}}
			>
				<div className="flex items-start gap-4">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
						style={{ backgroundColor: `${SEMANTIC_COLORS.error.from}20` }}
					>
						<AlertCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.error.from }} />
					</div>
					<div>
						<h3 className="font-semibold text-foreground mb-1">Failed to load scheduler status</h3>
						<p className="text-sm text-muted-foreground">
							{error instanceof Error ? error.message : "Please try again"}
						</p>
					</div>
				</div>
			</div>
		);
	}

	const schedulerData = data?.data;

	// No Data State
	if (!schedulerData) {
		return (
			<div
				className="rounded-2xl border p-6 backdrop-blur-sm"
				style={{
					backgroundColor: SEMANTIC_COLORS.info.bg,
					borderColor: SEMANTIC_COLORS.info.border,
				}}
			>
				<div className="flex items-center gap-3">
					<AlertCircle className="h-5 w-5" style={{ color: SEMANTIC_COLORS.info.from }} />
					<p className="text-foreground">Scheduler status not available</p>
				</div>
			</div>
		);
	}

	return (
		<div className="rounded-2xl border border-border/50 bg-card/30 backdrop-blur-sm p-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
			<div className="space-y-6">
				{/* Header */}
				<div className="flex items-start justify-between gap-4 flex-wrap">
					<div className="flex items-center gap-4">
						<div
							className="flex h-12 w-12 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Timer className="h-6 w-6" style={{ color: themeGradient.from }} />
						</div>
						<div>
							<h3
								className="text-xl font-bold"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
									WebkitBackgroundClip: "text",
									WebkitTextFillColor: "transparent",
								}}
							>
								Update Scheduler
							</h3>
							<p className="text-sm text-muted-foreground mt-0.5">
								Checks for TRaSH Guides updates every 12 hours
							</p>
						</div>
					</div>

					{/* Status Badge */}
					{schedulerData.isRunning ? (
						<span
							className="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium"
							style={{
								backgroundColor: SEMANTIC_COLORS.success.bg,
								border: `1px solid ${SEMANTIC_COLORS.success.border}`,
								color: SEMANTIC_COLORS.success.text,
							}}
						>
							<span className="relative flex h-2 w-2">
								<span
									className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
									style={{ backgroundColor: SEMANTIC_COLORS.success.from }}
								/>
								<span
									className="relative inline-flex rounded-full h-2 w-2"
									style={{ backgroundColor: SEMANTIC_COLORS.success.from }}
								/>
							</span>
							Running
						</span>
					) : (
						<span className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-muted/20 text-muted-foreground text-sm font-medium">
							<span className="h-2 w-2 rounded-full bg-muted-foreground" />
							Stopped
						</span>
					)}
				</div>

				{/* Stats Grid */}
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
					<StatCard
						icon={Clock}
						label="Last Check"
						value={safeFormatDistanceToNow(schedulerData.lastCheckAt, "Never")}
					/>
					<StatCard
						icon={RefreshCw}
						label="Next Check"
						value={safeFormatDistanceToNow(schedulerData.nextCheckAt, "Not scheduled")}
					/>
					<StatCard
						icon={CheckCircle2}
						label="Templates Checked"
						value={schedulerData.lastCheckResult?.templatesChecked ?? 0}
						color={SEMANTIC_COLORS.success.from}
					/>
					<StatCard
						icon={AlertTriangle}
						label="Outdated"
						value={schedulerData.lastCheckResult?.templatesOutdated ?? 0}
						color={schedulerData.lastCheckResult?.templatesOutdated ? SEMANTIC_COLORS.warning.from : undefined}
					/>
				</div>

				{/* Last Check Results */}
				{schedulerData.lastCheckResult && (
					<div className="rounded-xl border border-border/50 bg-card/20 p-5 space-y-5">
						<h4 className="font-semibold text-foreground">Last Check Results</h4>

						{/* Template Version Check Results */}
						<div className="space-y-3">
							<div>
								<h5 className="text-sm font-medium text-foreground mb-1">Template Version Updates</h5>
								<p className="text-xs text-muted-foreground">
									Compares templates against latest TRaSH Guides commits. Auto-sync templates update automatically.
								</p>
							</div>
							<div className="grid gap-4 grid-cols-2 md:grid-cols-5">
								<div className="space-y-1">
									<div className="flex items-center gap-1.5">
										<RefreshCw className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.success.from }} />
										<span className="text-xs text-muted-foreground">Auto-Sync</span>
									</div>
									<p className="text-lg font-bold" style={{ color: SEMANTIC_COLORS.success.from }}>
										{schedulerData.lastCheckResult.templatesWithAutoStrategy ?? 0}
									</p>
									<p className="text-xs text-muted-foreground">
										{schedulerData.lastCheckResult.templatesAutoSynced > 0
											? `${schedulerData.lastCheckResult.templatesAutoSynced} synced`
											: "Up to date"}
									</p>
								</div>
								<div className="space-y-1">
									<div className="flex items-center gap-1.5">
										<Bell className="h-3.5 w-3.5" style={{ color: themeGradient.from }} />
										<span className="text-xs text-muted-foreground">Notify</span>
									</div>
									<p className="text-lg font-bold" style={{ color: themeGradient.from }}>
										{schedulerData.lastCheckResult.templatesWithNotifyStrategy ?? 0}
									</p>
									<p className="text-xs text-muted-foreground">Will alert on updates</p>
								</div>
								<div className="space-y-1">
									<div className="flex items-center gap-1.5">
										<Hand className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.warning.from }} />
										<span className="text-xs text-muted-foreground">Manual</span>
									</div>
									<p className="text-lg font-bold" style={{ color: SEMANTIC_COLORS.warning.from }}>
										{Math.max(
											0,
											schedulerData.lastCheckResult.templatesChecked -
												(schedulerData.lastCheckResult.templatesWithAutoStrategy ?? 0) -
												(schedulerData.lastCheckResult.templatesWithNotifyStrategy ?? 0)
										)}
									</p>
									<p className="text-xs text-muted-foreground">Excluded from checks</p>
								</div>
								<div className="space-y-1">
									<div className="flex items-center gap-1.5">
										<AlertTriangle className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.warning.from }} />
										<span className="text-xs text-muted-foreground">Needs Attention</span>
									</div>
									<p className="text-lg font-bold" style={{ color: SEMANTIC_COLORS.warning.from }}>
										{schedulerData.lastCheckResult.templatesNeedingAttention}
									</p>
								</div>
								<div className="space-y-1">
									<div className="flex items-center gap-1.5">
										<AlertCircle className="h-3.5 w-3.5" style={{ color: SEMANTIC_COLORS.error.from }} />
										<span className="text-xs text-muted-foreground">Errors</span>
									</div>
									<p className="text-lg font-bold" style={{ color: SEMANTIC_COLORS.error.from }}>
										{schedulerData.lastCheckResult.errors.length}
									</p>
								</div>
							</div>
						</div>

						{/* Cache Refresh Results */}
						<div className="pt-4 border-t border-border/50 space-y-3">
							<div>
								<h5 className="text-sm font-medium text-foreground mb-1">TRaSH Guides Data Cache</h5>
								<p className="text-xs text-muted-foreground">
									Refreshes cached quality profiles, naming formats, and custom formats from repository
								</p>
							</div>
							<div className="grid gap-4 md:grid-cols-2">
								<div className="flex items-center gap-3">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-lg"
										style={{ backgroundColor: `${SEMANTIC_COLORS.success.from}15` }}
									>
										<Database className="h-5 w-5" style={{ color: SEMANTIC_COLORS.success.from }} />
									</div>
									<div>
										<p className="text-xs text-muted-foreground">Caches Refreshed</p>
										<p className="text-xl font-bold" style={{ color: SEMANTIC_COLORS.success.from }}>
											{schedulerData.lastCheckResult.cachesRefreshed ?? 0}
										</p>
									</div>
								</div>
								<div className="flex items-center gap-3">
									<div
										className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted/10"
									>
										<AlertCircle className="h-5 w-5 text-muted-foreground" />
									</div>
									<div>
										<p className="text-xs text-muted-foreground">Cache Failures</p>
										<p className="text-xl font-bold text-foreground">
											{schedulerData.lastCheckResult.cachesFailed ?? 0}
										</p>
									</div>
								</div>
							</div>
						</div>

						{/* Error Display */}
						{schedulerData.lastCheckResult.errors.length > 0 && (
							<div
								className="rounded-xl p-4"
								style={{
									backgroundColor: SEMANTIC_COLORS.error.bg,
									border: `1px solid ${SEMANTIC_COLORS.error.border}`,
								}}
							>
								<div className="flex items-center gap-2 mb-3">
									<AlertCircle className="h-4 w-4" style={{ color: SEMANTIC_COLORS.error.from }} />
									<p className="text-sm font-medium" style={{ color: SEMANTIC_COLORS.error.text }}>
										Errors
									</p>
								</div>
								<ul className="text-xs text-muted-foreground space-y-1.5">
									{schedulerData.lastCheckResult.errors.map((error, index) => (
										<li key={`${index}-${error.slice(0, 50)}`} className="flex items-start gap-2">
											<span className="text-muted-foreground">•</span>
											<span>{error}</span>
										</li>
									))}
								</ul>
							</div>
						)}
					</div>
				)}

				{/* Actions */}
				<div className="flex items-center justify-end gap-3 pt-4 border-t border-border/50">
					<button
						type="button"
						onClick={handleManualTrigger}
						disabled={triggerCheck.isPending || !schedulerData.isRunning}
						className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 12px -4px ${themeGradient.glow}`,
						}}
					>
						<Play className="h-4 w-4" />
						{triggerCheck.isPending ? "Triggering..." : "Trigger Check Now"}
					</button>
				</div>
			</div>
		</div>
	);
};
