import { describe, expect, it } from "vitest";
import { oidcRedirectUriSchema } from "../oidc-provider";

describe("oidcRedirectUriSchema", () => {
	it("accepts HTTP(S) callbacks and preserves query parameters", () => {
		expect(
			oidcRedirectUriSchema.parse("https://arr.example.com/auth/oidc/callback?tenant=home"),
		).toBe("https://arr.example.com/auth/oidc/callback?tenant=home");
		expect(oidcRedirectUriSchema.parse("http://localhost:3000/auth/oidc/callback")).toBe(
			"http://localhost:3000/auth/oidc/callback",
		);
	});

	it("canonicalizes parser-normalized callback URLs", () => {
		expect(oidcRedirectUriSchema.parse("https://arr.example.com\\auth\\oidc\\callback")).toBe(
			"https://arr.example.com/auth/oidc/callback",
		);
	});

	it.each([
		"https://arr.example.com/auth/oidc/callback#fragment",
		"https://arr.example.com/auth/oidc/callback#",
		"https://admin@arr.example.com/auth/oidc/callback",
		"https://admin:secret@arr.example.com/auth/oidc/callback",
		"https://arr.example.com//auth/oidc/callback",
		"https://arr.example.com/wrong-callback",
		"ftp://arr.example.com/auth/oidc/callback",
	])("rejects an invalid OAuth callback: %s", (redirectUri) => {
		expect(oidcRedirectUriSchema.safeParse(redirectUri).success).toBe(false);
	});
});
