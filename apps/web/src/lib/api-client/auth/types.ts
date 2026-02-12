import type { CurrentUser, OIDCProvider as SharedOIDCProvider, PasswordPolicy } from "@arr/shared";

// Re-export shared types for convenience
export type { PasswordPolicy, CurrentUser };

export interface SetupRequiredResponse {
	required: boolean;
	passwordPolicy: PasswordPolicy;
}

// ==================== Account Management ====================

export interface UpdateAccountPayload {
	username?: string;
	currentPassword?: string;
	newPassword?: string;
}

export interface UpdateAccountResponse {
	user: CurrentUser;
}

export interface RemovePasswordPayload {
	currentPassword: string;
}

export interface RemovePasswordResponse {
	success: boolean;
	message: string;
}

// ==================== OIDC Authentication ====================

export type OIDCProvider = SharedOIDCProvider;

export interface OIDCProviderResponse {
	provider: { displayName: string; enabled: boolean } | null;
}

export interface OIDCLoginResponse {
	authorizationUrl: string;
}

// ==================== Passkey Authentication ====================

export interface PasskeyCredential {
	id: string;
	friendlyName: string | null;
	backedUp: boolean;
	createdAt: string;
	lastUsedAt: string;
}

export interface PasskeyCredentialsResponse {
	credentials: PasskeyCredential[];
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

export interface RevokeSessionResponse {
	success: boolean;
	message: string;
}
