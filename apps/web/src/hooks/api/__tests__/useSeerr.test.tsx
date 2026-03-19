import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import type { SeerrRequest, SeerrRequestCount, SeerrPageResult, LibraryEnrichmentResponse } from "@arr/shared";

// Mock the entire API client module
vi.mock("../../../lib/api-client/seerr");

// Import after mock declaration
import * as seerrApi from "../../../lib/api-client/seerr";
import {
	useSeerrRequests,
	useSeerrRequest,
	useSeerrRequestCount,
	useApproveSeerrRequest,
	useBulkSeerrRequestAction,
	useSeerrSearch,
	useSeerrDiscoverMovies,
	useSeerrGenres,
	useClearSeerrCache,
	useLibraryEnrichment,
} from "../useSeerr";

// ============================================================================
// Sample Data
// ============================================================================

const sampleRequest = {
	id: 1,
	status: 1,
	createdAt: "2024-01-01",
	updatedAt: "2024-01-01",
	type: "movie" as const,
	is4k: false,
	serverId: 1,
	profileId: 1,
	rootFolder: "/movies",
	media: { id: 1, tmdbId: 123, tvdbId: null, status: 1, mediaType: "movie" },
	requestedBy: { id: 1, displayName: "user" },
	modifiedBy: null,
	seasons: [],
} as unknown as SeerrRequest;

const samplePageResult: SeerrPageResult<SeerrRequest> = {
	pageInfo: { pages: 1, pageSize: 20, results: 1, page: 1 },
	results: [sampleRequest],
};

const sampleDiscoverResponse = {
	page: 1,
	totalPages: 5,
	totalResults: 100,
	results: [
		{
			id: 1,
			mediaType: "movie" as const,
			title: "The Matrix",
			posterPath: "/poster.jpg",
			voteAverage: 8.7,
		},
	],
};

// ============================================================================
// Wrapper Factory
// ============================================================================

function createWrapper() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, gcTime: 0 },
			mutations: { retry: false },
		},
	});
	return {
		wrapper: ({ children }: { children: ReactNode }) => (
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		),
		queryClient,
	};
}

// ============================================================================
// Reset mocks between tests
// ============================================================================

beforeEach(() => {
	vi.resetAllMocks();
});

// ============================================================================
// 1. useSeerrRequests
// ============================================================================

describe("useSeerrRequests", () => {
	it("fetches requests with correct params", async () => {
		vi.mocked(seerrApi.fetchSeerrRequests).mockResolvedValue(samplePageResult);

		const { wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useSeerrRequests({
					instanceId: "inst-1",
					filter: "pending",
					sort: "added",
					take: 20,
				}),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.fetchSeerrRequests).toHaveBeenCalledWith({
			instanceId: "inst-1",
			filter: "pending",
			sort: "added",
			take: 20,
		});
		expect(result.current.data).toEqual(samplePageResult);
	});

	it("is disabled when instanceId is empty", () => {
		const { wrapper } = createWrapper();
		const { result } = renderHook(
			() =>
				useSeerrRequests({
					instanceId: "",
					filter: "all" as const,
					sort: "added" as const,
				}),
			{ wrapper },
		);

		expect(result.current.fetchStatus).toBe("idle");
		expect(seerrApi.fetchSeerrRequests).not.toHaveBeenCalled();
	});

	it("returns correct data shape", async () => {
		vi.mocked(seerrApi.fetchSeerrRequests).mockResolvedValue(samplePageResult);

		const { wrapper } = createWrapper();
		const { result } = renderHook(
			() => useSeerrRequests({ instanceId: "inst-1" }),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(Array.isArray(result.current.data!.results)).toBe(true);
		expect(result.current.data!.pageInfo).toEqual(
			expect.objectContaining({
				pages: expect.any(Number),
				pageSize: expect.any(Number),
				results: expect.any(Number),
				page: expect.any(Number),
			}),
		);
	});
});

// ============================================================================
// 2. useSeerrRequest
// ============================================================================

describe("useSeerrRequest", () => {
	it("fetches a single request when enabled", async () => {
		vi.mocked(seerrApi.fetchSeerrRequest).mockResolvedValue(sampleRequest);

		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useSeerrRequest("inst-1", 42), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.fetchSeerrRequest).toHaveBeenCalledWith("inst-1", 42);
		expect(result.current.data).toEqual(sampleRequest);
	});

	it("is disabled when requestId is 0", () => {
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useSeerrRequest("inst-1", 0), {
			wrapper,
		});

		expect(result.current.fetchStatus).toBe("idle");
		expect(seerrApi.fetchSeerrRequest).not.toHaveBeenCalled();
	});
});

// ============================================================================
// 3. useSeerrRequestCount
// ============================================================================

describe("useSeerrRequestCount", () => {
	it("fetches count for a valid instanceId", async () => {
		const countResult: SeerrRequestCount = {
			total: 15,
			movie: 10,
			tv: 5,
			pending: 3,
			approved: 7,
			declined: 1,
			processing: 2,
			available: 2,
		};
		vi.mocked(seerrApi.fetchSeerrRequestCount).mockResolvedValue(countResult);

		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useSeerrRequestCount("inst-1"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.fetchSeerrRequestCount).toHaveBeenCalledWith("inst-1");
		expect(result.current.data).toEqual(countResult);
	});

	it("is disabled when instanceId is empty", () => {
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useSeerrRequestCount(""), {
			wrapper,
		});

		expect(result.current.fetchStatus).toBe("idle");
		expect(seerrApi.fetchSeerrRequestCount).not.toHaveBeenCalled();
	});
});

// ============================================================================
// 4. useApproveSeerrRequest
// ============================================================================

describe("useApproveSeerrRequest", () => {
	it("calls approveSeerrRequest with correct args on mutate", async () => {
		vi.mocked(seerrApi.approveSeerrRequest).mockResolvedValue(sampleRequest);

		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useApproveSeerrRequest(), { wrapper });

		await act(async () => {
			result.current.mutate({ instanceId: "inst-1", requestId: 1 });
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.approveSeerrRequest).toHaveBeenCalledWith("inst-1", 1);
	});

	it("invalidates request queries on success", async () => {
		vi.mocked(seerrApi.approveSeerrRequest).mockResolvedValue(sampleRequest);

		const { wrapper, queryClient } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useApproveSeerrRequest(), { wrapper });

		await act(async () => {
			result.current.mutate({ instanceId: "inst-1", requestId: 1 });
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ["seerr", "requests", "inst-1"],
			}),
		);
		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ["seerr", "request-count", "inst-1"],
			}),
		);
	});
});

// ============================================================================
// 5. useBulkSeerrRequestAction
// ============================================================================

describe("useBulkSeerrRequestAction", () => {
	it("calls bulkSeerrRequestAction with correct payload", async () => {
		const bulkResult = {
			results: [
				{ requestId: 1, success: true },
				{ requestId: 2, success: true },
				{ requestId: 3, success: true },
			],
			totalSuccess: 3,
			totalFailed: 0,
		};
		vi.mocked(seerrApi.bulkSeerrRequestAction).mockResolvedValue(bulkResult);

		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useBulkSeerrRequestAction(), {
			wrapper,
		});

		await act(async () => {
			result.current.mutate({
				instanceId: "inst-1",
				action: "approve",
				requestIds: [1, 2, 3],
			});
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.bulkSeerrRequestAction).toHaveBeenCalledWith(
			"inst-1",
			"approve",
			[1, 2, 3],
		);
		expect(result.current.data).toEqual(bulkResult);
	});

	it("invalidates request queries on success", async () => {
		vi.mocked(seerrApi.bulkSeerrRequestAction).mockResolvedValue({
			results: [],
			totalSuccess: 0,
			totalFailed: 0,
		});

		const { wrapper, queryClient } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useBulkSeerrRequestAction(), {
			wrapper,
		});

		await act(async () => {
			result.current.mutate({
				instanceId: "inst-1",
				action: "delete",
				requestIds: [1],
			});
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ["seerr", "requests", "inst-1"],
			}),
		);
	});
});

// ============================================================================
// 6. useSeerrSearch
// ============================================================================

describe("useSeerrSearch", () => {
	it("returns infinite query with search results", async () => {
		vi.mocked(seerrApi.fetchSeerrSearch).mockResolvedValue(
			sampleDiscoverResponse,
		);

		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useSeerrSearch("inst-1", "matrix"), {
			wrapper,
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.fetchSeerrSearch).toHaveBeenCalledWith(
			"inst-1",
			"matrix",
			1,
		);
		expect(result.current.data!.pages).toHaveLength(1);
		expect(result.current.data!.pages[0]).toEqual(sampleDiscoverResponse);
		expect(result.current.hasNextPage).toBe(true);
	});

	it("is disabled when query is empty string", () => {
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useSeerrSearch("inst-1", ""), {
			wrapper,
		});

		expect(result.current.fetchStatus).toBe("idle");
		expect(seerrApi.fetchSeerrSearch).not.toHaveBeenCalled();
	});
});

// ============================================================================
// 7. useSeerrDiscoverMovies
// ============================================================================

describe("useSeerrDiscoverMovies", () => {
	it("returns infinite query with pagination", async () => {
		vi.mocked(seerrApi.fetchSeerrDiscoverMovies).mockResolvedValue(
			sampleDiscoverResponse,
		);

		const { wrapper } = createWrapper();
		const { result } = renderHook(
			() => useSeerrDiscoverMovies("inst-1"),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.fetchSeerrDiscoverMovies).toHaveBeenCalledWith(
			"inst-1",
			1,
		);
		expect(result.current.data!.pages[0]!.results).toHaveLength(1);
		expect(result.current.hasNextPage).toBe(true);
	});

	it("is disabled when instanceId is empty", () => {
		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useSeerrDiscoverMovies(""), {
			wrapper,
		});

		expect(result.current.fetchStatus).toBe("idle");
		expect(seerrApi.fetchSeerrDiscoverMovies).not.toHaveBeenCalled();
	});
});

// ============================================================================
// 8. useSeerrGenres
// ============================================================================

describe("useSeerrGenres", () => {
	it("fetches genres for media type", async () => {
		const genres = [{ id: 28, name: "Action" }];
		vi.mocked(seerrApi.fetchSeerrGenres).mockResolvedValue(genres);

		const { wrapper } = createWrapper();
		const { result } = renderHook(
			() => useSeerrGenres("inst-1", "movie"),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.fetchSeerrGenres).toHaveBeenCalledWith("inst-1", "movie");
		expect(result.current.data).toEqual(genres);
	});
});

// ============================================================================
// 9. useClearSeerrCache
// ============================================================================

describe("useClearSeerrCache", () => {
	it("calls clearSeerrCache and returns cleared count", async () => {
		vi.mocked(seerrApi.clearSeerrCache).mockResolvedValue({ cleared: 3 });

		const { wrapper } = createWrapper();
		const { result } = renderHook(() => useClearSeerrCache(), { wrapper });

		await act(async () => {
			result.current.mutate({ instanceId: "inst-1" });
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.clearSeerrCache).toHaveBeenCalledWith("inst-1");
		expect(result.current.data).toEqual({ cleared: 3 });
	});

	it("invalidates discover and enrichment queries on success", async () => {
		vi.mocked(seerrApi.clearSeerrCache).mockResolvedValue({ cleared: 1 });

		const { wrapper, queryClient } = createWrapper();
		const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

		const { result } = renderHook(() => useClearSeerrCache(), { wrapper });

		await act(async () => {
			result.current.mutate({ instanceId: "inst-1" });
		});

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ["seerr", "discover"],
			}),
		);
		expect(invalidateSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				queryKey: ["seerr", "library-enrichment", "inst-1"],
			}),
		);
	});
});

// ============================================================================
// 10. useLibraryEnrichment
// ============================================================================

describe("useLibraryEnrichment", () => {
	it("fetches enrichment for items with tmdbIds", async () => {
		const enrichmentResponse: LibraryEnrichmentResponse = {
			items: {
				"movie:100": {
					voteAverage: 7.5,
					backdropPath: null,
					posterPath: "/poster.jpg",
					openIssueCount: 0,
				},
			},
		};
		vi.mocked(seerrApi.fetchLibraryEnrichment).mockResolvedValue(
			enrichmentResponse,
		);

		const items = [
			{
				id: "lib-1",
				title: "Test Movie",
				service: "radarr" as const,
				instanceId: "i-1",
				type: "movie" as const,
				remoteIds: { tmdbId: 100, imdbId: "tt123" },
				monitored: true,
				added: "2024-01-01",
				sizeOnDisk: 0,
				hasFile: false,
			},
			{
				id: "lib-2",
				title: "Test Series",
				service: "sonarr" as const,
				instanceId: "i-2",
				type: "series" as const,
				remoteIds: { tmdbId: 200, tvdbId: 999 },
				monitored: true,
				added: "2024-01-01",
				sizeOnDisk: 0,
				hasFile: false,
			},
		];

		const { wrapper } = createWrapper();
		const { result } = renderHook(
			() => useLibraryEnrichment("seerr-inst", items as any),
			{ wrapper },
		);

		await waitFor(() => expect(result.current.isSuccess).toBe(true));

		expect(seerrApi.fetchLibraryEnrichment).toHaveBeenCalledWith(
			"seerr-inst",
			[100, 200],
			["movie", "tv"],
		);
		expect(result.current.data).toEqual(enrichmentResponse);
	});

	it("is disabled when seerr instanceId is null", () => {
		const items = [
			{
				id: "lib-1",
				title: "Movie",
				service: "radarr" as const,
				instanceId: "i-1",
				type: "movie" as const,
				remoteIds: { tmdbId: 100 },
				monitored: true,
				added: "2024-01-01",
				sizeOnDisk: 0,
				hasFile: false,
			},
		];

		const { wrapper } = createWrapper();
		const { result } = renderHook(
			() => useLibraryEnrichment(null, items as any),
			{ wrapper },
		);

		expect(result.current.fetchStatus).toBe("idle");
		expect(seerrApi.fetchLibraryEnrichment).not.toHaveBeenCalled();
	});
});
