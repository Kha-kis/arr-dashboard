import { useState, useCallback } from "react";
import { useRefreshTrashCache, useDeleteTrashCacheEntry, type DeleteCachePayload } from "../../../hooks/api/useTrashCache";
import { toast } from "sonner";
import { getErrorMessage } from "../../../lib/error-utils";

type ServiceType = "RADARR" | "SONARR";
type ConfigType = DeleteCachePayload["configType"];

/**
 * Hook for managing TRaSH Guides actions (cache refresh and delete).
 * Handles cache mutations and tracking which service/entry is being refreshed.
 *
 * @returns Refresh and delete mutation state and handlers
 *
 * @example
 * const { handleRefresh, handleRefreshEntry, handleDelete, refreshing, refreshingEntry } = useTrashGuidesActions();
 */
export function useTrashGuidesActions() {
	const refreshMutation = useRefreshTrashCache();
	const deleteMutation = useDeleteTrashCacheEntry();
	const [refreshing, setRefreshing] = useState<string | null>(null);
	const [refreshingEntry, setRefreshingEntry] = useState<string | null>(null);

	/**
	 * Refresh all cache entries for a specific service type
	 */
	const handleRefresh = useCallback(
		async (serviceType: ServiceType) => {
			setRefreshing(serviceType);
			try {
				await refreshMutation.mutateAsync({ serviceType, force: true });
			} catch (error) {
				const message = getErrorMessage(error, "Unknown error");
				toast.error(`Failed to refresh ${serviceType.toLowerCase()} cache: ${message}`);
			} finally {
				setRefreshing(null);
			}
		},
		[refreshMutation],
	);

	/**
	 * Refresh a single cache entry
	 */
	const handleRefreshEntry = useCallback(
		async (serviceType: ServiceType, configType: ConfigType) => {
			const entryKey = `${serviceType}-${configType}`;
			setRefreshingEntry(entryKey);
			try {
				await refreshMutation.mutateAsync({ serviceType, configType, force: true });
			} catch (error) {
				const message = getErrorMessage(error, "Unknown error");
				toast.error(`Failed to refresh ${configType} cache: ${message}`);
			} finally {
				setRefreshingEntry(null);
			}
		},
		[refreshMutation],
	);

	/**
	 * Delete a specific cache entry
	 */
	const handleDelete = useCallback(
		async (serviceType: ServiceType, configType: ConfigType) => {
			try {
				await deleteMutation.mutateAsync({ serviceType, configType });
			} catch (error) {
				const message = getErrorMessage(error, "Unknown error");
				toast.error(`Failed to delete ${configType} cache: ${message}`);
			}
		},
		[deleteMutation],
	);

	return {
		handleRefresh,
		handleRefreshEntry,
		handleDelete,
		refreshing,
		refreshingEntry,
		refreshMutation,
		deleteMutation,
	};
}
