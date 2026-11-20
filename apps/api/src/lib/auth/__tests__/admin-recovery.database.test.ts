import { type ChildProcess, execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openRestoreRuntime, type RestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import { resolveSecretsPath } from "../../utils/secrets-path.js";
import { recoverAdministratorPassword } from "../admin-recovery.js";
import * as passwords from "../password.js";
import { SecretManager } from "../secret-manager.js";

const pgUrl = process.env.RESTORE_RUNTIME_TEST_PG_URL;
const provider = pgUrl ? "postgresql" : "sqlite";
const api = resolve(import.meta.dirname, "../../../../");
const oldPassword = "Synthetic-Old-123!";
const newPassword = "Synthetic-New-456!";
let directory: string | undefined;
let url: string;
let secretsPath: string;
let installationId: string;
let oldHash: string;
let held: Readonly<RestoreRuntime> | undefined;
let child: ChildProcess | undefined;

async function owned<T>(
	work: (prisma: ReturnType<typeof createRuntimePrismaClient>["prisma"]) => Promise<T>,
) {
	const runtime = await openRestoreRuntime({ databaseUrl: url });
	try {
		const native = createRuntimePrismaClient(runtime, { sqliteTransactionIntent: "write" });
		return await runtime.runStarting(() => work(native.prisma));
	} finally {
		await runtime.close();
	}
}
async function snapshot() {
	return owned(async (p) => ({
		users: await p.user.findMany({ orderBy: { id: "asc" } }),
		sessions: await p.session.findMany({ orderBy: { id: "asc" } }),
		passkeys: await p.webAuthnCredential.findMany(),
		oidc: await p.oIDCAccount.findMany(),
		connections: await p.serviceInstance.findMany(),
	}));
}
const recovery = (username = "Owner") =>
	recoverAdministratorPassword({
		databaseUrl: url,
		username,
		password: newPassword,
		confirmation: newPassword,
		passwordPolicy: "strict",
	});

beforeAll(async () => {
	if (pgUrl) {
		const project = process.env.RESTORE_RUNTIME_TEST_PROJECT;
		const parsed = new URL(pgUrl);
		if (
			!project ||
			resolve(process.cwd()) !== resolve(project) ||
			!project.includes("/artifacts/restore-application-admission-") ||
			parsed.hostname !== "127.0.0.1" ||
			!parsed.pathname.endsWith("_test")
		)
			throw new Error("Owned disposable PostgreSQL fixture required");
		url = pgUrl;
	} else {
		directory = mkdtempSync(join(tmpdir(), "arr-admin-recovery-"));
		const schema = join(directory, "schema.prisma");
		writeFileSync(
			schema,
			readFileSync(join(api, "prisma/schema.prisma"), "utf8").replace(
				/generator client \{[\s\S]*?\}/,
				'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
			),
			{ mode: 0o600 },
		);
		const config = join(directory, "safe.config.ts");
		writeFileSync(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
		url = `file:${join(directory, "fixture.db")}`;
		await promisify(execFile)(
			process.execPath,
			[
				join(api, "node_modules/prisma/build/index.js"),
				"db",
				"push",
				"--schema",
				schema,
				"--config",
				config,
				"--url",
				url,
			],
			{
				cwd: directory,
				env: {
					PATH: process.env.PATH,
					DATABASE_URL: url,
					CHECKPOINT_DISABLE: "1",
					DOTENV_CONFIG_PATH: "/dev/null",
				},
				timeout: 60000,
			},
		);
		chmodSync(join(directory, "fixture.db"), 0o600);
	}
	secretsPath = resolveSecretsPath(url);
	installationId = new SecretManager(secretsPath).getOrCreateSecrets().installationId;
	oldHash = await passwords.hashPassword(oldPassword);
}, 90000);
beforeEach(async () => {
	await owned(async (p) => {
		await p.user.deleteMany();
		await p.user.create({
			data: {
				id: "selected",
				username: "Owner",
				hashedPassword: oldHash,
				mustChangePassword: true,
				failedLoginAttempts: 5,
				lockedUntil: new Date(Date.now() + 600000),
				encryptedTmdbApiKey: "synthetic-cipher",
				tmdbEncryptionIv: "synthetic-iv",
			},
		});
		await p.user.create({
			data: { id: "peer", username: "owner", hashedPassword: oldHash, failedLoginAttempts: 2 },
		});
		await p.user.create({ data: { id: "passwordless", username: "Passwordless" } });
		await p.session.createMany({
			data: [
				{ id: "selected-session", userId: "selected", expiresAt: new Date(Date.now() + 600000) },
				{ id: "peer-session", userId: "peer", expiresAt: new Date(Date.now() + 600000) },
			],
		});
		await p.oIDCAccount.create({
			data: { id: "oidc", userId: "selected", providerUserId: "synthetic-subject" },
		});
		await p.webAuthnCredential.create({
			data: { id: "passkey", userId: "selected", publicKey: "synthetic-public-key", counter: 7 },
		});
		await p.serviceInstance.create({
			data: {
				id: "connection",
				userId: "selected",
				service: "SONARR",
				label: "Synthetic disabled connection",
				baseUrl: "https://synthetic.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
				enabled: false,
			},
		});
	});
});
afterEach(async () => {
	vi.restoreAllMocks();
	if (child) {
		child.kill("SIGCONT");
		child.kill("SIGKILL");
		if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
		child = undefined;
	}
	await held?.close();
	held = undefined;
});
afterAll(() => {
	if (directory) rmSync(directory, { recursive: true, force: true });
});

describe(`actual native ${provider} offline recovery`, () => {
	it("changes exactly one credential, clears its lockout/revokes only its sessions and conserves all other data", async () => {
		const before = await snapshot();
		const secretBytes = readFileSync(secretsPath);
		expect(await recovery()).toEqual({ status: "success" });
		const after = await snapshot();
		const target = after.users.find((u) => u.id === "selected")!;
		expect(await passwords.verifyPassword(oldPassword, target.hashedPassword!)).toBe(false);
		expect(await passwords.verifyPassword(newPassword, target.hashedPassword!)).toBe(true);
		expect(target).toMatchObject({
			failedLoginAttempts: 0,
			lockedUntil: null,
			mustChangePassword: true,
		});
		const stable = ({
			hashedPassword: _h,
			failedLoginAttempts: _f,
			lockedUntil: _l,
			updatedAt: _u,
			...rest
		}: typeof target) => rest;
		expect(stable(target)).toEqual(stable(before.users.find((u) => u.id === "selected")!));
		expect(after.users.filter((u) => u.id !== "selected")).toEqual(
			before.users.filter((u) => u.id !== "selected"),
		);
		expect(after.sessions).toEqual(before.sessions.filter((s) => s.userId !== "selected"));
		expect(after.passkeys).toEqual(before.passkeys);
		expect(after.oidc).toEqual(before.oidc);
		expect(after.connections).toEqual(before.connections);
		expect(readFileSync(secretsPath)).toEqual(secretBytes);
	});
	it.each(["OWNER", "Missing", "Passwordless"])(
		"refuses %s and preserves every account/session",
		async (username) => {
			const before = await snapshot();
			expect(await recovery(username)).toEqual({ status: "refused" });
			expect(await snapshot()).toEqual(before);
		},
	);
	it("rolls password and session changes back together when actual session deletion fails", async () => {
		const before = await snapshot();
		await owned(async (p) => {
			if (provider === "sqlite")
				await p.$executeRawUnsafe(
					`CREATE TRIGGER refuse_recovery_session BEFORE DELETE ON sessions WHEN OLD.userId='selected' BEGIN SELECT RAISE(ABORT,'Synthetic session refusal'); END`,
				);
			else {
				await p.$executeRawUnsafe(
					`CREATE FUNCTION refuse_recovery_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic session refusal'; END $$`,
				);
				await p.$executeRawUnsafe(
					"CREATE TRIGGER refuse_recovery_session BEFORE DELETE ON sessions FOR EACH ROW EXECUTE FUNCTION refuse_recovery_session()",
				);
			}
		});
		try {
			expect(await recovery()).toEqual({ status: "uncertain" });
			expect(await snapshot()).toEqual(before);
		} finally {
			await owned(async (p) => {
				await p.$executeRawUnsafe(
					provider === "sqlite"
						? "DROP TRIGGER refuse_recovery_session"
						: "DROP TRIGGER refuse_recovery_session ON sessions",
				);
				if (provider === "postgresql")
					await p.$executeRawUnsafe("DROP FUNCTION refuse_recovery_session()");
			});
		}
	});
	it("refuses a live normal native owner with no password/session mutation", async () => {
		const before = await snapshot();
		held = await openRestoreRuntime({ databaseUrl: url });
		await held.bindDestination(installationId);
		await held.activate();
		expect(await recovery()).toEqual({ status: "failed" });
		await held.close();
		held = undefined;
		expect(await snapshot()).toEqual(before);
	});
	it("concurrent recovery actors cannot both mutate", async () => {
		const results = await Promise.all([recovery(), recovery()]);
		expect(results.map((r) => r.status).sort()).toEqual(["failed", "success"]);
		expect((await snapshot()).sessions.map((s) => s.userId)).toEqual(["peer"]);
	});
	it("refuses a physically suspended native owner", async () => {
		const before = await snapshot();
		const file =
			provider === "sqlite"
				? process.env.SQLITE_RESTORE_ADMISSION_ACTOR_FILE
				: join(api, "src/lib/backup/__tests__/fixtures/restore-runtime-postgres-owner.ts");
		if (!file) throw new Error("Existing native owner actor fixture required");
		child = fork(file, provider === "sqlite" ? [url, randomUUID()] : [], {
			execArgv: file.endsWith(".ts") ? ["--import", import.meta.resolve("tsx/esm")] : [],
			env: {
				PATH: process.env.PATH,
				TEST_DATABASE_URL: url,
				LOG_DIR: "/dev/null/arr-recovery-fixture",
				NODE_ENV: "test",
			},
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const message = () =>
			Promise.race([
				once(child!, "message").then(([m]) => m),
				new Promise((_, reject) => {
					const timer = setTimeout(
						() => reject(new Error("Native owner fixture did not settle")),
						5000,
					);
					timer.unref();
				}),
			]);
		const ready = await message();
		if (provider === "postgresql") {
			expect(ready.category).toBe("ready");
			const pending = message();
			child.send({ id: 1, command: "acquire" });
			expect((await pending).category).toBe("acquired");
		} else expect(ready.kind).toBe("owned");
		child.kill("SIGSTOP");
		expect(await recovery()).toEqual({ status: "failed" });
		child.kill("SIGCONT");
		const exiting = once(child, "exit");
		if (provider === "sqlite") {
			const closing = message();
			child.send({ close: true });
			expect((await closing).kind).toBe("closed");
		} else child.disconnect();
		await exiting;
		child = undefined;
		expect(await snapshot()).toEqual(before);
	});
	it("owner loss during hashing never authorizes the pending mutation", async () => {
		const before = await snapshot();
		const hash = passwords.hashPassword;
		const ownerPath = url.startsWith("file:")
			? join(`${url.slice(5)}.arr-restore-runtime`, "owner.sqlite3")
			: undefined;
		vi.spyOn(passwords, "hashPassword").mockImplementation(async (value) => {
			const result = await hash(value);
			if (ownerPath) renameSync(ownerPath, `${ownerPath}.moved`);
			else {
				const c = new Client({ connectionString: url });
				await c.connect();
				try {
					await c.query(
						'SELECT pg_terminate_backend("ownerBackendPid") FROM "RestoreRuntimeControl" WHERE id=1',
					);
				} finally {
					await c.end();
				}
			}
			return result;
		});
		try {
			expect(await recovery()).toEqual({ status: "failed" });
		} finally {
			vi.restoreAllMocks();
			if (ownerPath) renameSync(`${ownerPath}.moved`, ownerPath);
		}
		expect(await snapshot()).toEqual(before);
	});
	it("joined maintenance close permits unchanged normal API startup and real login", async () => {
		expect(await recovery()).toEqual({ status: "success" });
		const { buildServer } = await import("../../../server.js");
		const { envSchema } = await import("../../../config/env.js");
		const app = buildServer({
			logger: false,
			env: envSchema.parse({
				NODE_ENV: "test",
				DATABASE_URL: url,
				COOKIE_SECURE: "false",
				APP_URL: "http://127.0.0.1",
				API_PORT: 0,
			}),
		});
		try {
			await app.ready();
			const rejected = await app.inject({
				method: "POST",
				url: "/auth/login",
				payload: { username: "Owner", password: oldPassword },
			});
			expect(rejected.statusCode).toBe(401);
			const accepted = await app.inject({
				method: "POST",
				url: "/auth/login",
				payload: { username: "Owner", password: newPassword },
			});
			expect(accepted.statusCode).toBe(200);
		} finally {
			await app.close();
		}
	}, 30000);
});
