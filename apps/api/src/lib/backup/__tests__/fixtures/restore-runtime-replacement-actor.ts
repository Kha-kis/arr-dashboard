import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import type { BackupData } from "@arr/shared";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { importCommandFingerprint } from "../../../arr/manual-import-command.js";
import { Encryptor } from "../../../auth/encryption.js";
import type { PrismaClientInstance } from "../../../prisma.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../../queue-cleaner/import-receipt.js";
import { encryptBackupData } from "../../backup-crypto.js";
import { exportDatabase } from "../../backup-database.js";
import { prepareRestoreData } from "../../backup-restore-preparation.js";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	type RestoreRuntime,
	withRestoreRuntimeReplacement,
} from "../../restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../restore-runtime-client.js";
import { publishPreparedRestore } from "../../restore-runtime-replacement.js";

// Hand-written schema/credential expectations, independent of the portability map.
export const publicationCredentialColumns = [
	["User", "encryptedTmdbApiKey", "tmdbEncryptionIv", "synthetic-tmdb"],
	["User", "encryptedTraktAccessToken", "traktTokenIv", "synthetic-trakt"],
	["ServiceInstance", "encryptedApiKey", "encryptionIv", "synthetic-arr"],
	[
		"ServiceInstance",
		"encryptedHttpAuthCredentials",
		"httpAuthEncryptionIv",
		'{"username":"synthetic","password":"synthetic"}',
	],
	["oidc_providers", "encryptedClientSecret", "clientSecretIv", "synthetic-oidc"],
	["backup_settings", "encryptedPassword", "passwordIv", "synthetic-backup"],
	["notification_channels", "encryptedConfig", "configIv", '{"url":"synthetic"}'],
	["vapid_keys", "encryptedPrivateKey", "privateKeyIv", "synthetic-vapid"],
	[
		"arr_import_operations",
		"encryptedSources",
		"sourcesEncryptionIv",
		'{"version":1,"service":"radarr","files":[{"path":"/synthetic/movie.mkv","downloadId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","movieId":7,"movieFileId":0}]}',
	],
] as const;

/** Populated native fixture only; no provider client or upstream action exists here. */
export async function preparePublicationCredentialFixture(
	runtime: RestoreRuntime,
	prisma: PrismaClientInstance,
	retainCurrentHolds: boolean,
) {
	const url = getRestoreRuntimeClientContext(runtime).databaseUrl;
	const owned = url.startsWith("file:/tmp/arr-restore-publication-") && url.endsWith("/main.db");
	const postgres = /^postgres(?:ql)?:\/\//.test(url) ? new URL(url) : undefined;
	if (!owned && !(postgres?.hostname === "127.0.0.1" && postgres.pathname.endsWith("_test")))
		throw new Error("Owned native credential fixture required");
	const key = (retainCurrentHolds ? "64" : "53").repeat(32);
	const encryptor = new Encryptor(key);
	const destination = new Encryptor("64".repeat(32));
	const encrypted = publicationCredentialColumns.map(([, , , text]) => encryptor.encrypt(text));
	const date = new Date("2026-10-09T00:00:00.000Z");
	const file = {
		path: "/synthetic/movie.mkv",
		downloadId: "a".repeat(40),
		movieId: 7,
		movieFileId: 0,
	};
	const records = await runtime.runOperation(async () => {
		await prisma.user.update({
			where: { id: "publication-owner" },
			data: {
				encryptedTmdbApiKey: encrypted[0]!.value,
				tmdbEncryptionIv: encrypted[0]!.iv,
				encryptedTraktAccessToken: encrypted[1]!.value,
				traktTokenIv: encrypted[1]!.iv,
			},
		});
		const instance = await prisma.serviceInstance.create({
			data: {
				id: "credential-instance",
				userId: "publication-owner",
				service: "RADARR",
				label: "synthetic",
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: encrypted[2]!.value,
				encryptionIv: encrypted[2]!.iv,
				encryptedHttpAuthCredentials: encrypted[3]!.value,
				httpAuthEncryptionIv: encrypted[3]!.iv,
				createdAt: date,
				updatedAt: date,
			},
		});
		await prisma.oIDCProvider.create({
			data: {
				id: 1,
				displayName: "synthetic",
				clientId: "synthetic",
				issuer: "https://synthetic.invalid",
				redirectUri: "https://synthetic.invalid/callback",
				encryptedClientSecret: encrypted[4]!.value,
				clientSecretIv: encrypted[4]!.iv,
			},
		});
		await prisma.backupSettings.create({
			data: {
				id: 1,
				encryptedPassword: encrypted[5]!.value,
				passwordIv: encrypted[5]!.iv,
			},
		});
		await prisma.notificationChannel.create({
			data: {
				id: "credential-channel",
				userId: "publication-owner",
				name: "synthetic",
				type: "WEBHOOK",
				encryptedConfig: encrypted[6]!.value,
				configIv: encrypted[6]!.iv,
			},
		});
		await prisma.vapidKeys.create({
			data: {
				id: 1,
				publicKey: "synthetic-public",
				encryptedPrivateKey: encrypted[7]!.value,
				privateKeyIv: encrypted[7]!.iv,
			},
		});
		const connectionFingerprint = importConnectionFingerprint(instance);
		await prisma.arrImportOperation.create({
			data: {
				id: "credential-operation",
				userId: "publication-owner",
				instanceId: instance.id,
				originalInstanceId: instance.id,
				connectionFingerprint,
				service: "RADARR",
				origin: "queue-cleaner",
				mode: "Move",
				idempotencyKey: "synthetic-idempotency",
				requestFingerprint: `v1:${"b".repeat(64)}`,
				commandFingerprint: importCommandFingerprint([file])!,
				encryptedSources: encrypted[8]!.value,
				sourcesEncryptionIv: encrypted[8]!.iv,
				legacyReceiptId: "credential-receipt",
				state: "unknown",
				reason: "evidence-unavailable",
				commandId: 42,
				commandState: "unknown",
				commandTerminal: false,
				selectedFileCount: 1,
				verifiedFileCount: 0,
				preparationExpiresAt: date,
				submissionStartedAt: date,
				reconcileToken: "synthetic-source-worker",
				reconcileExpiresAt: date,
				revision: 3,
				createdAt: date,
				updatedAt: date,
			},
		});
		await prisma.arrImportFileProof.create({
			data: {
				id: "credential-proof",
				operationId: "credential-operation",
				fileFingerprint: importCommandFingerprint([file])!,
				downloadKey: queueDownloadKey(file)!,
				identityJson: {
					pathHash: createHash("sha256").update(file.path).digest("hex"),
					movieId: 7,
					movieFileId: 0,
				},
				verifiedAt: null,
				createdAt: date,
			},
		});
		await prisma.arrImportSourceClaim.create({
			data: {
				id: "credential-claim",
				userId: "publication-owner",
				downloadKey: queueDownloadKey(file)!,
				activeOperationId: "credential-operation",
				createdAt: date,
				updatedAt: date,
			},
		});
		await prisma.queueCleanerImportReceipt.create({
			data: {
				id: "credential-receipt",
				instanceId: instance.id,
				downloadKey: queueDownloadKey(file)!,
				queueId: 7,
				downloadTitle: "synthetic",
				connectionFingerprint,
				commandFingerprint: importCommandFingerprint([file])!,
				commandId: 42,
				state: "unknown",
				lastAttemptAt: date,
				createdAt: date,
				updatedAt: date,
			},
		});
		const data = await exportDatabase(prisma);
		if (!retainCurrentHolds) {
			// Delete only the just-created synthetic source fixture, before publication.
			await prisma.arrImportSourceClaim.delete({ where: { id: "credential-claim" } });
			await prisma.arrImportOperation.delete({ where: { id: "credential-operation" } });
			await prisma.serviceInstance.delete({ where: { id: instance.id } });
			await prisma.oIDCProvider.delete({ where: { id: 1 } });
			await prisma.backupSettings.delete({ where: { id: 1 } });
			await prisma.notificationChannel.delete({ where: { id: "credential-channel" } });
			await prisma.vapidKeys.delete({ where: { id: 1 } });
			const old = destination.encrypt("synthetic-old-provider-key");
			await prisma.user.update({
				where: { id: "publication-owner" },
				data: {
					encryptedTmdbApiKey: old.value,
					tmdbEncryptionIv: old.iv,
					encryptedTraktAccessToken: null,
					traktTokenIv: null,
				},
			});
		}
		return data;
	});
	records.users[0]!.username = "synthetic-restored";
	const backup: BackupData = {
		version: "1.3",
		appVersion: "2.24.2",
		timestamp: date.toISOString(),
		data: records,
		secrets: { encryptionKey: key, sessionCookieSecret: "synthetic-source-cookie" },
	};
	return prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(backup), "synthetic-backup-password"),
		password: "synthetic-backup-password",
		destination: {
			encryptor: destination,
			installationId: "synthetic-destination",
			stableForRestart: true,
		},
	});
}

async function runFixtureActor() {
	// The parent supplies only its newly owned disposable main file, never a live URL.
	const url = process.argv[2]!;
	const mode = process.argv[3]!;
	if (/^postgres(?:ql)?:\/\//.test(url)) return runPostgresFixtureActor(url, mode);
	if (!url.startsWith("file:/tmp/arr-restore-publication-") || !url.endsWith("/main.db"))
		throw new Error("Owned replacement fixture required");
	if (
		![
			"sync-close",
			"writer-close-throw",
			"writer-close-false-ack",
			"marker-contradiction",
			"lost-commit-result",
			"sqlite-owner-loss-in-transaction",
			"sqlite-owner-loss-after-commit",
			"crash-before-pending",
			"crash-after-pending",
			"crash-before-commit",
			"crash-after-commit",
		].includes(mode)
	)
		throw new Error("Bounded replacement fixture mode required");
	let nativeOwner: Database.Database | undefined;
	let nativeOperations: Database.Database | undefined;
	const ownerLoss = mode.startsWith("sqlite-owner-loss-");
	if (ownerLoss) {
		const exec = Database.prototype.exec;
		Database.prototype.exec = function (sql) {
			const result = Reflect.apply(exec, this, [sql]);
			if (
				this.name === join(`${url.slice(5)}.arr-restore-runtime`, "owner.sqlite3") &&
				sql === "BEGIN IMMEDIATE"
			)
				nativeOwner = this;
			if (
				this.name === join(`${url.slice(5)}.arr-restore-runtime`, "operations.sqlite3") &&
				sql === "BEGIN EXCLUSIVE"
			)
				nativeOperations = this;
			return result;
		};
	}
	const runtime = await openRestoreRuntime({ databaseUrl: url });
	await runtime.bindDestination("synthetic-destination");
	await runtime.activate();
	const ownerProof = getRestoreRuntimeClientContext(runtime).assertOwned;
	const ownerLossBarrier = (main: Database.Database) => {
		if (!nativeOwner?.open || !nativeOperations?.inTransaction || !main.open)
			throw new Error("Actual live native ownership and publisher required");
		nativeOwner.close();
		// Trigger the real native ownership-loss path, not a fabricated latch.
		void ownerProof().catch(() => {});
		writeSync(
			1,
			`${JSON.stringify({
				kind: "publication-sqlite-owner-loss",
				stage: mode,
				ownerPhysicallyClosed: !nativeOwner.open,
				mainOpen: main.open,
				mainInTransaction: main.inTransaction,
			})}\n`,
		);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		throw new Error("Owner-loss barrier cannot resume publication");
	};
	const ordinary = createRuntimePrismaClient(runtime);
	const records = await runtime.runOperation(() => exportDatabase(ordinary.prisma));
	if (mode.startsWith("crash-") || mode === "lost-commit-result" || ownerLoss)
		records.users[0]!.username = "synthetic-restored";
	const backup: BackupData = {
		version: "1.3",
		appVersion: "2.24.2",
		timestamp: "2026-10-09T00:00:00.000Z",
		data: records,
		secrets: { encryptionKey: "64".repeat(32), sessionCookieSecret: "synthetic-source-cookie" },
	};
	const prepared = await prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(backup), "synthetic-backup-password"),
		password: "synthetic-backup-password",
		destination: {
			encryptor: new Encryptor("64".repeat(32)),
			installationId: "synthetic-destination",
			stableForRestart: true,
		},
	});

	if (
		mode.startsWith("crash-") ||
		mode === "lost-commit-result" ||
		mode === "sqlite-owner-loss-in-transaction"
	) {
		let nativeCommitCount = 0;
		const barrier = () => {
			// Synchronous kernel pipe delivery precedes blocking at the real SQL
			// boundary. Only the parent's joined SIGKILL ends this native actor.
			writeSync(1, `${JSON.stringify({ kind: "publication-crash-barrier", stage: mode })}\n`);
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			throw new Error("Crash barrier cannot resume publication");
		};
		if (mode === "crash-before-pending") {
			let entered!: () => void;
			const accepted = new Promise<void>((resolve) => {
				entered = resolve;
			});
			void runtime
				.runOperation(async () => {
					await ordinary.prisma.user.count();
					entered();
					await new Promise<void>(() => {});
				})
				.catch(() => {});
			await accepted;
			void publishPreparedRestore({ runtime, prepared }).catch(() => {});
			const refused = await runtime
				.runOperation(() => 0)
				.then(
					() => false,
					() => true,
				);
			if (!refused) throw new Error("Actual replacement reservation required");
			barrier();
		}
		const originalPrepare = Database.prototype.prepare;
		const originalExec = Database.prototype.exec;
		const intercept = <T>(main: Database.Database, sql: string, execute: () => T): T => {
			if (main.name !== url.slice(5) || !/^\s*COMMIT\s*;?\s*$/i.test(sql)) return execute();
			const row = Reflect.apply(originalPrepare, main, [
				'SELECT phase FROM "RestoreRuntimeControl"',
			]).get() as { phase: string };
			if (row.phase === "restart-required" && mode === "crash-before-commit") barrier();
			const result = execute();
			if (
				row.phase === "restart-required" &&
				mode === "lost-commit-result" &&
				nativeCommitCount === 0
			) {
				nativeCommitCount++;
				throw new Error("Synthetic lost native COMMIT acknowledgement");
			}
			if (
				(row.phase === "restore-pending" && mode === "crash-after-pending") ||
				(row.phase === "restart-required" && mode === "crash-after-commit")
			)
				barrier();
			return result;
		};
		Database.prototype.exec = function (sql) {
			return intercept(this, sql, () => Reflect.apply(originalExec, this, [sql]));
		};
		Database.prototype.prepare = function (this: Database.Database, sql: string) {
			const statement = Reflect.apply(originalPrepare, this, [sql]) as Database.Statement;
			if (
				this.name === url.slice(5) &&
				mode === "sqlite-owner-loss-in-transaction" &&
				/^\s*INSERT\s+INTO\s+(?:(?:"[^"\n]+"|`[^`\n]+`)\.)?(?:"User"|`User`)\s/i.test(sql)
			) {
				const main = this;
				for (const method of ["run", "all"] as const)
					Reflect.set(
						statement,
						method,
						new Proxy(statement[method], {
							apply(target, receiver, args) {
								const result = Reflect.apply(target, receiver, args);
								ownerLossBarrier(main);
								return result;
							},
						}),
					);
			}
			if (this.name === url.slice(5) && /^\s*COMMIT\s*;?\s*$/i.test(sql)) {
				const main = this;
				statement.run = new Proxy(statement.run, {
					apply(target, receiver, args) {
						return intercept(main, sql, () => Reflect.apply(target, receiver, args));
					},
				});
			}
			return statement;
		} as typeof Database.prototype.prepare;
		const publication = await publishPreparedRestore({ runtime, prepared });
		if (mode === "lost-commit-result") {
			const shutdownRefused = await runtime.close().then(
				() => false,
				() => true,
			);
			process.on("message", () => {});
			process.send?.({
				kind: "publication-native-result",
				stage: mode,
				publication,
				nativeCommitCount,
				shutdownRefused,
			});
			return;
		}
		throw new Error("Actual native publication crash boundary was not reached");
	}

	let evidence: Record<string, unknown>;
	if (mode === "sync-close") {
		const unregister = getRestoreRuntimeClientContext(runtime).registerClose(() => {
			throw new Error("Synthetic synchronous client close failure");
		});
		const second = createRuntimePrismaClient(runtime);
		await runtime.runOperation(() => second.prisma.user.count());
		let callbackEntered = false;
		const refused = await withRestoreRuntimeReplacement(runtime, prepared, async () => {
			callbackEntered = true;
		}).then(
			() => false,
			() => true,
		);
		unregister();
		const probe = new Database(join(`${url.slice(5)}.arr-restore-runtime`, "operations.sqlite3"), {
			fileMustExist: true,
			timeout: 0,
		});
		let otherClientsPhysicallyClosed = false;
		try {
			probe.exec("BEGIN EXCLUSIVE");
			otherClientsPhysicallyClosed = true;
		} catch {
			// A remaining genuine native SHARED participant prevents EXCLUSIVE.
		} finally {
			if (probe.inTransaction) probe.exec("ROLLBACK");
			probe.close();
		}
		const shutdownRefused = await runtime.close().then(
			() => false,
			() => true,
		);
		evidence = {
			kind: mode,
			refused,
			callbackEntered,
			otherClientsPhysicallyClosed,
			shutdownRefused,
		};
	} else {
		// Fault just the actual new publishing driver's closure, after real preparation.
		// Its native SQL, transaction, marker and actual main handle remain genuine.
		const originalConnect = PrismaBetterSqlite3.prototype.connect;
		let physical: Database.Database | undefined;
		PrismaBetterSqlite3.prototype.connect = async function () {
			const driver = await originalConnect.call(this);
			physical = Reflect.get(driver, "client") as Database.Database;
			const originalDispose = driver.dispose.bind(driver);
			driver.dispose = async () => {
				if (mode === "writer-close-throw") throw new Error("Synthetic native close failure");
				if (mode === "writer-close-false-ack" || mode === "sqlite-owner-loss-after-commit") return;
				await originalDispose();
				const main = new Database(url.slice(5), { fileMustExist: true });
				try {
					main.exec(`UPDATE RestoreRuntimeControl SET phase='restore-pending',
					lastCommittedRestoreId=NULL, lastCommittedAt=NULL`);
				} finally {
					main.close();
				}
			};
			return driver;
		};
		const publication = await publishPreparedRestore({ runtime, prepared }).catch(() => null);
		if (mode === "sqlite-owner-loss-after-commit") {
			if (
				publication?.outcome !== "unavailable" ||
				publication.reason !== "closure-unverified" ||
				!physical?.open
			)
				throw new Error("Genuine uncertain physical writer close required");
			ownerLossBarrier(physical);
		}
		const shutdownRefused = await runtime.close().then(
			() => false,
			() => true,
		);
		evidence = {
			kind: mode,
			publication,
			physicalStillOpen: physical?.open === true,
			shutdownRefused,
		};
	}
	// Keep this real owner alive for the parent's independent native exclusion probe.
	// Only the parent's joined SIGKILL/process exit releases uncertain actors.
	process.on("message", () => {});
	process.send?.(evidence);
}

async function runPostgresFixtureActor(url: string, mode: string) {
	const parsed = new URL(url);
	if (
		parsed.hostname !== "127.0.0.1" ||
		!parsed.pathname.endsWith("_test") ||
		parsed.search ||
		parsed.hash
	)
		throw new Error("Owned loopback replacement fixture required");
	if (
		![
			"crash-before-pending",
			"crash-after-pending",
			"crash-before-commit",
			"crash-after-commit",
			"owner-loss-before-writer",
			"owner-loss-in-transaction",
			"lost-commit-result",
			"postgres-writer-close-throw",
			"postgres-writer-close-false-ack",
		].includes(mode)
	)
		throw new Error("Bounded PostgreSQL crash mode required");
	const runtime = await openRestoreRuntime({ databaseUrl: url });
	await runtime.bindDestination("synthetic-destination");
	await runtime.activate();
	const ordinary = createRuntimePrismaClient(runtime);
	const records = await runtime.runOperation(() => exportDatabase(ordinary.prisma));
	records.users[0]!.username = "synthetic-restored";
	const backup: BackupData = {
		version: "1.3",
		appVersion: "2.24.2",
		timestamp: "2026-10-09T00:00:00.000Z",
		data: records,
		secrets: { encryptionKey: "64".repeat(32), sessionCookieSecret: "synthetic-source-cookie" },
	};
	const prepared = await prepareRestoreData({
		envelope: await encryptBackupData(JSON.stringify(backup), "synthetic-backup-password"),
		password: "synthetic-backup-password",
		destination: {
			encryptor: new Encryptor("64".repeat(32)),
			installationId: "synthetic-destination",
			stableForRestart: true,
		},
	});
	const ownerLoss = mode.startsWith("owner-loss-");
	const closeFault = mode.startsWith("postgres-writer-close-");
	let nativeCommitCount = 0;
	let publishingClient: Client | undefined;
	if (closeFault) {
		const originalEnd = Client.prototype.end;
		Client.prototype.end = function (this: Client, callback?: (error?: Error) => void) {
			if (this !== publishingClient)
				return Reflect.apply(originalEnd, this, callback ? [callback] : []);
			process.send?.({ kind: "publication-native-close-entered", stage: mode });
			if (mode === "postgres-writer-close-throw")
				throw new Error("Synthetic publishing backend close failure");
			if (callback) {
				callback();
				return;
			}
			return Promise.resolve();
		} as Client["end"];
	}
	let ownerBarrierUsed = false;
	const ownerBarrier = async () => {
		if (ownerBarrierUsed) throw new Error("One owner-loss boundary required");
		ownerBarrierUsed = true;
		const resumed = new Promise<void>((resolve) => process.once("message", () => resolve()));
		writeSync(1, `${JSON.stringify({ kind: "publication-owner-loss-barrier", stage: mode })}\n`);
		await resumed;
	};
	const barrier = () => {
		writeSync(1, `${JSON.stringify({ kind: "publication-crash-barrier", stage: mode })}\n`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		throw new Error("Crash barrier cannot resume publication");
	};
	if (mode === "crash-before-pending") {
		let entered!: () => void;
		const accepted = new Promise<void>((resolve) => {
			entered = resolve;
		});
		void runtime
			.runOperation(async () => {
				await ordinary.prisma.user.count();
				entered();
				await new Promise<void>(() => {});
			})
			.catch(() => {});
		await accepted;
		void publishPreparedRestore({ runtime, prepared }).catch(() => {});
		const refused = await runtime
			.runOperation(() => 0)
			.then(
				() => false,
				() => true,
			);
		if (!refused) throw new Error("Actual replacement reservation required");
		barrier();
	}
	const originalQuery = Client.prototype.query;
	Client.prototype.query = new Proxy(originalQuery, {
		apply(target, receiver: Client, args: unknown[]) {
			const sql =
				typeof args[0] === "string"
					? args[0]
					: args[0] && typeof args[0] === "object"
						? Reflect.get(args[0], "text")
						: undefined;
			if (
				closeFault &&
				receiver.constructor !== Client &&
				sql === "SELECT pg_try_advisory_lock(1095914052,2) AS acquired"
			)
				publishingClient = receiver;
			const insertBoundary =
				ownerLoss &&
				mode === "owner-loss-in-transaction" &&
				!ownerBarrierUsed &&
				receiver.constructor !== Client &&
				typeof sql === "string" &&
				/^\s*INSERT\s+INTO\s+(?:"[^"\n]+"\.)?"User"\s/i.test(sql);
			if (insertBoundary && typeof args.at(-1) !== "function")
				return (async () => {
					const result = await Reflect.apply(target, receiver, args);
					await ownerBarrier();
					return result;
				})();
			if (
				typeof sql !== "string" ||
				!/^\s*COMMIT\s*;?\s*$/i.test(sql) ||
				typeof args.at(-1) === "function"
			)
				return Reflect.apply(target, receiver, args);
			return (async () => {
				// Prisma and the real control transaction use promise COMMIT. The
				// native query and its result remain real; only their delivery pauses.
				const before = await Reflect.apply(target, receiver, [
					'SELECT phase FROM "RestoreRuntimeControl"',
				]);
				const phase: unknown = before.rows[0]?.phase;
				if (phase === "restart-required" && mode === "crash-before-commit") barrier();
				const result = await Reflect.apply(target, receiver, args);
				if (
					phase === "restart-required" &&
					mode === "lost-commit-result" &&
					receiver.constructor !== Client &&
					nativeCommitCount === 0
				) {
					nativeCommitCount++;
					throw new Error("Synthetic lost native COMMIT acknowledgement");
				}
				if (phase === "restore-pending" && mode === "owner-loss-before-writer" && !ownerBarrierUsed)
					await ownerBarrier();
				if (
					(phase === "restore-pending" && mode === "crash-after-pending") ||
					(phase === "restart-required" && mode === "crash-after-commit")
				)
					barrier();
				return result;
			})();
		},
	});
	let publicationSettled = false;
	if (closeFault)
		process.on("message", (message: unknown) => {
			if (
				message &&
				typeof message === "object" &&
				Reflect.get(message, "kind") === "inspect-publication"
			)
				process.send?.({ kind: "publication-settlement", publicationSettled });
		});
	const publication = await publishPreparedRestore({ runtime, prepared }).catch(() => null);
	publicationSettled = true;
	if (mode === "lost-commit-result" || closeFault) {
		const shutdownRefused = await runtime.close().then(
			() => false,
			() => true,
		);
		process.on("message", () => {});
		process.send?.({
			kind: "publication-native-result",
			stage: mode,
			publication,
			nativeCommitCount,
			shutdownRefused,
		});
		return;
	}
	if (ownerLoss) {
		if (!ownerBarrierUsed) throw new Error("Actual native owner-loss boundary required");
		const ordinaryRefused = await runtime
			.runOperation(() => 0)
			.then(
				() => false,
				() => true,
			);
		const shutdownRefused = await runtime.close().then(
			() => false,
			() => true,
		);
		process.on("message", () => {});
		process.send?.({
			kind: "publication-owner-loss-result",
			publication,
			ordinaryRefused,
			shutdownRefused,
		});
		return;
	}
	throw new Error("Actual PostgreSQL crash boundary was not reached");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]))
	await runFixtureActor();
