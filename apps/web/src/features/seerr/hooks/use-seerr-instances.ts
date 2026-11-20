"use client";

import { useMemo } from "react";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";

/**
 * Filters the global services list to only Seerr instances.
 * Returns the list + a sensible default instance (the first, or the one marked default).
 */
export function useSeerrInstances() {
	const {
		data: services,
		isLoading,
		error,
		errorUpdatedAt,
		isFetching,
		refetch,
	} = useServicesQuery();

	const seerrInstances = useMemo(
		() => (services ?? []).filter((s) => s.service.toLowerCase() === "seerr" && s.enabled),
		[services],
	);

	const defaultInstance = useMemo(
		() => seerrInstances.find((s) => s.isDefault) ?? seerrInstances[0] ?? null,
		[seerrInstances],
	);

	// A retry clears the query error while pending. Keep an uncached failed read
	// unavailable until a successful response (including an empty list) arrives.
	const hasFailedInitialRead = services === undefined && errorUpdatedAt > 0;

	return {
		seerrInstances,
		defaultInstance,
		isLoading,
		error,
		hasFailedInitialRead,
		isFetching,
		refetch,
	};
}
