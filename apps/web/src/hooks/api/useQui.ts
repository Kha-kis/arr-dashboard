"use client";

import type {
	CrossSeedDiscoveryResponse,
	LibraryItemType,
	QuiActionLogResponse,
	QuiActivityFeedResponse,
	QuiAttentionResponse,
	QuiEventLogResponse,
	QuiSummaryResponse,
} from "@arr/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
	type BulkTorrentActionArgs,
	fetchCrossSeedAvailability,
	fetchCrossSeedDiscoveryBatch,
	fetchMovieTorrents,
	fetchQuiActionLog,
	fetchQuiActivityFeed,
	fetchQuiAttention,
	fetchQuiEventLog,
	fetchQuiSummary,
	fetchQuiWebhookConfig,
	fetchSeriesTorrents,
	fetchTorrentState,
	postQuiBulkAction,
	postQuiTorrentAction,
	type QuiActionLogParams,
	type QuiDirScanTriggerResult,
	type QuiEventLogParams,
	type RegisterQuiWebhookArgs,
	registerQuiWebhook,
	rotateQuiWebhookSecret,
	type SeriesTorrentsResponse,
	type SingleTorrentActionArgs,
	triggerQuiCrossSeedSearch,
} from "../../lib/api-client/qui";
import { POLLING_ACTIVE, POLLING_BACKGROUND, POLLING_STANDARD } from "../../lib/polling-intervals";
import { quiKeys } from "../../lib/query-keys";

export interface UseTorrentStateArgs {
	arrInstanceId: string;
	arrItemId: number;
	itemType: LibraryItemType;
	enabled?: boolean;
}

/**
 * Fetches torrent state for a single library item via the qui integration.
 * The backend handles all the wiring: cache lookup, lazy *arr-history backfill
 * for the infoHash, qui torrent + cross-seed lookup. The hook is just a thin
 * React Query wrapper.
 *
 * Used by the deep `TorrentHealthPanel` modal — single-item, on-demand.
 * The previous batch variant has been retired: per-card data now ships
 * inside the page-level `/library` response (`LibraryItem.torrentState` /
 * `torrentRatio`), so the badge no longer needs to poll per item.
 */
export const useTorrentState = ({
	arrInstanceId,
	arrItemId,
	itemType,
	enabled = true,
}: UseTorrentStateArgs) => {
	return useQuery({
		queryKey: quiKeys.torrentState(arrInstanceId, arrItemId, itemType),
		queryFn: () => fetchTorrentState({ arrInstanceId, arrItemId, itemType }),
		enabled: enabled && Boolean(arrInstanceId) && Number.isFinite(arrItemId),
		staleTime: POLLING_ACTIVE,
		refetchInterval: POLLING_ACTIVE,
	});
};

/**
 * Probe for the Cross-Seed Discovery page (Phase 3.1). Returns whether the
 * user has qui configured AND has at least one correlated library item to
 * scan. Drives the page's empty-state copy before any expensive scan call.
 */
export const useCrossSeedAvailability = (enabled: boolean = true) => {
	return useQuery({
		queryKey: quiKeys.crossSeedAvailability(),
		queryFn: fetchCrossSeedAvailability,
		enabled,
		staleTime: POLLING_BACKGROUND,
	});
};

/**
 * Infinite-scroll discovery scan for the Cross-Seed page. Each fetch hits
 * the backend for ~one batch of LibraryCache rows; React Query stitches
 * batches via `nextCursor`. Stops automatically when the backend reports
 * `exhausted: true`.
 */
export const useCrossSeedDiscovery = (enabled: boolean = true, batchSize: number = 100) => {
	return useInfiniteQuery<CrossSeedDiscoveryResponse>({
		queryKey: [...quiKeys.crossSeedDiscovery(), batchSize] as const,
		queryFn: ({ pageParam }) =>
			fetchCrossSeedDiscoveryBatch({
				cursor: typeof pageParam === "string" ? pageParam : null,
				batchSize,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => (lastPage.exhausted ? undefined : lastPage.nextCursor),
		enabled,
		// Cross-seed siblings change with user actions in qui, but we don't
		// auto-refresh during an active scan — operators have a manual rescan
		// button. Long staleTime keeps the cached scan stable across nav.
		staleTime: POLLING_BACKGROUND,
	});
};

/**
 * Infinite-scroll qui Activity feed (Phase 3.2). Each fetch returns a page
 * of recent events; React Query stitches pages via `nextCursor`. Optional
 * `eventType` filter narrows to a single emitter category.
 */
export const useQuiActivityFeed = (eventType?: string, limit: number = 50) => {
	return useInfiniteQuery<QuiActivityFeedResponse>({
		queryKey: [...quiKeys.activity(eventType), limit] as const,
		queryFn: ({ pageParam }) =>
			fetchQuiActivityFeed({
				cursor: typeof pageParam === "string" ? pageParam : null,
				limit,
				eventType,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		// Refresh on focus so operators returning to the page see new events.
		staleTime: POLLING_BACKGROUND,
	});
};

// ── Phase 4 — action mutations + audit log feed ────────────────────────

/**
 * Infinite-scroll feed of arr-dashboard-initiated qui mutations (Phase 4.1).
 * Backs the "My Actions" tab — separate from `useQuiActivityFeed` because
 * the two surfaces have different invalidation rules: the activity feed
 * updates from background schedulers, while the action log only changes
 * when the operator triggers a mutation through arr-dashboard.
 */
export const useQuiActionLog = (filters: Omit<QuiActionLogParams, "cursor"> = {}) => {
	const { action, status, limit = 50 } = filters;
	return useInfiniteQuery<QuiActionLogResponse>({
		queryKey: [...quiKeys.actions(action, status), limit] as const,
		queryFn: ({ pageParam }) =>
			fetchQuiActionLog({
				cursor: typeof pageParam === "string" ? pageParam : null,
				limit,
				action,
				status,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		staleTime: POLLING_BACKGROUND,
	});
};

/**
 * Single-torrent mutation hook (Phase 4.1). On success invalidates the
 * action log so the new row appears immediately, plus the per-item
 * torrent-state query so the badge re-renders with qui's new state.
 */
export const useQuiTorrentAction = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (args: SingleTorrentActionArgs) => postQuiTorrentAction(args),
		// `onSettled` (not `onSuccess`) — the audit log records failures too,
		// so the My Actions tab must refresh on the failed-mutation path or
		// the new `failed` row stays invisible. The torrent-state cache also
		// needs invalidation on failure: if qui rejected the call because the
		// torrent disappeared from qui, the dashboard's cached state is stale
		// in a different way and a refetch corrects it.
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: quiKeys.actions() });
			queryClient.invalidateQueries({
				queryKey: ["qui", "torrent-state"] satisfies readonly string[],
			});
		},
	});
};

/**
 * Bulk-mutation hook (Phase 4.2). Same invalidation semantics as the
 * single-torrent variant — the action log refreshes and any open
 * torrent-state queries re-fetch. Cross-seed invalidates too because a
 * successful bulk mutation can promote/demote torrents in the
 * "siblings" view.
 */
export const useQuiBulkAction = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (args: BulkTorrentActionArgs) => postQuiBulkAction(args),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: quiKeys.actions() });
			queryClient.invalidateQueries({
				queryKey: ["qui", "torrent-state"] satisfies readonly string[],
			});
			queryClient.invalidateQueries({
				queryKey: ["qui", "cross-seed"] satisfies readonly string[],
			});
		},
	});
};

// ── Phase 5 — webhook config + event log + SSE stream ──────────────────

/**
 * Fetch the per-user qui webhook config (whether a secret exists +
 * the URL to paste into qui's notification target). The plaintext secret
 * is *never* returned by GET — only by rotate. The frontend keeps the
 * rotation-time secret in component state until the user navigates away.
 */
export const useQuiWebhookConfig = () => {
	return useQuery({
		queryKey: quiKeys.webhookConfig,
		queryFn: fetchQuiWebhookConfig,
	});
};

/**
 * Rotate the qui webhook secret. On success the query cache is updated
 * with the plaintext secret so subsequent reads of `useQuiWebhookConfig`
 * inside the same component render see it — but the data does not
 * persist past a page reload (the API only returns the plaintext at
 * rotation time).
 */
export const useRotateQuiWebhookSecret = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: rotateQuiWebhookSecret,
		onSuccess: (next) => {
			queryClient.setQueryData(quiKeys.webhookConfig, next);
		},
	});
};

/**
 * Auto-register a NotificationTarget in qui pointing at this dashboard's
 * webhook receiver. Caller supplies the plaintext secret obtained from
 * a recent rotate response — we never store plaintext on the server, so
 * this is the only way to push registration through programmatically.
 */
export const useRegisterQuiWebhook = () => {
	return useMutation({
		mutationFn: (args: RegisterQuiWebhookArgs) => registerQuiWebhook(args),
	});
};

/**
 * Ask qui to search for a cross-seed of a stuck library item. The
 * mutation hangs until qui has queued the scan (typically <1s — qui
 * returns the runId as soon as the scan is accepted, then continues
 * the actual indexer search asynchronously in the background).
 *
 * Successful match → qui injects the .torrent against the existing
 * file → arr-dashboard's next inode-backfill sweep correlates it.
 * That delay window is up to 6 hours by default; the user can hit
 * "Run correlation now" from /qui to short-circuit it.
 */
/**
 * Per-series torrent + correlation aggregate. Powers the
 * SeriesTorrentsPanel in the library detail modal: total episode files,
 * how many are correlated, list of distinct torrents covering them.
 *
 * Refetches on focus + after a cross-seed search mutation invalidates
 * (qui injects a torrent → our backfill correlates new episodes → this
 * query reflects the new state).
 */
export const useSeriesTorrents = (args: {
	arrInstanceId: string;
	arrItemId: number;
	enabled?: boolean;
}) => {
	return useQuery<SeriesTorrentsResponse>({
		queryKey: quiKeys.seriesTorrents(args.arrInstanceId, args.arrItemId),
		queryFn: () =>
			fetchSeriesTorrents({
				arrInstanceId: args.arrInstanceId,
				arrItemId: args.arrItemId,
			}),
		enabled: args.enabled !== false,
		// Episode correlation state changes slowly (only on backfill
		// scheduler ticks or after a manual cross-seed trigger). Polling
		// in the background would just hammer the server.
		refetchOnWindowFocus: true,
		staleTime: POLLING_STANDARD,
	});
};

/**
 * Per-movie torrent panel data. Same wire shape as `useSeriesTorrents`
 * with `seasonGroups: []` and `clusters: [oneOrZero]`. The shared
 * LibraryItemTorrentsPanel renders both responses; the empty
 * seasonGroups signals "render flat" instead of season-grouped.
 */
export const useMovieTorrents = (args: {
	arrInstanceId: string;
	arrItemId: number;
	enabled?: boolean;
}) => {
	return useQuery<SeriesTorrentsResponse>({
		queryKey: quiKeys.movieTorrents(args.arrInstanceId, args.arrItemId),
		queryFn: () =>
			fetchMovieTorrents({
				arrInstanceId: args.arrInstanceId,
				arrItemId: args.arrItemId,
			}),
		enabled: args.enabled !== false,
		refetchOnWindowFocus: true,
		staleTime: POLLING_STANDARD,
	});
};

export const useTriggerQuiCrossSeedSearch = () => {
	return useMutation<
		QuiDirScanTriggerResult,
		Error,
		{
			arrInstanceId: string;
			arrItemId: number;
			itemType: "movie" | "series" | "artist" | "author";
			quiInstanceId?: string;
		}
	>({
		mutationFn: (args) => triggerQuiCrossSeedSearch(args),
	});
};

/**
 * Infinite-scroll feed of inbound webhook events from qui. Distinct from
 * the activity feed (scheduler-emitted) and the action log (operator-
 * initiated). Updated in two ways:
 *   1. Polling on focus via React Query staleness.
 *   2. SSE pushes via `useQuiEventStream` invalidate this key.
 */
export const useQuiEventLog = (params: Omit<QuiEventLogParams, "cursor"> = {}) => {
	const { limit = 50 } = params;
	return useInfiniteQuery<QuiEventLogResponse>({
		queryKey: [...quiKeys.events, limit] as const,
		queryFn: ({ pageParam }) =>
			fetchQuiEventLog({
				cursor: typeof pageParam === "string" ? pageParam : null,
				limit,
			}),
		initialPageParam: null as string | null,
		getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
		staleTime: POLLING_BACKGROUND,
	});
};

export type QuiEventStreamStatus = "connecting" | "open" | "offline";

/**
 * Phase 5.2 — server-sent-events consumer for inbound qui webhook events.
 *
 * Opens an EventSource against the backend SSE route as soon as the
 * component mounts; cleans up on unmount. Each `qui-event` frame
 * triggers React Query invalidations on:
 *   - the qui event log (so the My Events tab shows the new row)
 *   - any open torrent-state queries (so badges reflect qui's new state)
 *   - cross-seed (so newly-completed torrents surface as siblings)
 *
 * Why invalidate instead of writing the event into the cache directly:
 * the inbound SSE payload only carries `{id, type, torrentHash, receivedAt}`,
 * not the full QuiEventLogEntry shape — invalidate-and-refetch gets us
 * the canonical persisted shape on the next render without dual
 * serialization paths to maintain.
 *
 * Returned `streamStatus` lets the consumer surface a "Live channel offline"
 * badge so the operator can tell when the dashboard is running on its
 * polling fallback rather than push freshness. Without this signal a 401
 * (session expired) or a downed API would leave the UI silently stale.
 *
 * `enabled` lets callers gate the connection (e.g., only open the stream
 * when the qui activity/events surface is mounted, not on every page).
 */
export const useQuiEventStream = ({ enabled = true }: { enabled?: boolean } = {}) => {
	const queryClient = useQueryClient();
	const [streamStatus, setStreamStatus] = useState<QuiEventStreamStatus>("connecting");

	useEffect(() => {
		if (!enabled) {
			setStreamStatus("offline");
			return;
		}
		// `credentials: include` is the EventSource default for same-origin;
		// the Next.js rewrite forwards the session cookie automatically.
		const source = new EventSource("/api/qui/events/stream", { withCredentials: true });
		const handleOpen = () => setStreamStatus("open");
		const handleEvent = () => {
			queryClient.invalidateQueries({ queryKey: quiKeys.events });
			queryClient.invalidateQueries({
				queryKey: ["qui", "torrent-state"] satisfies readonly string[],
			});
			queryClient.invalidateQueries({
				queryKey: ["qui", "cross-seed"] satisfies readonly string[],
			});
		};
		const handleError = () => {
			setStreamStatus("offline");
			// EventSource auto-retries with exponential backoff between attempts.
			// If the connection enters CLOSED (e.g., the server returned a 401
			// on a session-expired request, or the route is gone), there is no
			// retry — the source will never re-open. In that case we must call
			// close() explicitly to break the implicit retry loop AND drop the
			// listener; the consumer's status pill stays at "offline".
			if (source.readyState === EventSource.CLOSED) {
				source.close();
			}
		};
		source.addEventListener("open", handleOpen);
		source.addEventListener("qui-event", handleEvent);
		source.addEventListener("error", handleError);
		return () => {
			source.removeEventListener("open", handleOpen);
			source.removeEventListener("qui-event", handleEvent);
			source.removeEventListener("error", handleError);
			source.close();
		};
	}, [enabled, queryClient]);

	return { streamStatus };
};

// ── qui home page (Phase 6) ────────────────────────────────────────────

/**
 * KPI summary for the qui home page. Refresh cadence matches the
 * scheduled torrent-state-sync (10 min) — refreshing more aggressively
 * would burn qui API budget without changing the KPI numbers (qui's
 * state changes slowly relative to a single browser session).
 */
export const useQuiSummary = (options: { enabled?: boolean } = {}) => {
	return useQuery<QuiSummaryResponse>({
		queryKey: quiKeys.summary,
		queryFn: fetchQuiSummary,
		staleTime: POLLING_ACTIVE,
		refetchInterval: POLLING_STANDARD,
		enabled: options.enabled ?? true,
	});
};

/**
 * Needs Attention feed for the qui home page. Joined with library_cache
 * server-side so each row arrives with its *arr context (movie/series
 * title, instance label) pre-populated.
 */
export const useQuiAttention = (limit: number = 20, options: { enabled?: boolean } = {}) => {
	return useQuery<QuiAttentionResponse>({
		queryKey: quiKeys.attention(limit),
		queryFn: () => fetchQuiAttention({ limit }),
		staleTime: POLLING_ACTIVE,
		refetchInterval: POLLING_STANDARD,
		enabled: options.enabled ?? true,
	});
};
