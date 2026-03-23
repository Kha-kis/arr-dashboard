import { describe, expect, it } from "vitest";
import { normalizeIssuerUrl } from "./oidc-utils.js";

describe("normalizeIssuerUrl", () => {
	it("should return clean URL unchanged", () => {
		expect(normalizeIssuerUrl("https://keycloak.example.com/realms/master")).toBe(
			"https://keycloak.example.com/realms/master",
		);
	});

	it("should preserve trailing slash (RFC 8414 compliance)", () => {
		expect(normalizeIssuerUrl("https://keycloak.example.com/realms/master/")).toBe(
			"https://keycloak.example.com/realms/master/",
		);
	});

	it("should preserve multiple trailing slashes as-is", () => {
		expect(normalizeIssuerUrl("https://keycloak.example.com/realms/master///")).toBe(
			"https://keycloak.example.com/realms/master///",
		);
	});

	it("should remove .well-known/openid-configuration suffix", () => {
		expect(
			normalizeIssuerUrl(
				"https://keycloak.example.com/realms/master/.well-known/openid-configuration",
			),
		).toBe("https://keycloak.example.com/realms/master");
	});

	it("should remove .well-known suffix case-insensitively", () => {
		expect(
			normalizeIssuerUrl(
				"https://keycloak.example.com/realms/master/.WELL-KNOWN/OPENID-CONFIGURATION",
			),
		).toBe("https://keycloak.example.com/realms/master");
	});

	it("should trim whitespace", () => {
		expect(normalizeIssuerUrl("  https://keycloak.example.com/realms/master  ")).toBe(
			"https://keycloak.example.com/realms/master",
		);
	});

	it("should throw for invalid URL", () => {
		expect(() => normalizeIssuerUrl("not-a-url")).toThrow("Invalid issuer URL");
	});

	it("should throw for empty string", () => {
		expect(() => normalizeIssuerUrl("")).toThrow();
	});

	it("should handle Authelia URL format", () => {
		expect(normalizeIssuerUrl("https://auth.example.com")).toBe("https://auth.example.com");
	});

	it("should handle Authentik URL format with trailing slash (#208)", () => {
		expect(normalizeIssuerUrl("https://authentik.example.com/application/o/arr-dashboard/")).toBe(
			"https://authentik.example.com/application/o/arr-dashboard/",
		);
	});

	it("should handle Google OAuth URL with trailing slash", () => {
		expect(normalizeIssuerUrl("https://accounts.google.com/")).toBe("https://accounts.google.com/");
	});
});
