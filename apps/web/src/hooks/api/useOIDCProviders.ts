import type { CreateOIDCProvider, UpdateOIDCProvider } from "@arr/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	createOIDCProvider,
	deleteOIDCProvider,
	getOIDCProvider,
	updateOIDCProvider,
} from "../../lib/api-client/oidc-providers";
import { oidcKeys } from "../../lib/query-keys";

/**
 * Fetch the configured OIDC provider (admin only)
 *
 * Returns the single OIDC provider for this installation wrapped in { provider: OIDCProvider | null }
 */
export function useOIDCProvider() {
	return useQuery({
		queryKey: oidcKeys.provider,
		queryFn: getOIDCProvider, // Returns { provider: OIDCProvider | null }
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
			queryClient.invalidateQueries({ queryKey: oidcKeys.provider });
		},
	});
}

/**
 * Update the OIDC provider (admin only, singleton)
 */
export function useUpdateOIDCProvider() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: UpdateOIDCProvider) => updateOIDCProvider(data),
		onSuccess: () => {
			// Invalidate provider query to refetch
			queryClient.invalidateQueries({ queryKey: oidcKeys.provider });
		},
	});
}

/**
 * Delete the OIDC provider (admin only, singleton)
 */
export function useDeleteOIDCProvider() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: () => deleteOIDCProvider(),
		onSuccess: () => {
			// Invalidate provider query to refetch
			queryClient.invalidateQueries({ queryKey: oidcKeys.provider });
		},
	});
}
