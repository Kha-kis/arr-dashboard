import type { LibraryItemType, QuiCrossSeedMatch, QuiTorrent } from "@arr/shared";
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
