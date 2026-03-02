/**
 * Plex Shared Types
 *
 * Types for Plex integration — watch enrichment, sessions, sections, episodes, collections.
 */

// ============================================================================
// Watch Enrichment (F1)
// ============================================================================

export interface WatchEnrichmentItem {
	lastWatchedAt: string | null;
	watchCount: number;
	watchedByUsers: string[];
	onDeck: boolean;
	userRating: number | null;
	source: "plex" | "tautulli" | "both";
	/** Plex ratingKey for write-back operations (null if not available) */
	ratingKey: string | null;
	/** Instance ID of the Plex instance this item belongs to */
	instanceId: string | null;
	/** Plex collections this item belongs to */
	collections: string[];
	/** Plex labels applied to this item */
	labels: string[];
}

export interface WatchEnrichmentResponse {
	items: Record<string, WatchEnrichmentItem>;
}

// ============================================================================
// Sections (F2)
// ============================================================================

export interface PlexSection {
	sectionId: string;
	sectionTitle: string;
	mediaType: string;
	instanceId: string;
	instanceName: string;
}

export interface PlexSectionsResponse {
	sections: PlexSection[];
}

// ============================================================================
// Now Playing / Sessions (F4)
// ============================================================================

export interface PlexSessionPlayer {
	title: string;
	platform: string;
	product: string;
	state: string;
}

export interface PlexSessionUser {
	id: number;
	title: string;
	thumb?: string;
}

export interface PlexSession {
	sessionKey: string;
	ratingKey: string;
	title: string;
	grandparentTitle?: string;
	type: string;
	user: PlexSessionUser;
	player: PlexSessionPlayer;
	state: "playing" | "paused" | "buffering";
	viewOffset: number;
	duration: number;
	videoDecision: string;
	audioDecision: string;
	bandwidth?: number;
	thumb?: string;
	instanceId: string;
	instanceName: string;
}

export interface PlexNowPlayingResponse {
	sessions: PlexSession[];
	totalBandwidth: number;
}

// ============================================================================
// Episode Watch Status (F6)
// ============================================================================

export interface PlexEpisodeStatus {
	seasonNumber: number;
	episodeNumber: number;
	title: string;
	watched: boolean;
	watchedByUsers: string[];
	lastWatchedAt: string | null;
}

export interface PlexEpisodeStatusResponse {
	showTmdbId: number;
	episodes: PlexEpisodeStatus[];
}

// ============================================================================
// Collections & Labels (F8)
// ============================================================================

export interface PlexTagItem {
	name: string;
	count: number;
}

export interface PlexTagsResponse {
	collections: PlexTagItem[];
	labels: PlexTagItem[];
}

export interface PlexTagUpdateRequest {
	type: "collection" | "label";
	action: "add" | "remove";
	name: string;
}

// ============================================================================
// Scan (F3)
// ============================================================================

export interface PlexScanResponse {
	success: boolean;
	message: string;
}
