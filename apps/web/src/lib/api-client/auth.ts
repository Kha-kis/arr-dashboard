import type {
	CurrentUser,
	CurrentUserResponse,
	OIDCProvider as SharedOIDCProvider,
} from "@arr/shared";
import { ApiError, NetworkError, UnauthorizedError, apiRequest } from "./base";

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

export async function removePassword(
	payload: RemovePasswordPayload,
): Promise<RemovePasswordResponse> {
	return await apiRequest<RemovePasswordResponse>("/auth/password", {
		method: "DELETE",
		json: payload,
	});
}

export type PasswordPolicy = "strict" | "relaxed";

export interface SetupRequiredResponse {
	required: boolean;
	passwordPolicy: PasswordPolicy;
}

export async function checkSetupRequired(): Promise<SetupRequiredResponse> {
	try {
		const data = await apiRequest<SetupRequiredResponse>("/auth/setup-required");
		return data;
	} catch (error) {
		// Propagate network errors so the UI can show a helpful message
		if (error instanceof NetworkError) {
			throw error;
		}
		// Propagate server errors (500+) - these indicate real problems
		if (error instanceof ApiError && error.status >= 500) {
			throw new NetworkError(`API server error: ${error.message}`);
		}
		// For client errors (4xx), assume setup is not required with strict policy
		return { required: false, passwordPolicy: "strict" };
	}
}

// ==================== OIDC Authentication ====================

export type OIDCProvider = SharedOIDCProvider;

interface OIDCProviderResponse {
	provider: { displayName: string; enabled: boolean } | null;
}

interface OIDCLoginResponse {
	authorizationUrl: string;
}

/**
 * Get the configured OIDC provider (if any)
 * @returns Provider info with displayName and enabled status, or null if not configured
 */
export async function getOIDCProvider(): Promise<{ displayName: string; enabled: boolean } | null> {
	const data = await apiRequest<OIDCProviderResponse>("/auth/oidc/providers");
	return data.provider;
}

/**
 * Initiate OIDC login flow
 * @returns Authorization URL to redirect user to
 */
export async function initiateOIDCLogin(): Promise<string> {
	const data = await apiRequest<OIDCLoginResponse>("/auth/oidc/login", {
		method: "POST",
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

export async function verifyPasskeyLogin(response: any, sessionId: string): Promise<CurrentUser> {
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

// ==================== Session Management ====================

export type DeviceType = "desktop" | "mobile" | "tablet" | "unknown";

export interface SessionInfo {
	id: string;
	isCurrent: boolean;
	createdAt: string;
	expiresAt: string;
	lastAccessedAt: string;
	isExpired: boolean;
	// Device identification
	userAgent: string | null;
	ipAddress: string | null;
	// Parsed user agent info for display
	browser: string;
	os: string;
	device: DeviceType;
}

export interface SessionsResponse {
	totalSessions: number;
	sessions: SessionInfo[];
}

/**
 * Get all active sessions for the current user
 * Includes device/browser info for each session
 */
export async function getSessions(): Promise<SessionsResponse> {
	return apiRequest<SessionsResponse>("/auth/sessions");
}

interface RevokeSessionResponse {
	success: boolean;
	message: string;
}

/**
 * Revoke a specific session (sign out that device)
 * Cannot revoke the current session - use logout() for that
 */
export async function revokeSession(sessionId: string): Promise<RevokeSessionResponse> {
	return apiRequest<RevokeSessionResponse>(`/auth/sessions/${sessionId}`, {
		method: "DELETE",
	});
}
