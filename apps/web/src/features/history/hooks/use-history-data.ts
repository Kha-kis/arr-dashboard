import type { HistoryItem } from "@arr/shared";
import { useMemo } from "react";
import { type DayGroup, groupByDay } from "../lib/date-utils";
import {
	type ActivitySummary,
	createActivitySummary,
	createServiceSummary,
	createStatusSummary,
	extractInstanceOptions,
	extractStatusOptions,
	filterProwlarrRss,
	groupHistoryItems,
	type HistoryGroup,
	normalizeStatus,
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
	allItems: HistoryItem[];
	filteredItems: HistoryItem[];
	groupedItems: HistoryGroup[];
	groupedByDay: DayGroup<HistoryGroup>[];
	instanceOptions: Array<{ value: string; label: string }>;
	statusOptions: Array<{ value: string; label: string }>;
	serviceSummary: Map<HistoryItem["service"], number>;
	statusSummary: Array<[string, number]>;
	activitySummary: ActivitySummary;
	filtersActive: boolean;
	emptyMessage?: string;
}

interface HistoryGroupingContext {
	previousItems?: HistoryItem[];
	nextItems?: HistoryItem[];
}

const historyItemIdentity = (item: HistoryItem): string =>
	`${item.service}:${item.instanceId}:${String(item.id)}`;

const uniqueHistoryItems = (items: HistoryItem[]): HistoryItem[] => {
	const seen = new Set<string>();
	return items.filter((item) => {
		const key = historyItemIdentity(item);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

const filterHistoryItems = (items: HistoryItem[], filters: HistoryFilters): HistoryItem[] => {
	const term = filters.searchTerm.trim().toLowerCase();
	return items.filter((item) => {
		if (filters.serviceFilter !== "all" && item.service !== filters.serviceFilter) return false;
		if (filters.instanceFilter !== "all" && item.instanceId !== filters.instanceFilter)
			return false;
		const currentStatus = normalizeStatus(item.status, item.eventType);
		if (filters.statusFilter !== "all" && currentStatus !== filters.statusFilter) return false;
		if (term.length > 0) {
			const haystack = [
				item.title,
				item.sourceTitle,
				item.downloadClient,
				item.indexer,
				item.reason,
			]
				.filter(Boolean)
				.map((value) => value!.toLowerCase());
			if (!haystack.some((value) => value.includes(term))) return false;
		}
		return true;
	});
};

/**
 * Processes and filters history data
 */
export const useHistoryData = (
	data:
		| {
				aggregated?: HistoryItem[];
				instances?: Array<{ instanceId: string; instanceName: string }>;
		  }
		| undefined,
	filters: HistoryFilters,
	groupByDownload: boolean,
	hideProwlarrRss: boolean,
	groupingContext: HistoryGroupingContext = {},
): ProcessedHistoryData => {
	const allAggregated = useMemo(() => data?.aggregated ?? [], [data?.aggregated]);
	const instances = useMemo(() => data?.instances ?? [], [data?.instances]);

	// Apply Prowlarr RSS filter before other processing
	const rssFilteredItems = useMemo(
		() => (hideProwlarrRss ? filterProwlarrRss(allAggregated) : allAggregated),
		[allAggregated, hideProwlarrRss],
	);
	const rssFilteredPreviousContext = useMemo(
		() =>
			hideProwlarrRss
				? filterProwlarrRss(groupingContext.previousItems ?? [])
				: (groupingContext.previousItems ?? []),
		[groupingContext.previousItems, hideProwlarrRss],
	);
	const rssFilteredNextContext = useMemo(
		() =>
			hideProwlarrRss
				? filterProwlarrRss(groupingContext.nextItems ?? [])
				: (groupingContext.nextItems ?? []),
		[groupingContext.nextItems, hideProwlarrRss],
	);

	const instanceOptions = useMemo(() => extractInstanceOptions(instances), [instances]);

	const statusOptions = useMemo(() => extractStatusOptions(rssFilteredItems), [rssFilteredItems]);

	const filteredItems = useMemo(
		() => filterHistoryItems(rssFilteredItems, filters),
		[rssFilteredItems, filters],
	);
	const filteredPreviousContext = useMemo(
		() => filterHistoryItems(rssFilteredPreviousContext, filters),
		[rssFilteredPreviousContext, filters],
	);
	const filteredNextContext = useMemo(
		() => filterHistoryItems(rssFilteredNextContext, filters),
		[rssFilteredNextContext, filters],
	);

	const serviceSummary = useMemo(() => createServiceSummary(rssFilteredItems), [rssFilteredItems]);

	const statusSummary = useMemo(() => createStatusSummary(filteredItems), [filteredItems]);

	const activitySummary = useMemo(() => createActivitySummary(allAggregated), [allAggregated]);

	const filtersActive =
		filters.serviceFilter !== "all" ||
		filters.instanceFilter !== "all" ||
		filters.statusFilter !== "all" ||
		filters.searchTerm.trim().length > 0 ||
		Boolean(filters.startDate) ||
		Boolean(filters.endDate);

	const emptyMessage =
		filteredItems.length === 0 && rssFilteredItems.length > 0
			? "No history records match the current filters."
			: undefined;

	const groupedItems = useMemo(() => {
		const currentItemKeys = new Set(filteredItems.map(historyItemIdentity));
		const previousItemKeys = new Set(filteredPreviousContext.map(historyItemIdentity));
		return groupHistoryItems(
			uniqueHistoryItems([...filteredPreviousContext, ...filteredItems, ...filteredNextContext]),
			groupByDownload,
		).filter(
			(group) =>
				!group.items.some((item) => previousItemKeys.has(historyItemIdentity(item))) &&
				group.items.some((item) => currentItemKeys.has(historyItemIdentity(item))),
		);
	}, [filteredItems, filteredNextContext, filteredPreviousContext, groupByDownload]);

	const groupedByDay = useMemo(
		() => groupByDay(groupedItems, (group) => group.items[0]?.date),
		[groupedItems],
	);

	return {
		allItems: rssFilteredItems,
		filteredItems,
		groupedItems,
		groupedByDay,
		instanceOptions,
		statusOptions,
		serviceSummary,
		statusSummary,
		activitySummary,
		filtersActive,
		emptyMessage,
	};
};
