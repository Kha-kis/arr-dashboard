"use client";

import { ChevronLeft, ChevronRight, Film, Plus, Tv } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRecentlyAdded } from "../../../hooks/api/usePlex";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const plexGradient = SERVICE_GRADIENTS.plex;
const MAX_DISPLAY = 12;

function timeAgo(dateString: string): string {
	const diff = Date.now() - new Date(dateString).getTime();
	const hours = Math.floor(diff / 3_600_000);
	if (hours < 1) return "Just now";
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d ago`;
	return `${Math.floor(days / 7)}w ago`;
}

function getPlexThumbUrl(instanceId: string, thumb: string): string {
	return `/api/plex/thumb/${instanceId}?path=${encodeURIComponent(thumb)}`;
}

interface RecentlyAddedWidgetProps {
	enabled: boolean;
	animationDelay?: number;
}

export const RecentlyAddedWidget = ({ enabled, animationDelay = 0 }: RecentlyAddedWidgetProps) => {
	const { data, isLoading, isError } = useRecentlyAdded(20, enabled);
	const [failedThumbs, setFailedThumbs] = useState<Set<string>>(new Set());
	const scrollRef = useRef<HTMLDivElement>(null);
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);

	const updateScrollState = useCallback(() => {
		const el = scrollRef.current;
		if (!el) return;
		setCanScrollLeft(el.scrollLeft > 4);
		setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
	}, []);

	useEffect(() => {
		updateScrollState();
		const el = scrollRef.current;
		if (!el) return;
		const observer = new ResizeObserver(updateScrollState);
		observer.observe(el);
		return () => observer.disconnect();
	}, [updateScrollState, data]);

	const scrollBy = useCallback((direction: "left" | "right") => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollBy({ left: direction === "left" ? -300 : 300, behavior: "smooth" });
	}, []);

	if (!enabled || isLoading || isError || !data?.items?.length) return null;

	const displayItems = data.items.slice(0, MAX_DISPLAY);
	const remaining = data.items.length - MAX_DISPLAY;

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<div className="overflow-hidden rounded-xl border border-border/30 bg-muted/10">
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

				<div className="relative group/scroll">
					<div
						ref={scrollRef}
						className="overflow-x-auto scrollbar-thin"
						onScroll={updateScrollState}
					>
						<div className="flex gap-3 p-4 min-w-min">
							{displayItems.map((item, index) => {
								const MediaIcon = item.mediaType === "movie" ? Film : Tv;
								const bgGradient =
									item.mediaType === "movie"
										? "linear-gradient(160deg, #92400e 0%, #f59e0b 100%)"
										: "linear-gradient(160deg, #164e63 0%, #06b6d4 100%)";
								const thumbKey = `${item.instanceId}-${item.tmdbId}`;
								const hasThumb = item.thumb && !failedThumbs.has(thumbKey);
								const libraryHref = item.tmdbId ? `/library?tmdbId=${item.tmdbId}` : "/library";

								return (
									<Link
										key={`${item.instanceId}-${item.tmdbId}-${item.mediaType}`}
										href={libraryHref}
										className="flex-shrink-0 w-[140px] group animate-in fade-in slide-in-from-bottom-2 duration-300"
										style={{
											animationDelay: `${index * 30}ms`,
											animationFillMode: "backwards",
										}}
									>
										<div
											className="relative aspect-[2/3] rounded-lg overflow-hidden mb-2 transition-transform duration-200 group-hover:scale-[1.03]"
											style={{
												background: bgGradient,
												boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
											}}
										>
											{hasThumb ? (
												<Image
													src={getPlexThumbUrl(item.instanceId, item.thumb!)}
													alt={item.title}
													width={140}
													height={210}
													className="absolute inset-0 w-full h-full object-cover"
													onError={() => setFailedThumbs((prev) => new Set(prev).add(thumbKey))}
												/>
											) : (
												<MediaIcon className="absolute inset-0 m-auto h-10 w-10 text-white/30" />
											)}
											<div className="absolute top-2 right-2 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white/90 leading-tight">
												{timeAgo(item.addedAt)}
											</div>
										</div>
										<p
											className="text-sm font-medium text-foreground line-clamp-2 leading-snug mb-0.5"
											title={item.title}
										>
											{item.title}
										</p>
										<span className="text-xs text-muted-foreground truncate block">
											{item.sectionTitle}
										</span>
									</Link>
								);
							})}
							{remaining > 0 && (
								<div className="flex-shrink-0 w-[140px] flex items-center justify-center">
									<span className="text-sm text-muted-foreground">+{remaining} more</span>
								</div>
							)}
						</div>
					</div>

					{/* Scroll fade indicators */}
					{canScrollLeft && (
						<div className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-card/80 to-transparent pointer-events-none z-[1] rounded-bl-xl" />
					)}
					{canScrollRight && (
						<div className="absolute right-0 top-0 bottom-0 w-12 bg-gradient-to-l from-card/80 to-transparent pointer-events-none z-[1] rounded-br-xl" />
					)}

					{/* Scroll arrow buttons */}
					{canScrollLeft && (
						<button
							type="button"
							onClick={() => scrollBy("left")}
							className="absolute left-2 top-1/2 -translate-y-1/2 z-[2] flex h-8 w-8 items-center justify-center rounded-full bg-card/90 border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-all opacity-0 group-hover/scroll:opacity-100 duration-200 shadow-lg backdrop-blur-sm"
						>
							<ChevronLeft className="h-4 w-4" />
						</button>
					)}
					{canScrollRight && (
						<button
							type="button"
							onClick={() => scrollBy("right")}
							className="absolute right-2 top-1/2 -translate-y-1/2 z-[2] flex h-8 w-8 items-center justify-center rounded-full bg-card/90 border border-border/50 text-muted-foreground hover:text-foreground hover:border-border transition-all opacity-0 group-hover/scroll:opacity-100 duration-200 shadow-lg backdrop-blur-sm"
						>
							<ChevronRight className="h-4 w-4" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
};
