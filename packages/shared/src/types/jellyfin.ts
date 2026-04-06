/**
 * Jellyfin Shared Types
 *
 * Types for Jellyfin integration — sessions, now-playing, cache health.
 */

// ============================================================================
// Now Playing / Sessions
// ============================================================================

export interface JellyfinSessionInfo {
	sessionId: string;
	title: string;
	seriesName?: string;
	type: string;
	user: string;
	player: string;
	deviceName: string;
	state: "playing" | "paused" | "buffering";
	viewOffset: number;
	duration: number;
	videoDecision: string;
	audioDecision: string;
	bandwidth?: number;
	videoCodec?: string;
	audioCodec?: string;
	thumb?: string;
	instanceId: string;
	instanceName: string;
}

export interface JellyfinNowPlayingResponse {
	sessions: JellyfinSessionInfo[];
	totalBandwidth: number;
}
