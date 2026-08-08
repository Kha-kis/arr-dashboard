import { scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Encryptor } from "../encryption.js";

describe("Encryptor credential fingerprints", () => {
	it("uses a memory-hard installation-keyed derivation", () => {
		const secret = "a".repeat(64);
		const value = JSON.stringify({ apiKey: "api-key", authorization: "Basic credential" });
		const encryptor = new Encryptor(secret);

		expect(encryptor.fingerprint(value)).toBe(
			scryptSync(value, Buffer.from(secret, "hex"), 32).toString("hex"),
		);
	});

	it("is deterministic per installation and separates credentials", () => {
		const first = new Encryptor("a".repeat(64));
		const second = new Encryptor("b".repeat(64));

		expect(first.fingerprint("credential-a")).toBe(first.fingerprint("credential-a"));
		expect(first.fingerprint("credential-a")).not.toBe(first.fingerprint("credential-b"));
		expect(first.fingerprint("credential-a")).not.toBe(second.fingerprint("credential-a"));
	});
});
