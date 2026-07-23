import { describe, expect, it } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import {
	createHttpAuthHeaders,
	decryptHttpAuthCredentials,
	encryptHttpAuthCredentials,
	stripUrlCredentials,
} from "../http-auth.js";

describe("HTTP Basic Auth credentials", () => {
	const encryptor = new Encryptor("a".repeat(64));

	it("round-trips an encrypted versioned credential payload", () => {
		const encrypted = encryptHttpAuthCredentials(encryptor, {
			username: "proxy-user",
			password: "p:a ss",
		});

		expect(encrypted.encryptedHttpAuthCredentials).not.toContain("proxy-user");
		expect(decryptHttpAuthCredentials(encryptor, encrypted)).toEqual({
			username: "proxy-user",
			password: "p:a ss",
		});
	});

	it("builds the standard Basic authorization header", () => {
		expect(createHttpAuthHeaders({ username: "user", password: "pass" })).toEqual({
			Authorization: "Basic dXNlcjpwYXNz",
		});
	});

	it("extracts percent-encoded URL credentials and preserves the rest of the URL", () => {
		expect(stripUrlCredentials("https://user:p%40ss@example.test:8443/qui?mode=1")).toEqual({
			baseUrl: "https://example.test:8443/qui?mode=1",
			credentials: { username: "user", password: "p@ss" },
		});
	});
	it("still strips malformed percent encoding instead of leaving credentials in the URL", () => {
		expect(stripUrlCredentials("https://user%ZZ:pass@example.test/qui")).toEqual({
			baseUrl: "https://example.test/qui",
			credentials: { username: "user%ZZ", password: "pass" },
		});
	});
});
