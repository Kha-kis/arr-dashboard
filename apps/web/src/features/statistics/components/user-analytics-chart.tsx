"use client";

import type { UserAnalytics } from "@arr/shared";
import { Users } from "lucide-react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { formatBandwidth } from "./chart-primitives";

type User = UserAnalytics["users"][number];
type Day = UserAnalytics["dailyBreakdown"][number];

function UserDailyChart({
	days,
	users,
	colors,
	label,
}: {
	days: Day[];
	users: User[];
	colors: string[];
	label: (name: string) => string;
}) {
	if (days.length < 2) return null;
	const top = users.slice(0, 5);
	const topKeys = new Set(top.map((user) => user.key!));
	const calendar: Array<{ date: string; day: Day | null }> = [];
	for (const [index, day] of days.entries()) {
		const previous = days[index - 1];
		if (previous) {
			const gapDays = Math.floor((Date.parse(day.date) - Date.parse(previous.date)) / 86_400_000);
			for (let gap = 1; gap < gapDays && gap <= 90; gap++) {
				calendar.push({
					date: new Date(Date.parse(previous.date) + gap * 86_400_000).toISOString().slice(0, 10),
					day: null,
				});
			}
		}
		calendar.push({ date: day.date, day });
	}
	const max = Math.max(1, ...days.map((day) => day.measurement?.observedSessions ?? 0));
	return (
		<div>
			<h4 className="text-xs text-muted-foreground mb-3">Daily Sampled User Activity</h4>
			<fieldset
				aria-label="Daily sampled user activity; gaps are unsampled"
				className="flex items-end gap-px min-w-0 w-full h-20"
			>
				{calendar.map(({ date, day }) => {
					const measured = day?.measurement;
					const observed = measured?.observedSessions ?? 0;
					const attributed = measured?.attributedSessions ?? 0;
					const unknown = measured?.unattributedSessions ?? 0;
					const other = day
						? Object.entries(day.userSessions).reduce(
								(sum, [key, count]) => sum + (topKeys.has(key) ? 0 : count),
								0,
							)
						: 0;
					const description = !day
						? `${date}: unsampled`
						: `${date}: ${observed} observations; ${attributed} attributed; ${unknown} unattributed; ${measured?.collection.idleSnapshots ?? 0} idle; ${measured?.collection.failedSnapshots ?? 0} failed collection observations`;
					const segments = [
						...top.map((user, index) => ({
							key: user.key!,
							count: day?.userSessions[user.key!] ?? 0,
							color: colors[index % colors.length],
						})),
						{ key: "other", count: other, color: "var(--muted-foreground)" },
						{ key: "unattributed", count: unknown, color: "var(--muted)" },
					];
					return (
						<div
							key={date}
							role="img"
							aria-label={description}
							title={description}
							className="flex-1 min-w-0 flex flex-col justify-end h-full"
						>
							{segments
								.filter((segment) => segment.count > 0)
								.map((segment) => (
									<div
										key={segment.key}
										data-observations={segment.count}
										style={{
											height: `${(segment.count / max) * 100}%`,
											backgroundColor: segment.color,
										}}
									/>
								))}
						</div>
					);
				})}
			</fieldset>
			<div className="flex justify-between text-[10px] text-muted-foreground mt-1">
				<span>{days[0]?.date}</span>
				<span>{days[days.length - 1]?.date}</span>
			</div>
			<div className="flex flex-wrap gap-3 mt-2 text-[10px] text-muted-foreground">
				{top.map((user, index) => (
					<span key={user.key} className="flex items-center gap-1.5">
						<span
							className="h-2 w-2 rounded-full"
							style={{ backgroundColor: colors[index % colors.length] }}
						/>
						{label(user.username)}
					</span>
				))}
				{users.length > 5 && <span>Other attributed users</span>}
				{days.some((day) => (day.measurement?.unattributedSessions ?? 0) > 0) && (
					<span>Unattributed observations</span>
				)}
				<span>Blank calendar gaps are unsampled, not zero activity.</span>
			</div>
		</div>
	);
}

interface UserAnalyticsChartProps {
	data: UserAnalytics | undefined;
	isLoading: boolean;
	isError: boolean;
	service?: "plex" | "jellyfin";
}

export const UserAnalyticsChart = ({
	data,
	isLoading,
	isError,
	service = "plex",
}: UserAnalyticsChartProps) => {
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const serviceLabel = service === "jellyfin" ? "Jellyfin/Emby" : "Plex";
	const colors = [
		gradient.from,
		gradient.to,
		SERVICE_GRADIENTS[service].from,
		SERVICE_GRADIENTS.sonarr.from,
		SERVICE_GRADIENTS.radarr.from,
	];
	const measurement =
		data?.measurement?.version === 1 && data.measurement.attribution === "source-provider-user-id"
			? data.measurement
			: undefined;
	const users = measurement
		? (data?.users.filter((user) => typeof user.key === "string" && user.key.length > 0) ?? [])
		: [];
	const max = Math.max(1, ...users.map((user) => user.totalSessions));
	const label = (name: string) => (incognitoMode ? getLinuxUsername(name) : name);

	if (isLoading && !data)
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<PremiumSkeleton variant="line" className="h-[120px] w-full" />
			</div>
		);
	if (isError && !data)
		return (
			<PremiumEmptyState
				icon={Users}
				title="Failed to Load User Analytics"
				description={`Could not fetch user analytics. Check your ${serviceLabel} connection and try again.`}
			/>
		);
	if (!data)
		return (
			<PremiumEmptyState
				icon={Users}
				title="No User Data Yet"
				description="Check source settings and the collection scheduler for sampled user activity."
			/>
		);

	const collection = measurement?.collection;
	const emptyState =
		measurement?.observedSessions === 0
			? measurement.configuredSources === 0
				? `No configured ${serviceLabel} sources. Check Settings to configure a connection.`
				: (collection?.failedSnapshots ?? 0) > 0
					? "Collection failed in this window. Check source settings and retry collection."
					: (collection?.invalidSnapshots ?? 0) > 0
						? "Collection evidence is invalid. Check source settings."
						: (collection?.idleSnapshots ?? 0) > 0
							? "Successful idle observations recorded; no active user observations are available."
							: "No observations recorded in this window. Check source settings and the collection scheduler."
			: null;
	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-5 min-w-0">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Users className="h-4 w-4" style={{ color: gradient.from }} />
				Sampled User Activity
			</h3>
			{isError && (
				<p role="status" className="text-xs text-warning">
					Last-known historical data retained; refresh failed. Check the connection and try again.
				</p>
			)}
			<div className="text-xs text-muted-foreground space-y-1">
				{measurement ? (
					<>
						<p>
							{measurement.attributedSessions} of {measurement.observedSessions} session
							observations attributed to source-scoped native users.
						</p>
						<p>
							{measurement.unattributedSessions} unattributed observations retained; missing
							identity and legacy labels do not become a verified user.
						</p>
						<p>
							Collection: {collection?.failedSnapshots ?? 0} failed,{" "}
							{collection?.legacySnapshots ?? 0} legacy/unverified,{" "}
							{collection?.invalidSnapshots ?? 0} invalid, {collection?.idleSnapshots ?? 0} idle
							observations.
						</p>
						{measurement.invalidDetailSnapshots > 0 && (
							<p>{measurement.invalidDetailSnapshots} snapshots have invalid detail evidence.</p>
						)}
						{emptyState && <p role="status">{emptyState}</p>}
						{measurement.observedSessions > 0 && users.length === 0 && (
							<p>
								Native user attribution unavailable. Check source settings for missing identity
								evidence.
							</p>
						)}
					</>
				) : (
					<p>
						Legacy/unverified user analytics: this response does not establish source-scoped native
						identity or measured rates.
					</p>
				)}
				<p>
					Five-minute sample observations, not distinct plays or continuous watch duration. Missing
					collection intervals cannot be reconstructed.
				</p>
				<p>
					Sample-weighted activity is five minutes per observation, not verified playback time.
					Average rates use only known observations, never summed traffic volume.
				</p>
			</div>
			{users.length > 0 && (
				<>
					<ul aria-label="Source-scoped sampled users" className="space-y-3">
						{users.slice(0, 10).map((user) => {
							const rate = user.bandwidthMeasurement;
							const known =
								rate?.version === 1 &&
								rate.observedSessions === user.totalSessions &&
								rate.measuredSessions > 0 &&
								typeof user.avgBandwidth === "number" &&
								Number.isFinite(user.avgBandwidth) &&
								user.avgBandwidth >= 0;
							return (
								<li key={user.key} className="min-w-0 text-xs">
									<div className="flex flex-wrap gap-x-3 gap-y-1 items-center">
										<span className="text-muted-foreground break-words">
											{label(user.username)}
										</span>
										<span className="tabular-nums">
											{user.totalSessions.toLocaleString()} observations
										</span>
										<span className="text-muted-foreground">
											{user.estimatedWatchTimeMinutes.toLocaleString()} sample-weighted minutes
										</span>
									</div>
									<div
										className="h-2 rounded-full bg-muted/30 overflow-hidden my-1"
										aria-hidden="true"
									>
										<div
											className="h-full rounded-full"
											style={{
												width: `${(user.totalSessions / max) * 100}%`,
												backgroundColor: gradient.from,
											}}
										/>
									</div>
									<p className="text-muted-foreground">
										{known ? `Average ${formatBandwidth(user.avgBandwidth!)}` : "Rate unknown"};{" "}
										{rate?.measuredSessions ?? 0} of {rate?.observedSessions ?? user.totalSessions}{" "}
										rate observations{rate?.bandwidthBasis ? ` (${rate.bandwidthBasis})` : ""}.
									</p>
								</li>
							);
						})}
					</ul>
					<p className="text-xs text-muted-foreground">
						{users.length} source-scoped users; showing {Math.min(users.length, 10)} ranked rows.
						Counts describe observations, not unique playback sessions.
					</p>
				</>
			)}
			{measurement && data.dailyBreakdown.length > 1 && (
				<UserDailyChart days={data.dailyBreakdown} users={users} colors={colors} label={label} />
			)}
		</div>
	);
};
