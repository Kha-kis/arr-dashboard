import type {
	CrossSeedDiscoveryAvailability,
	CrossSeedDiscoveryResponse,
	LibraryItemType,
	QuiAction,
	QuiActionLogResponse,
	QuiActivityFeedResponse,
	QuiAttentionResponse,
	QuiBulkActionRequest,
	QuiCrossSeedMatch,
	QuiEventLogResponse,
	QuiSummaryResponse,
	QuiTorrent,
	QuiTorrentActionRequest,
} from "@arr/shared";
import { apiRequest } from "./base";

export interface QuiTorrentStateResponse {
	supported: boolean;
	infoHash?: string | null;
	torrent?: QuiTorrent | null;
	siblings?: QuiCrossSeedMatch[];
	quiInstanceId?: string;
	quiInstanceLabel?: string;
	reason?: string;
}

export interface QuiTorrentStateRequest {
	arrInstanceId: string;
	arrItemId: number;
	itemType: LibraryItemType;
}

export async function fetchTorrentState(
	body: QuiTorrentStateRequest,
): Promise<QuiTorrentStateResponse> {
	return apiRequest<QuiTorrentStateResponse>("/api/qui/library-item/torrent-state", {
		method: "POST",
		json: body,
	});
}

export async function fetchCrossSeedAvailability(): Promise<CrossSeedDiscoveryAvailability> {
	return apiRequest<CrossSeedDiscoveryAvailability>("/api/qui/cross-seed/availability");
}

export interface CrossSeedDiscoveryParams {
	cursor?: string | null;
	batchSize?: number;
}

export async function fetchCrossSeedDiscoveryBatch(
	params: CrossSeedDiscoveryParams = {},
): Promise<CrossSeedDiscoveryResponse> {
	const search = new URLSearchParams();
	if (params.cursor) search.set("cursor", params.cursor);
	if (params.batchSize) search.set("batchSize", String(params.batchSize));
	const qs = search.toString();
	return apiRequest<CrossSeedDiscoveryResponse>(
		`/api/qui/cross-seed/discover${qs ? `?${qs}` : ""}`,
	);
}

export interface QuiActivityFeedParams {
	cursor?: string | null;
	limit?: number;
	eventType?: string;
}

export async function fetchQuiActivityFeed(
	params: QuiActivityFeedParams = {},
): Promise<QuiActivityFeedResponse> {
	const search = new URLSearchParams();
	if (params.cursor) search.set("cursor", params.cursor);
	if (params.limit) search.set("limit", String(params.limit));
	if (params.eventType) search.set("eventType", params.eventType);
	const qs = search.toString();
	return apiRequest<QuiActivityFeedResponse>(`/api/qui/activity${qs ? `?${qs}` : ""}`);
}

// ── Phase 4 — action mutations + per-user audit log feed ───────────────

export interface QuiActionLogParams {
	cursor?: string | null;
	limit?: number;
	action?: QuiAction;
	status?: "pending" | "success" | "failed";
}

export async function fetchQuiActionLog(
	params: QuiActionLogParams = {},
): Promise<QuiActionLogResponse> {
	const search = new URLSearchParams();
	if (params.cursor) search.set("cursor", params.cursor);
	if (params.limit) search.set("limit", String(params.limit));
	if (params.action) search.set("action", params.action);
	if (params.status) search.set("status", params.status);
	const qs = search.toString();
	return apiRequest<QuiActionLogResponse>(`/api/qui/actions${qs ? `?${qs}` : ""}`);
}

export interface SingleTorrentActionArgs extends QuiTorrentActionRequest {
	quiInstanceId: string;
	qbitInstanceId: number;
	hash: string;
	action: QuiAction;
}

export interface QuiActionResponseShape {
	status: "success";
	logRowCount: number;
}

/** Phase 4.1 — POST a single-torrent action. */
export async function postQuiTorrentAction({
	quiInstanceId,
	qbitInstanceId,
	hash,
	action,
	tags,
}: SingleTorrentActionArgs): Promise<QuiActionResponseShape> {
	return apiRequest<QuiActionResponseShape>(
		`/api/qui/instances/${quiInstanceId}/qbit/${qbitInstanceId}/torrents/${hash}/actions/${action}`,
		{ method: "POST", json: { tags } },
	);
}

export interface BulkTorrentActionArgs extends QuiBulkActionRequest {
	quiInstanceId: string;
	qbitInstanceId: number;
	action: QuiAction;
}

/** Phase 4.2 — POST a bulk action against many hashes. */
export async function postQuiBulkAction({
	quiInstanceId,
	qbitInstanceId,
	action,
	hashes,
	tags,
}: BulkTorrentActionArgs): Promise<QuiActionResponseShape> {
	return apiRequest<QuiActionResponseShape>(
		`/api/qui/instances/${quiInstanceId}/qbit/${qbitInstanceId}/torrents/bulk-action/${action}`,
		{ method: "POST", json: { hashes, tags } },
	);
}

// ── Phase 5 — webhook secret rotation, registration, event feed ────────

export interface QuiWebhookConfigResponse {
	hasSecret: boolean;
	webhookUrl: string;
	/** Plaintext secret; only present on rotate. */
	secret?: string;
}

export async function fetchQuiWebhookConfig(): Promise<QuiWebhookConfigResponse> {
	return apiRequest<QuiWebhookConfigResponse>("/api/qui/webhook-config");
}

export async function rotateQuiWebhookSecret(): Promise<QuiWebhookConfigResponse> {
	return apiRequest<QuiWebhookConfigResponse>("/api/qui/webhook-config/rotate", {
		method: "POST",
		json: {},
	});
}

export interface RegisterQuiWebhookArgs {
	quiInstanceId: string;
	secret: string;
	eventTypes?: string[];
}

export async function registerQuiWebhook({
	quiInstanceId,
	secret,
	eventTypes,
}: RegisterQuiWebhookArgs): Promise<{ ok: boolean; quiTargetId?: number }> {
	// `quiTargetId` is a number on the wire — qui's openapi declares it as
	// `integer`, and the backend forwards `created.id` verbatim from qui's
	// response. An earlier version of this client typed it as `string`,
	// which caused the Settings panel to call `.slice()` on a number (which
	// runtime-coerces in JS but is a TypeScript lie).
	return apiRequest<{ ok: boolean; quiTargetId?: number }>(
		`/api/qui/instances/${quiInstanceId}/webhook-config/register`,
		{ method: "POST", json: { secret, eventTypes } },
	);
}

export interface QuiEventLogParams {
	cursor?: string | null;
	limit?: number;
}

export async function fetchQuiEventLog(
	params: QuiEventLogParams = {},
): Promise<QuiEventLogResponse> {
	const search = new URLSearchParams();
	if (params.cursor) search.set("cursor", params.cursor);
	if (params.limit) search.set("limit", String(params.limit));
	const qs = search.toString();
	return apiRequest<QuiEventLogResponse>(`/api/qui/events${qs ? `?${qs}` : ""}`);
}

// ── qui home page surfaces (Phase 6 — single pane of glass) ────────────

export async function fetchQuiSummary(): Promise<QuiSummaryResponse> {
	return apiRequest<QuiSummaryResponse>("/api/qui/summary");
}

export interface QuiAttentionParams {
	limit?: number;
}

export async function fetchQuiAttention(
	params: QuiAttentionParams = {},
): Promise<QuiAttentionResponse> {
	const search = new URLSearchParams();
	if (params.limit) search.set("limit", String(params.limit));
	const qs = search.toString();
	return apiRequest<QuiAttentionResponse>(`/api/qui/attention${qs ? `?${qs}` : ""}`);
}

export interface QuiBackfillNowResult {
	usersScanned: number;
	rowsScanned: number;
	rowsHashed: number;
	rowsMissed: number;
	errors: number;
	durationMs: number;
}

/**
 * Manually trigger the path-correlation infoHash backfill pass. Same code
 * the scheduler runs every 6h, but synchronous on demand. Resolves when
 * the sweep completes (or after the route's 5000-row cap is exhausted).
 */
export async function runQuiBackfillNow(): Promise<QuiBackfillNowResult> {
	return apiRequest<QuiBackfillNowResult>("/api/qui/backfill/run-now", {
		method: "POST",
		json: {},
	});
}
