"use client";

import { Clock, Film, Plus, Tv } from "lucide-react";
import { GlassmorphicCard } from "../../../components/layout";
import { useRecentlyAdded } from "../../../hooks/api/usePlex";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const plexGradient = SERVICE_GRADIENTS.plex;

function timeAgo(dateString: string): string {
	const diff = Date.now() - new Date(dateString).getTime();
	const hours = Math.floor(diff / 3_600_000);
	if (hours < 1) return "Just now";
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return `${Math.floor(days / 7)}w ago`;
}

interface RecentlyAddedWidgetProps {
	enabled: boolean;
	animationDelay?: number;
}

export const RecentlyAddedWidget = ({ enabled, animationDelay = 0 }: RecentlyAddedWidgetProps) => {
	const { data, isLoading, isError } = useRecentlyAdded(20, enabled);

	if (!enabled || isLoading || isError || !data?.items?.length) return null;

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<GlassmorphicCard padding="none">
				<div
					className="h-0.5 w-full rounded-t-xl"
					style={{
						background: `linear-gradient(90deg, ${plexGradient.from}, ${plexGradient.to})`,
					}}
				/>
				<div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg"
						style={{
							background: `linear-gradient(135deg, ${plexGradient.from}20, ${plexGradient.to}20)`,
							border: `1px solid ${plexGradient.from}30`,
						}}
					>
						<Plus className="h-4 w-4" style={{ color: plexGradient.from }} />
					</div>
					<div>
						<h3 className="text-sm font-semibold text-foreground">Recently Added</h3>
						<p className="text-xs text-muted-foreground">Latest additions to your Plex library</p>
					</div>
				</div>

				<div className="overflow-x-auto">
					<div className="flex gap-3 p-4 min-w-min">
						{data.items.map((item, index) => {
							const MediaIcon = item.mediaType === "movie" ? Film : Tv;
							return (
								<div
									key={`${item.instanceId}-${item.tmdbId}-${item.mediaType}`}
									className="flex-shrink-0 w-36 rounded-lg border border-border/50 bg-card/50 p-3 transition-colors hover:border-border/80 animate-in fade-in slide-in-from-bottom-2 duration-300"
									style={{
										animationDelay: `${index * 30}ms`,
										animationFillMode: "backwards",
									}}
								>
									<div className="flex items-center gap-1.5 mb-2">
										<MediaIcon
											className="h-3.5 w-3.5 flex-shrink-0"
											style={{ color: plexGradient.from }}
										/>
										<span className="text-xs font-medium text-muted-foreground truncate">
											{item.sectionTitle}
										</span>
									</div>
									<p
										className="text-sm font-medium text-foreground truncate mb-1.5"
										title={item.title}
									>
										{item.title}
									</p>
									<div className="flex items-center gap-1 text-xs text-muted-foreground">
										<Clock className="h-3 w-3" />
										<span>{timeAgo(item.addedAt)}</span>
									</div>
								</div>
							);
						})}
					</div>
				</div>
			</GlassmorphicCard>
		</div>
	);
};
