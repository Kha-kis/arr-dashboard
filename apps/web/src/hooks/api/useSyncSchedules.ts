import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiRequest } from "../../lib/api-client/base";
import { getErrorMessage } from "../../lib/error-utils";
import { trashGuidesKeys } from "../../lib/query-keys";

// ============================================================================
// Types
// ============================================================================

export interface SyncSchedule {
	id: string;
	templateId: string | null;
	instanceId: string | null;
	userId: string;
	enabled: boolean;
	frequency: "DAILY" | "WEEKLY" | "MONTHLY";
	lastRunAt: string | null;
	nextRunAt: string | null;
	autoApply: boolean;
	notifyUser: boolean;
	createdAt: string;
	updatedAt: string;
	template?: { id: string; name: string; serviceType: string } | null;
	instance?: { id: string; label: string; service: string } | null;
}

export interface CreateSchedulePayload {
	templateId: string;
	instanceId: string;
	frequency: "DAILY" | "WEEKLY" | "MONTHLY";
	enabled?: boolean;
	autoApply?: boolean;
	notifyUser?: boolean;
}

export interface UpdateSchedulePayload {
	frequency?: "DAILY" | "WEEKLY" | "MONTHLY";
	enabled?: boolean;
	autoApply?: boolean;
	notifyUser?: boolean;
}

// ============================================================================
// API Functions
// ============================================================================

function fetchSchedules(): Promise<{ success: boolean; data: SyncSchedule[] }> {
	return apiRequest("/api/trash-guides/schedules");
}

function fetchScheduleByLink(
	templateId: string,
	instanceId: string,
): Promise<{ success: boolean; data: SyncSchedule | null }> {
	return apiRequest(
		`/api/trash-guides/schedules/by-link?templateId=${encodeURIComponent(templateId)}&instanceId=${encodeURIComponent(instanceId)}`,
	);
}

function createSchedule(
	payload: CreateSchedulePayload,
): Promise<{ success: boolean; data: SyncSchedule }> {
	return apiRequest("/api/trash-guides/schedules", { method: "POST", json: payload });
}

function updateSchedule(
	id: string,
	payload: UpdateSchedulePayload,
): Promise<{ success: boolean; data: SyncSchedule }> {
	return apiRequest(`/api/trash-guides/schedules/${id}`, { method: "PUT", json: payload });
}

function deleteSchedule(id: string): Promise<{ success: boolean; message: string }> {
	return apiRequest(`/api/trash-guides/schedules/${id}`, { method: "DELETE" });
}

// ============================================================================
// Hooks
// ============================================================================

export function useSyncSchedules() {
	return useQuery({
		queryKey: trashGuidesKeys.schedules.all,
		queryFn: fetchSchedules,
		staleTime: 60 * 1000,
	});
}

export function useSyncScheduleByLink(templateId: string | null, instanceId: string | null) {
	return useQuery({
		queryKey: trashGuidesKeys.schedules.byLink(templateId!, instanceId!),
		queryFn: () => fetchScheduleByLink(templateId!, instanceId!),
		enabled: !!templateId && !!instanceId,
		staleTime: 60 * 1000,
	});
}

export function useCreateSyncSchedule() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (payload: CreateSchedulePayload) => createSchedule(payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: trashGuidesKeys.schedules.all });
			toast.success("Sync schedule created");
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to create schedule"));
		},
	});
}

export function useUpdateSyncSchedule() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, payload }: { id: string; payload: UpdateSchedulePayload }) =>
			updateSchedule(id, payload),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: trashGuidesKeys.schedules.all });
			toast.success("Sync schedule updated");
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to update schedule"));
		},
	});
}

export function useDeleteSyncSchedule() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => deleteSchedule(id),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: trashGuidesKeys.schedules.all });
			toast.success("Sync schedule removed");
		},
		onError: (error) => {
			toast.error(getErrorMessage(error, "Failed to delete schedule"));
		},
	});
}
