import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest, ApiError } from "../../../lib/api-client/base";

interface TriggerHuntResponse {
	message: string;
	queued: boolean;
}

/**
 * Trigger a manual hunt for a specific instance.
 *
 * @param instanceId - The identifier of the instance to trigger the hunt for
 * @param type - The hunt type: `"missing"` to find missing items or `"upgrade"` to find available upgrades
 * @returns The API response containing a `message` and a `queued` flag indicating whether the hunt was accepted
 */
async function triggerHunt(instanceId: string, type: "missing" | "upgrade"): Promise<TriggerHuntResponse> {
	return apiRequest<TriggerHuntResponse>(`/api/hunting/trigger/${instanceId}`, {
		method: "POST",
		json: { type },
	});
}

/**
 * Utilities for triggering a manual hunt for an instance and observing the trigger state.
 *
 * @returns An object containing:
 * - `triggerHunt(instanceId, type)` — triggers a hunt for the given instance and resolves to the `TriggerHuntResponse` from the API.
 * - `isTriggering` — `true` while the trigger request is pending, `false` otherwise.
 * - `error` — the last mutation error, if any.
 * - `isCooldownError(error)` — type guard that returns `true` if `error` is an `ApiError` with HTTP status `429`.
 */
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