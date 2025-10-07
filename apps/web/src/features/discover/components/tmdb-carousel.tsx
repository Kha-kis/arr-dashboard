"use client";

import { useEffect, useRef, useState } from "react";
import type { RecommendationItem } from "@arr/shared";
import { Loader2, Star, ChevronLeft, ChevronRight } from "lucide-react";

/**
 * Props for the TMDBCarousel component
 */
interface TMDBCarouselProps {
	/** Title of the carousel section */
	title: string;
	/** Optional description text */
	description?: string;
	/** Array of recommendation items to display */
	items: RecommendationItem[];
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
}

/**
 * Horizontal scrolling carousel for displaying TMDB recommendations.
 * Features infinite scroll, navigation buttons, poster images, and ratings.
 *
 * @component
 * @example
 * <TMDBCarousel
 *   title="Trending Now"
 *   description="Popular movies trending this week"
 *   items={trendingItems}
 *   onSelectItem={handleSelect}
 *   isLoading={false}
 *   hasNextPage={true}
 *   onLoadMore={() => fetchNextPage()}
 * />
 */
export const TMDBCarousel: React.FC<TMDBCarouselProps> = ({
	title,
	description,
	items,
	onSelectItem,
	isLoading,
	isFetchingNextPage,
	hasNextPage,
	onLoadMore,
}) => {
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);

	const checkScrollButtons = () => {
		if (!scrollContainerRef.current) return;
		const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
		setCanScrollLeft(scrollLeft > 0);
		setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10);
	};

	const scroll = (direction: "left" | "right") => {
		if (!scrollContainerRef.current) return;
		const scrollAmount = scrollContainerRef.current.clientWidth * 0.8;
		scrollContainerRef.current.scrollBy({
			left: direction === "left" ? -scrollAmount : scrollAmount,
			behavior: "smooth",
		});
	};

	const handleScroll = () => {
		checkScrollButtons();

		// Check if we're near the end and should load more
		if (!scrollContainerRef.current || !hasNextPage || isFetchingNextPage) return;

		const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
		const scrollPercentage = (scrollLeft + clientWidth) / scrollWidth;

		// Load more when scrolled 80% to the right
		if (scrollPercentage > 0.8 && onLoadMore) {
			onLoadMore();
		}
	};

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
	}, [items, hasNextPage, isFetchingNextPage]);

	if (isLoading) {
		return (
			<section className="space-y-3">
				<div>
					<h2 className="text-lg font-semibold text-fg">{title}</h2>
					{description && <p className="text-sm text-fg-muted">{description}</p>}
				</div>
				<div className="flex items-center gap-3 text-fg-muted">
					<Loader2 className="h-5 w-5 animate-spin" />
					Loading recommendations...
				</div>
			</section>
		);
	}

	if (items.length === 0) {
		return null;
	}

	return (
		<section className="space-y-3">
			<div>
				<h2 className="text-lg font-semibold text-fg">{title}</h2>
				{description && <p className="text-sm text-fg-muted">{description}</p>}
			</div>
			<div className="group/carousel relative">
				{canScrollLeft && (
					<button
						onClick={() => scroll("left")}
						className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/80 p-2 text-white shadow-lg transition-all hover:bg-black/90 hover:scale-110"
						aria-label="Scroll left"
					>
						<ChevronLeft className="h-6 w-6" />
					</button>
				)}
				{canScrollRight && (
					<button
						onClick={() => scroll("right")}
						className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/80 p-2 text-white shadow-lg transition-all hover:bg-black/90 hover:scale-110"
						aria-label="Scroll right"
					>
						<ChevronRight className="h-6 w-6" />
					</button>
				)}
				<div ref={scrollContainerRef} className="flex gap-4 overflow-x-auto pb-4 scrollbar-none">
					{items.map((item) => (
						<div
							key={item.id}
							className="group relative w-[160px] flex-shrink-0 cursor-pointer overflow-hidden rounded-lg border border-border/50 bg-bg-subtle transition-all hover:scale-105 hover:border-border"
							onClick={() => onSelectItem(item)}
						>
							<div className="relative aspect-[2/3] w-full overflow-hidden bg-gradient-to-br from-slate-700 to-slate-900">
								{item.posterUrl ? (
									<img
										src={item.posterUrl}
										alt={item.title}
										className="h-full w-full object-cover"
									/>
								) : (
									<div className="flex h-full items-center justify-center text-xs text-white/40">
										No poster
									</div>
								)}
								{typeof item.rating === "number" && item.rating > 0 && (
									<div className="absolute right-2 top-2 flex items-center gap-1 rounded-full border border-yellow-500/40 bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-200 backdrop-blur-sm">
										<Star className="h-3 w-3 fill-yellow-400 text-yellow-400" />
										{item.rating.toFixed(1)}
									</div>
								)}
							</div>
							<div className="p-2">
								<p className="truncate text-sm font-medium text-fg">{item.title}</p>
								{item.releaseDate && (
									<p className="text-xs text-fg-muted">
										{new Date(item.releaseDate).getFullYear()}
									</p>
								)}
							</div>
						</div>
					))}
					{isFetchingNextPage && (
						<div className="flex w-[160px] flex-shrink-0 items-center justify-center">
							<Loader2 className="h-6 w-6 animate-spin text-fg-muted" />
						</div>
					)}
				</div>
			</div>
		</section>
	);
};
