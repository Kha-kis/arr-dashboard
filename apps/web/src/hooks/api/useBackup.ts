import { useMutation } from "@tanstack/react-query";
import type { CreateBackupRequest, RestoreBackupRequest } from "@arr/shared";
import { backupApi } from "../../lib/api-client/backup";

/**
 * Create an encrypted backup
 */
export function useCreateBackup() {
	return useMutation({
		mutationFn: async (request: CreateBackupRequest) => {
			return backupApi.createBackup(request);
		},
	});
}

/**
 * Restore from an encrypted backup
 */
export function useRestoreBackup() {
	return useMutation({
		mutationFn: async (request: RestoreBackupRequest) => {
			return backupApi.restoreBackup(request);
		},
	});
}
