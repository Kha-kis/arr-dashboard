import { useEffect } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import type { SearchIndexersResponse } from "@arr/shared";
import type { SearchStateActions } from "./use-search-state";

/**
 * Hook for managing indexer initialization and selection.
 * Automatically selects all enabled indexers when indexers are first loaded.
 *
 * @param indexersQuery - Query result from useSearchIndexersQuery
 * @param actions - Actions from useSearchState to update selected indexers
 *
 * @example
 * useSearchIndexers(indexersQuery, searchState.actions);
 */
export function useSearchIndexers(
	indexersQuery: UseQueryResult<SearchIndexersResponse>,
	actions: SearchStateActions,
) {
	useEffect(() => {
		if (!indexersQuery.data || indexersQuery.data.instances.length === 0) {
			actions.setSelectedIndexers({});
			return;
		}

		actions.setSelectedIndexers((current) => {
			// If already initialized, don't override user selections
			if (Object.keys(current).length > 0) {
				return current;
			}

			// Initialize with all enabled indexers
			const initial: Record<string, number[]> = {};
			for (const instance of indexersQuery.data.instances) {
				const enabled = instance.data
					.filter((indexer: { enable: boolean }) => indexer.enable)
					.map((indexer: { id: number }) => indexer.id);
				initial[instance.instanceId] = enabled;
			}
			return initial;
		});
	}, [indexersQuery.data, actions]);
}
