import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	CreateBackupRequest,
	RestoreBackupFromFileRequest,
	RestoreBackupRequest,
	UpdateBackupSettingsRequest,
} from "@arr/shared";
import { backupApi } from "../../lib/api-client/backup";

/**
 * List all backups from filesystem
 */
export function useBackups() {
	return useQuery({
		queryKey: ["backups"],
		queryFn: () => backupApi.listBackups(),
	});
}

/**
 * Create an encrypted backup
 */
export function useCreateBackup() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (request: CreateBackupRequest) => {
			return backupApi.createBackup(request);
		},
		onSuccess: () => {
			// Invalidate backups list to refetch
			queryClient.invalidateQueries({ queryKey: ["backups"] });
		},
	});
}

/**
 * Restore from an encrypted backup (uploaded file)
 */
export function useRestoreBackup() {
	return useMutation({
		mutationFn: async (request: RestoreBackupRequest) => {
			return backupApi.restoreBackup(request);
		},
	});
}

/**
 * Restore from a backup stored on filesystem
 */
export function useRestoreBackupFromFile() {
	return useMutation({
		mutationFn: async (request: RestoreBackupFromFileRequest) => {
			return backupApi.restoreBackupFromFile(request);
		},
	});
}

/**
 * Delete a backup by ID
 */
export function useDeleteBackup() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (id: string) => {
			return backupApi.deleteBackup(id);
		},
		onSuccess: () => {
			// Invalidate backups list to refetch
			queryClient.invalidateQueries({ queryKey: ["backups"] });
		},
	});
}

/**
 * Get backup settings
 */
export function useBackupSettings() {
	return useQuery({
		queryKey: ["backup-settings"],
		queryFn: () => backupApi.getSettings(),
	});
}

/**
 * Update backup settings
 */
export function useUpdateBackupSettings() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (request: UpdateBackupSettingsRequest) => {
			return backupApi.updateSettings(request);
		},
		onSuccess: () => {
			// Invalidate settings to refetch
			queryClient.invalidateQueries({ queryKey: ["backup-settings"] });
		},
	});
}
