import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import { BackupCompatibilityError } from "../../errors.js";
import type { Prisma, PrismaClient } from "../../prisma.js";
import { exportDatabase, restoreDatabase } from "../backup-database.js";
import { BACKUP_VERSION, validateBackup } from "../backup-validation.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const ROUND_TRIP_HOOK_TIMEOUT_MS = 120_000;
const execFileAsync = promisify(execFile);

type DatabaseHandle = { prisma: PrismaClient; cleanup: () => Promise<void> };

type InteractiveTransaction = (
	operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
	options?: {
		maxWait?: number;
		timeout?: number;
		isolationLevel?: Prisma.TransactionIsolationLevel;
	},
) => Promise<unknown>;

function withInteractiveTransactionDefaultTimeout(
	prisma: PrismaClient,
	timeout: number,
	startDelay: number,
): PrismaClient {
	const rootTransaction = prisma.$transaction.bind(prisma) as InteractiveTransaction;
	return new Proxy(prisma, {
		get(target, property) {
			if (property === "$transaction") {
				return (
					operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
					options?: Parameters<InteractiveTransaction>[1],
				) =>
					rootTransaction(async (tx) => {
						await new Promise((resolve) => setTimeout(resolve, startDelay));
						return operation(tx);
					}, options ?? { timeout });
			}
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as PrismaClient;
}

async function pushSqliteSchema(databasePath: string, apiDir: string): Promise<void> {
	await execFileAsync(
		"pnpm",
		[
			"exec",
			"prisma",
			"db",
			"push",
			"--schema",
			"prisma/schema.prisma",
			"--url",
			`file:${databasePath}`,
		],
		{ cwd: apiDir, env: { ...process.env, DATABASE_URL: `file:${databasePath}` } },
	);
}

function withPostgresSchema(connectionString: string, schema: string): string {
	const url = new URL(connectionString);
	url.searchParams.set("schema", schema);
	return url.toString();
}

async function createPostgresDatabasePair(
	connectionString: string,
	tempDir: string,
	apiDir: string,
): Promise<{ source: DatabaseHandle; target: DatabaseHandle }> {
	const suffix = `${process.pid}_${Date.now()}`;
	const sourceSchema = `backup815_source_${suffix}`;
	const targetSchema = `backup815_target_${suffix}`;
	const pg = await import("pg");
	const admin = new pg.default.Pool({ connectionString });
	const schemaFile = path.join(tempDir, "postgres-schema.prisma");
	const clientOutput = path.join(tempDir, "postgres-client");
	const pools: InstanceType<typeof pg.default.Pool>[] = [];
	const clients: PrismaClient[] = [];
	try {
		await admin.query(`CREATE SCHEMA "${sourceSchema}"`);
		await admin.query(`CREATE SCHEMA "${targetSchema}"`);
		const sourceSchemaText = await readFile(path.join(apiDir, "prisma/schema.prisma"), "utf8");
		const postgresSchemaText = sourceSchemaText
			.replace(
				/generator client \{[\s\S]*?\}\n\n/,
				`generator client {\n  provider = "prisma-client"\n  output = "${clientOutput}"\n}\n\n`,
			)
			.replace('provider = "sqlite"', 'provider = "postgresql"');
		await writeFile(schemaFile, postgresSchemaText, "utf8");
		await execFileAsync("pnpm", ["exec", "prisma", "generate", "--schema", schemaFile], {
			cwd: apiDir,
			env: process.env,
		});
		for (const schema of [sourceSchema, targetSchema]) {
			const schemaUrl = withPostgresSchema(connectionString, schema);
			await execFileAsync(
				"pnpm",
				["exec", "prisma", "db", "push", "--schema", schemaFile, "--url", schemaUrl],
				{ cwd: apiDir, env: { ...process.env, DATABASE_URL: schemaUrl } },
			);
		}
		const generatedModule = await import(
			/* @vite-ignore */ pathToFileURL(path.join(clientOutput, "client.ts")).href
		);
		const generatedExports = (generatedModule.default ?? generatedModule) as {
			PrismaClient: new (options: { adapter: unknown }) => PrismaClient;
		};
		const { PrismaPg } = await import("@prisma/adapter-pg");
		for (const schema of [sourceSchema, targetSchema]) {
			const pool = new pg.default.Pool({
				connectionString: withPostgresSchema(connectionString, schema),
			});
			pools.push(pool);
			clients.push(
				new generatedExports.PrismaClient({
					adapter: new PrismaPg(pool as never, { schema }),
				}),
			);
		}
		const [sourcePrisma, targetPrisma] = clients;
		if (!sourcePrisma || !targetPrisma) throw new Error("PostgreSQL test clients were not created");
		return {
			source: {
				prisma: sourcePrisma,
				cleanup: async () => {
					await sourcePrisma.$disconnect();
					await pools[0]?.end();
				},
			},
			target: {
				prisma: targetPrisma,
				cleanup: async () => {
					await targetPrisma.$disconnect();
					await pools[1]?.end();
					await admin.query(`DROP SCHEMA "${sourceSchema}" CASCADE`);
					await admin.query(`DROP SCHEMA "${targetSchema}" CASCADE`);
					await admin.end();
				},
			},
		};
	} catch (error) {
		await Promise.allSettled(clients.map((client) => client.$disconnect()));
		await Promise.allSettled(pools.map((pool) => pool.end()));
		await Promise.allSettled([
			admin.query(`DROP SCHEMA IF EXISTS "${sourceSchema}" CASCADE`),
			admin.query(`DROP SCHEMA IF EXISTS "${targetSchema}" CASCADE`),
		]);
		await admin.end().catch(() => undefined);
		throw error;
	}
}

async function createDatabasePair(): Promise<{
	source: DatabaseHandle;
	target: DatabaseHandle;
	tempDir: string;
}> {
	const tempDir = await mkdtemp(path.join(os.tmpdir(), "backup-roundtrip-"));
	const apiDir = path.resolve(import.meta.dirname, "../../../..");
	const externalDatabaseUrl = process.env.TEST_DATABASE_URL;
	if (externalDatabaseUrl?.startsWith("postgres")) {
		return { ...(await createPostgresDatabasePair(externalDatabaseUrl, tempDir, apiDir)), tempDir };
	}
	const sourcePath = path.join(tempDir, "source.db");
	const targetPath = path.join(tempDir, "target.db");
	await pushSqliteSchema(sourcePath, apiDir);
	await pushSqliteSchema(targetPath, apiDir);
	return {
		source: (() => {
			const prisma = createTestPrismaClient(sourcePath);
			return { prisma, cleanup: () => prisma.$disconnect() };
		})(),
		target: (() => {
			const prisma = createTestPrismaClient(targetPath);
			return { prisma, cleanup: () => prisma.$disconnect() };
		})(),
		tempDir,
	};
}

async function seedDurableSource(prisma: PrismaClient): Promise<void> {
	const userId = "issue815-roundtrip-user";
	const instanceId = "issue815-roundtrip-instance";
	const coordinationCreatedAt = new Date("2026-08-31T00:00:00.000Z");
	const coordinationUpdatedAt = new Date("2026-08-31T00:01:00.000Z");
	await prisma.user.create({
		data: {
			id: userId,
			username: userId,
			hashedPassword: "password-hash",
			encryptedTmdbApiKey: "tmdb-ciphertext",
			tmdbEncryptionIv: "tmdb-iv",
			encryptedTraktAccessToken: "trakt-ciphertext",
			traktTokenIv: "trakt-iv",
		},
	});
	await prisma.session.create({
		data: { id: "issue815-session", userId, expiresAt: new Date("2030-01-01T00:00:00.000Z") },
	});
	await prisma.serviceTag.create({ data: { id: "issue815-tag", name: "issue815" } });
	await prisma.serviceInstance.create({
		data: {
			id: instanceId,
			userId,
			service: "RADARR",
			label: "Issue 815 Radarr",
			baseUrl: "http://radarr.example",
			encryptedApiKey: "api-ciphertext",
			encryptionIv: "api-iv",
			encryptedHttpAuthCredentials: "http-auth-ciphertext",
			httpAuthEncryptionIv: "http-auth-iv",
		},
	});
	await prisma.serviceInstanceTag.create({ data: { instanceId, tagId: "issue815-tag" } });
	await prisma.oIDCProvider.create({
		data: {
			id: 1,
			displayName: "Issue 815 OIDC",
			clientId: "client-id",
			encryptedClientSecret: "oidc-ciphertext",
			clientSecretIv: "oidc-iv",
			issuer: "https://issuer.example",
			redirectUri: "https://dashboard.example/callback",
		},
	});
	await prisma.oIDCAccount.create({
		data: { id: "issue815-oidc-account", userId, providerUserId: "provider-user" },
	});
	await prisma.webAuthnCredential.create({
		data: { id: "issue815-credential", userId, publicKey: "passkey-public", counter: 3 },
	});
	await prisma.systemSettings.create({ data: { id: 1, appName: "Issue 815" } });
	await prisma.backupSettings.create({
		data: {
			id: 1,
			enabled: true,
			intervalType: "DAILY",
			encryptedPassword: "backup-password-ciphertext",
			passwordIv: "backup-password-iv",
		},
	});
	await prisma.vapidKeys.create({
		data: {
			id: 1,
			publicKey: "vapid-public",
			encryptedPrivateKey: "vapid-ciphertext",
			privateKeyIv: "vapid-iv",
		},
	});
	await prisma.trashCache.create({
		data: {
			id: "issue815-target-era-trash-cache",
			serviceType: "RADARR",
			configType: "CUSTOM_FORMATS",
			data: '{"targetEra":true}',
		},
	});
	await prisma.libraryCleanupMediaServerScanLease.create({
		data: {
			operationKey: "issue815:shared-server:library",
			userId,
			executionToken: "issue815-target-era-lease",
		},
	});

	const template = await prisma.trashTemplate.create({
		data: {
			id: "issue815-template",
			userId,
			name: "Issue 815 template",
			serviceType: "RADARR",
			configData: '{"customFormats":[]}',
		},
	});
	await prisma.trashSettings.create({ data: { id: "issue815-trash-settings", userId } });
	await prisma.trashSyncSchedule.create({
		data: {
			id: "issue815-schedule",
			userId,
			instanceId,
			templateId: template.id,
			frequency: "DAILY",
		},
	});
	await prisma.templateQualityProfileMapping.create({
		data: {
			id: "issue815-profile-mapping",
			templateId: template.id,
			instanceId,
			qualityProfileId: 10,
			qualityProfileName: "Issue 815 profile",
		},
	});
	await prisma.instanceQualityProfileOverride.create({
		data: {
			id: "issue815-score-intent",
			instanceId,
			qualityProfileId: 10,
			customFormatId: 20,
			score: 42,
			status: "PENDING",
			intentOperation: "SET_SCORE",
			intendedScore: 42,
			userId,
			connectionGeneration: 2,
			connectionStateToken: "state-token",
			createdAt: coordinationCreatedAt,
			updatedAt: coordinationUpdatedAt,
		},
	});
	await prisma.standaloneCFDeployment.create({
		data: {
			id: "issue815-standalone-cf",
			userId,
			instanceId,
			cfTrashId: "issue815-cf",
			cfName: "Issue 815 CF",
			serviceType: "RADARR",
			commitHash: "commit",
		},
	});
	await prisma.qualitySizeMapping.create({
		data: {
			id: "issue815-quality-size",
			instanceId,
			userId,
			presetTrashId: "issue815-preset",
			presetType: "movie",
			serviceType: "RADARR",
			lastAppliedAt: new Date("2025-01-01T00:00:00.000Z"),
		},
	});
	await prisma.huntConfig.create({
		data: { id: "issue815-hunt", instanceId, huntMissingEnabled: true, missingBatchSize: 2 },
	});
	await prisma.queueCleanerConfig.create({
		data: { id: "issue815-queue", instanceId, enabled: true, dryRunMode: false },
	});
	const cleanup = await prisma.libraryCleanupConfig.create({
		data: { id: "issue815-cleanup", userId, enabled: true, dryRunMode: false },
	});
	await prisma.libraryCleanupRule.create({
		data: {
			id: "issue815-cleanup-rule",
			configId: cleanup.id,
			name: "Issue 815 rule",
			ruleType: "age",
			parameters: '{"days":30}',
		},
	});
	await prisma.libraryCleanupApproval.create({
		data: {
			id: "issue815-active-approval",
			configId: cleanup.id,
			instanceId,
			arrItemId: 815,
			itemType: "movie",
			title: "Issue 815 movie",
			matchedRuleId: "issue815-cleanup-rule",
			matchedRuleName: "Issue 815 rule",
			reason: "age",
			action: "delete",
			sizeOnDisk: BigInt(1234),
			expiresAt: new Date("2030-01-01T00:00:00.000Z"),
			status: "pending",
			createdAt: coordinationCreatedAt,
		},
	});
	await prisma.libraryCleanupApproval.create({
		data: {
			id: "issue815-executed-parent",
			configId: cleanup.id,
			instanceId,
			arrItemId: 816,
			itemType: "series",
			title: "Issue 815 series",
			matchedRuleId: "issue815-cleanup-rule",
			matchedRuleName: "Issue 815 rule",
			reason: "size",
			action: "delete",
			sizeOnDisk: BigInt(5678),
			expiresAt: new Date("2030-01-01T00:00:00.000Z"),
			status: "executed",
			terminalAuditRecordedAt: new Date("2029-01-01T00:00:00.000Z"),
			terminalAuditRecoveryAttemptedAt: new Date("2028-12-31T23:00:00.000Z"),
			createdAt: coordinationCreatedAt,
		},
	});
	await prisma.libraryCleanupMediaServerScan.create({
		data: {
			id: "issue815-pending-scan",
			approvalId: "issue815-active-approval",
			instanceId,
			service: "PLEX",
			mediaType: "movie",
			targetKey: "movie:815",
			status: "pending",
			createdAt: coordinationCreatedAt,
			updatedAt: coordinationUpdatedAt,
		},
	});
	await prisma.libraryCleanupMediaServerScan.create({
		data: {
			id: "issue815-failed-scan",
			approvalId: "issue815-executed-parent",
			instanceId,
			service: "PLEX",
			mediaType: "show",
			targetKey: "series:816",
			status: "failed",
			lastError: "test failure",
			createdAt: coordinationCreatedAt,
			updatedAt: coordinationUpdatedAt,
		},
	});
	await prisma.userCustomFormat.create({
		data: {
			id: "issue815-custom-format",
			userId,
			name: "Issue 815 format",
			serviceType: "RADARR",
			specifications: "[]",
			defaultScore: 42,
		},
	});
	const channel = await prisma.notificationChannel.create({
		data: {
			id: "issue815-channel",
			userId,
			name: "Issue 815 channel",
			type: "WEBHOOK",
			encryptedConfig: "notification-ciphertext",
			configIv: "notification-iv",
		},
	});
	await prisma.notificationSubscription.create({
		data: { channelId: channel.id, eventType: "BACKUP_FAILED" },
	});
	await prisma.notificationRule.create({
		data: {
			id: "issue815-notification-rule",
			userId,
			name: "Issue 815 rule",
			action: "suppress",
			conditions: "[]",
		},
	});
	await prisma.notificationAggregationConfig.create({
		data: { id: "issue815-aggregation", userId, eventType: "BACKUP_FAILED" },
	});
	await prisma.namingConfig.create({
		data: {
			id: "issue815-naming",
			instanceId,
			userId,
			serviceType: "RADARR",
			selectedPresets: "{}",
		},
	});
	await prisma.labelSyncRule.create({
		data: {
			id: "issue815-label-sync",
			userId,
			name: "Issue 815 label sync",
			sourceService: "radarr",
			sourceTagName: "source",
			destInstanceId: instanceId,
			destTagName: "destination",
		},
	});
	await prisma.autoTagRule.create({
		data: {
			id: "issue815-auto-tag",
			userId,
			name: "Issue 815 auto tag",
			ruleType: "age",
			parameters: "{}",
			tagName: "issue815",
		},
	});
	await prisma.namingDeployHistory.create({
		data: {
			id: "issue815-naming-history",
			instanceId,
			userId,
			status: "SUCCESS",
			selectedPresets: "{}",
			resolvedPayload: "{}",
			changedFields: 1,
			totalFields: 1,
			deployedAt: coordinationCreatedAt,
		},
	});
}

function normalizedRows(rows: unknown[]): string[] {
	return rows
		.map((row) =>
			JSON.stringify(row, (_key, value) => {
				if (value instanceof Date) return value.toISOString();
				if (typeof value === "bigint") return value.toString();
				return value;
			}),
		)
		.sort();
}

const MODEL_EXPORTS = [
	["users", "user"],
	["sessions", "session"],
	["serviceInstances", "serviceInstance"],
	["serviceTags", "serviceTag"],
	["serviceInstanceTags", "serviceInstanceTag"],
	["oidcProviders", "oIDCProvider"],
	["oidcAccounts", "oIDCAccount"],
	["webAuthnCredentials", "webAuthnCredential"],
	["systemSettings", "systemSettings"],
	["backupSettings", "backupSettings"],
	["vapidKeys", "vapidKeys"],
	["trashTemplates", "trashTemplate"],
	["trashSettings", "trashSettings"],
	["trashSyncSchedules", "trashSyncSchedule"],
	["templateQualityProfileMappings", "templateQualityProfileMapping"],
	["instanceQualityProfileOverrides", "instanceQualityProfileOverride"],
	["standaloneCFDeployments", "standaloneCFDeployment"],
	["qualitySizeMappings", "qualitySizeMapping"],
	["huntConfigs", "huntConfig"],
	["queueCleanerConfig", "queueCleanerConfig"],
	["libraryCleanupConfig", "libraryCleanupConfig"],
	["libraryCleanupRule", "libraryCleanupRule"],
	["libraryCleanupApproval", "libraryCleanupApproval"],
	["libraryCleanupMediaServerScan", "libraryCleanupMediaServerScan"],
	["userCustomFormat", "userCustomFormat"],
	["notificationChannel", "notificationChannel"],
	["notificationSubscription", "notificationSubscription"],
	["notificationRule", "notificationRule"],
	["notificationAggregationConfig", "notificationAggregationConfig"],
	["namingConfig", "namingConfig"],
	["namingDeployHistory", "namingDeployHistory"],
	["labelSyncRule", "labelSyncRule"],
	["autoTagRule", "autoTagRule"],
] as const;

(RUN_DB_TESTS ? describe : describe.skip)(
	"backup format 1.2 independent database round-trip",
	() => {
		let source: DatabaseHandle;
		let target: DatabaseHandle;
		let tempDir: string;

		beforeAll(async () => {
			({ source, target, tempDir } = await createDatabasePair());
			await seedDurableSource(source.prisma);
			await seedDurableSource(target.prisma);
		}, ROUND_TRIP_HOOK_TIMEOUT_MS);

		afterAll(async () => {
			const cleanupErrors: unknown[] = [];
			for (const cleanup of [source?.cleanup, target?.cleanup]) {
				try {
					await cleanup?.();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			try {
				if (tempDir) await rm(tempDir, { recursive: true, force: true });
			} catch (error) {
				cleanupErrors.push(error);
			}
			if (cleanupErrors.length > 0) {
				throw new AggregateError(cleanupErrors, "Backup round-trip cleanup failed");
			}
		}, ROUND_TRIP_HOOK_TIMEOUT_MS);

		it("rejects incomplete populated-target restores, then replaces complete and covered legacy state", async () => {
			const exported = await exportDatabase(source.prisma, { excludeOperationalHistory: true });
			const backup = {
				version: BACKUP_VERSION,
				appVersion: "2.24.2",
				timestamp: new Date().toISOString(),
				data: exported,
				secrets: { encryptionKey: "key", sessionCookieSecret: "session" },
			};
			validateBackup(backup);

			await target.prisma.queueCleanerConfig.update({
				where: { id: "issue815-queue" },
				data: { enabled: false },
			});
			await target.prisma.backupSettings.update({
				where: { id: 1 },
				data: {
					encryptedPassword: "target-backup-ciphertext",
					passwordIv: "target-backup-iv",
				},
			});
			await target.prisma.notificationLog.create({
				data: {
					id: "issue815-post-snapshot-notification",
					channelId: "issue815-channel",
					channelType: "WEBHOOK",
					eventType: "BACKUP_FAILED",
					title: "Post-snapshot title",
					body: "Post-snapshot body",
					status: "sent",
					sentAt: new Date("2026-09-01T00:00:00.000Z"),
				},
			});
			const incompleteData = { ...exported } as Record<string, unknown>;
			delete incompleteData.queueCleanerConfig;

			await expect(restoreDatabase(target.prisma, incompleteData as never)).rejects.toBeInstanceOf(
				BackupCompatibilityError,
			);
			expect(
				await target.prisma.queueCleanerConfig.findUnique({ where: { id: "issue815-queue" } }),
			).toMatchObject({ enabled: false });
			expect(await target.prisma.backupSettings.findUnique({ where: { id: 1 } })).toMatchObject({
				encryptedPassword: "target-backup-ciphertext",
				passwordIv: "target-backup-iv",
			});
			expect(await target.prisma.libraryCleanupApproval.count()).toBe(2);
			expect(await target.prisma.notificationLog.count()).toBe(1);
			expect(await target.prisma.trashCache.count()).toBe(1);
			expect(await target.prisma.libraryCleanupMediaServerScanLease.count()).toBe(1);

			await restoreDatabase(target.prisma, backup.data);
			expect(await target.prisma.notificationLog.count()).toBe(0);
			expect(await target.prisma.trashCache.count()).toBe(0);
			expect(await target.prisma.libraryCleanupMediaServerScanLease.count()).toBe(0);

			for (const [exportKey, modelKey] of MODEL_EXPORTS) {
				const model = (
					target.prisma as unknown as Record<string, { findMany: () => Promise<unknown[]> }>
				)[modelKey];
				if (!model) throw new Error(`Missing Prisma model ${modelKey}`);
				const targetRows = await model.findMany();
				expect(normalizedRows(targetRows), modelKey).toEqual(
					normalizedRows(exported[exportKey] as unknown[]),
				);
			}
			expect(exported.notificationChannel?.[0]).toMatchObject({
				encryptedConfig: "notification-ciphertext",
				configIv: "notification-iv",
			});
			expect(exported.users[0]).toMatchObject({
				encryptedTmdbApiKey: "tmdb-ciphertext",
				tmdbEncryptionIv: "tmdb-iv",
				encryptedTraktAccessToken: "trakt-ciphertext",
				traktTokenIv: "trakt-iv",
			});
			expect(exported.oidcProviders?.[0]).toMatchObject({
				encryptedClientSecret: "oidc-ciphertext",
				clientSecretIv: "oidc-iv",
			});
			expect(exported.backupSettings?.[0]).toMatchObject({
				encryptedPassword: "backup-password-ciphertext",
				passwordIv: "backup-password-iv",
			});
			expect(exported.vapidKeys?.[0]).toMatchObject({
				encryptedPrivateKey: "vapid-ciphertext",
				privateKeyIv: "vapid-iv",
			});
			expect(exported.serviceInstances[0]).toMatchObject({
				encryptedApiKey: "api-ciphertext",
				encryptionIv: "api-iv",
				encryptedHttpAuthCredentials: "http-auth-ciphertext",
				httpAuthEncryptionIv: "http-auth-iv",
			});
			expect(exported.instanceQualityProfileOverrides?.[0]).toMatchObject({ status: "PENDING" });
			expect(
				(exported.libraryCleanupApproval as Array<Record<string, unknown>>).find(
					(row) => row.id === "issue815-executed-parent",
				),
			).toMatchObject({
				terminalAuditRecordedAt: null,
				terminalAuditRecoveryAttemptedAt: null,
			});

			await target.prisma.notificationSubscription.deleteMany();
			await target.prisma.notificationChannel.deleteMany();
			await target.prisma.backupSettings.update({
				where: { id: 1 },
				data: { encryptedPassword: null, passwordIv: null },
			});
			await target.prisma.vapidKeys.update({
				where: { id: 1 },
				data: {
					encryptedPrivateKey: "target-vapid-ciphertext",
					privateKeyIv: "target-vapid-iv",
				},
			});
			const coveredLegacyData = { ...exported } as Record<string, unknown>;
			delete coveredLegacyData.notificationChannel;
			delete coveredLegacyData.notificationSubscription;
			coveredLegacyData.libraryCleanupApproval = (
				exported.libraryCleanupApproval as Array<Record<string, unknown>>
			).map((row) => ({
				...row,
				terminalAuditRecordedAt: "2031-01-01T00:00:00.000Z",
				terminalAuditRecoveryAttemptedAt: "2031-01-01T01:00:00.000Z",
			}));

			await restoreDatabase(target.prisma, coveredLegacyData as never);
			expect(await target.prisma.backupSettings.findUnique({ where: { id: 1 } })).toMatchObject({
				encryptedPassword: "backup-password-ciphertext",
				passwordIv: "backup-password-iv",
			});
			expect(await target.prisma.vapidKeys.findUnique({ where: { id: 1 } })).toMatchObject({
				encryptedPrivateKey: "vapid-ciphertext",
				privateKeyIv: "vapid-iv",
			});
			expect(await target.prisma.notificationChannel.count()).toBe(0);
			expect(await target.prisma.notificationSubscription.count()).toBe(0);
			expect(
				await target.prisma.libraryCleanupApproval.findUnique({
					where: { id: "issue815-executed-parent" },
				}),
			).toMatchObject({
				terminalAuditRecordedAt: null,
				terminalAuditRecoveryAttemptedAt: null,
			});
		});

		it("overrides a short client transaction default for a populated restore", async () => {
			const exported = await exportDatabase(source.prisma, { excludeOperationalHistory: true });
			const constrainedTarget = withInteractiveTransactionDefaultTimeout(target.prisma, 1, 25);

			await expect(restoreDatabase(constrainedTarget, exported)).resolves.toBeUndefined();
			expect(await target.prisma.queueCleanerConfig.count()).toBe(1);
			expect(await target.prisma.notificationChannel.count()).toBe(1);
		});
	},
);
