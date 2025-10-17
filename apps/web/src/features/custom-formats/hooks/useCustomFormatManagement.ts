/**
 * Custom hook for managing custom format business logic
 * Consolidates all API interactions and helper functions
 */

import { useCallback, useMemo } from 'react';
import { z } from 'zod';
import {
	useCustomFormats,
	useCreateCustomFormat,
	useUpdateCustomFormat,
	useDeleteCustomFormat,
	useCopyCustomFormat,
	useExportCustomFormat,
	useImportCustomFormat,
} from '../../../hooks/api/useCustomFormats';
import {
	useTrashTracked,
	useSyncTrashFormats,
	useAllTrashSyncSettings,
	useUpdateTrashSyncSettings,
	useToggleSyncExclusion,
	useImportTrashFormat,
} from '../../../hooks/api/useTrashGuides';
import { toast } from '../../../components/ui/toast';
import type { CustomFormat } from '@arr/shared';
import * as customFormatsApi from '../../../lib/api-client/custom-formats';
import { useDebouncedCallback } from 'use-debounce';

// Validation schemas
export const customFormatSchema = z.object({
	name: z.string().min(1, 'Name is required').max(100, 'Name too long'),
	specifications: z.array(z.object({
		implementation: z.string(),
		name: z.string(),
		negate: z.boolean(),
		required: z.boolean(),
		fields: z.record(z.any()),
	})),
	includeCustomFormatWhenRenaming: z.boolean().default(false),
});

export type ValidatedCustomFormat = z.infer<typeof customFormatSchema>;

interface TrashInfo {
	customFormatId: number;
	customFormatName: string;
	trashId: string;
	service: 'SONARR' | 'RADARR';
	syncExcluded: boolean;
	lastSyncedAt: string;
	gitRef: string;
	importSource: 'INDIVIDUAL' | 'CF_GROUP' | 'QUALITY_PROFILE';
	sourceReference?: string;
}

export function useCustomFormatManagement() {
	// API hooks
	const { data: customFormatsData, isLoading } = useCustomFormats();
	const createMutation = useCreateCustomFormat();
	const updateMutation = useUpdateCustomFormat();
	const deleteMutation = useDeleteCustomFormat();
	const copyMutation = useCopyCustomFormat();
	const { exportCustomFormat } = useExportCustomFormat();
	const importMutation = useImportCustomFormat();

	// TRaSH Guides hooks
	const { data: trashTrackedData } = useTrashTracked();
	const syncTrashMutation = useSyncTrashFormats();
	const toggleExclusionMutation = useToggleSyncExclusion();
	const trashImportMutation = useImportTrashFormat();
	const { data: allSyncSettings } = useAllTrashSyncSettings();
	const updateSyncSettingsMutation = useUpdateTrashSyncSettings();

	// Helper functions with memoization
	const isTrackedByTrash = useCallback((instanceId: string, customFormatId: number): boolean => {
		if (!trashTrackedData?.tracked) return false;
		const instanceTracked = trashTrackedData.tracked[instanceId] || [];
		return instanceTracked.some((t) => t.customFormatId === customFormatId);
	}, [trashTrackedData]);

	const getTrashInfo = useCallback((instanceId: string, customFormatId: number): TrashInfo | null => {
		if (!trashTrackedData?.tracked) return null;
		const instanceTracked = trashTrackedData.tracked[instanceId] || [];
		return instanceTracked.find((t) => t.customFormatId === customFormatId) || null;
	}, [trashTrackedData]);

	const isSyncExcluded = useCallback((instanceId: string, customFormatId: number): boolean => {
		const trashInfo = getTrashInfo(instanceId, customFormatId);
		return trashInfo?.syncExcluded ?? false;
	}, [getTrashInfo]);

	// Validate format data
	const validateFormat = useCallback((format: Omit<CustomFormat, 'id'>): ValidatedCustomFormat | null => {
		try {
			return customFormatSchema.parse(format);
		} catch (error) {
			if (error instanceof z.ZodError) {
				const firstError = error.errors[0];
				toast.error(`Validation error: ${firstError.message}`);
			}
			return null;
		}
	}, []);

	// Error handler
	const handleApiError = useCallback((error: unknown, defaultMessage: string) => {
		console.error('API Error:', error);

		if (error instanceof Error) {
			if (error.message.includes('Network')) {
				toast.error('Network error. Please check your connection.');
			} else if (error.message.includes('Unauthorized')) {
				toast.error('Session expired. Please login again.');
			} else if (error.message.includes('404')) {
				toast.error('Resource not found. It may have been deleted.');
			} else {
				toast.error(error.message);
			}
		} else {
			toast.error(defaultMessage);
		}
	}, []);

	// Create custom format with validation
	const createFormat = useCallback(async (
		instanceId: string,
		format: Omit<CustomFormat, 'id'>
	): Promise<boolean> => {
		const validated = validateFormat(format);
		if (!validated) return false;

		try {
			await createMutation.mutateAsync({
				instanceId,
				customFormat: validated,
			});
			toast.success(`Custom format "${validated.name}" created successfully`);
			return true;
		} catch (error) {
			handleApiError(error, 'Failed to create custom format');
			return false;
		}
	}, [createMutation, validateFormat, handleApiError]);

	// Update custom format with validation
	const updateFormat = useCallback(async (
		instanceId: string,
		customFormatId: number,
		format: Partial<Omit<CustomFormat, 'id'>>
	): Promise<boolean> => {
		try {
			await updateMutation.mutateAsync({
				instanceId,
				customFormatId,
				customFormat: format,
			});
			toast.success(`Custom format updated successfully`);
			return true;
		} catch (error) {
			handleApiError(error, 'Failed to update custom format');
			return false;
		}
	}, [updateMutation, handleApiError]);

	// Delete custom format with confirmation
	const deleteFormat = useCallback(async (
		instanceId: string,
		customFormatId: number,
		name: string,
		skipConfirmation = false
	): Promise<boolean> => {
		if (!skipConfirmation && !window.confirm(`Delete custom format "${name}"?`)) {
			return false;
		}

		try {
			await deleteMutation.mutateAsync({ instanceId, customFormatId });
			toast.success(`Custom format "${name}" deleted successfully`);
			return true;
		} catch (error) {
			handleApiError(error, 'Failed to delete custom format');
			return false;
		}
	}, [deleteMutation, handleApiError]);

	// Bulk delete
	const bulkDeleteFormats = useCallback(async (
		formats: Array<{ instanceId: string; customFormatId: number; name: string }>
	): Promise<number> => {
		if (!window.confirm(`Delete ${formats.length} selected custom format(s)?`)) {
			return 0;
		}

		let successCount = 0;
		const deletePromises = formats.map(async ({ instanceId, customFormatId }) => {
			try {
				await deleteMutation.mutateAsync({ instanceId, customFormatId });
				successCount++;
			} catch (error) {
				console.error(`Failed to delete format ${customFormatId}:`, error);
			}
		});

		await Promise.all(deletePromises);

		if (successCount > 0) {
			toast.success(`${successCount} custom format(s) deleted successfully`);
		}
		if (successCount < formats.length) {
			toast.error(`Failed to delete ${formats.length - successCount} format(s)`);
		}

		return successCount;
	}, [deleteMutation]);

	// Export format
	const exportFormat = useCallback(async (
		instanceId: string,
		customFormatId: number,
		formatName: string
	): Promise<any | null> => {
		try {
			const formatData = await customFormatsApi.exportCustomFormat(instanceId, customFormatId);
			return formatData;
		} catch (error) {
			handleApiError(error, 'Failed to export custom format');
			return null;
		}
	}, [handleApiError]);

	// Import format with validation
	const importFormat = useCallback(async (
		instanceId: string,
		customFormat: any
	): Promise<boolean> => {
		const validated = validateFormat(customFormat);
		if (!validated) return false;

		try {
			await importMutation.mutateAsync({
				instanceId,
				customFormat: validated,
			});
			toast.success(`Custom format "${validated.name}" imported successfully`);
			return true;
		} catch (error) {
			handleApiError(error, 'Failed to import custom format');
			return false;
		}
	}, [importMutation, validateFormat, handleApiError]);

	// Import from TRaSH
	const importTrashFormat = useCallback(async (
		instanceId: string,
		trashId: string,
		service: 'SONARR' | 'RADARR',
		enableAutoSync = true
	): Promise<boolean> => {
		try {
			const result = await trashImportMutation.mutateAsync({
				instanceId,
				trashId,
				service,
			});

			// Optionally disable auto-sync
			if (!enableAutoSync && result.customFormat?.id) {
				await toggleExclusionMutation.mutateAsync({
					instanceId,
					customFormatId: result.customFormat.id,
					syncExcluded: true,
				});
			}

			toast.success(
				result.action === 'created'
					? `Format imported successfully`
					: `Format updated successfully`
			);
			return true;
		} catch (error) {
			handleApiError(error, 'Failed to import TRaSH format');
			return false;
		}
	}, [trashImportMutation, toggleExclusionMutation, handleApiError]);

	// Import multiple TRaSH formats
	const importMultipleTrashFormats = useCallback(async (
		formats: Array<{ trash_id: string; name: string }>,
		instanceId: string,
		service: 'SONARR' | 'RADARR'
	): Promise<{ success: number; failed: number }> => {
		let successCount = 0;
		let failCount = 0;

		for (const format of formats) {
			try {
				await trashImportMutation.mutateAsync({
					instanceId,
					trashId: format.trash_id,
					service,
				});
				successCount++;
			} catch (error) {
				failCount++;
				console.error(`Failed to import ${format.name}:`, error);
			}
		}

		if (successCount > 0) {
			toast.success(
				`Successfully imported ${successCount} custom format${successCount !== 1 ? 's' : ''}${
					failCount > 0 ? ` (${failCount} failed)` : ''
				}`
			);
		}
		if (failCount > 0 && successCount === 0) {
			toast.error(`Failed to import ${failCount} custom format${failCount !== 1 ? 's' : ''}`);
		}

		return { success: successCount, failed: failCount };
	}, [trashImportMutation]);

	// Sync TRaSH formats with debouncing to prevent rapid clicks
	const debouncedSyncTrash = useDebouncedCallback(
		async (instanceId: string, instanceLabel: string) => {
			try {
				const result = await syncTrashMutation.mutateAsync({ instanceId });
				if (result.synced > 0) {
					toast.success(`Synced ${result.synced} TRaSH custom format(s) for ${instanceLabel}`);
				} else {
					toast.info(`No TRaSH-managed custom formats to sync for ${instanceLabel}`);
				}
				if (result.failed > 0) {
					toast.warning(`${result.failed} format(s) failed to sync`);
				}
			} catch (error) {
				handleApiError(error, 'Failed to sync TRaSH formats');
			}
		},
		1000 // 1 second debounce
	);

	// Toggle sync exclusion
	const toggleSyncExclusion = useCallback(async (
		instanceId: string,
		customFormatId: number,
		currentlyExcluded: boolean,
		formatName: string
	): Promise<boolean> => {
		try {
			await toggleExclusionMutation.mutateAsync({
				instanceId,
				customFormatId,
				syncExcluded: !currentlyExcluded,
			});
			toast.success(
				!currentlyExcluded
					? `Auto-sync disabled for "${formatName}" - manual changes will be preserved`
					: `Auto-sync enabled for "${formatName}" - will receive TRaSH updates`
			);
			return true;
		} catch (error) {
			handleApiError(error, 'Failed to toggle auto-sync setting');
			return false;
		}
	}, [toggleExclusionMutation, handleApiError]);

	// Update instance sync settings
	const updateInstanceSyncSettings = useCallback(async (
		instanceId: string,
		settings: {
			enabled: boolean;
			intervalType: 'DISABLED' | 'HOURLY' | 'DAILY' | 'WEEKLY';
			intervalValue: number;
			syncFormats: boolean;
			syncCFGroups: boolean;
			syncQualityProfiles: boolean;
		}
	): Promise<boolean> => {
		try {
			await updateSyncSettingsMutation.mutateAsync({
				instanceId,
				settings,
			});
			toast.success('Auto-sync settings saved successfully');
			return true;
		} catch (error) {
			handleApiError(error, 'Failed to save auto-sync settings');
			return false;
		}
	}, [updateSyncSettingsMutation, handleApiError]);

	// Get processed data
	const instances = customFormatsData?.instances || [];

	const allFormats = useMemo(() => {
		return instances.flatMap((instance) => {
			const formats = Array.isArray(instance.customFormats) ? instance.customFormats : [];
			return formats.map((cf) => ({
				...cf,
				instanceId: instance.instanceId,
				instanceLabel: instance.instanceLabel,
				instanceService: instance.instanceService,
			}));
		});
	}, [instances]);

	return {
		// Data
		instances,
		allFormats,
		isLoading,
		trashTrackedData,
		allSyncSettings,

		// Helpers
		isTrackedByTrash,
		getTrashInfo,
		isSyncExcluded,

		// Actions
		createFormat,
		updateFormat,
		deleteFormat,
		bulkDeleteFormats,
		exportFormat,
		importFormat,
		importTrashFormat,
		importMultipleTrashFormats,
		syncTrash: debouncedSyncTrash,
		toggleSyncExclusion,
		updateInstanceSyncSettings,

		// Mutation states
		isCreating: createMutation.isPending,
		isUpdating: updateMutation.isPending,
		isDeleting: deleteMutation.isPending,
		isSyncing: syncTrashMutation.isPending,
		isImporting: importMutation.isPending || trashImportMutation.isPending,
		isTogglingExclusion: toggleExclusionMutation.isPending,
		isUpdatingSettings: updateSyncSettingsMutation.isPending,
	};
}