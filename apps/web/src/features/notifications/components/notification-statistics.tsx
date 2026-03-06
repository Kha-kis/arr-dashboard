"use client";

import { BarChart3, Loader2 } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard } from "@/components/layout/premium-components";
import { useThemeGradient } from "@/hooks/useThemeGradient";
import { useNotificationStatistics } from "../../../hooks/api/useNotifications";

const PERIOD_OPTIONS = [
	{ days: 7, label: "7d" },
	{ days: 14, label: "14d" },
	{ days: 30, label: "30d" },
	{ days: 90, label: "90d" },
];

const EVENT_LABELS: Record<string, string> = {
	HUNT_CONTENT_FOUND: "Hunt: Content Found",
	HUNT_COMPLETED: "Hunt: Completed",
	HUNT_FAILED: "Hunt: Failed",
	QUEUE_ITEMS_REMOVED: "Queue: Items Removed",
	QUEUE_STRIKES_ISSUED: "Queue: Strikes Issued",
	QUEUE_CLEANER_FAILED: "Queue: Cleaner Failed",
	TRASH_PROFILE_UPDATED: "TRaSH: Profile Updated",
	TRASH_SYNC_ERROR: "TRaSH: Sync Error",
	TRASH_DEPLOY_FAILED: "TRaSH: Deploy Failed",
	BACKUP_COMPLETED: "Backup: Completed",
	BACKUP_FAILED: "Backup: Failed",
	LIBRARY_NEW_CONTENT: "Library: New Content",
	CLEANUP_ITEMS_FLAGGED: "Cleanup: Items Flagged",
	CLEANUP_ITEMS_REMOVED: "Cleanup: Items Removed",
	ACCOUNT_LOCKED: "Security: Account Locked",
	LOGIN_FAILED: "Security: Login Failed",
	SERVICE_CONNECTION_FAILED: "Service: Connection Failed",
	CACHE_REFRESH_STALE: "Cache: Refresh Stale",
	PLEX_CONCURRENT_PEAK: "Plex: Concurrent Peak",
	PLEX_TRANSCODE_HEAVY: "Plex: Heavy Transcoding",
	PLEX_NEW_DEVICE: "Plex: New Device",
	SYSTEM_STARTUP: "System: Startup",
	SYSTEM_ERROR: "System: Error",
};

export function NotificationStatistics() {
	const { gradient } = useThemeGradient();
	const [days, setDays] = useState(30);
	const { data: stats, isLoading } = useNotificationStatistics(days);

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
			</div>
		);
	}

	if (!stats) {
		return (
			<GlassmorphicCard padding="lg">
				<p className="text-center text-muted-foreground py-8">
					No statistics available yet. Statistics appear after notifications are sent.
				</p>
			</GlassmorphicCard>
		);
	}

	const { totals, perChannel, perEventType, dailyTrend } = stats;

	// Find max for scaling the bar chart
	const trendMax = Math.max(...dailyTrend.map((d) => d.sent + d.failed), 1);
	const channelMax = Math.max(...perChannel.map((c) => c.sent + c.failed), 1);

	return (
		<div className="space-y-5">
			{/* Period selector */}
			<div className="flex items-center justify-between">
				<p className="text-sm text-muted-foreground">
					Notification delivery statistics for the selected period.
				</p>
				<div className="flex items-center gap-1">
					{PERIOD_OPTIONS.map((opt) => (
						<button
							type="button"
							key={opt.days}
							onClick={() => setDays(opt.days)}
							className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
								days === opt.days
									? "text-white"
									: "text-muted-foreground hover:text-foreground bg-card/30 border border-border/50"
							}`}
							style={days === opt.days ? { backgroundColor: gradient.from } : undefined}
						>
							{opt.label}
						</button>
					))}
				</div>
			</div>

			{/* Summary cards */}
			<div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
				<SummaryCard
					label="Total Sent"
					value={totals.sent}
					color="text-emerald-400"
				/>
				<SummaryCard
					label="Failed"
					value={totals.failed}
					color="text-red-400"
				/>
				<SummaryCard
					label="Dead Letter"
					value={totals.deadLetter}
					color="text-amber-400"
				/>
				<SummaryCard
					label="Success Rate"
					value={`${totals.successRate.toFixed(1)}%`}
					color={totals.successRate >= 90 ? "text-emerald-400" : "text-amber-400"}
				/>
			</div>

			{/* Daily trend */}
			{dailyTrend.length > 0 && (
				<GlassmorphicCard padding="md">
					<div className="flex items-center gap-2 mb-4">
						<BarChart3 className="h-4 w-4" style={{ color: gradient.from }} />
						<h3 className="font-semibold text-sm">Daily Trend</h3>
						<div className="ml-auto flex items-center gap-4 text-xs text-muted-foreground">
							<span className="flex items-center gap-1.5">
								<span className="inline-block h-2 w-2 rounded-sm bg-emerald-400" />
								Sent
							</span>
							<span className="flex items-center gap-1.5">
								<span className="inline-block h-2 w-2 rounded-sm bg-red-400" />
								Failed
							</span>
						</div>
					</div>
					<div className="flex items-end gap-1 h-32 overflow-x-auto pb-1">
						{dailyTrend.map((day) => {
							const total = day.sent + day.failed;
							const sentPct = total > 0 ? (day.sent / trendMax) * 100 : 0;
							const failedPct = total > 0 ? (day.failed / trendMax) * 100 : 0;
							const dateLabel = new Date(day.date).toLocaleDateString(undefined, {
								month: "numeric",
								day: "numeric",
							});
							return (
								<div
									key={day.date}
									className="flex flex-col items-center gap-1 flex-1 min-w-[28px]"
									title={`${day.date}: ${day.sent} sent, ${day.failed} failed`}
								>
									<div className="w-full flex flex-col justify-end gap-0.5" style={{ height: 96 }}>
										{day.failed > 0 && (
											<div
												className="w-full rounded-t-sm bg-red-400/70 transition-all"
												style={{ height: `${failedPct}%`, minHeight: failedPct > 0 ? 2 : 0 }}
											/>
										)}
										{day.sent > 0 && (
											<div
												className="w-full rounded-t-sm bg-emerald-400/70 transition-all"
												style={{
													height: `${sentPct}%`,
													minHeight: sentPct > 0 ? 2 : 0,
													borderRadius: day.failed > 0 ? "0" : "2px 2px 0 0",
												}}
											/>
										)}
										{total === 0 && (
											<div className="w-full bg-border/20 rounded-sm" style={{ height: 2 }} />
										)}
									</div>
									<span className="text-xs text-muted-foreground/60 text-center leading-none">
										{dateLabel}
									</span>
								</div>
							);
						})}
					</div>
				</GlassmorphicCard>
			)}

			{/* Per-channel health */}
			{perChannel.length > 0 && (
				<GlassmorphicCard padding="md">
					<h3 className="font-semibold text-sm mb-4">Channel Health</h3>
					<div className="space-y-3">
						{perChannel.map((ch) => {
							const total = ch.sent + ch.failed;
							const sentWidth = total > 0 ? (ch.sent / channelMax) * 100 : 0;
							const failedWidth = total > 0 ? (ch.failed / channelMax) * 100 : 0;
							return (
								<div key={ch.channelId} className="space-y-1">
									<div className="flex items-center justify-between text-sm">
										<span className="text-muted-foreground">{ch.channelType}</span>
										<span className="text-xs text-muted-foreground">
											{ch.sent}/{total} sent ({ch.successRate.toFixed(0)}%)
										</span>
									</div>
									<div className="flex h-2 gap-0.5 rounded-full overflow-hidden bg-border/20">
										{sentWidth > 0 && (
											<div
												className="bg-emerald-400/70 transition-all"
												style={{ width: `${sentWidth}%` }}
											/>
										)}
										{failedWidth > 0 && (
											<div
												className="bg-red-400/70 transition-all"
												style={{ width: `${failedWidth}%` }}
											/>
										)}
									</div>
								</div>
							);
						})}
					</div>
				</GlassmorphicCard>
			)}

			{/* Per-event breakdown table */}
			{perEventType.length > 0 && (
				<GlassmorphicCard padding="none">
					<div className="px-4 py-3 border-b border-border/30">
						<h3 className="font-semibold text-sm">Event Breakdown</h3>
					</div>
					<div className="overflow-x-auto">
						<table className="w-full text-sm">
							<thead>
								<tr className="border-b border-border/20">
									<th className="px-4 py-2.5 text-left text-xs text-muted-foreground font-medium">
										Event Type
									</th>
									<th className="px-4 py-2.5 text-right text-xs text-muted-foreground font-medium">
										Count
									</th>
									<th className="px-4 py-2.5 text-left text-xs text-muted-foreground font-medium min-w-[120px]">
										Share
									</th>
								</tr>
							</thead>
							<tbody>
								{perEventType.map((row) => {
									const share =
										totals.total > 0 ? (row.count / totals.total) * 100 : 0;
									return (
										<tr key={row.eventType} className="border-b border-border/10 hover:bg-card/20">
											<td className="px-4 py-2.5">
												{EVENT_LABELS[row.eventType] ?? row.eventType}
											</td>
											<td className="px-4 py-2.5 text-right tabular-nums">{row.count}</td>
											<td className="px-4 py-2.5">
												<div className="flex items-center gap-2">
													<div className="flex-1 h-1.5 bg-border/20 rounded-full overflow-hidden">
														<div
															className="h-full rounded-full transition-all"
															style={{
																width: `${share}%`,
																backgroundColor: gradient.from,
															}}
														/>
													</div>
													<span className="text-xs text-muted-foreground w-10 text-right">
														{share.toFixed(0)}%
													</span>
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				</GlassmorphicCard>
			)}
		</div>
	);
}

function SummaryCard({
	label,
	value,
	color,
}: {
	label: string;
	value: string | number;
	color: string;
}) {
	return (
		<GlassmorphicCard padding="md">
			<p className="text-xs text-muted-foreground mb-1">{label}</p>
			<p className={`text-2xl font-bold ${color}`}>{value}</p>
		</GlassmorphicCard>
	);
}
