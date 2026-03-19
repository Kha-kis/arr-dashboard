import { describe, expect, it } from "vitest";
import type { TautulliSessionItem } from "../../lib/tautulli/tautulli-client.js";
import {
	type PlexSessionInput,
	buildTautulliSessionMap,
	enrichSessionsWithTautulli,
} from "../lib/session-enrichment-helpers.js";

// ============================================================================
// Factories
// ============================================================================

function plexSession(overrides: Partial<PlexSessionInput> = {}): PlexSessionInput {
	return {
		user: { title: "alice" },
		title: "Test Movie",
		ratingKey: "12345",
		videoDecision: "direct play",
		bandwidth: 5000,
		state: "playing",
		...overrides,
	};
}

function tautulliSession(overrides: Partial<TautulliSessionItem> = {}): TautulliSessionItem {
	return {
		session_key: "1",
		rating_key: "12345",
		title: "Test Movie",
		media_type: "movie",
		user: "alice",
		friendly_name: "Alice",
		player: "Roku Ultra",
		platform: "Roku",
		product: "Plex for Roku",
		state: "playing",
		progress_percent: "50",
		transcode_decision: "direct play",
		stream_video_decision: "direct play",
		stream_audio_decision: "copy",
		video_resolution: "1080",
		audio_codec: "aac",
		video_codec: "h264",
		bandwidth: "5000",
		location: "lan",
		...overrides,
	};
}

// ============================================================================
// buildTautulliSessionMap
// ============================================================================

describe("buildTautulliSessionMap", () => {
	it("creates a map keyed by rating_key", () => {
		const sessions = [
			tautulliSession({ rating_key: "100" }),
			tautulliSession({ rating_key: "200" }),
		];
		const map = buildTautulliSessionMap(sessions);
		expect(map.size).toBe(2);
		expect(map.get("100")?.rating_key).toBe("100");
		expect(map.get("200")?.rating_key).toBe("200");
	});

	it("skips sessions with empty rating_key", () => {
		const sessions = [
			tautulliSession({ rating_key: "" }),
			tautulliSession({ rating_key: "100" }),
		];
		const map = buildTautulliSessionMap(sessions);
		expect(map.size).toBe(1);
	});
});

// ============================================================================
// enrichSessionsWithTautulli
// ============================================================================

describe("enrichSessionsWithTautulli", () => {
	it("enriches Plex session when Tautulli match exists", () => {
		const plex = [plexSession({ ratingKey: "100" })];
		const map = buildTautulliSessionMap([
			tautulliSession({
				rating_key: "100",
				stream_audio_decision: "transcode",
				video_codec: "hevc",
				audio_codec: "eac3",
				video_resolution: "2160",
				platform: "Apple TV",
				player: "Infuse",
			}),
		]);

		const result = enrichSessionsWithTautulli(plex, map);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			user: "alice",
			title: "Test Movie",
			videoDecision: "direct play",
			bandwidth: 5000,
			state: "playing",
			audioDecision: "transcode",
			videoCodec: "hevc",
			audioCodec: "eac3",
			videoResolution: "2160",
			platform: "Apple TV",
			player: "Infuse",
		});
	});

	it("returns null fields when no Tautulli match found", () => {
		const plex = [plexSession({ ratingKey: "999" })];
		const map = buildTautulliSessionMap([
			tautulliSession({ rating_key: "100" }),
		]);

		const result = enrichSessionsWithTautulli(plex, map);
		expect(result[0]?.audioDecision).toBeNull();
		expect(result[0]?.videoCodec).toBeNull();
		expect(result[0]?.audioCodec).toBeNull();
		expect(result[0]?.videoResolution).toBeNull();
		expect(result[0]?.platform).toBeNull();
		expect(result[0]?.player).toBeNull();
	});

	it("handles multiple sessions with partial Tautulli matches", () => {
		const plex = [
			plexSession({ ratingKey: "100", user: { title: "alice" } }),
			plexSession({ ratingKey: "200", user: { title: "bob" } }),
			plexSession({ ratingKey: "300", user: { title: "charlie" } }),
		];
		const map = buildTautulliSessionMap([
			tautulliSession({ rating_key: "100", platform: "Roku" }),
			tautulliSession({ rating_key: "300", platform: "Android" }),
		]);

		const result = enrichSessionsWithTautulli(plex, map);
		expect(result).toHaveLength(3);
		expect(result[0]?.platform).toBe("Roku");
		expect(result[1]?.platform).toBeNull();
		expect(result[2]?.platform).toBe("Android");
	});

	it("gracefully handles empty Tautulli map", () => {
		const plex = [plexSession()];
		const map = new Map<string, TautulliSessionItem>();

		const result = enrichSessionsWithTautulli(plex, map);
		expect(result).toHaveLength(1);
		expect(result[0]?.platform).toBeNull();
		expect(result[0]?.videoCodec).toBeNull();
	});

	it("formats grandparentTitle correctly", () => {
		const plex = [
			plexSession({ grandparentTitle: "Breaking Bad", title: "Pilot" }),
		];
		const map = new Map<string, TautulliSessionItem>();

		const result = enrichSessionsWithTautulli(plex, map);
		expect(result[0]?.title).toBe("Breaking Bad - Pilot");
	});
});
