import type { CurrentUser, CurrentUserResponse, OIDCProvider as SharedOIDCProvider } from "@arr/shared";
import { apiRequest, UnauthorizedError } from "./base";

export async function fetchCurrentUser(): Promise<CurrentUser | null> {
	try {
		const data = await apiRequest<CurrentUserResponse>("/auth/me");
		return data.user;
	} catch (error) {
		if (error instanceof UnauthorizedError) {
			return null;
		}
		throw error;
	}
}

export async function login(payload: {
	username: string;
	password: string;
	rememberMe?: boolean;
}): Promise<CurrentUser> {
	const data = await apiRequest<CurrentUserResponse>("/auth/login", {
		method: "POST",
		json: payload,
	});
	return data.user;
}

export async function logout(): Promise<void> {
	await apiRequest<void>("/auth/logout", {
		method: "POST",
	});
}

interface UpdateAccountPayload {
	username?: string;
	currentPassword?: string;
	newPassword?: string;
}

interface UpdateAccountResponse {
	user: CurrentUser;
}

export async function updateAccount(payload: UpdateAccountPayload): Promise<UpdateAccountResponse> {
	return await apiRequest<UpdateAccountResponse>("/auth/account", {
		method: "PATCH",
		json: payload,
	});
}

interface RemovePasswordPayload {
	currentPassword: string;
}

interface RemovePasswordResponse {
	success: boolean;
	message: string;
}

export async function removePassword(payload: RemovePasswordPayload): Promise<RemovePasswordResponse> {
	return await apiRequest<RemovePasswordResponse>("/auth/password", {
		method: "DELETE",
		json: payload,
	});
}

interface SetupRequiredResponse {
	required: boolean;
}

export async function checkSetupRequired(): Promise<boolean> {
	try {
		const data = await apiRequest<SetupRequiredResponse>("/auth/setup-required");
		return data.required;
	} catch (error) {
		// If the endpoint fails, assume setup is not required
		return false;
	}
}

// ==================== OIDC Authentication ====================

export type OIDCProvider = SharedOIDCProvider;
export type OIDCProviderType = OIDCProvider["type"];

interface OIDCProvidersResponse {
	providers: OIDCProvider[];
}

interface OIDCLoginResponse {
	authorizationUrl: string;
}

export async function getOIDCProviders(): Promise<OIDCProvider[]> {
	const data = await apiRequest<OIDCProvidersResponse>("/auth/oidc/providers");
	return data.providers;
}

export async function initiateOIDCLogin(provider: OIDCProviderType): Promise<string> {
	const data = await apiRequest<OIDCLoginResponse>("/auth/oidc/login", {
		method: "POST",
		json: { provider },
	});
	return data.authorizationUrl;
}

// ==================== Passkey Authentication ====================

export interface PasskeyCredential {
	id: string;
	friendlyName: string | null;
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string;
}

interface PasskeyCredentialsResponse {
	credentials: PasskeyCredential[];
}

export async function getPasskeyCredentials(): Promise<PasskeyCredential[]> {
	const data = await apiRequest<PasskeyCredentialsResponse>("/auth/passkey/credentials");
	return data.credentials;
}

export async function getPasskeyRegistrationOptions(friendlyName?: string): Promise<any> {
	return apiRequest("/auth/passkey/register/options", {
		method: "POST",
		json: { friendlyName },
	});
}

export async function verifyPasskeyRegistration(
	response: any,
	friendlyName?: string,
): Promise<void> {
	await apiRequest("/auth/passkey/register/verify", {
		method: "POST",
		json: { response, friendlyName },
	});
}

export async function getPasskeyLoginOptions(): Promise<{ options: any; sessionId: string }> {
	return apiRequest("/auth/passkey/login/options", {
		method: "POST",
	});
}

export async function verifyPasskeyLogin(
	response: any,
	sessionId: string,
): Promise<CurrentUser> {
	const data = await apiRequest<CurrentUserResponse>("/auth/passkey/login/verify", {
		method: "POST",
		json: { response, sessionId },
	});
	return data.user;
}

export async function deletePasskeyCredential(credentialId: string): Promise<void> {
	await apiRequest("/auth/passkey/credentials", {
		method: "DELETE",
		json: { credentialId },
	});
}

export async function renamePasskeyCredential(
	credentialId: string,
	friendlyName: string,
): Promise<void> {
	await apiRequest("/auth/passkey/credentials", {
		method: "PATCH",
		json: { credentialId, friendlyName },
	});
}
