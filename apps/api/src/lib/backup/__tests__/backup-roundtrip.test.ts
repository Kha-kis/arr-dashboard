import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import { exportDatabase, restoreDatabase } from "../backup-database.js";
import { BACKUP_VERSION, validateBackup } from "../backup-validation.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const execFileAsync = promisify(execFile);

type DatabaseHandle = { prisma: PrismaClient; cleanup: () => Promise<void> };

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
		},
	});
}

function normalizedRows(rows: unknown[]): string[] {
	return rows
		.map((row) =>
			JSON.stringify(row, (_key, value) => (value instanceof Date ? value.toISOString() : value)),
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
		});

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
		});

		it("restores every durable model and encrypted field into a fresh target", async () => {
			const exported = await exportDatabase(source.prisma, { excludeOperationalHistory: true });
			const backup = {
				version: BACKUP_VERSION,
				appVersion: "2.24.2",
				timestamp: new Date().toISOString(),
				data: exported,
				secrets: { encryptionKey: "key", sessionCookieSecret: "session" },
			};
			validateBackup(backup);
			await restoreDatabase(target.prisma, backup.data);

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
		});
	},
);
