"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import type { SeerrGenre } from "@arr/shared";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { useSeerrGenres } from "../../../hooks/api/useSeerr";

interface DiscoverGenreFilterProps {
	instanceId: string;
	mediaType: "movie" | "tv";
	selectedGenreId: number | null;
	onSelectGenre: (genreId: number | null) => void;
}

export const DiscoverGenreFilter: React.FC<DiscoverGenreFilterProps> = ({
	instanceId,
	mediaType,
	selectedGenreId,
	onSelectGenre,
}) => {
	const { gradient: themeGradient } = useThemeGradient();
	const { data: genres } = useSeerrGenres(instanceId, mediaType);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [canScrollLeft, setCanScrollLeft] = useState(false);
	const [canScrollRight, setCanScrollRight] = useState(false);

	const checkScrollButtons = useCallback(() => {
		if (!scrollRef.current) return;
		const { scrollLeft, scrollWidth, clientWidth } = scrollRef.current;
		setCanScrollLeft(scrollLeft > 0);
		setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 10);
	}, []);

	const scroll = useCallback((direction: "left" | "right") => {
		if (!scrollRef.current) return;
		scrollRef.current.scrollBy({
			left: direction === "left" ? -200 : 200,
			behavior: "smooth",
		});
	}, []);

	useEffect(() => {
		checkScrollButtons();
		const container = scrollRef.current;
		if (container) {
			container.addEventListener("scroll", checkScrollButtons);
			window.addEventListener("resize", checkScrollButtons);
			return () => {
				container.removeEventListener("scroll", checkScrollButtons);
				window.removeEventListener("resize", checkScrollButtons);
			};
		}
	}, [genres?.length, checkScrollButtons]);

	if (!genres || genres.length === 0) return null;

	return (
		<div className="relative">
			{/* Left scroll arrow */}
			{canScrollLeft && (
				<button
					type="button"
					onClick={() => scroll("left")}
					className="absolute left-0 top-1/2 z-10 -translate-y-1/2 rounded-full bg-card/90 p-1 shadow-md border border-border/50 text-muted-foreground hover:text-foreground transition-colors"
					aria-label="Scroll genres left"
				>
					<ChevronLeft className="h-4 w-4" />
				</button>
			)}

			{/* Right scroll arrow */}
			{canScrollRight && (
				<button
					type="button"
					onClick={() => scroll("right")}
					className="absolute right-0 top-1/2 z-10 -translate-y-1/2 rounded-full bg-card/90 p-1 shadow-md border border-border/50 text-muted-foreground hover:text-foreground transition-colors"
					aria-label="Scroll genres right"
				>
					<ChevronRight className="h-4 w-4" />
				</button>
			)}

			{/* Genre pills */}
			<div
				ref={scrollRef}
				className="flex items-center gap-2 overflow-x-auto scrollbar-none px-1"
				style={{
					maskImage: "linear-gradient(to right, transparent, black 2%, black 98%, transparent)",
					WebkitMaskImage: "linear-gradient(to right, transparent, black 2%, black 98%, transparent)",
				}}
			>
				{selectedGenreId && (
					<button
						type="button"
						onClick={() => onSelectGenre(null)}
						className="flex shrink-0 items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium transition-all border"
						style={{
							backgroundColor: `${themeGradient.from}15`,
							borderColor: `${themeGradient.from}40`,
							color: themeGradient.from,
						}}
					>
						<X className="h-3 w-3" />
						Clear
					</button>
				)}

				{genres.map((genre) => (
					<GenrePill
						key={genre.id}
						genre={genre}
						isSelected={genre.id === selectedGenreId}
						onSelect={() => onSelectGenre(genre.id === selectedGenreId ? null : genre.id)}
						themeFrom={themeGradient.from}
						themeTo={themeGradient.to}
					/>
				))}
			</div>
		</div>
	);
};

interface GenrePillProps {
	genre: SeerrGenre;
	isSelected: boolean;
	onSelect: () => void;
	themeFrom: string;
	themeTo: string;
}

const GenrePill: React.FC<GenrePillProps> = ({ genre, isSelected, onSelect, themeFrom, themeTo }) => (
	<button
		type="button"
		onClick={onSelect}
		className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium transition-all border"
		style={
			isSelected
				? {
						background: `linear-gradient(135deg, ${themeFrom}, ${themeTo})`,
						borderColor: "transparent",
						color: "#fff",
						boxShadow: `0 2px 8px -2px ${themeFrom}60`,
					}
				: {
						backgroundColor: "transparent",
						borderColor: "var(--border)",
						color: "var(--muted-foreground)",
					}
		}
	>
		{genre.name}
	</button>
);
