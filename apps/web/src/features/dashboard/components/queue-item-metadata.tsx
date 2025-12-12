"use client";

/**
 * Component for displaying queue item metadata (service, instance, client, size, etc.)
 */

import type { QueueItem } from "@arr/shared";
import { ExternalLink } from "lucide-react";
import { formatSizeGB } from "../lib/queue-utils";
import {
	useIncognitoMode,
	getLinuxInstanceName,
	getLinuxDownloadClient,
	getLinuxIndexer,
} from "../../../lib/incognito";

interface QueueItemMetadataProps {
	item: QueueItem;
	instanceUrl?: string;
	showGroupCount?: boolean;
	groupCount?: number;
}

/**
 * Displays metadata information for a queue item
 */
export const QueueItemMetadata = ({ item, instanceUrl, showGroupCount, groupCount }: QueueItemMetadataProps) => {
	const [incognitoMode] = useIncognitoMode();
	const sizeText = formatSizeGB(item.size);
	const displayName = incognitoMode ? getLinuxInstanceName(item.instanceName ?? "") : item.instanceName;

	return (
		<div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/60">
			<span className="capitalize">{item.service}</span>
			{item.instanceName && (
				instanceUrl ? (
					<a
						href={instanceUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 hover:text-sky-400 transition-colors"
						title={`Open ${item.instanceName} in new tab`}
					>
						{displayName}
						<ExternalLink className="h-3 w-3 opacity-50" />
					</a>
				) : (
					<span>{displayName}</span>
				)
			)}
			{item.downloadClient && (
				<span>
					{incognitoMode ? getLinuxDownloadClient(item.downloadClient) : item.downloadClient}
				</span>
			)}
			{item.indexer && (
				<span>
					{incognitoMode ? getLinuxIndexer(item.indexer) : item.indexer}
				</span>
			)}
			{sizeText && <span>{sizeText}</span>}
			{showGroupCount && groupCount && <span>{groupCount} items</span>}
		</div>
	);
};
