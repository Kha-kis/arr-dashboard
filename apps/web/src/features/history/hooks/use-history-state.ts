import { HISTORY_EVENT_TYPE_MAX_LENGTH } from "@arr/shared";
import { useCallback, useState } from "react";
import {
	canonicalizeDateInput,
	getTimeRangeStart,
	type TimeRangePreset,
	validateDateRange,
} from "../lib/date-utils";
import type { SERVICE_FILTERS } from "../lib/history-utils";
export type ViewMode = "timeline" | "table";
export interface HistoryState {
	limit: number;
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
	chainRevision: number;
	dateValidationError: string | null;
	eventTypeValidationError: string | null;
}
export interface HistoryStateActions {
	setLimit: (limit: number) => void;
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
	restartPagination: () => void;
}
export interface UseHistoryStateReturn {
	state: HistoryState;
	actions: HistoryStateActions;
}
const DEFAULT_PRESET: TimeRangePreset = "7d";
const INVALID_DATE_MESSAGE = "Enter a valid local date range.";
const INVALID_EVENT_TYPE_MESSAGE = "Enter a valid event type.";
const URL_LIKE_EVENT_TYPE = /(?:\b[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:data|mailto|magnet):)/i;
const hasControlCharacters = (value: string) =>
	Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
export const useHistoryState = (): UseHistoryStateReturn => {
	const [limit, setLimit] = useState(25);
	const [startDate, setStartDateRaw] = useState(() => getTimeRangeStart(DEFAULT_PRESET) ?? "");
	const [endDate, setEndDateRaw] = useState("");
	const [searchTerm, setSearchTerm] = useState("");
	const [serviceFilter, setServiceFilter] =
		useState<(typeof SERVICE_FILTERS)[number]["value"]>("all");
	const [instanceFilter, setInstanceFilter] = useState("all");
	const [statusFilter, setStatusFilterRaw] = useState("");
	const [groupByDownload, setGroupByDownload] = useState(true);
	const [viewMode, setViewMode] = useState<ViewMode>("timeline");
	const [timeRangePreset, setTimeRangePresetRaw] = useState<TimeRangePreset>(DEFAULT_PRESET);
	const [hideProwlarrRss, setHideProwlarrRss] = useState(true);
	const [chainRevision, setChainRevision] = useState(0);
	const [dateValidationError, setDateValidationError] = useState<string | null>(null);
	const [eventTypeValidationError, setEventTypeValidationError] = useState<string | null>(null);
	const updateBound = useCallback(
		(value: string, boundary: "start" | "end") => {
			const canonical = canonicalizeDateInput(value, boundary);
			if (
				canonical === null ||
				!validateDateRange(
					boundary === "start" ? canonical : startDate,
					boundary === "end" ? canonical : endDate,
				)
			) {
				setDateValidationError(INVALID_DATE_MESSAGE);
				return;
			}
			setDateValidationError(null);
			if (boundary === "start") setStartDateRaw(canonical);
			else setEndDateRaw(canonical);
			setTimeRangePresetRaw("all");
		},
		[startDate, endDate],
	);
	const setTimeRangePreset = useCallback((preset: TimeRangePreset) => {
		setTimeRangePresetRaw(preset);
		setStartDateRaw(getTimeRangeStart(preset) ?? "");
		setEndDateRaw("");
		setDateValidationError(null);
	}, []);
	const setStatusFilter = useCallback((value: string) => {
		const canonical = value.trim().toLowerCase();
		if (
			canonical.length > HISTORY_EVENT_TYPE_MAX_LENGTH ||
			hasControlCharacters(canonical) ||
			URL_LIKE_EVENT_TYPE.test(canonical)
		) {
			setEventTypeValidationError(INVALID_EVENT_TYPE_MESSAGE);
			return;
		}
		setEventTypeValidationError(null);
		setStatusFilterRaw(canonical);
	}, []);
	const restartPagination = useCallback(() => setChainRevision((revision) => revision + 1), []);
	return {
		state: {
			limit,
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
			chainRevision,
			dateValidationError,
			eventTypeValidationError,
		},
		actions: {
			setLimit,
			setStartDate: (value) => updateBound(value, "start"),
			setEndDate: (value) => updateBound(value, "end"),
			setSearchTerm,
			setServiceFilter,
			setInstanceFilter,
			setStatusFilter,
			setGroupByDownload,
			setViewMode,
			setTimeRangePreset,
			setHideProwlarrRss,
			restartPagination,
		},
	};
};
