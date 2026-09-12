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

type DatabaseHandle = {
	prisma: PrismaClient;
	concurrent?: PrismaClient;
	cleanup: () => Promise<void>;
};

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

type Deferred = {
	promise: Promise<void>;
	resolve: () => void;
};

function deferred(): Deferred {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function withRestoreAttemptBarrier(prisma: PrismaClient): {
	prisma: PrismaClient;
	rootPreflightComplete: Promise<void>;
	innerCurrentAttemptRead: Promise<void>;
	releaseTransaction: () => void;
} {
	const rootPreflight = deferred();
	const innerRead = deferred();
	const release = deferred();
	let innerReadSeen = false;

	function wrapClient(client: PrismaClient | Prisma.TransactionClient, isRoot: boolean) {
		return new Proxy(client, {
			get(target, property) {
				if (property !== "labelSyncMutationAttempt") {
					const value = Reflect.get(target, property, target);
					return typeof value === "function" ? value.bind(target) : value;
				}
				const delegate = Reflect.get(target, property, target);
				if (!delegate || typeof delegate !== "object") return delegate;
				return new Proxy(delegate, {
					get(delegateTarget, delegateProperty) {
						const value = Reflect.get(delegateTarget, delegateProperty, delegateTarget);
						if (delegateProperty !== "findMany" || typeof value !== "function") {
							return typeof value === "function" ? value.bind(delegateTarget) : value;
						}
						return async (...args: unknown[]) => {
							const result = await value.apply(delegateTarget, args);
							if (!isRoot && !innerReadSeen) {
								innerReadSeen = true;
								innerRead.resolve();
								await release.promise;
							}
							return result;
						};
					},
				});
			},
		}) as PrismaClient | Prisma.TransactionClient;
	}

	const rootTransaction = prisma.$transaction.bind(prisma) as InteractiveTransaction;
	const guardedRoot = new Proxy(prisma, {
		get(target, property) {
			if (property === "$transaction") {
				return (
					operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
					options?: Parameters<InteractiveTransaction>[1],
				) =>
					rootTransaction(async (tx) => {
						rootPreflight.resolve();
						return operation(wrapClient(tx, false) as Prisma.TransactionClient);
					}, options);
			}
			const value = Reflect.get(target, property, target);
			return value === undefined ? value : Reflect.get(wrapClient(target, true), property, target);
		},
	}) as PrismaClient;

	return {
		prisma: guardedRoot,
		rootPreflightComplete: rootPreflight.promise,
		innerCurrentAttemptRead: innerRead.promise,
		releaseTransaction: release.resolve,
	};
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
		const concurrentPool = new pg.default.Pool({
			connectionString: withPostgresSchema(connectionString, targetSchema),
		});
		pools.push(concurrentPool);
		const concurrentPrisma = new generatedExports.PrismaClient({
			adapter: new PrismaPg(concurrentPool as never, { schema: targetSchema }),
		});
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
				concurrent: concurrentPrisma,
				cleanup: async () => {
					await targetPrisma.$disconnect();
					await concurrentPrisma.$disconnect();
					await pools[1]?.end();
					await pools[2]?.end();
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
	const jellyfinInstanceId = "issue815-jellyfin-instance";
	await prisma.serviceInstance.create({
		data: {
			id: jellyfinInstanceId,
			userId,
			service: "JELLYFIN",
			label: "Issue 815 Jellyfin",
			baseUrl: "http://jellyfin.example",
			encryptedApiKey: "jellyfin-api-ciphertext",
			encryptionIv: "jellyfin-api-iv",
		},
	});
	await prisma.serviceInstanceTag.create({ data: { instanceId, tagId: "issue815-tag" } });
	await prisma.librarySyncStatus.create({
		data: {
			id: "issue815-library-sync-status",
			instanceId,
			pollingEnabled: false,
			pollingIntervalMins: 90,
			lastFullSync: coordinationCreatedAt,
			lastIncrementalSync: coordinationUpdatedAt,
			syncInProgress: true,
			lastSyncDurationMs: 815,
			lastError: "source-era sync error",
			itemCount: 123,
		},
	});
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
	await prisma.labelSyncRule.create({
		data: {
			id: "issue815-jellyfin-label-sync",
			userId,
			name: "Issue 815 Jellyfin label sync",
			sourceService: "radarr",
			sourceTagName: "source",
			destService: "jellyfin",
			destInstanceId: jellyfinInstanceId,
			destTagName: "destination",
		},
	});
	await prisma.labelSyncMutationAttempt.create({
		data: {
			id: "issue815-terminal-attempt",
			userId,
			ruleId: "issue815-jellyfin-label-sync",
			destinationInstanceId: jellyfinInstanceId,
			provider: "jellyfin",
			mediaType: "movie",
			tmdbId: 815,
			connectionGeneration: 0,
			identityGeneration: 0,
			targetItemId: "issue815-terminal-item",
			libraryId: "issue815-terminal-library",
			intentFingerprint: "issue815-terminal-intent",
			ruleFingerprint: "issue815-terminal-rule",
			destinationTag: "destination",
			activeOperationKey: null,
			claimToken: null,
			sendAttemptCount: 1,
			reconcileAttemptCount: 0,
			requestStartedAt: coordinationCreatedAt,
			lastObservedAt: coordinationUpdatedAt,
			completedAt: coordinationUpdatedAt,
			status: "verified",
			reasonCode: "applied",
			createdAt: coordinationCreatedAt,
			updatedAt: coordinationUpdatedAt,
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
	const observationRun = await prisma.providerObservationRun.create({
		data: {
			id: "issue815-observation-run",
			instanceId: jellyfinInstanceId,
			provider: "jellyfin_episode",
			cacheType: "jellyfin_episode",
			authorityKey: "a".repeat(64),
			activeSlotKey: "c".repeat(64),
			parentGenerationId: `jellyfin-episode-parent-v3:${"e".repeat(64)}`,
			targetDigest: "b".repeat(64),
			targetCount: 1,
			connectionGeneration: 0,
			identityGeneration: 0,
			state: "running",
			totalUnits: 1,
			totalWork: 1,
		},
	});
	const observationUnit = await prisma.providerObservationUnit.create({
		data: {
			id: "issue815-observation-unit",
			runId: observationRun.id,
			ordinal: 0,
			scopeKey: "issue815-scope",
			scopePayload: JSON.stringify({
				userId: "private-catalog-scope-user",
				libraryId: "private-catalog-scope-library",
				catalogProvenance: {
					version: 3,
					scopes: [
						{ userId: "private-catalog-scope-user", libraryId: "private-catalog-scope-library" },
					],
					bindings: [
						{
							libraryId: "private-catalog-scope-library",
							seriesId: "private-catalog-source-series",
							tmdbId: 42,
						},
					],
				},
			}),
			scopeDigest: "d".repeat(64),
			phase: "collect",
			expectedTargets: 1,
			state: "pending",
		},
	});
	await prisma.jellyfinEpisodeObservationStage.create({
		data: {
			id: "issue815-observation-stage",
			runId: observationRun.id,
			unitId: observationUnit.id,
			userKeyDigest: "issue815-user-digest",
			pass: "head",
			jellyfinId: "issue815-episode",
			seriesId: "issue815-series",
			seasonNumber: 1,
			episodeNumber: 1,
			title: "Issue 815 episode",
			played: true,
			playCount: 1,
			lastPlayedAt: coordinationUpdatedAt,
			userName: "issue815-user",
		},
	});
	await prisma.jellyfinEpisodeObservationExclusion.create({
		data: {
			id: "issue815-observation-exclusion",
			runId: observationRun.id,
			unitId: observationUnit.id,
			userKeyDigest: "issue815-user-digest",
			pass: "head",
			jellyfinId: "issue815-excluded-episode",
			reason: "missing-episode-metadata",
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
	["labelSyncMutationAttempts", "labelSyncMutationAttempt"],
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
			expect(JSON.stringify(exported)).not.toContain("private-catalog-scope-user");
			expect(JSON.stringify(exported)).not.toContain("private-catalog-source-series");
			expect(JSON.stringify(exported)).not.toContain("catalogProvenance");
			expect(JSON.stringify(exported)).not.toContain("providerObservationRuns");
			expect(JSON.stringify(exported)).not.toContain("providerObservationUnits");
			expect(JSON.stringify(exported)).not.toContain("plexEpisodeObservationStages");
			expect(JSON.stringify(exported)).not.toContain("jellyfinEpisodeObservationStages");
			const exportedLibrarySyncSettings = exported.librarySyncSettings as Array<
				Record<string, unknown>
			>;
			const backup = {
				version: BACKUP_VERSION,
				appVersion: "2.24.2",
				timestamp: new Date().toISOString(),
				data: {
					...exported,
					librarySyncSettings: exportedLibrarySyncSettings.map((settings) => ({
						...settings,
						syncInProgress: true,
						lastError: "injected stale state",
						itemCount: 999,
					})),
				},
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
			expect(await target.prisma.providerObservationRun.count()).toBe(0);
			expect(await target.prisma.providerObservationUnit.count()).toBe(0);
			expect(await target.prisma.plexEpisodeObservationStage.count()).toBe(0);
			expect(await target.prisma.jellyfinEpisodeObservationStage.count()).toBe(0);
			expect(await target.prisma.jellyfinEpisodeObservationExclusion.count()).toBe(0);
			expect(await target.prisma.notificationLog.count()).toBe(0);
			expect(await target.prisma.trashCache.count()).toBe(0);
			expect(await target.prisma.libraryCleanupMediaServerScanLease.count()).toBe(0);
			expect(exported.librarySyncSettings).toEqual([
				{
					instanceId: "issue815-roundtrip-instance",
					pollingEnabled: false,
					pollingIntervalMins: 90,
				},
			]);
			expect(
				await target.prisma.librarySyncStatus.findUnique({
					where: { instanceId: "issue815-roundtrip-instance" },
				}),
			).toMatchObject({
				instanceId: "issue815-roundtrip-instance",
				pollingEnabled: false,
				pollingIntervalMins: 90,
				lastFullSync: null,
				lastIncrementalSync: null,
				syncInProgress: false,
				lastSyncDurationMs: null,
				lastError: null,
				itemCount: 0,
			});

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

		it.skipIf(!process.env.TEST_DATABASE_URL?.startsWith("postgres"))(
			"does not erase an attempt created concurrently with destructive restore",
			async () => {
				const concurrent = target.concurrent;
				if (!concurrent)
					throw new Error("Independent PostgreSQL concurrency client is unavailable");
				const exported = await exportDatabase(source.prisma, { excludeOperationalHistory: true });
				const {
					prisma: barrierTarget,
					rootPreflightComplete,
					innerCurrentAttemptRead,
					releaseTransaction,
				} = withRestoreAttemptBarrier(target.prisma);
				const attempt = {
					id: "issue815-concurrent-attempt",
					userId: "issue815-roundtrip-user",
					ruleId: "issue815-jellyfin-label-sync",
					destinationInstanceId: "issue815-jellyfin-instance",
					provider: "jellyfin",
					mediaType: "movie",
					tmdbId: 815,
					connectionGeneration: 0,
					identityGeneration: 0,
					targetItemId: "concurrent-item",
					libraryId: "concurrent-library",
					intentFingerprint: "concurrent-intent",
					ruleFingerprint: "concurrent-rule",
					destinationTag: "concurrent-tag",
					activeOperationKey: "concurrent-operation",
					claimToken: null,
					sendAttemptCount: 1,
					reconcileAttemptCount: 0,
					requestStartedAt: new Date("2026-09-05T00:00:00.000Z"),
					lastObservedAt: null,
					completedAt: null,
					status: "unknown",
					reasonCode: "uncertain_send",
				};

				const restoreResult = restoreDatabase(barrierTarget, exported);
				await rootPreflightComplete;
				await innerCurrentAttemptRead;
				await concurrent.labelSyncMutationAttempt.create({ data: attempt });
				releaseTransaction();
				await expect(restoreResult).rejects.toThrow();
				const persisted = await target.prisma.labelSyncMutationAttempt.findUnique({
					where: { id: attempt.id },
				});
				expect(persisted).not.toBeNull();
			},
		);
	},
);
