"use client";

import type { DiscoverSearchResult, DiscoverSearchType, ServiceInstanceSummary } from "@arr/shared";
import { Loader2, Search } from "lucide-react";
import { EmptyState } from "../../../components/ui";
import { MediaCard } from "./media-card";

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
 * Component for displaying search results in a grid layout.
 * Shows loading state, empty state, or a grid of media cards.
 *
 * @component
 * @example
 * <SearchResults
 *   results={searchResults}
 *   searchType="movie"
 *   relevantInstances={instances}
 *   isLoading={false}
 *   onAddClick={handleAdd}
 * />
 */
export const SearchResults: React.FC<SearchResultsProps> = ({
	results,
	searchType,
	relevantInstances,
	isLoading,
	onAddClick,
}) => {
	if (isLoading) {
		return (
			<section className="space-y-6">
				<div className="flex items-center gap-3 text-fg-muted">
					<Loader2 className="h-5 w-5 animate-spin" />
					Fetching {searchType === "movie" ? "movies" : "series"}...
				</div>
			</section>
		);
	}

	if (results.length === 0) {
		return (
			<section className="space-y-6">
				<EmptyState
					icon={Search}
					title="No results found"
					description="Try a different title or adjust your search term."
				/>
			</section>
		);
	}

	return (
		<section className="space-y-6">
			<div className="grid gap-6 lg:grid-cols-2">
				{results.map((result) => (
					<MediaCard
						key={result.id}
						result={result}
						searchType={searchType}
						relevantInstances={relevantInstances}
						onAddClick={onAddClick}
					/>
				))}
			</div>
		</section>
	);
};
