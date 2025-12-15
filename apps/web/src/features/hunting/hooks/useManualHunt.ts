import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiError } from "../../../lib/api-client/base";

interface TriggerHuntResponse {
	message: string;
	queued: boolean;
}

async function triggerHunt(instanceId: string, type: "missing" | "upgrade"): Promise<TriggerHuntResponse> {
	return apiRequest<TriggerHuntResponse>(`/api/hunting/trigger/${instanceId}`, {
		method: "POST",
		json: { type },
	});
}

export function useManualHunt() {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: ({ instanceId, type }: { instanceId: string; type: "missing" | "upgrade" }) =>
			triggerHunt(instanceId, type),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["hunting"] });
		},
	});

	return {
		triggerHunt: async (instanceId: string, type: "missing" | "upgrade"): Promise<TriggerHuntResponse> => {
			try {
				return await mutation.mutateAsync({ instanceId, type });
			} catch (error) {
				// Re-throw with the original message if it's a 429 (cooldown)
				if (error instanceof ApiError && error.status === 429) {
					throw error;
				}
				throw error;
			}
		},
		isTriggering: mutation.isPending,
		error: mutation.error,
		// Helper to check if error is a cooldown error
		isCooldownError: (error: unknown): error is ApiError => {
			return error instanceof ApiError && error.status === 429;
		},
	};
}
