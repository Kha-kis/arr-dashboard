import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { readSecrets, writeSecrets } from "../../backup/backup-file-utils.js";
import { Encryptor } from "../encryption.js";
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
			installationId: "f".repeat(32),
		} as Parameters<typeof writeSecrets>[1]);

		expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual({
			encryptionKey: "d".repeat(64),
			sessionCookieSecret: "e".repeat(64),
			installationId,
		});
	});

	it("backs up the active environment secrets without dropping local metadata", async () => {
		const secretsPath = await createSecretsPath();
		const installationId = "c".repeat(32);
		const environmentEncryptionKey = "d".repeat(32);
		const environmentSessionSecret = "e".repeat(32);
		await writeFile(
			secretsPath,
			JSON.stringify({
				installationId,
				backupPassword: "local-backup-password",
			}),
		);

		const activeSecrets = new SecretManager(secretsPath).getOrCreateSecrets({
			encryptionKey: environmentEncryptionKey,
			sessionCookieSecret: environmentSessionSecret,
		});

		expect(activeSecrets).toMatchObject({
			encryptionKey: environmentEncryptionKey,
			sessionCookieSecret: environmentSessionSecret,
			installationId,
		});
		const backupSecrets = await readSecrets(secretsPath);
		expect(backupSecrets).toEqual({
			encryptionKey: activeSecrets.encryptionKey,
			sessionCookieSecret: activeSecrets.sessionCookieSecret,
		});
		expect(JSON.parse(await readFile(secretsPath, "utf8"))).toMatchObject({
			...activeSecrets,
			backupPassword: "local-backup-password",
		});

		const restorePath = await createSecretsPath();
		const destinationInstallationId = "f".repeat(32);
		await writeFile(restorePath, JSON.stringify({ installationId: destinationInstallationId }));
		await writeSecrets(restorePath, backupSecrets);
		const restoredAfterRestart = new SecretManager(restorePath).getOrCreateSecrets();
		expect(restoredAfterRestart).toEqual({
			encryptionKey: environmentEncryptionKey,
			sessionCookieSecret: environmentSessionSecret,
			installationId: destinationInstallationId,
		});

		const credential = new Encryptor(environmentEncryptionKey).encrypt("restored-api-key");
		expect(new Encryptor(restoredAfterRestart.encryptionKey).decrypt(credential)).toBe(
			"restored-api-key",
		);
	});

	it("rejects an invalid environment key before changing persisted secrets", async () => {
		const secretsPath = await createSecretsPath();
		const persisted = {
			encryptionKey: "a".repeat(64),
			sessionCookieSecret: "b".repeat(64),
			installationId: "c".repeat(32),
		};
		await writeFile(secretsPath, JSON.stringify(persisted));

		expect(() =>
			new SecretManager(secretsPath).getOrCreateSecrets({
				encryptionKey: "x".repeat(33),
			}),
		).toThrow("ENCRYPTION_KEY must decode to 32 bytes");
		expect(JSON.parse(await readFile(secretsPath, "utf8"))).toEqual(persisted);
	});

	it("starts consistently with environment-managed secrets when the secrets path is not writable", async () => {
		const directory = await mkdtemp(join(tmpdir(), "arr-dashboard-secrets-"));
		tempDirectories.push(directory);
		const pathBlocker = join(directory, "not-a-directory");
		await writeFile(pathBlocker, "block directory creation");
		const secretsPath = join(pathBlocker, "secrets.json");
		const overrides = {
			encryptionKey: "d".repeat(32),
			sessionCookieSecret: "e".repeat(32),
		};

		const firstManager = new SecretManager(secretsPath);
		const secondManager = new SecretManager(secretsPath);
		const first = firstManager.getOrCreateEnvironmentSecrets(overrides);
		const second = secondManager.getOrCreateEnvironmentSecrets(overrides);

		expect(first).toEqual(second);
		expect(first).toMatchObject(overrides);
		expect(first.installationId).toMatch(/^[a-f0-9]{32}$/);
		expect(firstManager.secretsSynchronized).toBe(false);
		expect(secondManager.secretsSynchronized).toBe(false);
	});

	it("does not expose a partially managed secret when persistence fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "arr-dashboard-secrets-"));
		tempDirectories.push(directory);
		const pathBlocker = join(directory, "not-a-directory");
		await writeFile(pathBlocker, "block directory creation");
		const environmentEncryptionKey = "d".repeat(32);

		let thrown: unknown;
		try {
			new SecretManager(join(pathBlocker, "secrets.json")).getOrCreateSecrets({
				encryptionKey: environmentEncryptionKey,
			});
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect(inspect(thrown)).not.toContain(environmentEncryptionKey);
		expect(JSON.stringify(thrown)).not.toContain(environmentEncryptionKey);
	});

	it("marks stale readable secrets as unsynchronized when environment keys cannot be written", async () => {
		const directory = await mkdtemp(join(tmpdir(), "arr-dashboard-secrets-"));
		tempDirectories.push(directory);
		const secretsPath = join(directory, "secrets.json");
		await writeFile(
			secretsPath,
			JSON.stringify({
				encryptionKey: "a".repeat(64),
				sessionCookieSecret: "b".repeat(64),
				installationId: "c".repeat(32),
			}),
		);
		await chmod(directory, 0o555);

		try {
			const manager = new SecretManager(secretsPath);
			const active = manager.getOrCreateEnvironmentSecrets({
				encryptionKey: "d".repeat(32),
				sessionCookieSecret: "e".repeat(32),
			});

			expect(active.encryptionKey).toBe("d".repeat(32));
			expect(active.sessionCookieSecret).toBe("e".repeat(32));
			expect(active.installationId).toBe("c".repeat(32));
			expect(manager.secretsSynchronized).toBe(false);
			expect(JSON.parse(await readFile(secretsPath, "utf8"))).toMatchObject({
				encryptionKey: "a".repeat(64),
				sessionCookieSecret: "b".repeat(64),
			});
		} finally {
			await chmod(directory, 0o755);
		}
	});
});
