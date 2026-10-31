import { fork, spawn } from "node:child_process";
import { join } from "node:path";
import type { BackupData } from "@arr/shared";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { BackupCompatibilityError } from "../../errors.js";
import { importConnectionFingerprint } from "../../queue-cleaner/import-receipt.js";
import { encryptBackupData } from "../backup-crypto.js";
import { exportDatabase } from "../backup-database.js";
import { PORTABLE_SAFETY_PAYLOAD_FIELDS } from "../backup-portability.js";
import { prepareRestoreData, RestorePreparationError } from "../backup-restore-preparation.js";
import { COMPLETE_V1_2_PAYLOAD_FIELDS } from "../backup-validation.js";
import {
	getRestoreRuntimeReplacementClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
	RestoreRuntimeAdmissionError,
	withRestoreRuntimeReplacement,
} from "../restore-runtime-admission.js";
import {
	createRuntimePrismaClient,
	createRuntimeReplacementPrismaClient,
} from "../restore-runtime-client.js";
import { acquirePostgresRestoreRuntimeOwnership } from "../restore-runtime-postgres.js";
import { publishPreparedRestore } from "../restore-runtime-replacement.js";
import { writeRestoreRuntimeCommit } from "../restore-runtime-repository.js";
import { classifyRestoreRuntimeRecovery } from "../restore-runtime-state.js";
import {
	preparePublicationCredentialFixture,
	publicationCredentialColumns,
} from "./fixtures/restore-runtime-replacement-actor.js";

const identity = "synthetic-destination";
async function prepare(destinationIdentity = identity) {
	const backup: BackupData = {
		version: "1.3",
		appVersion: "2.24.2",
		timestamp: "2026-10-09T00:00:00.000Z",
		secrets: { encryptionKey: "53".repeat(32), sessionCookieSecret: "synthetic-source-cookie" },
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
	};
	return prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(backup), "synthetic-backup-password"),
		password: "synthetic-backup-password",
		destination: {
			encryptor: new Encryptor("64".repeat(32)),
			installationId: destinationIdentity,
			stableForRestart: true,
		},
	});
}

describe("real PostgreSQL replacement reservation and terminal drain", () => {
	let fixture: Client;
	let runtime: RestoreRuntime;
	let ordinary: ReturnType<typeof createRuntimePrismaClient> | undefined;
	const destination = new Encryptor("64".repeat(32));
	const source = new Encryptor("53".repeat(32));
	const releases: Array<() => void> = [];
	beforeEach(async () => {
		ordinary = undefined;
		const url = process.env.RESTORE_RUNTIME_TEST_PG_URL;
		if (!url) throw new Error("Owned loopback PostgreSQL fixture required");
		const parsed = new URL(url);
		if (
			parsed.hostname !== "127.0.0.1" ||
			!parsed.pathname.endsWith("_test") ||
			parsed.search ||
			parsed.hash
		)
			throw new Error("Owned loopback PostgreSQL fixture required");
		fixture = new Client({ connectionString: url });
		await fixture.connect();
		await fixture.query('DELETE FROM "User"');
		await fixture.query('DELETE FROM "RestoreRuntimeControl"');
		await fixture.query(
			'INSERT INTO "RestoreRuntimeControl" (id,"protocolVersion",phase) VALUES(1,1,\'idle\')',
		);
		await fixture.query(
			'CREATE TABLE IF NOT EXISTS "RestorePublicationFixture" (value INTEGER NOT NULL)',
		);
		await fixture.query('DELETE FROM "RestorePublicationFixture"');
		await fixture.query('INSERT INTO "RestorePublicationFixture" VALUES(7)');
		runtime = await openRestoreRuntime({ databaseUrl: url });
		await runtime.bindDestination(identity);
		await runtime.activate();
	});
	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		await ordinary?.close();
		await runtime?.close();
		await fixture.query(`DROP TRIGGER IF EXISTS reject_restored ON "User";
			DROP TRIGGER IF EXISTS reject_marker ON "RestoreRuntimeControl";
			DROP TRIGGER IF EXISTS reject_commit ON "RestoreRuntimeControl";
			DROP FUNCTION IF EXISTS publication_refusal();
			DROP FUNCTION IF EXISTS publication_marker_refusal();
			DROP FUNCTION IF EXISTS publication_commit_refusal();
			DROP TABLE IF EXISTS "PublicationDeferredFailure";
			DROP TABLE IF EXISTS "PublicationRequiredParent"`);
		await fixture.query(
			'DELETE FROM "oidc_providers" WHERE id=1; DELETE FROM "backup_settings" WHERE id=1; DELETE FROM "vapid_keys" WHERE id=1',
		);
		await fixture?.end();
	});
	function barrier() {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => {
			release = resolve;
		});
		releases.push(release);
		return { promise, release };
	}
	async function record() {
		return (await fixture.query('SELECT * FROM "RestoreRuntimeControl"')).rows[0];
	}
	async function sharedCount() {
		return Number(
			(
				await fixture.query(
					"SELECT COUNT(*) AS count FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=1095914052::oid AND objid=2::oid AND objsubid=2 AND granted AND mode='ShareLock'",
				)
			).rows[0]?.count,
		);
	}
	async function healthy() {
		expect(await runtime.runOperation(() => 19)).toBe(19);
		expect(await record()).toMatchObject({ phase: "running", activeRestoreId: null });
		expect((await fixture.query('SELECT * FROM "RestorePublicationFixture"')).rows).toEqual([
			{ value: 7 },
		]);
	}
	async function preparedReplacement() {
		ordinary = createRuntimePrismaClient(runtime);
		await runtime.runOperation(async () => {
			const old = destination.encrypt("synthetic-old-provider-key");
			await ordinary!.prisma.user.create({
				data: {
					id: "publication-owner",
					username: "synthetic-old",
					encryptedTmdbApiKey: old.value,
					tmdbEncryptionIv: old.iv,
				},
			});
			await ordinary!.prisma.session.create({
				data: {
					id: "destination-session",
					userId: "publication-owner",
					expiresAt: new Date("2030-01-01T00:00:00.000Z"),
				},
			});
		});
		const records = await runtime.runOperation(() => exportDatabase(ordinary!.prisma));
		const translated = source.encrypt("synthetic-restored-provider-key");
		records.users[0]!.username = "synthetic-restored";
		records.users[0]!.encryptedTmdbApiKey = translated.value;
		records.users[0]!.tmdbEncryptionIv = translated.iv;
		const backup: BackupData = {
			version: "1.3",
			appVersion: "2.24.2",
			timestamp: "2026-10-09T00:00:00.000Z",
			data: records,
			secrets: { encryptionKey: "53".repeat(32), sessionCookieSecret: "synthetic-source-cookie" },
		};
		return prepareRestoreData({
			envelope: await encryptBackupData(JSON.stringify(backup), "synthetic-backup-password"),
			password: "synthetic-backup-password",
			destination: { encryptor: destination, installationId: identity, stableForRestart: true },
		});
	}
	async function assertOldRowsPreserved() {
		const rows = (
			await fixture.query('SELECT username, "encryptedTmdbApiKey", "tmdbEncryptionIv" FROM "User"')
		).rows;
		expect(rows).toHaveLength(1);
		expect(rows[0].username).toBe("synthetic-old");
		expect(
			destination.decrypt({ value: rows[0].encryptedTmdbApiKey, iv: rows[0].tmdbEncryptionIv }),
		).toBe("synthetic-old-provider-key");
		expect((await fixture.query('SELECT id FROM "sessions"')).rows).toEqual([
			{ id: "destination-session" },
		]);
	}
	it("rejects forged preparation before closing healthy ordinary admission", async () => {
		await expect(withRestoreRuntimeReplacement(runtime, {}, async () => 0)).rejects.toThrow(
			RestorePreparationError,
		);
		await healthy();
	});
	it("rejects destination mismatch before maintenance", async () => {
		await expect(
			withRestoreRuntimeReplacement(runtime, await prepare("other-destination"), async () => 0),
		).rejects.toThrow(BackupCompatibilityError);
		await healthy();
	});
	it("rejects controller self-drain inside an ordinary ticket", async () => {
		const prepared = await prepare();
		await expect(
			runtime.runOperation(() => withRestoreRuntimeReplacement(runtime, prepared, async () => 0)),
		).rejects.toThrow(RestoreRuntimeAdmissionError);
		await healthy();
	});
	it("joins in-flight admission ownership SQL before draining a fenced runtime", async () => {
		const entered = barrier(),
			finish = barrier();
		const original = Client.prototype.query;
		let armed = true,
			operationCalled = false,
			drained = false;
		const query = vi.spyOn(Client.prototype, "query").mockImplementation(function (
			this: Client,
			...args: unknown[]
		) {
			const result = Reflect.apply(original, this, args);
			if (
				armed &&
				typeof args[0] === "string" &&
				args[0].includes("pg_try_advisory_xact_lock_shared(")
			) {
				armed = false;
				return result.then(async (value: { rows: Array<{ acquired: boolean }> }) => {
					expect(value.rows[0]?.acquired).toBe(true);
					entered.release();
					await finish.promise;
					return value;
				});
			}
			return result;
		});
		const admission = runtime.runIndependentOperation(() => {
			operationCalled = true;
			return 17;
		});
		void admission.catch(() => {});
		let draining: Promise<void> | undefined;
		try {
			await entered.promise;
			runtime.closeAdmission();
			draining = runtime.drain().then(() => {
				drained = true;
			});
			expect(await sharedCount()).toBe(1);
			expect(drained, "real shared ownership-check transaction remains physically in flight").toBe(
				false,
			);
			expect(operationCalled).toBe(false);
		} finally {
			finish.release();
			await expect(admission).rejects.toThrow(RestoreRuntimeAdmissionError);
			await draining;
			query.mockRestore();
		}
		expect(drained).toBe(true);
		expect(operationCalled).toBe(false);
		expect(await sharedCount()).toBe(0);
	});
	it("joins accepted nested SQL and physical shared-pool closure before durable pending", async () => {
		const prepared = await prepare();
		const client = createRuntimePrismaClient(runtime);
		const entered = barrier(),
			finish = barrier();
		const work = runtime.runOperation(async () => {
			expect(
				await client.prisma.$queryRawUnsafe('SELECT value FROM "RestorePublicationFixture"'),
			).toEqual([{ value: 7 }]);
			entered.release();
			await finish.promise;
			return runtime.runOperation(() =>
				client.prisma.$queryRawUnsafe('SELECT value FROM "RestorePublicationFixture"'),
			);
		});
		void work.catch(() => entered.release());
		await entered.promise;
		// One physical ordinary-pool session and the separate accepted-operation
		// participant must both drain before the replacement can become pending.
		expect(await sharedCount()).toBe(2);
		let called = false;
		const replacement = withRestoreRuntimeReplacement(runtime, prepared, async (scope) => {
			called = true;
			const context = getRestoreRuntimeReplacementClientContext(scope);
			await context.assertOwned();
			await context.assertCurrentPostgresRecord();
			expect(await record()).toMatchObject({
				phase: "restore-pending",
				activeRestoreId: context.restoreId,
			});
			expect(await sharedCount()).toBe(0);
			return 23;
		});
		await expect(runtime.runOperation(() => 0)).rejects.toThrow(RestoreRuntimeAdmissionError);
		expect(called).toBe(false);
		finish.release();
		expect(await work).toEqual([{ value: 7 }]);
		expect(await replacement).toBe(23);
		await expect(runtime.runOperation(() => 0)).rejects.toThrow(RestoreRuntimeAdmissionError);
	});
	it("reserves once and shutdown waits for the controller without granting new work", async () => {
		const prepared = await prepare();
		const entered = barrier(),
			finish = barrier();
		const replacement = withRestoreRuntimeReplacement(runtime, prepared, async () => {
			entered.release();
			await finish.promise;
			return 31;
		});
		await entered.promise;
		await expect(withRestoreRuntimeReplacement(runtime, prepared, async () => 0)).rejects.toThrow(
			RestoreRuntimeAdmissionError,
		);
		let closed = false;
		const closing = runtime.close().then(() => {
			closed = true;
		});
		await expect(runtime.runOperation(() => 0)).rejects.toThrow(RestoreRuntimeAdmissionError);
		expect(closed).toBe(false);
		finish.release();
		expect(await replacement).toBe(31);
		await closing;
		expect(closed).toBe(true);
	});
	it("rejects cloned and escaped replacement authority", async () => {
		const prepared = await prepare();
		let context!: ReturnType<typeof getRestoreRuntimeReplacementClientContext>;
		const later = barrier();
		let escaped!: Promise<void>;
		await withRestoreRuntimeReplacement(runtime, prepared, async (scope) => {
			expect(() => getRestoreRuntimeReplacementClientContext({ ...scope })).toThrow(
				RestoreRuntimeAdmissionError,
			);
			context = getRestoreRuntimeReplacementClientContext(scope);
			escaped = later.promise.then(() => context.assertTicket());
		});
		expect(() => context.assertTicket()).toThrow(RestoreRuntimeAdmissionError);
		later.release();
		await expect(escaped).rejects.toThrow(RestoreRuntimeAdmissionError);
	});
	it("publishes actual populated rows, destination-key credentials and revoked sessions with one positive marker", async () => {
		const prepared = await preparedReplacement();
		expect(prepared.records.sessions).toEqual([]);
		const result = await publishPreparedRestore({ runtime, prepared });
		expect(result).toMatchObject({ outcome: "committed", restartRequired: true, reason: null });
		const row = (
			await fixture.query(
				'SELECT username, "encryptedTmdbApiKey", "tmdbEncryptionIv" FROM "User" WHERE id=$1',
				["publication-owner"],
			)
		).rows[0];
		expect(row.username).toBe("synthetic-restored");
		expect(destination.decrypt({ value: row.encryptedTmdbApiKey, iv: row.tmdbEncryptionIv })).toBe(
			"synthetic-restored-provider-key",
		);
		expect(
			Number((await fixture.query('SELECT COUNT(*) AS count FROM "sessions"')).rows[0]?.count),
		).toBe(0);
		expect(await record()).toMatchObject({
			phase: "restart-required",
			activeRestoreId: result.restoreId,
			lastCommittedRestoreId: result.restoreId,
		});
		expect(await sharedCount()).toBe(0);
		await expect(runtime.runOperation(() => 0)).rejects.toThrow(RestoreRuntimeAdmissionError);
	});
	it("queued shutdown joins actual PostgreSQL publication and server backend closure", async () => {
		await preparedReplacement();
		const prepared = await preparePublicationCredentialFixture(runtime, ordinary!.prisma, true);
		const inserted = barrier(),
			resume = barrier();
		const connect = PrismaPg.prototype.connect;
		const spy = vi.spyOn(PrismaPg.prototype, "connect").mockImplementation(async function (
			this: PrismaPg,
		) {
			const driver = await connect.call(this);
			const start = driver.startTransaction.bind(driver);
			driver.startTransaction = async (...args) => {
				const transaction = await start(...args);
				const query = transaction.queryRaw.bind(transaction);
				const execute = transaction.executeRaw.bind(transaction);
				const pause = async <T>(sql: string, result: T): Promise<T> => {
					if (/^\s*INSERT\s+INTO\s+(?:"[^"\n]+"\.)?"User"\s/i.test(sql)) {
						inserted.release();
						await resume.promise;
					}
					return result;
				};
				transaction.queryRaw = async (request) => pause(request.sql, await query(request));
				transaction.executeRaw = async (request) => pause(request.sql, await execute(request));
				return transaction;
			};
			return driver;
		});
		let publicationSettled = false,
			shutdownSettled = false;
		const publishing = publishPreparedRestore({ runtime, prepared }).finally(() => {
			publicationSettled = true;
		});
		void publishing.catch(() => inserted.release());
		let closing: Promise<void> | undefined;
		try {
			await Promise.race([
				inserted.promise,
				publishing.then(() => {
					throw new Error("Actual PostgreSQL INSERT barrier was not reached");
				}),
			]);
			const pending = await record();
			const participants = (
				await fixture.query(
					"SELECT l.pid, a.state FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND l.classid=1095914052::oid AND l.objid=2::oid AND l.objsubid=2 AND l.granted AND l.mode='ExclusiveLock'",
				)
			).rows;
			expect(participants).toHaveLength(1);
			expect(participants[0].state).toBe("idle in transaction");
			expect(participants[0].pid).not.toBe(pending.ownerBackendPid);
			const retainedPids = [pending.ownerBackendPid, participants[0].pid];
			closing = runtime.close().then(() => {
				shutdownSettled = true;
			});
			void closing.catch(() => {});
			await expect(runtime.runOperation(() => 0)).rejects.toThrow(RestoreRuntimeAdmissionError);
			await expect(
				acquirePostgresRestoreRuntimeOwnership(process.env.RESTORE_RUNTIME_TEST_PG_URL!),
			).rejects.toThrow();
			expect(publicationSettled).toBe(false);
			expect(shutdownSettled).toBe(false);
			expect((await fixture.query('SELECT username FROM "User"')).rows).toEqual([
				{ username: "synthetic-old" },
			]);
			expect(
				Number((await fixture.query('SELECT COUNT(*) AS count FROM "sessions"')).rows[0]?.count),
			).toBe(1);
			expect(pending).toMatchObject({ phase: "restore-pending", lastCommittedRestoreId: null });
			expect(
				Number(
					(
						await fixture.query(
							"SELECT COUNT(*) AS count FROM pg_stat_activity WHERE pid=ANY($1::int[])",
							[retainedPids],
						)
					).rows[0]?.count,
				),
			).toBe(2);
			resume.release();
			const result = await publishing;
			expect(result).toMatchObject({ outcome: "committed", restartRequired: true, reason: null });
			await closing;
			expect(shutdownSettled).toBe(true);
			expect(
				Number(
					(
						await fixture.query(
							"SELECT COUNT(*) AS count FROM pg_stat_activity WHERE pid=ANY($1::int[])",
							[retainedPids],
						)
					).rows[0]?.count,
				),
			).toBe(0);
			const fresh = await acquirePostgresRestoreRuntimeOwnership(
				process.env.RESTORE_RUNTIME_TEST_PG_URL!,
			);
			try {
				expect(await fresh.tryAcquireExclusive()).toBe(true);
			} finally {
				await fresh.close();
			}
			for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
				const rows = (
					await fixture.query(
						'SELECT "' + value + '" AS value, "' + iv + '" AS iv FROM "' + table + '"',
					)
				).rows;
				expect(rows).toHaveLength(1);
				expect(destination.decrypt(rows[0])).toBe(plaintext);
			}
			expect((await fixture.query('SELECT username FROM "User"')).rows).toEqual([
				{ username: "synthetic-restored" },
			]);
			expect(
				Number((await fixture.query('SELECT COUNT(*) AS count FROM "sessions"')).rows[0]?.count),
			).toBe(0);
			expect(await record()).toMatchObject({
				phase: "restart-required",
				lastCommittedRestoreId: result.restoreId,
			});
			expect(
				(await fixture.query('SELECT id,state FROM "queue_cleaner_import_receipts"')).rows,
			).toEqual([{ id: "credential-receipt", state: "unknown" }]);
		} finally {
			resume.release();
			await Promise.allSettled([publishing, ...(closing ? [closing] : [])]);
			spy.mockRestore();
		}
	}, 30000);
	it.each(["insert-failure", "marker-cas-loss", "commit-failure"])(
		"rolls back rows, credentials, sessions and marker after %s",
		async (failure) => {
			const prepared = await preparedReplacement();
			if (failure === "insert-failure")
				await fixture.query(`CREATE FUNCTION publication_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN IF NEW.username='synthetic-restored' THEN RAISE EXCEPTION 'synthetic refusal'; END IF; RETURN NEW; END $$;
				CREATE TRIGGER reject_restored BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION publication_refusal()`);
			else if (failure === "marker-cas-loss")
				await fixture.query(`CREATE FUNCTION publication_marker_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN IF NEW.phase='restart-required' THEN RETURN NULL; END IF; RETURN NEW; END $$;
				CREATE TRIGGER reject_marker BEFORE UPDATE ON "RestoreRuntimeControl" FOR EACH ROW EXECUTE FUNCTION publication_marker_refusal()`);
			else
				await fixture.query(`CREATE TABLE "PublicationRequiredParent"(id INTEGER PRIMARY KEY);
				CREATE TABLE "PublicationDeferredFailure"("parentId" INTEGER REFERENCES "PublicationRequiredParent"(id) DEFERRABLE INITIALLY DEFERRED);
				CREATE FUNCTION publication_commit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN IF NEW.phase='restart-required' THEN INSERT INTO "PublicationDeferredFailure" VALUES(1); END IF; RETURN NEW; END $$;
				CREATE TRIGGER reject_commit AFTER UPDATE ON "RestoreRuntimeControl" FOR EACH ROW EXECUTE FUNCTION publication_commit_refusal()`);
			const result = await publishPreparedRestore({ runtime, prepared });
			expect(result).toMatchObject({
				outcome: "not-committed",
				restartRequired: true,
				reason: "state-changed",
			});
			await assertOldRowsPreserved();
			expect(await record()).toMatchObject({
				phase: "restore-pending",
				activeRestoreId: result.restoreId,
				lastCommittedRestoreId: null,
				lastCommittedAt: null,
			});
			if (failure === "commit-failure")
				expect((await fixture.query('SELECT * FROM "PublicationDeferredFailure"')).rows).toEqual(
					[],
				);
			expect(await sharedCount()).toBe(0);
			await expect(runtime.runOperation(() => 0)).rejects.toThrow(RestoreRuntimeAdmissionError);
		},
	);
	it("fences application SQL after the transaction writes its positive marker", async () => {
		const prepared = await preparedReplacement();
		await expect(
			withRestoreRuntimeReplacement(runtime, prepared, async (scope) => {
				const context = getRestoreRuntimeReplacementClientContext(scope);
				const writer = createRuntimeReplacementPrismaClient(scope);
				await writer.prisma.$transaction(async (tx) => {
					await writeRestoreRuntimeCommit(tx, context.commitRequest);
					await tx.user.count();
				});
			}),
		).rejects.toThrow();
		await assertOldRowsPreserved();
		expect(await record()).toMatchObject({
			phase: "restore-pending",
			lastCommittedRestoreId: null,
		});
	});
	it("allows only one writer and rejects escaped native clients instead of reconnecting", async () => {
		const prepared = await preparedReplacement();
		const writer = await withRestoreRuntimeReplacement(runtime, prepared, async (scope) => {
			const active = createRuntimeReplacementPrismaClient(scope);
			expect(() => createRuntimeReplacementPrismaClient(scope)).toThrow(
				RestoreRuntimeAdmissionError,
			);
			expect(await active.prisma.user.count()).toBe(1);
			return active;
		});
		await expect(writer.prisma.user.count()).rejects.toThrow();
		await assertOldRowsPreserved();
	});
	it("refuses a stale preparation rather than deleting an import hold added before reservation", async () => {
		const prepared = await preparedReplacement();
		await runtime.runOperation(async () => {
			const credential = destination.encrypt("synthetic-late-provider-key");
			const instance = await ordinary!.prisma.serviceInstance.create({
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
			await ordinary!.prisma.queueCleanerImportReceipt.create({
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
					lastAttemptAt: new Date("2026-10-09T00:00:00.000Z"),
				},
			});
		});
		const holds = (await fixture.query('SELECT * FROM "queue_cleaner_import_receipts"')).rows;
		const instances = (await fixture.query('SELECT * FROM "ServiceInstance"')).rows;
		const result = await publishPreparedRestore({ runtime, prepared });
		expect(result).toMatchObject({ outcome: "not-committed", reason: "state-changed" });
		expect((await fixture.query('SELECT * FROM "queue_cleaner_import_receipts"')).rows).toEqual(
			holds,
		);
		expect((await fixture.query('SELECT * FROM "ServiceInstance"')).rows).toEqual(instances);
		await assertOldRowsPreserved();
		expect(await record()).toMatchObject({
			phase: "restore-pending",
			lastCommittedRestoreId: null,
		});
	});
	it.each([
		["crash-before-pending", "running", "no-pending-restore", false],
		["crash-after-pending", "restore-pending", "not-committed", false],
		["crash-before-commit", "restore-pending", "not-committed", false],
		["crash-after-commit", "restart-required", "committed", true],
	] as const)(
		"recovers a real publisher after %s without replay or lost holds",
		async (stage, phase, category, committed) => {
			await preparedReplacement();
			await preparePublicationCredentialFixture(runtime, ordinary!.prisma, true);
			await ordinary!.close();
			await runtime.close();
			const actorFile = process.env.POSTGRES_RESTORE_REPLACEMENT_ACTOR_FILE;
			if (!actorFile) throw new Error("Compiled current PostgreSQL replacement actor required");
			const tables = [
				"User",
				"ServiceInstance",
				"sessions",
				"queue_cleaner_import_receipts",
				"arr_import_operations",
				"arr_import_source_claims",
				"arr_import_file_proofs",
			];
			const snapshot = async () =>
				Object.fromEntries(
					await Promise.all(
						tables.map(async (table) => [
							table,
							(await fixture.query(`SELECT * FROM "${table}"`)).rows,
						]),
					),
				);
			const before = await snapshot();
			const url = process.env.RESTORE_RUNTIME_TEST_PG_URL!;
			const env = Object.fromEntries(
				["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
					process.env[key] ? [[key, process.env[key]]] : [],
				),
			);
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
					child.once("close", () =>
						reject(new Error("PostgreSQL publisher exited before crash barrier")),
					);
					timer = setTimeout(() => reject(new Error("PostgreSQL crash barrier timeout")), 15000);
				});
				expect(barrier).toEqual({ kind: "publication-crash-barrier", stage });
				await expect(acquirePostgresRestoreRuntimeOwnership(url)).rejects.toThrow();
				expect(await record()).toMatchObject({ phase });
				const actors: number[] = (
					await fixture.query(
						"SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
					)
				).rows.map((row) => row.pid);
				expect(actors.length).toBeGreaterThan(0);
				child.kill("SIGKILL");
				expect(await closed).toEqual({ code: null, signal: "SIGKILL" });
				// Process closure alone is not a server-side backend-end receipt.
				await expect
					.poll(
						async () =>
							Number(
								(
									await fixture.query(
										"SELECT COUNT(*) AS count FROM pg_stat_activity WHERE pid=ANY($1::int[])",
										[actors],
									)
								).rows[0].count,
							),
						{ timeout: 5000 },
					)
					.toBe(0);
				const owner = await acquirePostgresRestoreRuntimeOwnership(url);
				let deadRecord: Awaited<ReturnType<typeof record>>;
				try {
					expect(await owner.tryAcquireExclusive()).toBe(true);
					deadRecord = await record();
					expect(classifyRestoreRuntimeRecovery(deadRecord, identity)).toBe(category);
				} finally {
					await owner.close();
				}
				const afterCrash = await snapshot();
				if (!committed) expect(afterCrash).toEqual(before);
				expect((await fixture.query('SELECT username FROM "User"')).rows).toEqual([
					{ username: committed ? "synthetic-restored" : "synthetic-old" },
				]);
				expect(
					Number((await fixture.query('SELECT COUNT(*) AS count FROM "sessions"')).rows[0].count),
				).toBe(committed ? 0 : 1);
				expect(
					(
						await fixture.query(
							'SELECT id, state, "commandId" FROM "queue_cleaner_import_receipts"',
						)
					).rows,
				).toEqual([{ id: "credential-receipt", state: "unknown", commandId: 42 }]);
				expect(
					(await fixture.query('SELECT id, "activeOperationId" FROM "arr_import_source_claims"'))
						.rows,
				).toEqual([{ id: "credential-claim", activeOperationId: "credential-operation" }]);
				runtime = await openRestoreRuntime({ databaseUrl: url });
				await runtime.bindDestination(identity);
				await runtime.activate();
				ordinary = createRuntimePrismaClient(runtime);
				expect(await runtime.runOperation(() => ordinary!.prisma.user.count())).toBe(1);
				expect(await snapshot()).toEqual(afterCrash);
				const recovered = await record();
				expect(recovered).toMatchObject({
					phase: "running",
					activeRestoreId: null,
					lastCommittedRestoreId: deadRecord.lastCommittedRestoreId,
					lastCommittedAt: deadRecord.lastCommittedAt,
					destinationInstallationId: identity,
				});
				expect(recovered.runtimeEpoch).not.toBe(deadRecord.runtimeEpoch);
			} finally {
				if (timer) clearTimeout(timer);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
			}
		},
		30000,
	);
	it.each([
		"lost-commit-result",
		"postgres-writer-close-throw",
		"postgres-writer-close-false-ack",
	] as const)(
		"reconciles actual PostgreSQL publication after %s only from physical evidence",
		async (stage) => {
			await preparedReplacement();
			await preparePublicationCredentialFixture(runtime, ordinary!.prisma, true);
			await ordinary!.close();
			await runtime.close();
			const actorFile = process.env.POSTGRES_RESTORE_REPLACEMENT_ACTOR_FILE;
			if (!actorFile) throw new Error("Compiled current PostgreSQL replacement actor required");
			const url = process.env.RESTORE_RUNTIME_TEST_PG_URL!;
			const env = Object.fromEntries(
				["PATH", "LANG", "LC_ALL", "TZ", "LOG_DIR"].flatMap((key) =>
					process.env[key] ? [[key, process.env[key]]] : [],
				),
			);
			const child = fork(actorFile, [url, stage], {
				env,
				stdio: ["ignore", "ignore", "ignore", "ipc"],
			});
			const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
			const queued: unknown[] = [];
			let receive: ((value: unknown) => void) | undefined;
			child.on("message", (value) => {
				if (receive) receive(value);
				else queued.push(value);
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			const message = () =>
				new Promise<unknown>((resolve, reject) => {
					if (queued.length) return resolve(queued.shift());
					receive = (value) => {
						receive = undefined;
						if (timer) clearTimeout(timer);
						resolve(value);
					};
					child.once("error", reject);
					child.once("close", () => reject(new Error("Publisher exited before physical evidence")));
					timer = setTimeout(() => reject(new Error("Native publication evidence timeout")), 15000);
				});
			try {
				if (stage === "lost-commit-result") {
					expect(await message()).toMatchObject({
						kind: "publication-native-result",
						stage,
						publication: { outcome: "committed", reason: null },
						nativeCommitCount: 1,
						shutdownRefused: false,
					});
				} else {
					expect(await message()).toEqual({ kind: "publication-native-close-entered", stage });
					if (stage === "postgres-writer-close-throw")
						expect(await message()).toMatchObject({
							kind: "publication-native-result",
							stage,
							shutdownRefused: true,
							publication: { outcome: "unavailable", reason: "closure-unverified" },
						});
					else {
						child.send({ kind: "inspect-publication" });
						expect(await message()).toEqual({
							kind: "publication-settlement",
							publicationSettled: false,
						});
					}
					await expect(acquirePostgresRestoreRuntimeOwnership(url)).rejects.toThrow();
					const ownerPid = (await record()).ownerBackendPid;
					expect(
						(await fixture.query("SELECT pg_terminate_backend($1) AS terminated", [ownerPid]))
							.rows[0].terminated,
					).toBe(true);
					await expect
						.poll(
							async () =>
								Number(
									(
										await fixture.query(
											"SELECT COUNT(*) AS count FROM pg_stat_activity WHERE pid=$1",
											[ownerPid],
										)
									).rows[0].count,
								),
							{ timeout: 5000 },
						)
						.toBe(0);
					const contender = await acquirePostgresRestoreRuntimeOwnership(url);
					try {
						expect(await contender.tryAcquireExclusive()).toBe(false);
					} finally {
						await contender.close();
					}
					await expect(openRestoreRuntime({ databaseUrl: url })).rejects.toThrow();
				}
				expect(child.exitCode).toBeNull();
				const positive = await record();
				expect(positive).toMatchObject({ phase: "restart-required" });
				expect(positive.lastCommittedRestoreId).toBe(positive.activeRestoreId);
				expect((await fixture.query('SELECT username FROM "User"')).rows).toEqual([
					{ username: "synthetic-restored" },
				]);
				expect((await fixture.query('SELECT id FROM "sessions"')).rows).toEqual([]);
				for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
					const rows = (
						await fixture.query(`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`)
					).rows;
					expect(rows).toHaveLength(1);
					expect(destination.decrypt({ value: rows[0].value, iv: rows[0].iv })).toBe(plaintext);
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
				const snapshot = async () =>
					Object.fromEntries(
						await Promise.all(
							tables.map(async (table) => [
								table,
								(await fixture.query(`SELECT * FROM "${table}"`)).rows,
							]),
						),
					);
				const committedRows = await snapshot();
				const actors: number[] = (
					await fixture.query(
						"SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
					)
				).rows.map((row) => row.pid);
				child.kill("SIGKILL");
				await closed;
				await expect
					.poll(
						async () =>
							Number(
								(
									await fixture.query(
										"SELECT COUNT(*) AS count FROM pg_stat_activity WHERE pid=ANY($1::int[])",
										[actors],
									)
								).rows[0].count,
							),
						{ timeout: 5000 },
					)
					.toBe(0);
				const owner = await acquirePostgresRestoreRuntimeOwnership(url);
				try {
					expect(await owner.tryAcquireExclusive()).toBe(true);
					expect(classifyRestoreRuntimeRecovery(await record(), identity)).toBe("committed");
				} finally {
					await owner.close();
				}
				runtime = await openRestoreRuntime({ databaseUrl: url });
				await runtime.bindDestination(identity);
				await runtime.activate();
				expect(await snapshot()).toEqual(committedRows);
				expect(await record()).toMatchObject({
					phase: "running",
					activeRestoreId: null,
					lastCommittedRestoreId: positive.lastCommittedRestoreId,
					lastCommittedAt: positive.lastCommittedAt,
				});
			} finally {
				if (timer) clearTimeout(timer);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
			}
		},
		30000,
	);
	it.each(["owner-loss-before-writer", "owner-loss-in-transaction"] as const)(
		"fences a surviving real publisher after %s until its actual writer settles",
		async (stage) => {
			await preparedReplacement();
			await preparePublicationCredentialFixture(runtime, ordinary!.prisma, true);
			await ordinary!.close();
			await runtime.close();
			const actorFile = process.env.POSTGRES_RESTORE_REPLACEMENT_ACTOR_FILE;
			if (!actorFile) throw new Error("Compiled current PostgreSQL replacement actor required");
			const tables = [
				"User",
				"ServiceInstance",
				"sessions",
				"queue_cleaner_import_receipts",
				"arr_import_operations",
				"arr_import_source_claims",
				"arr_import_file_proofs",
			];
			const snapshot = async () =>
				Object.fromEntries(
					await Promise.all(
						tables.map(async (table) => [
							table,
							(await fixture.query(`SELECT * FROM "${table}"`)).rows,
						]),
					),
				);
			const before = await snapshot();
			const url = process.env.RESTORE_RUNTIME_TEST_PG_URL!;
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
						if (line.length > 256) reject(new Error("Bounded owner-loss barrier required"));
						else if (line.endsWith("\n")) {
							try {
								resolve(JSON.parse(line));
							} catch {
								reject(new Error("Invalid owner-loss barrier"));
							}
						}
					});
					child.once("error", reject);
					child.once("close", () =>
						reject(new Error("Publisher exited before owner-loss barrier")),
					);
					timer = setTimeout(() => reject(new Error("Owner-loss barrier timeout")), 15000);
				});
				clearTimeout(timer);
				expect(reached).toEqual({ kind: "publication-owner-loss-barrier", stage });
				const pending = await record();
				expect(pending).toMatchObject({ phase: "restore-pending", lastCommittedRestoreId: null });
				const actors: number[] = (
					await fixture.query(
						"SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'",
					)
				).rows.map((row) => row.pid);
				expect(actors).toContain(pending.ownerBackendPid);
				expect(
					(
						await fixture.query("SELECT pg_terminate_backend($1) AS terminated", [
							pending.ownerBackendPid,
						])
					).rows[0].terminated,
				).toBe(true);
				await expect
					.poll(
						async () =>
							Number(
								(
									await fixture.query(
										"SELECT COUNT(*) AS count FROM pg_stat_activity WHERE pid=$1",
										[pending.ownerBackendPid],
									)
								).rows[0].count,
							),
						{ timeout: 5000 },
					)
					.toBe(0);
				const writerActive = stage === "owner-loss-in-transaction";
				const lockRows = (
					await fixture.query(
						"SELECT pid FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND classid=1095914052::oid AND objid=2::oid AND objsubid=2 AND granted AND mode='ExclusiveLock'",
					)
				).rows;
				expect(lockRows).toHaveLength(writerActive ? 1 : 0);
				if (writerActive) expect(lockRows[0].pid).not.toBe(pending.ownerBackendPid);
				const contender = await acquirePostgresRestoreRuntimeOwnership(url);
				try {
					expect(await contender.tryAcquireExclusive()).toBe(!writerActive);
				} finally {
					await contender.close();
				}
				if (writerActive) {
					await expect(openRestoreRuntime({ databaseUrl: url })).rejects.toThrow();
					expect(await record()).toEqual(pending);
				} else {
					// No publishing connection exists yet. Real recovery may retire
					// the old attempt; its suspended continuation must remain fenced.
					runtime = await openRestoreRuntime({ databaseUrl: url });
					await runtime.bindDestination(identity);
					await runtime.activate();
					expect((await record()).runtimeEpoch).not.toBe(pending.runtimeEpoch);
				}
				expect(await snapshot()).toEqual(before);
				const resumed = new Promise<unknown>((resolve, reject) => {
					child.once("message", resolve);
					child.once("close", () => reject(new Error("Publisher exited before fenced result")));
					timer = setTimeout(() => reject(new Error("Fenced publication result timeout")), 15000);
				});
				child.send({ kind: "resume-owner-loss" });
				const result = await resumed;
				clearTimeout(timer);
				expect(result).toMatchObject({
					kind: "publication-owner-loss-result",
					ordinaryRefused: true,
				});
				if (writerActive)
					expect(result).toMatchObject({
						publication: { outcome: "unavailable", reason: "commit-unknown" },
					});
				else expect(result).toMatchObject({ publication: null });
				// The actor deliberately stays alive. Its actual server backends,
				// not process-exit or a delay, prove transaction/connection closure.
				expect(child.exitCode).toBeNull();
				await expect
					.poll(
						async () =>
							Number(
								(
									await fixture.query(
										"SELECT COUNT(*) AS count FROM pg_stat_activity WHERE pid=ANY($1::int[])",
										[actors],
									)
								).rows[0].count,
							),
						{ timeout: 5000 },
					)
					.toBe(0);
				expect(await snapshot()).toEqual(before);
				if (writerActive) {
					const owner = await acquirePostgresRestoreRuntimeOwnership(url);
					try {
						expect(await owner.tryAcquireExclusive()).toBe(true);
						expect(classifyRestoreRuntimeRecovery(await record(), identity)).toBe("not-committed");
					} finally {
						await owner.close();
					}
					runtime = await openRestoreRuntime({ databaseUrl: url });
					await runtime.bindDestination(identity);
					await runtime.activate();
				}
				expect(await snapshot()).toEqual(before);
				expect(await record()).toMatchObject({
					phase: "running",
					activeRestoreId: null,
					lastCommittedRestoreId: null,
				});
				ordinary = createRuntimePrismaClient(runtime);
				expect(await runtime.runOperation(() => ordinary!.prisma.user.count())).toBe(1);
			} finally {
				if (timer) clearTimeout(timer);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await closed;
			}
		},
		30000,
	);
	it.each([false, true])(
		"publishes all nine credential pairs and %s current-held-state conservation",
		async (retainCurrentHolds) => {
			await preparedReplacement();
			const prepared = await preparePublicationCredentialFixture(
				runtime,
				ordinary!.prisma,
				retainCurrentHolds,
			);
			const result = await publishPreparedRestore({ runtime, prepared });
			expect(result).toMatchObject({ outcome: "committed", reason: null, restartRequired: true });
			for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
				const rows = (
					await fixture.query(`SELECT "${value}" AS value, "${iv}" AS iv FROM "${table}"`)
				).rows;
				expect(rows).toHaveLength(1);
				expect(destination.decrypt({ value: rows[0].value, iv: rows[0].iv })).toBe(plaintext);
			}
			expect((await fixture.query('SELECT username FROM "User"')).rows).toEqual([
				{ username: "synthetic-restored" },
			]);
			expect((await fixture.query('SELECT id FROM "sessions"')).rows).toEqual([]);
			expect(
				(await fixture.query('SELECT id, state, "commandId" FROM "queue_cleaner_import_receipts"'))
					.rows,
			).toEqual([{ id: "credential-receipt", state: "unknown", commandId: 42 }]);
			expect(
				(
					await fixture.query(
						'SELECT id, state, "commandId", revision, "reconcileToken", "reconcileExpiresAt" FROM "arr_import_operations"',
					)
				).rows,
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
				(await fixture.query('SELECT id, "activeOperationId" FROM "arr_import_source_claims"'))
					.rows,
			).toEqual([{ id: "credential-claim", activeOperationId: "credential-operation" }]);
			expect(
				(
					await fixture.query(
						'SELECT id, "operationId", "verifiedAt" FROM "arr_import_file_proofs"',
					)
				).rows,
			).toEqual([
				{ id: "credential-proof", operationId: "credential-operation", verifiedAt: null },
			]);
			expect(await record()).toMatchObject({
				phase: "restart-required",
				lastCommittedRestoreId: result.restoreId,
			});
		},
	);
	it("publishes the full native schema in a quoted namespace without touching public", async () => {
		await runtime.close();
		const project = process.env.RESTORE_RUNTIME_TEST_PROJECT;
		if (
			!project ||
			!/^\/tmp\/arr-native-postgres-test-[^/]+\/artifacts\/restore-application-admission-native$/.test(
				project,
			)
		)
			throw new Error("Owned native PostgreSQL schema project required");
		const schema = 'publication"scope';
		const bootstrapSchema = "publication_bootstrap";
		const quoted = `"${schema.replaceAll('"', '""')}"`;
		const url = new URL(process.env.RESTORE_RUNTIME_TEST_PG_URL!);
		url.searchParams.set("schema", schema);
		const bootstrapUrl = new URL(url);
		bootstrapUrl.searchParams.set("schema", bootstrapSchema);
		const snapshotPublic = async () => {
			const tables = (
				await fixture.query<{ tablename: string }>(
					"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
				)
			).rows;
			return Object.fromEntries(
				await Promise.all(
					tables.map(async ({ tablename }) => [
						tablename,
						(await fixture.query(`SELECT * FROM "public"."${tablename.replaceAll('"', '""')}"`))
							.rows,
					]),
				),
			);
		};
		const before = await snapshotPublic();
		expect(
			(await fixture.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [schema])).rows,
		).toEqual([]);
		expect(
			(await fixture.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [bootstrapSchema]))
				.rows,
		).toEqual([]);
		await fixture.query(`CREATE SCHEMA "${bootstrapSchema}"`);
		let renamed = false;
		try {
			const child = spawn(
				process.execPath,
				[
					join(project, "node_modules/prisma/build/index.js"),
					"db",
					"push",
					"--schema",
					"prisma/schema.prisma",
				],
				{
					cwd: project,
					stdio: ["ignore", "pipe", "pipe"],
					env: {
						PATH: process.env.PATH,
						HOME: process.env.HOME,
						LANG: "C.UTF-8",
						TZ: "UTC",
						NODE_ENV: "test",
						CI: "true",
						DOTENV_CONFIG_PATH: "/dev/null",
						CHECKPOINT_DISABLE: "1",
						DATABASE_URL: bootstrapUrl.toString(),
					},
				},
			);
			let failed = false;
			child.once("error", () => {
				failed = true;
			});
			let diagnostic = "";
			child.stdout.on("data", (bytes) => {
				diagnostic = (diagnostic + String(bytes)).slice(-8192);
			});
			child.stderr.on("data", (bytes) => {
				diagnostic = (diagnostic + String(bytes)).slice(-8192);
			});
			const completion = await new Promise<{ code: number | null; signal: string | null }>(
				(resolve) => child.once("close", (code, signal) => resolve({ code, signal })),
			);
			expect(failed).toBe(false);
			const category = {
				code: diagnostic.match(/\bP\d{4}\b/)?.[0] ?? null,
				syntax: /syntax error/i.test(diagnostic),
				connection: /connect|authentication/i.test(diagnostic),
				schema: /schema/i.test(diagnostic),
				permissions: /permission denied/i.test(diagnostic),
			};
			expect(completion, JSON.stringify(category)).toEqual({ code: 0, signal: null });
			// Prisma's CLI bootstrap does not quote interior schema quotes. Native
			// rename preserves all genuine table/FK OIDs; runtime uses the raw name.
			const bootstrapOid = (
				await fixture.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [bootstrapSchema])
			).rows[0].oid;
			await fixture.query(`ALTER SCHEMA "${bootstrapSchema}" RENAME TO ${quoted}`);
			renamed = true;
			expect(
				(await fixture.query("SELECT oid FROM pg_namespace WHERE nspname=$1", [schema])).rows[0]
					.oid,
			).toBe(bootstrapOid);
			expect(
				Number(
					(
						await fixture.query("SELECT COUNT(*) AS count FROM pg_tables WHERE schemaname=$1", [
							schema,
						])
					).rows[0].count,
				),
			).toBe(101);
			expect(
				(
					await fixture.query(
						"SELECT tablename FROM pg_tables WHERE schemaname=$1 AND tablename IN ('SearchGrabAttempt', 'SearchGrabClaim', 'NotificationOutboxEvent', 'NotificationOutboxDelivery') ORDER BY tablename",
						[schema],
					)
				).rows,
			).toEqual([
				{ tablename: "NotificationOutboxDelivery" },
				{ tablename: "NotificationOutboxEvent" },
				{ tablename: "SearchGrabAttempt" },
				{ tablename: "SearchGrabClaim" },
			]);
			await fixture.query(
				`INSERT INTO ${quoted}."RestoreRuntimeControl" (id,"protocolVersion",phase) VALUES(1,1,'idle')`,
			);
			runtime = await openRestoreRuntime({ databaseUrl: url.toString() });
			await runtime.bindDestination(identity);
			await runtime.activate();
			await preparedReplacement();
			const prepared = await preparePublicationCredentialFixture(runtime, ordinary!.prisma, true);
			const result = await publishPreparedRestore({ runtime, prepared });
			expect(result).toMatchObject({ outcome: "committed", reason: null });
			for (const [table, value, iv, plaintext] of publicationCredentialColumns) {
				const rows = (
					await fixture.query(`SELECT "${value}" AS value, "${iv}" AS iv FROM ${quoted}."${table}"`)
				).rows;
				expect(rows).toHaveLength(1);
				expect(destination.decrypt({ value: rows[0].value, iv: rows[0].iv })).toBe(plaintext);
			}
			expect((await fixture.query(`SELECT username FROM ${quoted}."User"`)).rows).toEqual([
				{ username: "synthetic-restored" },
			]);
			expect((await fixture.query(`SELECT id FROM ${quoted}."sessions"`)).rows).toEqual([]);
			expect(
				(
					await fixture.query(
						`SELECT id,state,"commandId" FROM ${quoted}."queue_cleaner_import_receipts"`,
					)
				).rows,
			).toEqual([{ id: "credential-receipt", state: "unknown", commandId: 42 }]);
			expect(
				(
					await fixture.query(
						`SELECT phase,"lastCommittedRestoreId" FROM ${quoted}."RestoreRuntimeControl"`,
					)
				).rows,
			).toEqual([{ phase: "restart-required", lastCommittedRestoreId: result.restoreId }]);
			expect(await snapshotPublic()).toEqual(before);
		} finally {
			await ordinary?.close();
			await runtime.close();
			// Only the exact namespace created above in this owned local database.
			await fixture.query(`DROP SCHEMA ${renamed ? quoted : `"${bootstrapSchema}"`} CASCADE`);
		}
	}, 60000);
});
