/**
 * Session Enrichment Helpers
 *
 * Pure functions for merging Tautulli session data (codec, resolution, platform)
 * into Plex session snapshots. Extracted for testability.
 */

import type { TautulliSessionItem } from "../../lib/tautulli/tautulli-client.js";

/** Minimal Plex session shape used during snapshot capture */
export interface PlexSessionInput {
	user: { title: string };
	title: string;
	grandparentTitle?: string;
	type?: string;
	ratingKey: string;
	videoDecision?: string | null;
	bandwidth?: number | null;
	state: string;
}

/** Normalized media type for leaderboard aggregation */
export type SessionMediaType = "movie" | "series" | "music" | "other";

/** Enriched session entry stored in sessionsJson */
export interface EnrichedSession {
	user: string;
	title: string;
	/** Show/album name when applicable; absent for movies */
	grandparentTitle?: string;
	/** Normalized media type for cross-service aggregation */
	mediaType?: SessionMediaType;
	videoDecision: string | null | undefined;
	bandwidth: number;
	state: string;
	audioDecision: string | null;
	videoCodec: string | null;
	audioCodec: string | null;
	videoResolution: string | null;
	platform: string | null;
	player: string | null;
}

/** Map a Plex session `type` field to a normalized media type. */
export function normalizePlexMediaType(type: string | undefined): SessionMediaType {
	switch (type) {
		case "movie":
			return "movie";
		case "episode":
		case "show":
		case "season":
			return "series";
		case "track":
		case "album":
			return "music";
		default:
			return "other";
	}
}

/** Map a Jellyfin item `Type` field to a normalized media type. */
export function normalizeJellyfinMediaType(type: string | undefined): SessionMediaType {
	switch (type) {
		case "Movie":
			return "movie";
		case "Episode":
		case "Series":
		case "Season":
			return "series";
		case "Audio":
		case "MusicAlbum":
		case "MusicVideo":
			return "music";
		default:
			return "other";
	}
}

/**
 * Build a lookup map from Tautulli sessions keyed by rating_key.
 * If multiple Tautulli sessions share a rating_key (unlikely but possible),
 * the last one wins — this is acceptable since rating_key is per-item.
 */
export function buildTautulliSessionMap(
	sessions: TautulliSessionItem[],
): Map<string, TautulliSessionItem> {
	const map = new Map<string, TautulliSessionItem>();
	for (const session of sessions) {
		if (session.rating_key) {
			map.set(session.rating_key, session);
		}
	}
	return map;
}

/**
 * Enrich Plex sessions with Tautulli codec/resolution/platform data.
 *
 * Matches by ratingKey ↔ rating_key. If no Tautulli match is found,
 * the extra fields are set to null for backward compatibility.
 */
export function enrichSessionsWithTautulli(
	plexSessions: PlexSessionInput[],
	tautulliMap: Map<string, TautulliSessionItem>,
): EnrichedSession[] {
	return plexSessions.map((s) => {
		const tautulli = tautulliMap.get(s.ratingKey);

		return {
			user: s.user.title,
			title: s.grandparentTitle ? `${s.grandparentTitle} - ${s.title}` : s.title,
			grandparentTitle: s.grandparentTitle,
			mediaType: normalizePlexMediaType(s.type),
			videoDecision: s.videoDecision,
			bandwidth: s.bandwidth ?? 0,
			state: s.state,
			audioDecision: tautulli?.stream_audio_decision ?? null,
			videoCodec: tautulli?.video_codec ?? null,
			audioCodec: tautulli?.audio_codec ?? null,
			videoResolution: tautulli?.video_resolution ?? null,
			platform: tautulli?.platform ?? null,
			player: tautulli?.player ?? null,
		};
	});
}
