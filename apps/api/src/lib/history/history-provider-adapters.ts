import type { HistoryService } from "@arr/shared";
import { LidarrClient, ProwlarrClient, RadarrClient, ReadarrClient, SonarrClient } from "arr-sdk";
import type { ArrClient } from "../arr/client-factory.js";
import {
	HISTORY_COLLECTION_MAX_REQUESTS,
	HISTORY_COLLECTION_PAGE_SIZE,
} from "./history-source-contract.js";

export type HistoryProviderPageResult =
	| {
			kind: "page";
			records: readonly unknown[];
			rawRecordCount: number;
			totalRecordsHint: number | null;
	  }
	| {
			kind: "invalid";
			rawRecordCount: number;
	  };

type HistoryProviderResponse = object & { records: unknown };

const INVALID_PAGE: HistoryProviderPageResult = { kind: "invalid", rawRecordCount: 0 };

function isValidPage(page: unknown): page is number {
	return (
		typeof page === "number" &&
		Number.isSafeInteger(page) &&
		page >= 1 &&
		page <= HISTORY_COLLECTION_MAX_REQUESTS
	);
}

function getValidTotalRecordsHint(
	response: HistoryProviderResponse,
	page: number,
	recordCount: number,
): number | null {
	const totalRecords = "totalRecords" in response ? response.totalRecords : undefined;
	if (
		typeof totalRecords !== "number" ||
		!Number.isSafeInteger(totalRecords) ||
		totalRecords < 0 ||
		totalRecords < (page - 1) * HISTORY_COLLECTION_PAGE_SIZE + recordCount
	) {
		return null;
	}
	return totalRecords;
}

function validateResponse(response: unknown, page: number): HistoryProviderPageResult {
	if (typeof response !== "object" || response === null || Array.isArray(response)) {
		return INVALID_PAGE;
	}
	if (!("records" in response) || !Array.isArray(response.records)) {
		return INVALID_PAGE;
	}

	const records = response.records;
	if (records.length > HISTORY_COLLECTION_PAGE_SIZE) {
		return { kind: "invalid", rawRecordCount: records.length };
	}

	return {
		kind: "page",
		records: records.slice(),
		rawRecordCount: records.length,
		totalRecordsHint: getValidTotalRecordsHint(response, page, records.length),
	};
}

export async function fetchHistoryProviderPage(input: {
	service: HistoryService;
	client: ArrClient;
	page: number;
}): Promise<HistoryProviderPageResult> {
	if (!isValidPage(input.page)) {
		return INVALID_PAGE;
	}

	let response: unknown;
	switch (input.service) {
		case "sonarr":
			if (!(input.client instanceof SonarrClient)) return INVALID_PAGE;
			response = await input.client.history.get({
				page: input.page,
				pageSize: HISTORY_COLLECTION_PAGE_SIZE,
				sortKey: "date",
				sortDirection: "descending",
				includeEpisode: true,
				includeSeries: true,
			});
			break;
		case "radarr":
			if (!(input.client instanceof RadarrClient)) return INVALID_PAGE;
			response = await input.client.history.get({
				page: input.page,
				pageSize: HISTORY_COLLECTION_PAGE_SIZE,
				sortKey: "date",
				sortDirection: "descending",
				includeMovie: true,
			});
			break;
		case "prowlarr":
			if (!(input.client instanceof ProwlarrClient)) return INVALID_PAGE;
			response = await input.client.history.get({
				page: input.page,
				pageSize: HISTORY_COLLECTION_PAGE_SIZE,
				sortKey: "date",
				sortDirection: "descending",
			});
			break;
		case "lidarr":
			if (!(input.client instanceof LidarrClient)) return INVALID_PAGE;
			response = await input.client.history.get({
				page: input.page,
				pageSize: HISTORY_COLLECTION_PAGE_SIZE,
				sortKey: "date",
				sortDirection: "descending",
				includeArtist: true,
				includeAlbum: true,
				includeTrack: true,
			});
			break;
		case "readarr":
			if (!(input.client instanceof ReadarrClient)) return INVALID_PAGE;
			response = await input.client.history.get({
				page: input.page,
				pageSize: HISTORY_COLLECTION_PAGE_SIZE,
				sortKey: "date",
				sortDirection: "descending",
				includeAuthor: true,
				includeBook: true,
			});
			break;
		default:
			return INVALID_PAGE;
	}

	return validateResponse(response, input.page);
}
