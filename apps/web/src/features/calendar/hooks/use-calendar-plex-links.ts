import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { usePlexIdentity, plexKeys } from "../../../hooks/api/usePlex";
import { fetchWatchEnrichment } from "../../../lib/api-client/plex";
import { buildPlexUrl } from "../../library/lib/library-utils";
import type { DeduplicatedCalendarItem } from "./use-calendar-data";

/**
 * Builds a Map of "type:tmdbId" → Plex deep link URL for calendar events.
 * Only fetches when Plex is configured (hasPlex=true) and events have tmdbIds.
 * Returns an empty map when Plex is not configured — zero overhead.
 */
export const useCalendarPlexLinks = (
	events: DeduplicatedCalendarItem[],
	hasPlex: boolean,
): Map<string, string> => {
	// Extract unique tmdbIds and types from calendar events
	const enrichable = useMemo(() => {
		if (!hasPlex || events.length === 0) {
			return { tmdbIds: [] as number[], types: [] as string[], key: "" };
		}

		const seen = new Set<string>();
		const tmdbIds: number[] = [];
		const types: string[] = [];

		for (const event of events) {
			if (
				event.tmdbId != null &&
				(event.service === "sonarr" || event.service === "radarr")
			) {
				const mediaType = event.service === "radarr" ? "movie" : "series";
				const key = `${mediaType}:${event.tmdbId}`;
				if (!seen.has(key)) {
					seen.add(key);
					tmdbIds.push(event.tmdbId);
					types.push(mediaType);
				}
			}
		}

		const key = tmdbIds.map((id, i) => `${types[i]}:${id}`).join(",");
		return { tmdbIds, types, key };
	}, [events, hasPlex]);

	// Fetch watch enrichment (contains ratingKey + instanceId per item)
	const enrichmentQuery = useQuery({
		queryKey: plexKeys.watchEnrichment(`cal:${enrichable.key}`),
		queryFn: () => fetchWatchEnrichment(enrichable.tmdbIds, enrichable.types),
		staleTime: 5 * 60_000,
		enabled: hasPlex && enrichable.tmdbIds.length > 0,
	});

	// Fetch Plex identity (contains machineId per Plex instance)
	const identityQuery = usePlexIdentity(hasPlex);

	// Build machineId lookup: instanceId → machineId
	const machineIdMap = useMemo(() => {
		const map = new Map<string, string>();
		if (identityQuery.data?.servers) {
			for (const server of identityQuery.data.servers) {
				map.set(server.instanceId, server.machineId);
			}
		}
		return map;
	}, [identityQuery.data]);

	// Build final Plex URL map: "type:tmdbId" → deep link URL
	return useMemo(() => {
		const map = new Map<string, string>();
		const items = enrichmentQuery.data?.items;
		if (!items || machineIdMap.size === 0) return map;

		for (const [key, enrichment] of Object.entries(items)) {
			if (!enrichment.ratingKey || !enrichment.instanceId) continue;
			const machineId = machineIdMap.get(enrichment.instanceId);
			if (!machineId) continue;
			map.set(key, buildPlexUrl(machineId, enrichment.ratingKey));
		}

		return map;
	}, [enrichmentQuery.data, machineIdMap]);
};
