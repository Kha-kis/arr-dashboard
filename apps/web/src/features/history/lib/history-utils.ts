import type {
	HistoryItemV2,
	HistoryResponseV2,
	HistoryService,
	ServiceInstanceSummary,
} from "@arr/shared";

export const SERVICE_FILTERS = [
	{ value: "all" as const, label: "All services" },
	{ value: "sonarr" as const, label: "Sonarr" },
	{ value: "radarr" as const, label: "Radarr" },
	{ value: "prowlarr" as const, label: "Prowlarr" },
	{ value: "lidarr" as const, label: "Lidarr" },
	{ value: "readarr" as const, label: "Readarr" },
];
export interface HistoryGroup {
	items: HistoryItemV2[];
	downloadId?: string;
}
export interface ComposedHistory {
	items: HistoryItemV2[];
	sources: HistoryResponseV2["sources"];
	matchingObservedCount: number;
	hasNextPage: boolean;
	nextCursor: string | null;
}
export const composeHistoryItems = (
	pages: Array<Pick<HistoryResponseV2, "items" | "sources" | "pageInfo">>,
): ComposedHistory => {
	const seen = new Set<string>();
	const items: HistoryItemV2[] = [];
	for (const page of pages)
		for (const item of page.items)
			if (!seen.has(item.id)) {
				seen.add(item.id);
				items.push(item);
			}
	const firstPage = pages[0]?.pageInfo;
	const lastPage = pages.at(-1)?.pageInfo;
	return {
		items,
		sources: pages.at(-1)?.sources ?? [],
		matchingObservedCount: firstPage?.matchingObservedCount ?? 0,
		hasNextPage: lastPage?.hasNextPage === true && Boolean(lastPage.nextCursor),
		nextCursor: lastPage?.hasNextPage && lastPage.nextCursor ? lastPage.nextCursor : null,
	};
};
export const extractInstanceOptions = (
	sources: Array<{ instanceId: string; instanceName: string }>,
): Array<{ value: string; label: string }> =>
	Array.from(new Map(sources.map((source) => [source.instanceId, source.instanceName]))).map(
		([value, label]) => ({ value, label }),
	);
export const groupHistoryItems = (
	items: HistoryItemV2[],
	groupByDownload: boolean,
): HistoryGroup[] => {
	if (!groupByDownload)
		return items.map((item) => ({ items: [item], downloadId: item.downloadId }));
	const groups = new Map<string, HistoryItemV2[]>();
	const ungrouped: HistoryItemV2[] = [];
	for (const item of items) {
		const key = item.downloadId?.trim();
		if (!key) ungrouped.push(item);
		else groups.set(key, [...(groups.get(key) ?? []), item]);
	}
	for (const group of groups.values())
		group.sort((a, b) => Date.parse(b.eventAt) - Date.parse(a.eventAt));
	return [
		...Array.from(groups.values()).map((group) => ({
			items: group,
			downloadId: group[0]?.downloadId,
		})),
		...ungrouped.map((item) => ({ items: [item], downloadId: item.downloadId })),
	].sort((a, b) => {
		const newestA = a.items[0];
		const newestB = b.items[0];
		return (
			(newestB ? Date.parse(newestB.eventAt) : 0) - (newestA ? Date.parse(newestA.eventAt) : 0)
		);
	});
};
export const buildHistoryExternalLink = (
	item: HistoryItemV2,
	instance?: ServiceInstanceSummary,
): string | null => {
	if (!instance?.baseUrl) return null;
	const baseUrl = (instance.externalUrl ?? instance.baseUrl).replace(/\/+$/, "");
	if (item.service === "sonarr")
		return item.seriesSlug ? `${baseUrl}/series/${item.seriesSlug}` : `${baseUrl}/activity/history`;
	if (item.service === "radarr")
		return item.movieSlug ? `${baseUrl}/movie/${item.movieSlug}` : `${baseUrl}/activity/history`;
	return item.service === "prowlarr" ? baseUrl : null;
};
export const detectLifecycleStages = (items: HistoryItemV2[]) => {
	const stages: Array<{
		stage: string;
		label: string;
		color: "success" | "warning" | "error" | "info" | "default";
	}> = [];
	const seen = new Set<string>();
	for (const item of [...items].sort((a, b) => a.eventAt.localeCompare(b.eventAt))) {
		const event = item.eventType;
		const stage = event.includes("grab")
			? { stage: "grabbed", label: "Grabbed", color: "info" as const }
			: event.includes("import") || event.includes("download")
				? { stage: "imported", label: "Imported", color: "success" as const }
				: event.includes("fail") || event.includes("error") || event.includes("reject")
					? { stage: "failed", label: "Failed", color: "error" as const }
					: event.includes("delete") || event.includes("removed")
						? { stage: "deleted", label: "Deleted", color: "warning" as const }
						: event.includes("upgrade")
							? { stage: "upgraded", label: "Upgraded", color: "success" as const }
							: event.includes("renam")
								? { stage: "renamed", label: "Renamed", color: "default" as const }
								: undefined;
		if (stage && !seen.has(stage.stage)) {
			seen.add(stage.stage);
			stages.push(stage);
		}
	}
	return stages;
};
export const getDisplayTitle = (item: HistoryItemV2): string =>
	item.title ?? item.sourceTitle ?? item.eventType;
export const getEventTypeStatusBadge = (
	eventType: string,
): "success" | "warning" | "error" | "info" | "default" => {
	if (
		eventType.includes("fail") ||
		eventType.includes("error") ||
		eventType.includes("reject") ||
		eventType.includes("delete") ||
		eventType.includes("removed")
	)
		return "error";
	if (eventType.includes("download") || eventType.includes("import")) return "success";
	if (eventType.includes("skip") || eventType.includes("ignored") || eventType.includes("upgrade"))
		return "warning";
	if (eventType.includes("grab") || eventType.includes("query") || eventType.includes("rss"))
		return "info";
	return "default";
};
export const getSourceClient = (item: HistoryItemV2): string =>
	item.eventType.includes("grab") ||
	item.eventType.includes("query") ||
	item.eventType.includes("rss")
		? (item.indexer ?? "")
		: (item.downloadClient ?? item.indexer ?? item.protocol ?? "");
export const getSourceClientKind = (item: HistoryItemV2): "indexer" | "client" | "other" =>
	item.eventType.includes("grab") ||
	item.eventType.includes("query") ||
	item.eventType.includes("rss")
		? "indexer"
		: item.downloadClient
			? "client"
			: item.indexer
				? "indexer"
				: "other";
export const createServiceSummary = (items: HistoryItemV2[]): Map<HistoryService, number> => {
	const result = new Map<HistoryService, number>();
	for (const item of items) result.set(item.service, (result.get(item.service) ?? 0) + 1);
	return result;
};
export const createStatusSummary = (items: HistoryItemV2[]): Array<[string, number]> => {
	const result = new Map<string, number>();
	for (const item of items) result.set(item.eventType, (result.get(item.eventType) ?? 0) + 1);
	return Array.from(result.entries()).sort((a, b) => b[1] - a[1]);
};
export interface ActivitySummary {
	grabs: number;
	imports: number;
	failures: number;
}
export const createActivitySummary = (items: HistoryItemV2[]): ActivitySummary =>
	items.reduce(
		(result, item) => {
			if (item.eventType.includes("grab")) result.grabs++;
			else if (item.eventType.includes("import") || item.eventType.includes("download"))
				result.imports++;
			else if (
				item.eventType.includes("fail") ||
				item.eventType.includes("error") ||
				item.eventType.includes("reject")
			)
				result.failures++;
			return result;
		},
		{ grabs: 0, imports: 0, failures: 0 },
	);
export { formatBytes } from "../../../lib/format-utils";
