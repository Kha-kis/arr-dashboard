/**
 * Tautulli API Client
 *
 * Standalone client for Tautulli's query-param authenticated API.
 * Tautulli uses `?apikey=KEY&cmd=COMMAND` instead of X-Api-Key headers.
 */

import type { FastifyBaseLogger } from "fastify";
import type { ClientInstanceData } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";

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
		return this.command<TautulliInfo>("get_tautulli_info");
	}

	/**
	 * Get all Tautulli libraries.
	 */
	async getLibraries(): Promise<TautulliLibrary[]> {
		return this.command<TautulliLibrary[]>("get_libraries");
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
		return this.command<TautulliHistoryData>("get_history", params);
	}

	/**
	 * Get metadata for a specific item, including GUIDs (TMDB, IMDB, etc.).
	 */
	async getMetadata(ratingKey: string): Promise<TautulliMetadata> {
		return this.command<TautulliMetadata>("get_metadata", { rating_key: ratingKey });
	}

	/**
	 * Execute a Tautulli API command.
	 * Tautulli API format: GET /api/v2?apikey=KEY&cmd=COMMAND&param1=val1
	 */
	private async command<T>(cmd: string, params?: Record<string, unknown>): Promise<T> {
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

		const response = await fetch(url.toString(), {
			headers: { Accept: "application/json" },
			signal: AbortSignal.timeout(this.timeout),
		});

		if (!response.ok) {
			this.log.warn({ status: response.status, cmd }, "Tautulli API non-OK response");
			throw new Error(`Tautulli API error: HTTP ${response.status} ${response.statusText}`);
		}

		const json = (await response.json()) as TautulliResponse<T>;

		if (json.response.result !== "success") {
			throw new Error(`Tautulli API error: ${json.response.message ?? "Unknown error"}`);
		}

		return json.response.data;
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
