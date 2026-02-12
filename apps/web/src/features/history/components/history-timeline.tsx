"use client";

import { useState } from "react";
import type { ServiceInstanceSummary } from "@arr/shared";
import { History, ArrowRight, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
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
	PremiumEmptyState,
	ServiceBadge,
	StatusBadge,
} from "../../../components/layout";
import {
	Tooltip,
	TooltipTrigger,
	TooltipContent,
	TooltipProvider,
} from "../../../components/ui/tooltip";
import {
	type HistoryGroup,
	getDisplayTitle,
	formatBytes,
	getEventTypeStatusBadge,
	detectLifecycleStages,
	buildHistoryExternalLink,
	getSourceClient,
	getSourceClientKind,
} from "../lib/history-utils";
import {
	formatCompactRelativeTime,
	formatAbsoluteDateTime,
	type DayGroup,
} from "../lib/date-utils";

interface HistoryTimelineProps {
	readonly groupedByDay: DayGroup<HistoryGroup>[];
	readonly serviceMap: Map<string, ServiceInstanceSummary>;
	readonly emptyMessage?: string;
	readonly groupingEnabled: boolean;
}

export const HistoryTimeline = ({
	groupedByDay,
	serviceMap,
	emptyMessage,
	groupingEnabled,
}: HistoryTimelineProps) => {
	const { gradient: themeGradient } = useThemeGradient();

	if (groupedByDay.length === 0) {
		return (
			<PremiumEmptyState
				icon={History}
				title="No History Records"
				description={emptyMessage ?? "No history records available."}
			/>
		);
	}

	let cardIndex = 0;

	return (
		<TooltipProvider>
			<div className="space-y-6">
				{groupedByDay.map((dayGroup) => (
					<div key={dayGroup.date} className="space-y-3">
						{/* Day Separator */}
						<div className="flex items-center gap-3 py-2">
							<div
								className="h-px flex-1"
								style={{
									background: `linear-gradient(to right, transparent, ${themeGradient.fromMuted})`,
								}}
							/>
							<span
								className="text-xs font-semibold uppercase tracking-wider"
								style={{ color: themeGradient.from }}
							>
								{dayGroup.label}
							</span>
							<div
								className="h-px flex-1"
								style={{
									background: `linear-gradient(to left, transparent, ${themeGradient.fromMuted})`,
								}}
							/>
						</div>

						{/* Timeline Cards */}
						{dayGroup.items.map((group) => {
							const index = cardIndex++;
							return (
								<HistoryTimelineCard
									key={`${group.items[0]?.service}:${group.items[0]?.instanceId}:${String(group.items[0]?.id)}:${index}`}
									group={group}
									serviceMap={serviceMap}
									animationIndex={index}
									groupingEnabled={groupingEnabled}
								/>
							);
						})}
					</div>
				))}
			</div>
		</TooltipProvider>
	);
};

interface HistoryTimelineCardProps {
	readonly group: HistoryGroup;
	readonly serviceMap: Map<string, ServiceInstanceSummary>;
	readonly animationIndex: number;
	readonly groupingEnabled: boolean;
}

const HistoryTimelineCard = ({
	group,
	serviceMap,
	animationIndex,
	groupingEnabled,
}: HistoryTimelineCardProps) => {
	const [incognitoMode] = useIncognitoMode();
	const { gradient: themeGradient } = useThemeGradient();
	const [expanded, setExpanded] = useState(false);

	const firstItem = group.items[0];
	if (!firstItem) return null;

	const serviceGradient = getServiceGradient(firstItem.service);
	const eventType = firstItem.eventType ?? firstItem.status ?? "Unknown";
	const displayTitle = getDisplayTitle(firstItem);
	const anonymizedTitle = incognitoMode ? getLinuxIsoName(displayTitle) : displayTitle;
	const quality = (firstItem.quality as { quality?: { name?: string } })?.quality?.name;
	const isGrouped = groupingEnabled && group.items.length > 1;
	const lifecycleStages = isGrouped ? detectLifecycleStages(group.items) : [];

	// Determine source/client
	const rawSourceClient = getSourceClient(firstItem);
	let sourceClient = rawSourceClient;
	if (incognitoMode && rawSourceClient) {
		const kind = getSourceClientKind(firstItem);
		sourceClient = kind === "indexer"
			? getLinuxIndexer(rawSourceClient)
			: kind === "client"
				? getLinuxDownloadClient(rawSourceClient)
				: rawSourceClient;
	}

	const instance = serviceMap.get(firstItem.instanceId);
	const externalLink = buildHistoryExternalLink(firstItem, instance);
	const instanceName = incognitoMode
		? getLinuxInstanceName(firstItem.instanceName)
		: firstItem.instanceName;

	return (
		<div
			className="group relative rounded-xl border border-border/50 bg-card/30 backdrop-blur-xs overflow-hidden transition-all duration-200 hover:border-border/80 hover:bg-card/40 animate-in fade-in slide-in-from-bottom-2 duration-300"
			style={{
				borderLeftWidth: "3px",
				borderLeftColor: serviceGradient.from,
				animationDelay: `${Math.min(animationIndex * 30, 300)}ms`,
				animationFillMode: "backwards",
			}}
		>
			<div className="p-4 space-y-2">
				{/* Header: Title + Relative Time */}
				<div className="flex items-start justify-between gap-3">
					<div className="flex-1 min-w-0">
						<h4
							className="text-sm font-medium text-foreground truncate"
							title={anonymizedTitle}
						>
							{anonymizedTitle}
						</h4>
					</div>
					<Tooltip>
						<TooltipTrigger asChild>
							<span className="text-xs text-muted-foreground whitespace-nowrap shrink-0 cursor-default">
								{formatCompactRelativeTime(firstItem.date)}
							</span>
						</TooltipTrigger>
						<TooltipContent>
							{formatAbsoluteDateTime(firstItem.date)}
						</TooltipContent>
					</Tooltip>
				</div>

				{/* Subtitle: Service badge + Instance name */}
				<div className="flex items-center gap-2 flex-wrap">
					<ServiceBadge service={firstItem.service} />
					<StatusBadge status={getEventTypeStatusBadge(eventType)}>
						{eventType}
					</StatusBadge>
					{externalLink ? (
						<a
							href={externalLink}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
						>
							{instanceName}
							<ExternalLink className="h-3 w-3 opacity-50" />
						</a>
					) : (
						<span className="text-xs text-muted-foreground">{instanceName}</span>
					)}
					{isGrouped && (
						<button
							type="button"
							onClick={() => setExpanded(!expanded)}
							className="inline-flex items-center gap-1 text-xs font-medium transition-colors hover:brightness-125 cursor-pointer"
							style={{ color: themeGradient.from }}
						>
							{group.items.length} events
							{expanded ? (
								<ChevronUp className="h-3 w-3" />
							) : (
								<ChevronDown className="h-3 w-3" />
							)}
						</button>
					)}
				</div>

				{/* Lifecycle Row */}
				{lifecycleStages.length > 0 && (
					<div className="flex items-center gap-1 flex-wrap">
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

				{/* Custom Formats */}
				{firstItem.customFormats && firstItem.customFormats.length > 0 && (
					<div className="flex items-center gap-1.5 flex-wrap">
						{firstItem.customFormats.map((cf) => (
							<span
								key={cf.id}
								className="rounded-md px-1.5 py-0.5 text-[10px] font-medium border"
								style={{
									color: themeGradient.from,
									borderColor: themeGradient.fromMuted,
									backgroundColor: themeGradient.fromLight,
								}}
							>
								{cf.name}
							</span>
						))}
						{firstItem.customFormatScore != null && firstItem.customFormatScore !== 0 && (
							<span className="text-[10px] text-muted-foreground font-medium">
								Score: {firstItem.customFormatScore}
							</span>
						)}
					</div>
				)}

				{/* Metadata Row */}
				<div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
					{quality && (
						<span className="rounded bg-muted/30 px-1.5 py-0.5">{quality}</span>
					)}
					{firstItem.size && firstItem.size > 0 && (
						<span>{formatBytes(firstItem.size)}</span>
					)}
					{sourceClient && <span>{sourceClient}</span>}
				</div>
			</div>

			{/* Expanded Sub-Events */}
			{isGrouped && expanded && (
				<div className="border-t border-border/30 bg-muted/5 animate-in fade-in slide-in-from-top-1 duration-200">
					{group.items.slice(1).map((item) => (
						<SubEventRow
							key={`${item.service}:${item.instanceId}:${String(item.id)}`}
							item={item}
							serviceMap={serviceMap}
							incognitoMode={incognitoMode}
						/>
					))}
				</div>
			)}
		</div>
	);
};

interface SubEventRowProps {
	readonly item: HistoryGroup["items"][number];
	readonly serviceMap: Map<string, ServiceInstanceSummary>;
	readonly incognitoMode: boolean;
}

const SubEventRow = ({ item, serviceMap, incognitoMode }: SubEventRowProps) => {
	const eventType = item.eventType ?? item.status ?? "Unknown";
	const displayTitle = getDisplayTitle(item);
	const anonymizedTitle = incognitoMode ? getLinuxIsoName(displayTitle) : displayTitle;
	const quality = (item.quality as { quality?: { name?: string } })?.quality?.name;

	const rawSourceClient = getSourceClient(item);
	let sourceClient = rawSourceClient;
	if (incognitoMode && rawSourceClient) {
		const kind = getSourceClientKind(item);
		sourceClient = kind === "indexer"
			? getLinuxIndexer(rawSourceClient)
			: kind === "client"
				? getLinuxDownloadClient(rawSourceClient)
				: rawSourceClient;
	}

	const instance = serviceMap.get(item.instanceId);
	const externalLink = buildHistoryExternalLink(item, instance);

	return (
		<div className="flex items-center gap-3 px-4 py-2.5 border-b border-border/20 last:border-0 text-xs">
			<div className="w-1 h-1 rounded-full bg-muted-foreground/30 shrink-0" />
			<StatusBadge status={getEventTypeStatusBadge(eventType)}>
				{eventType}
			</StatusBadge>
			<span className="text-muted-foreground truncate flex-1" title={anonymizedTitle}>
				{anonymizedTitle}
			</span>
			{quality && (
				<span className="text-muted-foreground/70 hidden sm:inline">{quality}</span>
			)}
			{item.size && item.size > 0 && (
				<span className="text-muted-foreground/70 hidden sm:inline">{formatBytes(item.size)}</span>
			)}
			{sourceClient && (
				<span className="text-muted-foreground/70 hidden md:inline">{sourceClient}</span>
			)}
			<Tooltip>
				<TooltipTrigger asChild>
					<span className="text-muted-foreground whitespace-nowrap shrink-0 cursor-default">
						{formatCompactRelativeTime(item.date)}
					</span>
				</TooltipTrigger>
				<TooltipContent>
					{formatAbsoluteDateTime(item.date)}
				</TooltipContent>
			</Tooltip>
			{externalLink && (
				<a
					href={externalLink}
					target="_blank"
					rel="noopener noreferrer"
					className="text-muted-foreground/50 hover:text-muted-foreground transition-colors shrink-0"
				>
					<ExternalLink className="h-3 w-3" />
				</a>
			)}
		</div>
	);
};
