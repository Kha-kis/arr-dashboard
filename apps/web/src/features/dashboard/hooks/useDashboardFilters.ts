/**
 * Dashboard Filters Hook
 *
 * Manages queue filtering and pagination state.
 * Handles service, instance, and status filters with pagination.
 */

import { useMemo, useState } from "react";
import type { QueueItem } from "@arr/shared";

const SERVICE_FILTERS = [
	{ value: "all" as const, label: "All services" },
	{ value: "sonarr" as const, label: "Sonarr" },
	{ value: "radarr" as const, label: "Radarr" },
] as const;

/**
 * Hook for dashboard queue filtering and pagination
 *
 * @param queueItems - All queue items to filter
 * @returns Filter state, filtered items, and control functions
 */
export const useDashboardFilters = (queueItems: QueueItem[]) => {
	const [serviceFilter, setServiceFilter] =
		useState<(typeof SERVICE_FILTERS)[number]["value"]>("all");
	const [instanceFilter, setInstanceFilter] = useState<string>("all");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(25);

	// Apply all filters
	const filteredItems = useMemo(() => {
		return queueItems.filter((item) => {
			if (serviceFilter !== "all" && item.service !== serviceFilter) {
				return false;
			}
			if (instanceFilter !== "all" && item.instanceId !== instanceFilter) {
				return false;
			}
			const statusValue = (item.status ?? "Pending").toLowerCase();
			if (statusFilter !== "all" && statusValue !== statusFilter.toLowerCase()) {
				return false;
			}
			return true;
		});
	}, [queueItems, serviceFilter, instanceFilter, statusFilter]);

	// Paginate filtered items
	const paginatedItems = useMemo(() => {
		const start = (page - 1) * pageSize;
		return filteredItems.slice(start, start + pageSize);
	}, [filteredItems, page, pageSize]);

	// Status summary for filtered items
	const statusSummary = useMemo(() => {
		const summary = new Map<string, number>();
		for (const item of filteredItems) {
			const label = item.status ?? "Pending";
			summary.set(label, (summary.get(label) ?? 0) + 1);
		}
		return Array.from(summary.entries()).sort((a, b) => b[1] - a[1]);
	}, [filteredItems]);

	const filtersActive =
		serviceFilter !== "all" || instanceFilter !== "all" || statusFilter !== "all";

	const emptyMessage =
		filteredItems.length === 0 && queueItems.length > 0
			? "No queue items match the current filters."
			: undefined;

	const resetFilters = () => {
		setServiceFilter("all");
		setInstanceFilter("all");
		setStatusFilter("all");
		setPage(1);
	};

	const handlePageSizeChange = (size: number) => {
		setPageSize(size);
		setPage(1);
	};

	return {
		// Filter state
		serviceFilter,
		setServiceFilter,
		instanceFilter,
		setInstanceFilter,
		statusFilter,
		setStatusFilter,

		// Pagination state
		page,
		setPage,
		pageSize,
		setPageSize: handlePageSizeChange,

		// Computed values
		filteredItems,
		paginatedItems,
		statusSummary,
		filtersActive,
		emptyMessage,

		// Actions
		resetFilters,

		// Constants
		SERVICE_FILTERS,
	};
};
