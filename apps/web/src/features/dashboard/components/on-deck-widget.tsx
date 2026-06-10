"use client";

import { ChevronLeft, ChevronRight, Film, PlayCircle, Tv } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useJellyfinOnDeck } from "../../../hooks/api/useJellyfin";
import { useOnDeck } from "../../../hooks/api/usePlex";
import { getLinuxIsoName, getLinuxSectionName, useIncognitoMode } from "../../../lib/incognito";
import { SERVICE_GRADIENTS } from "../../../lib/theme-gradients";

const mediaGradient = SERVICE_GRADIENTS.plex;
const MAX_DISPLAY = 10;

function getPlexThumbUrl(instanceId: string, thumb: string): string {
	return `/api/plex/thumb/${instanceId}?path=${encodeURIComponent(thumb)}`;
}

function getJellyfinThumbUrl(instanceId: string, jellyfinId: string): string {
	return `/api/jellyfin/thumb/${instanceId}?itemId=${encodeURIComponent(jellyfinId)}`;
}

interface NormalizedOnDeckItem {
	key: string;
	tmdbId: number;
	title: string;
	mediaType: string;
	sectionTitle: string;
	instanceId: string;
	thumbUrl: string | null;
}

interface OnDeckWidgetProps {
	hasPlexInstances: boolean;
	hasJellyfinInstances: boolean;
	animationDelay?: number;
}

export const OnDeckWidget = ({ hasPlexInstances, hasJellyfinInstances, animationDelay = 0 }: OnDeckWidgetProps) => {
	const enabled = hasPlexInstances || hasJellyfinInstances;
	const [incognitoMode] = useIncognitoMode();
	const plexQuery = useOnDeck(hasPlexInstances);
	const jellyfinQuery = useJellyfinOnDeck(hasJellyfinInstances);

	const items = useMemo<NormalizedOnDeckItem[]>(() => {
		const result: NormalizedOnDeckItem[] = [];
		for (const item of plexQuery.data?.items ?? []) {
			result.push({
				key: `plex:${item.instanceId}:${item.tmdbId}:${item.mediaType}`,
				tmdbId: item.tmdbId,
				title: item.title,
				mediaType: item.mediaType,
				sectionTitle: item.sectionTitle,
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
				instanceId: item.instanceId,
				thumbUrl: item.jellyfinId ? getJellyfinThumbUrl(item.instanceId, item.jellyfinId) : null,
			});
		}
		return result;
	}, [plexQuery.data, jellyfinQuery.data]);

	const isLoading = plexQuery.isLoading || jellyfinQuery.isLoading;
	// Only error if all enabled sources failed
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
						<PlayCircle className="h-4 w-4" style={{ color: mediaGradient.from }} />
					</div>
					<div>
						<h3 className="text-sm font-semibold text-foreground">Continue Watching</h3>
						<p className="text-xs text-muted-foreground">
							{items.length} item{items.length !== 1 ? "s" : ""} on deck
						</p>
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
