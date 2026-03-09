/**
 * Tautulli API Client
 *
 * Standalone client for Tautulli's query-param authenticated API.
 * Tautulli uses `?apikey=KEY&cmd=COMMAND` instead of X-Api-Key headers.
 */

import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { ClientInstanceData } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { parseUpstreamOrThrow } from "../validation/parse-upstream.js";
import {
	tautulliActivityDataSchema,
	tautulliHistoryDataSchema,
	tautulliHomeStatSchema,
	tautulliInfoSchema,
	tautulliLibrarySchema,
	tautulliMetadataSchema,
	tautulliPlaysByDateDataSchema,
	tautulliResponseWrapperSchema,
	tautulliUserWatchTimeStatsSchema,
} from "./tautulli-schemas.js";

// ============================================================================
// Response Types
// ============================================================================

export interface TautulliResponse<T> {
	response: {
		result: "success" | "error";
		message: string | null;
		data: T;
	};
}

export interface TautulliInfo {
	tautulli_version: string;
}

export interface TautulliLibrary {
	section_id: string;
	section_name: string;
	section_type: string; // "movie" | "show" | "artist"
	count: string;
}

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

export interface TautulliHistoryData {
	data: TautulliHistoryItem[];
	recordsFiltered: number;
	recordsTotal: number;
}

export interface TautulliMetadata {
	guids: string[]; // e.g. ["tmdb://12345", "imdb://tt1234567"]
	media_type: string;
	title: string;
	rating_key: string;
}

export interface TautulliSessionItem {
	session_key: string;
	rating_key: string;
	title: string;
	grandparent_title?: string;
	media_type: string;
	user: string;
	friendly_name: string;
	player: string;
	platform: string;
	product: string;
	state: string;
	progress_percent: string;
	transcode_decision: string;
	stream_video_decision: string;
	stream_audio_decision: string;
	video_resolution: string;
	audio_codec: string;
	video_codec: string;
	bandwidth: string;
	location: string;
	thumb?: string;
}

export interface TautulliActivityData {
	sessions: TautulliSessionItem[];
	stream_count: string;
	total_bandwidth: number;
	lan_bandwidth: number;
	wan_bandwidth: number;
}

export interface TautulliPlaysByDateData {
	categories: string[];
	series: Array<{
		name: string;
		data: number[];
	}>;
}

export interface TautulliUserWatchTimeStats {
	user_id: number;
	friendly_name: string;
	total_plays: number;
	total_duration: number;
}

export interface TautulliHomeStat {
	stat_id: string;
	stat_title: string;
	rows: Array<{
		title: string;
		friendly_name?: string;
		total_plays: number;
		total_duration: number;
		platform?: string;
		thumb?: string;
	}>;
}

// ============================================================================
// Client Implementation
// ============================================================================

const DEFAULT_TIMEOUT = 10_000;

export class TautulliClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly log: FastifyBaseLogger;
	private readonly timeout: number;

	constructor(baseUrl: string, apiKey: string, log: FastifyBaseLogger, timeout = DEFAULT_TIMEOUT) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.apiKey = apiKey;
		this.log = log;
		this.timeout = timeout;
	}

	/**
	 * Get Tautulli server info (used for connection testing).
	 */
	async getInfo(): Promise<TautulliInfo> {
		return this.command("get_tautulli_info", undefined, tautulliInfoSchema);
	}

	/**
	 * Get all Tautulli libraries.
	 */
	async getLibraries(): Promise<TautulliLibrary[]> {
		return this.command("get_libraries", undefined, z.array(tautulliLibrarySchema));
	}

	/**
	 * Get watch history with optional filtering.
	 */
	async getHistory(params?: {
		rating_key?: string;
		length?: number;
		start?: number;
		section_id?: string;
	}): Promise<TautulliHistoryData> {
		return this.command("get_history", params, tautulliHistoryDataSchema);
	}

	/**
	 * Get current activity (active sessions).
	 */
	async getActivity(): Promise<TautulliActivityData> {
		return this.command("get_activity", undefined, tautulliActivityDataSchema);
	}

	/**
	 * Get play counts by date for time-series charts.
	 */
	async getPlaysByDate(timeRange?: number): Promise<TautulliPlaysByDateData> {
		return this.command("get_plays_by_date", {
			time_range: timeRange ?? 30,
		}, tautulliPlaysByDateDataSchema);
	}

	/**
	 * Get watch time statistics per user.
	 */
	async getUserWatchTimeStats(userId?: string): Promise<TautulliUserWatchTimeStats[]> {
		return this.command("get_user_watch_time_stats", {
			user_id: userId,
		}, z.array(tautulliUserWatchTimeStatsSchema));
	}

	/**
	 * Get home statistics (most watched, top users, top platforms).
	 */
	async getHomeStats(timeRange?: number): Promise<TautulliHomeStat[]> {
		return this.command("get_home_stats", {
			time_range: timeRange ?? 30,
		}, z.array(tautulliHomeStatSchema));
	}

	/**
	 * Get metadata for a specific item, including GUIDs (TMDB, IMDB, etc.).
	 */
	async getMetadata(ratingKey: string): Promise<TautulliMetadata> {
		return this.command("get_metadata", { rating_key: ratingKey }, tautulliMetadataSchema);
	}

	/**
	 * Execute a Tautulli API command.
	 * Tautulli API format: GET /api/v2?apikey=KEY&cmd=COMMAND&param1=val1
	 */
	private async command<T>(
		cmd: string,
		params?: Record<string, unknown>,
		schema?: z.ZodType<T>,
	): Promise<T> {
		const url = new URL(`${this.baseUrl}/api/v2`);
		url.searchParams.set("apikey", this.apiKey);
		url.searchParams.set("cmd", cmd);

		if (params) {
			for (const [key, value] of Object.entries(params)) {
				if (value !== undefined && value !== null) {
					url.searchParams.set(key, String(value));
				}
			}
		}

		let response: Response;
		try {
			response = await fetch(url.toString(), {
				headers: { Accept: "application/json" },
				signal: AbortSignal.timeout(this.timeout),
			});
		} catch (err) {
			// Sanitize error to avoid leaking API key from URL in error messages
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`Tautulli API connection error for cmd=${cmd}: ${message.replace(/apikey=[^&]+/, "apikey=***")}`);
		}

		if (!response.ok) {
			this.log.warn({ status: response.status, cmd }, "Tautulli API non-OK response");
			throw new Error(`Tautulli API error: HTTP ${response.status} ${response.statusText}`);
		}

		const raw = await response.json();

		// Validate wrapper structure
		const wrapper = tautulliResponseWrapperSchema.parse(raw);

		if (wrapper.response.result !== "success") {
			throw new Error(`Tautulli API error: ${wrapper.response.message ?? "Unknown error"}`);
		}

		// Validate inner data if schema provided
		if (schema) {
			return parseUpstreamOrThrow(wrapper.response.data, schema, { integration: "tautulli", category: cmd });
		}
		return wrapper.response.data as T;
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a TautulliClient with decrypted API key from an encrypted instance.
 */
export function createTautulliClient(
	encryptor: Encryptor,
	instance: ClientInstanceData,
	log: FastifyBaseLogger,
): TautulliClient {
	const apiKey = encryptor.decrypt({
		value: instance.encryptedApiKey,
		iv: instance.encryptionIv,
	});

	return new TautulliClient(instance.baseUrl, apiKey, log);
}
