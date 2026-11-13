import { useQueries } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { usePlexIdentity } from "../../../hooks/api/usePlex";
import { fetchWatchEnrichment } from "../../../lib/api-client/plex";
import {
	getPlexEvidenceFromError,
	isCurrentAuthoritativePlexEvidence,
} from "../../../lib/plex-evidence";
import { plexKeys } from "../../../lib/query-keys";
import { buildPlexUrl } from "../../library/lib/library-utils";
import type { DeduplicatedCalendarItem } from "./use-calendar-data";

// Match the watch-enrichment read route; never truncate the Calendar selection.
const BATCH_SIZE = 200;

/**
 * Builds a Map of "type:tmdbId" → Plex deep link URL for calendar events.
 * Only fetches when Plex is configured (hasPlex=true) and events have tmdbIds.
 * Returns an empty map when Plex is not configured — zero overhead.
 */
export const useCalendarPlexLinks = (events: DeduplicatedCalendarItem[], hasPlex: boolean) => {
	// Extract unique tmdbIds and types from calendar events
	const enrichable = useMemo(() => {
		if (!hasPlex || events.length === 0) {
			return { tmdbIds: [] as number[], types: [] as string[], invalidLinkItemCount: 0 };
		}

		const seen = new Set<string>();
		const tmdbIds: number[] = [];
		const types: string[] = [];
		let invalidLinkItemCount = 0;

		for (const event of events) {
			if (event.service !== "sonarr" && event.service !== "radarr") continue;
			if (
				typeof event.tmdbId !== "number" ||
				!Number.isSafeInteger(event.tmdbId) ||
				event.tmdbId <= 0
			) {
				invalidLinkItemCount++;
				continue;
			}
			const mediaType = event.service === "radarr" ? "movie" : "series";
			const key = `${mediaType}:${event.tmdbId}`;
			if (!seen.has(key)) {
				seen.add(key);
				tmdbIds.push(event.tmdbId);
				types.push(mediaType);
			}
		}

		return { tmdbIds, types, invalidLinkItemCount };
	}, [events, hasPlex]);

	const batches = useMemo(() => {
		const result = [];
		for (let offset = 0; offset < enrichable.tmdbIds.length; offset += BATCH_SIZE) {
			const tmdbIds = enrichable.tmdbIds.slice(offset, offset + BATCH_SIZE);
			const types = enrichable.types.slice(offset, offset + BATCH_SIZE);
			result.push({ tmdbIds, types, key: tmdbIds.map((id, i) => `${types[i]}:${id}`).join(",") });
		}
		return result;
	}, [enrichable]);

	// Independent caches retain healthy/last-known positives when a sibling fails.
	// Serialize reads so a large Calendar cannot fan out an unbounded request burst.
	const requestQueue = useRef<Promise<void>>(Promise.resolve());
	const enrichmentQueries = useQueries({
		queries: batches.map((batch) => ({
			queryKey: plexKeys.watchEnrichment(`cal-batch:${batch.key}`),
			queryFn: ({ signal }: { signal: AbortSignal }) => {
				const request = requestQueue.current.then(() => {
					// Obsolete queued selections must not perform their provider read.
					signal.throwIfAborted();
					return fetchWatchEnrichment(batch.tmdbIds, batch.types);
				});
				requestQueue.current = request.then(
					() => undefined,
					() => undefined,
				);
				return request;
			},
			staleTime: 5 * 60_000,
			enabled: hasPlex,
		})),
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
	const plexUrlMap = new Map<string, string>();
	for (const [index, query] of enrichmentQueries.entries()) {
		const items = query.data?.items;
		if (!items) continue;
		const batch = batches[index]!;
		for (const [target, id] of batch.tmdbIds.entries()) {
			const key = `${batch.types[target]}:${id}`;
			const enrichment = items[key];
			if (!enrichment) continue;
			if (!enrichment.ratingKey || !enrichment.instanceId) continue;
			const machineId = machineIdMap.get(enrichment.instanceId);
			if (!machineId) continue;
			plexUrlMap.set(key, buildPlexUrl(machineId, enrichment.ratingKey));
		}
	}

	const failedQueries = enrichmentQueries.filter((query) => query.error);
	const error = hasPlex ? (failedQueries[0]?.error ?? identityQuery.error) : null;
	const pendingBatchCount = enrichmentQueries.filter((query) => query.isPending).length;
	const summaries = [
		...failedQueries.map(
			(query) =>
				getPlexEvidenceFromError(query.error) ??
				// A generic failure preserves an earlier degraded warning, not current authority.
				(!isCurrentAuthoritativePlexEvidence(query.data?.evidence)
					? query.data?.evidence
					: undefined),
		),
		...enrichmentQueries.filter((query) => !query.error).map((query) => query.data?.evidence),
	].filter((summary) => summary !== undefined);
	// This is an actual degraded batch summary, never synthesized merged authority.
	// An error/pending sibling must not inherit another batch's current status.
	const evidence =
		summaries.find((summary) => !isCurrentAuthoritativePlexEvidence(summary)) ??
		(!error &&
		pendingBatchCount === 0 &&
		enrichmentQueries.every((query) => isCurrentAuthoritativePlexEvidence(query.data?.evidence))
			? summaries[0]
			: undefined);
	const refetch = async () => {
		if (!hasPlex) return;
		await Promise.all([
			...enrichmentQueries.map((query) => query.refetch()),
			identityQuery.refetch(),
		]);
	};

	return {
		plexUrlMap,
		invalidLinkItemCount: enrichable.invalidLinkItemCount,
		error,
		evidence,
		pendingBatchCount,
		refetch,
	};
};
