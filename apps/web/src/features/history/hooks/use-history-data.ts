import type { HistoryItemV2, HistoryResponseV2 } from "@arr/shared";
import { useMemo } from "react";
import { type DayGroup, groupByDay } from "../lib/date-utils";
import {
	composeHistoryItems,
	createActivitySummary,
	createServiceSummary,
	createStatusSummary,
	extractInstanceOptions,
	groupHistoryItems,
	type HistoryGroup,
} from "../lib/history-utils";

export interface HistoryFilters {
	searchTerm: string;
	serviceFilter: string;
	instanceFilter: string;
	statusFilter: string;
	startDate?: string;
	endDate?: string;
}
export interface ProcessedHistoryData {
	allItems: HistoryItemV2[];
	filteredItems: HistoryItemV2[];
	groupedItems: HistoryGroup[];
	groupedByDay: DayGroup<HistoryGroup>[];
	instanceOptions: Array<{ value: string; label: string }>;
	serviceSummary: Map<HistoryItemV2["service"], number>;
	statusSummary: Array<[string, number]>;
	activitySummary: ReturnType<typeof createActivitySummary>;
	filtersActive: boolean;
	emptyMessage?: string;
	sources: HistoryResponseV2["sources"];
	matchingObservedCount: number;
	hasNextPage: boolean;
}
export const useHistoryData = (
	data: { pages: HistoryResponseV2[] } | undefined,
	filters: HistoryFilters,
	groupByDownload: boolean,
	_hideProwlarrRss: boolean,
): ProcessedHistoryData => {
	const composed = useMemo(() => composeHistoryItems(data?.pages ?? []), [data?.pages]);
	const instanceOptions = useMemo(
		() => extractInstanceOptions(composed.sources),
		[composed.sources],
	);
	const groupedItems = useMemo(
		() => groupHistoryItems(composed.items, groupByDownload),
		[composed.items, groupByDownload],
	);
	const groupedByDay = useMemo(
		() => groupByDay(groupedItems, (group) => group.items[0]?.eventAt),
		[groupedItems],
	);
	const filtersActive =
		filters.serviceFilter !== "all" ||
		filters.instanceFilter !== "all" ||
		filters.statusFilter !== "" ||
		filters.searchTerm.trim().length > 0 ||
		Boolean(filters.startDate) ||
		Boolean(filters.endDate);
	return {
		allItems: composed.items,
		filteredItems: composed.items,
		groupedItems,
		groupedByDay,
		instanceOptions,
		serviceSummary: createServiceSummary(composed.items),
		statusSummary: createStatusSummary(composed.items),
		activitySummary: createActivitySummary(composed.items),
		filtersActive,
		emptyMessage:
			composed.items.length === 0
				? "No retained observations match the active filters."
				: undefined,
		sources: composed.sources,
		matchingObservedCount: composed.matchingObservedCount,
		hasNextPage: composed.hasNextPage,
	};
};
