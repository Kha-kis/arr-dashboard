import { useCallback, useState } from "react";
import type { SearchResult } from "@arr/shared";
import {
	useManualSearchMutation,
	useGrabSearchResultMutation,
} from "../../../hooks/api/useSearch";
import { buildFilters, deriveGrabErrorMessage } from "../lib/search-utils";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { copyToClipboard } from "../../../lib/utils/clipboard";
import type { SearchStateActions } from "./use-search-state";

/**
 * Feedback message for user actions.
 */
interface _FeedbackMessage {
	type: "success" | "error";
	message: string;
}

/**
 * Hook for managing search actions: performing searches, grabbing results,
 * copying links, and opening info URLs.
 *
 * @param query - Current search query
 * @param searchType - Current search type (all/movie/tv/music/book)
 * @param selectedIndexers - Currently selected indexers
 * @param stateActions - Actions from useSearchState to update validation/feedback/grabbing state
 * @returns Search results, action handlers, and mutation state
 *
 * @example
 * const {
 *   results,
 *   handleSearch,
 *   handleSubmit,
 *   handleGrab,
 *   handleCopyMagnet,
 *   handleOpenInfo,
 *   isSearching
 * } = useSearchActions(query, searchType, selectedIndexers, actions);
 */
export function useSearchActions(
	query: string,
	searchType: "all" | "movie" | "tv" | "music" | "book",
	selectedIndexers: Record<string, number[]>,
	stateActions: SearchStateActions,
) {
	const [results, setResults] = useState<SearchResult[]>([]);

	const searchMutation = useManualSearchMutation();
	const grabMutation = useGrabSearchResultMutation();

	/**
	 * Performs manual search mutation with validation.
	 */
	const handleSearch = useCallback(() => {
		if (!query.trim()) {
			stateActions.setValidationError("Enter a search query first.");
			stateActions.setFeedback(null);
			return;
		}

		const filterPayload = buildFilters(selectedIndexers);
		if (filterPayload.length === 0) {
			stateActions.setValidationError("Select at least one indexer to search against.");
			stateActions.setFeedback(null);
			return;
		}

		stateActions.setValidationError(null);
		stateActions.setFeedback(null);

		searchMutation.mutate(
			{
				query: query.trim(),
				type: searchType,
				filters: filterPayload,
			},
			{
				onSuccess: (data) => {
					stateActions.setHasSearched(true);
					setResults(data.aggregated);
					const total = data.totalCount;
					stateActions.setFeedback({
						type: "success",
						message:
							total > 0
								? `Found ${total} result${total === 1 ? "" : "s"}.`
								: "No results found for that query.",
					});
				},
				onError: (error) => {
					const message = error instanceof Error ? error.message : "Search failed";
					stateActions.setFeedback({ type: "error", message });
				},
			},
		);
		// eslint-disable-next-line react-hooks/exhaustive-deps -- searchMutation.mutate is stable
	}, [query, searchType, selectedIndexers, stateActions]);

	/**
	 * Handles form submission for search.
	 */
	const handleSubmit = useCallback(
		(event: React.FormEvent) => {
			event.preventDefault();
			if (!searchMutation.isPending) {
				handleSearch();
			}
		},
		[handleSearch, searchMutation.isPending],
	);

	/**
	 * Handles grabbing a search result and sending to download client.
	 */
	const handleGrab = useCallback(
		async (result: SearchResult) => {
			const rowKey = `${result.instanceId}:${result.indexerId}:${result.id}`;
			stateActions.setGrabbingKey(rowKey);
			stateActions.setFeedback(null);
			try {
				await grabMutation.mutateAsync({
					instanceId: result.instanceId,
					result,
				});
				stateActions.setFeedback({
					type: "success",
					message: `Sent "${result.title}" to the download client.`,
				});
			} catch (error) {
				const message = deriveGrabErrorMessage(error);
				stateActions.setFeedback({ type: "error", message });
			} finally {
				stateActions.setGrabbingKey(null);
			}
		},
		[stateActions, grabMutation],
	);

	/**
	 * Handles copying magnet/download link to clipboard.
	 * Uses fallback method for non-HTTPS environments.
	 */
	const handleCopyMagnet = useCallback(
		async (result: SearchResult) => {
			const link = result.magnetUrl ?? result.downloadUrl ?? result.link;
			if (!link) {
				stateActions.setFeedback({
					type: "error",
					message: "No copyable magnet or download link is available for this release.",
				});
				return;
			}

			try {
				await copyToClipboard(link);
				stateActions.setFeedback({ type: "success", message: "Copied link to clipboard." });
			} catch (error) {
				const message = error instanceof Error ? error.message : "Clipboard copy failed.";
				stateActions.setFeedback({
					type: "error",
					message: `Unable to copy link: ${message}`,
				});
			}
		},
		[stateActions],
	);

	/**
	 * Handles opening release info URL in new tab.
	 */
	const handleOpenInfo = useCallback(
		(result: SearchResult) => {
			const target = result.infoUrl ?? result.link ?? result.downloadUrl ?? result.magnetUrl;
			if (!target) {
				stateActions.setFeedback({
					type: "error",
					message: "This release did not provide a public info link.",
				});
				return;
			}
			if (!safeOpenUrl(target)) {
				stateActions.setFeedback({ type: "error", message: "Invalid or unsafe URL." });
			}
		},
		[stateActions],
	);

	return {
		// Search results
		results,

		// Search mutation
		handleSearch,
		handleSubmit,
		isSearching: searchMutation.isPending,

		// Result actions
		handleGrab,
		handleCopyMagnet,
		handleOpenInfo,
	};
}
