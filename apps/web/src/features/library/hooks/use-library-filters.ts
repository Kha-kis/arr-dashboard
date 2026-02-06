"use client";

import { useCallback, useEffect, useState } from "react";
import type { LibraryService } from "@arr/shared";

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

/**
 * Sort options for library items
 */
export const SORT_OPTIONS = [
	{ value: "sortTitle", label: "Title" },
	{ value: "year", label: "Year" },
	{ value: "sizeOnDisk", label: "Size" },
	{ value: "added", label: "Date Added" },
] as const;

export type StatusFilterValue = (typeof STATUS_FILTERS)[number]["value"];
export type FileFilterValue = (typeof FILE_FILTERS)[number]["value"];
export type SortByValue = (typeof SORT_OPTIONS)[number]["value"];
export type SortOrderValue = "asc" | "desc";

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
	const [serviceFilter, setServiceFilterState] = useState<"all" | LibraryService>("all");
	const [instanceFilter, setInstanceFilterState] = useState<string>("all");
	const [searchTerm, setSearchTermState] = useState("");
	const [statusFilter, setStatusFilterState] = useState<StatusFilterValue>("all");
	const [fileFilter, setFileFilterState] = useState<FileFilterValue>("all");
	const [sortBy, setSortByState] = useState<SortByValue>("sortTitle");
	const [sortOrder, setSortOrderState] = useState<SortOrderValue>("asc");
	const [page, setPage] = useState(1);
	const [pageSize, setPageSizeState] = useState(50);

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
		setSortByState("sortTitle");
		setSortOrderState("asc");
		setPage(1);
	}, []);

	// Reset instance filter when service filter changes
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
