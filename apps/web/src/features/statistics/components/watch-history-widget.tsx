"use client";

import type { WatchHistoryResponse } from "@arr/shared";
import { ChevronDown, ChevronUp, Clock, MonitorPlay } from "lucide-react";
import { useState } from "react";
import { PremiumEmptyState, PremiumSkeleton } from "../../../components/layout";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getLinuxIsoName, getLinuxUsername, useIncognitoMode } from "../../../lib/incognito";

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

const INITIAL_VISIBLE = 5;

interface WatchHistoryWidgetProps {
	data: WatchHistoryResponse | undefined;
	isLoading: boolean;
	isError: boolean;
	service?: "plex" | "jellyfin";
}

export const WatchHistoryWidget = ({ data, isLoading, isError }: WatchHistoryWidgetProps) => {
	const { gradient } = useThemeGradient();
	const [incognitoMode] = useIncognitoMode();
	const [expanded, setExpanded] = useState(false);

	if (isLoading) {
		return (
			<div className="rounded-xl border border-border/30 bg-card/30 p-6">
				<PremiumSkeleton variant="line" className="h-5 w-40 mb-4" />
				<div className="space-y-3">
					{[0, 1, 2].map((i) => (
						<PremiumSkeleton
							key={i}
							variant="line"
							className="h-12"
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

	const totalEvents = data.events.length;
	const hasMore = totalEvents > INITIAL_VISIBLE;
	const visibleEvents = expanded ? data.events : data.events.slice(0, INITIAL_VISIBLE);

	return (
		<div className="rounded-xl border border-border/30 bg-card/30 p-6 space-y-4">
			<div className="flex items-center justify-between">
				<h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
					<Clock className="h-4 w-4" style={{ color: gradient.from }} />
					Recent Watch History
				</h3>
				{hasMore && (
					<span className="text-[10px] text-muted-foreground/40 tabular-nums">
						{expanded ? totalEvents : INITIAL_VISIBLE} of {totalEvents}
					</span>
				)}
			</div>

			<div className="space-y-1">
				{visibleEvents.map(
					(
						event: {
							user: string;
							title: string;
							timestamp: string;
							platform: string | null;
							videoDecision: string | null;
						},
						i: number,
					) => (
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
								{(incognitoMode ? getLinuxUsername(event.user) : event.user)
									.charAt(0)
									.toUpperCase()}
							</div>

							{/* Content */}
							<div className="flex-1 min-w-0">
								<p className="text-sm font-medium truncate">
									{incognitoMode ? getLinuxIsoName(event.title) : event.title}
								</p>
								<p className="text-[10px] text-muted-foreground flex items-center gap-2">
									<span>{incognitoMode ? getLinuxUsername(event.user) : event.user}</span>
									{event.platform && (
										<>
											<span className="text-border">·</span>
											<span>{incognitoMode ? "Linux" : event.platform}</span>
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
					),
				)}
			</div>

			{/* Show more / less toggle */}
			{hasMore && (
				<button
					type="button"
					onClick={() => setExpanded(!expanded)}
					className="w-full flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-muted-foreground/50 hover:text-muted-foreground transition-colors rounded-lg hover:bg-muted/10"
				>
					{expanded ? (
						<>
							Show less
							<ChevronUp className="h-3.5 w-3.5" />
						</>
					) : (
						<>
							Show {totalEvents - INITIAL_VISIBLE} more
							<ChevronDown className="h-3.5 w-3.5" />
						</>
					)}
				</button>
			)}
		</div>
	);
};
