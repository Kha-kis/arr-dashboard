import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSecrets, writeSecrets } from "../../backup/backup-file-utils.js";
import { SecretManager } from "../secret-manager.js";

describe("SecretManager installation identity", () => {
	const tempDirectories: string[] = [];

	async function createSecretsPath(): Promise<string> {
		const directory = await mkdtemp(join(tmpdir(), "arr-dashboard-secrets-"));
		tempDirectories.push(directory);
		return join(directory, "secrets.json");
	}

	afterEach(async () => {
		await Promise.all(
			tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
		);
	});

	it("adds a stable installation ID to an existing secrets file", async () => {
		const secretsPath = await createSecretsPath();
		await writeFile(
			secretsPath,
			JSON.stringify({
				encryptionKey: "a".repeat(64),
				sessionCookieSecret: "b".repeat(64),
				backupPassword: "local-backup-password",
			}),
		);

		const first = new SecretManager(secretsPath).getOrCreateSecrets();
		const second = new SecretManager(secretsPath).getOrCreateSecrets();

		expect(first.installationId).toMatch(/^[a-f0-9]{32}$/);
		expect(second.installationId).toBe(first.installationId);
		expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual({
			...first,
			backupPassword: "local-backup-password",
		});
	});

	it("keeps the installation ID local when secrets are backed up and restored", async () => {
		const secretsPath = await createSecretsPath();
		const installationId = "c".repeat(32);
		await writeFile(
			secretsPath,
			JSON.stringify({
				encryptionKey: "a".repeat(64),
				sessionCookieSecret: "b".repeat(64),
				installationId,
			}),
		);

		const backupSecrets = await readSecrets(secretsPath);
		expect(backupSecrets).toEqual({
			encryptionKey: "a".repeat(64),
			sessionCookieSecret: "b".repeat(64),
		});

		await writeSecrets(secretsPath, {
			encryptionKey: "d".repeat(64),
			sessionCookieSecret: "e".repeat(64),
		});

		expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual({
			encryptionKey: "d".repeat(64),
			sessionCookieSecret: "e".repeat(64),
			installationId,
		});
	});
});
