import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { HuntConfigWithInstance, HuntConfigUpdate, InstanceSummary } from "../lib/hunting-types";

interface HuntingConfigsResponse {
	configs: (HuntConfigWithInstance | null)[];
	instances: InstanceSummary[];
}

async function fetchHuntingConfigs(): Promise<HuntingConfigsResponse> {
	return apiRequest<HuntingConfigsResponse>("/api/hunting/configs");
}

async function updateHuntConfig(instanceId: string, data: HuntConfigUpdate): Promise<HuntConfigWithInstance> {
	return apiRequest<HuntConfigWithInstance>(`/api/hunting/configs/${instanceId}`, {
		method: "PATCH",
		body: JSON.stringify(data),
	});
}

async function createHuntConfig(instanceId: string): Promise<HuntConfigWithInstance> {
	return apiRequest<HuntConfigWithInstance>("/api/hunting/configs", {
		method: "POST",
		body: JSON.stringify({ instanceId }),
	});
}

async function toggleScheduler(): Promise<{ running: boolean }> {
	return apiRequest<{ running: boolean }>("/api/hunting/scheduler/toggle", {
		method: "POST",
	});
}

export function useHuntingConfigs() {
	const query = useQuery({
		queryKey: ["hunting", "configs"],
		queryFn: fetchHuntingConfigs,
	});

	return {
		configs: query.data?.configs ?? [],
		instances: query.data?.instances ?? [],
		isLoading: query.isLoading,
		error: query.error,
		refetch: query.refetch,
	};
}

export function useUpdateHuntConfig() {
	const queryClient = useQueryClient();

	const updateMutation = useMutation({
		mutationFn: ({ instanceId, data }: { instanceId: string; data: HuntConfigUpdate }) =>
			updateHuntConfig(instanceId, data),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["hunting"] });
		},
	});

	const createMutation = useMutation({
		mutationFn: (instanceId: string) => createHuntConfig(instanceId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["hunting"] });
		},
	});

	return {
		updateConfig: (instanceId: string, data: HuntConfigUpdate) =>
			updateMutation.mutateAsync({ instanceId, data }),
		createConfig: (instanceId: string) => createMutation.mutateAsync(instanceId),
		isUpdating: updateMutation.isPending,
		isCreating: createMutation.isPending,
		error: updateMutation.error ?? createMutation.error,
	};
}

export function useToggleScheduler() {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: toggleScheduler,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["hunting"] });
		},
	});

	return {
		toggleScheduler: mutation.mutateAsync,
		isToggling: mutation.isPending,
		error: mutation.error,
	};
}
