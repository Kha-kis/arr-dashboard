"use client";

import { useMemo } from "react";
import type { LibraryItem, LibraryService, ServiceInstanceSummary } from "@arr/shared";
import { useLibraryQuery } from "../../../hooks/api/useLibrary";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";
import type { StatusFilterValue, FileFilterValue } from "./use-library-filters";

/**
 * Groups library items by their type
 */
const groupItemsByType = (items: LibraryItem[]) => ({
	movies: items.filter((item) => item.type === "movie"),
	series: items.filter((item) => item.type === "series"),
});

export interface LibraryDataParams {
	serviceFilter: "all" | LibraryService;
	instanceFilter: string;
	searchTerm: string;
	statusFilter: StatusFilterValue;
	fileFilter: FileFilterValue;
}

export interface InstanceOption {
	id: string;
	label: string;
	service: LibraryService;
}

export interface LibraryData {
	items: LibraryItem[];
	filteredItems: LibraryItem[];
	grouped: {
		movies: LibraryItem[];
		series: LibraryItem[];
	};
	instances: Array<{
		instanceId: string;
		instanceName: string;
		service: LibraryService;
	}>;
	instanceOptions: InstanceOption[];
	serviceLookup: Record<string, ServiceInstanceSummary>;
	isLoading: boolean;
	isError: boolean;
	error: Error | undefined;
}

/**
 * Custom hook for fetching and processing library data
 *
 * Handles:
 * - Fetching library items from the API
 * - Fetching service instance data
 * - Filtering items based on search term, status, and file filters
 * - Grouping items by type (movies/series)
 * - Building instance options for the filter dropdown
 * - Creating a service lookup map for external links
 *
 * @param params - Filter parameters for fetching and filtering data
 * @returns Processed library data including filtered and grouped items
 */
export function useLibraryData(params: LibraryDataParams): LibraryData {
	const { serviceFilter, instanceFilter, searchTerm, statusFilter, fileFilter } = params;

	// Fetch library data
	const libraryQuery = useLibraryQuery({
		service: serviceFilter === "all" ? undefined : serviceFilter,
		instanceId: instanceFilter === "all" ? undefined : instanceFilter,
	});

	// Fetch services data
	const servicesQuery = useServicesQuery();

	// Extract raw data
	const items = libraryQuery.data?.aggregated ?? [];
	const instances = libraryQuery.data?.instances ?? [];

	// Create service lookup map
	const serviceLookup = useMemo<Record<string, ServiceInstanceSummary>>(() => {
		const lookup: Record<string, ServiceInstanceSummary> = {};
		for (const service of servicesQuery.data ?? []) {
			lookup[service.id] = service;
		}
		return lookup;
	}, [servicesQuery.data]);

	// Filter items based on search term and filters
	const filteredItems = useMemo(() => {
		const text = searchTerm.trim().toLowerCase();
		return items.filter((item) => {
			// Search filter
			const haystack = [
				item.title,
				item.overview,
				item.instanceName,
				item.genres?.join(" "),
				item.tags?.join(" "),
			]
				.filter(Boolean)
				.join(" ")
				.toLowerCase();

			const matchesText = text.length === 0 || haystack.includes(text);

			// Status filter
			const matchesStatus =
				statusFilter === "all" ||
				(statusFilter === "monitored" && Boolean(item.monitored)) ||
				(statusFilter === "unmonitored" && !Boolean(item.monitored));

			// File filter
			const itemHasFile =
				item.type === "movie"
					? Boolean(item.hasFile)
					: Boolean(item.hasFile) || (item.statistics?.episodeFileCount ?? 0) > 0;
			const matchesFile =
				fileFilter === "all" ||
				(fileFilter === "has-file" && itemHasFile) ||
				(fileFilter === "missing" && !itemHasFile);

			return matchesText && matchesStatus && matchesFile;
		});
	}, [items, searchTerm, statusFilter, fileFilter]);

	// Group filtered items by type
	const grouped = useMemo(() => groupItemsByType(filteredItems), [filteredItems]);

	// Build instance options for the filter dropdown
	const instanceOptions = useMemo(() => {
		if (instances.length === 0) {
			return [];
		}

		return instances.map((entry) => ({
			id: entry.instanceId,
			label: `${entry.instanceName} - ${entry.service === "radarr" ? "Movies" : "Series"}`,
			service: entry.service,
		}));
	}, [instances]);

	return {
		items,
		filteredItems,
		grouped,
		instances,
		instanceOptions,
		serviceLookup,
		isLoading: libraryQuery.isLoading,
		isError: libraryQuery.isError,
		error: libraryQuery.error as Error | undefined,
	};
}
