/**
 * Upstream Fixture / Regression Tests
 *
 * Validates that real-world API response shapes from Plex and Seerr
 * pass through parseUpstream correctly. These fixtures represent actual upstream
 * payloads (with extra fields) to catch regressions when schemas evolve.
 *
 * Each fixture includes extra fields beyond what the schema requires — this
 * ensures z.looseObject() tolerance works and we don't accidentally switch
 * to strict parsing.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { z } from "zod";
import { integrationHealth } from "../integration-health.js";
import { parseUpstream, } from "../parse-upstream.js";
import {
	plexIdentityResponseSchema,
	plexSectionsResponseSchema,
	plexSessionsResponseSchema,
	plexHistoryResponseSchema,
	plexLibraryItemsResponseSchema,
} from "../../plex/plex-schemas.js";

// ============================================================================
// Plex Fixtures
// ============================================================================

const PLEX_IDENTITY_RESPONSE = {
	MediaContainer: {
		size: 0,
		claimed: true,
		machineIdentifier: "abc123def456",
		version: "1.40.2.8395-c67dce28e",
		// Extra fields present in real responses
		apiVersion: "20",
		platform: "Linux",
		platformVersion: "6.1.0-18-amd64",
		updatedAt: 1709912345,
	},
};

const PLEX_SECTIONS_RESPONSE = {
	MediaContainer: {
		size: 3,
		allowSync: false,
		Directory: [
			{
				key: "1",
				title: "Movies",
				type: "movie",
				// Extra fields
				agent: "tv.plex.agents.movie",
				scanner: "Plex Movie",
				language: "en-US",
				uuid: "xxxx-yyyy-zzzz",
				updatedAt: 1709912345,
				scannedAt: 1709912345,
				hidden: 0,
			},
			{
				key: "2",
				title: "TV Shows",
				type: "show",
				agent: "tv.plex.agents.series",
				scanner: "Plex TV Series",
				language: "en-US",
			},
			{
				key: "3",
				title: "Music",
				type: "artist",
				agent: "tv.plex.agents.music",
				scanner: "Plex Music",
			},
		],
	},
};

const PLEX_SESSIONS_RESPONSE = {
	MediaContainer: {
		size: 1,
		Metadata: [
			{
				sessionKey: "123",
				ratingKey: "456",
				title: "Breaking Bad",
				grandparentTitle: "Breaking Bad",
				type: "episode",
				viewOffset: 1234567,
				duration: 2700000,
				thumb: "/library/metadata/456/thumb/1234567890",
				User: {
					id: 1,
					title: "admin",
					thumb: "https://plex.tv/users/abc/avatar?c=123",
				},
				Player: {
					title: "Chrome",
					platform: "Chrome",
					product: "Plex Web",
					state: "playing",
					// Extra fields
					address: "192.168.1.100",
					machineIdentifier: "xyz",
					local: true,
				},
				Session: {
					id: "abc-123",
					bandwidth: 20000,
					// Extra fields
					location: "lan",
				},
				TranscodeSession: {
					videoDecision: "transcode",
					audioDecision: "copy",
					// Extra fields
					throttled: false,
					complete: false,
					progress: 45.5,
				},
				// Many extra Metadata fields from real responses
				parentIndex: 5,
				index: 7,
				year: 2013,
				contentRating: "TV-MA",
				addedAt: 1600000000,
			},
		],
	},
};

const PLEX_HISTORY_RESPONSE = {
	MediaContainer: {
		size: 2,
		Metadata: [
			{
				ratingKey: "100",
				title: "Inception",
				type: "movie",
				viewedAt: 1709900000,
				accountID: 1,
				// Extra fields
				thumb: "/library/metadata/100/thumb/123",
				art: "/library/metadata/100/art/123",
				duration: 8880000,
			},
			{
				ratingKey: "200",
				parentRatingKey: "150",
				parentKey: "/library/metadata/150",
				grandparentRatingKey: "140",
				grandparentKey: "/library/metadata/140",
				grandparentTitle: "The Office",
				title: "Dinner Party",
				type: "episode",
				viewedAt: 1709890000,
				accountID: 1,
			},
		],
	},
};

const PLEX_LIBRARY_ITEMS_RESPONSE = {
	MediaContainer: {
		Metadata: [
			{
				ratingKey: "500",
				title: "Interstellar",
				type: "movie",
				year: 2014,
				userRating: 9.5,
				addedAt: 1600000000,
				Guid: [
					{ id: "imdb://tt0816692" },
					{ id: "tmdb://157336" },
				],
				Collection: [
					{ tag: "Christopher Nolan" },
				],
				Label: [
					{ tag: "4K" },
				],
				// Extra fields
				summary: "A team of explorers travel through a wormhole...",
				contentRating: "PG-13",
				studio: "Paramount Pictures",
			},
		],
	},
};

describe("Upstream fixture regression tests", () => {
	beforeEach(() => {
		integrationHealth.reset();
	});

	describe("Plex fixtures", () => {
		it("accepts real /identity response with extra fields", () => {
			const result = parseUpstream(PLEX_IDENTITY_RESPONSE, plexIdentityResponseSchema, {
				integration: "plex",
				category: "/identity",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.MediaContainer.machineIdentifier).toBe("abc123def456");
				expect(result.data.MediaContainer.version).toBe("1.40.2.8395-c67dce28e");
			}
		});

		it("accepts real /library/sections response with extra fields", () => {
			const result = parseUpstream(PLEX_SECTIONS_RESPONSE, plexSectionsResponseSchema, {
				integration: "plex",
				category: "/library/sections",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.MediaContainer.Directory).toHaveLength(3);
				expect(result.data.MediaContainer.Directory![0]!.title).toBe("Movies");
			}
		});

		it("accepts real /status/sessions response with nested extra fields", () => {
			const result = parseUpstream(PLEX_SESSIONS_RESPONSE, plexSessionsResponseSchema, {
				integration: "plex",
				category: "/status/sessions",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				const session = result.data.MediaContainer.Metadata![0]!;
				expect(session.title).toBe("Breaking Bad");
				expect(session.User?.title).toBe("admin");
				expect(session.Player?.state).toBe("playing");
				expect(session.TranscodeSession?.videoDecision).toBe("transcode");
			}
		});

		it("accepts sessions with numeric sessionKey/ratingKey (Plex version variance)", () => {
			const numericKeysResponse = {
				MediaContainer: {
					size: 1,
					Metadata: [
						{
							sessionKey: 42,
							ratingKey: 789,
							title: "Movie Title",
							type: "movie",
							Session: { id: 101 },
							User: { id: "1", title: "user" },
						},
					],
				},
			};
			const result = parseUpstream(numericKeysResponse, plexSessionsResponseSchema, {
				integration: "plex",
				category: "/status/sessions",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				const session = result.data.MediaContainer.Metadata![0]!;
				expect(session.sessionKey).toBe("42");
				expect(session.ratingKey).toBe("789");
				expect(session.Session?.id).toBe("101");
				expect(session.User?.id).toBe(1);
			}
		});

		it("accepts sessions with missing Player fields (minimal client metadata)", () => {
			const minimalPlayerResponse = {
				MediaContainer: {
					size: 1,
					Metadata: [
						{
							sessionKey: "1",
							ratingKey: "100",
							title: "Song",
							Player: { title: "PlexAmp" },
						},
					],
				},
			};
			const result = parseUpstream(minimalPlayerResponse, plexSessionsResponseSchema, {
				integration: "plex",
				category: "/status/sessions",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				const session = result.data.MediaContainer.Metadata![0]!;
				expect(session.Player?.platform).toBe("unknown");
				expect(session.Player?.product).toBe("unknown");
				expect(session.Player?.state).toBe("unknown");
				expect(session.type).toBe("unknown");
			}
		});

		it("accepts real history response", () => {
			const result = parseUpstream(PLEX_HISTORY_RESPONSE, plexHistoryResponseSchema, {
				integration: "plex",
				category: "/status/sessions/history/all",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.MediaContainer.Metadata).toHaveLength(2);
			}
		});

		it("accepts real library items response with Guid/Collection/Label arrays", () => {
			const result = parseUpstream(PLEX_LIBRARY_ITEMS_RESPONSE, plexLibraryItemsResponseSchema, {
				integration: "plex",
				category: "/library/sections/1/all",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				const item = result.data.MediaContainer.Metadata![0]!;
				expect(item.Guid).toHaveLength(2);
				expect(item.Collection![0]!.tag).toBe("Christopher Nolan");
			}
		});

		it("rejects when required field is wrong type", () => {
			const broken = {
				MediaContainer: {
					machineIdentifier: 12345, // should be string
					version: "1.0.0",
				},
			};
			const result = parseUpstream(broken, plexIdentityResponseSchema, {
				integration: "plex",
				category: "/identity",
			});
			expect(result.success).toBe(false);
		});

		it("accepts empty MediaContainer (no Metadata/Directory arrays)", () => {
			const empty = { MediaContainer: {} };
			const result = parseUpstream(empty, plexSectionsResponseSchema, {
				integration: "plex",
				category: "/library/sections",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.MediaContainer.Directory).toBeUndefined();
			}
		});
	});

	describe("Health recording from fixtures", () => {
		it("accumulates correct stats across multiple fixture validations", () => {
			// Run several validations
			parseUpstream(PLEX_IDENTITY_RESPONSE, plexIdentityResponseSchema, {
				integration: "plex", category: "/identity",
			});
			parseUpstream(PLEX_SECTIONS_RESPONSE, plexSectionsResponseSchema, {
				integration: "plex", category: "/library/sections",
			});
			// One failure
			parseUpstream({ broken: true }, plexIdentityResponseSchema, {
				integration: "plex", category: "/identity",
			});

			const all = integrationHealth.getAll();
			expect(all.overallTotals).toEqual({ total: 3, validated: 2, rejected: 1 });

			const plex = all.integrations.plex!;
			expect(plex.totals).toEqual({ total: 3, validated: 2, rejected: 1 });
			expect(plex.categories["/identity"]).toEqual({ total: 2, validated: 1, rejected: 1 });
			expect(plex.categories["/library/sections"]).toEqual({ total: 1, validated: 1, rejected: 0 });
		});
	});

	describe("Extra field tolerance (z.looseObject)", () => {
		it("preserves extra fields in parsed output", () => {
			const result = parseUpstream(PLEX_IDENTITY_RESPONSE, plexIdentityResponseSchema, {
				integration: "plex", category: "/identity",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				// z.looseObject passes through unknown fields
				const container = result.data.MediaContainer as Record<string, unknown>;
				expect(container.platform).toBe("Linux");
				expect(container.claimed).toBe(true);
			}
		});

		it("would fail with z.object().strict() — confirms looseObject is needed", () => {
			const strictSchema = z.object({
				MediaContainer: z.object({
					machineIdentifier: z.string(),
					version: z.string(),
				}).strict(),
			}).strict();

			const result = parseUpstream(PLEX_IDENTITY_RESPONSE, strictSchema, {
				integration: "test", category: "strict-test",
			});
			// Should fail because fixture has extra fields
			expect(result.success).toBe(false);
		});
	});
});
