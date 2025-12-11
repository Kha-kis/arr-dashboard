import * as oauth from "oauth4webapi";

export interface OIDCProviderConfig {
	clientId: string;
	clientSecret: string;
	issuer: string; // e.g., https://auth.example.com
	redirectUri: string; // e.g., https://arr-dashboard.example.com/auth/oidc/callback
	scopes?: string[] | string; // Array or comma-separated string. Default: ["openid", "email", "profile"]
}

export interface OIDCUserInfo {
	sub: string; // Subject (unique user ID from provider)
	email?: string;
	name?: string;
	preferred_username?: string;
}

/**
 * OIDC Provider Service
 * Supports any OpenID Connect compliant provider
 */
export class OIDCProvider {
	private config: OIDCProviderConfig;
	private authServer: oauth.AuthorizationServer | null = null;
	private client: oauth.Client;
	private clientAuth: oauth.ClientAuth;

	constructor(config: OIDCProviderConfig) {
		this.config = config;
		this.client = {
			client_id: config.clientId,
			client_secret: config.clientSecret,
			token_endpoint_auth_method: "client_secret_basic",
		};
		// Create client authentication method for token endpoint requests
		this.clientAuth = oauth.ClientSecretBasic(config.clientSecret);
	}

	/**
	 * Check if HTTP requests should be allowed for this issuer
	 * Allows HTTP for localhost and private network IPs (IPv4 and IPv6)
	 */
	private shouldAllowInsecureRequests(): boolean {
		const issuerUrl = new URL(this.config.issuer);
		const hostname = issuerUrl.hostname.toLowerCase();

		// IPv4 localhost
		if (hostname === 'localhost' || hostname === '127.0.0.1') {
			return true;
		}

		// IPv6 localhost (::1)
		if (hostname === '::1' || hostname === '[::1]') {
			return true;
		}

		// IPv4 private networks
		// 192.168.0.0/16
		if (hostname.startsWith('192.168.')) {
			return true;
		}
		// 10.0.0.0/8
		if (hostname.startsWith('10.')) {
			return true;
		}
		// 172.16.0.0/12 (172.16.0.0 - 172.31.255.255)
		if (hostname.startsWith('172.16.') || hostname.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
			return true;
		}

		// IPv6 private/local networks
		// fe80::/10 (link-local)
		if (hostname.startsWith('fe80:') || hostname.startsWith('[fe80:')) {
			return true;
		}

		// fc00::/7 (unique local addresses - ULA)
		// This includes both fc00::/8 and fd00::/8 ranges
		// Strip brackets if present for parsing
		const ipv6Host = hostname.replace(/^\[|\]$/g, '');
		if (ipv6Host.includes(':')) {
			// Extract first hextet (first 16 bits)
			const firstHextet = ipv6Host.split(':')[0];
			if (firstHextet) {
				// Parse as hex and check if it's in fc00-fdff range (fc00::/7)
				const firstBits = Number.parseInt(firstHextet, 16);
				// fc00::/7 means first 7 bits are 1111110x
				// fc00 = 0xFC00 (11111100), fdff = 0xFDFF (11111101)
				// So we check if (firstBits & 0xFE00) === 0xFC00
				if (!Number.isNaN(firstBits) && (firstBits & 0xFE00) === 0xFC00) {
					return true;
				}
			}
		}

		return false;
	}

	/**
	 * Discover OIDC configuration from issuer
	 */
	private async discoverAuthServer(): Promise<oauth.AuthorizationServer> {
		if (this.authServer) {
			return this.authServer;
		}

		const issuerUrl = new URL(this.config.issuer);

		// Allow HTTP for local/development environments (localhost, 127.0.0.1, private IPs)
		// In production with public domains, HTTPS is still enforced by oauth4webapi
		const discoveryResponse = await oauth.discoveryRequest(issuerUrl, {
			algorithm: "oidc",
			[oauth.allowInsecureRequests]: this.shouldAllowInsecureRequests(),
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

		// Parse scopes - handle both array and comma-separated string
		let scopes: string[];
		if (Array.isArray(this.config.scopes)) {
			scopes = this.config.scopes;
		} else if (typeof this.config.scopes === 'string') {
			scopes = this.config.scopes.split(',').map(s => s.trim()).filter(Boolean);
		} else {
			scopes = ["openid", "email", "profile"];
		}

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
	 * @param callbackParams - URLSearchParams from the OIDC callback (query parameters)
	 * @param redirectUri - The redirect URI used for this flow
	 * @param expectedState - State value to validate against callback (CSRF protection)
	 * @param expectedNonce - Nonce value to validate against ID token (prevents replay attacks)
	 * @param codeVerifier - PKCE code verifier to prove possession (prevents authorization code interception)
	 */
	async exchangeCode(
		callbackParams: URLSearchParams,
		redirectUri: string,
		expectedState: string,
		expectedNonce: string,
		codeVerifier: string,
	): Promise<oauth.TokenEndpointResponse> {
		const authServer = await this.discoverAuthServer();

		// Construct the full callback URL by combining redirect URI + query parameters
		// validateAuthResponse() requires a full URL, not just parameters
		const callbackUrl = new URL(redirectUri);
		callbackUrl.search = callbackParams.toString();

		// Validate the authorization response FIRST
		// This validates state and extracts parameters properly
		const params = oauth.validateAuthResponse(
			authServer,
			this.client,
			callbackUrl,
			expectedState
		);

		// Check for OAuth errors - check if params has 'error' property
		if ('error' in params) {
			const errorDesc = 'error_description' in params ? String(params.error_description) : 'Unknown error';
			throw new Error(`OAuth error: ${params.error} - ${errorDesc}`);
		}

		// Exchange the authorization code for tokens
		const response = await oauth.authorizationCodeGrantRequest(
			authServer,
			this.client,
			this.clientAuth, // Client authentication method (ClientSecretBasic)
			params, // Use validated params from validateAuthResponse
			redirectUri,
			codeVerifier, // PKCE code verifier for authorization code protection
			{
				[oauth.allowInsecureRequests]: this.shouldAllowInsecureRequests(),
			}
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
		if ('error' in result) {
			const errorDesc = 'error_description' in result ? String(result.error_description) : 'Unknown error';
			throw new Error(`OIDC token exchange failed: ${result.error} - ${errorDesc}`);
		}

		return result;
	}

	/**
	 * Get user information from OIDC provider
	 * @param accessToken - Access token from token exchange
	 * @param expectedSubject - Expected subject (sub) claim from ID token for validation
	 */
	async getUserInfo(accessToken: string, expectedSubject: string): Promise<OIDCUserInfo> {
		const authServer = await this.discoverAuthServer();

		if (!authServer.userinfo_endpoint) {
			throw new Error("UserInfo endpoint not found in OIDC discovery");
		}

		const response = await oauth.userInfoRequest(authServer, this.client, accessToken, {
			[oauth.allowInsecureRequests]: this.shouldAllowInsecureRequests(),
		});
		const userInfo = await oauth.processUserInfoResponse(authServer, this.client, expectedSubject, response);

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
		try {
			return JSON.parse(decoded);
		} catch {
			throw new Error("Invalid ID token payload: malformed JSON");
		}
	}
}

