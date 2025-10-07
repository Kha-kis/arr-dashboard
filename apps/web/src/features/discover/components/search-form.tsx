"use client";

import type { DiscoverSearchType } from "@arr/shared";
import { Loader2, Search } from "lucide-react";
import { Button, Input, Alert, AlertDescription } from "../../../components/ui";

/**
 * Props for the SearchForm component
 */
interface SearchFormProps {
	/** The current search input value */
	searchInput: string;
	/** Callback when search input changes */
	onSearchInputChange: (value: string) => void;
	/** Callback when form is submitted */
	onSubmit: (event: React.FormEvent<HTMLFormElement>) => void;
	/** The current media type being searched */
	searchType: DiscoverSearchType;
	/** Whether the search is currently loading */
	isLoading: boolean;
	/** Whether search is available (instances configured) */
	canSearch: boolean;
}

/**
 * Search form component for discovering movies and series.
 * Includes input field, submit button, and warning message if no instances are configured.
 *
 * @component
 * @example
 * <SearchForm
 *   searchInput={input}
 *   onSearchInputChange={setInput}
 *   onSubmit={handleSubmit}
 *   searchType="movie"
 *   isLoading={false}
 *   canSearch={true}
 * />
 */
export const SearchForm: React.FC<SearchFormProps> = ({
	searchInput,
	onSearchInputChange,
	onSubmit,
	searchType,
	isLoading,
	canSearch,
}) => {
	return (
		<div className="space-y-4">
			<form className="flex w-full flex-col gap-4 md:flex-row" onSubmit={onSubmit}>
				<div className="relative flex-1">
					<Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/40" />
					<Input
						placeholder={`Search for ${searchType === "movie" ? "movies" : "series"} (title, keyword, remote id...)`}
						value={searchInput}
						onChange={(event) => onSearchInputChange(event.target.value)}
						className="pl-10"
					/>
				</div>
				<Button
					type="submit"
					className="flex items-center gap-2"
					disabled={!canSearch || searchInput.trim().length === 0}
				>
					{isLoading ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						<Search className="h-4 w-4" />
					)}
					Search
				</Button>
			</form>

			{!canSearch && (
				<Alert variant="warning">
					<AlertDescription>
						Configure at least one {searchType === "movie" ? "Radarr" : "Sonarr"} instance in
						Settings to perform searches.
					</AlertDescription>
				</Alert>
			)}
		</div>
	);
};
