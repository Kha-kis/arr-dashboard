import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CreateOIDCProvider, OIDCProvider, UpdateOIDCProvider } from "@arr/shared";
import {
	createOIDCProvider,
	deleteOIDCProvider,
	getOIDCProviders,
	updateOIDCProvider,
} from "../../lib/api-client/oidc-providers";

/**
 * Fetch all OIDC providers (admin only)
 */
export function useOIDCProviders() {
	return useQuery({
		queryKey: ["oidc-providers"],
		queryFn: getOIDCProviders,
	});
}

/**
 * Create a new OIDC provider (admin only)
 */
export function useCreateOIDCProvider() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (data: CreateOIDCProvider) => createOIDCProvider(data),
		onSuccess: () => {
			// Invalidate provider list to refetch
			queryClient.invalidateQueries({ queryKey: ["oidc-providers"] });
		},
	});
}

/**
 * Update an existing OIDC provider (admin only)
 */
export function useUpdateOIDCProvider() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: ({ id, data }: { id: string; data: UpdateOIDCProvider }) =>
			updateOIDCProvider(id, data),
		onSuccess: () => {
			// Invalidate provider list to refetch
			queryClient.invalidateQueries({ queryKey: ["oidc-providers"] });
		},
	});
}

/**
 * Delete an OIDC provider (admin only)
 */
export function useDeleteOIDCProvider() {
	const queryClient = useQueryClient();

	return useMutation({
		mutationFn: (id: string) => deleteOIDCProvider(id),
		onSuccess: () => {
			// Invalidate provider list to refetch
			queryClient.invalidateQueries({ queryKey: ["oidc-providers"] });
		},
	});
}
