"use client";

import type { DeviceAnalytics } from "@arr/shared";
import { Smartphone } from "lucide-react";
import { useMemo } from "react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxDevice, useIncognitoMode } from "../../../lib/incognito";
import { SEMANTIC_COLORS, SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

// ============================================================================
// Donut Chart (consistent with codec-chart)
// ============================================================================

interface DonutSegment {
	label: string;
	value: number;
	color: string;
}

const DonutChart = ({ segments, size = 120 }: { segments: DonutSegment[]; size?: number }) => {
	const total = segments.reduce((sum, s) => sum + s.value, 0);
	if (total === 0) return null;

	const cx = size / 2;
	const cy = size / 2;
	const radius = size / 2 - 6;
	const strokeWidth = 16;
	const circumference = 2 * Math.PI * radius;

	let cumulativePercent = 0;

	return (
		<div className="relative inline-flex items-center justify-center">
			<svg width={size} height={size} className="-rotate-90">
				{segments.map((seg) => {
					const percent = seg.value / total;
					const offset = circumference * cumulativePercent;
					const dash = circumference * percent;
					cumulativePercent += percent;

					return (
						<circle
							key={seg.label}
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
				<span className="text-[9px] text-muted-foreground">sessions</span>
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

	const platformSegments = useMemo((): DonutSegment[] => {
		if (!data?.platforms) return [];
		return data.platforms
			.slice(0, 6)
			.map((p: { platform: string; sessions: number }, i: number) => ({
				label: incognitoMode ? "Linux" : p.platform,
				value: p.sessions,
				color: donutColors[i % donutColors.length]!,
			}));
	}, [data, incognitoMode, donutColors]);

	if (isLoading) {
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

	if (isError) {
		return (
			<PremiumEmptyState
				icon={Smartphone}
				title="Failed to Load Device Data"
				description="Could not fetch device analytics."
			/>
		);
	}

	if (!data || data.totalSessions === 0) {
		return (
			<PremiumEmptyState
				icon={Smartphone}
				title="No Device Data Yet"
				description="Device data appears once active sessions are captured by the snapshot scheduler."
			/>
		);
	}

	const topPlayers = data.players.slice(0, 8);
	const maxSessions = Math.max(...topPlayers.map((p: { sessions: number }) => p.sessions), 1);

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-5">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Smartphone className="h-4 w-4" style={{ color: gradient.from }} />
				Devices &amp; Platforms
			</h3>

			<div className="grid gap-6 md:grid-cols-2">
				{/* Platform donut */}
				<div className="flex items-start gap-4">
					<DonutChart segments={platformSegments} />
					<div className="space-y-1.5">
						{platformSegments.map((seg) => (
							<div key={seg.label} className="flex items-center gap-2 text-xs">
								<div
									className="h-2.5 w-2.5 rounded-full shrink-0"
									style={{ backgroundColor: seg.color }}
								/>
								<span className="text-muted-foreground flex-1">{seg.label}</span>
								<span className="font-medium tabular-nums">{seg.value.toLocaleString()}</span>
							</div>
						))}
					</div>
				</div>

				{/* Top players bar chart */}
				<div>
					<h4 className="text-xs text-muted-foreground mb-3">Top Players</h4>
					<div className="space-y-2">
						{topPlayers.map(
							(player: { player: string; platform: string; sessions: number }, i: number) => (
								<div
									key={`${player.player}-${player.platform}`}
									className="flex items-center gap-3 text-xs"
								>
									<span
										className="w-24 truncate text-muted-foreground text-right"
										title={incognitoMode ? getLinuxDevice(player.player) : player.player}
									>
										{incognitoMode ? getLinuxDevice(player.player) : player.player}
									</span>
									<div className="flex-1 h-4 rounded-full bg-muted/30 overflow-hidden">
										<div
											className="h-full rounded-full transition-all duration-500"
											style={{
												width: `${(player.sessions / maxSessions) * 100}%`,
												background: `linear-gradient(90deg, ${gradient.from}, ${gradient.from}bb)`,
												animationDelay: `${i * 50}ms`,
											}}
										/>
									</div>
									<span className="w-10 text-right font-medium tabular-nums">
										{player.sessions}
									</span>
								</div>
							),
						)}
					</div>
				</div>
			</div>
		</div>
	);
};
