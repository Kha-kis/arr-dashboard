import { useMemo, useState } from "react";
import type { SearchResult } from "@arr/shared";

/**
 * Hook for managing search results pagination.
 * Handles page state, page size, and computes paginated results slice.
 *
 * @param results - Filtered and sorted search results to paginate
 * @returns Pagination state and paginated results slice
 *
 * @example
 * const { page, pageSize, paginatedResults, setPage, setPageSize } = useSearchPagination(filteredResults);
 */
export function useSearchPagination(results: SearchResult[]) {
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(25);

	const paginatedResults = useMemo(() => {
		const start = (page - 1) * pageSize;
		return results.slice(start, start + pageSize);
	}, [results, page, pageSize]);

	const handlePageSizeChange = (size: number) => {
		setPageSize(size);
		setPage(1); // Reset to first page when changing page size
	};

	return {
		page,
		pageSize,
		paginatedResults,
		setPage,
		setPageSize: handlePageSizeChange,
	};
}
