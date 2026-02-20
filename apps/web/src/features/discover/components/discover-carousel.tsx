"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { LucideIcon } from "lucide-react";
import { Loader2, ChevronLeft, ChevronRight, AlertCircle } from "lucide-react";
import type { SeerrDiscoverResult } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { PremiumSkeleton } from "../../../components/layout";
import { DiscoverPosterCard } from "./discover-poster-card";

// ============================================================================
// Loading Skeleton
// ============================================================================

const CarouselSkeleton: React.FC = () => (
	<div className="flex gap-4">
		{Array.from({ length: 7 }).map((_, i) => (
			<div key={i} className="w-[160px] shrink-0">
				<div className="rounded-xl border border-border/30 bg-card/30 overflow-hidden">
					<PremiumSkeleton
						variant="card"
						className="aspect-2/3 rounded-none"
						style={{ animationDelay: `${i * 50}ms` }}
					/>
					<div className="p-3 space-y-2">
						<PremiumSkeleton
							variant="line"
							className="h-4 w-3/4"
							style={{ animationDelay: `${i * 50 + 25}ms` }}
						/>
						<PremiumSkeleton
							variant="line"
							className="h-3 w-1/2"
							style={{ animationDelay: `${i * 50 + 50}ms` }}
						/>
					</div>
				</div>
			</div>
		))}
	</div>
);

// ============================================================================
// DiscoverCarousel
// ============================================================================

interface DiscoverCarouselProps {
	title: string;
	description?: string;
	icon?: LucideIcon;
	items: SeerrDiscoverResult[];
	onSelectItem: (item: SeerrDiscoverResult) => void;
	isLoading?: boolean;
	isError?: boolean;
	isFetchingNextPage?: boolean;
	hasNextPage?: boolean;
	onLoadMore?: () => void;
	animationDelay?: number;
}

export const DiscoverCarousel: React.FC<DiscoverCarouselProps> = ({
	title,
	description,
	icon: Icon,
	items,
	onSelectItem,
	isLoading,
	isError,
	isFetchingNextPage,
	hasNextPage,
	onLoadMore,
	animationDelay = 0,
}) => {
	const { gradient: themeGradient } = useThemeGradient();
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
		if (!scrollContainerRef.current || !hasNextPage || isFetchingNextPage) return;
		const { scrollLeft, scrollWidth, clientWidth } = scrollContainerRef.current;
		const scrollPercentage = (scrollLeft + clientWidth) / scrollWidth;
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

	// Section header
	const SectionHeader = () => (
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
		</div>
	);

	if (isLoading) {
		return (
			<section
				className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				<SectionHeader />
				<CarouselSkeleton />
			</section>
		);
	}

	if (isError) {
		return (
			<section
				className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
				style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
			>
				<SectionHeader />
				<div className="flex items-center gap-3 rounded-xl border border-border/50 bg-card/30 px-4 py-6 text-sm text-muted-foreground">
					<AlertCircle className="h-4 w-4 shrink-0" />
					<span>Failed to load {title.toLowerCase()}</span>
				</div>
			</section>
		);
	}

	if (items.length === 0) return null;

	return (
		<section
			className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500"
			style={{ animationDelay: `${animationDelay}ms`, animationFillMode: "backwards" }}
		>
			<SectionHeader />

			<div className="group/carousel relative px-1">
				{/* Left nav */}
				{canScrollLeft && (
					<button
						type="button"
						onClick={() => scroll("left")}
						className="absolute left-2 top-1/2 z-10 -translate-y-1/2 rounded-xl p-2.5 shadow-lg transition-all duration-300 hover:scale-110 opacity-0 group-hover/carousel:opacity-100"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
						}}
						aria-label="Scroll left"
					>
						<ChevronLeft className="h-5 w-5 text-white" />
					</button>
				)}

				{/* Right nav */}
				{canScrollRight && (
					<button
						type="button"
						onClick={() => scroll("right")}
						className="absolute right-2 top-1/2 z-10 -translate-y-1/2 rounded-xl p-2.5 shadow-lg transition-all duration-300 hover:scale-110 opacity-0 group-hover/carousel:opacity-100"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							boxShadow: `0 4px 16px -4px ${themeGradient.glow}`,
						}}
						aria-label="Scroll right"
					>
						<ChevronRight className="h-5 w-5 text-white" />
					</button>
				)}

				{/* Scrollable content */}
				<div
					ref={scrollContainerRef}
					className="flex gap-4 overflow-x-auto pb-4 scrollbar-none"
					style={{
						maskImage:
							"linear-gradient(to right, transparent, black 1%, black 99%, transparent)",
						WebkitMaskImage:
							"linear-gradient(to right, transparent, black 1%, black 99%, transparent)",
					}}
				>
					{items.map((item, index) => (
						<DiscoverPosterCard
							key={`${item.id}-${item.mediaType}`}
							item={item}
							onClick={onSelectItem}
							index={index}
						/>
					))}

					{isFetchingNextPage && (
						<div className="flex w-[160px] shrink-0 items-center justify-center">
							<div
								className="flex h-12 w-12 items-center justify-center rounded-xl"
								style={{
									background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
									border: `1px solid ${themeGradient.from}30`,
								}}
							>
								<Loader2
									className="h-5 w-5 animate-spin"
									style={{ color: themeGradient.from }}
								/>
							</div>
						</div>
					)}
				</div>
			</div>
		</section>
	);
};
