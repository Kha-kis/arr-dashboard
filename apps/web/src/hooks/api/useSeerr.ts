"use client";

/**
 * React Query hooks for Seerr integration
 */

import type {
	LibraryEnrichmentResponse,
	LibraryItem,
	SeerrCreateRequestPayload,
	SeerrCreateRequestResponse,
	SeerrDiscoverResponse,
	SeerrGenre,
	SeerrIssue,
	SeerrIssueComment,
	SeerrMovieDetails,
	SeerrNotificationAgent,
	SeerrPageResult,
	SeerrQuota,
	SeerrRequest,
	SeerrRequestCount,
	SeerrRequestOptions,
	SeerrStatus,
	SeerrTvDetails,
	SeerrUser,
} from "@arr/shared";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
	addSeerrIssueComment,
	approveSeerrRequest,
	type BulkRequestResult,
	bulkSeerrRequestAction,
	createSeerrRequest,
	declineSeerrRequest,
	deleteSeerrRequest,
	type FetchSeerrIssuesParams,
	type FetchSeerrRequestsParams,
	type FetchSeerrUsersParams,
	fetchLibraryEnrichment,
	fetchSeerrDiscoverByGenre,
	fetchSeerrDiscoverMovies,
	fetchSeerrDiscoverMoviesUpcoming,
	fetchSeerrDiscoverTrending,
	fetchSeerrDiscoverTv,
	fetchSeerrDiscoverTvUpcoming,
	clearSeerrCache,
	fetchSeerrAuditLog,
	fetchSeerrGenres,
	type SeerrAuditLogEntry,
	type SeerrHealthResponse,
	fetchSeerrHealth,
	fetchSeerrIssues,
	fetchSeerrMovieDetails,
	fetchSeerrNotifications,
	fetchSeerrRequest,
	fetchSeerrRequestCount,
	fetchSeerrRequestOptions,
	fetchSeerrRequests,
	fetchSeerrSearch,
	fetchSeerrStatus,
	fetchSeerrTvDetails,
	fetchSeerrUserQuota,
	fetchSeerrUsers,
	retrySeerrRequest,
	testSeerrNotification,
	type UpdateSeerrUserPayload,
	updateSeerrIssueStatus,
	updateSeerrNotification,
	updateSeerrUser,
} from "../../lib/api-client/seerr";

// ============================================================================
// Query Keys
// ============================================================================

const seerrKeys = {
	all: ["seerr"] as const,
	requests: (instanceId: string, params?: Omit<FetchSeerrRequestsParams, "instanceId">) =>
		["seerr", "requests", instanceId, params] as const,
	request: (instanceId: string, requestId: number) =>
		["seerr", "request", instanceId, requestId] as const,
	requestCount: (instanceId: string) => ["seerr", "request-count", instanceId] as const,
	users: (instanceId: string, params?: Omit<FetchSeerrUsersParams, "instanceId">) =>
		["seerr", "users", instanceId, params] as const,
	userQuota: (instanceId: string, userId: number) =>
		["seerr", "user-quota", instanceId, userId] as const,
	issues: (instanceId: string, params?: Omit<FetchSeerrIssuesParams, "instanceId">) =>
		["seerr", "issues", instanceId, params] as const,
	notifications: (instanceId: string) => ["seerr", "notifications", instanceId] as const,
	status: (instanceId: string) => ["seerr", "status", instanceId] as const,
	health: (instanceId: string) => ["seerr", "health", instanceId] as const,
	audit: (instanceId: string) => ["seerr", "audit", instanceId] as const,
	// Discover
	libraryEnrichment: (instanceId: string, tmdbIdKey: string) =>
		["seerr", "library-enrichment", instanceId, tmdbIdKey] as const,
	discover: {
		all: ["seerr", "discover"] as const,
		movies: (instanceId: string) => ["seerr", "discover", "movies", instanceId] as const,
		tv: (instanceId: string) => ["seerr", "discover", "tv", instanceId] as const,
		trending: (instanceId: string) => ["seerr", "discover", "trending", instanceId] as const,
		moviesUpcoming: (instanceId: string) =>
			["seerr", "discover", "movies-upcoming", instanceId] as const,
		tvUpcoming: (instanceId: string) => ["seerr", "discover", "tv-upcoming", instanceId] as const,
		search: (instanceId: string, query: string) =>
			["seerr", "discover", "search", instanceId, query] as const,
		movieDetails: (instanceId: string, tmdbId: number) =>
			["seerr", "discover", "movie", instanceId, tmdbId] as const,
		tvDetails: (instanceId: string, tmdbId: number) =>
			["seerr", "discover", "tv-details", instanceId, tmdbId] as const,
		genres: (instanceId: string, mediaType: "movie" | "tv") =>
			["seerr", "discover", "genres", instanceId, mediaType] as const,
		requestOptions: (instanceId: string, mediaType: "movie" | "tv") =>
			["seerr", "discover", "request-options", instanceId, mediaType] as const,
		byGenre: (instanceId: string, mediaType: "movie" | "tv", genreId: number) =>
			["seerr", "discover", "genre", instanceId, mediaType, genreId] as const,
	},
};

// ============================================================================
// Request Hooks
// ============================================================================

export const useSeerrRequests = (params: FetchSeerrRequestsParams) =>
	useQuery<SeerrPageResult<SeerrRequest>>({
		queryKey: seerrKeys.requests(params.instanceId, params),
		queryFn: () => fetchSeerrRequests(params),
		refetchInterval: 30_000,
		enabled: !!params.instanceId,
	});

export const useSeerrRequest = (instanceId: string, requestId: number) =>
	useQuery<SeerrRequest>({
		queryKey: seerrKeys.request(instanceId, requestId),
		queryFn: () => fetchSeerrRequest(instanceId, requestId),
		staleTime: 30_000,
		enabled: !!instanceId && requestId > 0,
	});

export const useSeerrRequestCount = (instanceId: string) =>
	useQuery<SeerrRequestCount>({
		queryKey: seerrKeys.requestCount(instanceId),
		queryFn: () => fetchSeerrRequestCount(instanceId),
		refetchInterval: 30_000,
		enabled: !!instanceId,
	});

export const useApproveSeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<SeerrRequest, Error, { instanceId: string; requestId: number }>({
		mutationFn: ({ instanceId, requestId }) => approveSeerrRequest(instanceId, requestId),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

export const useDeclineSeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<SeerrRequest, Error, { instanceId: string; requestId: number }>({
		mutationFn: ({ instanceId, requestId }) => declineSeerrRequest(instanceId, requestId),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

export const useDeleteSeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<void, Error, { instanceId: string; requestId: number }>({
		mutationFn: ({ instanceId, requestId }) => deleteSeerrRequest(instanceId, requestId),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

export const useBulkSeerrRequestAction = () => {
	const queryClient = useQueryClient();
	return useMutation<
		BulkRequestResult,
		Error,
		{ instanceId: string; action: "approve" | "decline" | "delete"; requestIds: number[] }
	>({
		mutationFn: ({ instanceId, action, requestIds }) =>
			bulkSeerrRequestAction(instanceId, action, requestIds),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

export const useRetrySeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<SeerrRequest, Error, { instanceId: string; requestId: number }>({
		mutationFn: ({ instanceId, requestId }) => retrySeerrRequest(instanceId, requestId),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

// ============================================================================
// User Hooks
// ============================================================================

export const useSeerrUsers = (params: FetchSeerrUsersParams) =>
	useQuery<SeerrPageResult<SeerrUser>>({
		queryKey: seerrKeys.users(params.instanceId, params),
		queryFn: () => fetchSeerrUsers(params),
		refetchInterval: 60_000,
		enabled: !!params.instanceId,
	});

export const useSeerrUserQuota = (instanceId: string, userId: number) =>
	useQuery<SeerrQuota>({
		queryKey: seerrKeys.userQuota(instanceId, userId),
		queryFn: () => fetchSeerrUserQuota(instanceId, userId),
		refetchInterval: 60_000,
		enabled: !!instanceId && !!userId,
	});

export const useUpdateSeerrUser = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrUser,
		Error,
		{ instanceId: string; seerrUserId: number; data: UpdateSeerrUserPayload }
	>({
		mutationFn: ({ instanceId, seerrUserId, data }) =>
			updateSeerrUser(instanceId, seerrUserId, data),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "users", instanceId] });
			queryClient.invalidateQueries({ queryKey: ["seerr", "user-quota", instanceId] });
		},
	});
};

// ============================================================================
// Issue Hooks
// ============================================================================

export const useSeerrIssues = (params: FetchSeerrIssuesParams) =>
	useQuery<SeerrPageResult<SeerrIssue>>({
		queryKey: seerrKeys.issues(params.instanceId, params),
		queryFn: () => fetchSeerrIssues(params),
		refetchInterval: 60_000,
		enabled: !!params.instanceId,
	});

export const useAddSeerrIssueComment = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrIssueComment,
		Error,
		{ instanceId: string; issueId: number; message: string }
	>({
		mutationFn: ({ instanceId, issueId, message }) =>
			addSeerrIssueComment(instanceId, issueId, message),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "issues", instanceId] });
		},
	});
};

export const useUpdateSeerrIssueStatus = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrIssue,
		Error,
		{ instanceId: string; issueId: number; status: "open" | "resolved" }
	>({
		mutationFn: ({ instanceId, issueId, status }) =>
			updateSeerrIssueStatus(instanceId, issueId, status),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: ["seerr", "issues", instanceId] });
		},
	});
};

// ============================================================================
// Notification Hooks
// ============================================================================

export const useSeerrNotifications = (instanceId: string) =>
	useQuery<{ agents: SeerrNotificationAgent[] }>({
		queryKey: seerrKeys.notifications(instanceId),
		queryFn: () => fetchSeerrNotifications(instanceId),
		refetchInterval: 5 * 60_000,
		enabled: !!instanceId,
	});

export const useUpdateSeerrNotification = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrNotificationAgent,
		Error,
		{ instanceId: string; agentId: string; config: Partial<SeerrNotificationAgent> }
	>({
		mutationFn: ({ instanceId, agentId, config }) =>
			updateSeerrNotification(instanceId, agentId, config),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: seerrKeys.notifications(instanceId) });
		},
	});
};

export const useTestSeerrNotification = () =>
	useMutation<void, Error, { instanceId: string; agentId: string }>({
		mutationFn: ({ instanceId, agentId }) => testSeerrNotification(instanceId, agentId),
	});

// ============================================================================
// Status Hook
// ============================================================================

export const useSeerrStatus = (instanceId: string) =>
	useQuery<SeerrStatus>({
		queryKey: seerrKeys.status(instanceId),
		queryFn: () => fetchSeerrStatus(instanceId),
		refetchInterval: 5 * 60_000,
		enabled: !!instanceId,
	});

// ============================================================================
// Health Hook
// ============================================================================

export const useSeerrHealth = (instanceId: string) =>
	useQuery<SeerrHealthResponse>({
		queryKey: seerrKeys.health(instanceId),
		queryFn: () => fetchSeerrHealth(instanceId),
		refetchInterval: 5 * 60_000,
		enabled: !!instanceId,
		throwOnError: false,
	});

// ============================================================================
// Audit Log Hook
// ============================================================================

export const useClearSeerrCache = () => {
	const queryClient = useQueryClient();
	return useMutation<{ cleared: number }, Error, { instanceId: string }>({
		mutationFn: ({ instanceId }) => clearSeerrCache(instanceId),
		onSuccess: (_, { instanceId }) => {
			// Invalidate discover queries so they refetch with fresh server-side cache
			queryClient.invalidateQueries({ queryKey: ["seerr", "discover"] });
			queryClient.invalidateQueries({ queryKey: ["seerr", "library-enrichment", instanceId] });
		},
	});
};

export const useSeerrAuditLog = (instanceId: string) =>
	useQuery<SeerrAuditLogEntry[]>({
		queryKey: seerrKeys.audit(instanceId),
		queryFn: () => fetchSeerrAuditLog(instanceId),
		refetchInterval: 30_000,
		enabled: !!instanceId,
	});

// ============================================================================
// Discover Hooks
// ============================================================================

const DISCOVER_STALE_TIME = 5 * 60_000;

const discoverInfiniteOptions = (
	queryKey: readonly unknown[],
	fetchFn: (page: number) => Promise<SeerrDiscoverResponse>,
	enabled: boolean,
) => ({
	queryKey,
	queryFn: ({ pageParam }: { pageParam: number }) => fetchFn(pageParam),
	initialPageParam: 1,
	getNextPageParam: (last: SeerrDiscoverResponse) =>
		last.page < last.totalPages ? last.page + 1 : undefined,
	staleTime: DISCOVER_STALE_TIME,
	enabled,
});

export const useSeerrDiscoverMovies = (instanceId: string) =>
	useInfiniteQuery(
		discoverInfiniteOptions(
			seerrKeys.discover.movies(instanceId),
			(page) => fetchSeerrDiscoverMovies(instanceId, page),
			!!instanceId,
		),
	);

export const useSeerrDiscoverTv = (instanceId: string) =>
	useInfiniteQuery(
		discoverInfiniteOptions(
			seerrKeys.discover.tv(instanceId),
			(page) => fetchSeerrDiscoverTv(instanceId, page),
			!!instanceId,
		),
	);

export const useSeerrDiscoverTrending = (instanceId: string) =>
	useInfiniteQuery(
		discoverInfiniteOptions(
			seerrKeys.discover.trending(instanceId),
			(page) => fetchSeerrDiscoverTrending(instanceId, page),
			!!instanceId,
		),
	);

export const useSeerrDiscoverMoviesUpcoming = (instanceId: string) =>
	useInfiniteQuery(
		discoverInfiniteOptions(
			seerrKeys.discover.moviesUpcoming(instanceId),
			(page) => fetchSeerrDiscoverMoviesUpcoming(instanceId, page),
			!!instanceId,
		),
	);

export const useSeerrDiscoverTvUpcoming = (instanceId: string) =>
	useInfiniteQuery(
		discoverInfiniteOptions(
			seerrKeys.discover.tvUpcoming(instanceId),
			(page) => fetchSeerrDiscoverTvUpcoming(instanceId, page),
			!!instanceId,
		),
	);

export const useSeerrSearch = (instanceId: string, query: string) =>
	useInfiniteQuery(
		discoverInfiniteOptions(
			seerrKeys.discover.search(instanceId, query),
			(page) => fetchSeerrSearch(instanceId, query, page),
			!!instanceId && query.length > 0,
		),
	);

export const useSeerrMovieDetails = (instanceId: string, tmdbId: number) =>
	useQuery<SeerrMovieDetails>({
		queryKey: seerrKeys.discover.movieDetails(instanceId, tmdbId),
		queryFn: () => fetchSeerrMovieDetails(instanceId, tmdbId),
		staleTime: DISCOVER_STALE_TIME,
		enabled: !!instanceId && tmdbId > 0,
	});

export const useSeerrTvDetails = (instanceId: string, tmdbId: number) =>
	useQuery<SeerrTvDetails>({
		queryKey: seerrKeys.discover.tvDetails(instanceId, tmdbId),
		queryFn: () => fetchSeerrTvDetails(instanceId, tmdbId),
		staleTime: DISCOVER_STALE_TIME,
		enabled: !!instanceId && tmdbId > 0,
	});

export const useSeerrGenres = (instanceId: string, mediaType: "movie" | "tv") =>
	useQuery<SeerrGenre[]>({
		queryKey: seerrKeys.discover.genres(instanceId, mediaType),
		queryFn: () => fetchSeerrGenres(instanceId, mediaType),
		staleTime: 60 * 60_000,
		enabled: !!instanceId,
	});

export const useSeerrDiscoverByGenre = (
	instanceId: string,
	mediaType: "movie" | "tv",
	genreId: number,
) =>
	useInfiniteQuery(
		discoverInfiniteOptions(
			seerrKeys.discover.byGenre(instanceId, mediaType, genreId),
			(page) => fetchSeerrDiscoverByGenre(instanceId, mediaType, genreId, page),
			!!instanceId && genreId > 0,
		),
	);

export const useSeerrRequestOptions = (instanceId: string, mediaType: "movie" | "tv") =>
	useQuery<SeerrRequestOptions>({
		queryKey: seerrKeys.discover.requestOptions(instanceId, mediaType),
		queryFn: () => fetchSeerrRequestOptions(instanceId, mediaType),
		staleTime: 5 * 60_000,
		enabled: !!instanceId,
	});

export const useCreateSeerrRequest = () => {
	const queryClient = useQueryClient();
	return useMutation<
		SeerrCreateRequestResponse,
		Error,
		{ instanceId: string; payload: SeerrCreateRequestPayload }
	>({
		mutationFn: ({ instanceId, payload }) => createSeerrRequest(instanceId, payload),
		onSuccess: (_, { instanceId }) => {
			queryClient.invalidateQueries({ queryKey: seerrKeys.discover.all });
			queryClient.invalidateQueries({ queryKey: ["seerr", "requests", instanceId] });
			queryClient.invalidateQueries({ queryKey: seerrKeys.requestCount(instanceId) });
		},
	});
};

// ============================================================================
// Library Enrichment Hook
// ============================================================================

/**
 * Fetches TMDB ratings + open issue counts for a page of library items.
 * Only fires when a Seerr instance is available and there are enrichable items
 * (movie/series with tmdbId).
 */
export const useLibraryEnrichment = (
	seerrInstanceId: string | null | undefined,
	items: LibraryItem[],
) => {
	// Extract enrichable items (movie/series with tmdbId)
	const enrichable = useMemo(() => {
		if (!seerrInstanceId || items.length === 0) return { tmdbIds: [], types: [], key: "" };

		const tmdbIds: number[] = [];
		const types: ("movie" | "tv")[] = [];

		for (const item of items) {
			if ((item.service === "sonarr" || item.service === "radarr") && item.remoteIds?.tmdbId) {
				tmdbIds.push(item.remoteIds.tmdbId);
				types.push(item.type === "movie" ? "movie" : "tv");
			}
		}

		// Stable key for query deduplication — includes types so movie/tv with same ID don't collide
		const key = tmdbIds.map((id, i) => `${types[i]}:${id}`).join(",");
		return { tmdbIds, types, key };
	}, [seerrInstanceId, items]);

	return useQuery<LibraryEnrichmentResponse>({
		queryKey: seerrKeys.libraryEnrichment(seerrInstanceId ?? "", enrichable.key),
		queryFn: () => fetchLibraryEnrichment(seerrInstanceId!, enrichable.tmdbIds, enrichable.types),
		staleTime: 5 * 60_000,
		enabled: !!seerrInstanceId && enrichable.tmdbIds.length > 0,
	});
};
