"use client";

import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useWatchHistory } from "../../../hooks/api/usePlex";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { Clock, MonitorPlay } from "lucide-react";

// ============================================================================
// Time Formatting
// ============================================================================

function formatRelativeTime(isoDate: string): string {
	const diff = Date.now() - new Date(isoDate).getTime();
	const minutes = Math.floor(diff / 60000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

// ============================================================================
// Watch History Widget
// ============================================================================

interface WatchHistoryWidgetProps {
	days: number;
	enabled: boolean;
}

export const WatchHistoryWidget = ({ days, enabled }: WatchHistoryWidgetProps) => {
	const { gradient } = useThemeGradient();
	const { data, isLoading, isError } = useWatchHistory(days, 20, enabled);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="space-y-3">
					{[0, 1, 2].map((i) => (
						<PremiumSkeleton key={i} variant="line" className="h-12" style={{ animationDelay: `${i * 50}ms` }} />
					))}
				</div>
			</div>
		);
	}

	if (isError) {
		return (
			<PremiumEmptyState
				icon={Clock}
				title="Failed to Load Watch History"
				description="Could not fetch watch history data."
			/>
		);
	}

	if (!data || data.events.length === 0) {
		return (
			<PremiumEmptyState
				icon={Clock}
				title="No Watch History Yet"
				description="Watch events will appear here once session data is captured."
			/>
		);
	}

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 backdrop-blur-xs p-6 space-y-4">
			<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
				<Clock className="h-4 w-4" style={{ color: gradient.from }} />
				Recent Watch History
			</h3>

			<div className="space-y-1">
				{data.events.map((event: { user: string; title: string; timestamp: string; platform: string | null; videoDecision: string | null }, i: number) => (
					<div
						key={`${event.user}-${event.title}-${event.timestamp}`}
						className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-muted/20 transition-colors animate-in fade-in slide-in-from-bottom-1 duration-200"
						style={{ animationDelay: `${i * 30}ms`, animationFillMode: "backwards" }}
					>
						{/* User avatar placeholder */}
						<div
							className="h-8 w-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
							style={{ backgroundColor: `${gradient.from}20`, color: gradient.from }}
						>
							{event.user.charAt(0).toUpperCase()}
						</div>

						{/* Content */}
						<div className="flex-1 min-w-0">
							<p className="text-sm font-medium truncate">{event.title}</p>
							<p className="text-[10px] text-muted-foreground flex items-center gap-2">
								<span>{event.user}</span>
								{event.platform && (
									<>
										<span className="text-border">·</span>
										<span>{event.platform}</span>
									</>
								)}
								{event.videoDecision && (
									<>
										<span className="text-border">·</span>
										<span className="flex items-center gap-0.5">
											<MonitorPlay className="h-2.5 w-2.5" />
											{event.videoDecision}
										</span>
									</>
								)}
							</p>
						</div>

						{/* Timestamp */}
						<span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
							{formatRelativeTime(event.timestamp)}
						</span>
					</div>
				))}
			</div>
		</div>
	);
};
