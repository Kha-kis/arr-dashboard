"use client";

import type { HistoryItem, ServiceInstanceSummary } from "@arr/shared";
import { ExternalLink, History, ArrowRight } from "lucide-react";
import {
	useIncognitoMode,
	getLinuxIsoName,
	getLinuxIndexer,
	getLinuxDownloadClient,
	getLinuxInstanceName,
} from "../../../lib/incognito";
import { useThemeGradient } from "../../../hooks/useThemeGradient";
import { getServiceGradient } from "../../../lib/theme-gradients";
import {
	buildHistoryExternalLink,
	getDisplayTitle,
	formatBytes,
	getEventTypeStatusBadge,
	detectLifecycleStages,
	getSourceClient,
	getSourceClientKind,
} from "../lib/history-utils";
import {
	formatCompactRelativeTime,
	formatAbsoluteDateTime,
} from "../lib/date-utils";
import {
	PremiumTable,
	PremiumTableHeader,
	PremiumTableRow,
	PremiumEmptyState,
	PremiumSkeleton,
	StatusBadge,
} from "../../../components/layout";
import {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
	TooltipProvider,
} from "../../../components/ui/tooltip";

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
		<TooltipProvider>
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
							const firstItem = group.items[0];
							const serviceColor = firstItem ? getServiceGradient(firstItem.service).from : undefined;
							const lifecycleStages = isGrouped ? detectLifecycleStages(group.items) : [];

							// For RSS groups, only show a summary row
							if (isRssGroup && isGrouped) {
								const key = `rss-group-${groupIndex}`;
								const eventCount = group.items.length;

								return (
									<PremiumTableRow key={key}>
										<td
											className="px-4 py-3"
											style={{ borderLeft: `3px solid ${serviceColor}` }}
										>
											<div className="flex flex-col gap-1">
												<div
													className="mb-1 text-xs font-semibold"
													style={{ color: themeGradient.from }}
												>
													{eventCount} feeds
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
											<Tooltip>
												<TooltipTrigger asChild>
													<span className="cursor-default">
														{formatCompactRelativeTime(firstItem?.date)}
													</span>
												</TooltipTrigger>
												<TooltipContent>
													{formatAbsoluteDateTime(firstItem?.date)}
												</TooltipContent>
											</Tooltip>
										</td>
									</PremiumTableRow>
								);
							}

							return group.items.map((item, itemIndex) => {
								const key = `${item.service}:${item.instanceId}:${String(item.id)}`;
								const eventType = item.eventType ?? item.status ?? "Unknown";
								const displayTitle = getDisplayTitle(item);
								const anonymizedTitle = incognitoMode ? getLinuxIsoName(displayTitle) : displayTitle;
								const itemServiceColor = getServiceGradient(item.service).from;

								// Determine what to show in Source/Client column
								const rawSourceClient = getSourceClient(item);
								let sourceClient = rawSourceClient || "-";
								if (incognitoMode && rawSourceClient) {
									const kind = getSourceClientKind(item);
									sourceClient = kind === "indexer"
										? getLinuxIndexer(rawSourceClient)
										: kind === "client"
											? getLinuxDownloadClient(rawSourceClient)
											: rawSourceClient;
								}

								const isFirstInGroup = itemIndex === 0;
								const isLastInGroup = itemIndex === group.items.length - 1;

								return (
									<PremiumTableRow
										key={key}
										className={`${isGrouped ? "border-l-2 border-l-primary/50" : ""} ${isGrouped && !isLastInGroup ? "border-b-0" : ""}`}
									>
										<td
											className={`px-4 py-3 ${isGrouped && !isFirstInGroup ? "pl-8" : ""}`}
											style={!isGrouped ? { borderLeft: `3px solid ${itemServiceColor}` } : undefined}
										>
											<div className="flex flex-col gap-1">
												{isFirstInGroup && isGrouped && (
													<div
														className="mb-1 text-xs font-semibold"
														style={{ color: themeGradient.from }}
													>
														{group.items.length} events
													</div>
												)}
												<StatusBadge status={getEventTypeStatusBadge(eventType)}>
													{eventType}
												</StatusBadge>
												{/* Lifecycle badges on first item of group */}
												{isFirstInGroup && lifecycleStages.length > 0 && (
													<div className="flex items-center gap-1 flex-wrap mt-1">
														{lifecycleStages.map((stage, i) => (
															<div key={stage.stage} className="flex items-center gap-1">
																{i > 0 && <ArrowRight className="h-3 w-3 text-muted-foreground/50" />}
																<StatusBadge status={stage.color}>
																	{stage.label}
																</StatusBadge>
															</div>
														))}
													</div>
												)}
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
											{item.customFormats && item.customFormats.length > 0 && (
												<div className="flex items-center gap-1 mt-1 flex-wrap">
													{item.customFormats.map((cf) => (
														<span
															key={cf.id}
															className="rounded px-1 py-0.5 text-[10px] font-medium"
															style={{
																color: themeGradient.from,
																backgroundColor: themeGradient.fromLight,
															}}
														>
															{cf.name}
														</span>
													))}
													{item.customFormatScore != null && item.customFormatScore !== 0 && (
														<span className="text-[10px] text-muted-foreground/70">
															({item.customFormatScore})
														</span>
													)}
												</div>
											)}
										</td>
										<td className="px-4 py-3 text-muted-foreground">
											{(item.quality as { quality?: { name?: string } })?.quality?.name ?? "-"}
										</td>
										<td className="px-4 py-3 text-muted-foreground">{sourceClient}</td>
										<td className="px-4 py-3 text-right text-muted-foreground">{formatBytes(item.size)}</td>
										<td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
											<Tooltip>
												<TooltipTrigger asChild>
													<span className="cursor-default">
														{formatCompactRelativeTime(item.date)}
													</span>
												</TooltipTrigger>
												<TooltipContent>
													{formatAbsoluteDateTime(item.date)}
												</TooltipContent>
											</Tooltip>
										</td>
									</PremiumTableRow>
								);
							});
						})}
					</tbody>
				</table>
			</PremiumTable>
		</TooltipProvider>
	);
};
