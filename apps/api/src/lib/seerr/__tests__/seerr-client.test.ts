import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyBaseLogger } from "fastify";
import { SeerrClient } from "../seerr-client.js";
import { SeerrApiError } from "../../errors.js";
import { GENRE_TTL_MS, type SeerrCache } from "../seerr-cache.js";
import type { SeerrCircuitBreaker } from "../seerr-circuit-breaker.js";
import type { ArrClientFactory, ClientInstanceData } from "../../arr/client-factory.js";

// Mock retry to just call the function directly (no actual retry/delay)
vi.mock("../seerr-retry.js", () => ({
	withSeerrRetry: (fn: () => Promise<unknown>) => fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockResponse(data: unknown, status = 200): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		statusText: status === 200 ? "OK" : "Error",
		json: () => Promise.resolve(data),
		text: () => Promise.resolve(JSON.stringify(data)),
		headers: new Headers(),
	} as unknown as Response;
}

function makeRequest(overrides?: Record<string, unknown>) {
	return {
		id: 1,
		status: 1,
		createdAt: "2024-01-01T00:00:00Z",
		updatedAt: "2024-01-01T00:00:00Z",
		type: "movie",
		is4k: false,
		serverId: 1,
		profileId: 1,
		rootFolder: "/movies",
		media: {
			id: 1,
			tmdbId: 123,
			tvdbId: undefined,
			status: 1,
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z",
		},
		requestedBy: {
			id: 1,
			displayName: "user",
			createdAt: "2024-01-01T00:00:00Z",
			updatedAt: "2024-01-01T00:00:00Z",
			permissions: 0,
			requestCount: 0,
			userType: 1,
		},
		modifiedBy: undefined,
		seasons: [],
		...overrides,
	};
}

function makePageResult(results: unknown[] = [makeRequest()]) {
	return {
		pageInfo: { pages: 1, pageSize: 20, results: results.length, page: 1 },
		results,
	};
}

function makeRequestCount() {
	return {
		total: 10,
		movie: 5,
		tv: 3,
		pending: 2,
		approved: 4,
		declined: 1,
		processing: 0,
		available: 3,
	};
}

function makeDiscoverResponse() {
	return {
		page: 1,
		totalPages: 5,
		totalResults: 100,
		results: [
			{
				id: 550,
				mediaType: "movie" as const,
				title: "Fight Club",
				overview: "A ticking-Loss bomb.",
				posterPath: "/poster.jpg",
				voteAverage: 8.4,
			},
		],
	};
}

// ---------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------

let factory: { rawRequest: ReturnType<typeof vi.fn> };
let instance: ClientInstanceData;
let log: FastifyBaseLogger;
let circuitBreaker: {
	check: ReturnType<typeof vi.fn>;
	reportSuccess: ReturnType<typeof vi.fn>;
	reportFailure: ReturnType<typeof vi.fn>;
};
let cache: {
	get: ReturnType<typeof vi.fn>;
	set: ReturnType<typeof vi.fn>;
	invalidate: ReturnType<typeof vi.fn>;
	destroy: ReturnType<typeof vi.fn>;
};
let client: SeerrClient;

beforeEach(() => {
	factory = { rawRequest: vi.fn() };
	instance = {
		id: "inst-1",
		baseUrl: "http://seerr.local",
		encryptedApiKey: "enc",
		encryptionIv: "iv",
		service: "SEERR" as const,
	} as ClientInstanceData;
	log = {
		warn: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		error: vi.fn(),
	} as unknown as FastifyBaseLogger;
	circuitBreaker = {
		check: vi.fn(),
		reportSuccess: vi.fn(),
		reportFailure: vi.fn(),
	};
	cache = {
		get: vi.fn(),
		set: vi.fn(),
		invalidate: vi.fn(),
		destroy: vi.fn(),
	};
	client = new SeerrClient(
		factory as unknown as ArrClientFactory,
		instance,
		log,
		circuitBreaker as unknown as SeerrCircuitBreaker,
		cache as unknown as SeerrCache,
	);
});

// ===========================================================================
// 1. getRequests
// ===========================================================================

describe("getRequests", () => {
	it("returns parsed data on valid response", async () => {
		const pageResult = makePageResult();
		factory.rawRequest.mockResolvedValue(mockResponse(pageResult));

		const result = await client.getRequests();

		expect(result.pageInfo.pages).toBe(1);
		expect(result.results).toHaveLength(1);
		expect(result.results[0]!.id).toBe(1);
	});

	it("falls back to raw data with warn log on Zod validation failure", async () => {
		// Request missing required fields — Zod safeParse will fail
		const badResult = makePageResult([
			{
				id: 1,
				status: "not_a_number", // wrong type
				type: "movie",
				is4k: false,
				media: { id: 1, tmdbId: 123, status: 1, createdAt: "x", updatedAt: "x" },
				createdAt: "x",
				updatedAt: "x",
				requestedBy: { id: 1, displayName: "u", createdAt: "x", updatedAt: "x", permissions: 0, requestCount: 0, userType: 1 },
				seasons: [],
			},
		]);
		factory.rawRequest.mockResolvedValue(mockResponse(badResult));

		const result = await client.getRequests();

		// Should return raw data (the bad result)
		expect(result.results[0]).toHaveProperty("status", "not_a_number");
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ errors: expect.any(Array) }),
			expect.stringContaining("validation failed"),
		);
	});

	it("constructs correct query string from params", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse(makePageResult()));

		await client.getRequests({ take: 10, skip: 5, filter: "pending", sort: "added" });

		const call = factory.rawRequest.mock.calls[0]!;
		const path = call[1] as string;
		expect(path).toContain("take=10");
		expect(path).toContain("skip=5");
		expect(path).toContain("filter=pending");
		expect(path).toContain("sort=added");
	});
});

// ===========================================================================
// 2. getRequestCount
// ===========================================================================

describe("getRequestCount", () => {
	it("parses valid response with seerrRequestCountSchema", async () => {
		const count = makeRequestCount();
		factory.rawRequest.mockResolvedValue(mockResponse(count));

		const result = await client.getRequestCount();

		expect(result.total).toBe(10);
		expect(result.movie).toBe(5);
		expect(result.pending).toBe(2);
	});

	it("throws on invalid response (schema.parse throws)", async () => {
		// Missing required field
		factory.rawRequest.mockResolvedValue(mockResponse({ total: 10 }));

		await expect(client.getRequestCount()).rejects.toThrow();
	});
});

// ===========================================================================
// 3. getRequest
// ===========================================================================

describe("getRequest", () => {
	it("returns parsed request on success", async () => {
		const req = makeRequest();
		factory.rawRequest.mockResolvedValue(mockResponse(req));

		const result = await client.getRequest(1);

		expect(result.id).toBe(1);
		expect(result.type).toBe("movie");
	});

	it("falls back to raw data on Zod failure", async () => {
		const badReq = makeRequest({ status: "bad" });
		factory.rawRequest.mockResolvedValue(mockResponse(badReq));

		const result = await client.getRequest(1);

		expect(result.status).toBe("bad");
		expect(log.warn).toHaveBeenCalled();
	});

	it("propagates error when rawRequest returns non-ok response", async () => {
		factory.rawRequest.mockResolvedValue(
			mockResponse({ error: "Not Found" }, 404),
		);

		await expect(client.getRequest(999)).rejects.toThrow(SeerrApiError);
	});
});

// ===========================================================================
// 4. approveRequest
// ===========================================================================

describe("approveRequest", () => {
	it("returns result on success", async () => {
		const req = makeRequest({ status: 2 });
		factory.rawRequest.mockResolvedValue(mockResponse(req));

		const result = await client.approveRequest(1);

		expect(result.status).toBe(2);
		const call = factory.rawRequest.mock.calls[0]!;
		expect(call[1]).toBe("/api/v1/request/1/approve");
		expect(call[2]).toMatchObject({ method: "POST" });
	});

	it("propagates errors", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse({ error: "Forbidden" }, 403));

		await expect(client.approveRequest(1)).rejects.toThrow(SeerrApiError);
	});
});

// ===========================================================================
// 5. declineRequest
// ===========================================================================

describe("declineRequest", () => {
	it("returns result on success", async () => {
		const req = makeRequest({ status: 3 });
		factory.rawRequest.mockResolvedValue(mockResponse(req));

		const result = await client.declineRequest(1);

		expect(result.status).toBe(3);
		const call = factory.rawRequest.mock.calls[0]!;
		expect(call[1]).toBe("/api/v1/request/1/decline");
	});
});

// ===========================================================================
// 6. deleteRequest
// ===========================================================================

describe("deleteRequest", () => {
	it("resolves without body on success (parseBody: false)", async () => {
		// DELETE returns no body — the client uses del() which sets parseBody: false
		factory.rawRequest.mockResolvedValue(mockResponse(null, 204));

		await expect(client.deleteRequest(1)).resolves.toBeUndefined();

		const call = factory.rawRequest.mock.calls[0]!;
		expect(call[1]).toBe("/api/v1/request/1");
		expect(call[2]).toMatchObject({ method: "DELETE" });
	});

	it("propagates errors", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse({ error: "Server Error" }, 500));

		await expect(client.deleteRequest(1)).rejects.toThrow(SeerrApiError);
	});
});

// ===========================================================================
// 7. retryRequest
// ===========================================================================

describe("retryRequest", () => {
	it("returns result on success", async () => {
		const req = makeRequest({ status: 2 });
		factory.rawRequest.mockResolvedValue(mockResponse(req));

		const result = await client.retryRequest(1);

		expect(result.status).toBe(2);
		const call = factory.rawRequest.mock.calls[0]!;
		expect(call[1]).toBe("/api/v1/request/1/retry");
	});
});

// ===========================================================================
// 8. search
// ===========================================================================

describe("search", () => {
	it("forwards query and page params correctly", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse(makeDiscoverResponse()));

		await client.search({ query: "Fight Club", page: 2 });

		const path = factory.rawRequest.mock.calls[0]![1] as string;
		expect(path).toContain("/api/v1/search");
		expect(path).toContain("query=Fight+Club");
		expect(path).toContain("page=2");
	});

	it("returns discover response with Zod validation", async () => {
		const discover = makeDiscoverResponse();
		factory.rawRequest.mockResolvedValue(mockResponse(discover));

		const result = await client.search({ query: "Fight Club" });

		expect(result.page).toBe(1);
		expect(result.totalResults).toBe(100);
		expect(result.results).toHaveLength(1);
		expect(result.results[0]!.title).toBe("Fight Club");
	});
});

// ===========================================================================
// 9. discoverMovies
// ===========================================================================

describe("discoverMovies", () => {
	it("forwards pagination params", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse(makeDiscoverResponse()));

		await client.discoverMovies({ page: 3, language: "en" });

		const path = factory.rawRequest.mock.calls[0]![1] as string;
		expect(path).toContain("/api/v1/discover/movies");
		expect(path).toContain("page=3");
		expect(path).toContain("language=en");
	});

	it("validates response with discover schema", async () => {
		const discover = makeDiscoverResponse();
		factory.rawRequest.mockResolvedValue(mockResponse(discover));

		const result = await client.discoverMovies();

		expect(result.totalPages).toBe(5);
		expect(result.results[0]!.mediaType).toBe("movie");
	});
});

// ===========================================================================
// 10. getMovieGenres
// ===========================================================================

describe("getMovieGenres", () => {
	it("fetches from API on cache miss and stores in cache", async () => {
		const genres = [
			{ id: 28, name: "Action" },
			{ id: 35, name: "Comedy" },
		];
		cache.get.mockReturnValue(undefined);
		factory.rawRequest.mockResolvedValue(mockResponse(genres));

		const result = await client.getMovieGenres();

		expect(result).toEqual(genres);
		expect(cache.set).toHaveBeenCalledWith(
			expect.stringContaining("genres:inst-1:movie"),
			genres,
			GENRE_TTL_MS,
		);
		expect(factory.rawRequest).toHaveBeenCalledTimes(1);
	});

	it("returns cached value on cache hit", async () => {
		const genres = [{ id: 28, name: "Action" }];
		cache.get.mockReturnValue(genres);

		const result = await client.getMovieGenres();

		expect(result).toEqual(genres);
		expect(factory.rawRequest).not.toHaveBeenCalled();
	});

	it("fetches from API when cache returns undefined (expired)", async () => {
		const genres = [{ id: 28, name: "Action" }];
		cache.get.mockReturnValue(undefined);
		factory.rawRequest.mockResolvedValue(mockResponse(genres));

		const result = await client.getMovieGenres();

		expect(result).toEqual(genres);
		expect(factory.rawRequest).toHaveBeenCalledTimes(1);
	});
});

// ===========================================================================
// 11. enrichRequestsWithMedia
// ===========================================================================

describe("enrichRequestsWithMedia", () => {
	it("enriches requests with poster/title from TMDB lookups", async () => {
		const req = makeRequest();
		const pageResult = makePageResult([req]);

		// First call is for the request itself (already resolved above);
		// enrichment calls getMovieDetails → GET /api/v1/movie/123
		factory.rawRequest.mockResolvedValue(
			mockResponse({ posterPath: "/poster.jpg", title: "Test Movie" }),
		);

		const result = await client.enrichRequestsWithMedia(pageResult as any);

		expect(result.results[0]!.media.posterPath).toBe("/poster.jpg");
		expect(result.results[0]!.media.title).toBe("Test Movie");
	});

	it("deduplicates lookups (2 requests for same movie → 1 API call)", async () => {
		const req1 = makeRequest({ id: 1 });
		const req2 = makeRequest({ id: 2 }); // same tmdbId (123)
		const pageResult = makePageResult([req1, req2]);

		factory.rawRequest.mockResolvedValue(
			mockResponse({ posterPath: "/poster.jpg", title: "Test Movie" }),
		);

		await client.enrichRequestsWithMedia(pageResult as any);

		// Only 1 API call for the deduplicated tmdbId
		expect(factory.rawRequest).toHaveBeenCalledTimes(1);
	});

	it("handles partial failures (one lookup fails, others succeed)", async () => {
		const req1 = makeRequest({ id: 1, media: { id: 1, tmdbId: 100, status: 1, createdAt: "x", updatedAt: "x" } });
		const req2 = makeRequest({ id: 2, media: { id: 2, tmdbId: 200, status: 1, createdAt: "x", updatedAt: "x" } });
		const pageResult = makePageResult([req1, req2]);

		// First lookup succeeds, second fails
		factory.rawRequest
			.mockResolvedValueOnce(mockResponse({ posterPath: "/a.jpg", title: "Movie A" }))
			.mockResolvedValueOnce(mockResponse({ error: "Server Error" }, 500));

		const result = await client.enrichRequestsWithMedia(pageResult as any);

		// First request enriched
		expect(result.results[0]!.media.posterPath).toBe("/a.jpg");
		// Second request left as-is (no posterPath)
		expect(result.results[1]!.media.posterPath).toBeUndefined();
		// Warning logged for partial failure
		expect(log.warn).toHaveBeenCalledWith(
			expect.objectContaining({ err: expect.any(SeerrApiError) }),
			expect.stringContaining("enrichment lookups failed"),
		);
	});
});

// ===========================================================================
// 12. Circuit breaker integration
// ===========================================================================

describe("circuit breaker integration", () => {
	it("check() is called before each request", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse(makeRequestCount()));

		await client.getRequestCount();

		expect(circuitBreaker.check).toHaveBeenCalledWith("inst-1");
		// check is called before rawRequest
		const checkOrder = circuitBreaker.check.mock.invocationCallOrder[0]!;
		const requestOrder = factory.rawRequest.mock.invocationCallOrder[0]!;
		expect(checkOrder).toBeLessThan(requestOrder);
	});

	it("reportSuccess() is called after successful request", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse(makeRequestCount()));

		await client.getRequestCount();

		expect(circuitBreaker.reportSuccess).toHaveBeenCalledWith("inst-1");
	});

	it("reportFailure() is called after retryable error", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse({ error: "Server Error" }, 500));

		await expect(client.getRequestCount()).rejects.toThrow(SeerrApiError);

		expect(circuitBreaker.reportFailure).toHaveBeenCalledWith("inst-1");
	});
});

// ===========================================================================
// 13. Timeout handling
// ===========================================================================

describe("timeout handling", () => {
	it("abort/timeout error → SeerrApiError.timeout with 504", async () => {
		factory.rawRequest.mockRejectedValue(new Error("The operation was aborted"));

		try {
			await client.getRequests();
			expect.fail("Should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SeerrApiError);
			const seerrErr = err as SeerrApiError;
			expect(seerrErr.statusCode).toBe(504);
			expect(seerrErr.message).toContain("timed out");
		}
	});

	it("custom timeout is passed to rawRequest", async () => {
		factory.rawRequest.mockResolvedValue(mockResponse(makeRequestCount()));

		// getRequestCount uses TIMEOUT_INTERACTIVE = 10_000
		await client.getRequestCount();

		const call = factory.rawRequest.mock.calls[0]!;
		const opts = call[2] as { timeout: number };
		expect(opts.timeout).toBe(10_000);
	});
});
