import { useMemo } from "react";
import type { HistoryItem } from "@arr/shared";
import {
	extractInstanceOptions,
	extractStatusOptions,
	createServiceSummary,
	createStatusSummary,
	groupHistoryItems,
	normalizeStatus,
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
	allItems: HistoryItem[];
	filteredItems: HistoryItem[];
	groupedItems: HistoryGroup[];
	instanceOptions: Array<{ value: string; label: string }>;
	statusOptions: Array<{ value: string; label: string }>;
	serviceSummary: Map<HistoryItem["service"], number>;
	statusSummary: Array<[string, number]>;
	filtersActive: boolean;
	emptyMessage?: string;
}

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
): ProcessedHistoryData => {
	const allAggregated = useMemo(() => data?.aggregated ?? [], [data?.aggregated]);
	const instances = useMemo(() => data?.instances ?? [], [data?.instances]);

	const instanceOptions = useMemo(() => extractInstanceOptions(instances), [instances]);

	const statusOptions = useMemo(() => extractStatusOptions(allAggregated), [allAggregated]);

	const filteredItems = useMemo(() => {
		const term = filters.searchTerm.trim().toLowerCase();
		return allAggregated.filter((item) => {
			if (filters.serviceFilter !== "all" && item.service !== filters.serviceFilter) {
				return false;
			}
			if (filters.instanceFilter !== "all" && item.instanceId !== filters.instanceFilter) {
				return false;
			}
			const currentStatus = normalizeStatus(item.status, item.eventType);
			if (filters.statusFilter !== "all" && currentStatus !== filters.statusFilter) {
				return false;
			}
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
				if (!haystack.some((value) => value.includes(term))) {
					return false;
				}
			}
			return true;
		});
	}, [
		allAggregated,
		filters.serviceFilter,
		filters.instanceFilter,
		filters.statusFilter,
		filters.searchTerm,
	]);

	const serviceSummary = useMemo(() => createServiceSummary(allAggregated), [allAggregated]);

	const statusSummary = useMemo(() => createStatusSummary(filteredItems), [filteredItems]);

	const filtersActive =
		filters.serviceFilter !== "all" ||
		filters.instanceFilter !== "all" ||
		filters.statusFilter !== "all" ||
		filters.searchTerm.trim().length > 0 ||
		Boolean(filters.startDate) ||
		Boolean(filters.endDate);

	const emptyMessage =
		filteredItems.length === 0 && allAggregated.length > 0
			? "No history records match the current filters."
			: undefined;

	const groupedItems = useMemo(
		() => groupHistoryItems(filteredItems, groupByDownload),
		[filteredItems, groupByDownload],
	);

	return {
		allItems: allAggregated,
		filteredItems,
		groupedItems,
		instanceOptions,
		statusOptions,
		serviceSummary,
		statusSummary,
		filtersActive,
		emptyMessage,
	};
};
