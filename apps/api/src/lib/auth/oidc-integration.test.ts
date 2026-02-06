import { describe, it, expect, } from "vitest";
import { normalizeIssuerUrl } from "./oidc-utils.js";

/**
 * Integration tests for OIDC configuration flow
 * Tests the normalization behavior that will be used by the API endpoints
 */
describe("OIDC Configuration Integration", () => {
	describe("Issuer URL normalization in configuration flow", () => {
		// Simulate the validation + normalization that happens in the API endpoints
		const simulateOidcConfig = (issuer: string) => {
			// First, validate it's a URL (Zod does this)
			try {
				new URL(issuer);
			} catch {
				throw new Error("Invalid URL format");
			}

			// Then normalize (our new function)
			const normalizedIssuer = normalizeIssuerUrl(issuer);

			return {
				originalIssuer: issuer,
				normalizedIssuer,
				wasNormalized: issuer !== normalizedIssuer,
			};
		};

		it("should accept and normalize Keycloak URL with trailing slash", () => {
			const result = simulateOidcConfig("https://keycloak.example.com/realms/master/");

			expect(result.normalizedIssuer).toBe("https://keycloak.example.com/realms/master");
			expect(result.wasNormalized).toBe(true);
		});

		it("should accept and normalize URL with .well-known suffix", () => {
			const result = simulateOidcConfig(
				"https://keycloak.example.com/realms/master/.well-known/openid-configuration",
			);

			expect(result.normalizedIssuer).toBe("https://keycloak.example.com/realms/master");
			expect(result.wasNormalized).toBe(true);
		});

		it("should accept and normalize URL with both issues", () => {
			const result = simulateOidcConfig(
				"https://keycloak.example.com/realms/master/.well-known/openid-configuration/",
			);

			expect(result.normalizedIssuer).toBe("https://keycloak.example.com/realms/master");
			expect(result.wasNormalized).toBe(true);
		});

		it("should pass through correct URLs unchanged", () => {
			const result = simulateOidcConfig("https://keycloak.example.com/realms/master");

			expect(result.normalizedIssuer).toBe("https://keycloak.example.com/realms/master");
			expect(result.wasNormalized).toBe(false);
		});

		it("should handle various common OIDC providers", () => {
			const providers = [
				{ input: "https://accounts.google.com/", expected: "https://accounts.google.com" },
				{
					input: "https://login.microsoftonline.com/tenant-id/v2.0/",
					expected: "https://login.microsoftonline.com/tenant-id/v2.0",
				},
				{ input: "https://auth.example.com/", expected: "https://auth.example.com" },
				{
					input: "https://authentik.local/application/o/app/",
					expected: "https://authentik.local/application/o/app",
				},
			];

			for (const { input, expected } of providers) {
				const result = simulateOidcConfig(input);
				expect(result.normalizedIssuer).toBe(expected);
			}
		});
	});

	describe("Error handling for invalid URLs", () => {
		it("should reject non-URL strings", () => {
			expect(() => normalizeIssuerUrl("not-a-url")).toThrow("Invalid issuer URL");
		});

		it("should reject empty string after trimming", () => {
			expect(() => normalizeIssuerUrl("   ")).toThrow();
		});

		it("should reject malformed URLs", () => {
			expect(() => normalizeIssuerUrl("://missing-protocol.com")).toThrow();
		});
	});

	describe("Discovery URL construction", () => {
		it("should construct correct discovery URL from normalized issuer", () => {
			const testCases = [
				{
					input: "https://keycloak.example.com/realms/master/",
					expectedDiscovery:
						"https://keycloak.example.com/realms/master/.well-known/openid-configuration",
				},
				{
					input: "https://keycloak.example.com/realms/master/.well-known/openid-configuration",
					expectedDiscovery:
						"https://keycloak.example.com/realms/master/.well-known/openid-configuration",
				},
			];

			for (const { input, expectedDiscovery } of testCases) {
				const normalized = normalizeIssuerUrl(input);
				const discoveryUrl = `${normalized}/.well-known/openid-configuration`;
				expect(discoveryUrl).toBe(expectedDiscovery);
			}
		});
	});
});
