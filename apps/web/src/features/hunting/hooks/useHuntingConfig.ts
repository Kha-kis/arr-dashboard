import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../../../lib/api-client/base";
import type { HuntConfigWithInstance, HuntConfigUpdate, InstanceSummary } from "../lib/hunting-types";

interface HuntingConfigsResponse {
	configs: (HuntConfigWithInstance | null)[];
	instances: InstanceSummary[];
}

/**
 * Fetches hunting configurations along with instance summaries.
 *
 * @returns An object with `configs` (array of hunt configurations or `null`) and `instances` (array of instance summaries)
 */
async function fetchHuntingConfigs(): Promise<HuntingConfigsResponse> {
	return apiRequest<HuntingConfigsResponse>("/api/hunting/configs");
}

/**
 * Update the hunting configuration for a specific instance.
 *
 * @param instanceId - Identifier of the instance whose hunt configuration will be updated
 * @param data - Partial hunt configuration fields to apply to the instance
 * @returns The updated hunt configuration including instance metadata
 */
async function updateHuntConfig(instanceId: string, data: HuntConfigUpdate): Promise<HuntConfigWithInstance> {
	return apiRequest<HuntConfigWithInstance>(`/api/hunting/configs/${instanceId}`, {
		method: "PATCH",
		json: data,
	});
}

/**
 * Creates a hunting configuration for the specified instance.
 *
 * @param instanceId - The identifier of the instance to create a configuration for
 * @returns The created `HuntConfigWithInstance` containing the new configuration and its instance metadata
 */
async function createHuntConfig(instanceId: string): Promise<HuntConfigWithInstance> {
	return apiRequest<HuntConfigWithInstance>("/api/hunting/configs", {
		method: "POST",
		json: { instanceId },
	});
}

/**
 * Toggle the hunting scheduler on the server.
 *
 * @returns An object with `running` set to `true` if the scheduler is running, `false` otherwise.
 */
async function toggleScheduler(): Promise<{ running: boolean }> {
	return apiRequest<{ running: boolean }>("/api/hunting/scheduler/toggle", {
		method: "POST",
	});
}

/**
 * Provides hunting configurations, instance summaries, loading/error state, and a refetch function.
 *
 * @returns An object containing:
 * - `configs`: an array of `HuntConfigWithInstance` (empty if none).
 * - `instances`: an array of `InstanceSummary` (empty if none).
 * - `isLoading`: `true` while the query is loading, `false` otherwise.
 * - `error`: the query error object if the request failed, otherwise `undefined`.
 * - `refetch`: a function to re-fetch the hunting configurations and instances.
 */
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

/**
 * Provide mutations to create or update hunting configurations and expose their status.
 *
 * @returns An object with:
 * - `updateConfig(instanceId, data)` - Updates the hunt configuration for `instanceId` with `data` and returns the updated hunt configuration.
 * - `createConfig(instanceId)` - Creates a hunt configuration for `instanceId` and returns the created hunt configuration.
 * - `isUpdating` - `true` when an update operation is pending, `false` otherwise.
 * - `isCreating` - `true` when a create operation is pending, `false` otherwise.
 * - `error` - The error from the update operation if present, otherwise the error from the create operation, or `undefined` if neither failed.
 */
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

/**
 * Provides a mutation hook to toggle the hunting scheduler and refresh related hunting data.
 *
 * @returns An object with:
 * - `toggleScheduler` — a function that triggers the scheduler toggle.
 * - `isToggling` — `true` if the toggle operation is in progress, `false` otherwise.
 * - `error` — the mutation error object if the toggle failed, otherwise `undefined`.
 */
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