import { useState } from "react";
import type { DiscoverSearchType } from "@arr/shared";
import { useDiscoverSearchQuery } from "../../../hooks/api/useDiscover";

/**
 * Hook for managing discover search state and functionality.
 * Handles search input, query submission, and coordinating with search API.
 *
 * @returns Object containing search state and handlers
 *
 * @example
 * const {
 *   searchType,
 *   setSearchType,
 *   searchInput,
 *   setSearchInput,
 *   submittedQuery,
 *   handleSubmit,
 *   searchResults,
 *   isLoading,
 *   hasQuery,
 *   isError,
 *   error
 * } = useDiscoverSearch();
 */
export function useDiscoverSearch() {
	const [searchType, setSearchType] = useState<DiscoverSearchType>("movie");
	const [searchInput, setSearchInput] = useState("");
	const [submittedQuery, setSubmittedQuery] = useState("");

	const searchQuery = useDiscoverSearchQuery({
		query: submittedQuery,
		type: searchType,
		enabled: submittedQuery.trim().length > 0,
	});

	const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const trimmed = searchInput.trim();
		if (trimmed.length === 0) {
			return;
		}
		setSubmittedQuery(trimmed);
	};

	const searchResults = searchQuery.data?.results ?? [];
	const isLoading = searchQuery.isFetching || searchQuery.isLoading;
	const hasQuery = submittedQuery.trim().length > 0;

	return {
		// Search type state
		searchType,
		setSearchType,

		// Search input state
		searchInput,
		setSearchInput,
		submittedQuery,

		// Search submission
		handleSubmit,

		// Search results
		searchResults,
		isLoading,
		hasQuery,

		// Error handling
		isError: searchQuery.isError,
		error: searchQuery.error as Error | undefined,
	};
}
