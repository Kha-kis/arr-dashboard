import type {
	CreateOIDCProvider,
	OIDCProvider,
	OIDCProviderResponse,
	UpdateOIDCProvider,
} from "@arr/shared";
import { apiRequest } from "./base";

/**
 * Get the configured OIDC provider (admin only)
 *
 * Returns a wrapper object containing the single OIDC provider for this installation.
 * Only one OIDC provider is supported per installation.
 *
 * @returns Promise resolving to { provider: OIDCProvider | null }
 */
export async function getOIDCProvider(): Promise<OIDCProviderResponse> {
	return apiRequest<OIDCProviderResponse>("/api/oidc-providers", {
		method: "GET",
	});
}

/**
 * @deprecated Use getOIDCProvider instead - renamed to reflect single-provider semantics
 */
export const getOIDCProviders = getOIDCProvider;

/**
 * Create a new OIDC provider (admin only)
 */
export async function createOIDCProvider(data: CreateOIDCProvider): Promise<OIDCProvider> {
	return apiRequest<OIDCProvider>("/api/oidc-providers", {
		method: "POST",
		json: data,
	});
}

/**
 * Update an existing OIDC provider (admin only)
 */
export async function updateOIDCProvider(
	id: string,
	data: UpdateOIDCProvider,
): Promise<OIDCProvider> {
	return apiRequest<OIDCProvider>(`/api/oidc-providers/${id}`, {
		method: "PUT",
		json: data,
	});
}

/**
 * Delete an OIDC provider (admin only)
 */
export async function deleteOIDCProvider(id: string): Promise<void> {
	await apiRequest<void>(`/api/oidc-providers/${id}`, {
		method: "DELETE",
	});
}
