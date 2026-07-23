import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../password.js";

describe("password hashing", () => {
	it("hashes and verifies a password with Argon2id", async () => {
		const password = "Correct Horse Battery Staple!";
		const hash = await hashPassword(password);

		expect(hash).toMatch(/^\$argon2id\$/);
		await expect(verifyPassword(password, hash)).resolves.toBe(true);
		await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
	});

	it("returns false for malformed hashes", async () => {
		await expect(verifyPassword("password", "not-an-argon2-hash")).resolves.toBe(false);
	});
});
