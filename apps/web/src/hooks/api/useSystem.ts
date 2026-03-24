import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	type LogFilesResponse,
	type SystemInfoResponse,
	type SystemSettingsResponse,
	type UpdateSystemSettingsPayload,
	type ValidationHealthResponse,
	type QuarantineResponse,
	clearValidationQuarantine,
	fetchLogFiles,
	fetchSystemInfo,
	fetchSystemSettings,
	fetchValidationHealth,
	fetchValidationQuarantine,
	resetValidationHealth,
	restartSystem,
	updateSystemSettings,
} from "../../lib/api-client/system";
import { getErrorMessage } from "../../lib/error-utils";
import { POLLING_STANDARD } from "../../lib/polling-intervals";
import { systemKeys, validationKeys } from "../../lib/query-keys";

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
