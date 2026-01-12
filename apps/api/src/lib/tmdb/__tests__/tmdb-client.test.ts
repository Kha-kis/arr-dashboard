/**
 * Tests for TMDBClient
 *
 * Unit tests for the TMDB client wrapper, including caching and normalization.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TMDBClient } from "../tmdb-client.js";

// Mock tmdb-ts module
vi.mock("tmdb-ts", () => {
	const mockMovies = {
		popular: vi.fn(),
		topRated: vi.fn(),
		upcoming: vi.fn(),
		similar: vi.fn(),
		externalIds: vi.fn(),
		credits: vi.fn(),
		videos: vi.fn(),
		watchProviders: vi.fn(),
	};

	const mockTvShows = {
		popular: vi.fn(),
		topRated: vi.fn(),
		airingToday: vi.fn(),
		similar: vi.fn(),
		externalIds: vi.fn(),
		credits: vi.fn(),
		aggregateCredits: vi.fn(),
		videos: vi.fn(),
		watchProviders: vi.fn(),
	};

	const mockTrending = {
		trending: vi.fn(),
	};

	const mockSearch = {
		movies: vi.fn(),
		tvShows: vi.fn(),
	};

	const mockGenres = {
		movies: vi.fn(),
		tvShows: vi.fn(),
	};

	return {
		TMDB: vi.fn().mockImplementation(() => ({
			movies: mockMovies,
			tvShows: mockTvShows,
			trending: mockTrending,
			search: mockSearch,
			genres: mockGenres,
		})),
		// Export mock references for test access
		__mockMovies: mockMovies,
		__mockTvShows: mockTvShows,
		__mockTrending: mockTrending,
		__mockSearch: mockSearch,
		__mockGenres: mockGenres,
	};
});

// Helper to get mock references
const getMocks = async () => {
	const mod = await import("tmdb-ts");
	return {
		mockMovies: (mod as any).__mockMovies,
		mockTvShows: (mod as any).__mockTvShows,
		mockTrending: (mod as any).__mockTrending,
		mockSearch: (mod as any).__mockSearch,
		mockGenres: (mod as any).__mockGenres,
	};
};

describe("TMDBClient - Image URL Generation", () => {
	let client: TMDBClient;

	beforeEach(() => {
		client = new TMDBClient("test-api-key", {
			imageBaseUrl: "https://image.tmdb.org/t/p",
		});
	});

	it("should generate correct image URL with default size", () => {
		const url = client.getImageUrl("/abc123.jpg");
		expect(url).toBe("https://image.tmdb.org/t/p/w500/abc123.jpg");
	});

	it("should generate correct image URL with specified size", () => {
		const url = client.getImageUrl("/abc123.jpg", "original");
		expect(url).toBe("https://image.tmdb.org/t/p/original/abc123.jpg");
	});

	it("should return null for null path", () => {
		const url = client.getImageUrl(null);
		expect(url).toBeNull();
	});

	it("should return null for undefined path", () => {
		const url = client.getImageUrl(undefined);
		expect(url).toBeNull();
	});

	it("should support all size variants", () => {
		const sizes = ["w185", "w342", "w500", "w780", "original"] as const;
		for (const size of sizes) {
			const url = client.getImageUrl("/test.jpg", size);
			expect(url).toBe(`https://image.tmdb.org/t/p/${size}/test.jpg`);
		}
	});
});

describe("TMDBClient - Movies Endpoints", () => {
	let client: TMDBClient;
	let mocks: Awaited<ReturnType<typeof getMocks>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks = await getMocks();
		client = new TMDBClient("test-api-key", {
			imageBaseUrl: "https://image.tmdb.org/t/p",
		});
	});

	it("should fetch popular movies with pagination", async () => {
		const mockResponse = {
			page: 1,
			results: [
				{ id: 1, title: "Movie 1", poster_path: "/poster1.jpg" },
				{ id: 2, title: "Movie 2", poster_path: "/poster2.jpg" },
			],
			total_pages: 100,
			total_results: 2000,
		};

		mocks.mockMovies.popular.mockResolvedValue(mockResponse);

		const result = await client.movies.popular(1);

		expect(result.results).toBeDefined();
		expect(result.page).toBe(1);
		expect(mocks.mockMovies.popular).toHaveBeenCalled();
	});

	it("should fetch movie external IDs", async () => {
		const mockExternalIds = {
			id: 550,
			imdb_id: "tt0137523",
			facebook_id: null,
			instagram_id: null,
			twitter_id: null,
		};

		mocks.mockMovies.externalIds.mockResolvedValue(mockExternalIds);

		const result = await client.movies.externalIds(550);

		expect(result.imdb_id).toBe("tt0137523");
		expect(mocks.mockMovies.externalIds).toHaveBeenCalledWith(550);
	});

	it("should fetch movie credits", async () => {
		const mockCredits = {
			id: 550,
			cast: [
				{
					id: 819,
					name: "Edward Norton",
					character: "The Narrator",
					profile_path: "/profile.jpg",
					order: 0,
				},
			],
			crew: [
				{
					id: 7467,
					name: "David Fincher",
					job: "Director",
					department: "Directing",
					profile_path: "/fincher.jpg",
				},
			],
		};

		mocks.mockMovies.credits.mockResolvedValue(mockCredits);

		const result = await client.movies.credits(550);

		expect(result.cast).toHaveLength(1);
		expect(result.crew).toHaveLength(1);
		expect(result.cast[0]!.name).toBe("Edward Norton");
	});

	it("should fetch movie videos", async () => {
		const mockVideos = {
			id: 550,
			results: [
				{
					id: "abc123",
					key: "SUXWAEX2jlg",
					name: "Fight Club Trailer",
					type: "Trailer",
					site: "YouTube",
					size: 1080,
				},
			],
		};

		mocks.mockMovies.videos.mockResolvedValue(mockVideos);

		const result = await client.movies.videos(550);

		expect(result.results).toHaveLength(1);
		expect(result.results[0]!.key).toBe("SUXWAEX2jlg");
	});

	it("should fetch movie watch providers", async () => {
		const mockProviders = {
			id: 550,
			results: {
				US: {
					link: "https://www.themoviedb.org/movie/550/watch",
					flatrate: [
						{ provider_id: 8, provider_name: "Netflix", logo_path: "/netflix.png" },
					],
					rent: [],
					buy: [],
				},
			},
		};

		mocks.mockMovies.watchProviders.mockResolvedValue(mockProviders);

		const result = await client.movies.watchProviders(550);

		expect(result.results).toBeDefined();
		expect(result.results.US).toBeDefined();
	});
});

describe("TMDBClient - TV Shows Endpoints", () => {
	let client: TMDBClient;
	let mocks: Awaited<ReturnType<typeof getMocks>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks = await getMocks();
		client = new TMDBClient("test-api-key", {
			imageBaseUrl: "https://image.tmdb.org/t/p",
		});
	});

	it("should fetch popular TV shows", async () => {
		const mockResponse = {
			page: 1,
			results: [
				{
					id: 1,
					name: "Show 1",
					original_name: "Show 1",
					overview: "Description",
					poster_path: "/poster1.jpg",
					backdrop_path: null,
					first_air_date: "2024-01-01",
					genre_ids: [18],
					origin_country: ["US"],
					original_language: "en",
					vote_average: 8.5,
					vote_count: 1000,
					popularity: 100,
				},
			],
			total_pages: 50,
			total_results: 1000,
		};

		mocks.mockTvShows.popular.mockResolvedValue(mockResponse);

		const result = await client.tv.popular(1);

		expect(result.results).toBeDefined();
		expect(result.results[0]!).toHaveProperty("name");
		expect(result.results[0]!).toHaveProperty("first_air_date");
	});

	it("should fetch TV show aggregate credits", async () => {
		const mockCredits = {
			id: 1399,
			cast: [
				{
					id: 22970,
					name: "Peter Dinklage",
					roles: [{ character: "Tyrion Lannister", episode_count: 73 }],
					total_episode_count: 73,
					profile_path: "/profile.jpg",
					order: 0,
				},
			],
			crew: [],
		};

		mocks.mockTvShows.aggregateCredits.mockResolvedValue(mockCredits);

		const result = await client.tv.aggregateCredits(1399);

		expect(result.cast).toHaveLength(1);
		expect(result.cast[0]!.total_episode_count).toBe(73);
	});
});

describe("TMDBClient - Search Endpoints", () => {
	let client: TMDBClient;
	let mocks: Awaited<ReturnType<typeof getMocks>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks = await getMocks();
		client = new TMDBClient("test-api-key", {
			imageBaseUrl: "https://image.tmdb.org/t/p",
		});
	});

	it("should search for movies", async () => {
		const mockResponse = {
			page: 1,
			results: [
				{ id: 550, title: "Fight Club", poster_path: "/poster.jpg" },
			],
			total_pages: 1,
			total_results: 1,
		};

		mocks.mockSearch.movies.mockResolvedValue(mockResponse);

		const result = await client.search.movies({ query: "Fight Club" });

		expect(result.results).toHaveLength(1);
		expect(mocks.mockSearch.movies).toHaveBeenCalledWith(
			expect.objectContaining({ query: "Fight Club" })
		);
	});

	it("should search for TV shows", async () => {
		const mockResponse = {
			page: 1,
			results: [
				{
					id: 1399,
					name: "Game of Thrones",
					original_name: "Game of Thrones",
					overview: "Description",
					poster_path: "/got.jpg",
					backdrop_path: null,
					first_air_date: "2011-04-17",
					genre_ids: [18, 10765],
					origin_country: ["US"],
					original_language: "en",
					vote_average: 8.4,
					vote_count: 10000,
					popularity: 500,
				},
			],
			total_pages: 1,
			total_results: 1,
		};

		mocks.mockSearch.tvShows.mockResolvedValue(mockResponse);

		const result = await client.search.tv({ query: "Game of Thrones" });

		expect(result.results).toHaveLength(1);
		expect(result.results[0]!.name).toBe("Game of Thrones");
	});
});

describe("TMDBClient - Genres Endpoints", () => {
	let client: TMDBClient;
	let mocks: Awaited<ReturnType<typeof getMocks>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks = await getMocks();
		client = new TMDBClient("test-api-key", {
			imageBaseUrl: "https://image.tmdb.org/t/p",
		});
	});

	it("should fetch movie genres", async () => {
		const mockGenres = {
			genres: [
				{ id: 28, name: "Action" },
				{ id: 12, name: "Adventure" },
				{ id: 18, name: "Drama" },
			],
		};

		mocks.mockGenres.movies.mockResolvedValue(mockGenres);

		const result = await client.genres.movies();

		expect(result.genres).toHaveLength(3);
		expect(result.genres[0]!.name).toBe("Action");
	});

	it("should fetch TV genres", async () => {
		const mockGenres = {
			genres: [
				{ id: 18, name: "Drama" },
				{ id: 10765, name: "Sci-Fi & Fantasy" },
			],
		};

		mocks.mockGenres.tvShows.mockResolvedValue(mockGenres);

		const result = await client.genres.tv();

		expect(result.genres).toHaveLength(2);
	});
});

describe("TMDBClient - Batch External IDs", () => {
	let client: TMDBClient;
	let mocks: Awaited<ReturnType<typeof getMocks>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks = await getMocks();
		client = new TMDBClient("test-api-key", {
			imageBaseUrl: "https://image.tmdb.org/t/p",
		});
	});

	it("should fetch external IDs for multiple movies", async () => {
		// Use unique IDs to avoid cache collisions from other tests
		mocks.mockMovies.externalIds
			.mockResolvedValueOnce({ id: 9001, imdb_id: "tt9001001" })
			.mockResolvedValueOnce({ id: 9002, imdb_id: "tt9002002" });

		const items = [{ id: 9001 }, { id: 9002 }];
		const result = await client.getExternalIdsForItems(items, "movie");

		expect(result.size).toBe(2);
		expect(result.get(9001)?.imdb_id).toBe("tt9001001");
		expect(result.get(9002)?.imdb_id).toBe("tt9002002");
	});

	it("should handle errors gracefully in batch fetch", async () => {
		// Use unique IDs to avoid cache collisions
		mocks.mockMovies.externalIds
			.mockResolvedValueOnce({ id: 9003, imdb_id: "tt9003003" })
			.mockRejectedValueOnce(new Error("API error"));

		const items = [{ id: 9003 }, { id: 9004 }];
		const result = await client.getExternalIdsForItems(items, "movie");

		// Should still return results, with empty object for failed item
		expect(result.size).toBe(2);
		expect(result.get(9003)?.imdb_id).toBe("tt9003003");
		expect(result.get(9004)).toEqual({});
	});
});
