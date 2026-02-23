/**
 * Tautulli Shared Types
 *
 * Minimal types for Tautulli integration — response shapes and cache data.
 */

/** Tautulli server info (from get_tautulli_info) */
export interface TautulliInfo {
	tautulli_version: string;
}

/** Tautulli library section (from get_libraries) */
export interface TautulliLibrary {
	section_id: string;
	section_name: string;
	section_type: string; // "movie" | "show" | "artist"
	count: string;
}

/** Tautulli history item (from get_history) */
export interface TautulliHistoryItem {
	rating_key: string;
	parent_rating_key: string;
	grandparent_rating_key: string;
	title: string;
	grandparent_title: string;
	media_type: string; // "movie" | "episode"
	user: string;
	date: number; // Unix timestamp
	play_count?: number;
}
