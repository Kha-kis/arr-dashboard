"use client";

import type { HistoryItem, ServiceInstanceSummary } from "@arr/shared";
import { ExternalLink, History } from "lucide-react";
import {
	useIncognitoMode,
	getLinuxIsoName,
	getLinuxIndexer,
	getLinuxDownloadClient,
	getLinuxInstanceName,
} from "../../../lib/incognito";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { buildHistoryExternalLink } from "../lib/history-utils";
import {
	PremiumTable,
	PremiumTableHeader,
	PremiumTableRow,
	PremiumEmptyState,
	PremiumSkeleton,
	StatusBadge,
} from "../../../components/layout";

interface HistoryGroup {
	downloadId?: string;
	groupType?: string;
	items: HistoryItem[];
}

interface HistoryTableProps {
	readonly groups: HistoryGroup[];
	readonly loading?: boolean;
	readonly emptyMessage?: string;
	readonly groupingEnabled: boolean;
	readonly serviceMap: Map<string, ServiceInstanceSummary>;
}

const formatBytes = (value?: number): string => {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return "-";
	}
	const units = ["B", "KB", "MB", "GB", "TB"];
	let size = value;
	let unitIndex = 0;
	while (size >= 1024 && unitIndex < units.length - 1) {
		size /= 1024;
		unitIndex += 1;
	}
	return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatDateTime = (value?: string): string => {
	if (!value) {
		return "-";
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return value;
	}
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
};

const getEventTypeStatusBadge = (eventType: string): "success" | "warning" | "error" | "info" | "default" => {
	const normalized = eventType.toLowerCase();
	if (normalized.includes("download") || normalized.includes("import")) {
		return "success";
	}
	if (
		normalized.includes("fail") ||
		normalized.includes("error") ||
		normalized.includes("reject")
	) {
		return "error";
	}
	if (
		normalized.includes("delete") ||
		normalized.includes("removed")
	) {
		return "error";
	}
	if (
		normalized.includes("ignored") ||
		normalized.includes("skip") ||
		normalized.includes("renam") ||
		normalized.includes("upgrade")
	) {
		return "warning";
	}
	if (
		normalized.includes("grab") ||
		normalized.includes("indexerquery") ||
		normalized.includes("query") ||
		normalized.includes("rss")
	) {
		return "info";
	}
	return "default";
};

const getDisplayTitle = (item: HistoryItem): string => {
	// For Prowlarr, try to extract meaningful info from data field
	if (item.service === "prowlarr") {
		const data = item.data as any;
		const eventType = (item.eventType ?? "").toLowerCase();

		// For release grabbed events, prioritize release title
		if (eventType.includes("grab") || eventType.includes("release")) {
			const release = data?.releaseTitle || data?.title || item.title || item.sourceTitle;
			if (release && release !== "Untitled" && release) return release;
		}

		// For query/RSS events, show the search term or category
		if (eventType.includes("query") || eventType.includes("rss")) {
			const query = data?.query || data?.searchTerm || data?.term;
			if (query) return `Search: "${query}"`;

			// For RSS with no query, show categories or "RSS Feed Sync"
			const categories = data?.categories;
			if (categories && Array.isArray(categories) && categories.length > 0) {
				return `RSS: ${categories.join(", ")}`;
			}

			return "RSS Feed Sync";
		}

		// Fallback: try release title, then query
		const release = data?.releaseTitle || data?.title;
		if (release && release !== "Untitled" && release) return release;

		const query = data?.query || data?.searchTerm;
		if (query) return `Search: "${query}"`;

		// If we still have nothing useful, show the event type context
		if (eventType.includes("rss")) return "RSS Feed Sync";
		if (eventType.includes("query")) return "Indexer Query";

		// Last resort: show application
		const app = data?.application || data?.source;
		if (app) return `${eventType} - ${app}`;
	}

	// For series, show "Series - Episode Title"
	if (item.service === "sonarr" && item.title) {
		return item.title;
	}
	// For movies, show movie title
	if (item.service === "radarr" && item.title) {
		return item.title;
	}
	// Fallback to sourceTitle or generic
	return item.sourceTitle ?? item.title ?? "Unknown";
};

const _getProwlarrDetails = (item: HistoryItem): string => {
	if (item.service !== "prowlarr") return "";

	const data = item.data as any;
	if (!data) return "";

	const parts: string[] = [];

	// Show number of results for queries
	if (typeof data.queryResults === "number" || typeof data.numberOfResults === "number") {
		const count = data.queryResults ?? data.numberOfResults;
		parts.push(`${count} results`);
	}

	// Show successful status
	if (typeof data.successful === "boolean") {
		parts.push(data.successful ? "✓ Success" : "✗ Failed");
	}

	// Show elapsed time
	if (typeof data.elapsedTime === "number") {
		parts.push(`${data.elapsedTime}ms`);
	}

	// Show requesting application
	if (data.application || data.source) {
		parts.push(`via ${data.application ?? data.source}`);
	}

	return parts.join(" • ") || "-";
};

export const HistoryTable = ({
	groups,
	loading,
	emptyMessage,
	groupingEnabled,
	serviceMap,
}: HistoryTableProps) => {
	const [incognitoMode] = useIncognitoMode();
	const { gradient: themeGradient } = useThemeGradient();

	if (loading) {
		return <PremiumSkeleton variant="card" className="h-96" />;
	}

	if (groups.length === 0) {
		return (
			<PremiumEmptyState
				icon={History}
				title="No History Records"
				description={emptyMessage ?? "No history records available."}
			/>
		);
	}

	return (
		<PremiumTable>
			<table className="min-w-full text-sm text-muted-foreground">
				<PremiumTableHeader>
					<tr>
						<th className="px-4 py-3 text-left text-xs uppercase tracking-wide">Event</th>
						<th className="px-4 py-3 text-left text-xs uppercase tracking-wide">Title</th>
						<th className="px-4 py-3 text-left text-xs uppercase tracking-wide">Quality</th>
						<th className="px-4 py-3 text-left text-xs uppercase tracking-wide">Source/Client</th>
						<th className="px-4 py-3 text-right text-xs uppercase tracking-wide">Size</th>
						<th className="px-4 py-3 text-left text-xs uppercase tracking-wide">Date</th>
					</tr>
				</PremiumTableHeader>
				<tbody className="divide-y divide-border/50">
					{groups.map((group, groupIndex) => {
						const isGrouped = groupingEnabled && group.items.length > 1;
						const isRssGroup = group.groupType === "rss";

						// For RSS groups, only show a summary row
						if (isRssGroup && isGrouped) {
							const firstItem = group.items[0];
							const key = `rss-group-${groupIndex}`;

							// Count total events in group
							const eventCount = group.items.length;

							return (
								<PremiumTableRow key={key}>
									<td className="px-4 py-3">
										<div className="flex flex-col gap-1">
											<div
												className="mb-1 text-xs font-semibold"
												style={{ color: themeGradient.from }}
											>
												📡 RSS Sync - {eventCount} feeds
											</div>
											<StatusBadge status="info">indexerRss</StatusBadge>
											{(() => {
												const instance = firstItem ? serviceMap.get(firstItem.instanceId) : undefined;
												const externalLink = firstItem ? buildHistoryExternalLink(firstItem, instance) : null;
												const displayName = firstItem?.instanceName
													? incognitoMode
														? getLinuxInstanceName(firstItem.instanceName)
														: firstItem.instanceName
													: "-";

												return externalLink ? (
													<a
														href={externalLink}
														target="_blank"
														rel="noopener noreferrer"
														className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors"
														onMouseEnter={(e) => {
															e.currentTarget.style.color = themeGradient.from;
														}}
														onMouseLeave={(e) => {
															e.currentTarget.style.color = "";
														}}
													>
														{displayName}
														<ExternalLink className="h-3 w-3 opacity-50" />
													</a>
												) : (
													<span className="text-xs text-muted-foreground">{displayName}</span>
												);
											})()}
										</div>
									</td>
									<td className="px-4 py-3 text-foreground">
										<div className="truncate">RSS Feed Sync</div>
									</td>
									<td className="px-4 py-3 text-muted-foreground">-</td>
									<td className="px-4 py-3 text-muted-foreground">
										<div className="text-xs text-muted-foreground">
											{eventCount} {eventCount === 1 ? "feed" : "feeds"}
										</div>
									</td>
									<td className="px-4 py-3 text-right text-muted-foreground">-</td>
									<td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
										{firstItem?.date ? formatDateTime(firstItem.date) : "-"}
									</td>
								</PremiumTableRow>
							);
						}

						return group.items.map((item, itemIndex) => {
							const key = `${item.service}:${item.instanceId}:${String(item.id)}`;
							const eventType = item.eventType ?? item.status ?? "Unknown";
							const displayTitle = getDisplayTitle(item);
							const anonymizedTitle = incognitoMode ? getLinuxIsoName(displayTitle) : displayTitle;

							// Determine what to show in Source/Client column (smart selection)
							const isProwlarr = item.service === "prowlarr";
							const prowlarrData = isProwlarr ? (item.data as any) : null;

							// For grabs/queries: show indexer
							// For downloads/imports: show download client
							const eventTypeLower = eventType.toLowerCase();
							let sourceClient = "";

							if (
								eventTypeLower.includes("grab") ||
								eventTypeLower.includes("query") ||
								eventTypeLower.includes("rss")
							) {
								// Show indexer for search/grab events
								const rawIndexer = isProwlarr
									? prowlarrData?.indexer || prowlarrData?.indexerName || item.indexer || "-"
									: item.indexer || "-";
								sourceClient = incognitoMode && rawIndexer !== "-" ? getLinuxIndexer(rawIndexer) : rawIndexer;
							} else if (eventTypeLower.includes("download") || eventTypeLower.includes("import")) {
								// Show download client for download/import events
								const rawClient = item.downloadClient || "-";
								sourceClient = incognitoMode && rawClient !== "-" ? getLinuxDownloadClient(rawClient) : rawClient;
							} else {
								// Fallback: show whatever is available
								const raw = item.downloadClient || item.indexer || item.protocol || "-";
								if (raw !== "-" && incognitoMode) {
									sourceClient = item.downloadClient
										? getLinuxDownloadClient(raw)
										: item.indexer
											? getLinuxIndexer(raw)
											: raw;
								} else {
									sourceClient = raw;
								}
							}

							// Filter out useless values
							if (sourceClient === "localhost" || sourceClient === "unknown") {
								sourceClient = "-";
							}

							const isFirstInGroup = itemIndex === 0;
							const isLastInGroup = itemIndex === group.items.length - 1;

							return (
								<PremiumTableRow
									key={key}
									className={`${isGrouped ? "border-l-2 border-l-primary/50" : ""} ${isGrouped && !isLastInGroup ? "border-b-0" : ""}`}
								>
									<td className={`px-4 py-3 ${isGrouped && !isFirstInGroup ? "pl-8" : ""}`}>
										<div className="flex flex-col gap-1">
											{isFirstInGroup && isGrouped && (
												<div
													className="mb-1 text-xs font-semibold"
													style={{ color: themeGradient.from }}
												>
													📦 {group.items.length} events
												</div>
											)}
											<StatusBadge status={getEventTypeStatusBadge(eventType)}>
												{eventType}
											</StatusBadge>
											{(() => {
												const instance = serviceMap.get(item.instanceId);
												const externalLink = buildHistoryExternalLink(item, instance);
												const displayName = incognitoMode
													? getLinuxInstanceName(item.instanceName)
													: item.instanceName;

												return externalLink ? (
													<a
														href={externalLink}
														target="_blank"
														rel="noopener noreferrer"
														className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors"
														onMouseEnter={(e) => {
															e.currentTarget.style.color = themeGradient.from;
														}}
														onMouseLeave={(e) => {
															e.currentTarget.style.color = "";
														}}
													>
														{displayName}
														<ExternalLink className="h-3 w-3 opacity-50" />
													</a>
												) : (
													<span className="text-xs text-muted-foreground">{displayName}</span>
												);
											})()}
										</div>
									</td>
									<td className="max-w-xs px-4 py-3 text-foreground" title={anonymizedTitle}>
										<div className="truncate">{anonymizedTitle}</div>
									</td>
									<td className="px-4 py-3 text-muted-foreground">
										{(item.quality as { quality?: { name?: string } })?.quality?.name ?? "-"}
									</td>
									<td className="px-4 py-3 text-muted-foreground">{sourceClient}</td>
									<td className="px-4 py-3 text-right text-muted-foreground">{formatBytes(item.size)}</td>
									<td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
										{formatDateTime(item.date)}
									</td>
								</PremiumTableRow>
							);
						});
					})}
				</tbody>
			</table>
		</PremiumTable>
	);
};
