"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { RecommendationItem } from "@arr/shared";
import type { LucideIcon } from "lucide-react";
import { Loader2, Star, ChevronLeft, ChevronRight, ExternalLink, CheckCircle2, Sparkles } from "lucide-react";
import { fetchTMDBExternalIds } from "../../../lib/api-client/tmdb";
import { THEME_GRADIENTS, SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";
import { GlassmorphicCard, PremiumSkeleton } from "../../../components/layout";

// ============================================================================
// Premium Recommendation Card
// ============================================================================

interface RecommendationCardProps {
	item: RecommendationItem;
	mediaType: "movie" | "series";
	onSelect: (item: RecommendationItem) => void;
	index: number;
}

/**
 * Premium recommendation card with on-demand external ID fetching.
 * Features glassmorphic overlay, theme-aware styling, and hover effects.
 */
const RecommendationCard: React.FC<RecommendationCardProps> = ({ item, mediaType, onSelect, index }) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const [externalIds, setExternalIds] = useState<{ imdbId: string | null; tvdbId: number | null } | null>(null);
	const [isHovered, setIsHovered] = useState(false);
	const fetchedRef = useRef(false);

	// Fetch external IDs on first hover
	useEffect(() => {
		if (isHovered && !fetchedRef.current && !externalIds) {
			fetchedRef.current = true;
			const tmdbMediaType = mediaType === "movie" ? "movie" : "tv";
			fetchTMDBExternalIds(tmdbMediaType, item.tmdbId)
				.then((data) => {
					setExternalIds({ imdbId: data.imdbId, tvdbId: data.tvdbId });
				})
				.catch(() => {
					// Silently fail - TMDB link is always available
				});
		}
	}, [isHovered, externalIds, item.tmdbId, mediaType]);

	// Use item's existing IDs if available (from cache), otherwise use fetched ones
	const imdbId = item.imdbId ?? externalIds?.imdbId;
	const tvdbId = item.tvdbId ?? externalIds?.tvdbId;

	// Check if item is already in library
	const isInLibrary = item.libraryStatus === "in-library";

	return (
		<div
			className="group relative w-[160px] flex-shrink-0 cursor-pointer overflow-hidden rounded-xl transition-all duration-300 hover:scale-[1.03] animate-in fade-in slide-in-from-bottom-2"
			style={{
				animationDelay: `${index * 30}ms`,
				animationFillMode: "backwards",
			}}
			onClick={() => onSelect(item)}
			onMouseEnter={() => setIsHovered(true)}
		>
			{/* Card Border with Gradient on Hover */}
			<div
				className="absolute inset-0 rounded-xl transition-opacity duration-300 opacity-0 group-hover:opacity-100"
				style={{
					background: `linear-gradient(135deg, ${themeGradient.from}40, ${themeGradient.to}40)`,
					padding: "1px",
				}}
			/>

			{/* Card Content */}
			<div className="relative rounded-xl border border-border/50 bg-card/80 backdrop-blur-sm overflow-hidden group-hover:border-transparent transition-colors duration-300">
				{/* Poster */}
				<div className="relative aspect-[2/3] w-full overflow-hidden bg-gradient-to-br from-slate-800 to-slate-900">
					{item.posterUrl ? (
						/* eslint-disable-next-line @next/next/no-img-element -- External TMDB image with dynamic URL */
						<img
							src={item.posterUrl}
							alt={item.title}
							className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-110"
						/>
					) : (
						<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
							No poster
						</div>
					)}

					{/* Gradient Overlay on Hover */}
					<div
						className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-300"
						style={{
							background: `linear-gradient(to top, ${themeGradient.from}40, transparent 60%)`,
						}}
					/>

					{/* Rating Badge */}
					{typeof item.rating === "number" && item.rating > 0 && (
						<div
							className="absolute right-2 top-2 flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium backdrop-blur-md"
							style={{
								backgroundColor: "rgba(234, 179, 8, 0.15)",
								border: "1px solid rgba(234, 179, 8, 0.3)",
								color: "#fbbf24",
							}}
						>
							<Star className="h-3 w-3 fill-yellow-400" />
							{item.rating.toFixed(1)}
						</div>
					)}

					{/* In Library Badge */}
					{isInLibrary && (
						<div
							className="absolute left-2 top-2 flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium backdrop-blur-md"
							style={{
								backgroundColor: SEMANTIC_COLORS.success.bg,
								border: `1px solid ${SEMANTIC_COLORS.success.border}`,
								color: SEMANTIC_COLORS.success.text,
							}}
						>
							<CheckCircle2 className="h-3 w-3" />
						</div>
					)}

					{/* External Links on Hover */}
					<div
						className="absolute bottom-2 left-2 right-2 flex flex-wrap items-center gap-1.5 opacity-0 translate-y-2 group-hover:opacity-100 group-hover:translate-y-0 transition-all duration-300"
						onClick={(e) => e.stopPropagation()}
					>
						<a
							href={`https://www.themoviedb.org/${mediaType === "movie" ? "movie" : "tv"}/${item.tmdbId}`}
							target="_blank"
							rel="noopener noreferrer"
							className="flex items-center gap-1 rounded-md border border-white/20 bg-black/70 px-2 py-1 text-xs text-white/80 backdrop-blur-md transition-all hover:bg-black/90 hover:text-white"
							title="View on TMDB"
						>
							TMDB
							<ExternalLink className="h-2.5 w-2.5" />
						</a>
						{imdbId && (
							<a
								href={`https://www.imdb.com/title/${imdbId}`}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-1 rounded-md border border-white/20 bg-black/70 px-2 py-1 text-xs text-white/80 backdrop-blur-md transition-all hover:bg-black/90 hover:text-white"
								title="View on IMDB"
							>
								IMDB
							</a>
						)}
						{tvdbId && (
							<a
								href={`https://www.thetvdb.com/dereferrer/series/${tvdbId}`}
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-1 rounded-md border border-white/20 bg-black/70 px-2 py-1 text-xs text-white/80 backdrop-blur-md transition-all hover:bg-black/90 hover:text-white"
								title="View on TVDB"
							>
								TVDB
							</a>
						)}
					</div>
				</div>

				{/* Title Section */}
				<div className="p-3 space-y-1">
					<p className="truncate text-sm font-medium text-foreground group-hover:text-foreground transition-colors">
						{item.title}
					</p>
					{item.releaseDate && (
						<p className="text-xs text-muted-foreground">
							{new Date(item.releaseDate).getFullYear()}
						</p>
					)}
				</div>
			</div>
		</div>
	);
};

// ============================================================================
// Premium Loading Skeleton
// ============================================================================

const CarouselSkeleton: React.FC = () => (
	<div className="flex gap-4">
		{Array.from({ length: 7 }).map((_, i) => (
			<div
				key={i}
				className="w-[160px] flex-shrink-0 animate-pulse"
				style={{
					animationDelay: `${i * 50}ms`,
				}}
			>
				<div className="rounded-xl border border-border/30 bg-card/30 overflow-hidden">
					<div className="aspect-[2/3] bg-gradient-to-br from-slate-800/50 to-slate-900/50" />
					<div className="p-3 space-y-2">
						<div className="h-4 w-3/4 rounded bg-muted/30" />
						<div className="h-3 w-1/2 rounded bg-muted/20" />
					</div>
				</div>
			</div>
		))}
	</div>
);

// ============================================================================
// TMDBCarousel Component
// ============================================================================

/**
 * Props for the TMDBCarousel component
 */
interface TMDBCarouselProps {
	/** Title of the carousel section */
	title: string;
	/** Optional description text */
	description?: string;
	/** Icon component for the section header */
	icon?: LucideIcon;
	/** Array of recommendation items to display */
	items: RecommendationItem[];
	/** Media type for generating correct TMDB links */
	mediaType: "movie" | "series";
	/** Callback when an item is selected */
	onSelectItem: (item: RecommendationItem) => void;
	/** Whether the initial data is loading */
	isLoading?: boolean;
	/** Whether the next page is being fetched */
	isFetchingNextPage?: boolean;
	/** Whether there are more pages to load */
	hasNextPage?: boolean;
	/** Callback to load more items */
	onLoadMore?: () => void;
	/** Animation delay in ms */
	animationDelay?: number;
}

/**
 * Premium TMDB Carousel
 *
 * Horizontal scrolling carousel with:
 * - Theme-aware section header with gradient icon
 * - Glassmorphic navigation buttons
 * - Infinite scroll pagination
 * - Premium card styling with hover effects
 */
export const TMDBCarousel: React.FC<TMDBCarouselProps> = ({
	title,
	description,
	icon: Icon,
	items,
	mediaType,
	onSelectItem,
	isLoading,
	isFetchingNextPage,
	hasNextPage,
	onLoadMore,
	animationDelay = 0,
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);

	const checkScrollButtons = useCallback(() => {
		if (!scrollContainerRef.current) return;
		const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
		setCanScrollLeft(scrollLeft > 0);
		setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10);
	}, []);

	const scroll = useCallback((direction: "left" | "right") => {
		if (!scrollContainerRef.current) return;
		const scrollAmount = scrollContainerRef.current.clientWidth * 0.8;
		scrollContainerRef.current.scrollBy({
			left: direction === "left" ? -scrollAmount : scrollAmount,
			behavior: "smooth",
		});
	}, []);

	const handleScroll = useCallback(() => {
		checkScrollButtons();

		// Check if we're near the end and should load more
		if (!scrollContainerRef.current || !hasNextPage || isFetchingNextPage) return;

		const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
		const scrollPercentage = (scrollLeft + clientWidth) / scrollWidth;

		// Load more when scrolled 80% to the right
		if (scrollPercentage > 0.8 && onLoadMore) {
			onLoadMore();
		}
	}, [checkScrollButtons, hasNextPage, isFetchingNextPage, onLoadMore]);

	useEffect(() => {
		checkScrollButtons();
		const container = scrollContainerRef.current;
		if (container) {
			container.addEventListener("scroll", handleScroll);
			window.addEventListener("resize", checkScrollButtons);
			return () => {
				container.removeEventListener("scroll", handleScroll);
				window.removeEventListener("resize", checkScrollButtons);
			};
		}
	}, [items.length, handleScroll, checkScrollButtons]);

	// Loading State
	if (isLoading) {
		return (
			<section
				className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				{/* Section Header */}
				<div className="flex items-center gap-3">
					{Icon && (
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Icon className="h-5 w-5" style={{ color: themeGradient.from }} />
						</div>
					)}
					<div>
						<h2 className="text-lg font-semibold text-foreground">{title}</h2>
						{description && <p className="text-sm text-muted-foreground">{description}</p>}
					</div>
				</div>

				<CarouselSkeleton />
			</section>
		);
	}

	// Empty State
	if (items.length === 0) {
		return null;
	}

	return (
		<section
			className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			{/* Section Header */}
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-3">
					{Icon && (
						<div
							className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
							style={{
								background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
								border: `1px solid ${themeGradient.from}30`,
							}}
						>
							<Icon className="h-5 w-5" style={{ color: themeGradient.from }} />
						</div>
					)}
					<div>
						<h2 className="text-lg font-semibold text-foreground">{title}</h2>
						{description && <p className="text-sm text-muted-foreground">{description}</p>}
					</div>
				</div>

				{/* Item Count */}
				<div
					className="hidden sm:flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}10)`,
						border: `1px solid ${themeGradient.from}20`,
					}}
				>
					<Sparkles className="h-3 w-3" style={{ color: themeGradient.from }} />
					<span className="text-muted-foreground">
						<span className="font-medium text-foreground">{items.length}</span> titles
					</span>
				</div>
			</div>

			{/* Carousel Container */}
			<div className="group/carousel relative">
				{/* Left Navigation Button */}
				{canScrollLeft && (
					<button
						type="button"
						onClick={() => scroll("left")}
						className="absolute -left-4 top-1/2 z-10 -translate-y-1/2 rounded-xl p-2.5 shadow-lg transition-all duration-300 hover:scale-110 opacity-0 group-hover/carousel:opacity-100"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
						}}
						aria-label="Scroll left"
					>
						<ChevronLeft className="h-5 w-5 text-white" />
					</button>
				)}

				{/* Right Navigation Button */}
				{canScrollRight && (
					<button
						type="button"
						onClick={() => scroll("right")}
						className="absolute -right-4 top-1/2 z-10 -translate-y-1/2 rounded-xl p-2.5 shadow-lg transition-all duration-300 hover:scale-110 opacity-0 group-hover/carousel:opacity-100"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
						}}
						aria-label="Scroll right"
					>
						<ChevronRight className="h-5 w-5 text-white" />
					</button>
				)}

				{/* Scrollable Content */}
				<div
					ref={scrollContainerRef}
					className="flex gap-4 overflow-x-auto pb-4 scrollbar-none"
					style={{
						maskImage: "linear-gradient(to right, transparent, black 1%, black 99%, transparent)",
						WebkitMaskImage: "linear-gradient(to right, transparent, black 1%, black 99%, transparent)",
					}}
				>
					{items.map((item, index) => (
						<RecommendationCard
							key={item.id}
							item={item}
							mediaType={mediaType}
							onSelect={onSelectItem}
							index={index}
						/>
					))}

					{/* Loading More Indicator */}
					{isFetchingNextPage && (
						<div className="flex w-[160px] flex-shrink-0 items-center justify-center">
							<div
								className="flex h-12 w-12 items-center justify-center rounded-xl"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Loader2 className="h-5 w-5 animate-spin" style={{ color: themeGradient.from }} />
							</div>
						</div>
					)}
				</div>
			</div>
		</section>
	);
};
