import * as oauth from "oauth4webapi";

export type OIDCProviderType = "authelia" | "authentik" | "generic";

export interface OIDCProviderConfig {
	type: OIDCProviderType;
	clientId: string;
	clientSecret: string;
	issuer: string; // e.g., https://auth.example.com
	redirectUri: string; // e.g., https://arr-dashboard.example.com/auth/oidc/callback
	scopes?: string[]; // Default: ["openid", "email", "profile"]
}

export interface OIDCUserInfo {
	sub: string; // Subject (unique user ID from provider)
	email?: string;
	name?: string;
	preferred_username?: string;
}

/**
 * OIDC Provider Service
 * Supports Authelia, Authentik, and generic OIDC providers
 */
export class OIDCProvider {
	private config: OIDCProviderConfig;
	private authServer: oauth.AuthorizationServer | null = null;
	private client: oauth.Client;

	constructor(config: OIDCProviderConfig) {
		this.config = config;
		this.client = {
			client_id: config.clientId,
			client_secret: config.clientSecret,
			token_endpoint_auth_method: "client_secret_basic",
		};
	}

	/**
	 * Discover OIDC configuration from issuer
	 */
	private async discoverAuthServer(): Promise<oauth.AuthorizationServer> {
		if (this.authServer) {
			return this.authServer;
		}

		const issuerUrl = new URL(this.config.issuer);
		const discoveryResponse = await oauth.discoveryRequest(issuerUrl, {
			algorithm: "oidc",
		});

		const authServer = await oauth.processDiscoveryResponse(issuerUrl, discoveryResponse);

		this.authServer = authServer;
		return authServer;
	}

	/**
	 * Generate authorization URL for OIDC login flow with PKCE
	 */
	async getAuthorizationUrl(state: string, nonce: string, codeChallenge: string): Promise<string> {
		const authServer = await this.discoverAuthServer();

		if (!authServer.authorization_endpoint) {
			throw new Error("Authorization endpoint not found in OIDC discovery");
		}

		const scopes = this.config.scopes ?? ["openid", "email", "profile"];

		const authUrl = new URL(authServer.authorization_endpoint);
		authUrl.searchParams.set("client_id", this.config.clientId);
		authUrl.searchParams.set("redirect_uri", this.config.redirectUri);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("scope", scopes.join(" "));
		authUrl.searchParams.set("state", state);
		authUrl.searchParams.set("nonce", nonce);
		authUrl.searchParams.set("code_challenge", codeChallenge);
		authUrl.searchParams.set("code_challenge_method", "S256");

		return authUrl.toString();
	}

	/**
	 * Exchange authorization code for tokens with PKCE
	 * @param callbackUrl - Full callback URL with query parameters from the OIDC redirect
	 * @param expectedState - State value to validate against callback (CSRF protection)
	 * @param expectedNonce - Nonce value to validate against ID token (prevents replay attacks)
	 * @param codeVerifier - PKCE code verifier to prove possession (prevents authorization code interception)
	 */
	async exchangeCode(
		callbackUrl: string,
		expectedState: string,
		expectedNonce: string,
		codeVerifier: string,
	): Promise<oauth.TokenEndpointResponse> {
		const authServer = await this.discoverAuthServer();

		// Parse the callback URL
		const currentUrl = new URL(callbackUrl);

		// Validate the authorization response FIRST
		// This validates state and extracts parameters properly
		const params = oauth.validateAuthResponse(
			authServer,
			this.client,
			currentUrl,
			expectedState
		);

		// Check for OAuth errors
		if (oauth.isOAuth2Error(params)) {
			throw new Error(`OAuth error: ${params.error} - ${params.error_description || 'Unknown error'}`);
		}

		// Exchange the authorization code for tokens
		const response = await oauth.authorizationCodeGrantRequest(
			authServer,
			this.client,
			params, // Use validated params from validateAuthResponse
			this.config.redirectUri,
			codeVerifier, // PKCE code verifier for authorization code protection
		);

		// Validate ID token with nonce to prevent replay attacks
		const result = await oauth.processAuthorizationCodeResponse(
			authServer,
			this.client,
			response,
			{
				expectedNonce: expectedNonce,
				requireIdToken: true, // OIDC requires ID token
			},
		);

		// Check for OAuth error response
		if (oauth.isOAuth2Error(result)) {
			throw new Error(`OIDC token exchange failed: ${result.error} - ${result.error_description || 'Unknown error'}`);
		}

		return result;
	}

	/**
	 * Get user information from OIDC provider
	 */
	async getUserInfo(accessToken: string): Promise<OIDCUserInfo> {
		const authServer = await this.discoverAuthServer();

		if (!authServer.userinfo_endpoint) {
			throw new Error("UserInfo endpoint not found in OIDC discovery");
		}

		const response = await oauth.userInfoRequest(authServer, this.client, accessToken);
		const userInfo = await oauth.processUserInfoResponse(authServer, this.client, "", response);

		if (!userInfo.sub) {
			throw new Error("OIDC user info missing 'sub' claim");
		}

		return {
			sub: userInfo.sub,
			email: userInfo.email as string | undefined,
			name: userInfo.name as string | undefined,
			preferred_username: userInfo.preferred_username as string | undefined,
		};
	}

	/**
	 * Extract ID token claims (optional, for additional user data)
	 */
	extractIdTokenClaims(idToken: string): Record<string, unknown> {
		// ID tokens are JWTs in format: header.payload.signature
		const parts = idToken.split(".");
		if (parts.length !== 3 || !parts[1]) {
			throw new Error("Invalid ID token format");
		}

		const payload = parts[1];
		// Convert base64url to base64 (replace - with + and _ with /)
		const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
		const decoded = Buffer.from(base64, "base64").toString("utf-8");
		return JSON.parse(decoded);
	}
}

/**
 * Create OIDC provider from environment variables
 */
export function createOIDCProviderFromEnv(type: OIDCProviderType): OIDCProvider | null {
	const prefix = type.toUpperCase();
	const clientId = process.env[`OIDC_${prefix}_CLIENT_ID`];
	const clientSecret = process.env[`OIDC_${prefix}_CLIENT_SECRET`];
	const issuer = process.env[`OIDC_${prefix}_ISSUER`];
	const redirectUri = process.env[`OIDC_${prefix}_REDIRECT_URI`];

	if (!clientId || !clientSecret || !issuer || !redirectUri) {
		return null; // Provider not configured
	}

	const scopes = process.env[`OIDC_${prefix}_SCOPES`]?.split(",") ?? [
		"openid",
		"email",
		"profile",
	];

	return new OIDCProvider({
		type,
		clientId,
		clientSecret,
		issuer,
		redirectUri,
		scopes,
	});
}
