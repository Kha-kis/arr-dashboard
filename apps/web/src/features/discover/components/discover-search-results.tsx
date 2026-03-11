"use client";

import type { SeerrDiscoverResponse, SeerrDiscoverResult } from "@arr/shared";
import type { InfiniteData } from "@tanstack/react-query";
import { AlertCircle, Loader2, Search } from "lucide-react";
import { PremiumSkeleton } from "../../../components/layout";
import { Button } from "../../../components/ui";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { SEMANTIC_COLORS } from "../../../lib/theme-gradients";
import type { SearchSortOption } from "../hooks/use-discover-state";
import { FilterSelect } from "../../../components/layout";
import { useMemo } from "react";
import { DiscoverPosterCard } from "./discover-poster-card";

interface DiscoverSearchResultsProps {
	data: InfiniteData<SeerrDiscoverResponse> | undefined;
	isLoading: boolean;
	isError?: boolean;
	isFetchingNextPage?: boolean;
	hasNextPage?: boolean;
	onLoadMore?: () => void;
	onSelectItem: (item: SeerrDiscoverResult) => void;
	query: string;
	sort: SearchSortOption;
	onSortChange: (sort: SearchSortOption) => void;
}

const SORT_OPTIONS: { value: SearchSortOption; label: string }[] = [
	{ value: "popularity", label: "Most Popular" },
	{ value: "rating", label: "Highest Rated" },
	{ value: "release_date", label: "Release Date" },
];

export const DiscoverSearchResults: React.FC<DiscoverSearchResultsProps> = ({
	data,
	isLoading,
	isError,
	isFetchingNextPage,
	hasNextPage,
	onLoadMore,
	onSelectItem,
	query,
	sort,
	onSortChange,
}) => {
	const { gradient: themeGradient } = useThemeGradient();

	const flatResults = useMemo(() => data?.pages.flatMap((p) => p.results) ?? [], [data]);

	const sortedResults = useMemo(() => {
		if (sort === "popularity") return flatResults; // API default order
		return [...flatResults].sort((a, b) => {
			if (sort === "rating") {
				return (b.voteAverage ?? 0) - (a.voteAverage ?? 0);
			}
			// release_date — descending
			const dateA = a.releaseDate ?? a.firstAirDate ?? "";
			const dateB = b.releaseDate ?? b.firstAirDate ?? "";
			return dateB.localeCompare(dateA);
		});
	}, [flatResults, sort]);

	const totalResults = data?.pages[0]?.totalResults ?? 0;

	if (isLoading) {
		return (
			<div className="space-y-4 animate-in fade-in duration-300">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Loader2 className="h-4 w-4 animate-spin" style={{ color: themeGradient.from }} />
					Searching for &quot;{query}&quot;...
				</div>
				<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
					{Array.from({ length: 12 }).map((_, i) => (
						<div key={i} className="rounded-xl border border-border/30 bg-card/30 overflow-hidden">
							<PremiumSkeleton
								variant="card"
								className="aspect-2/3 rounded-none"
								style={{ animationDelay: `${i * 30}ms` }}
							/>
							<div className="p-3 space-y-2">
								<PremiumSkeleton variant="line" className="h-4 w-3/4" />
								<PremiumSkeleton variant="line" className="h-3 w-1/2" />
							</div>
						</div>
					))}
				</div>
			</div>
		);
	}

	if (isError) {
		return (
			<div className="flex flex-col items-center justify-center py-16 text-center space-y-4 animate-in fade-in duration-300">
				<div
					className="flex h-14 w-14 items-center justify-center rounded-xl"
					style={{
						background: SEMANTIC_COLORS.error.bg,
						border: `1px solid ${SEMANTIC_COLORS.error.border}`,
					}}
				>
					<AlertCircle className="h-6 w-6" style={{ color: SEMANTIC_COLORS.error.text }} />
				</div>
				<div className="space-y-1">
					<p className="text-sm font-medium text-foreground">Search failed</p>
					<p className="text-xs text-muted-foreground">
						Please try again. If the problem persists, check your Seerr connection.
					</p>
				</div>
			</div>
		);
	}

	if (!data || sortedResults.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center py-16 text-center space-y-4 animate-in fade-in duration-300">
				<div
					className="flex h-14 w-14 items-center justify-center rounded-xl"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}15, ${themeGradient.to}15)`,
						border: `1px solid ${themeGradient.from}20`,
					}}
				>
					<Search className="h-6 w-6 text-muted-foreground" />
				</div>
				<div className="space-y-1">
					<p className="text-sm font-medium text-foreground">No results found</p>
					<p className="text-xs text-muted-foreground">
						Try a different search term or browse the categories below
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="space-y-4 animate-in fade-in duration-300">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 text-sm text-muted-foreground">
					<Search className="h-4 w-4" />
					<span>
						Found <span className="font-medium text-foreground">{totalResults}</span> results for
						&quot;{query}&quot;
					</span>
				</div>
				<FilterSelect
					value={sort}
					onChange={(v) => onSortChange(v as SearchSortOption)}
					options={SORT_OPTIONS}
					className="min-w-[140px]"
				/>
			</div>

			<div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
				{sortedResults.map((item, index) => (
					<DiscoverPosterCard
						key={`${item.id}-${item.mediaType}`}
						item={item}
						onClick={onSelectItem}
						index={index}
					/>
				))}
			</div>

			{hasNextPage && (
				<div className="flex justify-center pt-2">
					<Button
						variant="secondary"
						onClick={onLoadMore}
						disabled={isFetchingNextPage}
						className="gap-2 border-border/50 bg-card/50 text-xs"
					>
						{isFetchingNextPage ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
						Load More Results
					</Button>
				</div>
			)}
		</div>
	);
};
