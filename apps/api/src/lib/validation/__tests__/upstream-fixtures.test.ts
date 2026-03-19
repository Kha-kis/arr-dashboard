/**
 * Upstream Fixture / Regression Tests
 *
 * Validates that real-world API response shapes from Plex, Tautulli, and Seerr
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
import { parseUpstream, parseUpstreamOrThrow } from "../parse-upstream.js";
import {
	plexIdentityResponseSchema,
	plexSectionsResponseSchema,
	plexSessionsResponseSchema,
	plexHistoryResponseSchema,
	plexLibraryItemsResponseSchema,
} from "../../plex/plex-schemas.js";
import {
	tautulliResponseWrapperSchema,
	tautulliInfoSchema,
	tautulliHistoryDataSchema,
	tautulliActivityDataSchema,
} from "../../tautulli/tautulli-schemas.js";

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

// ============================================================================
// Tautulli Fixtures
// ============================================================================

const TAUTULLI_WRAPPER_SUCCESS = {
	response: {
		result: "success" as const,
		message: null,
		data: { tautulli_version: "2.13.4" },
	},
};

const TAUTULLI_WRAPPER_ERROR = {
	response: {
		result: "error" as const,
		message: "API key is invalid",
		data: {},
	},
};

const TAUTULLI_HISTORY_DATA = {
	data: [
		{
			rating_key: "100",
			parent_rating_key: "90",
			grandparent_rating_key: "80",
			title: "Pilot",
			grandparent_title: "Breaking Bad",
			media_type: "episode",
			user: "admin",
			date: 1709900000,
			play_count: 3,
			// Extra fields
			full_title: "Breaking Bad - S01E01 - Pilot",
			duration: 3500,
			paused_counter: 120,
			percent_complete: 100,
			ip_address: "192.168.1.100",
		},
	],
	recordsFiltered: 1,
	recordsTotal: 150,
	// Extra fields
	draw: 1,
	filter_duration: "3 hrs 25 mins",
	total_duration: "250 hrs",
};

const TAUTULLI_ACTIVITY_DATA = {
	sessions: [
		{
			session_key: "abc",
			rating_key: "200",
			title: "Dune",
			media_type: "movie",
			user: "admin",
			friendly_name: "Admin User",
			player: "Plex Web",
			platform: "Chrome",
			product: "Plex Web",
			state: "playing",
			progress_percent: "45",
			transcode_decision: "direct play",
			stream_video_decision: "direct play",
			stream_audio_decision: "direct play",
			video_resolution: "1080",
			audio_codec: "aac",
			video_codec: "h264",
			bandwidth: "20000",
			location: "lan",
			thumb: "/library/metadata/200/thumb/123",
			// Extra fields
			ip_address: "192.168.1.100",
			full_title: "Dune (2021)",
			quality_profile: "Original",
			stream_container: "mkv",
		},
	],
	stream_count: "1",
	total_bandwidth: 20000,
	lan_bandwidth: 20000,
	wan_bandwidth: 0,
	// Extra fields
	stream_count_direct_play: 1,
	stream_count_direct_stream: 0,
	stream_count_transcode: 0,
};

// ============================================================================
// Tests
// ============================================================================

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

	describe("Tautulli fixtures", () => {
		it("accepts real response wrapper (success)", () => {
			const result = parseUpstream(TAUTULLI_WRAPPER_SUCCESS, tautulliResponseWrapperSchema, {
				integration: "tautulli",
				category: "wrapper",
			});
			expect(result.success).toBe(true);
		});

		it("accepts real response wrapper (error)", () => {
			const result = parseUpstream(TAUTULLI_WRAPPER_ERROR, tautulliResponseWrapperSchema, {
				integration: "tautulli",
				category: "wrapper",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.response.result).toBe("error");
			}
		});

		it("accepts real get_tautulli_info data", () => {
			const data = parseUpstreamOrThrow(
				TAUTULLI_WRAPPER_SUCCESS.response.data,
				tautulliInfoSchema,
				{ integration: "tautulli", category: "get_tautulli_info" },
			);
			expect(data.tautulli_version).toBe("2.13.4");
		});

		it("accepts real get_history data with extra fields", () => {
			const result = parseUpstream(TAUTULLI_HISTORY_DATA, tautulliHistoryDataSchema, {
				integration: "tautulli",
				category: "get_history",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.data).toHaveLength(1);
				expect(result.data.recordsFiltered).toBe(1);
				expect(result.data.recordsTotal).toBe(150);
			}
		});

		it("accepts real get_activity data with extra fields", () => {
			const result = parseUpstream(TAUTULLI_ACTIVITY_DATA, tautulliActivityDataSchema, {
				integration: "tautulli",
				category: "get_activity",
			});
			expect(result.success).toBe(true);
			if (result.success) {
				expect(result.data.sessions).toHaveLength(1);
				expect(result.data.sessions[0]!.title).toBe("Dune");
			}
		});

		it("rejects when wrapper has invalid result enum", () => {
			const broken = {
				response: {
					result: "maybe", // not in enum
					message: null,
					data: {},
				},
			};
			const result = parseUpstream(broken, tautulliResponseWrapperSchema, {
				integration: "tautulli",
				category: "wrapper",
			});
			expect(result.success).toBe(false);
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
			parseUpstream(TAUTULLI_HISTORY_DATA, tautulliHistoryDataSchema, {
				integration: "tautulli", category: "get_history",
			});
			// One failure
			parseUpstream({ broken: true }, plexIdentityResponseSchema, {
				integration: "plex", category: "/identity",
			});

			const all = integrationHealth.getAll();
			expect(all.overallTotals).toEqual({ total: 4, validated: 3, rejected: 1 });

			const plex = all.integrations.plex!;
			expect(plex.totals).toEqual({ total: 3, validated: 2, rejected: 1 });
			expect(plex.categories["/identity"]).toEqual({ total: 2, validated: 1, rejected: 1 });
			expect(plex.categories["/library/sections"]).toEqual({ total: 1, validated: 1, rejected: 0 });

			const tautulli = all.integrations.tautulli!;
			expect(tautulli.totals).toEqual({ total: 1, validated: 1, rejected: 0 });
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
