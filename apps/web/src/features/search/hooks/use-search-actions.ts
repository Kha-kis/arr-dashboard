import type { SearchCoverage, SearchResult } from "@arr/shared";
import { useCallback, useState } from "react";
import { useManualSearchMutation } from "../../../hooks/api/useSearch";
import { getErrorMessage } from "../../../lib/error-utils";
import { copyToClipboard } from "../../../lib/utils/clipboard";
import { safeOpenUrl } from "../../../lib/utils/url-validation";
import { buildFilters } from "../lib/search-utils";
import type { SearchStateActions } from "./use-search-state";

const describeCoverage = (coverage: SearchCoverage | undefined, unverified: boolean) =>
	[
		unverified
			? "Returned-batch coverage is unverified. Available results may be incomplete; check Prowlarr and search again."
			: "",
		coverage?.rejectedCount
			? `${coverage.rejectedCount} returned result${coverage.rejectedCount === 1 ? "" : "s"} rejected during validation.`
			: "",
		coverage?.metadataIncompleteCount
			? `${coverage.metadataIncompleteCount} result${coverage.metadataIncompleteCount === 1 ? "" : "s"} with incomplete metadata.`
			: "",
	]
		.filter(Boolean)
		.join(" ");

/**
 * Hook for managing search actions: performing searches,
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
	const [failedInstanceCount, setFailedInstanceCount] = useState(0);
	const [coverage, setCoverage] = useState<SearchCoverage>();
	const [coverageUnverified, setCoverageUnverified] = useState(false);
	const coverageIncomplete =
		failedInstanceCount > 0 ||
		coverageUnverified ||
		(coverage?.rejectedCount ?? 0) > 0 ||
		(coverage?.metadataIncompleteCount ?? 0) > 0;
	const coverageWarning = describeCoverage(coverage, coverageUnverified);
	const searchMutation = useManualSearchMutation();

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
					setFailedInstanceCount(data.failedInstanceCount);
					setCoverage(data.coverage);
					const unverified =
						!data.coverage &&
						(data.instances.some((instance) => instance.success) || data.failedInstanceCount === 0);
					setCoverageUnverified(unverified);
					const total = data.totalCount;
					const incomplete =
						unverified ||
						(data.coverage?.rejectedCount ?? 0) > 0 ||
						(data.coverage?.metadataIncompleteCount ?? 0) > 0;
					const normalizationMessage = describeCoverage(data.coverage, unverified);
					stateActions.setFeedback({
						type: data.failedInstanceCount > 0 || incomplete ? "error" : "success",
						message:
							data.failedInstanceCount > 0
								? `Search incomplete: ${data.failedInstanceCount} Prowlarr instance${data.failedInstanceCount === 1 ? "" : "s"} unavailable; results from ${data.failedInstanceCount === 1 ? "it are" : "them are"} unknown.`
								: incomplete
									? normalizationMessage
									: total > 0
										? `Found ${total} result${total === 1 ? "" : "s"}.`
										: "No results found for that query.",
						incognitoMessage:
							data.failedInstanceCount > 0
								? `Search incomplete: ${data.failedInstanceCount} Prowlarr instance${data.failedInstanceCount === 1 ? "" : "s"} unavailable; results from ${data.failedInstanceCount === 1 ? "it are" : "them are"} unknown.`
								: incomplete
									? normalizationMessage
									: total > 0
										? `Found ${total} result${total === 1 ? "" : "s"}.`
										: "No results found for that query.",
					});
				},
				onError: (error) => {
					setResults([]);
					setFailedInstanceCount(0);
					setCoverage(undefined);
					setCoverageUnverified(false);
					stateActions.setHasSearched(false);
					stateActions.setFeedback({
						type: "error",
						message: getErrorMessage(error, "Search failed"),
						incognitoMessage: "Search failed. Check Prowlarr connections and retry.",
					});
				},
			},
		);
	}, [query, searchType, selectedIndexers, stateActions, searchMutation]);

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
					incognitoMessage: "No copyable magnet or download link is available for this release.",
				});
				return;
			}

			try {
				await copyToClipboard(link);
				stateActions.setFeedback({
					type: "success",
					message: "Copied link to clipboard.",
					incognitoMessage: "Copied link to clipboard.",
				});
			} catch (error) {
				const message = getErrorMessage(error, "Clipboard copy failed.");
				stateActions.setFeedback({
					type: "error",
					message: `Unable to copy link: ${message}`,
					incognitoMessage: "Unable to copy link. Check clipboard permissions and retry.",
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
					incognitoMessage: "This release did not provide a public info link.",
				});
				return;
			}
			if (!safeOpenUrl(target)) {
				stateActions.setFeedback({
					type: "error",
					message: "Invalid or unsafe URL.",
					incognitoMessage: "Invalid or unsafe URL.",
				});
			}
		},
		[stateActions],
	);

	return {
		// Search results
		results,
		failedInstanceCount,
		coverage,
		coverageIncomplete,
		coverageWarning,

		// Search mutation
		handleSearch,
		handleSubmit,
		isSearching: searchMutation.isPending,

		// Result actions
		handleCopyMagnet,
		handleOpenInfo,
	};
}
