"use client";

import type { DiscoverSearchResult, DiscoverSearchType, ServiceInstanceSummary } from "@arr/shared";
import { Loader2, Search, Film, Tv } from "lucide-react";
import { MediaCard } from "./media-card";
import { PremiumEmptyState } from "../../../components/layout";
import { THEME_GRADIENTS } from "../../../lib/theme-gradients";
import { useColorTheme } from "../../../providers/color-theme-provider";

/**
 * Props for the SearchResults component
 */
interface SearchResultsProps {
	/** Array of search results to display */
	results: DiscoverSearchResult[];
	/** The type of media being searched */
	searchType: DiscoverSearchType;
	/** Available service instances */
	relevantInstances: ServiceInstanceSummary[];
	/** Whether the search is loading */
	isLoading: boolean;
	/** Callback when a result's add button is clicked */
	onAddClick: (result: DiscoverSearchResult) => void;
}

/**
 * Premium Search Results
 *
 * Component for displaying search results with:
 * - Theme-aware loading state
 * - Premium empty state
 * - Grid layout with staggered animations
 * - Results count badge
 */
export const SearchResults: React.FC<SearchResultsProps> = ({
	results,
	searchType,
	relevantInstances,
	isLoading,
	onAddClick,
}) => {
	const { colorTheme } = useColorTheme();
	const themeGradient = THEME_GRADIENTS[colorTheme];

	// Loading State
	if (isLoading) {
		return (
			<section className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						<Loader2 className="h-5 w-5 animate-spin" style={{ color: themeGradient.from }} />
					</div>
					<div>
						<p className="font-medium text-foreground">Searching...</p>
						<p className="text-sm text-muted-foreground">
							Finding {searchType === "movie" ? "movies" : "series"} across your instances
						</p>
					</div>
				</div>

				{/* Loading Skeleton Grid */}
				<div className="grid gap-6 lg:grid-cols-2">
					{Array.from({ length: 4 }).map((_, i) => (
						<div
							key={i}
							className="rounded-2xl border border-border/30 bg-card/20 p-5 animate-pulse"
							style={{ animationDelay: `${i * 100}ms` }}
						>
							<div className="flex gap-4">
								<div className="h-40 w-28 rounded-xl bg-muted/20 shrink-0" />
								<div className="flex-1 space-y-3">
									<div className="h-6 w-3/4 rounded bg-muted/20" />
									<div className="h-4 w-1/2 rounded bg-muted/15" />
									<div className="h-16 w-full rounded bg-muted/10" />
									<div className="flex gap-2">
										<div className="h-6 w-16 rounded-lg bg-muted/15" />
										<div className="h-6 w-20 rounded-lg bg-muted/15" />
									</div>
								</div>
							</div>
						</div>
					))}
				</div>
			</section>
		);
	}

	// Empty State
	if (results.length === 0) {
		return (
			<section className="animate-in fade-in slide-in-from-bottom-4 duration-500">
				<PremiumEmptyState
					icon={Search}
					title="No results found"
					description="Try a different title or adjust your search term to find what you're looking for."
				/>
			</section>
		);
	}

	// Results
	return (
		<section className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
			{/* Results Header */}
			<div className="flex items-center justify-between gap-4">
				<div className="flex items-center gap-3">
					<div
						className="flex h-10 w-10 items-center justify-center rounded-xl shrink-0"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}20, ${themeGradient.to}20)`,
							border: `1px solid ${themeGradient.from}30`,
						}}
					>
						{searchType === "movie" ? (
							<Film className="h-5 w-5" style={{ color: themeGradient.from }} />
						) : (
							<Tv className="h-5 w-5" style={{ color: themeGradient.from }} />
						)}
					</div>
					<div>
						<h2 className="font-semibold text-foreground">Search Results</h2>
						<p className="text-sm text-muted-foreground">
							Found across your {searchType === "movie" ? "Radarr" : "Sonarr"} instances
						</p>
					</div>
				</div>

				{/* Results Count Badge */}
				<div
					className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-sm"
					style={{
						background: `linear-gradient(135deg, ${themeGradient.from}10, ${themeGradient.to}10)`,
						border: `1px solid ${themeGradient.from}20`,
					}}
				>
					<span
						className="text-lg font-bold"
						style={{
							background: `linear-gradient(135deg, ${themeGradient.from}, ${themeGradient.to})`,
							WebkitBackgroundClip: "text",
							WebkitTextFillColor: "transparent",
						}}
					>
						{results.length}
					</span>
					<span className="text-muted-foreground">
						{results.length === 1 ? "result" : "results"}
					</span>
				</div>
			</div>

			{/* Results Grid */}
			<div className="grid gap-6 lg:grid-cols-2">
				{results.map((result, index) => (
					<MediaCard
						key={result.id}
						result={result}
						searchType={searchType}
						relevantInstances={relevantInstances}
						onAddClick={onAddClick}
						animationDelay={index * 50}
					/>
				))}
			</div>
		</section>
	);
};
