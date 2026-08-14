import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
	clearValidationQuarantine,
	dismissTautulliProviderNotice,
	fetchAnalyticsProviderSelection,
	fetchLogFiles,
	fetchSecurityPosture,
	fetchSystemInfo,
	fetchSystemJobs,
	fetchSystemSettings,
	fetchTautulliProviderNotices,
	fetchValidationHealth,
	fetchValidationQuarantine,
	type LogFilesResponse,
	type AnalyticsProviderSelectionResponse,
	type QuarantineResponse,
	resetValidationHealth,
	restartSystem,
	type SecurityPostureResponse,
	type SystemInfoResponse,
	type SystemJobsResponse,
	type SystemSettingsResponse,
	type TautulliNoticeKey,
	type TautulliProviderNoticesResponse,
	type UpdateSystemSettingsPayload,
	type UpdateAnalyticsProviderSelectionPayload,
	updateAnalyticsProviderSelection,
	updateSystemSettings,
	type ValidationHealthResponse,
} from "../../lib/api-client/system";
import { getErrorMessage } from "../../lib/error-utils";
import { POLLING_STANDARD, POLLING_STATS } from "../../lib/polling-intervals";
import {
	serviceKeys,
	systemKeys,
	tautulliKeys,
	tracearrKeys,
	validationKeys,
} from "../../lib/query-keys";

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
			queryClient.invalidateQueries({ queryKey: systemKeys.securityPosture });
			toast.success(response.message || "Settings saved");
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to save settings"));
		},
	});
}

export function useAnalyticsProviderSelection() {
	return useQuery<AnalyticsProviderSelectionResponse>({
		queryKey: systemKeys.analyticsProvider,
		queryFn: fetchAnalyticsProviderSelection,
	});
}

export function useUpdateAnalyticsProviderSelection() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: UpdateAnalyticsProviderSelectionPayload) =>
			updateAnalyticsProviderSelection(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: systemKeys.analyticsProvider });
			queryClient.invalidateQueries({ queryKey: tracearrKeys.all });
			queryClient.invalidateQueries({ queryKey: tautulliKeys.all });
			queryClient.invalidateQueries({ queryKey: serviceKeys.all });
			queryClient.invalidateQueries({ queryKey: systemKeys.tautulliProviderNotices });
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to update analytics provider"));
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
// Background Jobs (scheduler registry)
// ============================================================================

export function useSystemJobs() {
	return useQuery<SystemJobsResponse>({
		queryKey: systemKeys.jobs,
		queryFn: fetchSystemJobs,
		staleTime: 30_000,
		refetchInterval: POLLING_STATS,
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
// Tautulli Provider Notices (3.0)
// ============================================================================

export function useTautulliProviderNotices() {
	return useQuery<TautulliProviderNoticesResponse>({
		queryKey: systemKeys.tautulliProviderNotices,
		queryFn: fetchTautulliProviderNotices,
	});
}

export function useDismissTautulliProviderNotice() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (key: TautulliNoticeKey) => dismissTautulliProviderNotice(key),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: systemKeys.tautulliProviderNotices });
		},
		onError: (err) => {
			toast.error(`Failed to dismiss Tautulli notice: ${getErrorMessage(err)}`);
		},
	});
}
