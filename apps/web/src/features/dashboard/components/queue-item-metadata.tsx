"use client";

/**
 * Component for displaying queue item metadata with service-specific styling
 */

import type { QueueItem } from "@arr/shared";
import { ExternalLink, Tv, Film, HardDrive, Globe, Database, Music, BookOpen } from "lucide-react";
import { formatSizeGB } from "../lib/queue-utils";
import {
	useIncognitoMode,
	getLinuxInstanceName,
	getLinuxDownloadClient,
	getLinuxIndexer,
} from "../../../lib/incognito";
import { cn } from "../../../lib/utils";

interface QueueItemMetadataProps {
	item: QueueItem;
	instanceUrl?: string;
	showGroupCount?: boolean;
	groupCount?: number;
}

/**
 * Service-specific colors for visual distinction
 */
const SERVICE_COLORS = {
	sonarr: {
		bg: "bg-cyan-500/10",
		border: "border-cyan-500/30",
		text: "text-cyan-400",
		icon: Tv,
	},
	radarr: {
		bg: "bg-orange-500/10",
		border: "border-orange-500/30",
		text: "text-orange-400",
		icon: Film,
	},
	lidarr: {
		bg: "bg-green-500/10",
		border: "border-green-500/30",
		text: "text-green-400",
		icon: Music,
	},
	readarr: {
		bg: "bg-violet-500/10",
		border: "border-violet-500/30",
		text: "text-violet-400",
		icon: BookOpen,
	},
} as const;

/**
 * Premium metadata display with service-specific styling and icons
 */
export const QueueItemMetadata = ({
	item,
	instanceUrl,
	showGroupCount,
	groupCount,
}: QueueItemMetadataProps) => {
	const [incognitoMode] = useIncognitoMode();
	const sizeText = formatSizeGB(item.size);
	const displayName = incognitoMode
		? getLinuxInstanceName(item.instanceName ?? "")
		: item.instanceName;

	const serviceStyle = SERVICE_COLORS[item.service as keyof typeof SERVICE_COLORS];
	const ServiceIcon = serviceStyle?.icon ?? Tv;

	return (
		<div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
			{/* Service badge */}
			<span
				className={cn(
					"inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium border capitalize transition-all duration-300",
					serviceStyle?.bg ?? "bg-muted/20",
					serviceStyle?.border ?? "border-border/50",
					serviceStyle?.text ?? "text-muted-foreground"
				)}
			>
				<ServiceIcon className="h-3 w-3" />
				{item.service}
			</span>

			{/* Instance name with external link */}
			{item.instanceName && (
				instanceUrl ? (
					<a
						href={`${instanceUrl}/activity/queue`}
						target="_blank"
						rel="noopener noreferrer"
						className={cn(
							"group inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium transition-all duration-300",
							"bg-muted/20 border border-border/30 text-muted-foreground",
							"hover:bg-primary/10 hover:border-primary/30 hover:text-primary"
						)}
						title={`Open ${item.instanceName} queue`}
					>
						<Database className="h-3 w-3" />
						{displayName}
						<ExternalLink className="h-3 w-3 opacity-0 -ml-1 group-hover:opacity-100 group-hover:ml-0 transition-all duration-200" />
					</a>
				) : (
					<span className="inline-flex items-center gap-1.5 rounded-full bg-muted/20 border border-border/30 px-2 py-0.5 text-muted-foreground">
						<Database className="h-3 w-3" />
						{displayName}
					</span>
				)
			)}

			{/* Download client */}
			{item.downloadClient && (
				<span className="inline-flex items-center gap-1.5 text-muted-foreground">
					<HardDrive className="h-3 w-3" />
					{incognitoMode
						? getLinuxDownloadClient(item.downloadClient)
						: item.downloadClient}
				</span>
			)}

			{/* Indexer */}
			{item.indexer && (
				<span className="inline-flex items-center gap-1.5 text-muted-foreground">
					<Globe className="h-3 w-3" />
					{incognitoMode ? getLinuxIndexer(item.indexer) : item.indexer}
				</span>
			)}

			{/* Size */}
			{sizeText && (
				<span className="text-muted-foreground font-mono">
					{sizeText}
				</span>
			)}

			{/* Group count */}
			{showGroupCount && groupCount && (
				<span className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 px-2 py-0.5 text-primary font-medium">
					{groupCount} items
				</span>
			)}
		</div>
	);
};
