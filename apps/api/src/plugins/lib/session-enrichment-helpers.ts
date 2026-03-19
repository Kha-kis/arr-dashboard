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
	ratingKey: string;
	videoDecision?: string | null;
	bandwidth?: number | null;
	state: string;
}

/** Enriched session entry stored in sessionsJson */
export interface EnrichedSession {
	user: string;
	title: string;
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
