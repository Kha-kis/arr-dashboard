import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type {
	QueueCleanerConfigWithInstance,
	QueueCleanerConfigUpdate,
	InstanceSummary,
} from "../lib/queue-cleaner-types";

interface ConfigsResponse {
	configs: (QueueCleanerConfigWithInstance | null)[];
	instances: InstanceSummary[];
}

async function fetchConfigs(): Promise<ConfigsResponse> {
	return apiRequest<ConfigsResponse>("/api/queue-cleaner/configs");
}

async function updateConfig(
	instanceId: string,
	data: QueueCleanerConfigUpdate,
): Promise<QueueCleanerConfigWithInstance> {
	return apiRequest<QueueCleanerConfigWithInstance>(
		`/api/queue-cleaner/configs/${instanceId}`,
		{ method: "PATCH", json: data },
	);
}

async function createConfig(instanceId: string): Promise<QueueCleanerConfigWithInstance> {
	return apiRequest<QueueCleanerConfigWithInstance>("/api/queue-cleaner/configs", {
		method: "POST",
		json: { instanceId },
	});
}

async function deleteConfig(instanceId: string): Promise<void> {
	return apiRequest<void>(`/api/queue-cleaner/configs/${instanceId}`, {
		method: "DELETE",
	});
}

export function useQueueCleanerConfigs() {
	const query = useQuery({
		queryKey: ["queue-cleaner", "configs"],
		queryFn: fetchConfigs,
	});

	return {
		configs: query.data?.configs ?? [],
		instances: query.data?.instances ?? [],
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}

export function useUpdateQueueCleanerConfig() {
	const queryClient = useQueryClient();

	const updateMutation = useMutation({
		mutationFn: ({
			instanceId,
			data,
		}: {
			instanceId: string;
			data: QueueCleanerConfigUpdate;
		}) => updateConfig(instanceId, data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["queue-cleaner"] });
		},
	});

	const createMutation = useMutation({
		mutationFn: (instanceId: string) => createConfig(instanceId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["queue-cleaner"] });
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (instanceId: string) => deleteConfig(instanceId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["queue-cleaner"] });
		},
	});

	return {
		updateConfig: (instanceId: string, data: QueueCleanerConfigUpdate) =>
			updateMutation.mutateAsync({ instanceId, data }),
		createConfig: (instanceId: string) => createMutation.mutateAsync(instanceId),
		deleteConfig: (instanceId: string) => deleteMutation.mutateAsync(instanceId),
		isUpdating: updateMutation.isPending,
		isCreating: createMutation.isPending,
		isDeleting: deleteMutation.isPending,
		error: updateMutation.error ?? createMutation.error ?? deleteMutation.error,
	};
}

export function useToggleCleanerScheduler() {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: () =>
			apiRequest<{ running: boolean }>("/api/queue-cleaner/scheduler/toggle", {
				method: "POST",
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["queue-cleaner"] });
		},
	});

	return {
		toggleScheduler: mutation.mutateAsync,
		isToggling: mutation.isPending,
		error: mutation.error,
	};
}
