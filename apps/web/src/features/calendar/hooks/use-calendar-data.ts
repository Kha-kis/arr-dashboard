import { useMemo } from "react";
import type { CalendarItem, ServiceInstanceSummary } from "@arr/shared";
import type { CalendarFilters } from "./use-calendar-state";

/**
 * Extended calendar item with information about all instances where this content appears
 */
export interface DeduplicatedCalendarItem extends CalendarItem {
	/** All instances where this content appears */
	allInstances: Array<{ instanceId: string; instanceName: string }>;
}

/**
 * Generate a unique content key for deduplication.
 * Movies: tmdbId > imdbId > movieTitle+airDate
 * Episodes: (tmdbId|imdbId|seriesTitle) + seasonNumber + episodeNumber
 * Albums: musicBrainzId > artistName+albumTitle+releaseDate
 * Books: goodreadsId > authorName+bookTitle+airDate
 */
const getContentKey = (item: CalendarItem): string => {
	if (item.type === "movie") {
		// For movies, prefer tmdbId, then imdbId, then title+date
		if (item.tmdbId) {
			return `movie:tmdb:${item.tmdbId}`;
		}
		if (item.imdbId) {
			return `movie:imdb:${item.imdbId}`;
		}
		// Fallback to title + air date
		const title = item.movieTitle ?? item.title ?? "";
		const date = item.airDate ?? item.airDateUtc ?? "";
		return `movie:title:${title.toLowerCase()}:${date.split("T")[0]}`;
	}

	if (item.type === "episode") {
		// For episodes, need series identifier + season + episode
		const seasonEp = `S${String(item.seasonNumber ?? 0).padStart(2, "0")}E${String(item.episodeNumber ?? 0).padStart(2, "0")}`;
		if (item.tmdbId) {
			return `episode:tmdb:${item.tmdbId}:${seasonEp}`;
		}
		if (item.imdbId) {
			return `episode:imdb:${item.imdbId}:${seasonEp}`;
		}
		// Fallback to series title
		const seriesTitle = item.seriesTitle ?? item.title ?? "";
		return `episode:title:${seriesTitle.toLowerCase()}:${seasonEp}`;
	}

	if (item.type === "album") {
		// For albums, prefer musicBrainzId, then artist+album+date
		if (item.musicBrainzId) {
			return `album:mb:${item.musicBrainzId}`;
		}
		const artist = item.artistName ?? "";
		const album = item.albumTitle ?? item.title ?? "";
		const date = item.releaseDate ?? item.airDate ?? item.airDateUtc ?? "";
		return `album:title:${artist.toLowerCase()}:${album.toLowerCase()}:${date.split("T")[0]}`;
	}

	if (item.type === "book") {
		// For books, prefer goodreadsId, then author+book+date
		if (item.goodreadsId) {
			return `book:gr:${item.goodreadsId}`;
		}
		const author = item.authorName ?? "";
		const book = item.bookTitle ?? item.title ?? "";
		const date = item.airDate ?? item.airDateUtc ?? "";
		return `book:title:${author.toLowerCase()}:${book.toLowerCase()}:${date.split("T")[0]}`;
	}

	// Fallback for unknown types
	return `unknown:${item.id}:${item.instanceId}`;
};

/**
 * Deduplicate calendar items that appear in multiple instances.
 * Returns deduplicated items with allInstances array showing where content appears.
 */
const deduplicateEvents = (events: CalendarItem[]): DeduplicatedCalendarItem[] => {
	const contentMap = new Map<string, DeduplicatedCalendarItem>();

	for (const item of events) {
		const key = getContentKey(item);
		const existing = contentMap.get(key);

		if (existing) {
			// Add this instance to the existing item's allInstances
			existing.allInstances.push({
				instanceId: item.instanceId,
				instanceName: item.instanceName,
			});
		} else {
			// First occurrence - create deduplicated item
			contentMap.set(key, {
				...item,
				allInstances: [{ instanceId: item.instanceId, instanceName: item.instanceName }],
			});
		}
	}

	return Array.from(contentMap.values());
};

export interface CalendarDataHookResult {
	aggregated: CalendarItem[];
	instances: Array<{
		instanceId: string;
		instanceName: string;
		service: "sonarr" | "radarr" | "lidarr" | "readarr";
		data: CalendarItem[];
	}>;
	instanceOptions: Array<{ value: string; label: string }>;
	filteredEvents: DeduplicatedCalendarItem[];
	eventsByDate: Map<string, DeduplicatedCalendarItem[]>;
	serviceMap: Map<string, ServiceInstanceSummary>;
}

export const useCalendarData = (
	data:
		| {
				aggregated?: CalendarItem[];
				instances?: Array<{
					instanceId: string;
					instanceName: string;
					service: "sonarr" | "radarr" | "lidarr" | "readarr";
					data: CalendarItem[];
				}>;
		  }
		| undefined,
	services: ServiceInstanceSummary[] | undefined,
	filters: CalendarFilters,
): CalendarDataHookResult => {
	const aggregated = useMemo(() => data?.aggregated ?? [], [data?.aggregated]);
	const instances = useMemo(() => data?.instances ?? [], [data?.instances]);

	const serviceMap = useMemo(() => {
		const map = new Map<string, ServiceInstanceSummary>();
		for (const instance of services ?? []) {
			map.set(instance.id, instance);
		}
		return map;
	}, [services]);

	const instanceOptions = useMemo(() => {
		const map = new Map<string, string>();
		for (const instance of instances) {
			map.set(instance.instanceId, instance.instanceName);
		}
		return Array.from(map.entries()).map(([value, label]) => ({
			value,
			label,
		}));
	}, [instances]);

	const filteredEvents = useMemo(() => {
		const term = filters.searchTerm.trim().toLowerCase();
		const filtered = aggregated.filter((item) => {
			if (filters.serviceFilter !== "all" && item.service !== filters.serviceFilter) {
				return false;
			}
			if (filters.instanceFilter !== "all" && item.instanceId !== filters.instanceFilter) {
				return false;
			}
			if (term.length > 0) {
				const haystack = [
					item.title,
					item.seriesTitle,
					item.episodeTitle,
					item.movieTitle,
					// Lidarr fields
					item.artistName,
					item.albumTitle,
					// Readarr fields
					item.authorName,
					item.bookTitle,
					item.overview,
				]
					.filter(Boolean)
					.map((value) => value!.toLowerCase());
				if (!haystack.some((value) => value.includes(term))) {
					return false;
				}
			}
			return true;
		});
		// Deduplicate events that appear in multiple instances
		return deduplicateEvents(filtered);
	}, [aggregated, filters]);

	const eventsByDate = useMemo(() => {
		const map = new Map<string, DeduplicatedCalendarItem[]>();
		for (const item of filteredEvents) {
			// Use releaseDate for albums, otherwise airDateUtc/airDate
			const iso = item.releaseDate ?? item.airDateUtc ?? item.airDate;
			if (!iso) {
				continue;
			}
			const separatorIndex = iso.indexOf("T");
			const dateKey = separatorIndex === -1 ? iso : iso.slice(0, separatorIndex);
			const existing = map.get(dateKey);
			if (existing) {
				existing.push(item);
			} else {
				map.set(dateKey, [item]);
			}
		}
		// Sort events within each date
		for (const value of map.values()) {
			value.sort((a, b) => {
				const timeA = new Date(a.releaseDate ?? a.airDateUtc ?? a.airDate ?? 0).getTime();
				const timeB = new Date(b.releaseDate ?? b.airDateUtc ?? b.airDate ?? 0).getTime();
				if (timeA !== timeB) {
					return timeA - timeB;
				}
				return (a.title ?? "").localeCompare(b.title ?? "");
			});
		}
		return map;
	}, [filteredEvents]);

	return {
		aggregated,
		instances,
		instanceOptions,
		filteredEvents,
		eventsByDate,
		serviceMap,
	};
};
