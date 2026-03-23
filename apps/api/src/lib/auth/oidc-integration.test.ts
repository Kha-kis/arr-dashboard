import { describe, expect, it } from "vitest";
import { normalizeIssuerUrl } from "./oidc-utils.js";

/**
 * Integration tests for OIDC configuration flow
 * Tests the normalization behavior that will be used by the API endpoints
 *
 * IMPORTANT: Trailing slashes are now preserved per RFC 8414 §2.
 * oauth4webapi performs strict issuer comparison, so the stored value
 * must match the provider's canonical issuer exactly. Providers like
 * Authentik include a trailing slash. See GitHub issue #208.
 */
describe("OIDC Configuration Integration", () => {
	describe("Issuer URL normalization in configuration flow", () => {
		const simulateOidcConfig = (issuer: string) => {
			try {
				new URL(issuer);
			} catch {
				throw new Error("Invalid URL format");
			}

			const normalizedIssuer = normalizeIssuerUrl(issuer);

			return {
				originalIssuer: issuer,
				normalizedIssuer,
				wasNormalized: issuer !== normalizedIssuer,
			};
		};

		it("should preserve Authentik URL with trailing slash (#208)", () => {
			const result = simulateOidcConfig("https://authentik.local/application/o/app/");

			expect(result.normalizedIssuer).toBe("https://authentik.local/application/o/app/");
			expect(result.wasNormalized).toBe(false);
		});

		it("should preserve trailing slash on Keycloak URL", () => {
			const result = simulateOidcConfig("https://keycloak.example.com/realms/master/");

			expect(result.normalizedIssuer).toBe("https://keycloak.example.com/realms/master/");
			expect(result.wasNormalized).toBe(false);
		});

		it("should strip .well-known suffix", () => {
			const result = simulateOidcConfig(
				"https://keycloak.example.com/realms/master/.well-known/openid-configuration",
			);

			expect(result.normalizedIssuer).toBe("https://keycloak.example.com/realms/master");
			expect(result.wasNormalized).toBe(true);
		});

		it("should pass through correct URLs unchanged", () => {
			const result = simulateOidcConfig("https://keycloak.example.com/realms/master");

			expect(result.normalizedIssuer).toBe("https://keycloak.example.com/realms/master");
			expect(result.wasNormalized).toBe(false);
		});

		it("should handle various common OIDC providers (trailing slashes preserved)", () => {
			const providers = [
				{ input: "https://accounts.google.com/", expected: "https://accounts.google.com/" },
				{
					input: "https://login.microsoftonline.com/tenant-id/v2.0/",
					expected: "https://login.microsoftonline.com/tenant-id/v2.0/",
				},
				{ input: "https://auth.example.com/", expected: "https://auth.example.com/" },
				{ input: "https://auth.example.com", expected: "https://auth.example.com" },
				{
					input: "https://authentik.local/application/o/app/",
					expected: "https://authentik.local/application/o/app/",
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
		it("oauth4webapi handles discovery URL construction internally", () => {
			// oauth4webapi appends /.well-known/openid-configuration to the issuer URL
			// We no longer construct discovery URLs manually — this test verifies
			// that normalizeIssuerUrl only strips the .well-known suffix
			const normalized = normalizeIssuerUrl(
				"https://keycloak.example.com/realms/master/.well-known/openid-configuration",
			);
			expect(normalized).toBe("https://keycloak.example.com/realms/master");
		});
	});
});
