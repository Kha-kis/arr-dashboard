/**
 * Dashboard Filters Hook
 *
 * Manages queue filtering, sorting, and pagination state.
 * Handles service, instance, status filters, and sort options.
 *
 * IMPORTANT: This hook handles FILTERING and SORTING only. Pagination should happen
 * AFTER grouping in the component to ensure the correct number of visual
 * cards (groups/items) are displayed per page.
 */

import { useMemo, useState } from "react";
import type { QueueItem } from "@arr/shared";
import { analyzeQueueItem, getProblematicCount } from "../lib/queue-utils";

const SERVICE_FILTERS = [
	{ value: "all" as const, label: "All services" },
	{ value: "sonarr" as const, label: "Sonarr" },
	{ value: "radarr" as const, label: "Radarr" },
	{ value: "lidarr" as const, label: "Lidarr" },
	{ value: "readarr" as const, label: "Readarr" },
] as const;

/**
 * Sort options for queue items
 * @see https://github.com/Kha-kis/arr-dashboard/issues/32
 */
const SORT_OPTIONS = [
	{ value: "default" as const, label: "Default" },
	{ value: "title-asc" as const, label: "Title (A-Z)" },
	{ value: "title-desc" as const, label: "Title (Z-A)" },
	{ value: "size-desc" as const, label: "Size (Largest)" },
	{ value: "size-asc" as const, label: "Size (Smallest)" },
	{ value: "progress-asc" as const, label: "Progress (Least)" },
	{ value: "progress-desc" as const, label: "Progress (Most)" },
	{ value: "status" as const, label: "Status" },
] as const;

type SortOption = (typeof SORT_OPTIONS)[number]["value"];

/**
 * Get display title from queue item (handles both series and movies)
 */
const getItemTitle = (item: QueueItem): string => {
	if (item.series?.title) return item.series.title;
	if (item.movie?.title) return item.movie.title;
	if (item.artist?.name) return item.artist.name;
	if (item.author?.name) return item.author.name;
	return item.title ?? "";
};

/**
 * Calculate progress percentage (0-100)
 */
const getProgress = (item: QueueItem): number => {
	if (!item.size || item.size === 0) return 0;
	const downloaded = item.size - (item.sizeleft ?? 0);
	return (downloaded / item.size) * 100;
};

/**
 * Sort queue items based on selected option
 */
const sortItems = (items: QueueItem[], sortBy: SortOption): QueueItem[] => {
	if (sortBy === "default") return items;

	return [...items].sort((a, b) => {
		switch (sortBy) {
			case "title-asc":
				return getItemTitle(a).localeCompare(getItemTitle(b));
			case "title-desc":
				return getItemTitle(b).localeCompare(getItemTitle(a));
			case "size-desc":
				return (b.size ?? 0) - (a.size ?? 0);
			case "size-asc":
				return (a.size ?? 0) - (b.size ?? 0);
			case "progress-asc":
				return getProgress(a) - getProgress(b);
			case "progress-desc":
				return getProgress(b) - getProgress(a);
			case "status":
				return (a.status ?? "").localeCompare(b.status ?? "");
			default:
				return 0;
		}
	});
};

/**
 * Hook for dashboard queue filtering and pagination state
 *
 * @param queueItems - All queue items to filter
 * @returns Filter state, filtered items, and control functions
 */
export const useDashboardFilters = (queueItems: QueueItem[]) => {
	const [serviceFilter, setServiceFilter] =
		useState<(typeof SERVICE_FILTERS)[number]["value"]>("all");
	const [instanceFilter, setInstanceFilter] = useState<string>("all");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [sortBy, setSortBy] = useState<SortOption>("default");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(5);

	// Apply all filters to raw items
	const filteredItems = useMemo(() => {
		const filtered = queueItems.filter((item) => {
			if (serviceFilter !== "all" && item.service !== serviceFilter) {
				return false;
			}
			if (instanceFilter !== "all" && item.instanceId !== instanceFilter) {
				return false;
			}

			// Special handling for "problematic" filter
			if (statusFilter === "problematic") {
				return analyzeQueueItem(item).isProblematic;
			}

			const statusValue = (item.status ?? "Pending").toLowerCase();
			if (statusFilter !== "all" && statusValue !== statusFilter.toLowerCase()) {
				return false;
			}
			return true;
		});

		// Apply sorting after filtering
		return sortItems(filtered, sortBy);
	}, [queueItems, serviceFilter, instanceFilter, statusFilter, sortBy]);

	// Count of problematic items (for badge display)
	const problematicCount = useMemo(
		() => getProblematicCount(queueItems),
		[queueItems]
	);

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
		serviceFilter !== "all" || instanceFilter !== "all" || statusFilter !== "all" || sortBy !== "default";

	const emptyMessage =
		filteredItems.length === 0 && queueItems.length > 0
			? "No queue items match the current filters."
			: undefined;

	const resetFilters = () => {
		setServiceFilter("all");
		setInstanceFilter("all");
		setStatusFilter("all");
		setSortBy("default");
		setPage(1);
	};

	const handleSortChange = (value: SortOption) => {
		setPage(1);
		setSortBy(value);
	};

	const handleServiceFilterChange = (value: (typeof SERVICE_FILTERS)[number]["value"]) => {
		setPage(1);
		setServiceFilter(value);
	};

	const handleInstanceFilterChange = (value: string) => {
		setPage(1);
		setInstanceFilter(value);
	};

	const handleStatusFilterChange = (value: string) => {
		setPage(1);
		setStatusFilter(value);
	};

	const handlePageSizeChange = (size: number) => {
		setPageSize(size);
		setPage(1);
	};

	return {
		// Filter state
		serviceFilter,
		setServiceFilter: handleServiceFilterChange,
		instanceFilter,
		setInstanceFilter: handleInstanceFilterChange,
		statusFilter,
		setStatusFilter: handleStatusFilterChange,

		// Sort state
		sortBy,
		setSortBy: handleSortChange,

		// Pagination state (managed here, but pagination should be done on grouped rows)
		page,
		setPage,
		pageSize,
		setPageSize: handlePageSizeChange,

		// Computed values
		filteredItems,
		statusSummary,
		filtersActive,
		emptyMessage,
		problematicCount,

		// Actions
		resetFilters,

		// Constants
		SERVICE_FILTERS,
		SORT_OPTIONS,
	};
};
