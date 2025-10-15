/**
 * ARR Sync Hooks
 * React Query hooks for Custom Formats & TRaSH sync
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	ArrSyncSettings,
	PreviewRequest,
	ApplyRequest,
} from "@arr/shared";
import {
	getArrSyncSettings,
	updateArrSyncSettings,
	previewArrSync,
	applyArrSync,
	testArrSyncConnection,
} from "../../lib/api-client/arr-sync";
import { toast } from "../../components/ui";

/**
 * Get sync settings for all instances
 */
export function useArrSyncSettings() {
	return useQuery({
		queryKey: ["arr-sync", "settings"],
		queryFn: getArrSyncSettings,
		refetchOnWindowFocus: false,
	});
}

/**
 * Update sync settings for an instance
 */
export function useUpdateArrSyncSettings() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({
			instanceId,
			settings,
		}: {
			instanceId: string;
			settings: ArrSyncSettings;
		}) => updateArrSyncSettings(instanceId, settings),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["arr-sync", "settings"] });
			toast("Settings updated successfully");
		},
		onError: (error: Error) => {
			toast(`Failed to update settings: ${error.message}`);
		},
	});
}

/**
 * Preview sync changes (dry run)
 */
export function usePreviewArrSync() {
	return useMutation({
		mutationFn: (request: PreviewRequest) => previewArrSync(request),
		onError: (error: Error) => {
			toast(`Failed to preview sync: ${error.message}`);
		},
	});
}

/**
 * Apply sync changes
 */
export function useApplyArrSync() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (request: ApplyRequest) => applyArrSync(request),
		onSuccess: (data) => {
			const totalSuccess = data.results.filter((r) => r.success).length;
			const totalErrors = data.results.filter((r) => !r.success).length;

			if (totalErrors === 0) {
				toast(`Successfully synced ${totalSuccess} instance(s)`);
			} else {
				toast(
					`Synced with errors: ${totalSuccess} succeeded, ${totalErrors} failed`,
				);
			}

			queryClient.invalidateQueries({ queryKey: ["arr-sync", "settings"] });
		},
		onError: (error: Error) => {
			toast(`Failed to apply sync: ${error.message}`);
		},
	});
}

/**
 * Test connection to an instance
 */
export function useTestArrSyncConnection() {
	return useMutation({
		mutationFn: (instanceId: string) => testArrSyncConnection(instanceId),
		onError: (error: Error) => {
			toast(`Connection test failed: ${error.message}`);
		},
	});
}
