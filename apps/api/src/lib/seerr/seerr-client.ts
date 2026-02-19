/**
 * Seerr API Client
 *
 * Typed wrapper around ArrClientFactory.rawRequest() for Seerr's REST API (v1).
 * Seerr (merged Jellyseerr + Overseerr) uses `/api/v1/*` endpoints with
 * `X-Api-Key` header authentication — same auth pattern as *arr apps.
 */

import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ArrClientFactory, ClientInstanceData } from "../arr/client-factory.js";
import { requireInstance } from "../arr/instance-helpers.js";
import { AppValidationError } from "../errors.js";
import type {
	SeerrIssue,
	SeerrIssueComment,
	SeerrIssueParams,
	SeerrNotificationAgent,
	SeerrPageResult,
	SeerrQuota,
	SeerrRequest,
	SeerrRequestCount,
	SeerrRequestParams,
	SeerrStatus,
	SeerrUser,
	SeerrUserParams,
	SeerrUserUpdateData,
} from "@arr/shared";

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
// Client Implementation
// ============================================================================

export class SeerrClient {
	private readonly factory: ArrClientFactory;
	private readonly instance: ClientInstanceData;
	private readonly log: FastifyBaseLogger;

	constructor(factory: ArrClientFactory, instance: ClientInstanceData, log: FastifyBaseLogger) {
		this.factory = factory;
		this.instance = instance;
		this.log = log;
	}

	// --- Private HTTP helpers ---

	/** Read error body (truncated) for inclusion in error messages */
	private async readErrorBody(response: Response): Promise<string> {
		const body = await response.text().catch(() => "");
		return body ? ` — ${body.slice(0, 500)}` : "";
	}

	private async get<T>(path: string): Promise<T> {
		const response = await this.factory.rawRequest(this.instance, path);
		if (!response.ok) {
			const detail = await this.readErrorBody(response);
			throw new Error(
				`Seerr GET ${path} failed: ${response.status} ${response.statusText}${detail}`,
			);
		}
		return (await response.json()) as T;
	}

	private async post<T>(path: string, body?: unknown): Promise<T> {
		const response = await this.factory.rawRequest(this.instance, path, {
			method: "POST",
			body,
		});
		if (!response.ok) {
			const detail = await this.readErrorBody(response);
			throw new Error(
				`Seerr POST ${path} failed: ${response.status} ${response.statusText}${detail}`,
			);
		}
		return (await response.json()) as T;
	}

	private async postNoContent(path: string, body?: unknown): Promise<void> {
		const response = await this.factory.rawRequest(this.instance, path, {
			method: "POST",
			body,
		});
		if (!response.ok) {
			const detail = await this.readErrorBody(response);
			throw new Error(
				`Seerr POST ${path} failed: ${response.status} ${response.statusText}${detail}`,
			);
		}
	}

	private async put<T>(path: string, body?: unknown): Promise<T> {
		const response = await this.factory.rawRequest(this.instance, path, {
			method: "PUT",
			body,
		});
		if (!response.ok) {
			const detail = await this.readErrorBody(response);
			throw new Error(
				`Seerr PUT ${path} failed: ${response.status} ${response.statusText}${detail}`,
			);
		}
		return (await response.json()) as T;
	}

	private async del(path: string): Promise<void> {
		const response = await this.factory.rawRequest(this.instance, path, {
			method: "DELETE",
		});
		if (!response.ok) {
			const detail = await this.readErrorBody(response);
			throw new Error(
				`Seerr DELETE ${path} failed: ${response.status} ${response.statusText}${detail}`,
			);
		}
	}

	// --- Requests ---

	async getRequests(params?: SeerrRequestParams): Promise<SeerrPageResult<SeerrRequest>> {
		const qs = buildQueryString(params);
		return this.get(`/api/v1/request${qs}`);
	}

	async getRequestCount(): Promise<SeerrRequestCount> {
		return this.get("/api/v1/request/count");
	}

	async approveRequest(requestId: number): Promise<SeerrRequest> {
		return this.post(`/api/v1/request/${requestId}/approve`);
	}

	async declineRequest(requestId: number): Promise<SeerrRequest> {
		return this.post(`/api/v1/request/${requestId}/decline`);
	}

	async deleteRequest(requestId: number): Promise<void> {
		return this.del(`/api/v1/request/${requestId}`);
	}

	async retryRequest(requestId: number): Promise<SeerrRequest> {
		return this.post(`/api/v1/request/${requestId}/retry`);
	}

	// --- Users ---

	async getUsers(params?: SeerrUserParams): Promise<SeerrPageResult<SeerrUser>> {
		const qs = buildQueryString(params);
		return this.get(`/api/v1/user${qs}`);
	}

	async getUserQuota(userId: number): Promise<SeerrQuota> {
		return this.get(`/api/v1/user/${userId}/quota`);
	}

	async updateUser(userId: number, data: SeerrUserUpdateData): Promise<SeerrUser> {
		return this.put(`/api/v1/user/${userId}`, data);
	}

	// --- Issues ---

	async getIssues(params?: SeerrIssueParams): Promise<SeerrPageResult<SeerrIssue>> {
		const qs = buildQueryString(params);
		return this.get(`/api/v1/issue${qs}`);
	}

	async addIssueComment(issueId: number, message: string): Promise<SeerrIssueComment> {
		return this.post(`/api/v1/issue/${issueId}/comment`, { message });
	}

	async updateIssueStatus(issueId: number, status: "open" | "resolved"): Promise<SeerrIssue> {
		return this.post(`/api/v1/issue/${issueId}/${status}`);
	}

	// --- Notifications ---

	async getNotificationAgents(): Promise<SeerrNotificationAgent[]> {
		const settled = await Promise.allSettled(
			KNOWN_NOTIFICATION_AGENTS.map(({ id, name }) =>
				this.get<{ enabled: boolean; types: number; options: Record<string, unknown> }>(
					`/api/v1/settings/notifications/${id}`,
				).then((data) => ({ id, name, ...data })),
			),
		);

		const agents: SeerrNotificationAgent[] = [];
		for (let i = 0; i < settled.length; i++) {
			const result = settled[i]!;
			if (result.status === "fulfilled") {
				agents.push(result.value);
			} else {
				// 404 = agent not supported by this Seerr version, skip silently
				const is404 = result.reason instanceof Error && result.reason.message.includes(" 404 ");
				if (!is404) {
					const agentName = KNOWN_NOTIFICATION_AGENTS[i]!.name;
					this.log.warn(
						{ err: result.reason },
						`Seerr: failed to fetch notification agent "${agentName}"`,
					);
				}
			}
		}
		return agents;
	}

	async updateNotificationAgent(
		agentId: string,
		config: Partial<SeerrNotificationAgent>,
	): Promise<SeerrNotificationAgent> {
		return this.post(`/api/v1/settings/notifications/${agentId}`, config);
	}

	async testNotificationAgent(agentId: string): Promise<void> {
		await this.postNoContent(`/api/v1/settings/notifications/${agentId}/test`);
	}

	// --- TMDB Media Lookups (for enriching requests with poster/title) ---

	async getMovieDetails(tmdbId: number): Promise<{ posterPath?: string; title?: string }> {
		const data = await this.get<{ posterPath?: string; title?: string }>(`/api/v1/movie/${tmdbId}`);
		return { posterPath: data.posterPath, title: data.title };
	}

	async getTvDetails(tmdbId: number): Promise<{ posterPath?: string; title?: string }> {
		const data = await this.get<{ posterPath?: string; name?: string }>(`/api/v1/tv/${tmdbId}`);
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
		for (const outcome of settled) {
			if (outcome.status === "fulfilled") {
				mediaMap.set(outcome.value.key, outcome.value.details);
			} else {
				enrichmentFailures++;
			}
		}
		if (enrichmentFailures > 0) {
			this.log.warn(
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

	// --- System ---

	async getStatus(): Promise<SeerrStatus> {
		return this.get("/api/v1/status");
	}

	async getAbout(): Promise<{ version: string; totalRequests: number; totalMediaItems: number }> {
		return this.get("/api/v1/status/appdata");
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
	return new SeerrClient(app.arrClientFactory, instance, app.log);
}
