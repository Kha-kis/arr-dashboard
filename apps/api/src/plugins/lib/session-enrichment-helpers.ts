/**
 * Session Enrichment Helpers
 *
 * Pure functions shaping Plex session snapshots into the EnrichedSession
 * rows stored in sessionsJson. Extracted for testability.
 *
 * 3.0 (ADR-0007): Tautulli-sourced enrichment removed. platform/player/
 * audioDecision now come from Plex natively; videoCodec/audioCodec/
 * videoResolution are null until the Tracearr-era analytics rewrite
 * (charter Bucket C2) re-sources them.
 */

/** Minimal Plex session shape used during snapshot capture */
export interface PlexSessionInput {
	user: { title: string };
	title: string;
	grandparentTitle?: string;
	type?: string;
	ratingKey: string;
	videoDecision?: string | null;
	audioDecision?: string | null;
	bandwidth?: number | null;
	state: string;
	player?: { title?: string | null; platform?: string | null } | null;
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
 * Shape Plex sessions into the EnrichedSession rows stored in
 * sessionsJson. platform/player/audioDecision come from the Plex session
 * natively; codec/resolution fields are null pending the Tracearr-era
 * analytics rewrite (the EnrichedSession shape is unchanged, so all
 * downstream sessionsJson readers keep working).
 */
export function toEnrichedSessions(plexSessions: PlexSessionInput[]): EnrichedSession[] {
	return plexSessions.map((s) => ({
		user: s.user.title,
		title: s.grandparentTitle ? `${s.grandparentTitle} - ${s.title}` : s.title,
		grandparentTitle: s.grandparentTitle,
		mediaType: normalizePlexMediaType(s.type),
		videoDecision: s.videoDecision,
		bandwidth: s.bandwidth ?? 0,
		state: s.state,
		audioDecision: s.audioDecision ?? null,
		videoCodec: null,
		audioCodec: null,
		videoResolution: null,
		platform: s.player?.platform ?? null,
		player: s.player?.title ?? null,
	}));
}
