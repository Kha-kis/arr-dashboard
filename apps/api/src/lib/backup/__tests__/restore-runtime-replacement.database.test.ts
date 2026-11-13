import type { BackupData, BackupFormatVersion } from "@arr/shared";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { execFile, fork } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { BackupCompatibilityError } from "../../errors.js";
import { importConnectionFingerprint } from "../../queue-cleaner/import-receipt.js";
import { encryptBackupData } from "../backup-crypto.js";
import * as databaseOperations from "../backup-database.js";
import { PORTABLE_SAFETY_PAYLOAD_FIELDS } from "../backup-portability.js";
import { prepareRestoreData, RestorePreparationError } from "../backup-restore-preparation.js";
import { COMPLETE_V1_2_PAYLOAD_FIELDS } from "../backup-validation.js";
import * as runtimeOperations from "../restore-runtime-admission.js";
import {
	createRuntimePrismaClient,
	createRuntimeReplacementPrismaClient,
} from "../restore-runtime-client.js";
import { publishPreparedRestore } from "../restore-runtime-replacement.js";
import { writeRestoreRuntimeCommit } from "../restore-runtime-repository.js";
import {
	preparePublicationCredentialFixture,
	publicationCredentialColumns,
} from "./fixtures/restore-runtime-replacement-actor.js";
import {
	acquireSqliteRestoreOperationLock,
	acquireSqliteRestoreRuntimeOwnership,
} from "../restore-runtime-sqlite.js";
import { parseSqliteRestoreRuntimeRecord } from "../restore-runtime-sqlite-enrollment.js";
import { classifyRestoreRuntimeRecovery } from "../restore-runtime-state.js";

const sourceKey = "53".repeat(32);
const destination = new Encryptor("64".repeat(32));
const destinationId = "synthetic-destination";
const source = new Encryptor(sourceKey);
const date = "2026-10-09T00:00:00.000Z";

async function prepare(version: BackupFormatVersion = "1.3") {
	const apiKey = source.encrypt("synthetic-provider-key");
	const backup: BackupData = {
		version,
		appVersion: "2.24.2",
		timestamp: date,
		secrets: { encryptionKey: sourceKey, sessionCookieSecret: "synthetic-source-cookie" },
		data: {
			...Object.fromEntries(
				[...COMPLETE_V1_2_PAYLOAD_FIELDS, ...PORTABLE_SAFETY_PAYLOAD_FIELDS].map((field) => [
					field,
					[],
				]),
			),
			users: [
				{
					id: "synthetic-owner",
					username: "synthetic",
					hashedPassword: "synthetic-password-hash",
					createdAt: date,
					updatedAt: date,
				},
			],
			sessions: [{ id: "source-session", userId: "synthetic-owner", token: "synthetic" }],
			serviceInstances: [
				{
					id: "synthetic-instance",
					userId: "synthetic-owner",
					service: "RADARR",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: apiKey.value,
					encryptionIv: apiKey.iv,
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
				},
			],
			serviceTags: [],
			serviceInstanceTags: [],
			oidcAccounts: [],
			webAuthnCredentials: [],
		},
	};
	return prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(backup), "synthetic-backup-password"),
		password: "synthetic-backup-password",
		destination: { encryptor: destination, installationId: destinationId, stableForRestart: true },
	});
}

describe("Restore publication preflight before maintenance", () => {
	it("accepts genuine complete preparation without changing translated records", async () => {
		const prepared = await prepare();
		const before = structuredClone(prepared);
		expect(() =>
			databaseOperations.assertPreparedRestorePublication(prepared, destinationId),
		).not.toThrow();
		expect(prepared).toEqual(before);
		expect(prepared.records.users).toHaveLength(1);
		expect(prepared.records.serviceInstances).toHaveLength(1);
		expect(prepared.records.sessions).toEqual([]);
	});
	it.each(["", "other-destination"])("refuses destination mismatch %j", async (identity) => {
		const prepared = await prepare();
		const before = structuredClone(prepared);
		expect(() => databaseOperations.assertPreparedRestorePublication(prepared, identity)).toThrow(
			BackupCompatibilityError,
		);
		expect(prepared).toEqual(before);
	});
	it.each(["structural", "serialized"])(
		"refuses a %s clone of authenticated preparation",
		async (kind) => {
			const prepared = await prepare();
			const forged = kind === "structural" ? { ...prepared } : JSON.parse(JSON.stringify(prepared));
			expect(() =>
				databaseOperations.assertPreparedRestorePublication(forged, destinationId),
			).toThrow(RestorePreparationError);
		},
	);
	it("refuses genuine legacy preparation with incomplete safety coverage", async () => {
		const prepared = await prepare("1.2");
		expect(prepared.safetyCoverage).toBe("legacy-incomplete");
		expect(() =>
			databaseOperations.assertPreparedRestorePublication(prepared, destinationId),
		).toThrow(BackupCompatibilityError);
	});
});

describe.each(["WAL", "DELETE"])("real SQLite prepared replacement publication in %s", (mode) => {
	let directory: string;
	let path: string;
	let runtime: runtimeOperations.RestoreRuntime;
	let ordinary: ReturnType<typeof createRuntimePrismaClient>;
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-restore-publication-"));
		path = join(directory, "main.db");
		const url = `file:${path}`;
		const api = resolve(import.meta.dirname, "../../../..");
		const schema = join(directory, "schema.prisma");
		const config = join(directory, "safe.config.ts");
		writeFileSync(
			schema,
			readFileSync(join(api, "prisma/schema.prisma"), "utf8").replace(
				/generator client \{[\s\S]*?\}/,
				'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
			),
			{ mode: 0o600 },
		);
		writeFileSync(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
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
					LANG: "C.UTF-8",
					TZ: "UTC",
					NODE_ENV: "test",
					CI: "true",
					DOTENV_CONFIG_PATH: "/dev/null",
					CHECKPOINT_DISABLE: "1",
					DATABASE_URL: url,
				},
				timeout: 60000,
			},
		);
		chmodSync(path, 0o600);
		const main = new Database(path);
		main.pragma(`journal_mode = ${mode}`);
		main.close();
		runtime = await runtimeOperations.openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination(destinationId);
		await runtime.activate();
		ordinary = createRuntimePrismaClient(runtime);
		await runtime.runOperation(async () => {
			const credential = destination.encrypt("synthetic-old-provider-key");
			await ordinary.prisma.user.create({
				data: {
					id: "publication-owner",
					username: "synthetic-old",
					hashedPassword: "synthetic-hash",
					encryptedTmdbApiKey: credential.value,
					tmdbEncryptionIv: credential.iv,
				},
			});
			await ordinary.prisma.session.create({
				data: {
					id: "destination-session",
					userId: "publication-owner",
					expiresAt: new Date("2030-01-01T00:00:00.000Z"),
				},
			});
		});
	}, 90000);
	afterEach(async () => {
		await ordinary?.close();
		await runtime?.close();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	async function preparedReplacement() {
		const records = await runtime.runOperation(() =>
			databaseOperations.exportDatabase(ordinary.prisma),
		);
		const credential = source.encrypt("synthetic-restored-provider-key");
		records.users[0]!.username = "synthetic-restored";
		records.users[0]!.encryptedTmdbApiKey = credential.value;
		records.users[0]!.tmdbEncryptionIv = credential.iv;
		const backup: BackupData = {
			version: "1.3",
			appVersion: "2.24.2",
			timestamp: date,
			data: records,
			secrets: { encryptionKey: sourceKey, sessionCookieSecret: "synthetic-source-cookie" },
		};
		const prepared = await prepareRestoreData({
			envelope: await encryptBackupData(JSON.stringify(backup), "synthetic-backup-password"),
			password: "synthetic-backup-password",
			destination: {
				encryptor: destination,
				installationId: destinationId,
				stableForRestart: true,
			},
		});
		return prepared;
	}
	it("publishes actual prepared rows, destination-key credentials and session revocation with one positive marker", async () => {
		const prepared = await preparedReplacement();
		expect(prepared.records.sessions).toEqual([]);
		const storage = lstatSync(path, { bigint: true });
		const main = new Database(path, { readonly: true, fileMustExist: true });
		try {
			const binding = main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all();
			const result = await publishPreparedRestore({ runtime, prepared });
			expect(result).toMatchObject({ outcome: "committed", restartRequired: true, reason: null });
			const row = main
				.prepare('SELECT username, encryptedTmdbApiKey, tmdbEncryptionIv FROM "User" WHERE id=?')
				.get("publication-owner") as {
				username: string;
				encryptedTmdbApiKey: string;
				tmdbEncryptionIv: string;
			};
			expect(row.username).toBe("synthetic-restored");
			expect(
				destination.decrypt({ value: row.encryptedTmdbApiKey, iv: row.tmdbEncryptionIv }),
			).toBe("synthetic-restored-provider-key");
			expect(main.prepare('SELECT COUNT(*) AS count FROM "sessions"').get()).toEqual({ count: 0 });
			expect(
				main
					.prepare(
						'SELECT phase, activeRestoreId, lastCommittedRestoreId FROM "RestoreRuntimeControl"',
					)
					.get(),
			).toEqual({
				phase: "restart-required",
				activeRestoreId: result.restoreId,
				lastCommittedRestoreId: result.restoreId,
			});
			expect(main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all()).toEqual(binding);
			expect(main.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
			const current = lstatSync(path, { bigint: true });
			expect([current.dev, current.ino]).toEqual([storage.dev, storage.ino]);
			await expect(runtime.runOperation(() => 0)).rejects.toThrow(
				runtimeOperations.RestoreRuntimeAdmissionError,
			);
		} finally {
			main.close();
		}
	});
	it("queued shutdown joins the actual publishing transaction and native writer closure", async () => {
		const prepared = await preparePublicationCredentialFixture(runtime, ordinary.prisma, true);
		let entered!: () => void;
		let resume!: () => void;
		const inserted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const release = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let physical: Database.Database | undefined;
		const connect = PrismaBetterSqlite3.prototype.connect;
		const spy = vi
			.spyOn(PrismaBetterSqlite3.prototype, "connect")
			.mockImplementation(async function (this: PrismaBetterSqlite3) {
				const driver = await connect.call(this);
				physical = Reflect.get(driver, "client") as Database.Database;
				const start = driver.startTransaction.bind(driver);
				driver.startTransaction = async (...args) => {
					const transaction = await start(...args);
					const query = transaction.queryRaw.bind(transaction);
					const execute = transaction.executeRaw.bind(transaction);
					const pause = async <T>(sql: string, result: T): Promise<T> => {
						if (
							/^\s*INSERT\s+INTO\s+(?:(?:"[^"\n]+"|`[^`\n]+`)\.)?(?:"User"|`User`)\s/i.test(sql)
						) {
							entered();
							await release;
						}
						return result;
					};
					transaction.queryRaw = async (request) => pause(request.sql, await query(request));
					transaction.executeRaw = async (request) => pause(request.sql, await execute(request));
					return transaction;
				};
				return driver;
			});
		const main = new Database(path, { readonly: true, fileMustExist: true });
		const binding = main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all();
		const storage = lstatSync(path, { bigint: true });
		let publicationSettled = false;
		const publishing = publishPreparedRestore({ runtime, prepared }).finally(() => {
			publicationSettled = true;
		});
		void publishing.catch(() => entered());
		let closing: Promise<void> | undefined;
		let shutdownSettled = false;
		try {
			await Promise.race([
				inserted,
				publishing.then(() => {
					throw new Error("Actual transaction INSERT barrier was not reached");
				}),
			]);
			expect(physical?.open).toBe(true);
			expect(physical?.inTransaction).toBe(true);
			closing = runtime.close().then(() => {
				shutdownSettled = true;
			});
			void closing.catch(() => {});
			await expect(runtime.runOperation(() => 0)).rejects.toThrow(
				runtimeOperations.RestoreRuntimeAdmissionError,
			);
			await expect(acquireSqliteRestoreRuntimeOwnership(`file:${path}`)).rejects.toThrow();
			await expect(acquireSqliteRestoreOperationLock(`file:${path}`)).rejects.toThrow();
			expect(publicationSettled).toBe(false);
			expect(shutdownSettled).toBe(false);
			expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
				{ username: "synthetic-old" },
			]);
			expect(main.prepare('SELECT COUNT(*) AS count FROM "sessions"').get()).toEqual({ count: 1 });
			expect(
				main.prepare('SELECT phase, lastCommittedRestoreId FROM "RestoreRuntimeControl"').get(),
			).toEqual({ phase: "restore-pending", lastCommittedRestoreId: null });
			resume();
			const result = await publishing;
			expect(result).toMatchObject({ outcome: "committed", restartRequired: true, reason: null });
			await closing;
			expect(shutdownSettled).toBe(true);
			expect(physical?.open).toBe(false);
			const owner = await acquireSqliteRestoreRuntimeOwnership(`file:${path}`);
			try {
				expect(await owner.tryAcquireExclusive()).toBe(true);
			} finally {
				await owner.close();
			}
			for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
				const rows = main
					.prepare(`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`)
					.all() as Array<{ value: string; iv: string }>;
				expect(rows).toHaveLength(1);
				expect(destination.decrypt(rows[0]!)).toBe(plaintext);
			}
			expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
				{ username: "synthetic-restored" },
			]);
			expect(main.prepare('SELECT COUNT(*) AS count FROM "sessions"').get()).toEqual({ count: 0 });
			expect(
				main.prepare('SELECT phase, lastCommittedRestoreId FROM "RestoreRuntimeControl"').get(),
			).toEqual({ phase: "restart-required", lastCommittedRestoreId: result.restoreId });
			expect(main.prepare('SELECT id, state FROM "queue_cleaner_import_receipts"').all()).toEqual([
				{ id: "credential-receipt", state: "unknown" },
			]);
			expect(main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all()).toEqual(binding);
			expect([
				lstatSync(path, { bigint: true }).dev,
				lstatSync(path, { bigint: true }).ino,
			]).toEqual([storage.dev, storage.ino]);
			expect(main.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
		} finally {
			resume();
			await Promise.allSettled([publishing, ...(closing ? [closing] : [])]);
			spy.mockRestore();
			main.close();
		}
	}, 30000);
	it.each(["insert-failure", "marker-cas-loss", "commit-failure"])(
		"rolls back rows, credentials, sessions and marker after %s",
		async (failure) => {
			const prepared = await preparedReplacement();
			const main = new Database(path, { fileMustExist: true });
			try {
				if (failure === "insert-failure")
					main.exec(`CREATE TRIGGER reject_restored BEFORE INSERT ON User
				WHEN NEW.username='synthetic-restored' BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END`);
				else if (failure === "marker-cas-loss")
					main.exec(`CREATE TRIGGER reject_marker BEFORE UPDATE ON RestoreRuntimeControl
				WHEN NEW.phase='restart-required' BEGIN SELECT RAISE(IGNORE); END`);
				else
					main.exec(`CREATE TABLE PublicationRequiredParent(id INTEGER PRIMARY KEY);
				CREATE TABLE PublicationDeferredFailure(parentId INTEGER REFERENCES PublicationRequiredParent(id) DEFERRABLE INITIALLY DEFERRED);
				CREATE TRIGGER reject_commit AFTER UPDATE ON RestoreRuntimeControl WHEN NEW.phase='restart-required'
				BEGIN INSERT INTO PublicationDeferredFailure VALUES(1); END`);
				const result = await publishPreparedRestore({ runtime, prepared });
				expect(result).toMatchObject({
					outcome: "not-committed",
					restartRequired: true,
					reason: "state-changed",
				});
				const user = main
					.prepare('SELECT username, encryptedTmdbApiKey, tmdbEncryptionIv FROM "User"')
					.get() as {
					username: string;
					encryptedTmdbApiKey: string;
					tmdbEncryptionIv: string;
				};
				expect(user.username).toBe("synthetic-old");
				expect(
					destination.decrypt({ value: user.encryptedTmdbApiKey, iv: user.tmdbEncryptionIv }),
				).toBe("synthetic-old-provider-key");
				expect(main.prepare('SELECT id FROM "sessions"').all()).toEqual([
					{ id: "destination-session" },
				]);
				expect(
					main
						.prepare(
							'SELECT phase, activeRestoreId, lastCommittedRestoreId, lastCommittedAt FROM "RestoreRuntimeControl"',
						)
						.get(),
				).toEqual({
					phase: "restore-pending",
					activeRestoreId: result.restoreId,
					lastCommittedRestoreId: null,
					lastCommittedAt: null,
				});
				if (failure === "commit-failure")
					expect(main.prepare('SELECT * FROM "PublicationDeferredFailure"').all()).toEqual([]);
				await expect(runtime.runOperation(() => 0)).rejects.toThrow(
					runtimeOperations.RestoreRuntimeAdmissionError,
				);
			} finally {
				main.close();
			}
		},
	);
	it("fences application SQL after the transaction writes its positive marker", async () => {
		const prepared = await preparedReplacement();
		await expect(
			runtimeOperations.withRestoreRuntimeReplacement(runtime, prepared, async (scope) => {
				const context = runtimeOperations.getRestoreRuntimeReplacementClientContext(scope);
				const writer = createRuntimeReplacementPrismaClient(scope);
				await writer.prisma.$transaction(async (tx) => {
					await writeRestoreRuntimeCommit(tx, context.commitRequest);
					await tx.user.count();
				});
			}),
		).rejects.toThrow();
		const main = new Database(path, { readonly: true, fileMustExist: true });
		try {
			expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
				{ username: "synthetic-old" },
			]);
			expect(
				main.prepare('SELECT phase, lastCommittedRestoreId FROM "RestoreRuntimeControl"').get(),
			).toEqual({ phase: "restore-pending", lastCommittedRestoreId: null });
		} finally {
			main.close();
		}
	});
	it("refuses a stale preparation rather than deleting an import hold added before reservation", async () => {
		const prepared = await preparedReplacement();
		const hold = await runtime.runOperation(async () => {
			const credential = destination.encrypt("synthetic-late-provider-key");
			const instance = await ordinary.prisma.serviceInstance.create({
				data: {
					id: "late-instance",
					userId: "publication-owner",
					service: "RADARR",
					label: "synthetic-late",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: credential.value,
					encryptionIv: credential.iv,
				},
			});
			return ordinary.prisma.queueCleanerImportReceipt.create({
				data: {
					id: "late-hold",
					instanceId: instance.id,
					downloadKey: "a".repeat(64),
					queueId: 7,
					downloadTitle: "synthetic-late",
					connectionFingerprint: importConnectionFingerprint(instance),
					commandFingerprint: `v1:${"b".repeat(64)}`,
					commandId: 42,
					state: "unknown",
					lastAttemptAt: new Date(date),
				},
			});
		});
		const main = new Database(path, { readonly: true, fileMustExist: true });
		try {
			const before = main.prepare('SELECT * FROM "queue_cleaner_import_receipts"').all();
			const instances = main.prepare('SELECT * FROM "ServiceInstance"').all();
			const result = await publishPreparedRestore({ runtime, prepared });
			expect(result).toMatchObject({ outcome: "not-committed", reason: "state-changed" });
			expect(main.prepare('SELECT * FROM "queue_cleaner_import_receipts"').all()).toEqual(before);
			expect(main.prepare('SELECT * FROM "ServiceInstance"').all()).toEqual(instances);
			expect(hold.state).toBe("unknown");
			expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
				{ username: "synthetic-old" },
			]);
			expect(main.prepare('SELECT id FROM "sessions"').all()).toEqual([
				{ id: "destination-session" },
			]);
			expect(
				main.prepare('SELECT phase, lastCommittedRestoreId FROM "RestoreRuntimeControl"').get(),
			).toEqual({ phase: "restore-pending", lastCommittedRestoreId: null });
		} finally {
			main.close();
		}
	});
	it("allows only one writer and rejects escaped native clients instead of reconnecting", async () => {
		const prepared = await preparedReplacement();
		const writer = await runtimeOperations.withRestoreRuntimeReplacement(
			runtime,
			prepared,
			async (scope) => {
				const active = createRuntimeReplacementPrismaClient(scope);
				expect(() => createRuntimeReplacementPrismaClient(scope)).toThrow(
					runtimeOperations.RestoreRuntimeAdmissionError,
				);
				expect(await active.prisma.user.count()).toBe(1);
				return active;
			},
		);
		await expect(writer.prisma.user.count()).rejects.toThrow();
		const main = new Database(path, { readonly: true, fileMustExist: true });
		try {
			expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
				{ username: "synthetic-old" },
			]);
		} finally {
			main.close();
		}
	});
	it.each([false, true])(
		"publishes all nine credential pairs and %s current-held-state conservation",
		async (retainCurrentHolds) => {
			const prepared = await preparePublicationCredentialFixture(
				runtime,
				ordinary.prisma,
				retainCurrentHolds,
			);
			const main = new Database(path, { readonly: true, fileMustExist: true });
			try {
				const result = await publishPreparedRestore({ runtime, prepared });
				expect(result).toMatchObject({ outcome: "committed", reason: null, restartRequired: true });
				for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
					const rows = main
						.prepare(`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`)
						.all() as Array<{ value: string; iv: string }>;
					expect(rows).toHaveLength(1);
					expect(destination.decrypt(rows[0]!)).toBe(plaintext);
				}
				expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
					{ username: "synthetic-restored" },
				]);
				expect(main.prepare('SELECT id FROM "sessions"').all()).toEqual([]);
				expect(
					main.prepare('SELECT id, state, commandId FROM "queue_cleaner_import_receipts"').all(),
				).toEqual([{ id: "credential-receipt", state: "unknown", commandId: 42 }]);
				expect(
					main
						.prepare(
							'SELECT id, state, commandId, revision, reconcileToken, reconcileExpiresAt FROM "arr_import_operations"',
						)
						.all(),
				).toEqual([
					{
						id: "credential-operation",
						state: "unknown",
						commandId: 42,
						revision: 3,
						reconcileToken: null,
						reconcileExpiresAt: null,
					},
				]);
				expect(
					main.prepare('SELECT id, activeOperationId FROM "arr_import_source_claims"').all(),
				).toEqual([{ id: "credential-claim", activeOperationId: "credential-operation" }]);
				expect(
					main.prepare('SELECT id, operationId, verifiedAt FROM "arr_import_file_proofs"').all(),
				).toEqual([
					{ id: "credential-proof", operationId: "credential-operation", verifiedAt: null },
				]);
				expect(
					main.prepare('SELECT phase, lastCommittedRestoreId FROM "RestoreRuntimeControl"').get(),
				).toEqual({ phase: "restart-required", lastCommittedRestoreId: result.restoreId });
			} finally {
				main.close();
			}
		},
	);
	it.each(["returns-early", "rejects"] as const)(
		"waits for actual native worker exit before pending when termination %s",
		async (termination) => {
			const prepared = await preparePublicationCredentialFixture(runtime, ordinary.prisma, true);
			const actorFile = process.env.SQLITE_RESTORE_WORKER_EXIT_ACTOR_FILE;
			if (!actorFile) throw new Error("Compiled native Worker exit actor required");
			const { runJellyfinEpisodeFinalizerWorker } = await import(
				"../../jellyfin/jellyfin-episode-finalizer-worker-transport.js"
			);
			let worker: Worker | undefined;
			let actualExit: Promise<number> | undefined;
			let ready!: () => void, failed!: (error: Error) => void, stopRequested!: () => void;
			const resultMessage = new Promise<void>((resolve, reject) => {
				ready = resolve;
				failed = reject;
			});
			const stopped = new Promise<void>((resolve) => {
				stopRequested = resolve;
			});
			let workSettled = false;
			const running = runtime
				.runIndependentOperation(() =>
					runJellyfinEpisodeFinalizerWorker(
						{
							databaseUrl: `file:${path}`,
							userId: "synthetic",
							runId: "synthetic",
							scopes: [],
							attempt: { attemptedAt: new Date(date), resultMarker: "synthetic" },
							now: new Date(date),
							instance: {
								id: "synthetic",
								userId: "synthetic",
								service: "JELLYFIN",
								baseUrl: "http://synthetic.invalid",
								apiKey: "synthetic",
								enabled: true,
								encryptedApiKey: "synthetic",
								encryptionIv: "synthetic",
								encryptedHttpAuthCredentials: null,
								httpAuthEncryptionIv: null,
								expectedIdentity: null,
								identityStatus: "UNVERIFIED",
								connectionGeneration: 1,
								identityGeneration: 1,
							},
						},
						{
							createWorker: () => {
								worker = new Worker(new URL(`file://${actorFile}`), {
									workerData: { databaseUrl: `file:${path}` },
									env: Object.fromEntries(
										["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
											process.env[key] ? [[key, process.env[key]]] : [],
										),
									),
								});
								const physical = worker;
								actualExit = new Promise<number>((resolve) => physical.once("exit", resolve));
								physical.once("message", ready);
								physical.once("error", failed);
								return {
									on: physical.on.bind(physical),
									terminate: () => {
										stopRequested();
										if (termination === "rejects")
											return Promise.reject(new Error("Synthetic termination refusal"));
										return 0;
									},
								};
							},
						},
					),
				)
				.finally(() => {
					workSettled = true;
				});
			void running.catch(failed);
			let publishing: ReturnType<typeof publishPreparedRestore> | undefined;
			try {
				await resultMessage;
				await stopped;
				expect(worker!.threadId).not.toBe(-1);
				expect(workSettled).toBe(false);
				publishing = publishPreparedRestore({ runtime, prepared });
				void publishing.catch(() => {});
				await expect(runtime.runOperation(() => ordinary.prisma.user.count())).rejects.toThrow(
					runtimeOperations.RestoreRuntimeAdmissionError,
				);
				const main = new Database(path, { readonly: true, fileMustExist: true });
				try {
					expect(
						main.prepare('SELECT phase, activeRestoreId FROM "RestoreRuntimeControl"').get(),
					).toEqual({ phase: "running", activeRestoreId: null });
					expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
						{ username: "synthetic-old" },
					]);
					expect(main.prepare('SELECT id FROM "sessions"').all()).toEqual([
						{ id: "destination-session" },
					]);
				} finally {
					main.close();
				}
				expect(workSettled).toBe(false);
				worker!.postMessage("release");
				expect(await actualExit).toBe(0);
				expect(worker!.threadId).toBe(-1);
				await expect(running).resolves.toMatchObject({ status: "published", itemCount: 0 });
				await expect(publishing).resolves.toMatchObject({ outcome: "committed", reason: null });
			} finally {
				if (worker && worker.threadId !== -1) await worker.terminate();
				await actualExit;
				await Promise.allSettled([running, ...(publishing ? [publishing] : [])]);
			}
		},
		30000,
	);
	it("refuses recovery after real owner death while a shared follower retains its main transaction", async () => {
		await preparePublicationCredentialFixture(runtime, ordinary.prisma, true);
		await ordinary.close();
		await runtime.close();
		const actorFile = process.env.SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE;
		if (!actorFile) throw new Error("Compiled current replacement actor required");
		const url = "file:" + path;
		const main = new Database(path, { fileMustExist: true, timeout: 0 });
		const storage = lstatSync(path, { bigint: true });
		const binding = main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all();
		const tables = [
			"User",
			"ServiceInstance",
			"sessions",
			"queue_cleaner_import_receipts",
			"arr_import_operations",
			"arr_import_source_claims",
			"arr_import_file_proofs",
		];
		const snapshot = () =>
			Object.fromEntries(
				tables.map((table) => [table, main.prepare('SELECT * FROM "' + table + '"').all()]),
			);
		const before = snapshot();
		const env = Object.fromEntries(
			["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
				process.env[key] ? [[key, process.env[key]]] : [],
			),
		);
		const child = fork(actorFile, [url, "crash-before-pending"], {
			env,
			stdio: ["ignore", "pipe", "ignore", "ipc"],
		});
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		let timer: ReturnType<typeof setTimeout> | undefined;
		let follower: Awaited<ReturnType<typeof acquireSqliteRestoreOperationLock>> | undefined;
		try {
			const barrier = await new Promise<unknown>((resolve, reject) => {
				let line = "";
				child.stdout!.on("data", (bytes) => {
					line += String(bytes);
					if (line.length > 384) reject(new Error("Bounded owner-death evidence required"));
					else if (line.endsWith("\n")) {
						try {
							resolve(JSON.parse(line));
						} catch {
							reject(new Error("Invalid owner-death evidence"));
						}
					}
				});
				child.once("error", reject);
				child.once("close", () => reject(new Error("Owner exited before reservation barrier")));
				timer = setTimeout(() => reject(new Error("Native owner-death barrier timeout")), 15000);
			});
			clearTimeout(timer);
			expect(barrier).toEqual({ kind: "publication-crash-barrier", stage: "crash-before-pending" });
			follower = await acquireSqliteRestoreOperationLock(url);
			main.exec("BEGIN");
			expect(snapshot()).toEqual(before);
			expect(main.open && main.inTransaction).toBe(true);
			child.kill("SIGKILL");
			await closed;
			await follower.assertHeld();
			const contender = await acquireSqliteRestoreRuntimeOwnership(url);
			try {
				expect(await contender.tryAcquireExclusive()).toBe(false);
			} finally {
				await contender.close();
			}
			await expect(runtimeOperations.openRestoreRuntime({ databaseUrl: url })).rejects.toThrow();
			expect(main.open && main.inTransaction).toBe(true);
			await follower.assertHeld();
			expect(
				main.prepare('SELECT phase, "activeRestoreId" FROM "RestoreRuntimeControl"').get(),
			).toEqual({
				phase: "running",
				activeRestoreId: null,
			});
			expect(snapshot()).toEqual(before);
			main.exec("ROLLBACK");
			await follower.close();
			follower = undefined;
			const fresh = await acquireSqliteRestoreRuntimeOwnership(url);
			try {
				expect(await fresh.tryAcquireExclusive()).toBe(true);
			} finally {
				await fresh.close();
			}
			runtime = await runtimeOperations.openRestoreRuntime({ databaseUrl: url });
			await runtime.bindDestination(destinationId);
			await runtime.activate();
			ordinary = createRuntimePrismaClient(runtime);
			expect(await runtime.runOperation(() => ordinary.prisma.user.count())).toBe(1);
			expect(snapshot()).toEqual(before);
			expect(main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all()).toEqual(binding);
			expect([
				lstatSync(path, { bigint: true }).dev,
				lstatSync(path, { bigint: true }).ino,
			]).toEqual([storage.dev, storage.ino]);
			expect(main.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
		} finally {
			if (timer) clearTimeout(timer);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
			if (main.inTransaction) main.exec("ROLLBACK");
			main.close();
			await follower?.close();
		}
	}, 30000);
	it.each(["sqlite-owner-loss-in-transaction", "sqlite-owner-loss-after-commit"] as const)(
		"retains physical publication exclusion after %s until actual actor closure",
		async (stage) => {
			await preparePublicationCredentialFixture(runtime, ordinary.prisma, true);
			await ordinary.close();
			await runtime.close();
			const actorFile = process.env.SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE;
			if (!actorFile) throw new Error("Compiled current replacement actor required");
			const main = new Database(path, { readonly: true, fileMustExist: true });
			const storage = lstatSync(path, { bigint: true });
			const binding = main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all();
			const tables = [
				"User",
				"ServiceInstance",
				"sessions",
				"queue_cleaner_import_receipts",
				"arr_import_operations",
				"arr_import_source_claims",
				"arr_import_file_proofs",
			];
			const snapshot = () =>
				Object.fromEntries(
					tables.map((table) => [table, main.prepare(`SELECT * FROM "${table}"`).all()]),
				);
			const before = snapshot();
			const url = `file:${path}`;
			const env = Object.fromEntries(
				["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
					process.env[key] ? [[key, process.env[key]]] : [],
				),
			);
			const child = fork(actorFile, [url, stage], {
				env,
				stdio: ["ignore", "pipe", "ignore", "ipc"],
			});
			const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const reached = await new Promise<unknown>((resolve, reject) => {
					let line = "";
					child.stdout!.on("data", (bytes) => {
						line += String(bytes);
						if (line.length > 384) reject(new Error("Bounded owner-loss evidence required"));
						else if (line.endsWith("\n")) {
							try {
								resolve(JSON.parse(line));
							} catch {
								reject(new Error("Invalid owner-loss evidence"));
							}
						}
					});
					child.once("error", reject);
					child.once("close", () =>
						reject(new Error("Publisher exited before actual owner-loss boundary")),
					);
					timer = setTimeout(() => reject(new Error("Native owner-loss barrier timeout")), 15000);
				});
				clearTimeout(timer);
				const committed = stage === "sqlite-owner-loss-after-commit";
				expect(reached).toEqual({
					kind: "publication-sqlite-owner-loss",
					stage,
					ownerPhysicallyClosed: true,
					mainOpen: true,
					mainInTransaction: !committed,
				});
				expect(child.exitCode).toBeNull();
				// The retained EXCLUSIVE lock also refuses the protocol read at initialization.
				await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
				const contenderOwner = new Database(join(`${path}.arr-restore-runtime`, "owner.sqlite3"), {
					timeout: 0,
					fileMustExist: true,
				});
				const contenderOperations = new Database(
					join(`${path}.arr-restore-runtime`, "operations.sqlite3"),
					{ timeout: 0, fileMustExist: true },
				);
				try {
					contenderOwner.exec("BEGIN IMMEDIATE");
					expect(() => contenderOperations.exec("BEGIN EXCLUSIVE")).toThrow(
						expect.objectContaining({ code: "SQLITE_BUSY" }),
					);
					expect(contenderOperations.inTransaction).toBe(false);
				} finally {
					contenderOperations.close();
					contenderOwner.close();
				}
				await expect(runtimeOperations.openRestoreRuntime({ databaseUrl: url })).rejects.toThrow();
				const liveRecord = main.prepare('SELECT * FROM "RestoreRuntimeControl"').get() as Record<
					string,
					unknown
				>;
				expect(liveRecord.phase).toBe(committed ? "restart-required" : "restore-pending");
				if (!committed) expect(snapshot()).toEqual(before);
				child.kill("SIGKILL");
				await closed;
				const owner = await acquireSqliteRestoreRuntimeOwnership(url);
				try {
					expect(await owner.tryAcquireExclusive()).toBe(true);
					expect(
						classifyRestoreRuntimeRecovery(
							parseSqliteRestoreRuntimeRecord(liveRecord),
							destinationId,
						),
					).toBe(committed ? "committed" : "not-committed");
				} finally {
					await owner.close();
				}
				const settledRows = snapshot();
				if (!committed) expect(settledRows).toEqual(before);
				expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
					{ username: committed ? "synthetic-restored" : "synthetic-old" },
				]);
				expect(main.prepare('SELECT COUNT(*) AS count FROM "sessions"').get()).toEqual({
					count: committed ? 0 : 1,
				});
				runtime = await runtimeOperations.openRestoreRuntime({ databaseUrl: url });
				await runtime.bindDestination(destinationId);
				await runtime.activate();
				ordinary = createRuntimePrismaClient(runtime);
				expect(await runtime.runOperation(() => ordinary.prisma.user.count())).toBe(1);
				expect(snapshot()).toEqual(settledRows);
				expect(main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all()).toEqual(binding);
				expect(lstatSync(path, { bigint: true }).ino).toBe(storage.ino);
				expect(lstatSync(path, { bigint: true }).dev).toBe(storage.dev);
				expect(main.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
			} finally {
				if (timer) clearTimeout(timer);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
				main.close();
			}
		},
		30000,
	);
	it("reconciles a lost actual SQLite COMMIT acknowledgement without replay", async () => {
		await preparePublicationCredentialFixture(runtime, ordinary.prisma, true);
		await ordinary.close();
		await runtime.close();
		const actorFile = process.env.SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE;
		if (!actorFile) throw new Error("Compiled current replacement actor required");
		const storage = lstatSync(path, { bigint: true });
		const main = new Database(path, { readonly: true, fileMustExist: true });
		const binding = main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all();
		const env = Object.fromEntries(
			["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
				process.env[key] ? [[key, process.env[key]]] : [],
			),
		);
		const child = fork(actorFile, [`file:${path}`, "lost-commit-result"], {
			env,
			stdio: ["ignore", "ignore", "ignore", "ipc"],
		});
		const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const result = await new Promise<unknown>((resolve, reject) => {
				child.once("message", resolve);
				child.once("error", reject);
				child.once("close", () => reject(new Error("Publisher exited before native result")));
				timer = setTimeout(() => reject(new Error("Native publication result timeout")), 15000);
			});
			expect(result).toMatchObject({
				kind: "publication-native-result",
				stage: "lost-commit-result",
				// Native COMMIT succeeded, but the adapter's cleanup cannot prove
				// rollback and poisons this runtime. Only a fresh owner may reconcile.
				publication: { outcome: "unavailable", reason: "commit-unknown" },
				nativeCommitCount: 1,
				shutdownRefused: false,
			});
			expect(child.exitCode).toBeNull();
			const positive = parseSqliteRestoreRuntimeRecord(
				main.prepare('SELECT * FROM "RestoreRuntimeControl"').get() as Record<string, unknown>,
			);
			expect(positive.phase).toBe("restart-required");
			expect(positive.lastCommittedRestoreId).toBe(positive.activeRestoreId);
			expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
				{ username: "synthetic-restored" },
			]);
			expect(main.prepare('SELECT id FROM "sessions"').all()).toEqual([]);
			for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
				const rows = main
					.prepare(`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`)
					.all() as Array<{ value: string; iv: string }>;
				expect(rows).toHaveLength(1);
				expect(destination.decrypt(rows[0]!)).toBe(plaintext);
			}
			const tables = [
				"User",
				"ServiceInstance",
				"sessions",
				"queue_cleaner_import_receipts",
				"arr_import_operations",
				"arr_import_source_claims",
				"arr_import_file_proofs",
			];
			const snapshot = () =>
				Object.fromEntries(
					tables.map((table) => [table, main.prepare(`SELECT * FROM "${table}"`).all()]),
				);
			const committedRows = snapshot();
			// The actor is still alive. Genuine owner acquisition and EXCLUSIVE
			// participation prove its native writer and coordination handles closed.
			const owner = await acquireSqliteRestoreRuntimeOwnership(`file:${path}`);
			try {
				expect(await owner.tryAcquireExclusive()).toBe(true);
				expect(classifyRestoreRuntimeRecovery(positive, destinationId)).toBe("committed");
			} finally {
				await owner.close();
			}
			runtime = await runtimeOperations.openRestoreRuntime({ databaseUrl: `file:${path}` });
			await runtime.bindDestination(destinationId);
			await runtime.activate();
			ordinary = createRuntimePrismaClient(runtime);
			expect(await runtime.runOperation(() => ordinary.prisma.user.count())).toBe(1);
			expect(snapshot()).toEqual(committedRows);
			expect(main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all()).toEqual(binding);
			expect(lstatSync(path, { bigint: true }).ino).toBe(storage.ino);
			expect(lstatSync(path, { bigint: true }).dev).toBe(storage.dev);
			expect(main.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
		} finally {
			if (timer) clearTimeout(timer);
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await closed;
			main.close();
		}
	}, 30000);
	it.each([
		["crash-before-pending", "running", "no-pending-restore", false],
		["crash-after-pending", "restore-pending", "not-committed", false],
		["crash-before-commit", "restore-pending", "not-committed", false],
		["crash-after-commit", "restart-required", "committed", true],
	] as const)(
		"recovers a real publisher after %s without replay or lost holds",
		async (stage, phase, category, committed) => {
			await preparePublicationCredentialFixture(runtime, ordinary.prisma, true);
			await ordinary.close();
			await runtime.close();
			const actorFile = process.env.SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE;
			if (!actorFile) throw new Error("Compiled current replacement actor required");
			const storage = lstatSync(path, { bigint: true });
			const main = new Database(path, { readonly: true, fileMustExist: true });
			const binding = main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all();
			const tables = [
				"User",
				"ServiceInstance",
				"sessions",
				"queue_cleaner_import_receipts",
				"arr_import_operations",
				"arr_import_source_claims",
				"arr_import_file_proofs",
			];
			const snapshot = () =>
				Object.fromEntries(
					tables.map((table) => [table, main.prepare(`SELECT * FROM "${table}"`).all()]),
				);
			const before = snapshot();
			const env = Object.fromEntries(
				["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
					process.env[key] ? [[key, process.env[key]]] : [],
				),
			);
			const url = `file:${path}`;
			const child = fork(actorFile, [url, stage], {
				env,
				stdio: ["ignore", "pipe", "ignore", "ipc"],
			});
			const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
				child.once("close", (code, signal) => resolve({ code, signal })),
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const barrier = await new Promise<unknown>((resolve, reject) => {
					let line = "";
					child.stdout!.on("data", (bytes) => {
						line += String(bytes);
						if (line.length > 256) reject(new Error("Bounded crash barrier required"));
						else if (line.endsWith("\n")) {
							try {
								resolve(JSON.parse(line));
							} catch {
								reject(new Error("Invalid crash barrier"));
							}
						}
					});
					child.once("error", reject);
					child.once("close", () => reject(new Error("Publisher exited before crash barrier")));
					timer = setTimeout(() => reject(new Error("Publisher crash barrier timeout")), 15000);
				});
				expect(barrier).toEqual({ kind: "publication-crash-barrier", stage });
				await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
				expect(main.prepare('SELECT phase FROM "RestoreRuntimeControl"').get()).toEqual({ phase });
				child.kill("SIGKILL");
				expect(await closed).toEqual({ code: null, signal: "SIGKILL" });
				const deadRecord = parseSqliteRestoreRuntimeRecord(
					main.prepare('SELECT * FROM "RestoreRuntimeControl"').get() as Record<string, unknown>,
				);
				const owner = await acquireSqliteRestoreRuntimeOwnership(url);
				try {
					expect(await owner.tryAcquireExclusive()).toBe(true);
					expect(classifyRestoreRuntimeRecovery(deadRecord, destinationId)).toBe(category);
				} finally {
					await owner.close();
				}
				const afterCrash = snapshot();
				if (!committed) expect(afterCrash).toEqual(before);
				expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
					{ username: committed ? "synthetic-restored" : "synthetic-old" },
				]);
				expect(main.prepare('SELECT COUNT(*) AS count FROM "sessions"').get()).toEqual({
					count: committed ? 0 : 1,
				});
				expect(
					main.prepare('SELECT id, state, commandId FROM "queue_cleaner_import_receipts"').all(),
				).toEqual([{ id: "credential-receipt", state: "unknown", commandId: 42 }]);
				expect(
					main.prepare('SELECT id, activeOperationId FROM "arr_import_source_claims"').all(),
				).toEqual([{ id: "credential-claim", activeOperationId: "credential-operation" }]);
				runtime = await runtimeOperations.openRestoreRuntime({ databaseUrl: url });
				await runtime.bindDestination(destinationId);
				await runtime.activate();
				ordinary = createRuntimePrismaClient(runtime);
				expect(await runtime.runOperation(() => ordinary.prisma.user.count())).toBe(1);
				expect(snapshot()).toEqual(afterCrash);
				const recovered = parseSqliteRestoreRuntimeRecord(
					main.prepare('SELECT * FROM "RestoreRuntimeControl"').get() as Record<string, unknown>,
				);
				expect(recovered).toMatchObject({
					phase: "running",
					activeRestoreId: null,
					lastCommittedRestoreId: deadRecord.lastCommittedRestoreId,
					lastCommittedAt: deadRecord.lastCommittedAt,
					destinationInstallationId: destinationId,
				});
				expect(recovered.runtimeEpoch).not.toBe(deadRecord.runtimeEpoch);
				expect(main.prepare('SELECT * FROM "SqliteRestoreStorageBinding"').all()).toEqual(binding);
				expect(main.pragma("journal_mode", { simple: true })).toBe(mode.toLowerCase());
				const current = lstatSync(path, { bigint: true });
				expect([current.dev, current.ino]).toEqual([storage.dev, storage.ino]);
			} finally {
				if (timer) clearTimeout(timer);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
				main.close();
			}
		},
		30000,
	);
	it.each(["sync-close", "writer-close-throw", "writer-close-false-ack", "marker-contradiction"])(
		"retains honest publication and physical ownership after native %s",
		async (failure) => {
			await ordinary.close();
			await runtime.close();
			const actorFile = process.env.SQLITE_RESTORE_REPLACEMENT_ACTOR_FILE;
			if (!actorFile) throw new Error("Compiled current replacement actor required");
			const env = Object.fromEntries(
				["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
					process.env[key] ? [[key, process.env[key]]] : [],
				),
			);
			const url = `file:${path}`;
			const child = fork(actorFile, [url, failure], {
				env,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
			const closed = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
				child.once("close", (code, signal) => resolve({ code, signal })),
			);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				const evidence = await new Promise<Record<string, unknown>>((resolve, reject) => {
					child.once("message", (message) => resolve(message as Record<string, unknown>));
					child.once("error", reject);
					child.once("close", () =>
						reject(new Error("Native replacement actor exited before evidence")),
					);
					timer = setTimeout(() => reject(new Error("Native replacement evidence timeout")), 15000);
				});
				if (failure === "sync-close")
					expect(evidence).toEqual({
						kind: failure,
						refused: true,
						callbackEntered: false,
						otherClientsPhysicallyClosed: true,
						shutdownRefused: true,
					});
				else {
					expect(evidence.publication).toMatchObject({
						outcome: "unavailable",
						restartRequired: true,
						reason: failure === "marker-contradiction" ? "commit-unknown" : "closure-unverified",
					});
					expect(evidence.physicalStillOpen).toBe(failure !== "marker-contradiction");
					expect(evidence.shutdownRefused).toBe(failure !== "marker-contradiction");
				}
				if (failure !== "marker-contradiction")
					await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
				const main = new Database(path, { readonly: true, fileMustExist: true });
				try {
					expect(main.prepare('SELECT username FROM "User"').all()).toEqual([
						{ username: "synthetic-old" },
					]);
					const expectedPhase =
						failure === "sync-close"
							? "running"
							: failure === "marker-contradiction"
								? "restore-pending"
								: "restart-required";
					expect(main.prepare('SELECT phase FROM "RestoreRuntimeControl"').get()).toEqual({
						phase: expectedPhase,
					});
				} finally {
					main.close();
				}
			} finally {
				if (timer) clearTimeout(timer);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
			}
			const owner = await acquireSqliteRestoreRuntimeOwnership(url);
			try {
				expect(await owner.tryAcquireExclusive()).toBe(true);
			} finally {
				await owner.close();
			}
		},
		30000,
	);
});

describe("real SQLite replacement reservation and terminal drain", () => {
	let directory: string;
	let url: string;
	let main: Database.Database;
	let runtime: runtimeOperations.RestoreRuntime;
	const releases: Array<() => void> = [];
	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-restore-replacement-"));
		const path = join(directory, "main.db");
		url = `file:${path}`;
		main = new Database(path);
		main.pragma("journal_mode = WAL");
		main.exec(`CREATE TABLE Marker(value INTEGER); INSERT INTO Marker VALUES(7);
			CREATE TABLE RestoreRuntimeControl (
				id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL, phase TEXT NOT NULL,
				runtimeEpoch TEXT, ownerBackendPid INTEGER, activeRestoreId TEXT,
				lastCommittedRestoreId TEXT, lastCommittedAt DATETIME, destinationInstallationId TEXT);
			CREATE TABLE SqliteRestoreStorageBinding (
				id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL,
				databaseDevice TEXT NOT NULL, databaseInode TEXT NOT NULL,
				directoryDevice TEXT NOT NULL, directoryInode TEXT NOT NULL,
				coordinationDevice TEXT NOT NULL, coordinationInode TEXT NOT NULL,
				ownerDevice TEXT NOT NULL, ownerInode TEXT NOT NULL,
				operationsDevice TEXT NOT NULL, operationsInode TEXT NOT NULL)`);
		chmodSync(path, 0o600);
		runtime = await runtimeOperations.openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination(destinationId);
		await runtime.activate();
	});
	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		// A failed physical close prevents removal of this owned disposable fixture.
		await runtime?.close();
		if (main?.open) main.close();
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	const record = () =>
		main.prepare("SELECT * FROM RestoreRuntimeControl").get() as {
			phase: string;
			activeRestoreId: string | null;
		};
	function barrier() {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.push(release);
		return { promise, release };
	}
	async function healthy() {
		expect(await runtime.runOperation(() => 19)).toBe(19);
		expect(record()).toMatchObject({ phase: "running", activeRestoreId: null });
		expect(main.prepare("SELECT * FROM Marker").all()).toEqual([{ value: 7 }]);
	}
	it("rejects forged preparation before closing healthy ordinary admission", async () => {
		let called = false;
		await expect(async () =>
			runtimeOperations.withRestoreRuntimeReplacement(runtime, {}, async () => {
				called = true;
			}),
		).rejects.toThrow(RestorePreparationError);
		expect(called).toBe(false);
		await healthy();
	});
	it("rejects a foreign destination before closing healthy ordinary admission", async () => {
		const prepared = await prepareRestoreData({
			envelope: await encryptBackupData(
				JSON.stringify({
					version: "1.3",
					appVersion: "2.24.2",
					timestamp: date,
					secrets: { encryptionKey: sourceKey, sessionCookieSecret: "synthetic" },
					data: {
						...Object.fromEntries(
							[...COMPLETE_V1_2_PAYLOAD_FIELDS, ...PORTABLE_SAFETY_PAYLOAD_FIELDS].map((field) => [
								field,
								[],
							]),
						),
						users: [],
						sessions: [],
						serviceInstances: [],
						serviceTags: [],
						serviceInstanceTags: [],
						oidcAccounts: [],
						webAuthnCredentials: [],
					},
				}),
				"synthetic-backup-password",
			),
			password: "synthetic-backup-password",
			destination: {
				encryptor: destination,
				installationId: "other-destination",
				stableForRestart: true,
			},
		});
		await expect(async () =>
			runtimeOperations.withRestoreRuntimeReplacement(runtime, prepared, async () => 0),
		).rejects.toThrow(BackupCompatibilityError);
		await healthy();
	});
	it("rejects an ordinary-ticket controller invocation without self-draining", async () => {
		const prepared = await prepare();
		await expect(
			runtime.runOperation(() =>
				runtimeOperations.withRestoreRuntimeReplacement(runtime, prepared, async () => 0),
			),
		).rejects.toThrow(runtimeOperations.RestoreRuntimeAdmissionError);
		await healthy();
	});
	it("joins accepted nested native SQL and closes the shared client before exclusive pending publication", async () => {
		const prepared = await prepare();
		const accepted = barrier(),
			finish = barrier();
		const client = createRuntimePrismaClient(runtime);
		const work = runtime.runOperation(async () => {
			expect(
				await client.prisma.$queryRawUnsafe("SELECT CAST(value AS TEXT) AS value FROM Marker"),
			).toEqual([{ value: "7" }]);
			accepted.release();
			await finish.promise;
			return runtime.runOperation(() =>
				client.prisma.$queryRawUnsafe("SELECT CAST(value AS TEXT) AS value FROM Marker"),
			);
		});
		void work.catch(() => accepted.release());
		await accepted.promise;
		let called = false;
		let issued: unknown;
		const replacement = runtimeOperations.withRestoreRuntimeReplacement(
			runtime,
			prepared,
			async (scope) => {
				called = true;
				issued = scope;
				const context = runtimeOperations.getRestoreRuntimeReplacementClientContext(scope);
				expect(record()).toMatchObject({
					phase: "restore-pending",
					activeRestoreId: context.restoreId,
				});
				await expect(acquireSqliteRestoreOperationLock(url)).rejects.toBeDefined();
				return 23;
			},
		);
		await expect(runtime.runOperation(() => 0)).rejects.toThrow(
			runtimeOperations.RestoreRuntimeAdmissionError,
		);
		expect(called).toBe(false);
		finish.release();
		expect(await work).toEqual([{ value: "7" }]);
		expect(await replacement).toBe(23);
		expect(called).toBe(true);
		expect(() => runtimeOperations.getRestoreRuntimeReplacementClientContext(issued)).toThrow(
			runtimeOperations.RestoreRuntimeAdmissionError,
		);
		await expect(runtime.runOperation(() => 0)).rejects.toThrow(
			runtimeOperations.RestoreRuntimeAdmissionError,
		);
		expect(main.prepare("SELECT * FROM Marker").all()).toEqual([{ value: 7 }]);
	});
	it("reserves once and makes shutdown join the active controller", async () => {
		const prepared = await prepare();
		const entered = barrier(),
			finish = barrier();
		const replacement = runtimeOperations.withRestoreRuntimeReplacement(
			runtime,
			prepared,
			async () => {
				entered.release();
				await finish.promise;
				return 31;
			},
		);
		await entered.promise;
		await expect(
			runtimeOperations.withRestoreRuntimeReplacement(runtime, prepared, async () => 0),
		).rejects.toThrow(runtimeOperations.RestoreRuntimeAdmissionError);
		let closed = false;
		const closing = runtime.close().then(() => {
			closed = true;
		});
		await expect(runtime.runOperation(() => 0)).rejects.toThrow(
			runtimeOperations.RestoreRuntimeAdmissionError,
		);
		expect(closed).toBe(false);
		finish.release();
		expect(await replacement).toBe(31);
		await closing;
		expect(closed).toBe(true);
	});
	it.each(["legacy", "cloned"])(
		"refuses %s preparation without interrupting healthy work",
		async (kind) => {
			const prepared = await prepare(kind === "legacy" ? "1.2" : "1.3");
			await expect(
				runtimeOperations.withRestoreRuntimeReplacement(
					runtime,
					kind === "cloned" ? { ...prepared } : prepared,
					async () => 0,
				),
			).rejects.toThrow(kind === "cloned" ? RestorePreparationError : BackupCompatibilityError);
			await healthy();
		},
	);
	it("refuses cloned scopes and fences already captured context after callback completion", async () => {
		const prepared = await prepare();
		let context!: ReturnType<typeof runtimeOperations.getRestoreRuntimeReplacementClientContext>;
		const later = barrier();
		let escaped!: Promise<void>;
		await runtimeOperations.withRestoreRuntimeReplacement(runtime, prepared, async (scope) => {
			expect(() =>
				runtimeOperations.getRestoreRuntimeReplacementClientContext({ ...scope }),
			).toThrow(runtimeOperations.RestoreRuntimeAdmissionError);
			context = runtimeOperations.getRestoreRuntimeReplacementClientContext(scope);
			context.assertTicket();
			escaped = later.promise.then(() => context.assertTicket());
		});
		expect(() => context.assertTicket()).toThrow(runtimeOperations.RestoreRuntimeAdmissionError);
		later.release();
		await expect(escaped).rejects.toThrow(runtimeOperations.RestoreRuntimeAdmissionError);
	});
	it("rejects shutdown from its own replacement callback without self-draining", async () => {
		const prepared = await prepare();
		expect(
			await runtimeOperations.withRestoreRuntimeReplacement(runtime, prepared, async () => {
				await expect(runtime.close()).rejects.toThrow(
					runtimeOperations.RestoreRuntimeAdmissionError,
				);
				return 41;
			}),
		).toBe(41);
		await runtime.close();
	});
	it("a shutdown during drain refuses publication and joins the accepted operation", async () => {
		const prepared = await prepare();
		const entered = barrier(),
			finish = barrier();
		const work = runtime.runOperation(async () => {
			entered.release();
			await finish.promise;
			return runtime.runOperation(() => 43);
		});
		await entered.promise;
		let called = false;
		const replacement = runtimeOperations.withRestoreRuntimeReplacement(
			runtime,
			prepared,
			async () => {
				called = true;
			},
		);
		const refused = expect(replacement).rejects.toThrow(
			runtimeOperations.RestoreRuntimeAdmissionError,
		);
		const closing = runtime.close();
		finish.release();
		expect(await work).toBe(43);
		await refused;
		await closing;
		expect(called).toBe(false);
		expect(record()).toMatchObject({ phase: "running", activeRestoreId: null });
	});
	it("does not persist pending while an actual shared follower remains physically open", async () => {
		const prepared = await prepare();
		const follower = await acquireSqliteRestoreOperationLock(url);
		try {
			await expect(
				runtimeOperations.withRestoreRuntimeReplacement(runtime, prepared, async () => 0),
			).rejects.toThrow(runtimeOperations.RestoreRuntimeAdmissionError);
			await follower.assertHeld();
			expect(record()).toMatchObject({ phase: "running", activeRestoreId: null });
			expect(main.prepare("SELECT * FROM Marker").all()).toEqual([{ value: 7 }]);
			await expect(runtime.runOperation(() => 0)).rejects.toThrow(
				runtimeOperations.RestoreRuntimeAdmissionError,
			);
		} finally {
			await follower.close();
		}
	});
	it("retained producer completion remains part of the physical drain after parent completion", async () => {
		const prepared = await prepare();
		let producer!: runtimeOperations.RetainedRestoreRuntimeOperation;
		await runtime.runOperation(async () => {
			producer = runtimeOperations.retainRestoreRuntimeOperation()!;
		});
		let called = false;
		const replacement = runtimeOperations.withRestoreRuntimeReplacement(
			runtime,
			prepared,
			async () => {
				called = true;
				return 47;
			},
		);
		await expect(runtime.runOperation(() => 0)).rejects.toThrow(
			runtimeOperations.RestoreRuntimeAdmissionError,
		);
		expect(called).toBe(false);
		expect(await producer.run(() => runtime.runOperation(() => 49))).toBe(49);
		await producer.release();
		expect(await replacement).toBe(47);
		expect(called).toBe(true);
	});
});
