/**
 * Dashboard Queue Hook
 *
 * Manages queue actions and manual import modal state.
 * Handles retry, remove, and category change actions.
 */

import { useEffect, useState } from "react";
import type { QueueItem } from "@arr/shared";
import { useQueueActions } from "../../../hooks/api/useQueueActions";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";

interface ManualImportContext {
	instanceId: string;
	instanceName: string;
	service: "sonarr" | "radarr";
	downloadId?: string;
	open: boolean;
}

/**
 * Hook for dashboard queue management
 *
 * @param queueRefetch - Function to refetch queue data after actions
 * @returns Queue action handlers and manual import modal state
 */
export const useDashboardQueue = (queueRefetch?: () => void) => {
	const queueActions = useQueueActions();

	const [queueMessage, setQueueMessage] = useState<{
		type: "success";
		message: string;
	} | null>(null);

	const [manualImportContext, setManualImportContext] = useState<ManualImportContext>({
		instanceId: "",
		instanceName: "",
		service: "sonarr",
		downloadId: undefined,
		open: false,
	});

	// Auto-dismiss success messages after 6 seconds
	useEffect(() => {
		if (!queueMessage) {
			return;
		}
		const timeout = window.setTimeout(() => setQueueMessage(null), 6000);
		return () => window.clearTimeout(timeout);
	}, [queueMessage]);

	// Queue action handlers
	const handleQueueRetry = (items: QueueItem[]) => queueActions.executeAsync("retry", items);

	const handleQueueRemove = (items: QueueItem[], options?: QueueActionOptions) =>
		queueActions.executeAsync("delete", items, options);

	const handleQueueChangeCategory = (items: QueueItem[]) =>
		queueActions.executeAsync("delete", items, {
			removeFromClient: false,
			blocklist: false,
			changeCategory: true,
		});

	// Manual import modal handlers
	const openManualImport = (item: QueueItem) => {
		if (!item.instanceId || !item.instanceName) {
			return;
		}
		setManualImportContext({
			instanceId: item.instanceId,
			instanceName: item.instanceName,
			service: item.service,
			downloadId: item.downloadId,
			open: true,
		});
	};

	const handleManualImportOpenChange = (open: boolean) => {
		setManualImportContext((prev) => ({ ...prev, open }));
	};

	const handleManualImportCompleted = (result: { imported: number }) => {
		setQueueMessage({
			type: "success",
			message:
				result.imported === 1
					? "Manual import requested for 1 file."
					: `Manual import requested for ${result.imported} files.`,
		});
		if (queueRefetch) {
			queueRefetch();
		}
	};

	return {
		// Queue actions
		handleQueueRetry,
		handleQueueRemove,
		handleQueueChangeCategory,
		queueActionsPending: queueActions.isPending,
		queueActionsError: queueActions.error,

		// Manual import
		openManualImport,
		manualImportContext,
		handleManualImportOpenChange,
		handleManualImportCompleted,

		// Messages
		queueMessage,
		clearQueueMessage: () => setQueueMessage(null),
	};
};
