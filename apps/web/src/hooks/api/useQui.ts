"use client";

import type {
	CrossSeedDiscoveryResponse,
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
	fetchLibrarySeedingSummary,
	fetchMovieTorrents,
	fetchQuiActionLog,
	fetchQuiActivityFeed,
	fetchQuiAttention,
	fetchQuiCapabilities,
	fetchQuiCategories,
	fetchQuiEventLog,
	fetchQuiFileMediaInfo,
	fetchQuiSummary,
	fetchQuiTags,
	fetchQuiTorrentFiles,
	fetchQuiTorrentProperties,
	fetchQuiWebhookConfig,
	fetchSeriesTorrents,
	fetchTrackerIcons,
	postQuiAddTrackers,
	postQuiBulkAction,
	postQuiEditTracker,
	postQuiRemoveTrackers,
	postQuiRenameTorrent,
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

// ── Detail-drawer hooks (Phase 6) — properties, files, rename, trackers ──

/**
 * Lazy-loaded extended properties for a single torrent. The cluster
 * panel only needs the lightweight `SeriesTorrentCopy` shape; the drawer
 * pulls these heavier fields (limits, save path, share-limit settings)
 * when the user opens it. Disabled until the drawer mounts to avoid
 * fetching on every cluster expansion.
 */
export const useQuiTorrentProperties = (args: {
	quiInstanceId: string | null;
	qbitInstanceId: number | null;
	hash: string;
	enabled?: boolean;
}) => {
	const { quiInstanceId, qbitInstanceId, hash, enabled = true } = args;
	return useQuery({
		queryKey: ["qui", "torrent-properties", quiInstanceId, qbitInstanceId, hash] as const,
		queryFn: () =>
			fetchQuiTorrentProperties({
				quiInstanceId: quiInstanceId!,
				qbitInstanceId: qbitInstanceId!,
				hash,
			}),
		enabled: enabled && quiInstanceId !== null && qbitInstanceId !== null,
		staleTime: POLLING_STANDARD,
	});
};

/**
 * Lazy-loaded file inventory. Larger payloads — only fetch when the
 * drawer's Files section is expanded.
 */
export const useQuiTorrentFiles = (args: {
	quiInstanceId: string | null;
	qbitInstanceId: number | null;
	hash: string;
	enabled?: boolean;
}) => {
	const { quiInstanceId, qbitInstanceId, hash, enabled = true } = args;
	return useQuery({
		queryKey: ["qui", "torrent-files", quiInstanceId, qbitInstanceId, hash] as const,
		queryFn: () =>
			fetchQuiTorrentFiles({
				quiInstanceId: quiInstanceId!,
				qbitInstanceId: qbitInstanceId!,
				hash,
			}),
		enabled: enabled && quiInstanceId !== null && qbitInstanceId !== null,
		staleTime: POLLING_STANDARD,
	});
};

/**
 * MediaInfo for one file inside a torrent. Lazy — pass `enabled: false`
 * until the operator actually opens a file's quality check. The report is
 * immutable for a given file (its bytes don't change), so cache for an hour.
 */
export const useQuiFileMediaInfo = (args: {
	quiInstanceId: string | null;
	qbitInstanceId: number | null;
	hash: string;
	fileIndex: number | null;
	enabled?: boolean;
}) => {
	const { quiInstanceId, qbitInstanceId, hash, fileIndex, enabled = true } = args;
	return useQuery({
		queryKey: ["qui", "file-mediainfo", quiInstanceId, qbitInstanceId, hash, fileIndex] as const,
		queryFn: () =>
			fetchQuiFileMediaInfo({
				quiInstanceId: quiInstanceId!,
				qbitInstanceId: qbitInstanceId!,
				hash,
				fileIndex: fileIndex!,
			}),
		enabled: enabled && quiInstanceId !== null && qbitInstanceId !== null && fileIndex !== null,
		staleTime: 60 * 60 * 1000,
		retry: false,
	});
};

/**
 * Rename a torrent. Invalidates torrent-state (which carries the name)
 * so the cluster panel re-renders with the new name without waiting
 * for the next polling tick.
 */
export const useQuiRenameTorrent = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (args: {
			quiInstanceId: string;
			qbitInstanceId: number;
			hash: string;
			name: string;
		}) => postQuiRenameTorrent(args),
		onSettled: () => {
			queryClient.invalidateQueries({ queryKey: ["qui", "torrent-state"] as const });
		},
	});
};

/**
 * Refresh the series/movie torrent panels after a tracker mutation so the
 * cluster cards' tracker pills (and a re-opened drawer) reflect the change.
 * The drawer's Trackers section updates optimistically from local state —
 * it renders `copy`, a frozen snapshot, so a query refetch can't reach it.
 */
const invalidateTorrentPanels = (queryClient: ReturnType<typeof useQueryClient>) => {
	queryClient.invalidateQueries({ queryKey: ["qui", "series-torrents"] });
	queryClient.invalidateQueries({ queryKey: ["qui", "movie-torrents"] });
};

/** Add tracker URLs to a torrent. */
export const useQuiAddTrackers = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (args: {
			quiInstanceId: string;
			qbitInstanceId: number;
			hash: string;
			urls: string[];
		}) => postQuiAddTrackers(args),
		onSettled: () => invalidateTorrentPanels(queryClient),
	});
};

/** Remove trackers by hostname (resolved to full URLs server-side). */
export const useQuiRemoveTrackers = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (args: {
			quiInstanceId: string;
			qbitInstanceId: number;
			hash: string;
			hostnames: string[];
		}) => postQuiRemoveTrackers(args),
		onSettled: () => invalidateTorrentPanels(queryClient),
	});
};

/** Replace a tracker — identified by hostname, swapped for a new full URL. */
export const useQuiEditTracker = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (args: {
			quiInstanceId: string;
			qbitInstanceId: number;
			hash: string;
			oldHostname: string;
			newURL: string;
		}) => postQuiEditTracker(args),
		onSettled: () => invalidateTorrentPanels(queryClient),
	});
};

/**
 * qBit categories on this instance, surfaced as drawer-picker suggestions.
 * 5-minute staleTime — categories change rarely, and the drawer can
 * reasonably trust a stale list (worst case the user types a new name
 * and it succeeds anyway).
 */
export const useQuiCategories = (args: {
	quiInstanceId: string | null;
	qbitInstanceId: number | null;
	enabled?: boolean;
}) => {
	const { quiInstanceId, qbitInstanceId, enabled = true } = args;
	return useQuery({
		queryKey: ["qui", "categories", quiInstanceId, qbitInstanceId] as const,
		queryFn: () =>
			fetchQuiCategories({ quiInstanceId: quiInstanceId!, qbitInstanceId: qbitInstanceId! }),
		enabled: enabled && quiInstanceId !== null && qbitInstanceId !== null,
		staleTime: 5 * 60 * 1000,
	});
};

/**
 * qBit tags on this instance. Same caching rationale as categories.
 */
export const useQuiTags = (args: {
	quiInstanceId: string | null;
	qbitInstanceId: number | null;
	enabled?: boolean;
}) => {
	const { quiInstanceId, qbitInstanceId, enabled = true } = args;
	return useQuery({
		queryKey: ["qui", "tags", quiInstanceId, qbitInstanceId] as const,
		queryFn: () => fetchQuiTags({ quiInstanceId: quiInstanceId!, qbitInstanceId: qbitInstanceId! }),
		enabled: enabled && quiInstanceId !== null && qbitInstanceId !== null,
		staleTime: 5 * 60 * 1000,
	});
};

/**
 * Per-instance qBittorrent feature-support flags. Capabilities change only
 * when the operator upgrades qBittorrent, so cache aggressively (5 min,
 * matching categories/tags).
 */
export const useQuiCapabilities = (args: {
	quiInstanceId: string | null;
	qbitInstanceId: number | null;
	enabled?: boolean;
}) => {
	const { quiInstanceId, qbitInstanceId, enabled = true } = args;
	return useQuery({
		queryKey: ["qui", "capabilities", quiInstanceId, qbitInstanceId] as const,
		queryFn: () =>
			fetchQuiCapabilities({ quiInstanceId: quiInstanceId!, qbitInstanceId: qbitInstanceId! }),
		enabled: enabled && quiInstanceId !== null && qbitInstanceId !== null,
		staleTime: 5 * 60 * 1000,
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
 * qui's per-user tracker-icon registry. Hostname → data URL.
 *
 * Cached server-side for 1h (the icons themselves rarely change) and
 * client-side via the long staleTime here. Failures gracefully return
 * an empty record so the brand pills fall back to text abbreviations
 * — never breaks the panel.
 */
export const useTrackerIcons = () => {
	return useQuery({
		queryKey: quiKeys.trackerIcons(),
		queryFn: fetchTrackerIcons,
		// 1 hour: matches the backend cache window. Icons are user-curated
		// per-tracker — they change when the user adds a new tracker or
		// uploads a custom icon, not on a per-minute basis.
		staleTime: 60 * 60 * 1000,
		// Don't refetch on focus — icons aren't volatile state.
		refetchOnWindowFocus: false,
		// Soft-fail: hooks render with empty data on error, no toast.
		retry: 1,
	});
};

/**
 * Per-library-page seeding summary. Caller passes the IDs of items
 * currently visible (or a whole page); the hook returns a map keyed by
 * `"${itemType}:${itemId}"` with `{trackerCount, topHosts, hashCount}`
 * per item.
 *
 * Cached server-side and client-side for 10 min — the underlying
 * inode-index and tracker-meta caches have their own longer TTLs;
 * this hook just aggregates. Disabled when the items list is empty
 * (avoids a no-op POST on initial mount before library data loads).
 */
export const useLibrarySeedingSummary = (args: {
	items: Array<{ arrInstanceId: string; itemId: number; itemType: "movie" | "series" }>;
	enabled?: boolean;
}) => {
	// Build a stable key for React Query caching — same items in any
	// order produce the same key, so list re-renders don't refire.
	// Includes instanceId so multi-instance setups don't collide.
	const itemKey = [...args.items]
		.map((i) => `${i.arrInstanceId}|${i.itemType}:${i.itemId}`)
		.sort()
		.join(",");
	return useQuery({
		queryKey: quiKeys.librarySeedingSummary("multi", itemKey),
		queryFn: () => fetchLibrarySeedingSummary({ items: args.items }),
		enabled: args.enabled !== false && args.items.length > 0,
		staleTime: 10 * 60 * 1000,
		refetchOnWindowFocus: false,
		retry: 1,
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
