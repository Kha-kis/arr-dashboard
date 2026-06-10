"use client";

import { ChevronLeft, ChevronRight, Film, Plus, Tv } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useJellyfinRecentlyAdded } from "../../../hooks/api/useJellyfin";
import { useRecentlyAdded } from "../../../hooks/api/usePlex";
import { getLinuxIsoName, getLinuxSectionName, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const mediaGradient = SERVICE_GRADIENTS.plex;
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

function getJellyfinThumbUrl(instanceId: string, jellyfinId: string): string {
	return `/api/jellyfin/thumb/${instanceId}?itemId=${encodeURIComponent(jellyfinId)}`;
}

interface NormalizedRecentItem {
	key: string;
	tmdbId: number;
	title: string;
	mediaType: string;
	sectionTitle: string;
	addedAt: string | null;
	instanceId: string;
	thumbUrl: string | null;
}

interface RecentlyAddedWidgetProps {
	hasPlexInstances: boolean;
	hasJellyfinInstances: boolean;
	animationDelay?: number;
}

export const RecentlyAddedWidget = ({ hasPlexInstances, hasJellyfinInstances, animationDelay = 0 }: RecentlyAddedWidgetProps) => {
	const enabled = hasPlexInstances || hasJellyfinInstances;
	const [incognitoMode] = useIncognitoMode();
	const plexQuery = useRecentlyAdded(20, hasPlexInstances);
	const jellyfinQuery = useJellyfinRecentlyAdded(20, hasJellyfinInstances);

	const items = useMemo<NormalizedRecentItem[]>(() => {
		const result: NormalizedRecentItem[] = [];
		for (const item of plexQuery.data?.items ?? []) {
			result.push({
				key: `plex:${item.instanceId}:${item.tmdbId}:${item.mediaType}`,
				tmdbId: item.tmdbId,
				title: item.title,
				mediaType: item.mediaType,
				sectionTitle: item.sectionTitle,
				addedAt: item.addedAt,
				instanceId: item.instanceId,
				thumbUrl: item.thumb ? getPlexThumbUrl(item.instanceId, item.thumb) : null,
			});
		}
		for (const item of jellyfinQuery.data?.items ?? []) {
			result.push({
				key: `jellyfin:${item.instanceId}:${item.tmdbId}:${item.mediaType}`,
				tmdbId: item.tmdbId,
				title: item.title,
				mediaType: item.mediaType,
				sectionTitle: item.libraryName,
				addedAt: item.addedAt,
				instanceId: item.instanceId,
				thumbUrl: item.jellyfinId ? getJellyfinThumbUrl(item.instanceId, item.jellyfinId) : null,
			});
		}
		// Sort by addedAt descending (most recent first)
		result.sort((a, b) => {
			if (!a.addedAt) return 1;
			if (!b.addedAt) return -1;
			return new Date(b.addedAt).getTime() - new Date(a.addedAt).getTime();
		});
		return result;
	}, [plexQuery.data, jellyfinQuery.data]);

	const isLoading = plexQuery.isLoading || jellyfinQuery.isLoading;
	const enabledErrors = [hasPlexInstances && plexQuery.isError, hasJellyfinInstances && jellyfinQuery.isError].filter(Boolean).length;
	const enabledCount = [hasPlexInstances, hasJellyfinInstances].filter(Boolean).length;
	const isError = enabledCount > 0 && enabledErrors === enabledCount;
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
	}, [updateScrollState, items]);

	const scrollBy = useCallback((direction: "left" | "right") => {
		const el = scrollRef.current;
		if (!el) return;
		el.scrollBy({ left: direction === "left" ? -300 : 300, behavior: "smooth" });
	}, []);

	if (!enabled || isLoading || isError || items.length === 0) return null;

	const displayItems = items.slice(0, MAX_DISPLAY);
	const remaining = items.length - MAX_DISPLAY;

	return (
		<div
			className="animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<div className="overflow-hidden rounded-xl border border-border/30 bg-muted/10">
				<div
					className="h-0.5 w-full rounded-t-xl"
					style={{
						background: `linear-gradient(90deg, ${mediaGradient.from}, ${mediaGradient.to})`,
					}}
				/>
				<div className="flex items-center gap-3 px-6 py-4 border-b border-border/50">
					<div
						className="flex h-8 w-8 items-center justify-center rounded-lg"
						style={{
							background: `linear-gradient(135deg, ${mediaGradient.from}20, ${mediaGradient.to}20)`,
							border: `1px solid ${mediaGradient.from}30`,
						}}
					>
						<Plus className="h-4 w-4" style={{ color: mediaGradient.from }} />
					</div>
					<div>
						<h3 className="text-sm font-semibold text-foreground">Recently Added</h3>
						<p className="text-xs text-muted-foreground">Latest additions to your media library</p>
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
										? // Decorative poster-placeholder art, categorical not semantic (B2 carve-out)
											"linear-gradient(160deg, #92400e 0%, #f59e0b 100%)"
										: "linear-gradient(160deg, #164e63 0%, #06b6d4 100%)";
								const thumbKey = item.key;
								const hasThumb = item.thumbUrl && !failedThumbs.has(thumbKey);
								const libraryHref = item.tmdbId ? `/library?tmdbId=${item.tmdbId}` : "/library";
								const displayTitle = incognitoMode ? getLinuxIsoName(item.title) : item.title;
								const displaySection = incognitoMode && item.sectionTitle ? getLinuxSectionName(item.sectionTitle) : item.sectionTitle;

								return (
									<Link
										key={item.key}
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
											{hasThumb && !incognitoMode ? (
												<Image
													src={item.thumbUrl!}
													alt={displayTitle}
													width={140}
													height={210}
													className="absolute inset-0 w-full h-full object-cover"
													onError={() => setFailedThumbs((prev) => new Set(prev).add(thumbKey))}
											unoptimized
												/>
											) : (
												<MediaIcon className="absolute inset-0 m-auto h-10 w-10 text-white/30" />
											)}
											{item.addedAt && (
												<div className="absolute top-2 right-2 rounded-full bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white/90 leading-tight">
													{timeAgo(item.addedAt)}
												</div>
											)}
										</div>
										<p
											className="text-sm font-medium text-foreground line-clamp-2 leading-snug mb-0.5"
											title={displayTitle}
										>
											{displayTitle}
										</p>
										<span className="text-xs text-muted-foreground truncate block">
											{displaySection}
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
