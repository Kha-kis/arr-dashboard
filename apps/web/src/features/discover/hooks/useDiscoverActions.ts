import { useEffect, useState } from "react";
import type {
	DiscoverAddRequest,
	DiscoverSearchResult,
	DiscoverSearchType,
	RecommendationItem,
	ServiceInstanceSummary,
} from "@arr/shared";
import { useDiscoverAddMutation } from "../../../hooks/api/useDiscover";
import { convertRecommendationToSearchResult } from "../lib/discover-utils";
import { getErrorMessage } from "../../../lib/error-utils";

/**
 * Feedback message displayed to user after add operations.
 */
interface FeedbackMessage {
	type: "success" | "error";
	message: string;
}

/**
 * Hook for managing discover actions: item selection, adding to library, and feedback.
 * Handles state for selected items, mutation operations, and auto-dismissing feedback messages.
 *
 * @param searchType - Current media type ("movie" or "series")
 * @param relevantInstances - Service instances relevant to current search type
 * @returns Object containing action state and handlers
 *
 * @example
 * const {
 *   selectedResult,
 *   feedback,
 *   isSubmitting,
 *   handleSelectItem,
 *   handleAdd,
 *   handleCloseDialog
 * } = useDiscoverActions("movie", radarrInstances);
 */
export function useDiscoverActions(
	searchType: DiscoverSearchType,
	relevantInstances: ServiceInstanceSummary[],
) {
	const [selectedResult, setSelectedResult] = useState<DiscoverSearchResult | null>(null);
	const [feedback, setFeedback] = useState<FeedbackMessage | null>(null);

	const addMutation = useDiscoverAddMutation();

	// Auto-dismiss feedback after 4 seconds
	useEffect(() => {
		if (!feedback) {
			return;
		}
		const timer = window.setTimeout(() => setFeedback(null), 4000);
		return () => window.clearTimeout(timer);
	}, [feedback]);

	/**
	 * Handles selection of a recommendation item for adding to library.
	 * Converts RecommendationItem to DiscoverSearchResult format with fake instance states.
	 */
	const handleSelectItem = (item: RecommendationItem) => {
		const result = convertRecommendationToSearchResult(item, searchType, relevantInstances);
		setSelectedResult(result);
	};

	/**
	 * Handles selection of a search result for adding to library.
	 * Used when selecting from search results (already in DiscoverSearchResult format).
	 */
	const handleSelectResult = (result: DiscoverSearchResult) => {
		setSelectedResult(result);
	};

	/**
	 * Handles adding selected item to library.
	 * Shows success/error feedback and closes dialog on completion.
	 */
	const handleAdd = async (requestPayload: DiscoverAddRequest) => {
		try {
			await addMutation.mutateAsync(requestPayload);
			if (selectedResult) {
				setFeedback({
					type: "success",
					message: `Added '${selectedResult.title ?? "Title"}' to your library.`,
				});
			}
			setSelectedResult(null);
		} catch (error) {
			const message = getErrorMessage(error, "Failed to add title");
			setFeedback({ type: "error", message });
		}
	};

	/**
	 * Handles closing the add dialog.
	 * Only allows closing when not actively submitting.
	 */
	const handleCloseDialog = () => {
		if (!addMutation.isPending) {
			setSelectedResult(null);
		}
	};

	return {
		// Selection state
		selectedResult,

		// Feedback state
		feedback,

		// Mutation state
		isSubmitting: addMutation.isPending,

		// Action handlers
		handleSelectItem,
		handleSelectResult,
		handleAdd,
		handleCloseDialog,
	};
}
