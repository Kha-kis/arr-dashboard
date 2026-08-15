import type {
	TautulliHistoryItem,
	TautulliHistorySnapshot,
	TautulliHomeStat,
	TautulliInfo,
	TautulliLibrary,
	TautulliUser,
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
	tautulliServerInfoSchema,
	tautulliServersInfoSchema,
	tautulliUserSchema,
	tautulliUserWatchTimeStatsSchema,
} from "./tautulli-schemas.js";

const DEFAULT_TIMEOUT = 10_000;
const DEFAULT_HISTORY_PAGE_SIZE = 500;
const MAX_HISTORY_PAGE_SIZE = 1_000;
export const MAX_TAUTULLI_HISTORY_PAGE_LENGTH = 500;
export const MAX_TAUTULLI_HISTORY_RESULTS = 100_000;

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

export interface TautulliHistoryPageOptions {
	start: number;
	length: number;
	sectionId?: string;
}

export type TautulliClientInstanceData = Omit<ClientInstanceData, "service"> & {
	service: "TAUTULLI";
};

export interface TautulliServerIdentity {
	identifier: string;
	displayName?: string;
}

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
	private readonly beforeRequest?: () => Promise<void>;

	constructor(
		baseUrl: string,
		apiKey: string,
		log: FastifyBaseLogger,
		timeout = DEFAULT_TIMEOUT,
		httpAuthHeaders: Record<string, string> = {},
		beforeRequest?: () => Promise<void>,
	) {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.apiKey = apiKey;
		this.log = log;
		this.timeout = timeout;
		this.httpAuthHeaders = httpAuthHeaders;
		this.beforeRequest = beforeRequest;
	}

	getInfo(): Promise<TautulliInfo> {
		return this.command("get_tautulli_info", undefined, tautulliInfoSchema);
	}

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
			if (servers.length !== 1) throw new Error("ambiguous fallback identity");
			const fallbackServer = servers[0]!;
			const fallbackIdentifier = fallbackServer.machine_identifier.trim();
			if (!fallbackIdentifier) throw new Error("ambiguous fallback identity");
			return {
				identifier: fallbackIdentifier,
				displayName:
					normalizeDisplayName(fallbackServer.name) ??
					normalizeDisplayName(fallbackServer.pms_name),
			};
		} catch {
			throw new Error("Tautulli server identity is unavailable");
		}
	}

	getLibraries(): Promise<TautulliLibrary[]> {
		return this.command("get_libraries", undefined, tautulliLibrarySchema.array());
	}

	getHistory(params?: Record<string, string | number | undefined>): Promise<TautulliHistoryData> {
		return this.command("get_history", params, tautulliHistoryDataSchema);
	}

	/** User-facing history pages use Tautulli's documented date-descending order. */
	getHistoryNewestPage(options: TautulliHistoryPageOptions): Promise<TautulliHistoryData> {
		if (
			!Number.isSafeInteger(options.start) ||
			options.start < 0 ||
			!Number.isSafeInteger(options.length) ||
			options.length < 1 ||
			options.length > MAX_TAUTULLI_HISTORY_PAGE_LENGTH
		) {
			throw new Error(
				`Tautulli history pages require a non-negative start and a length from 1 to ${MAX_TAUTULLI_HISTORY_PAGE_LENGTH}`,
			);
		}

		return this.getHistory({
			section_id: options.sectionId,
			grouping: 0,
			include_activity: 0,
			json_data: JSON.stringify({
				draw: 1,
				columns: [
					{ data: "date", orderable: true, searchable: false },
					{ data: "row_id", orderable: true, searchable: false },
				],
				order: [
					{ column: 0, dir: "desc" },
					{ column: 1, dir: "desc" },
				],
				start: options.start,
				length: options.length,
				search: { value: "" },
			}),
		});
	}

	async getHistorySnapshot(
		options: TautulliHistorySnapshotOptions = {},
	): Promise<TautulliHistorySnapshot> {
		const pageSize = options.pageSize ?? DEFAULT_HISTORY_PAGE_SIZE;
		if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_HISTORY_PAGE_SIZE) {
			throw new Error(
				`Tautulli history pagination must use positive integers, pages of at most ${MAX_HISTORY_PAGE_SIZE}, and scan at most ${MAX_TAUTULLI_HISTORY_RESULTS} rows`,
			);
		}
		const maximumPagesForSize = Math.ceil(MAX_TAUTULLI_HISTORY_RESULTS / pageSize);
		const maxPages = options.maxPages ?? maximumPagesForSize;
		if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > maximumPagesForSize) {
			throw new Error(
				`Tautulli history pagination must use positive integers, pages of at most ${MAX_HISTORY_PAGE_SIZE}, and scan at most ${MAX_TAUTULLI_HISTORY_RESULTS} rows`,
			);
		}

		const items: TautulliHistoryItem[] = [];
		const rowIds = new Set<number>();
		let previousRowId: number | undefined;
		let expectedFiltered: number | undefined;
		let expectedTotal: number | undefined;
		for (let page = 0; page < maxPages; page += 1) {
			const pageStart = page * pageSize;
			const pageLength = Math.min(pageSize, MAX_TAUTULLI_HISTORY_RESULTS - pageStart);
			const data = await this.getHistory({
				section_id: options.section_id,
				grouping: 0,
				include_activity: 0,
				json_data: JSON.stringify({
					draw: 1,
					columns: [{ data: "row_id", orderable: true, searchable: false }],
					order: [{ column: 0, dir: "asc" }],
					start: pageStart,
					length: pageLength,
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

			for (const item of data.data) {
				if (item.row_id === undefined) {
					return createTautulliHistorySnapshot(
						items,
						recordsFiltered,
						recordsTotal,
						false,
						"missing_row_id",
					);
				}
				if (rowIds.has(item.row_id)) {
					return createTautulliHistorySnapshot(
						items,
						recordsFiltered,
						recordsTotal,
						false,
						"duplicate_row_id",
					);
				}
				if (previousRowId !== undefined && item.row_id < previousRowId) {
					return createTautulliHistorySnapshot(
						items,
						recordsFiltered,
						recordsTotal,
						false,
						"unstable_row_id",
					);
				}
				rowIds.add(item.row_id);
				previousRowId = item.row_id;
				items.push(item);
			}
			if (items.length === recordsFiltered) {
				return createTautulliHistorySnapshot(items, recordsFiltered, recordsTotal, true);
			}
			if (items.length > recordsFiltered) {
				return createTautulliHistorySnapshot(
					items,
					recordsFiltered,
					recordsTotal,
					false,
					"unstable_row_id",
				);
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

	getUsers(): Promise<TautulliUser[]> {
		return this.command("get_users", undefined, tautulliUserSchema.array());
	}

	getUserWatchTimeStats(
		userId: string,
		queryDays?: string | number,
	): Promise<TautulliUserWatchTimeStat[]> {
		if (!userId.trim()) {
			throw new Error("Tautulli user watch-time stats require a user id");
		}
		return this.command(
			"get_user_watch_time_stats",
			{ user_id: userId, query_days: queryDays },
			tautulliUserWatchTimeStatsSchema.array(),
		);
	}

	getHomeStats(timeRange = 30, statsCount = 10): Promise<TautulliHomeStat[]> {
		return this.command(
			"get_home_stats",
			{ time_range: timeRange, stats_count: statsCount },
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
		await this.beforeRequest?.();
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
	instance: TautulliClientInstanceData,
	log: FastifyBaseLogger,
	beforeRequest?: () => Promise<void>,
): TautulliClient {
	if (instance.service !== "TAUTULLI") {
		throw new Error("Instance is not a Tautulli service");
	}
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
		beforeRequest,
	);
}
