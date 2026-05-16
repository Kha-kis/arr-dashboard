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

export interface QuiDirScanTriggerResult {
	runId: number;
	directoryId: number;
	directoryPath: string;
	scanRoot: string;
	scanPath: string;
}

/**
 * Ask qui to search for a cross-seed of a stuck library item. qui matches
 * the item's on-disk path against its configured dir-scan directories,
 * starts a scan, and if a tracker has a matching torrent, downloads the
 * .torrent and adds it to qBit pointing at the existing file. The next
 * inode-backfill sweep correlates the new torrent automatically.
 *
 * Prerequisite: qui must have a dir-scan directory configured that
 * covers the library item's path (e.g., `/data/media/movies` for a movie
 * in that subtree). If not, the request returns 404.
 */
export interface TriggerCrossSeedSearchArgs {
	arrInstanceId: string;
	arrItemId: number;
	itemType: "movie" | "series" | "artist" | "author";
	quiInstanceId?: string;
}

export async function triggerQuiCrossSeedSearch(
	args: TriggerCrossSeedSearchArgs,
): Promise<QuiDirScanTriggerResult> {
	return apiRequest<QuiDirScanTriggerResult>("/api/qui/dirscan/trigger", {
		method: "POST",
		json: args,
	});
}

/**
 * One torrent copy inside a cluster. A cluster has 1..N copies (e.g. a
 * season pack across 4 trackers = 4 copies). Copies are sorted with
 * `role: "library"` (Sonarr/Radarr-imported) first, then by tracker name.
 */
export interface SeriesTorrentCopy {
	infoHash: string;
	name: string | null;
	state: string | null;
	category: string | null;
	/**
	 * "library" — Sonarr/Radarr imported it (categories like `tv`, `movies`,
	 * `tv.cross`). "cross-seed" — qui's cross-seed automation injected it
	 * under the `cross-seed-link` category (or it lives under `/links/`).
	 */
	role: "library" | "cross-seed";
	/** Tracker name parsed from qui's hardlink layout savePath; null when not parseable. */
	tracker: string | null;
	/**
	 * Announce URL hostnames from qBit's per-torrent tracker list (DHT/PeX/LSD
	 * filtered out). Authoritative for brand identification — independent of
	 * savePath and tags. Multiple entries when the torrent is multi-tracker;
	 * first known brand wins for pill rendering.
	 */
	trackerHostnames: string[];
	trackerHealth: "unregistered" | "tracker_down" | null;
	ratio: number | null;
	savePath: string | null;
	tags: string[];
	/** Unix seconds. Null when qui reports 0 (unset). */
	addedOn: number | null;
	/** Seconds in seeding state. */
	seedingTime: number | null;
	/** qBit's torrent size (BigInt string). */
	torrentSizeBytes: string | null;
	numSeeds: number | null;
	numLeechs: number | null;
	progress: number | null;
	instanceName: string | null;
	quiUnreachable: boolean;
}

/**
 * A content cluster — one set of episodes covered by N torrent copies
 * (cross-seeds + the library import all share files via hardlinks).
 * Replaces the old per-torrent rows with redundant sibling lists.
 */
export interface SeriesTorrentCluster {
	/** Deterministic id for React keys — sorted episode-file-id signature. */
	key: string;
	/** Sonarr episode_file_ids this cluster covers. */
	episodeFileIds: number[];
	episodeCount: number;
	seasons: number[];
	/** Pre-rendered label: "S02 · 8 episodes" / "S03E04 · 1 episode". */
	coverageLabel: string;
	/** Total bytes across episodes (BigInt string). */
	totalSizeBytes: string;
	qualityName: string | null;
	releaseGroup: string | null;
	inodeVerified: boolean;
	copies: SeriesTorrentCopy[];
	/** True when every copy has 0 peers AND ratio<1 — actionable signal. */
	isDormant: boolean;
	/** Aggregate state for the cluster header. */
	primaryState: string | null;
	/**
	 * Cross-reference: when this cluster's coverage is a STRICT subset of
	 * another cluster, that superset cluster is referenced here so the UI
	 * can render "↳ also covered by [superset]" annotations on REPACKs /
	 * per-episode releases shadowed by a season pack. Null when no
	 * superset cluster exists (a separate single-episode release with its
	 * own inode never lands in any cluster's coverage, so the cross-ref
	 * claim is provably accurate by construction).
	 */
	coveredBy: {
		clusterKey: string;
		coverageLabel: string;
		copyCount: number;
	} | null;
}

/**
 * Season-level navigational group — top-level structure for the panel.
 * Each group lists clusters contributing to this season + stuck episodes
 * (no torrent at all) for the inline "missing release" display.
 */
export interface SeriesSeasonGroup {
	seasonNumber: number;
	totalEpisodes: number;
	correlatedEpisodes: number;
	stuckEpisodes: number;
	/** Cluster keys belonging to this season. Multi-season packs appear in multiple groups. */
	clusterKeys: string[];
	stuckEpisodeFiles: Array<{
		arrEpisodeFileId: number;
		relativePath: string;
	}>;
}

/**
 * An actionable signal for the panel header. The UI surfaces these as a
 * compact list at the top so users see what to DO, not just what exists.
 */
export interface SeriesActionItem {
	kind: "stuck_episodes" | "stale_cache_healed" | "dormant_content" | "fs_unavailable";
	severity: "warning" | "info";
	title: string;
	detail: string;
	count?: number;
}

export interface SeriesEpisodeFile {
	arrEpisodeFileId: number;
	relativePath: string;
	sizeBytes: string;
	qualityName: string | null;
	releaseGroup: string | null;
	infoHash: string | null;
	infoHashSource: string | null;
}

export interface SeriesSeason {
	seasonNumber: number;
	episodeCount: number;
	correlatedCount: number;
	episodes: SeriesEpisodeFile[];
}

export interface SeriesTorrentsResponse {
	seriesTitle: string;
	totalEpisodes: number;
	correlatedEpisodes: number;
	viaInodeEpisodes: number;
	stuckEpisodes: number;
	/** How many stale cached infoHashes were auto-healed during this load. */
	healedEpisodes: number;
	actionItems: SeriesActionItem[];
	clusters: SeriesTorrentCluster[];
	seasonGroups: SeriesSeasonGroup[];
}

/**
 * Per-series episode-correlation summary + distinct torrents covering
 * those episodes. Drives the SeriesTorrentsPanel in the library detail
 * modal — replaces the movies-only TorrentHealthPanel for series rows.
 */
export async function fetchSeriesTorrents(args: {
	arrInstanceId: string;
	arrItemId: number;
}): Promise<SeriesTorrentsResponse> {
	return apiRequest<SeriesTorrentsResponse>(
		`/api/qui/series/${encodeURIComponent(args.arrInstanceId)}/${args.arrItemId}/torrents`,
	);
}
