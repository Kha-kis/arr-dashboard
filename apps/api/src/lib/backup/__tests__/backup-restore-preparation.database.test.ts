import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { BackupData, BackupFormatVersion } from "@arr/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { ArrClientFactory } from "../../arr/client-factory.js";
import { importCommandFingerprint } from "../../arr/manual-import-command.js";
import { Encryptor } from "../../auth/encryption.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { BackupCompatibilityError } from "../../errors.js";
import type { Prisma, PrismaClient } from "../../prisma.js";
import {
	importConnectionFingerprint,
	queueDownloadKey,
} from "../../queue-cleaner/import-receipt.js";
import {
	createDeploymentConnectionBinding,
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	isCurrentDeploymentConnectionMapping,
	isDeploymentBackupEndpointIdentityCurrent,
	isVerifiedClonedProfileSourceConnection,
} from "../../trash-guides/deployment-target.js";
import { encryptBackupData } from "../backup-crypto.js";
import { exportDatabase, restoreDatabase, restorePreparedDatabase } from "../backup-database.js";
import { BACKUP_MODEL_DISPOSITIONS } from "../backup-portability.js";
import { type PreparedRestoreData, prepareRestoreData } from "../backup-restore-preparation.js";
import type { RestoreRuntimeCommitRequest } from "../restore-runtime-state.js";

const execFileAsync = promisify(execFile);
const apiDir = path.resolve(import.meta.dirname, "../../../..");
const sourceKey = "31".repeat(32);
const destinationKey = "42".repeat(32);
const sourceEncryptor = new Encryptor(sourceKey);
const destination = new Encryptor(destinationKey);
const date = new Date("2026-10-07T01:00:00.000Z");
const file = {
	path: "/synthetic/movie.mkv",
	downloadId: "a".repeat(40),
	movieId: 7,
	movieFileId: 0,
};
const plaintexts = [
	"synthetic-tmdb",
	"synthetic-trakt",
	"synthetic-api",
	'{"v":1,"username":"synthetic","password":"synthetic"}',
	"synthetic-oidc",
	"synthetic-backup",
	'{"url":"synthetic"}',
	"synthetic-vapid",
	JSON.stringify({ version: 1, service: "radarr", files: [file] }),
];
// Independent v1.3 expectations: current-format Grab credentials have their own
// populated native coverage in backup-format-15.database.test.ts.
const legacyEncryptedFieldExpectations = [
	{
		payloadField: "users",
		id: "owner",
		valueField: "encryptedTmdbApiKey",
		ivField: "tmdbEncryptionIv",
		plaintext: "synthetic-tmdb",
	},
	{
		payloadField: "users",
		id: "owner",
		valueField: "encryptedTraktAccessToken",
		ivField: "traktTokenIv",
		plaintext: "synthetic-trakt",
	},
	{
		payloadField: "serviceInstances",
		id: "arr",
		valueField: "encryptedApiKey",
		ivField: "encryptionIv",
		plaintext: "synthetic-api",
	},
	{
		payloadField: "serviceInstances",
		id: "arr",
		valueField: "encryptedHttpAuthCredentials",
		ivField: "httpAuthEncryptionIv",
		plaintext: '{"v":1,"username":"synthetic","password":"synthetic"}',
	},
	{
		payloadField: "oidcProviders",
		id: 1,
		valueField: "encryptedClientSecret",
		ivField: "clientSecretIv",
		plaintext: "synthetic-oidc",
	},
	{
		payloadField: "backupSettings",
		id: 1,
		valueField: "encryptedPassword",
		ivField: "passwordIv",
		plaintext: "synthetic-backup",
	},
	{
		payloadField: "notificationChannel",
		id: "channel",
		valueField: "encryptedConfig",
		ivField: "configIv",
		plaintext: '{"url":"synthetic"}',
	},
	{
		payloadField: "vapidKeys",
		id: 1,
		valueField: "encryptedPrivateKey",
		ivField: "privateKeyIv",
		plaintext: "synthetic-vapid",
	},
	{
		payloadField: "arrImportOperations",
		id: "operation",
		valueField: "encryptedSources",
		ivField: "sourcesEncryptionIv",
		plaintext:
			'{"version":1,"service":"radarr","files":[{"path":"/synthetic/movie.mkv","downloadId":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","movieId":7,"movieFileId":0}]}',
	},
] as const;
type Row = Record<string, unknown>;
const safetyDelegates = [
	["arrImportOperations", "arrImportOperation"],
	["arrImportFileProofs", "arrImportFileProof"],
	["arrImportSourceClaims", "arrImportSourceClaim"],
	["queueCleanerImportReceipts", "queueCleanerImportReceipt"],
	["quiActionLogs", "quiActionLog"],
	["quiActionClaims", "quiActionClaim"],
] as const;

// Literal synthetic records test row conservation, not physical lock authority.
const destinationStorageBinding = {
	id: 1,
	protocolVersion: 1,
	databaseDevice: "47",
	databaseInode: "8010001",
	directoryDevice: "47",
	directoryInode: "8010002",
	coordinationDevice: "47",
	coordinationInode: "8010003",
	ownerDevice: "47",
	ownerInode: "8010004",
	operationsDevice: "47",
	operationsInode: "8010005",
};
const sourceStorageBinding = {
	...destinationStorageBinding,
	databaseInode: "9010001",
	directoryInode: "9010002",
	coordinationInode: "9010003",
	ownerInode: "9010004",
	operationsInode: "9010005",
};

describe.skipIf(process.env.TEST_DB !== "true")(
	"prepared Restore disposable database boundary",
	() => {
		let tempDir: string;
		let source: PrismaClient;
		let target: PrismaClient;
		let original: BackupData["data"];
		let backup: BackupData;
		let hashedPassword: string;
		let postgresCleanup: (() => Promise<void>) | undefined;
		let postgresSchema: string | undefined;
		let postgresClientPath: string | undefined;
		let postgresUrl: string | undefined;
		beforeAll(async () => {
			tempDir = await mkdtemp(path.join(os.tmpdir(), "backup-roundtrip-"));
			const connection = process.env.TEST_DATABASE_URL;
			if (connection?.startsWith("postgres")) {
				const url = new URL(connection);
				if (
					!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
					!/^\/[A-Za-z_][A-Za-z0-9_]*_test$/.test(url.pathname) ||
					url.searchParams.size ||
					url.hash
				)
					throw new Error("Only explicit loopback disposable test PostgreSQL is supported");
				const pg = await import("pg");
				const { PrismaPg } = await import("@prisma/adapter-pg");
				const admin = new pg.default.Pool({ connectionString: connection });
				const suffix = `${process.pid}_${Date.now()}`;
				const schemas = [
					`restore_preparation_source_${suffix}`,
					`restore_preparation_target_${suffix}`,
				];
				const schemaFile = path.join(tempDir, "postgres-schema.prisma");
				const generatedOutput = path.join(tempDir, "postgres-client");
				// The public fallback must also load in a fresh process from /tmp.
				await symlink(path.join(apiDir, "node_modules"), path.join(tempDir, "node_modules"), "dir");
				const schema = (await readFile(path.join(apiDir, "prisma/schema.prisma"), "utf8"))
					.replace(
						/generator client \{[\s\S]*?\}\n\n/,
						`generator client {\n  provider = "prisma-client"\n  output = "${generatedOutput}"\n}\n\n`,
					)
					.replace('provider = "sqlite"', 'provider = "postgresql"');
				await writeFile(schemaFile, schema, { mode: 0o600 });
				postgresClientPath =
					process.env.PRIVATE_PG_CLIENT_PATH ?? path.join(generatedOutput, "client.ts");
				if (!process.env.PRIVATE_PG_CLIENT_PATH)
					await execFileAsync("pnpm", ["exec", "prisma", "generate", "--schema", schemaFile], {
						cwd: apiDir,
						env: process.env,
					});
				const native = await import(/* @vite-ignore */ pathToFileURL(postgresClientPath).href);
				const NativeClient = (native.default ?? native).PrismaClient as new (args: {
					adapter: unknown;
				}) => PrismaClient;
				const pools: InstanceType<typeof pg.default.Pool>[] = [];
				const clients: PrismaClient[] = [];
				try {
					for (const schemaName of schemas) {
						await admin.query(`CREATE SCHEMA "${schemaName}"`);
						const schemaUrl = new URL(connection);
						schemaUrl.searchParams.set("schema", schemaName);
						await execFileAsync(
							"pnpm",
							[
								"exec",
								"prisma",
								"db",
								"push",
								"--schema",
								schemaFile,
								"--url",
								schemaUrl.toString(),
							],
							{ cwd: apiDir, env: { ...process.env, DATABASE_URL: schemaUrl.toString() } },
						);
						const pool = new pg.default.Pool({ connectionString: schemaUrl.toString() });
						pools.push(pool);
						clients.push(
							new NativeClient({ adapter: new PrismaPg(pool as never, { schema: schemaName }) }),
						);
					}
					[source, target] = clients as [PrismaClient, PrismaClient];
					postgresSchema = schemas[1];
					postgresUrl = connection;
				} finally {
					postgresCleanup = async () => {
						await Promise.allSettled(clients.map((client) => client.$disconnect()));
						await Promise.allSettled(pools.map((pool) => pool.end()));
						for (const schemaName of schemas)
							await admin.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
						await admin.end();
					};
				}
			} else {
				for (const name of ["source.db", "target.db"]) {
					const url = `file:${path.join(tempDir, name)}`;
					await execFileAsync(
						"pnpm",
						["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma", "--url", url],
						{ cwd: apiDir, env: { ...process.env, DATABASE_URL: url } },
					);
				}
				source = createTestPrismaClient(path.join(tempDir, "source.db"));
				target = createTestPrismaClient(path.join(tempDir, "target.db"));
			}
			hashedPassword = await hashPassword("synthetic-restored-password");
		}, 120000);
		afterAll(async () => {
			await source?.$disconnect();
			await target?.$disconnect();
			await postgresCleanup?.();
			if (tempDir) await rm(tempDir, { recursive: true, force: true });
		});
		async function clear(prisma: PrismaClient) {
			// Only these freshly created disposable databases are ever passed here.
			const models = prisma as unknown as Record<string, { deleteMany: () => Promise<unknown> }>;
			for (const model of Object.keys(BACKUP_MODEL_DISPOSITIONS).reverse())
				await models[model[0]!.toLowerCase() + model.slice(1)]!.deleteMany();
		}
		beforeEach(async () => {
			await clear(source);
			await clear(target);
			const encrypted = plaintexts.map((text) => sourceEncryptor.encrypt(text));
			await source.user.create({
				data: {
					id: "owner",
					username: "synthetic",
					hashedPassword,
					encryptedTmdbApiKey: encrypted[0]!.value,
					tmdbEncryptionIv: encrypted[0]!.iv,
					encryptedTraktAccessToken: encrypted[1]!.value,
					traktTokenIv: encrypted[1]!.iv,
					createdAt: date,
					updatedAt: date,
				},
			});
			const instance = await source.serviceInstance.create({
				data: {
					id: "arr",
					userId: "owner",
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
			const quiCrypto = sourceEncryptor.encrypt("synthetic-qui");
			await source.serviceInstance.create({
				data: {
					id: "qui",
					userId: "owner",
					service: "QUI",
					label: "same label",
					baseUrl: "http://qui.invalid",
					encryptedApiKey: quiCrypto.value,
					encryptionIv: quiCrypto.iv,
				},
			});
			await source.session.create({
				data: { id: "source-session", userId: "owner", expiresAt: new Date("2030-01-01") },
			});
			await source.oIDCProvider.create({
				data: {
					id: 1,
					displayName: "synthetic",
					clientId: "synthetic",
					issuer: "https://issuer.invalid",
					redirectUri: "https://app.invalid/callback",
					encryptedClientSecret: encrypted[4]!.value,
					clientSecretIv: encrypted[4]!.iv,
				},
			});
			await source.oIDCAccount.create({
				data: { id: "account", userId: "owner", providerUserId: "synthetic-provider" },
			});
			await source.webAuthnCredential.create({
				data: { id: "passkey", userId: "owner", publicKey: "synthetic-public-key", counter: 9 },
			});
			await source.backupSettings.create({
				data: { id: 1, encryptedPassword: encrypted[5]!.value, passwordIv: encrypted[5]!.iv },
			});
			await source.notificationChannel.create({
				data: {
					id: "channel",
					userId: "owner",
					name: "synthetic",
					type: "WEBHOOK",
					encryptedConfig: encrypted[6]!.value,
					configIv: encrypted[6]!.iv,
				},
			});
			await source.vapidKeys.create({
				data: {
					id: 1,
					publicKey: "synthetic-public",
					encryptedPrivateKey: encrypted[7]!.value,
					privateKeyIv: encrypted[7]!.iv,
				},
			});
			const fingerprint = importConnectionFingerprint(instance);
			await source.arrImportOperation.create({
				data: {
					id: "operation",
					userId: "owner",
					instanceId: "arr",
					originalInstanceId: "arr",
					service: "RADARR",
					origin: "queue-cleaner",
					mode: "Move",
					idempotencyKey: "synthetic-idempotency",
					requestFingerprint: `v1:${"b".repeat(64)}`,
					commandFingerprint: importCommandFingerprint([file])!,
					connectionFingerprint: fingerprint,
					encryptedSources: encrypted[8]!.value,
					sourcesEncryptionIv: encrypted[8]!.iv,
					legacyReceiptId: "receipt",
					state: "unknown",
					reason: "evidence-unavailable",
					commandId: 42,
					commandState: "unknown",
					commandTerminal: false,
					selectedFileCount: 1,
					verifiedFileCount: 0,
					preparationExpiresAt: date,
					submissionStartedAt: date,
					lastCheckedAt: date,
					nextCheckAt: date,
					reconcileToken: "source-worker",
					reconcileExpiresAt: date,
					revision: 3,
					createdAt: date,
					updatedAt: date,
				},
			});
			await source.arrImportFileProof.create({
				data: {
					id: "proof",
					operationId: "operation",
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
			await source.arrImportSourceClaim.create({
				data: {
					id: "claim",
					userId: "owner",
					downloadKey: queueDownloadKey(file)!,
					activeOperationId: "operation",
					createdAt: date,
					updatedAt: date,
				},
			});
			await source.queueCleanerImportReceipt.create({
				data: {
					id: "receipt",
					instanceId: "arr",
					downloadKey: queueDownloadKey(file)!,
					queueId: 7,
					downloadTitle: "synthetic",
					connectionFingerprint: fingerprint,
					commandFingerprint: importCommandFingerprint([file])!,
					commandId: 42,
					state: "unknown",
					lastAttemptAt: date,
					createdAt: date,
					updatedAt: date,
				},
			});
			await source.quiActionLog.create({
				data: {
					id: "qui-log",
					userId: "owner",
					serviceInstanceId: "qui",
					qbitInstanceId: 1,
					torrentHash: "a".repeat(40),
					action: "pause",
					status: "uncertain",
					attemptId: "qui-attempt",
					requestedAt: date,
				},
			});
			await source.quiActionClaim.create({
				data: {
					userId: "owner",
					serviceInstanceId: "qui",
					qbitInstanceId: 1,
					torrentHash: "a".repeat(40),
					attemptId: "qui-attempt",
					createdAt: date,
				},
			});
			original = await exportDatabase(source, { excludeOperationalHistory: true });
			expect(original.searchGrabAttempts).toEqual([]);
			expect(original.searchGrabClaims).toEqual([]);
			backup = {
				version: "1.3",
				appVersion: "synthetic",
				timestamp: date.toISOString(),
				data: original,
				secrets: { encryptionKey: sourceKey, sessionCookieSecret: "synthetic-source-cookie" },
			};
		}, 30000);
		async function prepare(key = destinationKey, version: BackupFormatVersion = "1.3") {
			return prepareRestoreData({
				envelope: await encryptBackupData(
					JSON.stringify({ ...backup, version }),
					"synthetic-envelope-password",
				),
				password: "synthetic-envelope-password",
				destination: {
					encryptor: new Encryptor(key),
					installationId: "destination-installation",
					stableForRestart: true,
				},
			});
		}
		async function copyCurrent() {
			await restoreDatabase(target, original);
			const models = target as unknown as Record<
				string,
				{ createMany: (args: unknown) => Promise<unknown> }
			>;
			for (const [field, delegate] of safetyDelegates) {
				if (original[field]!.length) await models[delegate]!.createMany({ data: original[field] });
			}
			await target.session.create({
				data: { id: "destination-session", userId: "owner", expiresAt: new Date("2030-01-01") },
			});
		}
		async function snapshot() {
			return exportDatabase(target);
		}
		async function seedTrash() {
			const instance = await source.serviceInstance.findUniqueOrThrow({ where: { id: "arr" } });
			const token = createDeploymentConnectionStateToken(instance);
			await source.trashTemplate.create({
				data: {
					id: "trash-template",
					userId: "owner",
					serviceType: "RADARR",
					name: "same-title",
					configData: JSON.stringify({
						extra: { retained: true },
						completeQualityProfile: {
							sourceInstanceId: "arr",
							sourceConnectionStateToken: token,
							id: 7,
							name: "same-title",
							unknownField: [1, 2],
						},
					}),
				},
			});
			await source.templateQualityProfileMapping.create({
				data: {
					id: "trash-mapping",
					templateId: "trash-template",
					instanceId: "arr",
					qualityProfileId: 7,
					qualityProfileName: "same-title",
					connectionGeneration: instance.connectionGeneration,
					connectionStateToken: token,
					syncStrategy: "manual",
					managedCustomFormatsCaptured: true,
					managedCustomFormats: '[{"resourceId":8,"stateToken":"positive-proof"}]',
				},
			});
			await source.instanceQualityProfileOverride.create({
				data: {
					id: "trash-override",
					userId: "owner",
					instanceId: "arr",
					qualityProfileId: 7,
					customFormatId: 8,
					score: 50,
					status: "UNCERTAIN",
					intentOperation: "SET_SCORE",
					intendedScore: 60,
					connectionGeneration: instance.connectionGeneration,
					connectionStateToken: token,
				},
			});
			await source.trashBackup.create({
				data: {
					id: "trash-backup",
					userId: "owner",
					instanceId: "arr",
					backupData: JSON.stringify({
						schemaVersion: 2,
						connectionStateToken: token,
						endpointKey: createDeploymentEndpointKey("owner", {
							...instance,
							credentialIdentity: new ArrClientFactory(
								sourceEncryptor,
							).createConnectionCredentialIdentity(instance),
						}),
						customFormats: [{ id: 8, extra: true }],
						customFormatDeployments: [
							{
								action: "updated",
								beforeFormat: {
									id: 8,
									name: "synthetic",
									includeCustomFormatWhenRenaming: false,
									specifications: [],
								},
								resourceId: 8,
								name: "synthetic",
								status: "applied",
								postStateToken: "positive-proof",
								extra: true,
							},
						],
						managedCustomFormats: [
							{
								trashId: "synthetic",
								name: "synthetic",
								resourceId: 8,
								stateToken: "managed-proof",
								profileId: 7,
								appliedScore: 50,
							},
						],
						managedCustomFormatsCaptured: true,
						qualityProfileDeployment: {
							action: "updated",
							beforeProfile: {
								id: 7,
								name: "same-title",
								upgradeAllowed: true,
								cutoff: 0,
								items: [],
								minFormatScore: 0,
								cutoffFormatScore: 0,
								minUpgradeFormatScore: 0,
								formatItems: [],
							},
							profileId: 7,
							status: "pending",
							postStateToken: null,
							intendedPostStateToken: "intended-proof",
						},
						namingDeployment: {
							beforeConfig: { renameMovies: true },
							status: "pending",
							postStateToken: null,
							intendedPostStateToken: "naming-proof",
						},
						unknownEvidence: { outcome: "unknown", positive: true },
					}),
				},
			});
			await source.trashSyncHistory.create({
				data: {
					id: "trash-history",
					userId: "owner",
					instanceId: "arr",
					templateId: "trash-template",
					backupId: "trash-backup",
					syncType: "MANUAL",
					status: "PARTIAL_SUCCESS",
					appliedConfigs: "[]",
					rollbackStatus: "IN_PROGRESS",
					rollbackProgress: '{"unknown":true}',
				},
			});
			original = await exportDatabase(source, { excludeOperationalHistory: true });
			backup.data = original;
		}
		describe("Phase-C correction cleanup repeat Restore", () => {
			async function seedCleanup(kind: "approval" | "scan") {
				await source.libraryCleanupConfig.create({
					data: { id: "repeat-cleanup-config", userId: "owner", createdAt: date, updatedAt: date },
				});
				await source.libraryCleanupApproval.create({
					data: {
						id: "repeat-cleanup-approval",
						configId: "repeat-cleanup-config",
						instanceId: "arr",
						arrItemId: 7,
						itemType: "movie",
						title: "synthetic",
						matchedRuleId: "synthetic-rule",
						matchedRuleName: "synthetic",
						reason: "synthetic",
						sizeOnDisk: 17n,
						status: kind === "approval" ? "executing" : "executed",
						executionToken: kind === "approval" ? "source-cleanup-worker" : null,
						executionAuditCorrelationId: "synthetic-audit",
						safetySnapshot: '{"positive":true}',
						executedAt: kind === "scan" ? date : null,
						expiresAt: new Date("2030-01-01"),
						createdAt: date,
					},
				});
				if (kind === "scan")
					await source.libraryCleanupMediaServerScan.create({
						data: {
							id: "repeat-cleanup-scan",
							approvalId: "repeat-cleanup-approval",
							instanceId: "arr",
							service: "plex",
							mediaType: "movie",
							targetKey: "synthetic-target",
							serverIdentity: "synthetic-server",
							plannedSectionIds: '["section"]',
							status: "triggering",
							executionToken: "source-scan-worker",
							attemptCount: 2,
							completedSectionIds: '["previous-section"]',
							requestStartedAt: date,
							createdAt: date,
							updatedAt: date,
						},
					});
				original = await exportDatabase(source, { excludeOperationalHistory: true });
				backup.data = original;
				await copyCurrent();
				for (const field of ["libraryCleanupApproval", "libraryCleanupMediaServerScan"] as const)
					expect((await snapshot())[field]).toEqual(original[field]);
			}
			for (const kind of ["approval", "scan"] as const)
				for (const key of [sourceKey, destinationKey])
					for (const journal of process.env.TEST_DATABASE_URL?.startsWith("postgres")
						? ["postgres"]
						: ["DELETE", "WAL"])
						it(`repeats unchanged inert ${kind} with ${key === sourceKey ? "same" : "different"} key and ${journal}`, async () => {
							if (journal !== "postgres")
								expect(await target.$queryRawUnsafe(`PRAGMA journal_mode = ${journal}`)).toEqual([
									{ journal_mode: journal.toLowerCase() },
								]);
							await seedCleanup(kind);
							const first = await prepare(key);
							await restorePreparedDatabase(target, first, "destination-installation");
							const before = await snapshot();
							const field =
								kind === "approval" ? "libraryCleanupApproval" : "libraryCleanupMediaServerScan";
							expect(before[field]![0]).toMatchObject({
								executionToken: null,
								status: kind === "approval" ? "executing" : "triggering",
							});
							await target.$disconnect();
							await target.$connect();
							await restorePreparedDatabase(target, await prepare(key), "destination-installation");
							const after = await snapshot();
							for (const evidence of [
								"libraryCleanupApproval",
								"libraryCleanupMediaServerScan",
								"quiActionLogs",
							] as const)
								expect(after[evidence]).toEqual(before[evidence]);
							const operation = after.arrImportOperations![0] as Row;
							expect(
								new Encryptor(key).decrypt({
									value: operation.encryptedSources as string,
									iv: operation.sourcesEncryptionIv as string,
								}),
							).toBe(plaintexts[8]);
							expect(operation).toMatchObject({
								state: "unknown",
								commandId: 42,
								commandTerminal: false,
								revision: 3,
								reconcileToken: null,
							});
							expect(await target.session.count()).toBe(0);
							await rejectUnchanged(first);
						});
			for (const kind of ["approval", "scan"] as const)
				for (const change of ["claim", "target", "status", "evidence"] as const)
					it(`rejects changed ${kind} ${change} instead of replacing current evidence`, async () => {
						await seedCleanup(kind);
						await restorePreparedDatabase(target, await prepare(), "destination-installation");
						if (kind === "approval")
							await target.libraryCleanupApproval.update({
								where: { id: "repeat-cleanup-approval" },
								data:
									change === "claim"
										? { executionToken: "new-cleanup-worker" }
										: change === "target"
											? { arrItemId: 8 }
											: change === "status"
												? { status: "retry_executing" }
												: { safetySnapshot: '{"changed":true}' },
							});
						else
							await target.libraryCleanupMediaServerScan.update({
								where: { id: "repeat-cleanup-scan" },
								data: {
									...(change === "claim"
										? { executionToken: "new-scan-worker" }
										: change === "target"
											? { targetKey: "new-target" }
											: change === "status"
												? { status: "pending" }
												: { attemptCount: 3 }),
									updatedAt: date,
								},
							});
						await rejectUnchanged(await prepare());
					});
		});
		describe("caller-bound repeat Restore", () => {
			async function seedCaller(kind: "naming" | "trash" | "claimed" | "sending" | "unknown") {
				if (kind === "naming") {
					await source.namingDeployHistory.create({
						data: {
							id: "caller-naming",
							instanceId: "arr",
							userId: "owner",
							status: "SUCCESS",
							selectedPresets: "{}",
							resolvedPayload: "{}",
							previousConfig: '{"renameMovies":true}',
							changedFields: 1,
							totalFields: 1,
							deployedAt: date,
						},
					});
				} else if (kind === "trash") {
					await seedTrash();
					await source.templateDeploymentHistory.create({
						data: {
							id: "caller-undeploy",
							userId: "owner",
							instanceId: "arr",
							templateId: "trash-template",
							deployedBy: "owner",
							status: "PARTIAL_UNDEPLOY",
							canRollback: true,
							backupId: "trash-backup",
							undeployStatus: "IN_PROGRESS",
							appliedConfigs: "[]",
							templateSnapshot: null,
							deployedAt: date,
						},
					});
				} else {
					const sourceCipher = sourceEncryptor.encrypt("synthetic-label-source");
					await source.serviceInstance.create({
						data: {
							id: "caller-label-source",
							userId: "owner",
							service: "RADARR",
							label: "synthetic",
							baseUrl: "http://label-source.invalid",
							encryptedApiKey: sourceCipher.value,
							encryptionIv: sourceCipher.iv,
							createdAt: date,
							updatedAt: date,
						},
					});
					const cipher = sourceEncryptor.encrypt("synthetic-label");
					await source.serviceInstance.create({
						data: {
							id: "caller-label-instance",
							userId: "owner",
							service: "JELLYFIN",
							label: "synthetic",
							baseUrl: "http://label.invalid",
							encryptedApiKey: cipher.value,
							encryptionIv: cipher.iv,
							connectionGeneration: 2,
							identityGeneration: 3,
							expectedIdentity: "synthetic-server",
							identityKind: "JELLYFIN_SERVER_ID",
							identityStatus: "VERIFIED",
							createdAt: date,
							updatedAt: date,
						},
					});
					await source.labelSyncRule.create({
						data: {
							id: "caller-label-rule",
							userId: "owner",
							name: "synthetic",
							sourceService: "radarr",
							sourceInstanceId: "caller-label-source",
							sourceTagName: "tag",
							destService: "jellyfin",
							destInstanceId: "caller-label-instance",
							destTagName: "tag",
							createdAt: date,
							updatedAt: date,
						},
					});
					await source.labelSyncMutationAttempt.create({
						data: {
							id: "caller-label-attempt",
							userId: "owner",
							ruleId: "caller-label-rule",
							destinationInstanceId: "caller-label-instance",
							provider: "jellyfin",
							mediaType: "movie",
							tmdbId: 7,
							connectionGeneration: 2,
							identityGeneration: 3,
							targetItemId: "item",
							libraryId: "library",
							intentFingerprint: "synthetic-intent",
							ruleFingerprint: "synthetic-rule",
							destinationTag: "tag",
							activeOperationKey: "caller-durable-label-hold",
							claimToken: "source-worker",
							sendAttemptCount: kind === "claimed" ? 0 : 1,
							reconcileAttemptCount: kind === "unknown" ? 1 : 0,
							requestStartedAt: kind === "claimed" ? null : date,
							status: kind,
							reasonCode: kind === "unknown" ? "uncertain_send" : null,
							createdAt: date,
							updatedAt: date,
						},
					});
				}
				original = await exportDatabase(source, { excludeOperationalHistory: true });
				backup.data = original;
			}
			for (const kind of ["naming", "trash", "claimed", "sending", "unknown"] as const)
				for (const key of [sourceKey, destinationKey])
					for (const journal of process.env.TEST_DATABASE_URL?.startsWith("postgres")
						? ["postgres"]
						: ["DELETE", "WAL"])
						it(`repeats older ${kind} evidence with ${key === sourceKey ? "same" : "different"} key and ${journal}`, async () => {
							if (journal !== "postgres")
								expect(await target.$queryRawUnsafe(`PRAGMA journal_mode = ${journal}`)).toEqual([
									{ journal_mode: journal.toLowerCase() },
								]);
							await seedCaller(kind);
							await copyCurrent();
							if (kind !== "naming" && kind !== "trash") {
								// The legacy fixture copy clears unknown-worker tokens.
								// Seed the actual captured current row before testing the
								// genuine prepared boundary, and prove no other difference.
								await target.labelSyncMutationAttempt.update({
									where: { id: "caller-label-attempt" },
									data: { claimToken: "source-worker", updatedAt: date },
								});
								expect((await snapshot()).labelSyncMutationAttempts).toEqual(
									original.labelSyncMutationAttempts,
								);
							}
							const first = await prepare(key);
							await restorePreparedDatabase(target, first, "destination-installation");
							const before = await snapshot();
							if (kind !== "naming" && kind !== "trash")
								expect(before.labelSyncMutationAttempts![0]).toMatchObject({
									status: "restored-held",
									claimToken: null,
									reasonCode: "restore_uncertain",
									activeOperationKey: "caller-durable-label-hold",
									sendAttemptCount: kind === "claimed" ? 0 : 1,
									reconcileAttemptCount: kind === "unknown" ? 1 : 0,
								});
							await target.$disconnect();
							await target.$connect();
							await restorePreparedDatabase(target, await prepare(key), "destination-installation");
							const after = await snapshot();
							for (const field of [
								"namingDeployHistory",
								"trashSyncHistory",
								"templateDeploymentHistory",
								"labelSyncMutationAttempts",
								"arrImportFileProofs",
								"arrImportSourceClaims",
								"quiActionLogs",
								"quiActionClaims",
							] as const)
								expect(after[field]).toEqual(before[field]);
							if (kind === "trash") {
								const instance = await target.serviceInstance.findUniqueOrThrow({
									where: { id: "arr" },
								});
								const state = JSON.parse((after.trashBackups![0] as Row).backupData as string);
								expect(
									isDeploymentBackupEndpointIdentityCurrent({
										userId: "owner",
										instance,
										backupEndpointKey: state.endpointKey,
										backupConnectionStateToken: state.connectionStateToken,
										credentialIdentity: new ArrClientFactory(
											new Encryptor(key),
										).createConnectionCredentialIdentity(instance),
									}),
								).toBe(true);
								expect(state.unknownEvidence).toEqual({ outcome: "unknown", positive: true });
								expect(state.namingDeployment.status).toBe("pending");
								expect(state.qualityProfileDeployment.status).toBe("pending");
								for (const field of [
									"templateQualityProfileMappings",
									"instanceQualityProfileOverrides",
								] as const)
									expect(
										isCurrentDeploymentConnectionMapping(after[field]![0] as never, [
											createDeploymentConnectionBinding(instance),
										]),
									).toBe(true);
							}
							expect(await target.session.count()).toBe(0);
							await rejectUnchanged(first);
						});

			const negativeCases = [
				["naming", "rollback configuration"],
				["trash", "score intent"],
				["trash", "score connection binding"],
				["trash", "endpoint identity"],
				["trash", "resource proof"],
				["trash", "unknown recovery evidence"],
				["trash", "fallback clone binding"],
				["trash", "fallback clone source"],
				["trash", "fallback unknown configuration"],
				["trash", "undeploy progress"],
				["sending", "label target"],
				["sending", "label rule tag"],
				["sending", "label source selection"],
				["sending", "label source credential"],
				["sending", "label destination credential"],
				["sending", "label acquired worker claim"],
			] as const;
			for (const [kind, change] of negativeCases)
				it(`rejects older backup after changed ${change} without replacing current evidence`, async () => {
					await seedCaller(kind);
					await copyCurrent();
					await restorePreparedDatabase(target, await prepare(), "destination-installation");
					if (change === "rollback configuration") {
						await target.namingDeployHistory.update({
							where: { id: "caller-naming" },
							data: { previousConfig: '{"renameMovies":false}' },
						});
					} else if (change === "score intent" || change === "score connection binding") {
						const row = await target.instanceQualityProfileOverride.findUniqueOrThrow({
							where: { id: "trash-override" },
						});
						const changed =
							change === "score intent" ? { intendedScore: 61 } : { connectionStateToken: "stale" };
						await target.instanceQualityProfileOverride.update({
							where: { id: row.id },
							data: { ...changed, updatedAt: row.updatedAt },
						});
						expect(
							await target.instanceQualityProfileOverride.findUniqueOrThrow({
								where: { id: row.id },
							}),
						).toEqual({ ...row, ...changed });
					} else if (
						["endpoint identity", "resource proof", "unknown recovery evidence"].includes(change)
					) {
						const row = await target.trashBackup.findUniqueOrThrow({
							where: { id: "trash-backup" },
						});
						const state = JSON.parse(row.backupData);
						if (change === "endpoint identity") state.endpointKey = "different-endpoint";
						else if (change === "resource proof")
							state.customFormatDeployments[0].postStateToken = "different-proof";
						else state.unknownEvidence.positive = false;
						await target.trashBackup.update({
							where: { id: row.id },
							data: { backupData: JSON.stringify(state) },
						});
					} else if (change.startsWith("fallback")) {
						const row = await target.trashTemplate.findUniqueOrThrow({
							where: { id: "trash-template" },
						});
						const config = JSON.parse(row.configData);
						if (change === "fallback clone binding")
							config.completeQualityProfile.sourceConnectionStateToken = "stale";
						else if (change === "fallback clone source")
							config.completeQualityProfile.sourceInstanceId = "other-source";
						else config.extra.retained = false;
						await target.trashTemplate.update({
							where: { id: row.id },
							data: { configData: JSON.stringify(config), updatedAt: row.updatedAt },
						});
					} else if (change === "undeploy progress") {
						await target.templateDeploymentHistory.update({
							where: { id: "caller-undeploy" },
							data: { undeployProgress: '[{"resourceId":8,"status":"unknown"}]' },
						});
					} else if (change === "label target" || change === "label acquired worker claim") {
						const row = await target.labelSyncMutationAttempt.findUniqueOrThrow({
							where: { id: "caller-label-attempt" },
						});
						const changed =
							change === "label target"
								? { targetItemId: "different-target" }
								: { claimToken: "new-worker", reconcileAttemptCount: 1 };
						await target.labelSyncMutationAttempt.update({
							where: { id: row.id },
							data: { ...changed, updatedAt: row.updatedAt },
						});
						expect(
							await target.labelSyncMutationAttempt.findUniqueOrThrow({ where: { id: row.id } }),
						).toEqual({ ...row, ...changed });
					} else if (change === "label rule tag" || change === "label source selection") {
						const row = await target.labelSyncRule.findUniqueOrThrow({
							where: { id: "caller-label-rule" },
						});
						const changed =
							change === "label rule tag"
								? { sourceTagName: "different-tag" }
								: { sourceInstanceId: "arr" };
						await target.labelSyncRule.update({
							where: { id: row.id },
							data: { ...changed, updatedAt: row.updatedAt },
						});
						expect(await target.labelSyncRule.findUniqueOrThrow({ where: { id: row.id } })).toEqual(
							{ ...row, ...changed },
						);
					} else {
						const id =
							change === "label source credential"
								? "caller-label-source"
								: "caller-label-instance";
						const row = await target.serviceInstance.findUniqueOrThrow({ where: { id } });
						const cipher = destination.encrypt("different-credential");
						const changed = { encryptedApiKey: cipher.value, encryptionIv: cipher.iv };
						await target.serviceInstance.update({
							where: { id },
							data: { ...changed, updatedAt: row.updatedAt },
						});
						expect(await target.serviceInstance.findUniqueOrThrow({ where: { id } })).toEqual({
							...row,
							...changed,
						});
					}
					await rejectUnchanged(await prepare());
					expect(await target.session.count()).toBe(0);
				});

			for (const legacy of ["score", "clone"] as const)
				it(`repeats a legacy-unbound ${legacy} without inventing connection authority`, async () => {
					await seedCaller("trash");
					if (legacy === "score") {
						await source.instanceQualityProfileOverride.update({
							where: { id: "trash-override" },
							data: { connectionGeneration: 0, connectionStateToken: null },
						});
					} else {
						const row = await source.trashTemplate.findUniqueOrThrow({
							where: { id: "trash-template" },
						});
						const config = JSON.parse(row.configData);
						delete config.completeQualityProfile.sourceConnectionStateToken;
						await source.trashTemplate.update({
							where: { id: row.id },
							data: { configData: JSON.stringify(config) },
						});
					}
					original = await exportDatabase(source, { excludeOperationalHistory: true });
					backup.data = original;
					await copyCurrent();
					await restorePreparedDatabase(target, await prepare(), "destination-installation");
					await target.$disconnect();
					await target.$connect();
					await restorePreparedDatabase(target, await prepare(), "destination-installation");
					if (legacy === "score")
						expect(
							await target.instanceQualityProfileOverride.findUniqueOrThrow({
								where: { id: "trash-override" },
							}),
						).toMatchObject({
							connectionGeneration: 0,
							connectionStateToken: null,
							status: "UNCERTAIN",
						});
					else {
						const row = await target.trashTemplate.findUniqueOrThrow({
							where: { id: "trash-template" },
						});
						expect(row.configData).toBe((original.trashTemplates![0] as Row).configData);
						expect(
							JSON.parse(row.configData).completeQualityProfile.sourceConnectionStateToken,
						).toBeUndefined();
					}
				});
		});
		for (const key of [sourceKey, destinationKey])
			it(`restores usable TRaSH consumers and exact recovery evidence with ${key === sourceKey ? "same" : "different"} key`, async () => {
				await seedTrash();
				await copyCurrent();
				const prepared = await prepare(key);
				await restorePreparedDatabase(target, prepared, "destination-installation");
				const restored = await snapshot();
				const instance = await target.serviceInstance.findUniqueOrThrow({ where: { id: "arr" } });
				for (const field of [
					"templateQualityProfileMappings",
					"instanceQualityProfileOverrides",
				] as const) {
					const row = restored[field]![0] as Row;
					expect
						.soft(
							isCurrentDeploymentConnectionMapping(row as never, [
								createDeploymentConnectionBinding(instance),
							]),
						)
						.toBe(true);
					expect({ ...row, connectionStateToken: null }).toEqual({
						...(original[field]![0] as Row),
						connectionStateToken: null,
					});
				}
				const state = JSON.parse((restored.trashBackups![0] as Row).backupData as string);
				expect
					.soft(
						isDeploymentBackupEndpointIdentityCurrent({
							userId: "owner",
							instance,
							backupEndpointKey: state.endpointKey,
							backupConnectionStateToken: state.connectionStateToken,
							credentialIdentity: new ArrClientFactory(
								new Encryptor(key),
							).createConnectionCredentialIdentity(instance),
						}),
					)
					.toBe(true);
				const before = JSON.parse((original.trashBackups![0] as Row).backupData as string);
				expect({ ...state, connectionStateToken: null, endpointKey: null }).toEqual({
					...before,
					connectionStateToken: null,
					endpointKey: null,
				});
				const config = JSON.parse((restored.trashTemplates![0] as Row).configData as string);
				const beforeConfig = JSON.parse((original.trashTemplates![0] as Row).configData as string);
				expect({
					...config,
					completeQualityProfile: {
						...config.completeQualityProfile,
						sourceConnectionStateToken: null,
					},
				}).toEqual({
					...beforeConfig,
					completeQualityProfile: {
						...beforeConfig.completeQualityProfile,
						sourceConnectionStateToken: null,
					},
				});
				expect(restored.trashSyncHistory).toEqual(original.trashSyncHistory);
				expect(await target.session.count()).toBe(0);
				expect(
					isVerifiedClonedProfileSourceConnection({
						...config.completeQualityProfile,
						sourceInstance: instance,
						equivalentInstanceIds: [instance.id],
					}),
				).toBe(true);
			});
		for (const [name, mutate] of [
			[
				"stale mapping",
				(data: BackupData["data"]) => {
					(data.templateQualityProfileMappings![0] as Row).connectionStateToken = "stale";
				},
			],
			[
				"cross-owner override",
				(data: BackupData["data"]) => {
					(data.instanceQualityProfileOverrides![0] as Row).userId = "other";
				},
			],
			[
				"missing resource proof",
				(data: BackupData["data"]) => {
					const row = data.trashBackups![0] as Row;
					const state = JSON.parse(row.backupData as string);
					state.customFormatDeployments[0].postStateToken = null;
					row.backupData = JSON.stringify(state);
				},
			],
			[
				"stale clone",
				(data: BackupData["data"]) => {
					const row = data.trashTemplates![0] as Row;
					const config = JSON.parse(row.configData as string);
					config.completeQualityProfile.sourceConnectionStateToken = "stale";
					row.configData = JSON.stringify(config);
				},
			],
		] as const)
			it(`refuses mixed valid import/TRaSH state with ${name} before mutation`, async () => {
				await seedTrash();
				await copyCurrent();
				const before = await snapshot();
				mutate(original);
				await expect(prepare()).rejects.toMatchObject({ category: "invalid-binding" });
				expect(await snapshot()).toEqual(before);
			});
		async function rejectUnchanged(
			prepared: PreparedRestoreData,
			id = "destination-installation",
			prisma = target,
		) {
			const before = await snapshot();
			const error = await restorePreparedDatabase(prisma, prepared, id).catch((failure) => failure);
			expect(error).toBeInstanceOf(BackupCompatibilityError);
			expect(error).not.toHaveProperty("cause");
			expect(await snapshot()).toEqual(before);
		}
		for (const key of [destinationKey, sourceKey])
			it(`conserves complete original state and all nine credentials under ${key === sourceKey ? "same" : "different"} key`, async () => {
				await copyCurrent();
				const prepared = await prepare(key);
				await restorePreparedDatabase(target, prepared, "destination-installation");
				const restored = await snapshot();
				const encryptor = new Encryptor(key);
				expect(restored.searchGrabAttempts).toEqual([]);
				expect(restored.searchGrabClaims).toEqual([]);
				for (const pair of legacyEncryptedFieldExpectations) {
					const row = restored[pair.payloadField]!.find((entry) => entry.id === pair.id) as Row;
					expect(
						encryptor.decrypt({
							value: row[pair.valueField] as string,
							iv: row[pair.ivField] as string,
						}),
					).toBe(pair.plaintext);
					expect(row[pair.ivField]).not.toBe(
						(original[pair.payloadField]!.find((entry) => (entry as Row).id === pair.id) as Row)[
							pair.ivField
						],
					);
				}
				for (const field of [
					"arrImportFileProofs",
					"arrImportSourceClaims",
					"quiActionLogs",
					"quiActionClaims",
				] as const)
					expect(restored[field]).toEqual(original[field]);
				expect(restored.arrImportOperations![0]).toMatchObject({
					id: "operation",
					state: "unknown",
					commandId: 42,
					revision: 3,
					reconcileToken: null,
					reconcileExpiresAt: null,
				});
				expect(restored.queueCleanerImportReceipts![0]).toMatchObject({
					id: "receipt",
					state: "unknown",
					commandId: 42,
				});
				expect(await target.session.count()).toBe(0);
				expect(
					await verifyPassword(
						"synthetic-restored-password",
						(await target.user.findUniqueOrThrow({ where: { id: "owner" } })).hashedPassword!,
					),
				).toBe(true);
				expect(restored.oidcAccounts).toEqual(original.oidcAccounts);
				expect(restored.webAuthnCredentials).toEqual(original.webAuthnCredentials);
			});
		for (const key of [destinationKey, sourceKey])
			for (const journal of process.env.TEST_DATABASE_URL?.startsWith("postgres")
				? ["postgres"]
				: ["DELETE", "WAL"])
				it(`repeats an older authenticated backup after reconnect with ${key === sourceKey ? "same" : "different"} key and ${journal}`, async () => {
					if (journal !== "postgres") {
						const result = await target.$queryRawUnsafe(`PRAGMA journal_mode = ${journal}`);
						expect(result).toEqual([{ journal_mode: journal.toLowerCase() }]);
					}
					await copyCurrent();
					const first = await prepare(key);
					await restorePreparedDatabase(target, first, "destination-installation");
					const prior = await snapshot();
					await target.$disconnect();
					await target.$connect();
					await target.session.create({
						data: { id: "recovered-session", userId: "owner", expiresAt: new Date("2030-01-01") },
					});
					// Fresh authentication/preparation of the OLD source envelope, not
					// a replacement backup exported from the already-translated target.
					const retry = await prepare(key);
					await restorePreparedDatabase(target, retry, "destination-installation");
					const restored = await snapshot();
					const encryptor = new Encryptor(key);
					expect(restored.searchGrabAttempts).toEqual([]);
					expect(restored.searchGrabClaims).toEqual([]);
					for (const pair of legacyEncryptedFieldExpectations) {
						const row = restored[pair.payloadField]!.find((entry) => entry.id === pair.id) as Row;
						expect(
							encryptor.decrypt({
								value: row[pair.valueField] as string,
								iv: row[pair.ivField] as string,
							}),
						).toBe(pair.plaintext);
						expect(row[pair.ivField]).not.toBe(
							(prior[pair.payloadField]!.find((entry) => entry.id === pair.id) as Row)[
								pair.ivField
							],
						);
					}
					for (const field of [
						"arrImportFileProofs",
						"arrImportSourceClaims",
						"quiActionLogs",
						"quiActionClaims",
					] as const)
						expect(restored[field]).toEqual(prior[field]);
					expect(restored.arrImportOperations![0]).toMatchObject({
						id: "operation",
						state: "unknown",
						commandId: 42,
						revision: 3,
						reconcileToken: null,
						reconcileExpiresAt: null,
					});
					expect(restored.queueCleanerImportReceipts![0]).toMatchObject({
						id: "receipt",
						state: "unknown",
						commandId: 42,
					});
					const arr = await target.serviceInstance.findUniqueOrThrow({ where: { id: "arr" } });
					expect((restored.arrImportOperations![0] as Row).connectionFingerprint).toBe(
						importConnectionFingerprint(arr),
					);
					expect((restored.queueCleanerImportReceipts![0] as Row).connectionFingerprint).toBe(
						importConnectionFingerprint(arr),
					);
					expect(await target.session.count()).toBe(0);
					await rejectUnchanged(first);
					await rejectUnchanged(retry);
				});
		for (const kind of [
			"api-credential",
			"http-auth",
			"http-auth-removed",
			"malformed-credential",
			"noncanonical-credential",
			"lookup",
			"owner",
			"provider",
			"url",
			"generation",
			"storage",
			"identity",
			"receipt-command",
			"operation-state",
			"source-claim",
			"qUI-target",
			"stale-fingerprint",
			"new-worker-lease",
		] as const)
			it(`refuses repeat Restore after ${kind} changes and preserves recovered state`, async () => {
				await copyCurrent();
				await restorePreparedDatabase(target, await prepare(), "destination-installation");
				await target.session.create({
					data: { id: "recovered-session", userId: "owner", expiresAt: new Date("2030-01-01") },
				});
				if (
					[
						"api-credential",
						"http-auth",
						"http-auth-removed",
						"malformed-credential",
						"noncanonical-credential",
						"provider",
						"url",
						"generation",
						"storage",
						"identity",
						"owner",
					].includes(kind)
				) {
					const encrypted = destination.encrypt("synthetic-changed-credential");
					const current = await target.serviceInstance.findUniqueOrThrow({ where: { id: "arr" } });
					if (kind === "owner")
						await target.user.create({ data: { id: "other-owner", username: "synthetic-other" } });
					const changes: Prisma.ServiceInstanceUpdateInput =
						kind === "api-credential"
							? { encryptedApiKey: encrypted.value, encryptionIv: encrypted.iv }
							: kind === "http-auth"
								? {
										encryptedHttpAuthCredentials: encrypted.value,
										httpAuthEncryptionIv: encrypted.iv,
									}
								: kind === "http-auth-removed"
									? { encryptedHttpAuthCredentials: null, httpAuthEncryptionIv: null }
									: kind === "malformed-credential"
										? { encryptedApiKey: "malformed" }
										: kind === "noncanonical-credential"
											? { encryptedApiKey: current.encryptedApiKey + "\n" }
											: kind === "owner"
												? { user: { connect: { id: "other-owner" } } }
												: kind === "provider"
													? { service: "SONARR" }
													: kind === "url"
														? { baseUrl: "http://different.invalid" }
														: kind === "generation"
															? { connectionGeneration: 1 }
															: kind === "storage"
																? { storageGroupId: "changed-storage" }
																: { expectedIdentity: "changed-identity" };
					const changed = await target.serviceInstance.update({
						where: { id: "arr" },
						data: { ...changes, updatedAt: date },
					});
					// Keep each current hold bound to its ACTUAL current connection;
					// stale fingerprints cannot be the reason this negative passes.
					const connectionFingerprint = importConnectionFingerprint(changed);
					const beforeOperation = await target.arrImportOperation.findUniqueOrThrow({
						where: { id: "operation" },
					});
					const beforeReceipt = await target.queueCleanerImportReceipt.findUniqueOrThrow({
						where: { id: "receipt" },
					});
					const operation = await target.arrImportOperation.update({
						where: { id: "operation" },
						data: { connectionFingerprint, updatedAt: date },
					});
					const receipt = await target.queueCleanerImportReceipt.update({
						where: { id: "receipt" },
						data: { connectionFingerprint, updatedAt: date },
					});
					expect(operation).toEqual({ ...beforeOperation, connectionFingerprint });
					expect(receipt).toEqual({ ...beforeReceipt, connectionFingerprint });
				} else if (kind === "lookup") {
					const encrypted = destination.encrypt(
						JSON.stringify({ version: 1, service: "radarr", files: [{ ...file, movieId: 99 }] }),
					);
					await target.arrImportOperation.update({
						where: { id: "operation" },
						data: {
							encryptedSources: encrypted.value,
							sourcesEncryptionIv: encrypted.iv,
							updatedAt: date,
						},
					});
				} else if (kind === "receipt-command")
					await target.queueCleanerImportReceipt.update({
						where: { id: "receipt" },
						data: { commandId: 99, updatedAt: date },
					});
				else if (kind === "operation-state")
					await target.arrImportOperation.update({
						where: { id: "operation" },
						data: { state: "submitted", commandState: "queued", updatedAt: date },
					});
				else if (kind === "source-claim")
					await target.arrImportSourceClaim.update({
						where: { id: "claim" },
						data: { downloadKey: "changed-source", updatedAt: date },
					});
				else if (kind === "qUI-target")
					await target.quiActionLog.update({
						where: { id: "qui-log" },
						data: { qbitInstanceId: 2 },
					});
				else if (kind === "new-worker-lease")
					await target.arrImportOperation.update({
						where: { id: "operation" },
						data: { reconcileToken: "new-worker", reconcileExpiresAt: date, updatedAt: date },
					});
				else
					await target.queueCleanerImportReceipt.update({
						where: { id: "receipt" },
						data: { connectionFingerprint: "stale-fingerprint", updatedAt: date },
					});
				await rejectUnchanged(await prepare());
				expect(await target.session.count()).toBe(1);
			});
		describe("runtime-marked prepared Restore", () => {
			const epoch = "11111111-1111-4111-8111-111111111111";
			const restoreId = "22222222-2222-4222-8222-222222222222";
			const older = "33333333-3333-4333-8333-333333333333";
			function context(): RestoreRuntimeCommitRequest {
				return {
					runtimeEpoch: epoch,
					restoreId,
					destinationInstallationId: "destination-installation",
					committedAt: "2026-10-07T12:00:00.000Z",
				};
			}
			async function seedRuntime() {
				return target.restoreRuntimeControl.create({
					data: {
						id: 1,
						protocolVersion: 1,
						phase: "restore-pending",
						runtimeEpoch: epoch,
						ownerBackendPid: null,
						activeRestoreId: restoreId,
						lastCommittedRestoreId: older,
						lastCommittedAt: date,
						destinationInstallationId: "destination-installation",
					},
				});
			}
			function transactionBoundary(
				enter: (tx: Prisma.TransactionClient) => Promise<Prisma.TransactionClient>,
				leave?: (tx: Prisma.TransactionClient) => Promise<void>,
			): PrismaClient {
				const transaction = target.$transaction.bind(target);
				return new Proxy(target, {
					get(client, property) {
						if (property === "$transaction")
							return (
								operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
								options: unknown,
							) =>
								transaction(async (tx) => {
									const result = await operation(await enter(tx));
									await leave?.(tx);
									return result;
								}, options as never);
						const value = Reflect.get(client, property);
						return typeof value === "function" ? value.bind(client) : value;
					},
				}) as PrismaClient;
			}
			async function rejectRuntimeUnchanged(
				prepared: PreparedRestoreData,
				request: RestoreRuntimeCommitRequest,
				client = target,
			) {
				const before = await snapshot();
				const journal = await target.restoreRuntimeControl.findMany();
				const sessions = await target.session.findMany({ orderBy: { id: "asc" } });
				const error = await restorePreparedDatabase(
					client,
					prepared,
					"destination-installation",
					request,
				).catch((failure) => failure);
				expect(error).toBeInstanceOf(BackupCompatibilityError);
				expect(error).not.toHaveProperty("cause");
				expect(await snapshot()).toEqual(before);
				expect(await target.restoreRuntimeControl.findMany()).toEqual(journal);
				expect(await target.session.findMany({ orderBy: { id: "asc" } })).toEqual(sessions);
			}

			it("commits translated records, revoked sessions and the matching journal marker together", async () => {
				await copyCurrent();
				await seedRuntime();
				await restorePreparedDatabase(
					target,
					await prepare(),
					"destination-installation",
					context(),
				);
				expect(await target.restoreRuntimeControl.findUnique({ where: { id: 1 } })).toEqual({
					id: 1,
					protocolVersion: 1,
					phase: "restart-required",
					runtimeEpoch: epoch,
					ownerBackendPid: null,
					activeRestoreId: restoreId,
					lastCommittedRestoreId: restoreId,
					lastCommittedAt: new Date("2026-10-07T12:00:00.000Z"),
					destinationInstallationId: "destination-installation",
				});
				const restored = await snapshot();
				expect(restored.searchGrabAttempts).toEqual([]);
				expect(restored.searchGrabClaims).toEqual([]);
				for (const pair of legacyEncryptedFieldExpectations) {
					const row = restored[pair.payloadField]!.find((entry) => entry.id === pair.id) as Row;
					expect(
						destination.decrypt({
							value: row[pair.valueField] as string,
							iv: row[pair.ivField] as string,
						}),
					).toBe(pair.plaintext);
				}
				expect(await target.session.count()).toBe(0);
				expect(restored.arrImportFileProofs).toEqual(original.arrImportFileProofs);
				expect(restored.quiActionLogs).toEqual(original.quiActionLogs);
			});
			it("refuses a missing journal without creating one or opening a destructive transaction", async () => {
				await copyCurrent();
				let entered = false;
				const observed = transactionBoundary(async (tx) => {
					entered = true;
					return tx;
				});
				await rejectRuntimeUnchanged(await prepare(), context(), observed);
				expect(entered).toBe(false);
			});
			it.each([
				["epoch", { runtimeEpoch: older }],
				["Restore ID", { restoreId: older }],
				["installation", { destinationInstallationId: "other-installation" }],
				["timestamp", { committedAt: "not-a-date" }],
			])(
				"refuses stale or malformed request %s before opening a transaction",
				async (_label, changed) => {
					await copyCurrent();
					await seedRuntime();
					let entered = false;
					const observed = transactionBoundary(async (tx) => {
						entered = true;
						return tx;
					});
					await rejectRuntimeUnchanged(await prepare(), { ...context(), ...changed }, observed);
					expect(entered).toBe(false);
				},
			);
			it("refuses a runtime installation that matches the journal but not the prepared destination", async () => {
				await copyCurrent();
				await seedRuntime();
				await target.restoreRuntimeControl.update({
					where: { id: 1 },
					data: { destinationInstallationId: "other-installation" },
				});
				await rejectRuntimeUnchanged(await prepare(), {
					...context(),
					destinationInstallationId: "other-installation",
				});
			});
			it("refuses malformed persisted runtime phase without erasing any rows", async () => {
				await copyCurrent();
				await seedRuntime();
				await target.restoreRuntimeControl.update({
					where: { id: 1 },
					data: { phase: "fixture-invalid" },
				});
				await rejectRuntimeUnchanged(await prepare(), context());
			});
			it.each([
				["epoch", { runtimeEpoch: older }],
				["Restore ID", { activeRestoreId: older }],
				["installation", { destinationInstallationId: "other-installation" }],
			])("rechecks %s inside the transaction before deleting data", async (_label, changed) => {
				await copyCurrent();
				await seedRuntime();
				let entered = false;
				const barrier = transactionBoundary(async (tx) => {
					entered = true;
					await tx.restoreRuntimeControl.update({ where: { id: 1 }, data: changed });
					return tx;
				});
				await rejectRuntimeUnchanged(await prepare(), context(), barrier);
				expect(entered).toBe(true);
			});
			it.each([
				["epoch", { runtimeEpoch: older }],
				["Restore ID", { activeRestoreId: older }],
				["installation", { destinationInstallationId: "other-installation" }],
				["phase", { phase: "running", activeRestoreId: null }],
				["query failure", null],
			])(
				"rolls back replacement rows and sessions after late marker %s failure",
				async (_label, changed) => {
					await copyCurrent();
					await seedRuntime();
					let markerReached = false;
					let atMarker:
						| { sessions: number; translatedCredential: string; heldClaims: number }
						| undefined;
					const failing = transactionBoundary(
						async (tx) =>
							new Proxy(tx, {
								get(inner, property) {
									if (property === "restoreRuntimeControl")
										return new Proxy(inner.restoreRuntimeControl, {
											get(delegate, method) {
												if (method === "updateMany")
													return async (args: Prisma.RestoreRuntimeControlUpdateManyArgs) => {
														markerReached = true;
														const row = await tx.user.findUniqueOrThrow({ where: { id: "owner" } });
														atMarker = {
															sessions: await tx.session.count(),
															translatedCredential: destination.decrypt({
																value: row.encryptedTmdbApiKey!,
																iv: row.tmdbEncryptionIv!,
															}),
															heldClaims: await tx.quiActionClaim.count(),
														};
														if (changed === null)
															throw new Error("synthetic-private-marker-query-failure");
														await tx.restoreRuntimeControl.update({
															where: { id: 1 },
															data: changed,
														});
														return delegate.updateMany(args);
													};
												return Reflect.get(delegate, method);
											},
										});
									return Reflect.get(inner, property);
								},
							}),
					);
					await rejectRuntimeUnchanged(await prepare(), context(), failing);
					expect(markerReached).toBe(true);
					// Assertions stay outside the expected failure catch; a broken
					// transaction order must not masquerade as safe marker refusal.
					expect(atMarker).toEqual({
						sessions: 0,
						translatedCredential: "synthetic-tmdb",
						heldClaims: 1,
					});
				},
			);
			it("rolls back a successfully written marker when the surrounding transaction aborts", async () => {
				await copyCurrent();
				await seedRuntime();
				let markerSeen = false;
				const failing = transactionBoundary(
					async (tx) => tx,
					async (tx) => {
						const journal = await tx.restoreRuntimeControl.findUniqueOrThrow({ where: { id: 1 } });
						expect(journal.phase).toBe("restart-required");
						expect(journal.lastCommittedRestoreId).toBe(restoreId);
						markerSeen = true;
						throw new Error("synthetic-after-marker-before-commit");
					},
				);
				await rejectRuntimeUnchanged(await prepare(), context(), failing);
				expect(markerSeen).toBe(true);
			});
			it("preserves destination storage binding when the completed replacement transaction aborts", async () => {
				await copyCurrent();
				await seedRuntime();
				await target.sqliteRestoreStorageBinding.create({ data: destinationStorageBinding });
				let markerSeen = false;
				const failing = transactionBoundary(
					async (tx) => tx,
					async (tx) => {
						const journal = await tx.restoreRuntimeControl.findUniqueOrThrow({ where: { id: 1 } });
						markerSeen =
							journal.phase === "restart-required" && journal.lastCommittedRestoreId === restoreId;
						throw new Error("synthetic-after-marker-before-commit");
					},
				);
				await rejectRuntimeUnchanged(await prepare(), context(), failing);
				expect(markerSeen).toBe(true);
				expect(await target.sqliteRestoreStorageBinding.findMany()).toEqual([
					destinationStorageBinding,
				]);
			});
			it.each(["cast", "incomplete format", "omitted action evidence"])(
				"does not let runtime evidence bypass %s",
				async (kind) => {
					await copyCurrent();
					await seedRuntime();
					let prepared = await prepare();
					if (kind === "cast") prepared = { ...prepared };
					if (kind === "incomplete format") prepared = await prepare(destinationKey, "1.2");
					if (kind === "omitted action evidence") {
						backup.data = structuredClone(original);
						backup.data.arrImportSourceClaims = [];
						prepared = await prepare();
					}
					await rejectRuntimeUnchanged(prepared, context());
				},
			);
			it("binds one primitive runtime context despite caller mutation after preflight", async () => {
				await copyCurrent();
				await seedRuntime();
				const committedAt = new Date("2026-10-07T12:00:00.000Z");
				const request = { ...context(), committedAt };
				const barrier = transactionBoundary(async (tx) => {
					request.restoreId = older;
					request.runtimeEpoch = older;
					committedAt.setTime(date.getTime());
					return tx;
				});
				await restorePreparedDatabase(
					barrier,
					await prepare(),
					"destination-installation",
					request,
				);
				expect(await target.restoreRuntimeControl.findUnique({ where: { id: 1 } })).toMatchObject({
					phase: "restart-required",
					runtimeEpoch: epoch,
					activeRestoreId: restoreId,
					lastCommittedRestoreId: restoreId,
					lastCommittedAt: new Date("2026-10-07T12:00:00.000Z"),
				});
			});
		});

		it("excludes source runtime state and preserves destination journal and storage binding across prepared Restore", async () => {
			await source.sqliteRestoreStorageBinding.create({ data: sourceStorageBinding });
			await source.restoreRuntimeControl.create({
				data: {
					id: 1,
					protocolVersion: 1,
					phase: "idle",
					destinationInstallationId: "source-journal-installation",
				},
			});
			original = await exportDatabase(source, { excludeOperationalHistory: true });
			backup.data = original;
			expect(Reflect.get(original, "restoreRuntimeControl")).toBeUndefined();
			expect(Reflect.get(original, "sqliteRestoreStorageBinding")).toBeUndefined();
			expect(JSON.stringify(original)).not.toContain("9010001");
			expect(JSON.stringify(original)).not.toContain("source-journal-installation");
			await copyCurrent();
			await target.sqliteRestoreStorageBinding.create({ data: destinationStorageBinding });
			const journal = await target.restoreRuntimeControl.create({
				data: {
					id: 1,
					protocolVersion: 1,
					phase: "restore-pending",
					runtimeEpoch: "11111111-1111-4111-8111-111111111111",
					activeRestoreId: "22222222-2222-4222-8222-222222222222",
					lastCommittedRestoreId: "33333333-3333-4333-8333-333333333333",
					lastCommittedAt: date,
					destinationInstallationId: "destination-installation",
				},
			});
			await target.historyCollectionLease.create({
				data: { userId: "owner", claimToken: "old-history-worker" },
			});
			await target.libraryCleanupMediaServerScanLease.create({
				data: { operationKey: "old-scan", userId: "owner", executionToken: "old-scan-worker" },
			});
			await restorePreparedDatabase(
				target,
				await prepare(destinationKey, "1.4"),
				"destination-installation",
			);
			expect(await target.restoreRuntimeControl.findUnique({ where: { id: 1 } })).toEqual(journal);
			expect(await target.sqliteRestoreStorageBinding.findMany()).toEqual([
				destinationStorageBinding,
			]);
			expect(await target.historyCollectionLease.count()).toBe(0);
			expect(await target.libraryCleanupMediaServerScanLease.count()).toBe(0);
			expect(await target.session.count()).toBe(0);
		});

		it("preserves destination storage binding despite forged imported coordination properties", async () => {
			await copyCurrent();
			await target.sqliteRestoreStorageBinding.create({ data: destinationStorageBinding });
			// Unknown source fields remain data, never a destination-authority input.
			Object.assign(backup.data, {
				SqliteRestoreStorageBinding: [sourceStorageBinding],
				sqliteRestoreStorageBinding: [sourceStorageBinding],
				sqliteRestoreStorageBindings: [sourceStorageBinding],
			});
			await restorePreparedDatabase(
				target,
				await prepare(destinationKey, "1.4"),
				"destination-installation",
			);
			expect(await target.sqliteRestoreStorageBinding.findMany()).toEqual([
				destinationStorageBinding,
			]);
			expect(await target.session.count()).toBe(0);
			expect(await target.user.count({ where: { id: "owner" } })).toBe(1);
			const restored = await target.serviceInstance.findUniqueOrThrow({ where: { id: "arr" } });
			expect(
				destination.decrypt({ value: restored.encryptedApiKey, iv: restored.encryptionIv }),
			).toBe("synthetic-api");
		});

		it("rejects cast, incomplete legacy and wrong destination before any write", async () => {
			await copyCurrent();
			const prepared = await prepare();
			await rejectUnchanged({ ...prepared });
			await rejectUnchanged(await prepare(destinationKey, "1.2"));
			await rejectUnchanged(prepared, "different-installation");
		});
		for (const status of ["claimed", "sending", "unknown"] as const)
			it(`restores label ${status} as held without importing source worker authority`, async () => {
				await copyCurrent();
				const cipher = sourceEncryptor.encrypt("synthetic-label");
				backup.data.serviceInstances.push({
					id: "label-instance",
					userId: "owner",
					service: "JELLYFIN",
					label: "synthetic",
					baseUrl: "http://label.invalid",
					encryptedApiKey: cipher.value,
					encryptionIv: cipher.iv,
				});
				backup.data.labelSyncRule = [
					{
						id: "label-rule",
						userId: "owner",
						name: "synthetic",
						sourceService: "radarr",
						sourceTagName: "tag",
						destService: "jellyfin",
						destInstanceId: "label-instance",
						destTagName: "tag",
					},
				];
				backup.data.labelSyncMutationAttempts = [
					{
						id: "label-attempt",
						userId: "owner",
						ruleId: "label-rule",
						destinationInstanceId: "label-instance",
						provider: "jellyfin",
						mediaType: "movie",
						tmdbId: 7,
						connectionGeneration: 0,
						identityGeneration: 1,
						targetItemId: "item",
						libraryId: "library",
						intentFingerprint: "synthetic-intent",
						ruleFingerprint: "synthetic-rule",
						destinationTag: "tag",
						activeOperationKey: "durable-label-hold",
						claimToken: "source-worker",
						sendAttemptCount: status === "claimed" ? 0 : 1,
						reconcileAttemptCount: status === "unknown" ? 1 : 0,
						requestStartedAt: status === "claimed" ? null : date.toISOString(),
						lastObservedAt: null,
						completedAt: null,
						status,
						reasonCode: status === "unknown" ? "uncertain_send" : null,
						createdAt: date.toISOString(),
						updatedAt: date.toISOString(),
					},
				];
				const prepared = await prepare();
				expect(prepared.publicationBlockers).toEqual([]);
				await restorePreparedDatabase(target, prepared, "destination-installation");
				expect(
					await target.labelSyncMutationAttempt.findUnique({ where: { id: "label-attempt" } }),
				).toMatchObject({
					status: "restored-held",
					reasonCode: "restore_uncertain",
					activeOperationKey: "durable-label-hold",
					claimToken: null,
					sendAttemptCount: status === "claimed" ? 0 : 1,
					reconcileAttemptCount: status === "unknown" ? 1 : 0,
				});
				// A reused native witness cannot erase the newer held provenance.
				await rejectUnchanged(prepared);
			});
		it("conserves detached terminal command and positive proof without reviving its instance", async () => {
			await source.arrImportSourceClaim.deleteMany();
			await source.queueCleanerImportReceipt.deleteMany();
			await source.arrImportOperation.update({
				where: { id: "operation" },
				data: {
					instanceId: null,
					state: "completed",
					commandState: "completed",
					commandTerminal: true,
					verifiedFileCount: 1,
					reconcileToken: null,
					reconcileExpiresAt: null,
				},
			});
			await source.arrImportFileProof.update({
				where: { id: "proof" },
				data: { verifiedAt: date },
			});
			original = await exportDatabase(source);
			backup.data = original;
			await copyCurrent();
			await restorePreparedDatabase(target, await prepare(), "destination-installation");
			expect(
				await target.arrImportOperation.findUnique({ where: { id: "operation" } }),
			).toMatchObject({
				instanceId: null,
				originalInstanceId: "arr",
				state: "completed",
				commandId: 42,
				connectionFingerprint: (original.arrImportOperations![0] as Row).connectionFingerprint,
				verifiedFileCount: 1,
			});
			expect(await target.arrImportFileProof.findUnique({ where: { id: "proof" } })).toMatchObject({
				verifiedAt: date,
			});
		});
		it("preserves active naming binding using original credentials despite destination re-encryption", async () => {
			await source.namingDeployHistory.create({
				data: {
					id: "naming",
					instanceId: "arr",
					userId: "owner",
					status: "SUCCESS",
					selectedPresets: "{}",
					resolvedPayload: "{}",
					previousConfig: "{}",
					changedFields: 1,
					totalFields: 1,
					deployedAt: date,
				},
			});
			original = await exportDatabase(source);
			backup.data = original;
			await copyCurrent();
			await restorePreparedDatabase(target, await prepare(), "destination-installation");
			expect(
				await target.namingDeployHistory.findUnique({ where: { id: "naming" } }),
			).toMatchObject({ status: "SUCCESS", rolledBack: false, previousConfig: "{}" });
		});
		it("rejects reused stale preparation after success and safely retries from fresh authenticated state", async () => {
			await copyCurrent();
			const prepared = await prepare();
			await restorePreparedDatabase(target, prepared, "destination-installation");
			await rejectUnchanged(prepared);
			const current = await snapshot();
			const retry = await prepareRestoreData({
				envelope: await encryptBackupData(
					JSON.stringify({
						...backup,
						data: current,
						secrets: {
							encryptionKey: destinationKey,
							sessionCookieSecret: "synthetic-destination-cookie",
						},
					}),
					"synthetic-envelope-password",
				),
				password: "synthetic-envelope-password",
				destination: {
					encryptor: destination,
					installationId: "destination-installation",
					stableForRestart: true,
				},
			});
			await restorePreparedDatabase(target, retry, "destination-installation");
			expect(await target.arrImportSourceClaim.count()).toBe(1);
			expect(await target.session.count()).toBe(0);
		});
		it("allows one coherent result under concurrent prepared invocation and rejects the stale contender", async () => {
			await copyCurrent();
			const prepared = await prepare();
			const results = await Promise.allSettled([
				restorePreparedDatabase(target, prepared, "destination-installation"),
				restorePreparedDatabase(target, prepared, "destination-installation"),
			]);
			expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
			const failed = results.find(
				(result) => result.status === "rejected",
			) as PromiseRejectedResult;
			expect(failed.reason).toBeInstanceOf(BackupCompatibilityError);
			expect(await target.arrImportOperation.count()).toBe(1);
			expect(await target.arrImportSourceClaim.count()).toBe(1);
			expect(await target.quiActionClaim.count()).toBe(1);
			expect(await target.session.count()).toBe(0);
		});
		for (const [label, omit] of [
			[
				"file proof",
				() => {
					backup.data.arrImportOperations = [];
					backup.data.arrImportFileProofs = [];
					backup.data.arrImportSourceClaims = [];
				},
			],
			[
				"receipt",
				() => {
					(backup.data.arrImportOperations![0] as Row).legacyReceiptId = null;
					backup.data.queueCleanerImportReceipts = [];
				},
			],
			[
				"source claim",
				() => {
					backup.data.arrImportSourceClaims = [];
				},
			],
			[
				"qUI claim and linked log",
				() => {
					backup.data.quiActionClaims = [];
					backup.data.quiActionLogs = [];
				},
			],
		] as const)
			it(`rejects incoming omission of current ${label}`, async () => {
				await copyCurrent();
				backup.data = structuredClone(original);
				omit();
				await rejectUnchanged(await prepare());
			});
		for (const [label, drift] of [
			[
				"operation command evidence",
				(p: PrismaClient) =>
					p.arrImportOperation.update({ where: { id: "operation" }, data: { commandId: 99 } }),
			],
			[
				"file positive proof",
				(p: PrismaClient) =>
					p.arrImportFileProof.update({ where: { id: "proof" }, data: { verifiedAt: date } }),
			],
			[
				"source hold",
				(p: PrismaClient) =>
					p.arrImportSourceClaim.update({
						where: { id: "claim" },
						data: { activeOperationId: null },
					}),
			],
			[
				"receipt evidence",
				(p: PrismaClient) =>
					p.queueCleanerImportReceipt.update({ where: { id: "receipt" }, data: { commandId: 99 } }),
			],
			[
				"qUI linked outcome",
				(p: PrismaClient) =>
					p.quiActionLog.update({ where: { id: "qui-log" }, data: { status: "pending" } }),
			],
			[
				"same-title connection alias",
				(p: PrismaClient) =>
					p.serviceInstance.update({
						where: { id: "qui" },
						data: { baseUrl: "http://alias.invalid" },
					}),
			],
			[
				"qUI claim attempt",
				(p: PrismaClient) =>
					p.quiActionClaim.updateMany({ data: { attemptId: "changed-attempt" } }),
			],
			[
				"qUI connection credentials",
				(p: PrismaClient) =>
					p.serviceInstance.update({
						where: { id: "qui" },
						data: { encryptedApiKey: sourceEncryptor.encrypt("changed").value },
					}),
			],
			[
				"qUI qbit identity",
				(p: PrismaClient) => p.quiActionClaim.updateMany({ data: { qbitInstanceId: 2 } }),
			],
			[
				"parent ownership",
				async (p: PrismaClient) => {
					await p.user.create({ data: { id: "different-owner", username: "same-title-owner" } });
					await p.serviceInstance.update({
						where: { id: "qui" },
						data: { userId: "different-owner" },
					});
				},
			],
		] as const)
			it(`rejects changed current ${label} without erasure`, async () => {
				await copyCurrent();
				const prepared = await prepare();
				await drift(target);
				await rejectUnchanged(prepared);
			});
		it("restores backed-up authentication while permitting nonauthority account and display drift", async () => {
			await copyCurrent();
			const prepared = await prepare();
			await target.user.update({
				where: { id: "owner" },
				data: {
					username: "current-display",
					hashedPassword: await hashPassword("synthetic-current-password"),
					failedLoginAttempts: 3,
					lockedUntil: date,
				},
			});
			await target.serviceInstance.update({
				where: { id: "qui" },
				data: {
					label: "current-display",
					externalUrl: "http://display.invalid",
					isDefault: true,
					identityLastCheckedAt: date,
					identityVerifiedAt: date,
				},
			});
			await restorePreparedDatabase(target, prepared, "destination-installation");
			const restored = await target.user.findUniqueOrThrow({ where: { id: "owner" } });
			expect(restored).toMatchObject({
				username: "synthetic",
				failedLoginAttempts: 0,
				lockedUntil: null,
				hashedPassword,
			});
			expect(await verifyPassword("synthetic-restored-password", restored.hashedPassword!)).toBe(
				true,
			);
			expect(await target.quiActionClaim.count()).toBe(1);
		});
		for (const [field, value] of [
			["enabled", false],
			["storageGroupId", "changed-storage"],
			["hasLocalFilesystemAccess", true],
			["pathPrefix", "/synthetic>/changed"],
			["connectionGeneration", 1],
			["expectedIdentity", "changed-identity"],
			["identityKind", "JELLYFIN_SERVER_ID"],
			["identityStatus", "VERIFIED"],
			["identityGeneration", 1],
		] as const)
			it(`rejects current held service authority drift ${field}`, async () => {
				await copyCurrent();
				const prepared = await prepare();
				await target.serviceInstance.update({
					where: { id: "qui" },
					data: { [field]: value } as Prisma.ServiceInstanceUpdateInput,
				});
				await rejectUnchanged(prepared);
			});
		it("rejects an omitted current hold at the actual in-transaction read", async () => {
			await copyCurrent();
			const prepared = await prepare();
			let insideRead = false;
			const rootTransaction = target.$transaction.bind(target);
			const barrier = new Proxy(target, {
				get(client, property) {
					if (property === "$transaction")
						return (
							operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
							options: unknown,
						) =>
							rootTransaction(async (tx) => {
								// Insert after the root preflight, before the real conservation query.
								await tx.arrImportSourceClaim.create({
									data: {
										id: "new-hold",
										userId: "owner",
										downloadKey: "c".repeat(64),
										activeOperationId: null,
									},
								});
								return operation(
									new Proxy(tx, {
										get(inner, field) {
											if (field === "arrImportSourceClaim")
												return new Proxy(inner.arrImportSourceClaim, {
													get(delegate, method) {
														if (method === "findMany")
															return async (...args: unknown[]) => {
																insideRead = true;
																return (delegate.findMany as (...values: unknown[]) => unknown)(
																	...args,
																);
															};
														return Reflect.get(delegate, method);
													},
												});
											return Reflect.get(inner, field);
										},
									}),
								);
							}, options as never);
					const value = Reflect.get(client, property);
					return typeof value === "function" ? value.bind(client) : value;
				},
			}) as PrismaClient;
			await rejectUnchanged(prepared, "destination-installation", barrier);
			expect(insideRead).toBe(true);
		});
		it("rolls back all inserts, deletions and destination sessions after late bookkeeping failure", async () => {
			await seedTrash();
			await copyCurrent();
			const prepared = await prepare();
			const transaction = target.$transaction.bind(target);
			let reachedWrites = false;
			const failing = new Proxy(target, {
				get(client, property) {
					if (property === "$transaction")
						return (
							operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
							options: unknown,
						) =>
							transaction(async (tx) => {
								await operation(tx);
								reachedWrites = true;
								throw new Error("synthetic-late-bookkeeping-failure");
							}, options as never);
					const value = Reflect.get(client, property);
					return typeof value === "function" ? value.bind(client) : value;
				},
			}) as PrismaClient;
			const before = await snapshot();
			await expect(
				restorePreparedDatabase(failing, prepared, "destination-installation"),
			).rejects.toBeInstanceOf(BackupCompatibilityError);
			expect(reachedWrites).toBe(true);
			expect(await snapshot()).toEqual(before);
			expect(await target.session.count()).toBe(2);
		});
		it("reopens in a fresh process and decrypts all nine pairs under the unchanged effective destination key", async () => {
			const prepared = await prepare();
			await restorePreparedDatabase(target, prepared, "destination-installation");
			await target.$disconnect();
			const code = `const {createTestPrismaClient}=require('./src/lib/__tests__/test-prisma.ts'); const {Encryptor}=require('./src/lib/auth/encryption.ts'); (async()=>{let input=''; for await(const chunk of process.stdin) input+=chunk; const {key,file,expected,postgres}=JSON.parse(input); let p,pool; if(postgres){const {PrismaClient}=require(postgres.clientPath);const {PrismaPg}=require('@prisma/adapter-pg');const {Pool}=require('pg');pool=new Pool({connectionString:postgres.url});p=new PrismaClient({adapter:new PrismaPg(pool,{schema:postgres.schema})});}else p=createTestPrismaClient(file); const e=new Encryptor(key); const rows=[await p.user.findFirst(),await p.serviceInstance.findUnique({where:{id:'arr'}}),await p.oIDCProvider.findFirst(),await p.backupSettings.findFirst(),await p.notificationChannel.findFirst(),await p.vapidKeys.findFirst(),await p.arrImportOperation.findFirst()]; const pairs=[[0,'encryptedTmdbApiKey','tmdbEncryptionIv'],[0,'encryptedTraktAccessToken','traktTokenIv'],[1,'encryptedApiKey','encryptionIv'],[1,'encryptedHttpAuthCredentials','httpAuthEncryptionIv'],[2,'encryptedClientSecret','clientSecretIv'],[3,'encryptedPassword','passwordIv'],[4,'encryptedConfig','configIv'],[5,'encryptedPrivateKey','privateKeyIv'],[6,'encryptedSources','sourcesEncryptionIv']]; for(let i=0;i<pairs.length;i++){const [r,v,iv]=pairs[i];if(e.decrypt({value:rows[r][v],iv:rows[r][iv]})!==expected[i])throw Error('synthetic-decryption-mismatch');} if(await p.session.count()!==0)throw Error('sessions-survived'); await p.$disconnect();if(pool)await pool.end(); process.stdout.write('9 pairs decrypted; 0 sessions\\n');})().catch(()=>{process.stderr.write('synthetic-reopen-failed\\n');process.exitCode=1;});`;
			const env = Object.fromEntries(
				["PATH", "LANG", "LC_ALL", "TZ"]
					.filter((key) => process.env[key])
					.map((key) => [key, process.env[key]!]),
			);
			const child = spawn(
				process.execPath,
				[path.join(apiDir, "node_modules/tsx/dist/cli.mjs"), "--eval", code],
				{ cwd: apiDir, env, stdio: ["pipe", "pipe", "pipe"] },
			);
			let stdout = "",
				stderr = "";
			child.stdout.on("data", (value) => {
				stdout += value;
			});
			child.stderr.on("data", (value) => {
				stderr += value;
			});
			child.stdin.end(
				JSON.stringify({
					key: destinationKey,
					file: path.join(tempDir, "target.db"),
					expected: plaintexts,
					postgres: postgresUrl
						? { url: postgresUrl, schema: postgresSchema, clientPath: postgresClientPath }
						: undefined,
				}),
			);
			const status = await new Promise((resolve, reject) => {
				child.on("error", reject);
				child.on("close", resolve);
			});
			expect({ status, stderr, stdout }).toEqual({
				status: 0,
				stderr: "",
				stdout: "9 pairs decrypted; 0 sessions\n",
			});
		});
		it("compares equivalent proof JSON structurally and timestamps canonically", async () => {
			await copyCurrent();
			await target.arrImportFileProof.update({
				where: { id: "proof" },
				data: {
					identityJson: {
						movieFileId: 0,
						movieId: 7,
						pathHash: createHash("sha256").update(file.path).digest("hex"),
					},
				},
			});
			backup.data = structuredClone(original);
			(backup.data.arrImportFileProofs![0] as Row).createdAt = "2026-10-07T02:00:00.000+01:00";
			await restorePreparedDatabase(target, await prepare(), "destination-installation");
			expect(await target.arrImportFileProof.findUnique({ where: { id: "proof" } })).toMatchObject({
				createdAt: date,
				identityJson: {
					movieFileId: 0,
					movieId: 7,
					pathHash: createHash("sha256").update(file.path).digest("hex"),
				},
			});
		});
		it("refuses rebinding a qUI hold to a different same-label service instance", async () => {
			await copyCurrent();
			backup.data = structuredClone(original);
			const originalQui = backup.data.serviceInstances.find(
				(row) => (row as Row).id === "qui",
			) as Row;
			backup.data.serviceInstances.push({ ...originalQui, id: "same-label-alias" });
			(backup.data.quiActionClaims![0] as Row).serviceInstanceId = "same-label-alias";
			(backup.data.quiActionLogs![0] as Row).serviceInstanceId = "same-label-alias";
			await rejectUnchanged(await prepare());
		});
	},
);
