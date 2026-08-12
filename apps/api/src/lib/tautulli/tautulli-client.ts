import type {
	TautulliHistoryItem,
	TautulliHistorySnapshot,
	TautulliHomeStat,
	TautulliInfo,
	TautulliLibrary,
	TautulliUserWatchTimeStat,
} from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { z } from "zod";
import type { ClientInstanceData } from "../arr/client-factory.js";
import type { Encryptor } from "../auth/encryption.js";
import { getStoredHttpAuthHeaders } from "../services/http-auth.js";
import { parseUpstreamOrThrow } from "../validation/parse-upstream.js";
import { createTautulliHistorySnapshot } from "./tautulli-helpers.js";
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

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_HISTORY_PAGE_SIZE = 500;
const DEFAULT_HISTORY_MAX_PAGES = 100;

export interface TautulliHistoryData {
	data: TautulliHistoryItem[];
	recordsFiltered: number;
	recordsTotal: number;
}

export interface TautulliMetadata {
	guids: string[];
	media_type: string;
	title: string;
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
	series: Array<{ name: string; data: number[] }>;
}

export interface TautulliHistorySnapshotOptions {
	pageSize?: number;
	maxPages?: number;
	section_id?: string;
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

	getInfo(): Promise<TautulliInfo> {
		return this.command("get_tautulli_info", undefined, tautulliInfoSchema);
	}

	getLibraries(): Promise<TautulliLibrary[]> {
		return this.command("get_libraries", undefined, tautulliLibrarySchema.array());
	}

	getHistory(params?: Record<string, string | number | undefined>): Promise<TautulliHistoryData> {
		return this.command("get_history", params, tautulliHistoryDataSchema);
	}

	async getHistorySnapshot(
		options: TautulliHistorySnapshotOptions = {},
	): Promise<TautulliHistorySnapshot> {
		const pageSize = options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
		const maxPages = options.maxPages ?? DEFAULT_HISTORY_MAX_PAGES;
		if (
			!Number.isInteger(pageSize) ||
			pageSize < 1 ||
			!Number.isInteger(maxPages) ||
			maxPages < 1
		) {
			throw new Error("Tautulli history pagination options must be positive integers");
		}

		const items: TautulliHistoryItem[] = [];
		let expectedFiltered: number | undefined;
		let expectedTotal: number | undefined;
		for (let page = 0; page < maxPages; page += 1) {
			const data = await this.getHistory({
				section_id: options.section_id,
				grouping: 0,
				include_activity: 0,
				json_data: JSON.stringify({
					draw: 1,
					columns: [{ data: "row_id", orderable: true, searchable: false }],
					order: [{ column: 0, dir: "asc" }],
					start: page * pageSize,
					length: pageSize,
					search: { value: "" },
				}),
			});
			if (expectedFiltered === undefined) {
				expectedFiltered = data.recordsFiltered;
				expectedTotal = data.recordsTotal;
			} else if (data.recordsFiltered !== expectedFiltered || data.recordsTotal !== expectedTotal) {
				return createTautulliHistorySnapshot(
					items,
					expectedFiltered,
					expectedTotal ?? data.recordsTotal,
					false,
					"upstream_total_changed",
				);
			}
			const recordsFiltered = expectedFiltered ?? data.recordsFiltered;
			const recordsTotal = expectedTotal ?? data.recordsTotal;

			items.push(...data.data);
			if (items.length >= recordsFiltered) {
				return createTautulliHistorySnapshot(items, recordsFiltered, recordsTotal, true);
			}
			if (data.data.length === 0) {
				return createTautulliHistorySnapshot(
					items,
					recordsFiltered,
					recordsTotal,
					false,
					"empty_page",
				);
			}
		}

		return createTautulliHistorySnapshot(
			items,
			expectedFiltered ?? 0,
			expectedTotal ?? 0,
			false,
			"page_limit_reached",
		);
	}

	getActivity(): Promise<TautulliActivityData> {
		return this.command("get_activity", undefined, tautulliActivityDataSchema);
	}

	getPlaysByDate(timeRange = 30): Promise<TautulliPlaysByDateData> {
		return this.command(
			"get_plays_by_date",
			{ time_range: timeRange },
			tautulliPlaysByDateDataSchema,
		);
	}

	getUserWatchTimeStats(userId?: string): Promise<TautulliUserWatchTimeStat[]> {
		return this.command(
			"get_user_watch_time_stats",
			{ user_id: userId },
			tautulliUserWatchTimeStatsSchema.array(),
		);
	}

	getHomeStats(timeRange = 30): Promise<TautulliHomeStat[]> {
		return this.command(
			"get_home_stats",
			{ time_range: timeRange },
			tautulliHomeStatSchema.array(),
		);
	}

	getMetadata(ratingKey: string): Promise<TautulliMetadata> {
		return this.command("get_metadata", { rating_key: ratingKey }, tautulliMetadataSchema);
	}

	private async command<T>(
		cmd: string,
		params: Record<string, string | number | undefined> | undefined,
		schema: z.ZodType<T>,
	): Promise<T> {
		const url = new URL(`${this.baseUrl}/api/v2`);
		url.searchParams.set("apikey", this.apiKey);
		url.searchParams.set("cmd", cmd);
		for (const [key, value] of Object.entries(params ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}

		let response: Response;
		try {
			response = await fetch(url.toString(), {
				headers: { Accept: "application/json", ...this.httpAuthHeaders },
				signal: AbortSignal.timeout(this.timeout),
			});
		} catch {
			throw new Error(`Tautulli API connection error for cmd=${cmd}`);
		}

		if (!response.ok) {
			this.log.warn({ status: response.status, cmd }, "Tautulli API non-OK response");
			throw new Error(`Tautulli API error: HTTP ${response.status}`);
		}

		let raw: unknown;
		try {
			raw = await response.json();
		} catch {
			throw new Error(`Tautulli API invalid JSON response for cmd=${cmd}`);
		}

		const wrapper = parseUpstreamOrThrow(raw, tautulliResponseWrapperSchema, {
			integration: "tautulli",
			category: cmd,
		});
		if (wrapper.response.result !== "success") {
			throw new Error(`Tautulli API returned an error for cmd=${cmd}`);
		}
		return parseUpstreamOrThrow(wrapper.response.data, schema, {
			integration: "tautulli",
			category: cmd,
		});
	}
}

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
