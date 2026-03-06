"use client";

import type { TautulliWatchHistoryItem } from "@arr/shared";
import { Clock, Film, Headphones, History, Tv } from "lucide-react";
import { useState } from "react";
import { GlassmorphicCard, PremiumSkeleton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import { useWatchHistory } from "../../../hooks/api/useTautulli";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

// ============================================================================
// Helpers
// ============================================================================

function formatTimeAgo(isoDate: string): string {
	const diff = Date.now() - new Date(isoDate).getTime();
	const minutes = Math.floor(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return new Date(isoDate).toLocaleDateString();
}

const MEDIA_ICONS = {
	movie: Film,
	episode: Tv,
	track: Headphones,
} as const;

const plexGradient = SERVICE_GRADIENTS.plex;

// ============================================================================
// History Item Row
// ============================================================================

const HistoryRow = ({
	item,
	index,
}: { item: TautulliWatchHistoryItem; index: number }) => {
	const Icon = MEDIA_ICONS[item.mediaType] ?? Film;
	const displayTitle = item.grandparentTitle
		? `${item.grandparentTitle} — ${item.title}`
		: item.title;

	return (
		<div
			className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-card/40 animate-in fade-in slide-in-from-bottom-1 duration-200"
			style={{
				animationDelay: `${index * 30}ms`,
				animationFillMode: "backwards",
			}}
		>
			{/* Media type icon */}
			<div
				className="flex h-8 w-8 items-center justify-center rounded-lg shrink-0"
				style={{
					background: `linear-gradient(135deg, ${plexGradient.from}15, ${plexGradient.to}15)`,
					border: `1px solid ${plexGradient.from}25`,
				}}
			>
				<Icon className="h-4 w-4" style={{ color: plexGradient.from }} />
			</div>

			{/* Title + metadata */}
			<div className="flex-1 min-w-0">
				<p className="text-sm font-medium text-foreground truncate">{displayTitle}</p>
				<div className="flex items-center gap-2 text-xs text-muted-foreground">
					<span>{item.user}</span>
					{item.platform && (
						<>
							<span className="text-muted-foreground/30">·</span>
							<span>{item.platform}</span>
						</>
					)}
				</div>
			</div>

			{/* Time ago */}
			<div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
				<Clock className="h-3 w-3" />
				<span title={new Date(item.watchedAt).toLocaleString()}>
					{formatTimeAgo(item.watchedAt)}
				</span>
			</div>
		</div>
	);
};

// ============================================================================
// Main Component
// ============================================================================

interface WatchHistorySectionProps {
	enabled: boolean;
}

export const WatchHistorySection = ({ enabled }: WatchHistorySectionProps) => {
	const [pageSize] = useState(25);
	const query = useWatchHistory(pageSize, 0, enabled);
	const items = query.data?.history ?? [];
	const totalCount = query.data?.totalCount ?? 0;

	if (query.isLoading) {
		return (
			<div className="mt-6 space-y-2">
				<div className="flex items-center gap-2 mb-4">
					<History className="h-4 w-4" style={{ color: plexGradient.from }} />
					<span className="text-sm font-semibold text-foreground">Recent Watch History</span>
				</div>
				{[0, 1, 2].map((i) => (
					<PremiumSkeleton key={i} variant="line" className="h-14 w-full" style={{ animationDelay: `${i * 50}ms` }} />
				))}
			</div>
		);
	}

	if (!enabled || items.length === 0) return null;

	return (
		<div className="mt-6">
			<div className="flex items-center justify-between mb-4">
				<div className="flex items-center gap-2">
					<History className="h-4 w-4" style={{ color: plexGradient.from }} />
					<span className="text-sm font-semibold text-foreground">Recent Watch History</span>
					{totalCount > 0 && (
						<span className="text-xs text-muted-foreground">
							({totalCount} total)
						</span>
					)}
				</div>
				{query.isRefetching && (
					<span className="text-xs text-muted-foreground animate-pulse">Updating...</span>
				)}
			</div>

			<GlassmorphicCard padding="none" className="divide-y divide-border/30 overflow-hidden">
				{items.map((item, index) => (
					<HistoryRow
						key={`${item.ratingKey}:${item.watchedAt}:${index}`}
						item={item}
						index={index}
					/>
				))}
			</GlassmorphicCard>

			{totalCount > pageSize && (
				<div className="flex justify-center mt-3">
					<Button
						variant="secondary"
						size="sm"
						onClick={() => query.refetch()}
						className="text-xs"
					>
						Showing {items.length} of {totalCount}
					</Button>
				</div>
			)}
		</div>
	);
};
