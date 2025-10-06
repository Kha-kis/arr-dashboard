import { useMemo } from "react";
import type { SearchResult } from "@arr/shared";
import {
  compareBySortKey,
  getAgeHours,
  parseNumberInput,
  type SortKey,
  type ProtocolFilter,
} from "../lib/search-utils";

export interface SearchDataFilters {
  protocolFilter: ProtocolFilter;
  minSeedersInput: string;
  maxAgeInput: string;
  hideRejected: boolean;
  sortKey: SortKey;
  sortDirection: "asc" | "desc";
}

export interface ProcessedSearchData {
  results: SearchResult[];
  hidden: number;
  minSeeders: number | null;
  maxAgeHours: number | null;
  filtersActive: boolean;
}

/**
 * Processes and filters search results based on user preferences
 */
export const useSearchData = (
  results: SearchResult[],
  filters: SearchDataFilters,
): ProcessedSearchData => {
  const {
    protocolFilter,
    minSeedersInput,
    maxAgeInput,
    hideRejected,
    sortKey,
    sortDirection,
  } = filters;

  const processed = useMemo(() => {
    const minSeeders = parseNumberInput(minSeedersInput);
    const maxAgeHours = parseNumberInput(maxAgeInput);

    const filtered = results.filter((result) => {
      if (hideRejected && result.rejected) {
        return false;
      }
      if (protocolFilter !== "all" && result.protocol !== protocolFilter) {
        return false;
      }
      if (minSeeders !== null && (result.seeders ?? 0) < minSeeders) {
        return false;
      }
      if (maxAgeHours !== null) {
        const age = getAgeHours(result);
        if (age === null || age > maxAgeHours) {
          return false;
        }
      }
      return true;
    });

    const sorted = [...filtered].sort((a, b) => {
      const comparison = compareBySortKey(sortKey, a, b);
      if (comparison !== 0) {
        return sortDirection === "asc" ? comparison : -comparison;
      }

      const seedFallback = compareBySortKey("seeders", a, b);
      if (seedFallback !== 0) {
        return sortDirection === "asc" ? seedFallback : -seedFallback;
      }

      const publishFallback = compareBySortKey("publishDate", a, b);
      return sortDirection === "asc" ? publishFallback : -publishFallback;
    });

    return {
      results: sorted,
      hidden: results.length - filtered.length,
      minSeeders,
      maxAgeHours,
    };
  }, [
    results,
    hideRejected,
    protocolFilter,
    minSeedersInput,
    maxAgeInput,
    sortKey,
    sortDirection,
  ]);

  const filtersActive =
    hideRejected ||
    protocolFilter !== "all" ||
    processed.minSeeders !== null ||
    processed.maxAgeHours !== null;

  return {
    ...processed,
    filtersActive,
  };
};
