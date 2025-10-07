import { useMemo } from "react";
import type { CalendarItem, ServiceInstanceSummary } from "@arr/shared";
import { formatDateOnly } from "../lib/calendar-formatters";
import type { CalendarFilters } from "./use-calendar-state";

export interface CalendarDataHookResult {
	aggregated: CalendarItem[];
	instances: Array<{
		instanceId: string;
		instanceName: string;
		service: "sonarr" | "radarr";
		data: CalendarItem[];
	}>;
	instanceOptions: Array<{ value: string; label: string }>;
	filteredEvents: CalendarItem[];
	eventsByDate: Map<string, CalendarItem[]>;
	serviceMap: Map<string, ServiceInstanceSummary>;
}

export const useCalendarData = (
	data:
		| {
				aggregated?: CalendarItem[];
				instances?: Array<{
					instanceId: string;
					instanceName: string;
					service: "sonarr" | "radarr";
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
		return aggregated.filter((item) => {
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
	}, [aggregated, filters]);

	const eventsByDate = useMemo(() => {
		const map = new Map<string, CalendarItem[]>();
		for (const item of filteredEvents) {
			const iso = item.airDateUtc ?? item.airDate;
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
				const timeA = new Date(a.airDateUtc ?? a.airDate ?? 0).getTime();
				const timeB = new Date(b.airDateUtc ?? b.airDate ?? 0).getTime();
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
