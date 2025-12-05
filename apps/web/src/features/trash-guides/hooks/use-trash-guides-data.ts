import { useTrashCacheStatus } from "../../../hooks/api/useTrashCache";
import { useTemplates } from "../../../hooks/api/useTemplates";

/**
 * Hook for managing TRaSH Guides data fetching and aggregation.
 * Centralizes cache status and templates data queries.
 *
 * @returns Combined query state and data
 *
 * @example
 * const { cacheStatus, templates, isLoading, error, refetch } = useTrashGuidesData();
 */
export function useTrashGuidesData() {
	const cacheStatusQuery = useTrashCacheStatus();
	const templatesQuery = useTemplates();

	return {
		// Cache status query
		cacheStatus: cacheStatusQuery.data,
		isCacheLoading: cacheStatusQuery.isLoading,
		cacheError: cacheStatusQuery.error,
		refetchCache: cacheStatusQuery.refetch,

		// Templates query
		templates: templatesQuery.data,
		isTemplatesLoading: templatesQuery.isLoading,
		templatesError: templatesQuery.error,
		refetchTemplates: templatesQuery.refetch,

		// Combined loading state
		isLoading: cacheStatusQuery.isLoading || templatesQuery.isLoading,
		error: cacheStatusQuery.error || templatesQuery.error,
	};
}
