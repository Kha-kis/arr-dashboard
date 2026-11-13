import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSecrets } from "../backup-file-utils.js";

const SECRETS = {
	encryptionKey: "a".repeat(64),
	sessionCookieSecret: "synthetic-session-secret",
};

describe("backup secret-file validation", () => {
	let tempDir: string;
	let secretsPath: string;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "backup-secret-validation-"));
		secretsPath = path.join(tempDir, "secrets.json");
	});

	afterEach(async () => {
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	});

	it("returns only the required secret pair, not deployment-local metadata", async () => {
		await fs.writeFile(
			secretsPath,
			JSON.stringify({ ...SECRETS, installationId: "synthetic-local-id" }),
			{ mode: 0o600 },
		);
		expect(await readSecrets(secretsPath)).toEqual(SECRETS);
	});

	it.each([
		["UTF-8", "b".repeat(32)],
		["base64", "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE="],
	])("preserves supported %s encryption keys", async (_encoding, encryptionKey) => {
		const secrets = { ...SECRETS, encryptionKey };
		await fs.writeFile(secretsPath, JSON.stringify(secrets), { mode: 0o600 });
		expect(await readSecrets(secretsPath)).toEqual(secrets);
	});

	it.each([
		["missing key", { sessionCookieSecret: SECRETS.sessionCookieSecret }],
		["missing cookie secret", { encryptionKey: SECRETS.encryptionKey }],
		["wrong key type", { ...SECRETS, encryptionKey: 7 }],
		["wrong cookie-secret type", { ...SECRETS, sessionCookieSecret: false }],
		["empty key", { ...SECRETS, encryptionKey: "" }],
		["invalid encoded key", { ...SECRETS, encryptionKey: "not-a-valid-key" }],
		["empty cookie secret", { ...SECRETS, sessionCookieSecret: "" }],
		["null", null],
		["array", []],
	])("rejects %s with a content-free error", async (_category, contents) => {
		await fs.writeFile(secretsPath, JSON.stringify(contents), { mode: 0o600 });
		await expect(readSecrets(secretsPath)).rejects.toThrow(
			/^Failed to read secrets file: unavailable or invalid cryptographic fields$/,
		);
	});

	it("does not copy malformed JSON or its private path into the error", async () => {
		await fs.writeFile(secretsPath, '{"synthetic-secret-marker":BROKEN}', { mode: 0o600 });
		await expect(readSecrets(secretsPath)).rejects.toThrow(
			/^Failed to read secrets file: unavailable or invalid cryptographic fields$/,
		);
	});

	it("does not copy missing-file details into the error", async () => {
		await expect(readSecrets(secretsPath)).rejects.toThrow(
			/^Failed to read secrets file: unavailable or invalid cryptographic fields$/,
		);
	});
});
