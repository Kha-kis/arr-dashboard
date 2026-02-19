"use client";

import { useMemo } from "react";
import { useServicesQuery } from "../../../hooks/api/useServicesQuery";

/**
 * Filters the global services list to only Seerr instances.
 * Returns the list + a sensible default instance (the first, or the one marked default).
 */
export function useSeerrInstances() {
	const { data: services, isLoading, error } = useServicesQuery();

	const seerrInstances = useMemo(
		() => (services ?? []).filter((s) => s.service.toLowerCase() === "seerr" && s.enabled),
		[services],
	);

	const defaultInstance = useMemo(
		() => seerrInstances.find((s) => s.isDefault) ?? seerrInstances[0] ?? null,
		[seerrInstances],
	);

	return { seerrInstances, defaultInstance, isLoading, error };
}
