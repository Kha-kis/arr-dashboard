import { describe, expect, it } from "vitest";
import { buildOidcRedirectUriFromAppUrl } from "../oidc-redirect-uri.js";

describe("buildOidcRedirectUriFromAppUrl", () => {
	it.each([
		["https://arr.example.com", "https://arr.example.com/auth/oidc/callback"],
		["https://arr.example.com/", "https://arr.example.com/auth/oidc/callback"],
		["https://arr.example.com/arr", "https://arr.example.com/arr/auth/oidc/callback"],
		["https://arr.example.com/arr/", "https://arr.example.com/arr/auth/oidc/callback"],
	])("builds a canonical callback for %s", (appUrl, expected) => {
		expect(buildOidcRedirectUriFromAppUrl(appUrl)).toBe(expected);
	});

	it.each([
		"https://admin:secret@arr.example.com/",
		"ftp://arr.example.com/",
		"mailto:admin@example.com",
		"https://arr.example.com/arr?tenant=home",
		"https://arr.example.com/arr#fragment",
		"https://arr.example.com/arr//nested",
	])("rejects an unsafe application URL: %s", (appUrl) => {
		expect(buildOidcRedirectUriFromAppUrl(appUrl)).toBeNull();
	});
});
