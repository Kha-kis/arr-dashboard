import type {
	CreateOIDCProvider,
	OIDCProvider,
	UpdateOIDCProvider,
} from "@arr/shared";
import { apiRequest } from "./base";

interface OIDCProviderResponse {
	provider: OIDCProvider | null;
}

/**
 * Get the configured OIDC provider (admin only)
 */
export async function getOIDCProviders(): Promise<OIDCProviderResponse> {
	return apiRequest<OIDCProviderResponse>("/api/oidc-providers", {
		method: "GET",
	});
}

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
