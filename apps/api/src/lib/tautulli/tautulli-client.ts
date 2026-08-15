/**
 * Tautulli API Client
 *
 * Standalone client for Tautulli's query-param authenticated API.
 * Tautulli uses `?apikey=KEY&cmd=COMMAND` instead of X-Api-Key headers.
 */

import type { TautulliHistoryItem, TautulliInfo, TautulliLibrary } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import { z } from "zod";
import type { ClientInstanceData } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
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
	tautulliServerInfoSchema,
	tautulliServersInfoSchema,
	tautulliUserWatchTimeStatsSchema,
} from "./tautulli-schemas.js";

// ============================================================================
// Response Types
// ============================================================================

export interface TautulliHistoryData {
	data: TautulliHistoryItem[];
	recordsFiltered: number;
	recordsTotal: number;
}

export interface TautulliMetadata {
	guids: string[]; // e.g. ["tmdb://12345", "imdb://tt1234567"]
	media_type: string;
	title: string;
	// Optional — Tautulli omits this when the rating_key isn't in its database
	// (e.g., item deleted from Plex). Callers already have the rating_key as
	// the request arg, so the response copy is informational only.
	rating_key?: string;
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

export interface TautulliServerIdentity {
	identifier: string;
	displayName?: string;
}

// ============================================================================
// Client Implementation
// ============================================================================

const DEFAULT_TIMEOUT = 10_000;

function normalizeDisplayName(value: string | undefined): string | undefined {
	const displayName = value?.trim();
	return displayName || undefined;
}

export class TautulliClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly log: FastifyBaseLogger;
	private readonly timeout: number;
	private readonly httpAuthHeaders: Record<string, string>;

	constructor(
		baseUrl: string,
		apiKey: string,
		log: FastifyBaseLogger,
		timeout = DEFAULT_TIMEOUT,
		httpAuthHeaders: Record<string, string> = {},
	) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.apiKey = apiKey;
		this.log = log;
		this.timeout = timeout;
		this.httpAuthHeaders = httpAuthHeaders;
	}

	/**
	 * Get Tautulli server info (used for connection testing).
	 */
	async getInfo(): Promise<TautulliInfo> {
		return this.command("get_tautulli_info", undefined, tautulliInfoSchema);
	}

	/**
	 * Read the linked Plex Media Server identity.
	 *
	 * `get_server_info.pms_identifier` is authoritative. Older Tautulli
	 * versions may omit it, so a single non-empty `get_servers_info`
	 * `machine_identifier` is accepted as a compatibility fallback only.
	 */
	async getServerIdentity(): Promise<TautulliServerIdentity> {
		try {
			const serverInfo = await this.command("get_server_info", undefined, tautulliServerInfoSchema);
			const primaryIdentifier = serverInfo.pms_identifier?.trim();
			if (primaryIdentifier) {
				return {
					identifier: primaryIdentifier,
					displayName: normalizeDisplayName(serverInfo.pms_name),
				};
			}

			const servers = await this.command("get_servers_info", undefined, tautulliServersInfoSchema);
			const candidates = servers
				.map((server) => ({
					identifier: server.machine_identifier.trim(),
					displayName: normalizeDisplayName(server.pms_name),
				}))
				.filter((server) => server.identifier.length > 0);
			if (candidates.length !== 1) throw new Error("ambiguous fallback identity");
			return candidates[0]!;
		} catch {
			// The upstream identity and response details are intentionally internal.
			throw new Error("Tautulli server identity is unavailable");
		}
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
		order_column?: "date" | "row_id";
		order_dir?: "asc" | "desc";
		grouping?: 0;
		include_activity?: 0;
	}): Promise<TautulliHistoryData> {
		if (params?.order_column === "row_id") {
			const {
				length = 25,
				start = 0,
				order_dir: orderDir = "desc",
				order_column: _orderColumn,
				...filters
			} = params;
			// Tautulli's shorthand order_column allowlist omits row_id. Supplying
			// DataTables json_data declares the selected row_id alias so its query
			// builder emits a real, unique ORDER BY for safe offset pagination.
			const jsonData = JSON.stringify({
				draw: 1,
				columns: [{ data: "row_id", orderable: true, searchable: false }],
				order: [{ column: 0, dir: orderDir }],
				start,
				length,
				search: { value: "" },
			});
			return this.command(
				"get_history",
				{ ...filters, json_data: jsonData },
				tautulliHistoryDataSchema,
			);
		}

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
		return this.command(
			"get_plays_by_date",
			{
				time_range: timeRange ?? 30,
			},
			tautulliPlaysByDateDataSchema,
		);
	}

	/**
	 * Get watch time statistics per user.
	 */
	async getUserWatchTimeStats(userId?: string): Promise<TautulliUserWatchTimeStats[]> {
		return this.command(
			"get_user_watch_time_stats",
			{
				user_id: userId,
			},
			z.array(tautulliUserWatchTimeStatsSchema),
		);
	}

	/**
	 * Get home statistics (most watched, top users, top platforms).
	 */
	async getHomeStats(timeRange?: number): Promise<TautulliHomeStat[]> {
		return this.command(
			"get_home_stats",
			{
				time_range: timeRange ?? 30,
			},
			z.array(tautulliHomeStatSchema),
		);
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

		// URL.toString() emits form-urlencoded `+` for spaces in query params.
		// Strict upstream URL parsers can reject `+` as a reserved character
		// (see issue #470 for the Seerr equivalent). Normalise to RFC 3986
		// `%20` in the query portion only — current callers never pass spaces,
		// so this is preemptive hardening for future ones.
		const safeUrl = `${url.origin}${url.pathname}${url.search.replace(/\+/g, "%20")}${url.hash}`;

		let response: Response;
		try {
			response = await fetch(safeUrl, {
				headers: { Accept: "application/json", ...this.httpAuthHeaders },
				signal: AbortSignal.timeout(this.timeout),
			});
		} catch (err) {
			// Sanitize error to avoid leaking API key from URL in error messages
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Tautulli API connection error for cmd=${cmd}: ${message.replace(/apikey=[^&]+/, "apikey=***")}`,
			);
		}

		if (!response.ok) {
			this.log.warn({ status: response.status, cmd }, "Tautulli API non-OK response");
			throw new Error(`Tautulli API error: HTTP ${response.status} ${response.statusText}`);
		}

		let raw: unknown;
		try {
			raw = await response.json();
		} catch {
			throw new Error(`Tautulli API: invalid JSON response for cmd=${cmd}`);
		}

		// Validate wrapper structure
		const wrapper = parseUpstreamOrThrow(raw, tautulliResponseWrapperSchema, {
			integration: "tautulli",
			category: cmd,
		});

		if (wrapper.response.result !== "success") {
			throw new Error(`Tautulli API error: ${wrapper.response.message ?? "Unknown error"}`);
		}

		// Validate inner data — schema is required for all Tautulli commands
		if (!schema) {
			throw new Error(`Tautulli API: schema required for command responses (cmd: ${cmd})`);
		}
		return parseUpstreamOrThrow(wrapper.response.data, schema, {
			integration: "tautulli",
			category: cmd,
		});
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

	return new TautulliClient(
		instance.baseUrl,
		apiKey,
		log,
		DEFAULT_TIMEOUT,
		getStoredHttpAuthHeaders(encryptor, instance),
	);
}
