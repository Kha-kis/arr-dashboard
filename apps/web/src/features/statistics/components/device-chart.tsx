"use client";

import type { DeviceAnalytics } from "@arr/shared";
import { Smartphone } from "lucide-react";
import { useMemo } from "react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxDevice, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";
import { hasMixedCollectionSamples, MIXED_COLLECTION_EMPTY_NOTICE } from "./collection-coverage";

// ============================================================================
// Donut Chart (consistent with codec-chart)
// ============================================================================

interface DonutSegment {
	id: string;
	label: string;
	value: number;
	color: string;
}

function platformSegments(
	platforms: DeviceAnalytics["platforms"],
	colors: string[],
	incognito: boolean,
	clientAxis: boolean,
): DonutSegment[] {
	const visible = platforms.length > 6 ? platforms.slice(0, 5) : platforms;
	const segments = visible.map((platform, index) => ({
		id: JSON.stringify(["reported", platform.platform]),
		label: incognito && platform.platform !== "unknown" ? "Linux" : platform.platform,
		value: platform.sessions,
		color: colors[index % colors.length]!,
	}));
	if (platforms.length > 6)
		segments.push({
			id: JSON.stringify(["grouped"]),
			label: clientAxis ? "Other clients (grouped)" : "Other platforms (grouped)",
			value: platforms.slice(5).reduce((sum, platform) => sum + platform.sessions, 0),
			color: colors[5]!,
		});
	return segments;
}

function playerSegments(players: DeviceAnalytics["players"], incognito: boolean) {
	const visible = players.length > 8 ? players.slice(0, 7) : players;
	const segments = visible.map((player) => ({
		id: JSON.stringify(["reported", player.player, player.platform]),
		label: incognito && player.player !== "unknown" ? getLinuxDevice(player.player) : player.player,
		platform: incognito && player.platform !== "unknown" ? "Linux" : player.platform,
		sessions: player.sessions,
	}));
	if (players.length > 8)
		segments.push({
			id: JSON.stringify(["grouped"]),
			label: "Other players (grouped)",
			platform: "Multiple labels",
			sessions: players.slice(7).reduce((sum, player) => sum + player.sessions, 0),
		});
	return segments;
}

const DonutChart = ({
	segments,
	size = 120,
	label,
}: {
	segments: DonutSegment[];
	size?: number;
	label: string;
}) => {
	const total = segments.reduce((sum, s) => sum + s.value, 0);
	if (total === 0) return null;

	const cx = size / 2;
	const cy = size / 2;
	const strokeWidth = 16;
	const radius = size / 2 - strokeWidth / 2;
	const circumference = 2 * Math.PI * radius;

	let cumulativePercent = 0;

	return (
		<div className="relative inline-flex shrink-0 items-center justify-center">
			<svg
				role="img"
				aria-label={label}
				aria-description={`${total} observations, ${segments.map((segment) => `${segment.value} ${segment.label}`).join(", ")}`}
				width={size}
				height={size}
				className="-rotate-90"
			>
				{segments.map((seg) => {
					const percent = seg.value / total;
					const offset = circumference * cumulativePercent;
					const dash = circumference * percent;
					cumulativePercent += percent;

					return (
						<circle
							key={seg.id}
							cx={cx}
							cy={cy}
							r={radius}
							fill="none"
							stroke={seg.color}
							strokeWidth={strokeWidth}
							strokeDasharray={`${dash} ${circumference - dash}`}
							strokeDashoffset={-offset}
							strokeLinecap="round"
							className="transition-all duration-500"
						/>
					);
				})}
			</svg>
			<div className="absolute inset-0 flex flex-col items-center justify-center">
				<span className="text-lg font-bold tabular-nums">{total.toLocaleString()}</span>
				<span className="text-[9px] text-muted-foreground">observations</span>
			</div>
		</div>
	);
};

// ============================================================================
// Device Chart Section
// ============================================================================

interface DeviceChartProps {
	data: DeviceAnalytics | undefined;
	isLoading: boolean;
	isError: boolean;
	service?: "plex" | "jellyfin";
}

export const DeviceChart = ({ data, isLoading, isError, service = "plex" }: DeviceChartProps) => {
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();

	const donutColors = useMemo(
		() => [
			SERVICE_GRADIENTS[service].from,
			SEMANTIC_COLORS.success.text,
			SEMANTIC_COLORS.warning.text,
			SEMANTIC_COLORS.info.text,
			SERVICE_GRADIENTS.sonarr.from,
			SERVICE_GRADIENTS.radarr.from,
		],
		[service],
	);

	const measurement = data?.measurement?.version === 1 ? data.measurement : undefined;
	const clientAxis =
		measurement?.platformAxis === "client" || (!measurement && service === "jellyfin");
	const platforms = measurement
		? data!.platforms
		: data && data.totalSessions > 0
			? [{ platform: "unknown", sessions: data.totalSessions, percent: 100 }]
			: [];
	const players = measurement
		? data!.players
		: data && data.totalSessions > 0
			? [{ player: "unknown", platform: "unknown", sessions: data.totalSessions }]
			: [];
	const segments = platformSegments(platforms, donutColors, incognitoMode, clientAxis);
	const topPlayers = playerSegments(players, incognitoMode);
	const maxSessions = Math.max(...topPlayers.map((player) => player.sessions), 1);

	if (isLoading && !data) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="flex gap-8">
					<PremiumSkeleton variant="line" className="h-[120px] w-[120px] rounded-full" />
					<PremiumSkeleton variant="line" className="h-[120px] flex-1" />
				</div>
			</div>
		);
	}

	if (isError && !data) {
		return (
			<PremiumEmptyState
				icon={Smartphone}
				title="Failed to Load Device Data"
				description="Could not fetch device analytics. Check the connection in Settings and try again."
			/>
		);
	}

	if (!data) {
		return (
			<PremiumEmptyState
				icon={Smartphone}
				title="Device Evidence Unavailable"
				description="No observations are available. Check the connection in Settings and try again."
			/>
		);
	}

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Smartphone className="h-4 w-4" style={{ color: gradient.from }} />
				{clientAxis ? "Clients & Device Labels" : "Devices & Platforms"}
			</h3>
			{isError && (
				<p role="status" className="text-xs text-muted-foreground">
					Showing last-known device observations; refresh failed. Check the connection in Settings
					and try again.
				</p>
			)}
			{measurement ? (
				<div className="space-y-2 text-xs text-muted-foreground">
					<p>
						Measured{" "}
						{clientAxis
							? "client app"
							: measurement.platformAxis === "mixed"
								? "platform/client label"
								: "platform"}
						: {measurement.platformMeasuredSessions} of {measurement.observedSessions}
						{"; "}player/device label: {measurement.playerMeasuredSessions} of{" "}
						{measurement.observedSessions} observations.
					</p>
					<p>
						Sample observations, not unique devices or continuous playback history. Labels may be
						shared by multiple clients; unknown fields remain in the distributions.
					</p>
					<p>
						Collection: {measurement.collection.failedSnapshots} failed;{" "}
						{measurement.collection.legacySnapshots} legacy;{" "}
						{measurement.collection.invalidSnapshots} invalid;{" "}
						{measurement.collection.idleSnapshots} idle samples.
					</p>
					{measurement.invalidDetailSnapshots > 0 && (
						<p>
							{measurement.invalidDetailSnapshots} samples have invalid session detail; unverified
							fields remain unknown.
						</p>
					)}
					{measurement.unverifiedPlatformSnapshots > 0 && (
						<p>
							{measurement.unverifiedPlatformSnapshots} samples have unverified client-app evidence;
							new native observations are needed. Independent device labels remain available.
						</p>
					)}
					{measurement.status === "unavailable" && data.totalSessions > 0 && (
						<p>
							Label measurements are unavailable. Check the connection in Settings; new native
							observations are needed.
						</p>
					)}
				</div>
			) : (
				<p className="text-xs text-muted-foreground">
					Legacy device evidence is unverified. New native observations are needed; old labels
					remain unknown.
				</p>
			)}
			{incognitoMode && (
				<p className="text-xs text-muted-foreground">
					Private labels are masked in incognito mode.
				</p>
			)}
			{data.totalSessions === 0 && (
				<p className="text-sm text-muted-foreground">
					{measurement?.configuredSources === 0
						? "No configured sources. Configure a media-server connection in Settings."
						: hasMixedCollectionSamples(measurement?.collection)
							? MIXED_COLLECTION_EMPTY_NOTICE
							: measurement && measurement.collection.failedSnapshots > 0
								? "Collection failed. Check the connection in Settings and try again."
								: measurement &&
										(measurement.collection.invalidSnapshots > 0 ||
											measurement.collection.legacySnapshots > 0)
									? "Collection evidence is unverified. Check the connection in Settings; new native observations are needed."
									: measurement && measurement.collection.idleSnapshots > 0
										? "Successful idle collection: no active sessions were observed."
										: "No observations yet. Check the connection in Settings; device data appears after native sessions are captured."}
				</p>
			)}

			<div className="grid gap-6 md:grid-cols-2">
				{/* Platform donut */}
				<div className="flex min-w-0 flex-wrap items-start gap-4">
					<DonutChart
						segments={segments}
						label={
							clientAxis
								? "Client app distribution"
								: measurement?.platformAxis === "mixed"
									? "Platform/client label distribution"
									: "Platform distribution"
						}
					/>
					<ul
						aria-label={clientAxis ? "Client app labels" : "Platform labels"}
						className="min-w-0 flex-1 space-y-1.5"
					>
						{segments.map((seg) => (
							<li key={seg.id} className="flex items-center gap-2 text-xs">
								<div
									className="h-2.5 w-2.5 rounded-full shrink-0"
									style={{ backgroundColor: seg.color }}
								/>
								<span className="text-muted-foreground min-w-0 flex-1 break-all">{seg.label}</span>
								<span className="font-medium tabular-nums">{seg.value.toLocaleString()}</span>
							</li>
						))}
					</ul>
				</div>

				{/* Top players bar chart */}
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">
						{clientAxis ? "Top Device Labels" : "Top Players"}
					</h4>
					<ul className="space-y-2">
						{topPlayers.map((player, i) => (
							<li key={player.id} className="flex items-center gap-3 text-xs">
								<span className="w-24 shrink-0 break-all text-muted-foreground text-right">
									<span title={player.label} className="block">
										{player.label}
									</span>
									<span className="block text-[10px]">{player.platform}</span>
								</span>
								<div className="min-w-0 flex-1 h-4 rounded-full bg-muted/30 overflow-hidden">
									<div
										className="h-full rounded-full transition-all duration-500"
										style={{
											width: `${(player.sessions / maxSessions) * 100}%`,
											background: `linear-gradient(90deg, ${gradient.from}, ${gradient.from}bb)`,
											animationDelay: `${i * 50}ms`,
										}}
									/>
								</div>
								<span className="w-10 text-right font-medium tabular-nums">{player.sessions}</span>
							</li>
						))}
					</ul>
				</div>
			</div>
		</div>
	);
};
