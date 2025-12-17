import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
	CreateBackupRequest,
	RestoreBackupFromFileRequest,
	RestoreBackupRequest,
	SetBackupPasswordRequest,
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

/**
 * Read a backup file and return it as a base64 string.
 * Uses chunked processing to avoid call stack overflow on large files.
 *
 * @returns A React Query mutation that accepts a File and returns a base64 string
 */
export function useReadBackupFile() {
	return useMutation({
		mutationFn: async (file: File) => {
			return backupApi.readBackupFile(file);
		},
	});
}

/**
 * Download a backup file by ID.
 * Triggers a browser download of the backup file.
 *
 * @returns A React Query mutation that accepts backup id and filename, and triggers a download
 */
export function useDownloadBackup() {
	return useMutation({
		mutationFn: async ({ id, filename }: { id: string; filename: string }) => {
			return backupApi.downloadBackupById(id, filename);
		},
	});
}

/**
 * Retrieve the backup password configuration status.
 *
 * @returns The query result containing whether a password is configured and its source.
 */
export function useBackupPasswordStatus() {
	return useQuery({
		queryKey: ["backup-password-status"],
		queryFn: () => backupApi.getPasswordStatus(),
	});
}

/**
 * Set or update the backup password.
 * On success, invalidates the password status query.
 *
 * @returns A React Query mutation object for setting the backup password.
 */
export function useSetBackupPassword() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async (request: SetBackupPasswordRequest) => {
			return backupApi.setPassword(request);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["backup-password-status"] });
		},
	});
}

/**
 * Remove the backup password from the database.
 * On success, invalidates the password status query.
 *
 * @returns A React Query mutation object for removing the backup password.
 */
export function useRemoveBackupPassword() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: async () => {
			return backupApi.removePassword();
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["backup-password-status"] });
		},
	});
}