import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateOIDCProvider, OIDCProvider, UpdateOIDCProvider } from "@arr/shared";
import {
	createOIDCProvider,
	deleteOIDCProvider,
	getOIDCProviders,
	updateOIDCProvider,
} from "../../lib/api-client/oidc-providers";

/**
 * Fetch the configured OIDC provider (admin only)
 */
export function useOIDCProvider() {
	return useQuery({
		queryKey: ["oidc-provider"],
		queryFn: getOIDCProviders, // Returns { provider: OIDCProvider | null }
	});
}

/**
 * @deprecated Use useOIDCProvider instead - only one provider is supported
 */
export function useOIDCProviders() {
	return useOIDCProvider();
}

/**
 * Create the OIDC provider (admin only - only one allowed)
 */
export function useCreateOIDCProvider() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: CreateOIDCProvider) => createOIDCProvider(data),
		onSuccess: () => {
			// Invalidate provider query to refetch
			queryClient.invalidateQueries({ queryKey: ["oidc-provider"] });
		},
	});
}

/**
 * Update the OIDC provider (admin only)
 */
export function useUpdateOIDCProvider() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateOIDCProvider }) =>
			updateOIDCProvider(id, data),
		onSuccess: () => {
			// Invalidate provider query to refetch
			queryClient.invalidateQueries({ queryKey: ["oidc-provider"] });
		},
	});
}

/**
 * Delete the OIDC provider (admin only)
 */
export function useDeleteOIDCProvider() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => deleteOIDCProvider(id),
		onSuccess: () => {
			// Invalidate provider query to refetch
			queryClient.invalidateQueries({ queryKey: ["oidc-provider"] });
		},
	});
}
