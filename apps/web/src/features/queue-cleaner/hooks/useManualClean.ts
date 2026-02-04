import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiError } from "../../../lib/api-client/base";

interface TriggerCleanResponse {
	message: string;
	triggered: boolean;
}

async function triggerClean(instanceId: string): Promise<TriggerCleanResponse> {
	return apiRequest<TriggerCleanResponse>(
		`/api/queue-cleaner/trigger/${instanceId}`,
		{ method: "POST" },
	);
}

export function useManualClean() {
	const queryClient = useQueryClient();

	const mutation = useMutation({
		mutationFn: (instanceId: string) => triggerClean(instanceId),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["queue-cleaner"] });
		},
	});

	return {
		triggerClean: async (instanceId: string): Promise<TriggerCleanResponse> => {
			try {
				return await mutation.mutateAsync(instanceId);
			} catch (error) {
				if (error instanceof ApiError && error.status === 429) {
					throw error;
				}
				throw error;
			}
		},
		isTriggering: mutation.isPending,
		error: mutation.error,
		isCooldownError: (error: unknown): error is ApiError => {
			return error instanceof ApiError && error.status === 429;
		},
	};
}
