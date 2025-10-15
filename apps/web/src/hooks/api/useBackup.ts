import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	CreateBackupRequest,
	RestoreBackupFromFileRequest,
	RestoreBackupRequest,
	UpdateBackupSettingsRequest,
} from "@arr/shared";
import { backupApi } from "../../lib/api-client/backup";

/**
 * Retrieve the list of backups stored on the filesystem.
 *
 * @returns The query result containing the backups array and React Query metadata (status, error, refetch, etc.).
 */
export function useBackups() {
	return useQuery({
		queryKey: ["backups"],
		queryFn: () => backupApi.listBackups(),
	});
}

/**
 * Provides a React Query mutation hook to create an encrypted backup.
 *
 * The mutation calls the API to create a backup and, on success, invalidates the `["backups"]` query to trigger a refetch of the backups list.
 *
 * @returns A React Query mutation object for creating an encrypted backup; on success the `["backups"]` query is invalidated.
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
 * Restore application state from an encrypted backup file uploaded by the user.
 *
 * @returns A React Query mutation object whose mutation function accepts a `RestoreBackupRequest` and performs the restore operation
 */
export function useRestoreBackup() {
	return useMutation({
		mutationFn: async (request: RestoreBackupRequest) => {
			return backupApi.restoreBackup(request);
		},
	});
}

/**
 * Provide a mutation to restore application state from a backup file on the filesystem.
 *
 * @returns A React Query mutation object that accepts a `RestoreBackupFromFileRequest` and restores the application from the specified filesystem backup file.
 */
export function useRestoreBackupFromFile() {
	return useMutation({
		mutationFn: async (request: RestoreBackupFromFileRequest) => {
			return backupApi.restoreBackupFromFile(request);
		},
	});
}

/**
 * Creates a mutation hook that deletes a backup by ID.
 *
 * The mutation calls the API to delete the specified backup and, on success, invalidates the `["backups"]` query to refresh the backups list.
 *
 * @returns The React Query mutation object which accepts a backup `id` (string) and performs the deletion.
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
 * Retrieve the current backup configuration settings.
 *
 * @returns The current backup settings
 */
export function useBackupSettings() {
	return useQuery({
		queryKey: ["backup-settings"],
		queryFn: () => backupApi.getSettings(),
	});
}

/**
 * Update backup settings and invalidate the cached settings query to trigger a refetch.
 *
 * @returns A React Query mutation configured to accept an `UpdateBackupSettingsRequest` and update backup settings; on success the `["backup-settings"]` query is invalidated.
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