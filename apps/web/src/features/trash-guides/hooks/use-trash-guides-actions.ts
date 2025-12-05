import { useState, useCallback } from "react";
import { useRefreshTrashCache } from "../../../hooks/api/useTrashCache";

type ServiceType = "RADARR" | "SONARR";

/**
 * Hook for managing TRaSH Guides actions (cache refresh).
 * Handles cache refresh mutations and tracking which service is being refreshed.
 *
 * @returns Refresh mutation state and handlers
 *
 * @example
 * const { handleRefresh, refreshing, refreshMutation } = useTrashGuidesActions();
 */
export function useTrashGuidesActions() {
	const refreshMutation = useRefreshTrashCache();
	const [refreshing, setRefreshing] = useState<string | null>(null);

	/**
	 * Refresh cache for a specific service type
	 */
	const handleRefresh = useCallback(
		async (serviceType: ServiceType) => {
			setRefreshing(serviceType);
			try {
				await refreshMutation.mutateAsync({ serviceType, force: true });
			} finally {
				setRefreshing(null);
			}
		},
		[refreshMutation],
	);

	return {
		handleRefresh,
		refreshing,
		refreshMutation,
	};
}
