"use client";

import { Input, Button } from "../../../components/ui";
import { SEARCH_TYPES } from "../lib/search-utils";

interface SearchFormProps {
	/**
	 * Current search query
	 */
	query: string;
	/**
	 * Currently selected search type
	 */
	searchType: "all" | "movie" | "tv" | "music" | "book";
	/**
	 * Whether search is currently in progress
	 */
	isSearching: boolean;
	/**
	 * Handler for query changes
	 */
	onQueryChange: (value: string) => void;
	/**
	 * Handler for search type changes
	 */
	onSearchTypeChange: (type: "all" | "movie" | "tv" | "music" | "book") => void;
	/**
	 * Handler for form submission
	 */
	onSubmit: (event: React.FormEvent) => void;
}

/**
 * Search form component with query input and type selector
 * Allows users to enter a search query and select what type of content to search for
 *
 * @component
 */
export const SearchForm = ({
	query,
	searchType,
	isSearching,
	onQueryChange,
	onSearchTypeChange,
	onSubmit,
}: SearchFormProps) => {
	return (
		<form onSubmit={onSubmit} className="space-y-6">
			<div className="flex flex-col gap-4 md:flex-row">
				<div className="flex-1">
					<label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
						Query
					</label>
					<Input
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
						placeholder="Search for movies, series, music, or books"
					/>
				</div>
				<div className="md:w-64">
					<label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-white/60">
						Type
					</label>
					<div className="flex flex-wrap gap-2">
						{SEARCH_TYPES.map((type) => (
							<Button
								key={type.value}
								type="button"
								variant={searchType === type.value ? "primary" : "ghost"}
								className="flex-1"
								onClick={() => onSearchTypeChange(type.value)}
							>
								{type.label}
							</Button>
						))}
					</div>
				</div>
			</div>

			<div className="flex justify-end">
				<Button type="submit" disabled={isSearching}>
					{isSearching ? "Searching..." : "Search"}
				</Button>
			</div>
		</form>
	);
};
