"use client";

import type { QualityScoreAnalytics } from "@arr/shared";
import { Gauge } from "lucide-react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { Sparkline } from "./chart-primitives";

// ============================================================================
// Circular Gauge (0-100)
// ============================================================================

const CircularGauge = ({
	score,
	size = 140,
	label,
	color,
}: {
	score: number | null;
	size?: number;
	label: string;
	color: string;
}) => {
	const cx = size / 2;
	const cy = size / 2;
	const radius = size / 2 - 10;
	const strokeWidth = 8;
	const circumference = 2 * Math.PI * radius;
	const progress = score === null ? 0 : Math.min(Math.max(score, 0), 100);
	const dashLength = (progress / 100) * circumference;

	return (
		<div className="flex flex-col items-center gap-1">
			<div className="relative inline-flex items-center justify-center">
				<svg
					width={size}
					height={size}
					className="-rotate-90"
					role="img"
					aria-label={`${label}: ${score === null ? "Unknown" : `${score} out of 100`}`}
				>
					{/* Background track */}
					<circle
						cx={cx}
						cy={cy}
						r={radius}
						fill="none"
						stroke="currentColor"
						strokeWidth={strokeWidth}
						className="text-muted/20"
					/>
					{/* Progress arc */}
					{score !== null && (
						<circle
							cx={cx}
							cy={cy}
							r={radius}
							fill="none"
							stroke={color}
							strokeWidth={strokeWidth}
							strokeDasharray={`${dashLength} ${circumference - dashLength}`}
							strokeLinecap="round"
							className="transition-all duration-700"
						/>
					)}
				</svg>
				<div className="absolute inset-0 flex flex-col items-center justify-center">
					<span
						className={
							score === null ? "text-sm text-muted-foreground" : "text-2xl font-bold tabular-nums"
						}
					>
						{score ?? "Unknown"}
					</span>
					{score !== null && <span className="text-[9px] text-muted-foreground">/100</span>}
				</div>
			</div>
			<span className="text-[10px] text-muted-foreground font-medium">{label}</span>
		</div>
	);
};

// ============================================================================
// Sparkline for daily trend
// ============================================================================

const TrendSparkline = ({
	data,
	width = 600,
	height = 50,
	color,
}: {
	data: Array<{ date: string; score: number | null }>;
	width?: number;
	height?: number;
	color: string;
}) => {
	if (data.length < 2) return null;
	const values: Array<number | null> = [];
	for (const [index, point] of data.entries()) {
		const previous = data[index - 1];
		if (previous) {
			const gapDays = Math.floor((Date.parse(point.date) - Date.parse(previous.date)) / 86_400_000);
			for (let gap = 1; gap < gapDays && gap <= 90; gap++) values.push(null);
		}
		values.push(point.score);
	}
	return (
		<Sparkline
			data={values}
			width={width}
			height={height}
			color={color}
			fillColor={color}
			label="Quality heuristic trend"
		/>
	);
};

// ============================================================================
// Quality Score Chart
// ============================================================================

interface QualityScoreChartProps {
	data: QualityScoreAnalytics | undefined;
	isLoading: boolean;
	isError: boolean;
	service?: "plex" | "jellyfin";
}

export const QualityScoreChart = ({
	data,
	isLoading,
	isError,
	service = "plex",
}: QualityScoreChartProps) => {
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const resolutionScoreColor = SERVICE_GRADIENTS[service].from;
	const measurement =
		data?.measurement?.version === 1 && data.measurement.methodAxis === "video"
			? data.measurement
			: undefined;
	const overall = measurement ? (data?.overallScore ?? null) : null;
	const scoreColor =
		overall === null
			? "var(--muted-foreground)"
			: overall >= 80
				? SEMANTIC_COLORS.success.text
				: overall >= 50
					? SEMANTIC_COLORS.warning.text
					: SEMANTIC_COLORS.error.text;
	const serviceLabel = service === "jellyfin" ? "Jellyfin" : "Plex";

	if (isLoading && !data) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="flex gap-8 items-center">
					<PremiumSkeleton variant="line" className="h-[140px] w-[140px] rounded-full" />
					<PremiumSkeleton variant="line" className="h-[100px] flex-1" />
				</div>
			</div>
		);
	}

	if (isError && !data) {
		return (
			<PremiumEmptyState
				icon={Gauge}
				title="Failed to Load Quality Score"
				description={`Could not fetch quality score analytics. Check your ${serviceLabel} connection and try again.`}
			/>
		);
	}

	if (!data) {
		return (
			<PremiumEmptyState
				icon={Gauge}
				title="No Quality Data Yet"
				description="Quality scores are computed from session snapshots with codec/resolution data."
			/>
		);
	}
	const components = measurement ? data.components : undefined;
	const collection = measurement?.collection;
	const collectionState =
		measurement?.observedSessions === 0
			? measurement.configuredSources === 0
				? `No configured ${serviceLabel} sources. Check Settings to configure a connection.`
				: collection && collection.failedSnapshots > 0
					? "Collection failed in this window. Check source settings and retry collection."
					: collection && collection.invalidSnapshots > 0
						? "Collection evidence is invalid in this window. Check source settings."
						: collection && collection.idleSnapshots > 0
							? "Successful idle observations recorded; no active quality observations are available."
							: "No observations recorded in this window. Check source settings and the collection scheduler."
			: null;

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Gauge className="h-4 w-4" style={{ color: gradient.from }} />
				Video Processing &amp; Resolution
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
							{measurement.scoredSessions} of {measurement.observedSessions} session observations
							jointly measured for the composite score.
						</p>
						<p>
							{measurement.methodMeasuredSessions} of {measurement.observedSessions} have known
							video decisions; {measurement.resolutionMeasuredSessions} of{" "}
							{measurement.observedSessions} have known resolution. Component gauges use these
							independent subsets, not the joint cohort.
						</p>
						{collection && (
							<p>
								Collection: {collection.failedSnapshots} failed, {collection.legacySnapshots}{" "}
								legacy/unverified, {collection.invalidSnapshots} invalid, {collection.idleSnapshots}{" "}
								idle observations.
							</p>
						)}
						{measurement.invalidDetailSnapshots > 0 && (
							<p>{measurement.invalidDetailSnapshots} snapshots have invalid detail evidence.</p>
						)}
						{measurement.unattributedSessions > 0 && (
							<p>
								{measurement.unattributedSessions} observations cannot be attributed to a verified
								source-scoped user.
							</p>
						)}
						{collectionState && <p role="status">{collectionState}</p>}
						{!collectionState && overall === null && (
							<p>
								Composite score unavailable; known components are retained. Check source settings
								for missing native evidence.
							</p>
						)}
					</>
				) : (
					<p>
						Legacy/unverified scores: this response does not establish native measurement coverage.
						Scores remain unknown.
					</p>
				)}
				<p>
					Heuristic, not a playback-experience or lossless-quality measurement. Five-minute samples
					are not continuous playback history.
				</p>
				<p>
					Composite: 40% direct play + 30% resolution tier + 30% inverse video transcode rate, using
					the same jointly measured observations.
				</p>
			</div>

			<div className="flex flex-col md:flex-row gap-6 items-center">
				{/* Main gauge */}
				<CircularGauge score={overall} label="Overall" color={scoreColor} />

				{/* Sub-gauges */}
				<div className="flex gap-4">
					<CircularGauge
						score={components?.directPlayScore ?? null}
						size={90}
						label="Direct Play"
						color={SEMANTIC_COLORS.success.text}
					/>
					<CircularGauge
						score={components?.resolutionScore ?? null}
						size={90}
						label="Resolution"
						color={resolutionScoreColor}
					/>
					<CircularGauge
						score={components?.transcodeScore ?? null}
						size={90}
						label="Low Transcode"
						color={SEMANTIC_COLORS.warning.text}
					/>
				</div>
			</div>

			{/* Daily trend */}
			{measurement && data.trend.length > 1 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Quality Score Trend</h4>
					<div className="flex justify-center">
						<TrendSparkline data={data.trend} color={scoreColor} />
					</div>
					<div className="flex justify-between text-[10px] text-muted-foreground mt-1 px-1">
						<span>{data.trend[0]?.date}</span>
						<span>{data.trend[data.trend.length - 1]?.date}</span>
					</div>
				</div>
			)}

			{/* Per-user scores */}
			{measurement && data.perUser.length > 0 && (
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Per-User Quality</h4>
					<div className="space-y-2">
						{data.perUser.slice(0, 8).map((user) => (
							<div
								key={user.key ?? user.username}
								className="flex flex-wrap items-center gap-3 text-xs"
							>
								<div
									className="h-6 w-6 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0"
									style={{ backgroundColor: `${gradient.from}20`, color: gradient.from }}
								>
									{(incognitoMode ? getLinuxUsername(user.username) : user.username)
										.charAt(0)
										.toUpperCase()}
								</div>
								<span className="w-20 truncate text-muted-foreground">
									{incognitoMode ? getLinuxUsername(user.username) : user.username}
								</span>
								<div className="flex-1 h-3 rounded-full bg-muted/30 overflow-hidden">
									<div
										className="h-full rounded-full transition-all duration-500"
										style={{
											width: user.score === null ? "0%" : `${user.score}%`,
											backgroundColor:
												user.score === null
													? "var(--muted-foreground)"
													: user.score >= 80
														? SEMANTIC_COLORS.success.text
														: user.score >= 50
															? SEMANTIC_COLORS.warning.text
															: SEMANTIC_COLORS.error.text,
										}}
									/>
								</div>
								<span className="text-right font-medium tabular-nums">
									{user.score ?? "Unknown"}
								</span>
								<span className="text-right text-muted-foreground tabular-nums">
									{user.coverage
										? `${user.coverage.scoredSessions} of ${user.sessions} scored`
										: `${user.sessions} observations, coverage unknown`}
								</span>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
};
