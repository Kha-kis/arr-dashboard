"use client";

import { Film, PlayCircle, Tv } from "lucide-react";
import { GlassmorphicCard } from "../../../components/layout";
import { useOnDeck } from "../../../hooks/api/usePlex";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const plexGradient = SERVICE_GRADIENTS.plex;

interface OnDeckWidgetProps {
	enabled: boolean;
	animationDelay?: number;
}

export const OnDeckWidget = ({ enabled, animationDelay = 0 }: OnDeckWidgetProps) => {
	const { data, isLoading, isError } = useOnDeck(enabled);

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
						<PlayCircle className="h-4 w-4" style={{ color: plexGradient.from }} />
					</div>
					<div>
						<h3 className="text-sm font-semibold text-foreground">Continue Watching</h3>
						<p className="text-xs text-muted-foreground">
							{data.items.length} item{data.items.length !== 1 ? "s" : ""} on deck
						</p>
					</div>
				</div>

				<div className="overflow-x-auto">
					<div className="flex gap-3 p-4 min-w-min">
						{data.items.map((item, index) => {
							const MediaIcon = item.mediaType === "movie" ? Film : Tv;
							return (
								<div
									key={`${item.instanceId}-${item.tmdbId}-${item.mediaType}`}
									className="flex-shrink-0 w-40 rounded-lg border border-border/50 bg-card/50 p-3 transition-colors hover:border-border/80 animate-in fade-in slide-in-from-bottom-2 duration-300"
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
									<p className="text-sm font-medium text-foreground truncate" title={item.title}>
										{item.title}
									</p>
									<p className="text-xs text-muted-foreground truncate mt-1">{item.instanceName}</p>
								</div>
							);
						})}
					</div>
				</div>
			</GlassmorphicCard>
		</div>
	);
};
