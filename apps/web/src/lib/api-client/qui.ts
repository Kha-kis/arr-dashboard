import type {
	CrossSeedDiscoveryAvailability,
	CrossSeedDiscoveryResponse,
	LibraryItemType,
	QuiActivityFeedResponse,
	QuiCrossSeedMatch,
	QuiTorrent,
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
