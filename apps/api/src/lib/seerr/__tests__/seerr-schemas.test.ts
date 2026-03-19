/**
 * Tests for Seerr Zod schemas added in Phase 1B.
 * Validates that realistic fixture data passes and missing required fields are rejected.
 */
import { describe, expect, it } from "vitest";
import {
	seerrCreateRequestResponseSchema,
	seerrGenreSchema,
	seerrIssueCommentSchema,
	seerrIssueSchema,
	seerrMediaSummarySchema,
	seerrMovieDetailsSchema,
	seerrQuotaSchema,
	seerrServerWithDetailsSchema,
	seerrServiceServerSchema,
	seerrTvDetailsSchema,
} from "@arr/shared";

// ============================================================================
// Fixtures
// ============================================================================

const VALID_USER = {
	id: 1,
	displayName: "Admin",
	avatar: "/img/avatar.png",
	createdAt: "2024-01-01T00:00:00.000Z",
	updatedAt: "2024-01-01T00:00:00.000Z",
	permissions: 2,
	requestCount: 5,
	userType: 1,
};

const VALID_MEDIA_INFO = {
	id: 10,
	tmdbId: 550,
	status: 5,
	createdAt: "2024-01-01T00:00:00.000Z",
	updatedAt: "2024-01-01T00:00:00.000Z",
};

const VALID_DISCOVER_RESPONSE = {
	page: 1,
	totalPages: 1,
	totalResults: 0,
	results: [],
};

// ============================================================================
// Tests
// ============================================================================

describe("seerrIssueCommentSchema", () => {
	it("accepts valid issue comment", () => {
		const data = {
			id: 1,
			message: "This subtitle is wrong",
			createdAt: "2024-06-15T12:00:00.000Z",
			user: VALID_USER,
		};
		expect(() => seerrIssueCommentSchema.parse(data)).not.toThrow();
	});

	it("rejects missing message", () => {
		const data = { id: 1, createdAt: "2024-06-15T12:00:00.000Z", user: VALID_USER };
		expect(() => seerrIssueCommentSchema.parse(data)).toThrow();
	});
});

describe("seerrIssueSchema", () => {
	it("accepts valid issue", () => {
		const data = {
			id: 42,
			issueType: 1,
			status: 1,
			problemSeason: 0,
			problemEpisode: 0,
			createdAt: "2024-06-15T12:00:00.000Z",
			updatedAt: "2024-06-15T12:00:00.000Z",
			createdBy: VALID_USER,
			comments: [],
			media: { ...VALID_MEDIA_INFO, posterPath: "/poster.jpg", title: "Fight Club" },
		};
		expect(() => seerrIssueSchema.parse(data)).not.toThrow();
	});

	it("rejects missing media", () => {
		const data = {
			id: 42,
			issueType: 1,
			status: 1,
			problemSeason: 0,
			problemEpisode: 0,
			createdAt: "2024-06-15T12:00:00.000Z",
			updatedAt: "2024-06-15T12:00:00.000Z",
			createdBy: VALID_USER,
			comments: [],
		};
		expect(() => seerrIssueSchema.parse(data)).toThrow();
	});
});

describe("seerrQuotaSchema", () => {
	it("accepts valid quota", () => {
		const data = {
			movie: { used: 2, remaining: 3, restricted: true, limit: 5, days: 7 },
			tv: { used: 1, remaining: 4, restricted: true, limit: 5, days: 7 },
		};
		expect(() => seerrQuotaSchema.parse(data)).not.toThrow();
	});

	it("rejects missing tv quota", () => {
		const data = {
			movie: { used: 2, remaining: 3, restricted: true, limit: 5, days: 7 },
		};
		expect(() => seerrQuotaSchema.parse(data)).toThrow();
	});
});

describe("seerrGenreSchema", () => {
	it("accepts valid genre", () => {
		expect(() => seerrGenreSchema.parse({ id: 28, name: "Action" })).not.toThrow();
	});

	it("preserves extra fields", () => {
		const result = seerrGenreSchema.parse({ id: 28, name: "Action", slug: "action" });
		expect(result).toHaveProperty("slug", "action");
	});
});

describe("seerrMovieDetailsSchema", () => {
	it("accepts valid movie details", () => {
		const data = {
			id: 550,
			title: "Fight Club",
			genres: [{ id: 18, name: "Drama" }],
			credits: { cast: [], crew: [] },
			recommendations: VALID_DISCOVER_RESPONSE,
			similar: VALID_DISCOVER_RESPONSE,
		};
		expect(() => seerrMovieDetailsSchema.parse(data)).not.toThrow();
	});

	it("rejects missing credits", () => {
		const data = {
			id: 550,
			title: "Fight Club",
			genres: [],
			recommendations: VALID_DISCOVER_RESPONSE,
			similar: VALID_DISCOVER_RESPONSE,
		};
		expect(() => seerrMovieDetailsSchema.parse(data)).toThrow();
	});
});

describe("seerrTvDetailsSchema", () => {
	it("accepts valid tv details", () => {
		const data = {
			id: 1396,
			name: "Breaking Bad",
			genres: [{ id: 18, name: "Drama" }],
			credits: { cast: [], crew: [] },
			keywords: [{ id: 210024, name: "anime" }],
			seasons: [{ id: 1, seasonNumber: 1, episodeCount: 7 }],
			recommendations: VALID_DISCOVER_RESPONSE,
			similar: VALID_DISCOVER_RESPONSE,
		};
		expect(() => seerrTvDetailsSchema.parse(data)).not.toThrow();
	});

	it("rejects missing seasons", () => {
		const data = {
			id: 1396,
			name: "Breaking Bad",
			genres: [],
			credits: { cast: [], crew: [] },
			keywords: [],
			recommendations: VALID_DISCOVER_RESPONSE,
			similar: VALID_DISCOVER_RESPONSE,
		};
		expect(() => seerrTvDetailsSchema.parse(data)).toThrow();
	});
});

describe("seerrMediaSummarySchema", () => {
	it("accepts minimal response", () => {
		const result = seerrMediaSummarySchema.parse({});
		expect(result).toBeDefined();
	});

	it("accepts full response", () => {
		const data = { voteAverage: 8.4, backdropPath: "/bg.jpg", posterPath: "/p.jpg" };
		const result = seerrMediaSummarySchema.parse(data);
		expect(result.voteAverage).toBe(8.4);
	});
});

describe("seerrCreateRequestResponseSchema", () => {
	it("accepts valid create request response", () => {
		const data = {
			id: 1,
			status: 1,
			type: "movie" as const,
			media: VALID_MEDIA_INFO,
			createdAt: "2024-06-15T12:00:00.000Z",
			is4k: false,
		};
		expect(() => seerrCreateRequestResponseSchema.parse(data)).not.toThrow();
	});
});

describe("seerrServiceServerSchema", () => {
	it("accepts valid service server", () => {
		const data = {
			id: 1,
			name: "Radarr Main",
			is4k: false,
			isDefault: true,
			activeProfileId: 6,
			activeDirectory: "/movies",
			activeTags: [],
		};
		expect(() => seerrServiceServerSchema.parse(data)).not.toThrow();
	});
});

describe("seerrServerWithDetailsSchema", () => {
	it("accepts valid server with details", () => {
		const data = {
			server: {
				id: 1,
				name: "Radarr",
				is4k: false,
				isDefault: true,
				activeProfileId: 6,
				activeDirectory: "/movies",
				activeTags: [],
			},
			profiles: [{ id: 6, name: "HD-1080p" }],
			rootFolders: [{ id: 1, path: "/movies" }],
			tags: [{ id: 1, label: "anime" }],
		};
		expect(() => seerrServerWithDetailsSchema.parse(data)).not.toThrow();
	});

	it("rejects missing server", () => {
		const data = {
			profiles: [],
			rootFolders: [],
			tags: [],
		};
		expect(() => seerrServerWithDetailsSchema.parse(data)).toThrow();
	});
});
