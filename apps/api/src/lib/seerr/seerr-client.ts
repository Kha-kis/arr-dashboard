/**
 * Seerr API Client
 *
 * Typed wrapper around ArrClientFactory.rawRequest() for Seerr's REST API (v1).
 * Seerr (merged Jellyseerr + Overseerr) uses `/api/v1/*` endpoints with
 * `X-Api-Key` header authentication — same auth pattern as *arr apps.
 */

import type { ArrClientFactory, ClientInstanceData } from "../arr/client-factory.js";

// ============================================================================
// Response Types
// ============================================================================

export interface SeerrMediaInfo {
	id: number;
	tmdbId: number;
	tvdbId?: number;
	status: number;
	createdAt: string;
	updatedAt: string;
}

export interface SeerrRequest {
	id: number;
	status: number; // 1=pending, 2=approved, 3=declined
	type: "movie" | "tv";
	media: SeerrMediaInfo;
	createdAt: string;
	updatedAt: string;
	requestedBy: SeerrUser;
	modifiedBy?: SeerrUser;
	is4k: boolean;
	serverId?: number;
	profileId?: number;
	rootFolder?: string;
	languageProfileId?: number;
	tags?: number[];
	seasons?: SeerrSeason[];
	mediaInfo?: {
		posterPath?: string;
		title?: string;
		originalTitle?: string;
		overview?: string;
	};
}

export interface SeerrSeason {
	id: number;
	seasonNumber: number;
	status: number;
}

export interface SeerrRequestCount {
	total: number;
	movie: number;
	tv: number;
	pending: number;
	approved: number;
	declined: number;
	processing: number;
	available: number;
}

export interface SeerrUser {
	id: number;
	email?: string;
	displayName: string;
	avatar?: string;
	createdAt: string;
	updatedAt: string;
	permissions: number;
	requestCount: number;
	movieQuotaLimit?: number;
	movieQuotaDays?: number;
	tvQuotaLimit?: number;
	tvQuotaDays?: number;
	userType: number;
}

export interface SeerrQuota {
	movie: { used: number; remaining: number; restricted: boolean; limit: number; days: number };
	tv: { used: number; remaining: number; restricted: boolean; limit: number; days: number };
}

export interface SeerrIssue {
	id: number;
	issueType: number; // 1=video, 2=audio, 3=subtitle, 4=other
	status: number; // 1=open, 2=resolved
	problemSeason: number;
	problemEpisode: number;
	createdAt: string;
	updatedAt: string;
	createdBy: SeerrUser;
	comments: SeerrIssueComment[];
	media: SeerrMediaInfo & {
		posterPath?: string;
		title?: string;
	};
}

export interface SeerrIssueComment {
	id: number;
	message: string;
	createdAt: string;
	user: SeerrUser;
}

export interface SeerrNotificationAgent {
	id: number;
	name: string;
	enabled: boolean;
	types: number;
	options: Record<string, unknown>;
}

export interface SeerrStatus {
	version: string;
	commitTag: string;
	updateAvailable: boolean;
	commitsBehind: number;
}

export interface SeerrPageResult<T> {
	pageInfo: { pages: number; pageSize: number; results: number; page: number };
	results: T[];
}

// ============================================================================
// Request Parameter Types
// ============================================================================

export interface SeerrRequestParams {
	take?: number;
	skip?: number;
	filter?: "all" | "approved" | "available" | "pending" | "processing" | "unavailable" | "failed";
	sort?: "added" | "modified";
	requestedBy?: number;
}

export interface SeerrIssueParams {
	take?: number;
	skip?: number;
	filter?: "all" | "open" | "resolved";
	sort?: "added" | "modified";
}

export interface SeerrUserParams {
	take?: number;
	skip?: number;
	sort?: "created" | "updated" | "displayname" | "requests";
}

export interface SeerrUserUpdateData {
	permissions?: number;
	movieQuotaLimit?: number | null;
	movieQuotaDays?: number | null;
	tvQuotaLimit?: number | null;
	tvQuotaDays?: number | null;
}

// ============================================================================
// Client Implementation
// ============================================================================

export class SeerrClient {
	private readonly factory: ArrClientFactory;
	private readonly instance: ClientInstanceData;

	constructor(factory: ArrClientFactory, instance: ClientInstanceData) {
		this.factory = factory;
		this.instance = instance;
	}

	// --- Private HTTP helpers ---

	private async get<T>(path: string): Promise<T> {
		const response = await this.factory.rawRequest(this.instance, path);
		if (!response.ok) {
			throw new Error(`Seerr GET ${path} failed: ${response.status} ${response.statusText}`);
		}
		return (await response.json()) as T;
	}

	private async post<T>(path: string, body?: unknown): Promise<T> {
		const response = await this.factory.rawRequest(this.instance, path, {
			method: "POST",
			body,
		});
		if (!response.ok) {
			throw new Error(`Seerr POST ${path} failed: ${response.status} ${response.statusText}`);
		}
		return (await response.json()) as T;
	}

	private async put<T>(path: string, body?: unknown): Promise<T> {
		const response = await this.factory.rawRequest(this.instance, path, {
			method: "PUT",
			body,
		});
		if (!response.ok) {
			throw new Error(`Seerr PUT ${path} failed: ${response.status} ${response.statusText}`);
		}
		return (await response.json()) as T;
	}

	private async del(path: string): Promise<void> {
		const response = await this.factory.rawRequest(this.instance, path, {
			method: "DELETE",
		});
		if (!response.ok) {
			throw new Error(`Seerr DELETE ${path} failed: ${response.status} ${response.statusText}`);
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
		const result = await this.get<SeerrNotificationAgent[]>("/api/v1/settings/notifications");
		return result;
	}

	async updateNotificationAgent(
		agentId: string,
		config: Partial<SeerrNotificationAgent>,
	): Promise<SeerrNotificationAgent> {
		return this.post(`/api/v1/settings/notifications/${agentId}`, config);
	}

	async testNotificationAgent(agentId: string): Promise<{ success: boolean }> {
		return this.post(`/api/v1/settings/notifications/${agentId}/test`);
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
	const entries = Object.entries(params as Record<string, unknown>).filter(([, v]) => v !== undefined);
	if (entries.length === 0) return "";
	const qs = new URLSearchParams();
	for (const [key, value] of entries) {
		qs.set(key, String(value));
	}
	return `?${qs.toString()}`;
}

/**
 * Factory function — called from routes after requireInstance().
 */
export function createSeerrClient(
	factory: ArrClientFactory,
	instance: ClientInstanceData,
): SeerrClient {
	return new SeerrClient(factory, instance);
}
