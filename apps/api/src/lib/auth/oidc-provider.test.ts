/**
 * Unit tests for OIDCProvider class
 *
 * Tests the token_endpoint_auth_method auto-detection logic that enables
 * compatibility with various OIDC providers (Pocket ID, Authelia, Authentik, etc.)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as oauth from "oauth4webapi";
import { OIDCProvider } from "./oidc-provider.js";

// Mock oauth4webapi
vi.mock("oauth4webapi", async () => {
	const actual = await vi.importActual("oauth4webapi");
	return {
		...actual,
		discoveryRequest: vi.fn(),
		processDiscoveryResponse: vi.fn(),
		validateAuthResponse: vi.fn(),
		authorizationCodeGrantRequest: vi.fn(),
		processAuthorizationCodeResponse: vi.fn(),
		ClientSecretBasic: vi.fn((secret: string) => ({ type: "basic", secret })),
		ClientSecretPost: vi.fn((secret: string) => ({ type: "post", secret })),
	};
});

describe("OIDCProvider", () => {
	const mockConfig = {
		clientId: "test-client-id",
		clientSecret: "test-client-secret",
		issuer: "https://auth.example.com",
		redirectUri: "https://app.example.com/callback",
		scopes: ["openid", "email", "profile"],
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("Token endpoint auth method auto-detection", () => {
		// Helper to create a mock authorization server response
		const createMockAuthServer = (
			tokenEndpointAuthMethods?: string[],
		): oauth.AuthorizationServer =>
			({
				issuer: "https://auth.example.com",
				authorization_endpoint: "https://auth.example.com/authorize",
				token_endpoint: "https://auth.example.com/token",
				userinfo_endpoint: "https://auth.example.com/userinfo",
				token_endpoint_auth_methods_supported: tokenEndpointAuthMethods,
			}) as oauth.AuthorizationServer;

		// Helper to setup mocks for a token exchange scenario
		const setupExchangeMocks = (authServer: oauth.AuthorizationServer) => {
			vi.mocked(oauth.discoveryRequest).mockResolvedValue(new Response());
			vi.mocked(oauth.processDiscoveryResponse).mockResolvedValue(authServer);
			vi.mocked(oauth.validateAuthResponse).mockReturnValue(
				new URLSearchParams({ code: "test-code" }),
			);
			vi.mocked(oauth.authorizationCodeGrantRequest).mockResolvedValue(new Response());
			vi.mocked(oauth.processAuthorizationCodeResponse).mockResolvedValue({
				access_token: "test-access-token",
				token_type: "bearer" as Lowercase<string>,
				id_token: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJub25jZSI6InRlc3Qtbm9uY2UifQ.sig",
			});
		};

		it("should use client_secret_basic when provider supports it", async () => {
			const authServer = createMockAuthServer(["client_secret_basic", "client_secret_post"]);
			setupExchangeMocks(authServer);

			const provider = new OIDCProvider(mockConfig);

			await provider.exchangeCode(
				new URLSearchParams({ code: "test-code", state: "test-state" }),
				mockConfig.redirectUri,
				"test-state",
				"test-nonce",
				"test-code-verifier",
			);

			// Verify ClientSecretBasic was called (not ClientSecretPost)
			expect(oauth.ClientSecretBasic).toHaveBeenCalledWith(mockConfig.clientSecret);
			expect(oauth.ClientSecretPost).not.toHaveBeenCalled();
		});

		it("should use client_secret_post when provider only supports it (Pocket ID compatibility)", async () => {
			// Pocket ID only supports client_secret_post
			const authServer = createMockAuthServer(["client_secret_post"]);
			setupExchangeMocks(authServer);

			const provider = new OIDCProvider(mockConfig);

			await provider.exchangeCode(
				new URLSearchParams({ code: "test-code", state: "test-state" }),
				mockConfig.redirectUri,
				"test-state",
				"test-nonce",
				"test-code-verifier",
			);

			// Verify ClientSecretPost was called (not ClientSecretBasic)
			expect(oauth.ClientSecretPost).toHaveBeenCalledWith(mockConfig.clientSecret);
			expect(oauth.ClientSecretBasic).not.toHaveBeenCalled();
		});

		it("should default to client_secret_post when provider doesn't advertise methods (Pocket ID compatibility)", async () => {
			// Pocket ID and many simple providers don't advertise supported methods
			// Default to client_secret_post for broader compatibility
			const authServer = createMockAuthServer(undefined);
			setupExchangeMocks(authServer);

			const provider = new OIDCProvider(mockConfig);

			await provider.exchangeCode(
				new URLSearchParams({ code: "test-code", state: "test-state" }),
				mockConfig.redirectUri,
				"test-state",
				"test-nonce",
				"test-code-verifier",
			);

			// Should default to post for better compatibility
			expect(oauth.ClientSecretPost).toHaveBeenCalledWith(mockConfig.clientSecret);
			expect(oauth.ClientSecretBasic).not.toHaveBeenCalled();
		});

		it("should default to client_secret_post when provider returns empty array", async () => {
			const authServer = createMockAuthServer([]);
			setupExchangeMocks(authServer);

			const provider = new OIDCProvider(mockConfig);

			await provider.exchangeCode(
				new URLSearchParams({ code: "test-code", state: "test-state" }),
				mockConfig.redirectUri,
				"test-state",
				"test-nonce",
				"test-code-verifier",
			);

			// Should default to post for better compatibility
			expect(oauth.ClientSecretPost).toHaveBeenCalledWith(mockConfig.clientSecret);
			expect(oauth.ClientSecretBasic).not.toHaveBeenCalled();
		});

		it("should cache the auth method decision across multiple calls", async () => {
			const authServer = createMockAuthServer(["client_secret_post"]);
			setupExchangeMocks(authServer);

			const provider = new OIDCProvider(mockConfig);

			// First call
			await provider.exchangeCode(
				new URLSearchParams({ code: "test-code-1", state: "test-state" }),
				mockConfig.redirectUri,
				"test-state",
				"test-nonce",
				"test-code-verifier",
			);

			// Reset call counts but keep the mock implementations
			vi.mocked(oauth.ClientSecretPost).mockClear();
			vi.mocked(oauth.ClientSecretBasic).mockClear();

			// Second call - should use cached auth method
			await provider.exchangeCode(
				new URLSearchParams({ code: "test-code-2", state: "test-state" }),
				mockConfig.redirectUri,
				"test-state",
				"test-nonce",
				"test-code-verifier",
			);

			// ClientSecretPost should not be called again (cached)
			expect(oauth.ClientSecretPost).not.toHaveBeenCalled();
			expect(oauth.ClientSecretBasic).not.toHaveBeenCalled();
		});

		it("should prefer client_secret_basic over client_secret_post when both supported", async () => {
			// Both methods supported - should prefer basic (more secure)
			const authServer = createMockAuthServer(["client_secret_post", "client_secret_basic"]);
			setupExchangeMocks(authServer);

			const provider = new OIDCProvider(mockConfig);

			await provider.exchangeCode(
				new URLSearchParams({ code: "test-code", state: "test-state" }),
				mockConfig.redirectUri,
				"test-state",
				"test-nonce",
				"test-code-verifier",
			);

			// Should prefer basic even when post is listed first
			expect(oauth.ClientSecretBasic).toHaveBeenCalledWith(mockConfig.clientSecret);
			expect(oauth.ClientSecretPost).not.toHaveBeenCalled();
		});

		it("should fall back to client_secret_post when neither method is listed", async () => {
			// Provider advertises unsupported methods only (like private_key_jwt)
			// Fall back to client_secret_post for broader compatibility
			const authServer = createMockAuthServer(["private_key_jwt", "client_secret_jwt"]);
			setupExchangeMocks(authServer);

			const provider = new OIDCProvider(mockConfig);

			await provider.exchangeCode(
				new URLSearchParams({ code: "test-code", state: "test-state" }),
				mockConfig.redirectUri,
				"test-state",
				"test-nonce",
				"test-code-verifier",
			);

			// Should fall back to post for better compatibility (same as when no methods advertised)
			expect(oauth.ClientSecretPost).toHaveBeenCalledWith(mockConfig.clientSecret);
			expect(oauth.ClientSecretBasic).not.toHaveBeenCalled();
		});
	});
});
