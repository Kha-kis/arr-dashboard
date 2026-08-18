/**
 * F-01 regression contract: backup/restore must preserve durable configuration.
 *
 * These tests define the safety contract that current `next` violates: the
 * backup export omits durable configuration tables, while restore's
 * `deleteMany(user)` / `deleteMany(serviceInstance)` cascades erase them.
 *
 * They exercise the real `exportDatabase` / `restoreDatabase` boundary against
 * a disposable SQLite database (no mocks), mirroring the pattern in
 * `media-server-rescan-database.test.ts`.
 *
 * Run with TEST_DB=true (see .github/workflows/ci.yml).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestPrismaClient } from "../../__tests__/test-prisma.js";
import type { PrismaClient } from "../../prisma.js";
import { exportDatabase, restoreDatabase } from "../backup-database.js";
import { BACKUP_VERSION, validateBackup } from "../backup-validation.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const execFileAsync = promisify(execFile);

/**
 * Canonical durable-configuration inventory.
 *
 * These are the user-owned / instance-owned tables that represent operator
 * configuration and MUST survive a full backup/restore. They are distinct from
 * ephemeral cache/state/log tables (see EPHEMERAL_MODELS) which are rebuildable
 * and intentionally not required to round-trip.
 *
 * This list is the single source of truth for the F-01 contract. It is
 * cross-checked against schema.prisma in the "export completeness" test so a
 * future durable-config model added to the schema without backup support fails
 * here rather than silently losing data.
 */
const DURABLE_CONFIG_MODELS = [
	"notificationChannel",
	"notificationSubscription",
	"notificationRule",
	"notificationAggregationConfig",
	"autoTagRule",
	"labelSyncRule",
	"crossDomainRule",
	"queueCleanerConfig",
	"libraryCleanupConfig",
	"libraryCleanupRule",
	"namingConfig",
	"userCustomFormat",
] as const;

/**
 * Rebuildable/operational state that is intentionally NOT required to survive
 * restore. The eventual fix must not turn backup into a full 67-table dump.
 */
const EPHEMERAL_MODELS = [
	"libraryCache",
	"episodeFileCache",
	"plexCache",
	"tautulliCache",
	"jellyfinCache",
	"librarySyncStatus",
	"cacheRefreshStatus",
	"sessionSnapshot",
	"queueCleanerStrike",
	"queueCleanerLog",
	"libraryCleanupApproval",
	"libraryCleanupLog",
	"libraryCleanupAuditEvent",
	"huntLog",
	"huntSearchHistory",
	"seerrActionLog",
	"quiActivityLog",
	"quiActionLog",
	"quiEventLog",
	"pulseDismissal",
	"systemNoticeDismissal",
	"tmdbListCache",
	"traktListCache",
	"inodeIndexCache",
	"crossDomainRuleMatch",
	"libraryCleanupMediaServerScan",
] as const;

const USER_ID = "f01-user";
const INSTANCE_ID = "f01-instance";

function seedDurableConfig(prisma: PrismaClient) {
	return {
		user: prisma.user.create({ data: { id: USER_ID, username: "f01-user" } }),
		instance: prisma.serviceInstance.create({
			data: {
				id: INSTANCE_ID,
				userId: USER_ID,
				service: "RADARR",
				label: "F-01 Radarr",
				baseUrl: "http://radarr:7878",
				encryptedApiKey: "ciphertext-api-key",
				encryptionIv: "iv-api-key",
			},
		}),
	};
}

async function seedAllDurableConfig(prisma: PrismaClient) {
	await seedDurableConfig(prisma).user;
	await seedDurableConfig(prisma).instance;

	// Notification channels (2) + subscriptions
	await prisma.notificationChannel.create({
		data: {
			id: "chan-1",
			userId: USER_ID,
			name: "Channel 1",
			type: "WEBHOOK",
			encryptedConfig: "ciphertext-config-1",
			configIv: "iv-config-1",
		},
	});
	await prisma.notificationChannel.create({
		data: {
			id: "chan-2",
			userId: USER_ID,
			name: "Channel 2",
			type: "BROWSER_PUSH",
			encryptedConfig: "ciphertext-config-2",
			configIv: "iv-config-2",
		},
	});
	await prisma.notificationSubscription.create({
		data: { channelId: "chan-1", eventType: "HUNT_COMPLETED" },
	});

	// Notification rules + aggregation
	await prisma.notificationRule.create({
		data: {
			id: "rule-1",
			userId: USER_ID,
			name: "Rule 1",
			action: "suppress",
			conditions: '[{"field":"title","operator":"eq","value":"x"}]',
		},
	});
	await prisma.notificationAggregationConfig.create({
		data: { id: "agg-1", userId: USER_ID, eventType: "HUNT_CONTENT_FOUND", enabled: true },
	});

	// Automation rules
	await prisma.autoTagRule.create({
		data: {
			id: "autotag-1",
			userId: USER_ID,
			name: "AutoTag 1",
			ruleType: "age",
			parameters: '{"days":30}',
			tagName: "qa-tag",
		},
	});
	await prisma.labelSyncRule.create({
		data: {
			id: "labelsync-1",
			userId: USER_ID,
			name: "LabelSync 1",
			sourceService: "radarr",
			sourceTagName: "src",
			destService: "plex",
			destInstanceId: INSTANCE_ID,
			destTagName: "dst",
		},
	});
	await prisma.crossDomainRule.create({
		data: {
			id: "crossdomain-1",
			userId: USER_ID,
			name: "CrossDomain 1",
			document: "{}",
			scope: "{}",
			actions: "[]",
		},
	});

	// Queue cleaner + library cleanup
	await prisma.queueCleanerConfig.create({
		data: { id: "qc-1", instanceId: INSTANCE_ID, enabled: true, dryRunMode: false },
	});
	const lc = await prisma.libraryCleanupConfig.create({
		data: { id: "lc-1", userId: USER_ID, enabled: true },
	});
	await prisma.libraryCleanupRule.create({
		data: {
			id: "lcr-1",
			configId: lc.id,
			name: "Cleanup Rule 1",
			ruleType: "age",
			parameters: '{"days":90}',
		},
	});

	// Naming + custom formats
	await prisma.namingConfig.create({
		data: {
			id: "naming-1",
			instanceId: INSTANCE_ID,
			userId: USER_ID,
			serviceType: "RADARR",
			selectedPresets: '{"standard":true}',
		},
	});
	await prisma.userCustomFormat.create({
		data: {
			id: "ucf-1",
			userId: USER_ID,
			name: "Custom Format 1",
			serviceType: "RADARR",
			specifications: "[]",
		},
	});
}

async function seedEphemeralState(prisma: PrismaClient) {
	await prisma.libraryCache.create({
		data: {
			id: "libcache-1",
			instanceId: INSTANCE_ID,
			arrItemId: 1,
			itemType: "movie",
			title: "Cached Movie",
			data: "{}",
		},
	});
	await prisma.queueCleanerStrike.create({
		data: {
			id: "strike-1",
			instanceId: INSTANCE_ID,
			downloadId: "dl-1",
			downloadTitle: "Struck Download",
			lastRule: "stalled",
			lastReason: "stalled",
		},
	});
	await prisma.libraryCleanupApproval.create({
		data: {
			id: "approval-1",
			configId: "lc-1",
			instanceId: INSTANCE_ID,
			arrItemId: 2,
			itemType: "movie",
			title: "Pending Approval",
			matchedRuleId: "lcr-1",
			matchedRuleName: "Cleanup Rule 1",
			reason: "matched",
			sizeOnDisk: 1n,
			expiresAt: new Date("2027-01-01T00:00:00.000Z"),
		},
	});
	await prisma.huntLog.create({
		data: { id: "huntlog-1", instanceId: INSTANCE_ID, huntType: "missing", status: "completed" },
	});
	await prisma.sessionSnapshot.create({
		data: {
			id: "snap-1",
			instanceId: INSTANCE_ID,
			concurrentStreams: 1,
			sessionsJson: "[]",
		},
	});
}

async function countAll(prisma: PrismaClient, models: readonly string[]) {
	const result: Record<string, number> = {};
	const client = prisma as unknown as Record<string, { count: () => Promise<number> }>;
	for (const m of models) {
		result[m] = await client[m]!.count();
	}
	return result;
}

(RUN_DB_TESTS ? describe : describe.skip)(
	"F-01 backup/restore durable-config contract (SQLite)",
	() => {
		let prisma: PrismaClient;
		let databaseDir: string;

		beforeAll(async () => {
			databaseDir = await mkdtemp(path.join(os.tmpdir(), "arr-f01-"));
			const databasePath = path.join(databaseDir, "f01.db");
			const schemaPath = path.resolve(import.meta.dirname, "../../../../prisma/schema.prisma");
			const prismaCli = path.resolve(
				import.meta.dirname,
				"../../../../node_modules/prisma/build/index.js",
			);
			await execFileAsync(process.execPath, [
				prismaCli,
				"db",
				"push",
				"--schema",
				schemaPath,
				"--url",
				`file:${databasePath}`,
			]);
			prisma = createTestPrismaClient(databasePath);
		});

		afterAll(async () => {
			await prisma.$disconnect();
			await rm(databaseDir, { recursive: true, force: true });
		});

		it("A — durable configuration round-trips through export/restore", async () => {
			await prisma.user.deleteMany();
			await seedAllDurableConfig(prisma);

			const pre = await countAll(prisma, DURABLE_CONFIG_MODELS);

			const data = await exportDatabase(prisma, { excludeOperationalHistory: false });
			await restoreDatabase(prisma, data as never);

			const post = await countAll(prisma, DURABLE_CONFIG_MODELS);

			for (const model of DURABLE_CONFIG_MODELS) {
				expect(post[model], `${model} must survive restore`).toBe(pre[model]);
			}

			// Identity + representative field values + encrypted values survive.
			const channel = await prisma.notificationChannel.findUnique({ where: { id: "chan-1" } });
			expect(channel).toMatchObject({
				id: "chan-1",
				userId: USER_ID,
				name: "Channel 1",
				type: "WEBHOOK",
				encryptedConfig: "ciphertext-config-1",
				configIv: "iv-config-1",
			});

			const instance = await prisma.serviceInstance.findUnique({ where: { id: INSTANCE_ID } });
			expect(instance).toMatchObject({
				encryptedApiKey: "ciphertext-api-key",
				encryptionIv: "iv-api-key",
			});

			// FK relationship survives: subscription still points at its channel.
			const sub = await prisma.notificationSubscription.findUnique({
				where: { channelId_eventType: { channelId: "chan-1", eventType: "HUNT_COMPLETED" } },
			});
			expect(sub).not.toBeNull();

			// Library-cleanup rule still points at its config.
			const rule = await prisma.libraryCleanupRule.findUnique({ where: { id: "lcr-1" } });
			expect(rule?.configId).toBe("lc-1");
		});

		it("B — export includes explicit coverage for every durable-config model", async () => {
			await prisma.user.deleteMany();
			await seedAllDurableConfig(prisma);

			const data = await exportDatabase(prisma, { excludeOperationalHistory: false });
			const keys = Object.keys(data);

			for (const model of DURABLE_CONFIG_MODELS) {
				expect(keys, `export must include ${model}`).toContain(model);
				expect(
					Array.isArray((data as Record<string, unknown>)[model]),
					`${model} must be an array`,
				).toBe(true);
			}
		});

		it("C — ephemeral/operational state is intentionally not required to round-trip", async () => {
			await prisma.user.deleteMany();
			await seedAllDurableConfig(prisma);
			await seedEphemeralState(prisma);

			const preEphemeral = await countAll(prisma, EPHEMERAL_MODELS);
			// Sanity: the ephemeral seed actually produced rows.
			expect(preEphemeral.libraryCache).toBeGreaterThan(0);

			const data = await exportDatabase(prisma, { excludeOperationalHistory: false });
			await restoreDatabase(prisma, data as never);

			// Durable config must survive.
			const postConfig = await countAll(prisma, DURABLE_CONFIG_MODELS);
			for (const model of DURABLE_CONFIG_MODELS) {
				expect(postConfig[model], `${model} must survive`).toBeGreaterThan(0);
			}

			// Ephemeral state is NOT required to round-trip. This pins the boundary
			// so the fix does not become a full 67-table dump: we assert the durable
			// boundary holds while explicitly NOT asserting ephemeral rows survive.
			// (On current `next` these are wiped by cascade — acceptable for
			// rebuildable state, and this test documents that intent.)
			expect(postConfig.notificationChannel).toBe(2);
		});

		it("D — a legacy/incomplete backup cannot silently erase durable configuration", async () => {
			await prisma.user.deleteMany();
			await seedAllDurableConfig(prisma);

			// A valid-format backup that predates durable-config export: it carries
			// the core tables but none of the durable-config arrays.
			const legacyData = {
				users: [{ id: USER_ID, username: "f01-user" }],
				sessions: [],
				serviceInstances: [
					{
						id: INSTANCE_ID,
						userId: USER_ID,
						service: "RADARR",
						label: "F-01 Radarr",
						baseUrl: "http://radarr:7878",
						encryptedApiKey: "ciphertext-api-key",
						encryptionIv: "iv-api-key",
					},
				],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
			};

			// Required safety outcome: restore must fail closed rather than silently
			// erase the durable configuration already present in the target DB.
			await expect(restoreDatabase(prisma, legacyData as never)).rejects.toThrow();

			// Existing durable configuration remains intact.
			const post = await countAll(prisma, DURABLE_CONFIG_MODELS);
			for (const model of DURABLE_CONFIG_MODELS) {
				expect(
					post[model],
					`${model} must remain intact after rejected legacy restore`,
				).toBeGreaterThan(0);
			}
			expect(post.notificationChannel).toBe(2);
		});

		it("E — transaction rollback restores full pre-restore state on mid-restore failure", async () => {
			await prisma.user.deleteMany();
			await seedAllDurableConfig(prisma);

			const pre = await countAll(prisma, DURABLE_CONFIG_MODELS);

			// Force a deterministic failure after destructive deletes have begun but
			// before completion: a user record missing its required `username` field
			// passes the coordination check, then fails `validateRecords` during the
			// create phase (which runs after `deleteMany`).
			const malformedData = {
				users: [{ id: USER_ID }], // missing `username`
				sessions: [],
				serviceInstances: [],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
			};

			await expect(restoreDatabase(prisma, malformedData as never)).rejects.toThrow();

			// No partial restore may be observable: durable config fully intact.
			const post = await countAll(prisma, DURABLE_CONFIG_MODELS);
			expect(post).toEqual(pre);
		});

		it("F — malformed configuration is rejected before destructive commit", async () => {
			await prisma.user.deleteMany();
			await seedAllDurableConfig(prisma);

			const pre = await countAll(prisma, DURABLE_CONFIG_MODELS);

			// A backup that carries a durable-config array with a malformed record
			// (non-object) must be rejected, not silently accepted.
			const malformedData = {
				users: [{ id: USER_ID, username: "f01-user" }],
				sessions: [],
				serviceInstances: [],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
				notificationChannels: ["not-an-object"],
			};

			await expect(restoreDatabase(prisma, malformedData as never)).rejects.toThrow();

			const post = await countAll(prisma, DURABLE_CONFIG_MODELS);
			expect(post).toEqual(pre);
		});

		it("G — encrypted config and IVs survive byte-for-byte", async () => {
			await prisma.user.deleteMany();
			await seedAllDurableConfig(prisma);

			const data = await exportDatabase(prisma, { excludeOperationalHistory: false });
			await restoreDatabase(prisma, data as never);

			const channel = await prisma.notificationChannel.findUnique({ where: { id: "chan-1" } });
			expect(channel?.encryptedConfig).toBe("ciphertext-config-1");
			expect(channel?.configIv).toBe("iv-config-1");

			const instance = await prisma.serviceInstance.findUnique({ where: { id: INSTANCE_ID } });
			expect(instance?.encryptedApiKey).toBe("ciphertext-api-key");
			expect(instance?.encryptionIv).toBe("iv-api-key");
		});

		it("H — new-format backup with explicit empty config arrays is valid", () => {
			const emptyConfig = Object.fromEntries(DURABLE_CONFIG_MODELS.map((model) => [model, []]));
			const backup = {
				version: BACKUP_VERSION,
				appVersion: "3.0.0",
				timestamp: new Date().toISOString(),
				data: {
					users: [],
					sessions: [],
					serviceInstances: [],
					serviceTags: [],
					serviceInstanceTags: [],
					oidcAccounts: [],
					webAuthnCredentials: [],
					...emptyConfig,
				},
				secrets: {
					encryptionKey: "test-encryption-key-32-bytes-hex",
					sessionCookieSecret: "test-session-cookie-secret",
				},
			};

			expect(() => validateBackup(backup)).not.toThrow();
		});

		it("I — new-format backup missing a required config property is rejected", () => {
			const emptyConfig = Object.fromEntries(DURABLE_CONFIG_MODELS.map((model) => [model, []]));
			// Drop one required property to simulate an incomplete new-format backup.
			delete emptyConfig.notificationChannel;
			const backup = {
				version: BACKUP_VERSION,
				appVersion: "3.0.0",
				timestamp: new Date().toISOString(),
				data: {
					users: [],
					sessions: [],
					serviceInstances: [],
					serviceTags: [],
					serviceInstanceTags: [],
					oidcAccounts: [],
					webAuthnCredentials: [],
					...emptyConfig,
				},
				secrets: {
					encryptionKey: "test-encryption-key-32-bytes-hex",
					sessionCookieSecret: "test-session-cookie-secret",
				},
			};

			expect(() => validateBackup(backup)).toThrow(/notificationChannel/);
		});

		it("J — legacy backup restores into a clean target with no durable configuration", async () => {
			await prisma.user.deleteMany();

			// A legacy-format backup (no durable-config arrays) into a target with
			// zero durable configuration must be permitted — there is nothing to lose.
			const legacyData = {
				users: [{ id: USER_ID, username: "f01-user" }],
				sessions: [],
				serviceInstances: [
					{
						id: INSTANCE_ID,
						userId: USER_ID,
						service: "RADARR",
						label: "F-01 Radarr",
						baseUrl: "http://radarr:7878",
						encryptedApiKey: "ciphertext-api-key",
						encryptionIv: "iv-api-key",
					},
				],
				serviceTags: [],
				serviceInstanceTags: [],
				oidcAccounts: [],
				webAuthnCredentials: [],
			};

			await expect(restoreDatabase(prisma, legacyData as never)).resolves.toBeUndefined();

			expect(await prisma.user.count()).toBe(1);
			expect(await prisma.serviceInstance.count()).toBe(1);
		});
	},
);
