import { useState } from "react";

/**
 * Tab types for the TRaSH Guides interface
 */
export type TrashGuidesTab = "cache" | "templates" | "scheduler" | "history" | "bulk-scores" | "custom-formats";

/**
 * Hook for managing TRaSH Guides UI state (tabs).
 * Centralizes tab navigation state management.
 *
 * @returns Tab state and setter
 *
 * @example
 * const { activeTab, setActiveTab } = useTrashGuidesState();
 */
export function useTrashGuidesState() {
	const [activeTab, setActiveTab] = useState<TrashGuidesTab>("templates");

	return {
		activeTab,
		setActiveTab,
	};
}
