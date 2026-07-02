"use client";

/**
 * Statistics — Tracearr tab (charter C2).
 *
 * Deep, cross-server watch analytics from Tracearr, complementary to the
 * SessionSnapshot-backed per-server Plex/Jellyfin tabs (which already cover
 * post-Tautulli analytics). This tab surfaces what SessionSnapshot can't:
 * unified play/quality/platform time-series across every media server, plus
 * all-time rollups. (History + users + violations panels land in C2b.)
 *
 * No incognito surface here: the stats + activity data are counts, dates,
 * and platform names — no media titles or usernames. Those arrive with the
 * history/users panels (C2b), which will mask.
 */

import { AudioLines, Clock, Play, ShieldAlert, TrendingUp, Users } from "lucide-react";
import { useState } from "react";
import { AsyncStateView } from "../../../components/layout";
import { useTracearrActivity, useTracearrStats } from "../../../hooks/api/useTracearr";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { MiniStatCard, Sparkline } from "./chart-primitives";

const PERIODS = ["week", "month", "year"] as const;
type Period = (typeof PERIODS)[number];

const ACCENT = SERVICE_GRADIENTS.tracearr;

function Card({
	title,
	children,
	subtitle,
}: {
	title: string;
	subtitle?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded-xl border border-border/50 bg-card/30 p-4 backdrop-blur-sm">
			<div className="mb-3">
				<h3 className="text-sm font-medium text-foreground">{title}</h3>
				{subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
			</div>
			{children}
		</div>
	);
}

/** Labeled horizontal bars for a breakdown (platforms, day-of-week, …). */
function BarList({
	items,
	emptyLabel,
}: {
	items: Array<{ label: string; value: number }>;
	emptyLabel: string;
}) {
	const max = Math.max(...items.map((i) => i.value), 1);
	if (items.length === 0 || items.every((i) => i.value === 0)) {
		return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
	}
	return (
		<ul className="space-y-2">
			{items.map((item) => (
				<li key={item.label} className="flex items-center gap-3">
					<span className="w-24 shrink-0 truncate text-xs text-muted-foreground" title={item.label}>
						{item.label}
					</span>
					<div className="h-2 flex-1 overflow-hidden rounded-full bg-muted/20">
						<div
							className="h-full rounded-full"
							style={{
								width: `${(item.value / max) * 100}%`,
								background: `linear-gradient(90deg, ${ACCENT.from}, ${ACCENT.to})`,
							}}
						/>
					</div>
					<span className="w-10 shrink-0 text-right text-xs tabular-nums text-foreground">
						{item.value}
					</span>
				</li>
			))}
		</ul>
	);
}

export const TracearrTab = () => {
	const [period, setPeriod] = useState<Period>("month");
	const statsQuery = useTracearrStats();
	const activityQuery = useTracearrActivity(period);

	const stats = statsQuery.data;
	const activity = activityQuery.data?.activity;

	return (
		<div className="flex flex-col gap-6">
			{/* Summary cards — all-time + today's rollups. */}
			<AsyncStateView
				isLoading={statsQuery.isLoading}
				isError={statsQuery.isError}
				error={statsQuery.error}
				onRetry={() => void statsQuery.refetch()}
				errorTitle="Couldn't load Tracearr stats"
				loadingFallback={<div className="h-24 animate-pulse rounded-xl bg-muted/10" />}
				emptyState={{ icon: TrendingUp, title: "No stats", description: "" }}
			>
				{stats && (
					<div
						className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6"
						data-testid="tracearr-stats-cards"
					>
						<MiniStatCard
							icon={Play}
							label="Plays today"
							value={stats.today.todayPlays}
							color={ACCENT.from}
						/>
						<MiniStatCard
							icon={Clock}
							label="Watch hours today"
							// watchTimeHours is the one non-integer stat — round for display so
							// a value like 0.8333h doesn't render as a 16-digit float.
							value={stats.today.watchTimeHours.toFixed(1)}
							color={ACCENT.from}
						/>
						<MiniStatCard
							icon={Users}
							label="Active users today"
							value={stats.today.activeUsersToday}
							color={ACCENT.from}
						/>
						<MiniStatCard
							icon={Users}
							label="Total users"
							value={stats.stats.totalUsers}
							color={ACCENT.to}
						/>
						<MiniStatCard
							icon={AudioLines}
							label="Total sessions"
							value={stats.stats.totalSessions}
							color={ACCENT.to}
						/>
						<MiniStatCard
							icon={ShieldAlert}
							label="Recent violations"
							value={stats.stats.recentViolations}
							color={ACCENT.to}
						/>
					</div>
				)}
			</AsyncStateView>

			{/* Period selector for the activity series. */}
			<div className="flex items-center gap-2">
				<span className="text-xs text-muted-foreground">Period:</span>
				{PERIODS.map((p) => (
					<button
						key={p}
						type="button"
						onClick={() => setPeriod(p)}
						className={`rounded-md border px-2.5 py-1 text-xs capitalize transition-colors ${
							period === p
								? "border-border bg-card text-foreground"
								: "border-border/50 text-muted-foreground hover:text-foreground"
						}`}
					>
						{p}
					</button>
				))}
			</div>

			<AsyncStateView
				isLoading={activityQuery.isLoading}
				isError={activityQuery.isError}
				error={activityQuery.error}
				onRetry={() => void activityQuery.refetch()}
				errorTitle="Couldn't load Tracearr activity"
				loadingFallback={<div className="h-64 animate-pulse rounded-xl bg-muted/10" />}
				emptyState={{ icon: TrendingUp, title: "No activity", description: "" }}
			>
				{activity && (
					<div className="grid grid-cols-1 gap-4 lg:grid-cols-2" data-testid="tracearr-activity">
						<Card title="Plays over time" subtitle={`Per day, this ${period}`}>
							{activity.plays.length >= 2 ? (
								<Sparkline
									data={activity.plays.map((p) => p.count)}
									width={320}
									height={72}
									color={ACCENT.from}
									fillColor={ACCENT.from}
								/>
							) : (
								<p className="text-xs text-muted-foreground">Not enough data yet.</p>
							)}
						</Card>

						<Card title="Playback quality" subtitle="Direct vs. transcode">
							<BarList
								emptyLabel="No playback recorded yet."
								items={[
									{ label: "Direct play", value: activity.quality.directPlay },
									{ label: "Direct stream", value: activity.quality.directStream },
									{ label: "Transcode", value: activity.quality.transcode },
								]}
							/>
						</Card>

						<Card title="By day of week">
							<BarList
								emptyLabel="No plays recorded yet."
								items={activity.byDayOfWeek.map((d) => ({ label: d.name, value: d.count }))}
							/>
						</Card>

						<Card title="Top platforms">
							<BarList
								emptyLabel="No platforms recorded yet."
								items={activity.platforms
									.slice(0, 8)
									.map((p) => ({ label: p.platform, value: p.count }))}
							/>
						</Card>
					</div>
				)}
			</AsyncStateView>

			{stats && (
				<p className="text-xs text-muted-foreground">Source: Tracearr · {stats.instanceLabel}</p>
			)}
		</div>
	);
};
