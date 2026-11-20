/**
 * Dashboard Queue Hook
 *
 * Manages queue actions and manual import modal state.
 * Handles retry, remove, and category change actions.
 */

import type { QueueItem } from "@arr/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useCurrentUser } from "../../../hooks/api/useAuth";
import type { QueueActionOptions } from "../../../hooks/api/useQueueActions";
import { useQueueActions } from "../../../hooks/api/useQueueActions";
import { fetchManualImportCandidates } from "../../../lib/api-client/dashboard";
import { manualImportKeys } from "../../../lib/query-keys";
import type { ManualImportReviewSource } from "../../manual-import/types";

interface ManualImportContext {
	sources: ManualImportReviewSource[];
	open: boolean;
}

/**
 * Hook for dashboard queue management
 *
 * @param queueRefetch - Function to refetch queue data after actions
 * @returns Queue action handlers and manual import modal state
 */
export const useDashboardQueue = (queueRefetch?: () => void) => {
	const queryClient = useQueryClient();
	const { data: user } = useCurrentUser(false);
	const ownerId = user?.id ?? null;
	const queueActions = useQueueActions();

	const [queueMessage, setQueueMessage] = useState<{
		type: "success";
		message: string;
	} | null>(null);

	const [manualImportContext, setManualImportContext] = useState<ManualImportContext>({
		sources: [],
		open: false,
	});
	const [manualImportError, setManualImportError] = useState<Error | null>(null);

	// Prefetch manual import candidates on hover to reduce perceived latency
	const prefetchManualImport = useCallback(
		(item: QueueItem) => {
			if (!ownerId || !item.instanceId || !item.downloadId) {
				return;
			}
			const queryKey = manualImportKeys.candidates(ownerId, {
				instanceId: item.instanceId,
				service: item.service,
				downloadId: item.downloadId,
				filterExistingFiles: true,
			});
			// Only prefetch if not already in cache
			if (!queryClient.getQueryData(queryKey)) {
				void queryClient.prefetchQuery({
					queryKey,
					queryFn: () =>
						fetchManualImportCandidates({
							instanceId: item.instanceId,
							service: item.service,
							downloadId: item.downloadId,
						}),
					staleTime: 30 * 1000, // Keep prefetched data fresh for 30s
				});
			}
		},
		[queryClient, ownerId],
	);

	// Auto-dismiss success messages after 6 seconds
	useEffect(() => {
		if (!queueMessage) {
			return;
		}
		const timeout = window.setTimeout(() => setQueueMessage(null), 6000);
		return () => window.clearTimeout(timeout);
	}, [queueMessage]);

	// Queue action handlers (memoized for React.memo children)
	const handleQueueRetry = useCallback(
		(items: QueueItem[]) => queueActions.executeAsync("retry", items),
		[queueActions],
	);

	const handleQueueRemove = useCallback(
		(items: QueueItem[], options?: QueueActionOptions) =>
			queueActions.executeAsync("delete", items, options),
		[queueActions],
	);

	const handleQueueChangeCategory = useCallback(
		(items: QueueItem[]) =>
			queueActions.executeAsync("delete", items, {
				removeFromClient: false,
				blocklist: false,
				changeCategory: true,
			}),
		[queueActions],
	);

	// Manual import modal handlers (memoized)
	const openManualImports = useCallback(
		(items: QueueItem[]) => {
			setManualImportError(null);
			if (items.length === 0) return;
			if (!ownerId) {
				setManualImportError(new Error("Sign in before reviewing Manual Import."));
				setManualImportContext({ sources: [], open: false });
				return;
			}
			const sources: ManualImportReviewSource[] = [];
			const seen = new Set<string>();
			for (const item of items) {
				if (
					!item.instanceId?.trim() ||
					!item.downloadId?.trim() ||
					!["sonarr", "radarr", "lidarr", "readarr"].includes(item.service)
				) {
					setManualImportError(
						new Error(
							"A selected download is missing its source or ARR connection. Refresh the queue and review the selection again.",
						),
					);
					setManualImportContext({ sources: [], open: false });
					return;
				}
				const normalizedSource = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(item.downloadId)
					? item.downloadId.toLowerCase()
					: item.downloadId;
				const key = JSON.stringify([item.instanceId, item.service, normalizedSource]);
				if (seen.has(key)) continue;
				seen.add(key);
				sources.push({
					instanceId: item.instanceId,
					instanceName: item.instanceName || "ARR connection",
					service: item.service,
					downloadId: item.downloadId,
				});
			}
			setManualImportContext({ sources, open: true });
		},
		[ownerId],
	);
	const openManualImport = useCallback(
		(item: QueueItem) => openManualImports([item]),
		[openManualImports],
	);

	const handleManualImportOpenChange = useCallback((open: boolean) => {
		setManualImportContext((prev) => ({ ...prev, open }));
	}, []);

	const handleManualImportCompleted = useCallback(
		(result: { imported: number }) => {
			setQueueMessage({
				type: "success",
				message:
					result.imported === 1
						? "Manual import verified for 1 file."
						: `Manual import verified for ${result.imported} files.`,
			});
			if (queueRefetch) {
				queueRefetch();
			}
		},
		[queueRefetch],
	);

	return {
		// Queue actions
		handleQueueRetry,
		handleQueueRemove,
		handleQueueChangeCategory,
		queueActionsPending: queueActions.isPending,
		queueActionsError: manualImportError ?? queueActions.error,
		queueSearchWarning: queueActions.searchWarning,
		clearQueueSearchWarning: queueActions.clearSearchWarning,

		// Manual import
		openManualImport,
		openManualImports,
		prefetchManualImport,
		manualImportContext,
		handleManualImportOpenChange,
		handleManualImportCompleted,

		// Messages
		queueMessage,
		clearQueueMessage: useCallback(() => setQueueMessage(null), []),
	};
};
