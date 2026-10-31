import type {
	CreateBackupRequest,
	RestoreBackupFromFileRequest,
	RestoreBackupRequest,
	RestoreBackupResponse,
	SetBackupPasswordRequest,
	UpdateBackupSettingsRequest,
} from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useSyncExternalStore } from "react";
import { backupApi, RestoreRequestRejectedError } from "../../lib/api-client/backup";
import { reportProtectedUnauthorized } from "../../lib/auth-session-signal";
import { authKeys, backupKeys } from "../../lib/query-keys";

export type RestoreInput =
	| { kind: "upload"; request: RestoreBackupRequest }
	| { kind: "stored"; request: RestoreBackupFromFileRequest };

export type RestoreHandoff =
	| { kind: "published"; result: RestoreBackupResponse }
	| { kind: "unconfirmed" }
	| { kind: "rejected" };
type RestoreState = { pending: boolean; handoff: RestoreHandoff | null };
const emptyRestoreState: RestoreState = { pending: false, handoff: null };
let restoreState = emptyRestoreState;
const restoreListeners = new Set<() => void>();
const readRestoreState = () => restoreState;
const readServerRestoreState = () => emptyRestoreState;
function subscribeRestore(listener: () => void) {
	restoreListeners.add(listener);
	return () => {
		restoreListeners.delete(listener);
	};
}
function updateRestoreState(state: RestoreState) {
	restoreState = state;
	for (const listener of restoreListeners) listener();
}

/** Tab-memory notice only; the UI offers dismissal after a fresh protected GET. */
export function clearRestoreHandoff() {
	if (!restoreState.pending) updateRestoreState(emptyRestoreState);
}

export function useRestoreState() {
	return useSyncExternalStore(subscribeRestore, readRestoreState, readServerRestoreState);
}

/** Publication is never replayed; sensitive input never becomes mutation variables. */
export function useRestoreBackup() {
	const queryClient = useQueryClient();
	const input = useRef<RestoreInput | null>(null);
	const state = useRestoreState();
	const quarantine = async () => {
		await queryClient.cancelQueries();
		queryClient.getQueryCache().clear();
		queryClient.setQueryData(authKeys.currentUser, null);
		// Existing AuthGate hides potentially replaced account data while checking
		// the runtime. Neither this signal nor a notice proves restart/readiness.
		reportProtectedUnauthorized();
	};
	const mutation = useMutation({
		mutationKey: backupKeys.restore,
		retry: false,
		gcTime: 0,
		mutationFn: () => {
			const selection = input.current;
			input.current = null;
			if (!selection) throw new Error("No restore input selected.");
			return selection.kind === "upload"
				? backupApi.restoreBackup(selection.request)
				: backupApi.restoreBackupFromFile(selection.request);
		},
		onSuccess: async (result) => {
			// Publish the secret-free notice before auth recovery can unmount us.
			updateRestoreState({ pending: true, handoff: { kind: "published", result } });
			if (result.outcome !== "not-committed") await quarantine();
		},
		onError: async (error) => {
			if (
				error instanceof RestoreRequestRejectedError &&
				([400, 409].includes(error.status) ||
					(error.status === 429 && error.category === "restore-rate-limited"))
			)
				return;
			updateRestoreState({
				pending: true,
				handoff: {
					kind: error instanceof RestoreRequestRejectedError ? "rejected" : "unconfirmed",
				},
			});
			await quarantine();
		},
	});
	return {
		isPending: state.pending,
		isBlocked: state.handoff !== null,
		handoff: state.handoff,
		async mutateAsync(selection: RestoreInput) {
			if (restoreState.pending || restoreState.handoff)
				throw new Error("Restore is running or awaiting recovery. Do not repeat the request.");
			updateRestoreState({ pending: true, handoff: null });
			input.current = selection;
			try {
				return await mutation.mutateAsync();
			} finally {
				input.current = null;
				mutation.reset();
				updateRestoreState({ pending: false, handoff: restoreState.handoff });
			}
		},
	};
}

/** Explicit protected observation only; absence never establishes non-commit. */
export function useRestoreStatus(enabled = false) {
	return useQuery({
		queryKey: backupKeys.restoreStatus,
		queryFn: () => backupApi.getRestoreStatus(),
		enabled,
		retry: false,
		refetchOnMount: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
	});
}

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
