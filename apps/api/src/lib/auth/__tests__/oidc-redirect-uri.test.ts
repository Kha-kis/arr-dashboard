import { describe, expect, it } from "vitest";
import { resolveOidcAppUrl } from "../oidc-redirect-uri.js";

describe("resolveOidcAppUrl", () => {
	it("prefers the saved External URL", () => {
		expect(
			resolveOidcAppUrl(
				"https://canonical.example.com/dashboard",
				"https://app.example.com",
				"https://webauthn.example.com",
			),
		).toBe("https://canonical.example.com/dashboard");
	});

	it("keeps a public APP_URL authoritative", () => {
		expect(
			resolveOidcAppUrl(null, "https://app.example.com/dashboard", "https://webauthn.example.com"),
		).toBe("https://app.example.com/dashboard");
	});

	it("uses the public WebAuthn origin when APP_URL is local", () => {
		expect(
			resolveOidcAppUrl(null, "http://localhost:3000", "https://arr.example.com/passkeys"),
		).toBe("https://arr.example.com");
	});

	it.each([
		undefined,
		"not-a-url",
		"http://localhost:3000",
		"https://admin:secret@arr.example.com",
		"https://arr.example.com?redirect=attacker.example",
	])("does not replace a local APP_URL with an unsafe WebAuthn origin: %s", (webAuthnOrigin) => {
		expect(resolveOidcAppUrl(null, "http://localhost:3000", webAuthnOrigin)).toBe(
			"http://localhost:3000",
		);
	});
});
