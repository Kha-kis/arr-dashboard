"use client";

import { useMemo } from "react";
import type { LibraryItem, LibraryService, ServiceInstanceSummary, Pagination } from "@arr/shared";
import { useLibraryQuery, useLibrarySyncStatus } from "../../../hooks/api/useLibrary";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import type {
	StatusFilterValue,
	FileFilterValue,
	SortByValue,
	SortOrderValue,
} from "./use-library-filters";

/**
 * Groups library items by their type
 */
const groupItemsByType = (items: LibraryItem[]) => ({
	movies: items.filter((item) => item.type === "movie"),
	series: items.filter((item) => item.type === "series"),
});

export interface LibraryDataParams {
	// Service and instance filters
	serviceFilter: "all" | LibraryService;
	instanceFilter: string;
	// Search
	searchTerm: string;
	// Status and file filters
	statusFilter: StatusFilterValue;
	fileFilter: FileFilterValue;
	// Sorting
	sortBy: SortByValue;
	sortOrder: SortOrderValue;
	// Pagination
	page: number;
	pageSize: number;
}

export interface InstanceOption {
	id: string;
	label: string;
	service: LibraryService;
}

export interface SyncStatus {
	isCached: boolean;
	lastSync: string | null;
	syncInProgress: boolean;
	totalCachedItems: number;
}

export interface LibraryData {
	/** All items from the current page */
	items: LibraryItem[];
	/** Items grouped by type */
	grouped: {
		movies: LibraryItem[];
		series: LibraryItem[];
	};
	/** Pagination info from server */
	pagination: Pagination;
	/** Sync status for the library cache */
	syncStatus: SyncStatus | null;
	/** Instance options for filter dropdown */
	instanceOptions: InstanceOption[];
	/** Service lookup map for external links */
	serviceLookup: Record<string, ServiceInstanceSummary>;
	/** Loading state */
	isLoading: boolean;
	/** Error state */
	isError: boolean;
	/** Error object */
	error: Error | undefined;
	/** Whether the cache is being populated (initial sync) */
	isSyncing: boolean;
}

/**
 * Custom hook for fetching and processing library data with server-side pagination
 *
 * Handles:
 * - Fetching paginated library items from the API
 * - Passing filters, search, and pagination to the server
 * - Fetching service instance data for external links
 * - Grouping items by type (movies/series)
 * - Building instance options for the filter dropdown
 * - Creating a service lookup map for external links
 *
 * @param params - Filter, sort, and pagination parameters
 * @returns Processed library data including paginated and grouped items
 */
export function useLibraryData(params: LibraryDataParams): LibraryData {
	const {
		serviceFilter,
		instanceFilter,
		searchTerm,
		statusFilter,
		fileFilter,
		sortBy,
		sortOrder,
		page,
		pageSize,
	} = params;

	// Convert filter values to API format
	const monitoredFilter =
		statusFilter === "all" ? "all" : statusFilter === "monitored" ? "true" : "false";
	const hasFileFilter =
		fileFilter === "all" ? "all" : fileFilter === "has-file" ? "true" : "false";

	// Fetch library data with server-side pagination
	const libraryQuery = useLibraryQuery({
		// Pagination
		page,
		limit: pageSize,
		// Filters
		service: serviceFilter === "all" ? undefined : serviceFilter,
		instanceId: instanceFilter === "all" ? undefined : instanceFilter,
		search: searchTerm.trim() || undefined,
		monitored: monitoredFilter,
		hasFile: hasFileFilter,
		// Sorting
		sortBy,
		sortOrder,
	});

	// Fetch services data for external links
	const servicesQuery = useServicesQuery();

	// Fetch sync status to show cache state
	const syncStatusQuery = useLibrarySyncStatus();

	// Extract items from paginated response
	const items = useMemo(() => libraryQuery.data?.items ?? [], [libraryQuery.data?.items]);

	// Extract pagination from response
	const pagination = useMemo<Pagination>(
		() =>
			libraryQuery.data?.pagination ?? {
				page: 1,
				limit: pageSize,
				totalItems: 0,
				totalPages: 0,
			},
		[libraryQuery.data?.pagination, pageSize],
	);

	// Extract sync status
	const syncStatus = useMemo<SyncStatus | null>(() => {
		const status = libraryQuery.data?.syncStatus;
		if (!status) return null;
		return {
			isCached: status.isCached,
			lastSync: status.lastSync,
			syncInProgress: status.syncInProgress,
			totalCachedItems: status.totalCachedItems,
		};
	}, [libraryQuery.data?.syncStatus]);

	// Check if any instance is currently syncing
	const isSyncing = useMemo(() => {
		if (syncStatus?.syncInProgress) return true;
		return (
			syncStatusQuery.data?.instances.some((inst) => inst.syncStatus.syncInProgress) ?? false
		);
	}, [syncStatus, syncStatusQuery.data]);

	// Create service lookup map for external links
	const serviceLookup = useMemo<Record<string, ServiceInstanceSummary>>(() => {
		const lookup: Record<string, ServiceInstanceSummary> = {};
		for (const service of servicesQuery.data ?? []) {
			lookup[service.id] = service;
		}
		return lookup;
	}, [servicesQuery.data]);

	// Group items by type
	const grouped = useMemo(() => groupItemsByType(items), [items]);

	// Build instance options from services query (since we don't have instances from response anymore)
	const instanceOptions = useMemo<InstanceOption[]>(() => {
		const services = servicesQuery.data ?? [];
		// ServiceInstanceSummary uses uppercase service names
		const arrServices = services.filter(
			(s) =>
				s.service.toUpperCase() === "SONARR" || s.service.toUpperCase() === "RADARR",
		);

		return arrServices.map((service) => ({
			id: service.id,
			label: `${service.label} - ${service.service.toUpperCase() === "RADARR" ? "Movies" : "Series"}`,
			service: service.service.toLowerCase() as LibraryService,
		}));
	}, [servicesQuery.data]);

	return {
		items,
		grouped,
		pagination,
		syncStatus,
		instanceOptions,
		serviceLookup,
		isLoading: libraryQuery.isLoading,
		isError: libraryQuery.isError,
		error: libraryQuery.error as Error | undefined,
		isSyncing,
	};
}
