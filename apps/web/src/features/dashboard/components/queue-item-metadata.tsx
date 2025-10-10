"use client";

/**
 * Component for displaying queue item metadata (service, instance, client, size, etc.)
 */

import type { QueueItem } from "@arr/shared";
import { formatSizeGB } from "../lib/queue-utils";
import {
	useIncognitoMode,
	getLinuxInstanceName,
	getLinuxDownloadClient,
	getLinuxIndexer,
} from "../../../lib/incognito";

interface QueueItemMetadataProps {
	item: QueueItem;
	showGroupCount?: boolean;
	groupCount?: number;
}

/**
 * Displays metadata information for a queue item
 */
export const QueueItemMetadata = ({ item, showGroupCount, groupCount }: QueueItemMetadataProps) => {
	const [incognitoMode] = useIncognitoMode();
	const sizeText = formatSizeGB(item.size);

	return (
		<div className="mt-1 flex flex-wrap gap-2 text-xs text-white/60">
			<span className="capitalize">{item.service}</span>
			{item.instanceName && (
				<span>
					{incognitoMode ? getLinuxInstanceName(item.instanceName) : item.instanceName}
				</span>
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
