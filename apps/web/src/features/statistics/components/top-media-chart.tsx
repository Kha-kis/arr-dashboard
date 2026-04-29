"use client";

import type { TopMediaResponse, TopMediaType } from "@arr/shared";
import { Film, Music, Trophy, Tv } from "lucide-react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxIsoName, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const ICON_FOR_MEDIA_TYPE: Record<TopMediaType, typeof Film> = {
	movie: Film,
	series: Tv,
	music: Music,
};

const HEADING_FOR_MEDIA_TYPE: Record<TopMediaType, string> = {
	movie: "Top Movies",
	series: "Top Shows",
	music: "Top Music",
};

const SUBJECT_FOR_MEDIA_TYPE: Record<TopMediaType, string> = {
	movie: "movies",
	series: "shows",
	music: "tracks",
};

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

interface TopMediaChartProps {
	data: TopMediaResponse | undefined;
	isLoading: boolean;
	isError: boolean;
	mediaType: TopMediaType;
	service?: "plex" | "jellyfin";
}

export const TopMediaChart = ({
	data,
	isLoading,
	isError,
	mediaType,
	service = "plex",
}: TopMediaChartProps) => {
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const accentColor = SERVICE_GRADIENTS[service].from;
	const Icon = ICON_FOR_MEDIA_TYPE[mediaType];
	const heading = HEADING_FOR_MEDIA_TYPE[mediaType];
	const subject = SUBJECT_FOR_MEDIA_TYPE[mediaType];

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="space-y-2">
					{[0, 1, 2, 3].map((i) => (
						<PremiumSkeleton
							key={i}
							variant="line"
							className="h-8"
							style={{ animationDelay: `${i * 50}ms` }}
						/>
					))}
				</div>
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={Trophy}
				title={`Failed to Load ${heading}`}
				description={`Could not fetch top ${subject}. Try refreshing.`}
			/>
		);
	}

	if (!data || data.items.length === 0) {
		return (
			<PremiumEmptyState
				icon={Trophy}
				title={`No ${heading} Yet`}
				description={`Leaderboard appears once active sessions for ${subject} are captured by the snapshot scheduler.`}
			/>
		);
	}

	const maxPlayCount = Math.max(...data.items.map((item) => item.playCount), 1);

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-4">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Icon className="h-4 w-4" style={{ color: gradient.from }} />
				{heading}
			</h3>

			<div className="space-y-2">
				{data.items.map((item, i) => {
					const displayTitle = incognitoMode ? getLinuxIsoName(item.title) : item.title;
					const widthPercent = (item.playCount / maxPlayCount) * 100;
					return (
						<div key={`${item.title}-${i}`} className="flex items-center gap-3 text-sm group">
							<span
								className="w-5 text-right text-xs font-medium tabular-nums text-muted-foreground/60"
								title={`#${i + 1}`}
							>
								{i + 1}
							</span>
							<div className="flex-1 min-w-0">
								<div
									className="flex items-center gap-2 px-3 py-1.5 rounded-lg overflow-hidden relative"
									title={displayTitle}
								>
									<div
										className="absolute inset-0 transition-all duration-500"
										style={{
											width: `${widthPercent}%`,
											background: `linear-gradient(90deg, ${accentColor}33, ${accentColor}11)`,
											animationDelay: `${i * 30}ms`,
										}}
									/>
									<span className="relative z-10 truncate">{displayTitle}</span>
								</div>
							</div>
							<span className="w-16 text-right font-medium tabular-nums">
								{item.playCount.toLocaleString()}
								<span className="text-[10px] text-muted-foreground ml-1">plays</span>
							</span>
							<span className="w-20 text-right text-xs text-muted-foreground tabular-nums">
								{formatWatchTime(item.totalDurationMinutes)}
							</span>
						</div>
					);
				})}
			</div>
		</div>
	);
};
