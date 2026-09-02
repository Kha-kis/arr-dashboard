import type {
	CreateBackupRequest,
	SetBackupPasswordRequest,
	UpdateBackupSettingsRequest,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { backupApi } from "../../lib/api-client/backup";
import { backupKeys } from "../../lib/query-keys";

/**
 * Retrieve the list of backups stored on the filesystem.
 *
 * @returns The query result containing the backups array and React Query metadata (status, error, refetch, etc.).
 */
export function useBackups() {
	return useQuery({
		queryKey: backupKeys.all,
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
			queryClient.invalidateQueries({ queryKey: backupKeys.all });
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
			queryClient.invalidateQueries({ queryKey: backupKeys.all });
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
		queryKey: backupKeys.settings,
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
			queryClient.invalidateQueries({ queryKey: backupKeys.settings });
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
		queryKey: backupKeys.passwordStatus,
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
			queryClient.invalidateQueries({ queryKey: backupKeys.passwordStatus });
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
			queryClient.invalidateQueries({ queryKey: backupKeys.passwordStatus });
		},
	});
}
