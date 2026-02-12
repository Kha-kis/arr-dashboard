import { useState, useCallback } from "react";
import type { SERVICE_FILTERS } from "../lib/history-utils";
import { type TimeRangePreset, getTimeRangeStart } from "../lib/date-utils";

export type ViewMode = "timeline" | "table";

export interface HistoryState {
	page: number;
	pageSize: number;
	startDate: string;
	endDate: string;
	searchTerm: string;
	serviceFilter: (typeof SERVICE_FILTERS)[number]["value"];
	instanceFilter: string;
	statusFilter: string;
	groupByDownload: boolean;
	viewMode: ViewMode;
	timeRangePreset: TimeRangePreset;
	hideProwlarrRss: boolean;
}

export interface HistoryStateActions {
	setPage: (page: number) => void;
	setPageSize: (size: number) => void;
	setStartDate: (date: string) => void;
	setEndDate: (date: string) => void;
	setSearchTerm: (term: string) => void;
	setServiceFilter: (filter: (typeof SERVICE_FILTERS)[number]["value"]) => void;
	setInstanceFilter: (filter: string) => void;
	setStatusFilter: (filter: string) => void;
	setGroupByDownload: (group: boolean) => void;
	setViewMode: (mode: ViewMode) => void;
	setTimeRangePreset: (preset: TimeRangePreset) => void;
	setHideProwlarrRss: (hide: boolean) => void;
}

export interface UseHistoryStateReturn {
	state: HistoryState;
	actions: HistoryStateActions;
}

const DEFAULT_PRESET: TimeRangePreset = "7d";

/**
 * Manages all state for the history feature
 */
export const useHistoryState = (): UseHistoryStateReturn => {
	const [page, setPage] = useState(1);
	const [pageSize, setPageSize] = useState(25);
	const [startDate, setStartDate] = useState(() => getTimeRangeStart(DEFAULT_PRESET) ?? "");
	const [endDate, setEndDate] = useState("");
	const [searchTerm, setSearchTerm] = useState("");
	const [serviceFilter, setServiceFilter] =
		useState<(typeof SERVICE_FILTERS)[number]["value"]>("all");
	const [instanceFilter, setInstanceFilter] = useState<string>("all");
	const [statusFilter, setStatusFilter] = useState<string>("all");
	const [groupByDownload, setGroupByDownload] = useState(true);
	const [viewMode, setViewMode] = useState<ViewMode>("timeline");
	const [timeRangePreset, setTimeRangePresetRaw] = useState<TimeRangePreset>(DEFAULT_PRESET);
	const [hideProwlarrRss, setHideProwlarrRss] = useState(true);

	const setTimeRangePreset = useCallback((preset: TimeRangePreset) => {
		setTimeRangePresetRaw(preset);
		setStartDate(getTimeRangeStart(preset) ?? "");
		setEndDate("");
		setPage(1);
	}, []);

	return {
		state: {
			page,
			pageSize,
			startDate,
			endDate,
			searchTerm,
			serviceFilter,
			instanceFilter,
			statusFilter,
			groupByDownload,
			viewMode,
			timeRangePreset,
			hideProwlarrRss,
		},
		actions: {
			setPage,
			setPageSize,
			setStartDate,
			setEndDate,
			setSearchTerm,
			setServiceFilter,
			setInstanceFilter,
			setStatusFilter,
			setGroupByDownload,
			setViewMode,
			setTimeRangePreset,
			setHideProwlarrRss,
		},
	};
};
