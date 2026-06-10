import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	clearValidationQuarantine,
	fetchLogFiles,
	fetchSecurityPosture,
	completeTautulliMigration,
	fetchSystemInfo,
	fetchSystemSettings,
	fetchTautulliMigrationStatus,
	fetchValidationHealth,
	fetchValidationQuarantine,
	type LogFilesResponse,
	type QuarantineResponse,
	resetValidationHealth,
	restartSystem,
	type SecurityPostureResponse,
	type SystemInfoResponse,
	type SystemSettingsResponse,
	type TautulliMigrationStatus,
	type UpdateSystemSettingsPayload,
	updateSystemSettings,
	type ValidationHealthResponse,
} from "../../lib/api-client/system";
import { UnauthorizedError } from "../../lib/api-client/base";
import { getErrorMessage } from "../../lib/error-utils";
import { POLLING_STANDARD } from "../../lib/polling-intervals";
import { pulseKeys, serviceKeys, systemKeys, validationKeys } from "../../lib/query-keys";

// ============================================================================
// System Settings
// ============================================================================

export function useSystemSettings() {
	return useQuery<SystemSettingsResponse>({
		queryKey: systemKeys.settings,
		queryFn: fetchSystemSettings,
	});
}

export function useUpdateSystemSettings() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: UpdateSystemSettingsPayload) => updateSystemSettings(data),
		onSuccess: (response) => {
			queryClient.invalidateQueries({ queryKey: systemKeys.settings });
			toast.success(response.message || "Settings saved");
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to save settings"));
		},
	});
}

// ============================================================================
// System Info
// ============================================================================

export function useSystemInfo() {
	return useQuery<SystemInfoResponse>({
		queryKey: systemKeys.info,
		queryFn: fetchSystemInfo,
		refetchInterval: POLLING_STANDARD,
	});
}

// ============================================================================
// Log Files
// ============================================================================

export function useLogFiles() {
	return useQuery<LogFilesResponse>({
		queryKey: systemKeys.logs,
		queryFn: fetchLogFiles,
	});
}

// ============================================================================
// System Restart
// ============================================================================

export function useRestartSystem() {
	return useMutation({
		mutationFn: restartSystem,
		onSuccess: (response) => {
			toast.success(response.message || "Restart initiated");
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to restart"));
		},
	});
}

// ============================================================================
// Validation Health
// ============================================================================

export function useValidationHealth() {
	return useQuery<ValidationHealthResponse>({
		queryKey: validationKeys.health,
		queryFn: fetchValidationHealth,
		refetchInterval: POLLING_STANDARD,
	});
}

export function useResetValidationHealth() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: resetValidationHealth,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: validationKeys.health });
			toast.success("Validation health stats reset");
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to reset validation health"));
		},
	});
}

// ============================================================================
// Validation Quarantine
// ============================================================================

export function useValidationQuarantine() {
	return useQuery<QuarantineResponse>({
		queryKey: validationKeys.quarantine,
		queryFn: fetchValidationQuarantine,
		refetchInterval: POLLING_STANDARD,
	});
}

// ============================================================================
// Security Posture
// ============================================================================

export function useSecurityPosture() {
	return useQuery<SecurityPostureResponse>({
		queryKey: systemKeys.securityPosture,
		queryFn: fetchSecurityPosture,
		refetchInterval: POLLING_STANDARD,
	});
}

export function useClearQuarantine() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: clearValidationQuarantine,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: validationKeys.quarantine });
			toast.success("Quarantine cleared");
		},
		onError: (err) => {
			toast.error(`Failed to clear quarantine: ${getErrorMessage(err)}`);
		},
	});
}

// ============================================================================
// Tautulli Removal Migration (3.0 — ADR-0007)
// ============================================================================

export function useTautulliMigrationStatus() {
	return useQuery<TautulliMigrationStatus>({
		queryKey: systemKeys.tautulliMigration,
		queryFn: fetchTautulliMigrationStatus,
		// One-shot gate: no polling. Re-checked on mount and after the
		// completion mutation invalidates the key.
		staleTime: Number.POSITIVE_INFINITY,
		// A 401 must not block the app, but a transient failure (API still
		// booting right after the 3.0 upgrade — the likeliest moment) must
		// not permanently hide a required migration gate either: retry a
		// few times, then keep probing while errored.
		retry: (failureCount, error) => !(error instanceof UnauthorizedError) && failureCount < 3,
		refetchInterval: (query) => (query.state.status === "error" ? POLLING_STANDARD : false),
	});
}

export function useCompleteTautulliMigration() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: completeTautulliMigration,
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: systemKeys.tautulliMigration });
			// Instance rows were deleted (cache rows cascade) — refresh the
			// services list and any Pulse rows derived from lingering caches.
			queryClient.invalidateQueries({ queryKey: serviceKeys.all });
			queryClient.invalidateQueries({ queryKey: pulseKeys.all });
			toast.success("Tautulli removed — you're all set");
		},
		onError: (err) => {
			toast.error(`Failed to complete migration: ${getErrorMessage(err)}`);
		},
	});
}
