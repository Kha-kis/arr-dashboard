import type { CalendarItem, HistoryItem, QueueItem } from "@arr/shared";
import { calendarApiPath, compareCalendarItems, normalizeCalendarItem } from "./calendar-utils";
import { historyApiPath, normalizeHistoryItem } from "./history-utils";
import { normalizeQueueItem, queueApiPath } from "./queue-utils";

/**
 * Fetches queue items from Sonarr or Radarr
 */
export const fetchQueueItems = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr",
): Promise<Omit<QueueItem, "instanceId" | "instanceName">[]> => {
	const query =
		service === "sonarr" ? "?pageSize=1000&includeUnknownSeriesItems=true" : "?pageSize=1000";
	const response = await fetcher(`${queueApiPath(service)}${query}`);
	const payload = await response.json();
	const items = Array.isArray(payload) ? payload : (payload.records ?? []);
	return items.map((raw: unknown) => normalizeQueueItem(raw, service));
};

/**
 * Fetches history items from Sonarr, Radarr, or Prowlarr with pagination and date filtering
 */
export const fetchHistoryItems = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr" | "prowlarr",
	page: number,
	pageSize: number,
	startDate?: string,
	endDate?: string,
): Promise<{ items: HistoryItem[]; totalRecords: number }> => {
	const params = new URLSearchParams({
		page: String(page),
		pageSize: String(pageSize),
		sortKey: "date",
		sortDirection: "descending",
	});

	// Add date filtering if provided
	if (startDate) {
		params.append("since", startDate);
	}
	if (endDate) {
		params.append("until", endDate);
	}

	const response = await fetcher(`${historyApiPath(service)}?${params.toString()}`);
	const payload = await response.json();
	const records = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.records)
			? payload.records
			: Array.isArray(payload?.results)
				? payload.results
				: Array.isArray(payload?.history)
					? payload.history
					: [];

	const totalRecords =
		payload &&
		typeof payload === "object" &&
		!Array.isArray(payload) &&
		typeof payload.totalRecords === "number"
			? payload.totalRecords
			: payload &&
					typeof payload === "object" &&
					!Array.isArray(payload) &&
					typeof payload.total === "number"
				? payload.total
				: records.length;

	const items = records.map((raw: unknown) => normalizeHistoryItem(raw, service));
	return { items, totalRecords };
};

/**
 * Fetches calendar items from Sonarr or Radarr for a date range
 */
export const fetchCalendarItems = async (
	fetcher: (path: string, init?: RequestInit) => Promise<Response>,
	service: "sonarr" | "radarr",
	options: { start: string; end: string; unmonitored?: boolean },
): Promise<CalendarItem[]> => {
	const params = new URLSearchParams({
		start: options.start,
		end: options.end,
	});
	if (typeof options.unmonitored === "boolean") {
		params.set("unmonitored", String(options.unmonitored));
	}
	if (service === "sonarr") {
		params.set("includeSeries", "true");
		params.set("includeEpisodeFile", "true");
	} else {
		params.set("includeUnmonitored", "true");
	}
	const response = await fetcher(`${calendarApiPath(service)}?${params.toString()}`);
	const payload = await response.json();
	const records = Array.isArray(payload)
		? payload
		: Array.isArray(payload?.records)
			? payload.records
			: [];
	const normalized = records.map((raw: unknown) => normalizeCalendarItem(raw, service));
	normalized.sort(compareCalendarItems);
	return normalized;
};
