/**
 * Seerr API Client
 *
 * Typed wrapper around ArrClientFactory.rawRequest() for Seerr's REST API (v1).
 * Seerr (merged Jellyseerr + Overseerr) uses `/api/v1/*` endpoints with
 * `X-Api-Key` header authentication — same auth pattern as *arr apps.
 *
 * Resilience layers:
 * 1. Circuit breaker — fail-fast when instance is unreachable
 * 2. Retry with exponential backoff — handles transient 5xx / 429 / network errors
 * 3. Structured errors (SeerrApiError) — typed status codes and retry metadata
 */

import {
	type SeerrCreateRequestPayload,
	type SeerrCreateRequestResponse,
	type SeerrDiscoverParams,
	type SeerrDiscoverResponse,
	type SeerrGenre,
	type SeerrIssue,
	type SeerrIssueComment,
	type SeerrIssueParams,
	type SeerrMovieDetails,
	type SeerrNotificationAgent,
	type SeerrPageResult,
	type SeerrQuota,
	type SeerrRequest,
	type SeerrRequestCount,
	type SeerrRequestOptions,
	type SeerrRequestParams,
	type SeerrSearchParams,
	type SeerrServerWithDetails,
	type SeerrServiceServer,
	type SeerrStatus,
	type SeerrTvDetails,
	type SeerrUser,
	type SeerrUserParams,
	type SeerrUserUpdateData,
	seerrCreateRequestResponseSchema,
	seerrDiscoverResponseSchema,
	seerrGenreSchema,
	seerrIssueCommentSchema,
	seerrIssueSchema,
	seerrMediaSummarySchema,
	seerrMovieDetailsSchema,
	seerrPageResultSchema,
	seerrQuotaSchema,
	seerrRequestCountSchema,
	seerrRequestSchema,
	seerrServerWithDetailsSchema,
	seerrServiceServerSchema,
	seerrStatusSchema,
	seerrTvDetailsSchema,
	seerrUserSchema,
} from "@arr/shared";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { z } from "zod";
import type { ArrClientFactory, ClientInstanceData } from "../arr/client-factory.js";
import { requireInstance } from "../arr/instance-helpers.js";
import { AppValidationError, SeerrApiError } from "../errors.js";
import { parseUpstreamOrThrow } from "../validation/parse-upstream.js";
import {
	type SeerrCache,
	GENRE_TTL_MS,
	ISSUE_COUNT_TTL_MS,
	genreCacheKey,
	issueCountCacheKey,
} from "./seerr-cache.js";
import type { SeerrCircuitBreaker } from "./seerr-circuit-breaker.js";
import { withSeerrRetry } from "./seerr-retry.js";

// ============================================================================
// Timeout Constants (milliseconds)
// ============================================================================

/** Interactive queries — status, lists, users, issues, notification agents */
const TIMEOUT_INTERACTIVE = 10_000;

/** User-triggered actions — approve, decline, retry, delete, comment, status update */
const TIMEOUT_ACTION = 10_000;

/** TMDB media detail lookups */
const TIMEOUT_MEDIA_DETAIL = 10_000;

// ============================================================================
// Known Notification Agents
// ============================================================================

export const KNOWN_NOTIFICATION_AGENT_IDS = [
	"discord",
	"email",
	"gotify",
	"lunasea",
	"ntfy",
	"pushbullet",
	"pushover",
	"slack",
	"telegram",
	"webhook",
	"webpush",
] as const;

export type KnownNotificationAgentId = (typeof KNOWN_NOTIFICATION_AGENT_IDS)[number];

const KNOWN_NOTIFICATION_AGENTS: readonly { id: KnownNotificationAgentId; name: string }[] = [
	{ id: "discord", name: "Discord" },
	{ id: "email", name: "Email" },
	{ id: "gotify", name: "Gotify" },
	{ id: "lunasea", name: "LunaSea" },
	{ id: "ntfy", name: "ntfy" },
	{ id: "pushbullet", name: "Pushbullet" },
	{ id: "pushover", name: "Pushover" },
	{ id: "slack", name: "Slack" },
	{ id: "telegram", name: "Telegram" },
	{ id: "webhook", name: "Webhook" },
	{ id: "webpush", name: "Web Push" },
] as const;

// ============================================================================
// Lightweight Schemas (client-internal, not shared)
// ============================================================================

/** Schema for the raw notification agent response from Seerr's API (before id/name are injected) */
const seerrNotificationAgentRawSchema = z.looseObject({
	enabled: z.boolean(),
	types: z.number(),
	options: z.record(z.string(), z.unknown()),
});

/** Schema for TMDB media detail lookups — only validates the fields we extract */
const seerrMediaDetailSchema = z.looseObject({
	posterPath: z.string().nullable().optional(),
	title: z.string().optional(),
	name: z.string().optional(),
});

// ============================================================================
// Client Implementation
// ============================================================================

export class SeerrClient {
	private readonly factory: ArrClientFactory;
	private readonly instance: ClientInstanceData;
	private readonly log: FastifyBaseLogger;
	private readonly circuitBreaker?: SeerrCircuitBreaker;
	private readonly cache?: SeerrCache;

	constructor(
		factory: ArrClientFactory,
		instance: ClientInstanceData,
		log: FastifyBaseLogger,
		circuitBreaker?: SeerrCircuitBreaker,
		cache?: SeerrCache,
	) {
		this.factory = factory;
		this.instance = instance;
		this.log = log;
		this.circuitBreaker = circuitBreaker;
		this.cache = cache;
	}

	// --- Private Validation Helper ---

	/** Parse raw data with a Zod schema and record validation health.
	 *  Uses explicit return type `T` to handle z.looseObject() index signature mismatches. */
	private parseAndRecord<T>(raw: unknown, schema: z.ZodType, category: string): T {
		return parseUpstreamOrThrow(raw, schema, { integration: "seerr", category }) as T;
	}

	// --- Private HTTP helpers ---

	/** Read error body (truncated) for inclusion in error messages */
	private async readErrorBody(response: Response): Promise<string> {
		const body = await response.text().catch((err) => {
			this.log.debug({ err }, "Seerr: failed to read error response body");
			return "";
		});
		return body ? ` — ${body.slice(0, 500)}` : "";
	}

	/** Parse Retry-After header (supports delta-seconds and HTTP-date formats) */
	private parseRetryAfter(response: Response): number | undefined {
		const header = response.headers.get("retry-after");
		if (!header) return undefined;

		// Try as integer (seconds)
		const seconds = Number.parseInt(header, 10);
		if (!Number.isNaN(seconds) && seconds > 0) {
			return seconds * 1000;
		}

		// Try as HTTP-date
		const date = Date.parse(header);
		if (!Number.isNaN(date)) {
			const ms = date - Date.now();
			return ms > 0 ? ms : undefined;
		}

		return undefined;
	}

	/**
	 * Core HTTP request method with circuit breaker, retry, and structured errors.
	 * All public methods delegate to this via get/post/put/del helpers.
	 */
	private async request<T>(
		method: string,
		path: string,
		opts?: { body?: unknown; timeout?: number; parseBody?: boolean },
	): Promise<T> {
		const timeout = opts?.timeout ?? TIMEOUT_INTERACTIVE;
		const parseBody = opts?.parseBody ?? true;
		const instanceId = this.instance.id;

		// Circuit breaker check (throws CircuitBreakerOpenError if open)
		this.circuitBreaker?.check(instanceId);

		const execute = async (): Promise<T> => {
			let response: Response;
			try {
				response = await this.factory.rawRequest(this.instance, path, {
					method,
					body: opts?.body,
					timeout,
				});
			} catch (error) {
				// Network / timeout errors from rawRequest
				if (error instanceof Error) {
					const msg = error.message.toLowerCase();
					if (msg.includes("abort") || msg.includes("timeout")) {
						throw SeerrApiError.timeout(`Seerr ${method} ${path} timed out after ${timeout}ms`);
					}
					throw SeerrApiError.network(`Seerr ${method} ${path} network error: ${error.message}`);
				}
				throw error;
			}

			if (!response.ok) {
				const detail = await this.readErrorBody(response);
				const retryAfterMs = this.parseRetryAfter(response);
				throw new SeerrApiError(
					`Seerr ${method} ${path} failed: ${response.status} ${response.statusText}${detail}`,
					{ seerrStatus: response.status, retryAfterMs },
				);
			}

			if (!parseBody) return undefined as T;
			return (await response.json()) as T;
		};

		try {
			const result = await withSeerrRetry(execute);
			this.circuitBreaker?.reportSuccess(instanceId);
			return result;
		} catch (error) {
			// Report failure to circuit breaker for retryable or unknown errors
			if (error instanceof SeerrApiError) {
				if (error.retryable) {
					this.circuitBreaker?.reportFailure(instanceId);
				}
			} else {
				// Unknown error type (not classified as SeerrApiError) — treat as failure
				this.circuitBreaker?.reportFailure(instanceId);
			}
			throw error;
		}
	}

	private get<T>(path: string, timeout?: number): Promise<T> {
		return this.request("GET", path, { timeout });
	}

	private post<T>(path: string, body?: unknown, timeout?: number): Promise<T> {
		return this.request("POST", path, { body, timeout });
	}

	private postNoContent(path: string, body?: unknown, timeout?: number): Promise<void> {
		return this.request("POST", path, { body, timeout, parseBody: false });
	}

	private put<T>(path: string, body?: unknown, timeout?: number): Promise<T> {
		return this.request("PUT", path, { body, timeout });
	}

	private del(path: string, timeout?: number): Promise<void> {
		return this.request("DELETE", path, { timeout, parseBody: false });
	}

	// --- Requests ---

	async getRequests(params?: SeerrRequestParams): Promise<SeerrPageResult<SeerrRequest>> {
		const qs = buildQueryString(params);
		const raw = await this.get<SeerrPageResult<SeerrRequest>>(
			`/api/v1/request${qs}`,
			TIMEOUT_INTERACTIVE,
		);
		return this.parseAndRecord(raw, seerrPageResultSchema(seerrRequestSchema), "getRequests");
	}

	async getRequestCount(): Promise<SeerrRequestCount> {
		const raw = await this.get<SeerrRequestCount>("/api/v1/request/count", TIMEOUT_INTERACTIVE);
		return this.parseAndRecord(raw, seerrRequestCountSchema, "getRequestCount");
	}

	async getRequest(requestId: number): Promise<SeerrRequest> {
		const raw = await this.get<SeerrRequest>(`/api/v1/request/${requestId}`, TIMEOUT_INTERACTIVE);
		return this.parseAndRecord(raw, seerrRequestSchema, "getRequest");
	}

	async approveRequest(requestId: number): Promise<SeerrRequest> {
		const raw = await this.post(`/api/v1/request/${requestId}/approve`, undefined, TIMEOUT_ACTION);
		return this.parseAndRecord(raw, seerrRequestSchema, "approveRequest");
	}

	async declineRequest(requestId: number): Promise<SeerrRequest> {
		const raw = await this.post(`/api/v1/request/${requestId}/decline`, undefined, TIMEOUT_ACTION);
		return this.parseAndRecord(raw, seerrRequestSchema, "declineRequest");
	}

	async deleteRequest(requestId: number): Promise<void> {
		return this.del(`/api/v1/request/${requestId}`, TIMEOUT_ACTION);
	}

	async retryRequest(requestId: number): Promise<SeerrRequest> {
		const raw = await this.post(`/api/v1/request/${requestId}/retry`, undefined, TIMEOUT_ACTION);
		return this.parseAndRecord(raw, seerrRequestSchema, "retryRequest");
	}

	// --- Users ---

	async getUsers(params?: SeerrUserParams): Promise<SeerrPageResult<SeerrUser>> {
		const qs = buildQueryString(params);
		const raw = await this.get<SeerrPageResult<SeerrUser>>(
			`/api/v1/user${qs}`,
			TIMEOUT_INTERACTIVE,
		);
		return this.parseAndRecord(raw, seerrPageResultSchema(seerrUserSchema), "getUsers");
	}

	async getUserQuota(userId: number): Promise<SeerrQuota> {
		const raw = await this.get(`/api/v1/user/${userId}/quota`, TIMEOUT_INTERACTIVE);
		return this.parseAndRecord(raw, seerrQuotaSchema, "getUserQuota");
	}

	async updateUser(userId: number, data: SeerrUserUpdateData): Promise<SeerrUser> {
		const raw = await this.put(`/api/v1/user/${userId}`, data, TIMEOUT_ACTION);
		return this.parseAndRecord(raw, seerrUserSchema, "updateUser");
	}

	// --- Issues ---

	async getIssues(params?: SeerrIssueParams): Promise<SeerrPageResult<SeerrIssue>> {
		const qs = buildQueryString(params);
		const raw = await this.get(`/api/v1/issue${qs}`, TIMEOUT_INTERACTIVE);
		return this.parseAndRecord(raw, seerrPageResultSchema(seerrIssueSchema), "getIssues");
	}

	async addIssueComment(issueId: number, message: string): Promise<SeerrIssueComment> {
		const raw = await this.post(`/api/v1/issue/${issueId}/comment`, { message }, TIMEOUT_ACTION);
		return this.parseAndRecord(raw, seerrIssueCommentSchema, "addIssueComment");
	}

	async updateIssueStatus(issueId: number, status: "open" | "resolved"): Promise<SeerrIssue> {
		const raw = await this.post(`/api/v1/issue/${issueId}/${status}`, undefined, TIMEOUT_ACTION);
		return this.parseAndRecord(raw, seerrIssueSchema, "updateIssueStatus");
	}

	// --- Notifications ---

	async getNotificationAgents(): Promise<SeerrNotificationAgent[]> {
		const settled = await Promise.allSettled(
			KNOWN_NOTIFICATION_AGENTS.map(({ id, name }) =>
				this.get<unknown>(`/api/v1/settings/notifications/${id}`, TIMEOUT_INTERACTIVE).then(
					(raw) => {
						const data = this.parseAndRecord<{
							enabled: boolean;
							types: number;
							options: Record<string, unknown>;
						}>(raw, seerrNotificationAgentRawSchema, "getNotificationAgents");
						return { id, name, ...data };
					},
				),
			),
		);

		const agents: SeerrNotificationAgent[] = [];
		for (let i = 0; i < settled.length; i++) {
			const result = settled[i]!;
			if (result.status === "fulfilled") {
				agents.push(result.value);
			} else {
				// 404 = agent not supported by this Seerr version, skip silently
				const is404 = result.reason instanceof SeerrApiError && result.reason.seerrStatus === 404;
				if (!is404) {
					const agentName = KNOWN_NOTIFICATION_AGENTS[i]!.name;
					this.log.warn(
						{ err: result.reason },
						`Seerr: failed to fetch notification agent "${agentName}"`,
					);
				}
			}
		}
		const failures = settled.length - agents.length;
		if (failures > 0) {
			this.log.info(
				{ loaded: agents.length, total: settled.length, failures },
				"Seerr: notification agents loaded (some may be unsupported or failed)",
			);
		}
		return agents;
	}

	async updateNotificationAgent(
		agentId: string,
		config: Partial<SeerrNotificationAgent>,
	): Promise<SeerrNotificationAgent> {
		const raw = await this.post<unknown>(
			`/api/v1/settings/notifications/${agentId}`,
			config,
			TIMEOUT_ACTION,
		);
		const data = this.parseAndRecord<{
			enabled: boolean;
			types: number;
			options: Record<string, unknown>;
		}>(raw, seerrNotificationAgentRawSchema, "updateNotificationAgent");
		// Inject the known id/name back since the API only returns enabled/types/options
		const agent = KNOWN_NOTIFICATION_AGENTS.find((a) => a.id === agentId);
		return { id: agentId, name: agent?.name ?? agentId, ...data };
	}

	async testNotificationAgent(agentId: string): Promise<void> {
		await this.postNoContent(
			`/api/v1/settings/notifications/${agentId}/test`,
			undefined,
			TIMEOUT_ACTION,
		);
	}

	// --- TMDB Media Lookups (for enriching requests with poster/title) ---

	async getMovieDetails(tmdbId: number): Promise<{ posterPath?: string; title?: string }> {
		const raw = await this.get<unknown>(`/api/v1/movie/${tmdbId}`, TIMEOUT_MEDIA_DETAIL);
		const data = this.parseAndRecord<{ posterPath?: string; title?: string }>(
			raw,
			seerrMediaDetailSchema,
			"getMovieDetails",
		);
		return { posterPath: data.posterPath, title: data.title };
	}

	async getTvDetails(tmdbId: number): Promise<{ posterPath?: string; title?: string }> {
		const raw = await this.get<unknown>(`/api/v1/tv/${tmdbId}`, TIMEOUT_MEDIA_DETAIL);
		const data = this.parseAndRecord<{ posterPath?: string; name?: string }>(
			raw,
			seerrMediaDetailSchema,
			"getTvDetails",
		);
		return { posterPath: data.posterPath, title: data.name };
	}

	async getMediaDetails(
		type: "movie" | "tv",
		tmdbId: number,
	): Promise<{ posterPath?: string; title?: string }> {
		return type === "movie" ? this.getMovieDetails(tmdbId) : this.getTvDetails(tmdbId);
	}

	// --- Media Enrichment ---

	/**
	 * Enrich a page of Seerr requests with poster/title from Seerr's TMDB proxy.
	 * Deduplicates by tmdbId+type so each unique media is fetched only once.
	 */
	async enrichRequestsWithMedia(
		result: SeerrPageResult<SeerrRequest>,
	): Promise<SeerrPageResult<SeerrRequest>> {
		if (result.results.length === 0) return result;

		// Collect unique media lookups (deduplicate by tmdbId + type)
		const lookupKey = (type: string, tmdbId: number) => `${type}:${tmdbId}`;
		const uniqueKeys = new Map<string, { type: "movie" | "tv"; tmdbId: number }>();
		for (const req of result.results) {
			const key = lookupKey(req.type, req.media.tmdbId);
			if (!uniqueKeys.has(key)) {
				uniqueKeys.set(key, { type: req.type, tmdbId: req.media.tmdbId });
			}
		}

		// Fetch all unique media details in parallel
		const mediaMap = new Map<string, { posterPath?: string; title?: string }>();
		const entries = [...uniqueKeys.entries()];
		const settled = await Promise.allSettled(
			entries.map(([key, { type, tmdbId }]) =>
				this.getMediaDetails(type, tmdbId).then((details) => ({ key, details })),
			),
		);

		let enrichmentFailures = 0;
		let firstError: unknown;
		for (const outcome of settled) {
			if (outcome.status === "fulfilled") {
				mediaMap.set(outcome.value.key, outcome.value.details);
			} else {
				enrichmentFailures++;
				firstError ??= outcome.reason;
			}
		}
		if (enrichmentFailures > 0) {
			this.log.warn(
				{ err: firstError },
				`Seerr: ${enrichmentFailures}/${entries.length} media enrichment lookups failed`,
			);
		}

		// Merge poster/title into each request's media object
		const enriched = result.results.map((req) => {
			const details = mediaMap.get(lookupKey(req.type, req.media.tmdbId));
			if (!details) return req;
			return {
				...req,
				media: { ...req.media, posterPath: details.posterPath, title: details.title },
			};
		});

		return { ...result, results: enriched };
	}

	// --- Discovery ---

	async discoverMovies(params?: SeerrDiscoverParams): Promise<SeerrDiscoverResponse> {
		const qs = buildQueryString(params);
		return this.getDiscover(`/api/v1/discover/movies${qs}`);
	}

	async discoverTv(params?: SeerrDiscoverParams): Promise<SeerrDiscoverResponse> {
		const qs = buildQueryString(params);
		return this.getDiscover(`/api/v1/discover/tv${qs}`);
	}

	async discoverTrending(params?: SeerrDiscoverParams): Promise<SeerrDiscoverResponse> {
		const qs = buildQueryString(params);
		return this.getDiscover(`/api/v1/discover/trending${qs}`);
	}

	async discoverMoviesUpcoming(params?: SeerrDiscoverParams): Promise<SeerrDiscoverResponse> {
		const qs = buildQueryString(params);
		return this.getDiscover(`/api/v1/discover/movies/upcoming${qs}`);
	}

	async discoverTvUpcoming(params?: SeerrDiscoverParams): Promise<SeerrDiscoverResponse> {
		const qs = buildQueryString(params);
		return this.getDiscover(`/api/v1/discover/tv/upcoming${qs}`);
	}

	async discoverMoviesByGenre(
		genreId: number,
		params?: SeerrDiscoverParams,
	): Promise<SeerrDiscoverResponse> {
		const qs = buildQueryString(params);
		return this.getDiscover(`/api/v1/discover/movies/genre/${genreId}${qs}`);
	}

	async discoverTvByGenre(
		genreId: number,
		params?: SeerrDiscoverParams,
	): Promise<SeerrDiscoverResponse> {
		const qs = buildQueryString(params);
		return this.getDiscover(`/api/v1/discover/tv/genre/${genreId}${qs}`);
	}

	/** Shared discover fetch with schema validation */
	private async getDiscover(path: string): Promise<SeerrDiscoverResponse> {
		const raw = await this.get<SeerrDiscoverResponse>(path, TIMEOUT_INTERACTIVE);
		return this.parseAndRecord<SeerrDiscoverResponse>(raw, seerrDiscoverResponseSchema, "discover");
	}

	// --- Search ---

	async search(params: SeerrSearchParams): Promise<SeerrDiscoverResponse> {
		const qs = buildQueryString(params);
		return this.getDiscover(`/api/v1/search${qs}`);
	}

	// --- Full Details (with credits, recommendations, etc.) ---

	async getMovieDetailsFull(tmdbId: number): Promise<SeerrMovieDetails> {
		const raw = await this.get(`/api/v1/movie/${tmdbId}`, TIMEOUT_MEDIA_DETAIL);
		return this.parseAndRecord<SeerrMovieDetails>(
			raw,
			seerrMovieDetailsSchema,
			"getMovieDetailsFull",
		);
	}

	async getTvDetailsFull(tmdbId: number): Promise<SeerrTvDetails> {
		const raw = await this.get(`/api/v1/tv/${tmdbId}`, TIMEOUT_MEDIA_DETAIL);
		return this.parseAndRecord<SeerrTvDetails>(raw, seerrTvDetailsSchema, "getTvDetailsFull");
	}

	// --- Genres ---

	async getMovieGenres(): Promise<SeerrGenre[]> {
		const cacheKey = genreCacheKey(this.instance.id, "movie");
		const cached = this.cache?.get<SeerrGenre[]>(cacheKey);
		if (cached) return cached;
		const raw = await this.get("/api/v1/genres/movie", TIMEOUT_INTERACTIVE);
		const genres = this.parseAndRecord<SeerrGenre[]>(
			raw,
			z.array(seerrGenreSchema),
			"getMovieGenres",
		);
		this.cache?.set(cacheKey, genres, GENRE_TTL_MS);
		return genres;
	}

	async getTvGenres(): Promise<SeerrGenre[]> {
		const cacheKey = genreCacheKey(this.instance.id, "tv");
		const cached = this.cache?.get<SeerrGenre[]>(cacheKey);
		if (cached) return cached;
		const raw = await this.get("/api/v1/genres/tv", TIMEOUT_INTERACTIVE);
		const genres = this.parseAndRecord<SeerrGenre[]>(raw, z.array(seerrGenreSchema), "getTvGenres");
		this.cache?.set(cacheKey, genres, GENRE_TTL_MS);
		return genres;
	}

	// --- Create Request ---

	async createRequest(payload: SeerrCreateRequestPayload): Promise<SeerrCreateRequestResponse> {
		const raw = await this.post("/api/v1/request", payload, TIMEOUT_ACTION);
		return this.parseAndRecord<SeerrCreateRequestResponse>(
			raw,
			seerrCreateRequestResponseSchema,
			"createRequest",
		);
	}

	// --- Service Servers (for request options) ---

	async getServiceServers(serviceType: "radarr" | "sonarr"): Promise<SeerrServiceServer[]> {
		const raw = await this.get(`/api/v1/service/${serviceType}`, TIMEOUT_INTERACTIVE);
		return this.parseAndRecord<SeerrServiceServer[]>(
			raw,
			z.array(seerrServiceServerSchema),
			"getServiceServers",
		);
	}

	async getServerDetails(
		serviceType: "radarr" | "sonarr",
		serverId: number,
	): Promise<SeerrServerWithDetails> {
		const raw = await this.get(`/api/v1/service/${serviceType}/${serverId}`, TIMEOUT_INTERACTIVE);
		return this.parseAndRecord<SeerrServerWithDetails>(
			raw,
			seerrServerWithDetailsSchema,
			"getServerDetails",
		);
	}

	async getRequestOptions(mediaType: "movie" | "tv"): Promise<SeerrRequestOptions> {
		const serviceType = mediaType === "movie" ? "radarr" : "sonarr";
		const servers = await this.getServiceServers(serviceType);

		// Fetch full details (profiles, rootFolders, tags) for each server in parallel
		const settled = await Promise.allSettled(
			servers.map((s) => this.getServerDetails(serviceType, s.id)),
		);

		const results: SeerrServerWithDetails[] = [];
		for (let i = 0; i < settled.length; i++) {
			const outcome = settled[i]!;
			if (outcome.status === "fulfilled") {
				results.push(outcome.value);
			} else {
				this.log.warn(
					{ err: outcome.reason },
					`Seerr: failed to fetch details for ${serviceType} server ${servers[i]!.id}`,
				);
			}
		}

		return { servers: results };
	}

	// --- Library Enrichment ---

	/**
	 * Fetch lightweight TMDB summary (vote average + backdrop) for a single media item.
	 * Reuses the same /api/v1/movie/:id and /api/v1/tv/:id endpoints but only extracts
	 * the fields needed for library card badges.
	 */
	async getMediaSummary(
		type: "movie" | "tv",
		tmdbId: number,
	): Promise<{
		voteAverage: number | null;
		backdropPath: string | null;
		posterPath: string | null;
	}> {
		const raw = await this.get(`/api/v1/${type}/${tmdbId}`, TIMEOUT_MEDIA_DETAIL);
		const data = this.parseAndRecord<{
			voteAverage?: number;
			backdropPath?: string;
			posterPath?: string;
		}>(raw, seerrMediaSummarySchema, "getMediaSummary");
		return {
			voteAverage: data.voteAverage ?? null,
			backdropPath: data.backdropPath ?? null,
			posterPath: data.posterPath ?? null,
		};
	}

	/**
	 * Fetch all open issues and aggregate counts by tmdbId.
	 * Returns a Map<string, number> keyed by "movie:{tmdbId}" or "tv:{tmdbId}".
	 *
	 * Seerr's issue API only returns 20 items per page by default.
	 * We paginate up to 500 open issues (25 pages) to cover typical usage.
	 */
	async getOpenIssueCounts(): Promise<Map<string, number>> {
		const cacheKey = issueCountCacheKey(this.instance.id);
		const cached = this.cache?.get<Map<string, number>>(cacheKey);
		if (cached) return cached;

		const counts = new Map<string, number>();
		const take = 20;
		let skip = 0;
		const maxPages = 25;

		for (let page = 0; page < maxPages; page++) {
			const result = await this.getIssues({ filter: "open", take, skip });
			for (const issue of result.results) {
				if (!issue.media?.tmdbId) continue;
				// Use the API-provided mediaType; fall back to tvdbId heuristic
				const mediaType = issue.media.mediaType ?? (issue.media.tvdbId ? "tv" : "movie");
				const key = `${mediaType}:${issue.media.tmdbId}`;
				counts.set(key, (counts.get(key) ?? 0) + 1);
			}
			// Stop if we got fewer than requested (last page)
			if (result.results.length < take) break;
			skip += take;
		}

		this.cache?.set(cacheKey, counts, ISSUE_COUNT_TTL_MS);
		return counts;
	}

	// --- System ---

	async getStatus(): Promise<SeerrStatus> {
		const raw = await this.get<SeerrStatus>("/api/v1/status", TIMEOUT_INTERACTIVE);
		return this.parseAndRecord<SeerrStatus>(raw, seerrStatusSchema, "getStatus");
	}
}

// ============================================================================
// Helpers
// ============================================================================

function buildQueryString(params?: object): string {
	if (!params) return "";
	const entries = Object.entries(params as Record<string, unknown>).filter(
		([, v]) => v !== undefined,
	);
	if (entries.length === 0) return "";
	const qs = new URLSearchParams();
	for (const [key, value] of entries) {
		qs.set(key, String(value));
	}
	return `?${qs.toString()}`;
}

/**
 * Validate instance is a Seerr service and return a ready-to-use client.
 * Replaces the repeated requireInstance() + service check + createSeerrClient() pattern in routes.
 */
export async function requireSeerrClient(
	app: FastifyInstance,
	userId: string,
	instanceId: string,
): Promise<SeerrClient> {
	const instance = await requireInstance(app, userId, instanceId);
	if (instance.service !== "SEERR") {
		throw new AppValidationError("Instance is not a Seerr service");
	}
	return new SeerrClient(
		app.arrClientFactory,
		instance,
		app.log,
		app.seerrCircuitBreaker,
		app.seerrCache,
	);
}
