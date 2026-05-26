"use client";

import { type LibraryService, libraryServiceSchema } from "@arr/shared";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Status filter options for library items
 */
export const STATUS_FILTERS = [
	{ value: "all", label: "All statuses" },
	{ value: "monitored", label: "Monitored" },
	{ value: "unmonitored", label: "Not monitored" },
] as const;

/**
 * File filter options for library items
 */
export const FILE_FILTERS = [
	{ value: "all", label: "All files" },
	{ value: "has-file", label: "Has file" },
	{ value: "missing", label: "Missing file" },
] as const;

export const QUALITY_FILTERS = [
	{ value: "all", label: "All quality" },
	{ value: "cutoff-unmet", label: "Cutoff unmet" },
	{ value: "cutoff-met", label: "Cutoff met" },
] as const;

/**
 * qui torrent-state filter options (Phase 2.1).
 * `none` surfaces items the qui sync hasn't reached yet — useful for triaging
 * coverage. The list mirrors `normalizedTorrentStateSchema` in @arr/shared,
 * sorted by likely operator priority (problems first, healthy last).
 */
export const TORRENT_STATE_FILTERS = [
	{ value: "all", label: "All torrent states" },
	{ value: "stalled_dl", label: "Stalled download" },
	{ value: "error", label: "Error" },
	{ value: "downloading", label: "Downloading" },
	{ value: "seeding", label: "Seeding" },
	{ value: "paused", label: "Paused" },
	{ value: "queued", label: "Queued" },
	{ value: "checking", label: "Checking" },
	{ value: "moving", label: "Moving" },
	{ value: "unknown", label: "Unknown" },
	// "Not correlated" is the honest label: this bucket includes BOTH items
	// where qui has no torrent matching our infoHash AND items whose infoHash
	// hasn't been backfilled (most common cause: *arr's grab history was
	// pruned before backfill could capture the downloadId). The previous
	// label "No qui data" suggested the gap was on qui's side; the truth is
	// it's a missing audit trail, not a qui issue.
	{ value: "none", label: "Not correlated with qui" },
] as const;

/**
 * Sort options for library items.
 * `torrentRatio` is qui-only and only meaningful when qui is configured —
 * the LibraryHeader gates it behind `hasQui` to avoid offering an option
 * that would always sort to NULLs-last for users without qui data.
 */
export const SORT_OPTIONS = [
	{ value: "sortTitle", label: "Title" },
	{ value: "year", label: "Year" },
	{ value: "sizeOnDisk", label: "Size" },
	{ value: "added", label: "Date Added" },
	{ value: "torrentRatio", label: "Torrent ratio" },
] as const;

export type StatusFilterValue = (typeof STATUS_FILTERS)[number]["value"];
export type FileFilterValue = (typeof FILE_FILTERS)[number]["value"];
export type QualityFilterValue = (typeof QUALITY_FILTERS)[number]["value"];
export type TorrentStateFilterValue = (typeof TORRENT_STATE_FILTERS)[number]["value"];
export type SortByValue = (typeof SORT_OPTIONS)[number]["value"];
export type SortOrderValue = "asc" | "desc";

const QUALITY_FILTER_VALUES = QUALITY_FILTERS.map(
	(option) => option.value,
) as readonly QualityFilterValue[];

const TORRENT_STATE_FILTER_VALUES = TORRENT_STATE_FILTERS.map(
	(option) => option.value,
) as readonly TorrentStateFilterValue[];

/**
 * Normalize a deep-link `?quality=` param to a valid filter value.
 * Returns "all" for missing or unknown inputs so untrusted URLs can't widen the union.
 */
function parseQualityFilterParam(raw: string | null | undefined): QualityFilterValue {
	if (!raw) return "all";
	return (QUALITY_FILTER_VALUES as readonly string[]).includes(raw)
		? (raw as QualityFilterValue)
		: "all";
}

/**
 * Normalize a deep-link `?service=` param to a valid service filter.
 * Returns "all" for missing or unknown services.
 */
function parseServiceFilterParam(raw: string | null | undefined): "all" | LibraryService {
	if (!raw || raw === "all") return "all";
	const result = libraryServiceSchema.safeParse(raw);
	return result.success ? result.data : "all";
}

/**
 * Normalize a deep-link `?torrentState=` param to a valid filter value.
 * Returns "all" for missing or unknown inputs. The qui home page's Quick
 * Actions and the Pulse seeding-health card link into this via
 * `/library?torrentState=<bucket>`; without this parser the link lands
 * with no filter applied and the user sees the full library, not the
 * filtered slice they expected.
 */
function parseTorrentStateFilterParam(raw: string | null | undefined): TorrentStateFilterValue {
	if (!raw) return "all";
	return (TORRENT_STATE_FILTER_VALUES as readonly string[]).includes(raw)
		? (raw as TorrentStateFilterValue)
		: "all";
}

export interface LibraryFilters {
	// Service and instance
	serviceFilter: "all" | LibraryService;
	setServiceFilter: (value: "all" | LibraryService) => void;
	instanceFilter: string;
	setInstanceFilter: (value: string) => void;

	// Search
	searchTerm: string;
	setSearchTerm: (value: string) => void;

	// Filters
	statusFilter: StatusFilterValue;
	setStatusFilter: (value: StatusFilterValue) => void;
	fileFilter: FileFilterValue;
	setFileFilter: (value: FileFilterValue) => void;
	qualityFilter: QualityFilterValue;
	setQualityFilter: (value: QualityFilterValue) => void;
	torrentStateFilter: TorrentStateFilterValue;
	setTorrentStateFilter: (value: TorrentStateFilterValue) => void;

	// Sorting
	sortBy: SortByValue;
	setSortBy: (value: SortByValue) => void;
	sortOrder: SortOrderValue;
	setSortOrder: (value: SortOrderValue) => void;

	// Pagination
	page: number;
	setPage: (value: number) => void;
	pageSize: number;
	setPageSize: (value: number) => void;

	// Reset handler
	resetFilters: () => void;
}

/**
 * Custom hook for managing library filter state
 *
 * Manages all filter-related state for the library view including:
 * - Service filter (all/radarr/sonarr)
 * - Instance filter
 * - Search term
 * - Status filter (monitored/unmonitored)
 * - File filter (has-file/missing)
 * - Sorting (by title, year, size, date added)
 * - Pagination (page and page size)
 *
 * Automatically resets page to 1 when any filter changes.
 * Automatically resets the instance filter when the service filter changes.
 *
 * @returns Object containing all filter state values and their setters
 */
export function useLibraryFilters(): LibraryFilters {
	// Seed from URL search params so deep links such as `/library?quality=cutoff-unmet`
	// (Pulse) and `/library?service=sonarr` (dashboard cards) preselect the matching
	// filter. The initial useState read covers cold loads; the useEffect below covers
	// warm client-side navigations (App Router doesn't remount the page on a
	// query-string-only change). User-driven dropdown changes don't trigger the
	// effect because the URL param value is unchanged.
	const searchParams = useSearchParams();
	const initialServiceParam = searchParams.get("service");
	const initialQualityParam = searchParams.get("quality");
	const initialTorrentStateParam = searchParams.get("torrentState");
	const [serviceFilter, setServiceFilterState] = useState<"all" | LibraryService>(() =>
		parseServiceFilterParam(initialServiceParam),
	);
	const [instanceFilter, setInstanceFilterState] = useState<string>("all");
	const [searchTerm, setSearchTermState] = useState("");
	const [statusFilter, setStatusFilterState] = useState<StatusFilterValue>("all");
	const [fileFilter, setFileFilterState] = useState<FileFilterValue>("all");
	const [qualityFilter, setQualityFilterState] = useState<QualityFilterValue>(() =>
		parseQualityFilterParam(initialQualityParam),
	);
	const [torrentStateFilter, setTorrentStateFilterState] = useState<TorrentStateFilterValue>(() =>
		parseTorrentStateFilterParam(initialTorrentStateParam),
	);
	const [sortBy, setSortByState] = useState<SortByValue>("sortTitle");
	const [sortOrder, setSortOrderState] = useState<SortOrderValue>("asc");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSizeState] = useState(50);

	// Track the last URL param value we applied so user-driven dropdown changes
	// (which don't update the URL) don't get clobbered by re-renders.
	const lastServiceParam = useRef(initialServiceParam);
	const lastQualityParam = useRef(initialQualityParam);
	const lastTorrentStateParam = useRef(initialTorrentStateParam);

	useEffect(() => {
		const current = searchParams.get("service");
		if (current === lastServiceParam.current) return;
		lastServiceParam.current = current;
		setServiceFilterState(parseServiceFilterParam(current));
		setPage(1);
	}, [searchParams]);

	useEffect(() => {
		const current = searchParams.get("quality");
		if (current === lastQualityParam.current) return;
		lastQualityParam.current = current;
		setQualityFilterState(parseQualityFilterParam(current));
		setPage(1);
	}, [searchParams]);

	useEffect(() => {
		const current = searchParams.get("torrentState");
		if (current === lastTorrentStateParam.current) return;
		lastTorrentStateParam.current = current;
		setTorrentStateFilterState(parseTorrentStateFilterParam(current));
		setPage(1);
	}, [searchParams]);

	// Wrappers that reset page to 1 on filter change
	const setServiceFilter = useCallback((value: "all" | LibraryService) => {
		setServiceFilterState(value);
		setPage(1);
	}, []);

	const setInstanceFilter = useCallback((value: string) => {
		setInstanceFilterState(value);
		setPage(1);
	}, []);

	const setSearchTerm = useCallback((value: string) => {
		setSearchTermState(value);
		setPage(1);
	}, []);

	const setStatusFilter = useCallback((value: StatusFilterValue) => {
		setStatusFilterState(value);
		setPage(1);
	}, []);

	const setFileFilter = useCallback((value: FileFilterValue) => {
		setFileFilterState(value);
		setPage(1);
	}, []);

	const setQualityFilter = useCallback((value: QualityFilterValue) => {
		setQualityFilterState(value);
		setPage(1);
	}, []);

	const setTorrentStateFilter = useCallback((value: TorrentStateFilterValue) => {
		setTorrentStateFilterState(value);
		setPage(1);
	}, []);

	const setSortBy = useCallback((value: SortByValue) => {
		setSortByState(value);
		setPage(1);
	}, []);

	const setSortOrder = useCallback((value: SortOrderValue) => {
		setSortOrderState(value);
		setPage(1);
	}, []);

	const setPageSize = useCallback((value: number) => {
		setPageSizeState(value);
		setPage(1);
	}, []);

	const resetFilters = useCallback(() => {
		setServiceFilterState("all");
		setInstanceFilterState("all");
		setSearchTermState("");
		setStatusFilterState("all");
		setFileFilterState("all");
		setQualityFilterState("all");
		setTorrentStateFilterState("all");
		setSortByState("sortTitle");
		setSortOrderState("asc");
		setPage(1);
	}, []);

	// Reset instance filter when service filter changes. Also fires once on mount
	// (effects always do); currently safe because `instanceFilter` has no URL seed
	// — its initial value is "all" so the assignment is a no-op. If you ever add
	// an `?instance=` URL seed, gate this with a ref so it doesn't clobber it.
	useEffect(() => {
		setInstanceFilterState("all");
	}, [serviceFilter]);

	return {
		serviceFilter,
		setServiceFilter,
		instanceFilter,
		setInstanceFilter,
		searchTerm,
		setSearchTerm,
		statusFilter,
		setStatusFilter,
		fileFilter,
		setFileFilter,
		qualityFilter,
		setQualityFilter,
		torrentStateFilter,
		setTorrentStateFilter,
		sortBy,
		setSortBy,
		sortOrder,
		setSortOrder,
		page,
		setPage,
		pageSize,
		setPageSize,
		resetFilters,
	};
}
