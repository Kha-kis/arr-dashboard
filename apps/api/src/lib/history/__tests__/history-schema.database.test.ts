import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

const apiRoot = resolve(process.cwd());
const schemaPath = resolve(apiRoot, "prisma/schema.prisma");
// Exact schema from stable base e405d5e7d0f3653e428dae1c2a2dd4ff958adea3.
const preHistorySchemaPath = resolve(
	apiRoot,
	"src/lib/history/__tests__/fixtures/pre-history-schema.prisma",
);
const temporaryDirectories: string[] = [];

const historyUserRelations = ["historyCollectionLease HistoryCollectionLease?"];
const historyInstanceRelations = [
	"historyObservations HistoryObservation[]",
	"historySourceStatus HistorySourceStatus?",
];
const historyModels = ["HistoryObservation", "HistorySourceStatus", "HistoryCollectionLease"];
const labelSyncMutationAttemptRelations = [
	["User", "labelSyncMutationAttempts LabelSyncMutationAttempt[]"],
	["ServiceInstance", "labelSyncMutationAttempts LabelSyncMutationAttempt[]"],
	["LabelSyncRule", "mutationAttempts LabelSyncMutationAttempt[]"],
] as const;
const providerObservationRelations = [
	["ServiceInstance", "providerObservationRuns ProviderObservationRun[]"],
] as const;
const providerObservationModels = [
	"ProviderObservationRun",
	"ProviderObservationUnit",
	"PlexEpisodeObservationStage",
	"JellyfinEpisodeObservationStage",
] as const;

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("durable History schema", () => {
	it("classifies only the documented Prisma destructive refusal signature", () => {
		const diagnostic = [
			"Prisma schema push exited with status 1",
			"The following tables will be removed: history_observations, history_source_statuses, history_collection_leases",
			"You may use the --accept-data-loss flag to ignore these warnings",
		].join(" ");
		expect(classifySchemaPushFailure(1, diagnostic)).toBe("destructive-refusal");
		expect(classifySchemaPushFailure(2, diagnostic)).toBe("unexpected");
		expect(classifySchemaPushFailure(1, "Use --accept-data-loss for an unrelated change")).toBe(
			"unexpected",
		);
		expect(
			classifySchemaPushFailure(
				1,
				"The following tables will be removed: history_observations; use --accept-data-loss",
			),
		).toBe("unexpected");
	});

	it("matches the additive ledger, status, and lease contract", () => {
		const schema = normalizeSchemaText(readFileSync(schemaPath, "utf8"));
		for (const relation of historyUserRelations) {
			expect(countTrimmedLines(modelBlock(schema, "User"), relation), relation).toBe(1);
		}
		for (const relation of historyInstanceRelations) {
			expect(countTrimmedLines(modelBlock(schema, "ServiceInstance"), relation), relation).toBe(1);
		}
		expect(countTrimmedLines(modelBlock(schema, "ServiceInstance"), "@@unique([id, userId])")).toBe(
			0,
		);
		expect(
			countTrimmedLines(modelBlock(schema, "User"), "historyObservations HistoryObservation[]"),
		).toBe(0);
		expect(
			countTrimmedLines(modelBlock(schema, "User"), "historySourceStatuses HistorySourceStatus[]"),
		).toBe(0);

		const observation = modelBlock(schema, "HistoryObservation");
		expectSchemaLine(observation, "id                   String   @id @default(cuid())");
		expectSchemaLine(observation, "instanceId           String");
		expectSchemaLine(observation, "connectionGeneration Int");
		expectSchemaLine(observation, "providerEventId      Int");
		expectSchemaLine(observation, "eventAt              DateTime");
		expectSchemaLine(observation, "eventTypeKey         String");
		expectSchemaLine(observation, "searchText           String");
		expectSchemaLine(observation, "normalizedPayload    String");
		expectSchemaLine(observation, "firstObservedAt      DateTime");
		expectSchemaLine(observation, "lastObservedAt       DateTime");
		expectSchemaLine(
			observation,
			"instance ServiceInstance @relation(fields: [instanceId], references: [id], onDelete: Cascade, onUpdate: Restrict)",
		);
		expectSchemaLine(observation, "@@unique([instanceId, connectionGeneration, providerEventId])");
		expectSchemaLine(observation, "@@index([eventAt, id])");
		expectSchemaLine(observation, "@@index([instanceId, connectionGeneration, eventAt, id])");
		expectSchemaLine(
			observation,
			"@@index([instanceId, connectionGeneration, firstObservedAt, id])",
		);
		expectSchemaLine(observation, '@@map("history_observations")');

		const sourceStatus = modelBlock(schema, "HistorySourceStatus");
		expectSchemaLine(sourceStatus, "instanceId               String    @id");
		expectSchemaLine(sourceStatus, "connectionGeneration     Int");
		expectSchemaLine(sourceStatus, "publishedAt              DateTime?");
		expectSchemaLine(sourceStatus, "publicationMetadata      String?");
		expectSchemaLine(sourceStatus, "retainedObservationCount Int       @default(0)");
		expectSchemaLine(sourceStatus, "lastAttemptAt            DateTime?");
		expectSchemaLine(sourceStatus, "lastAttemptResult        String?");
		expectSchemaLine(sourceStatus, "lastAttemptReason        String?");
		expectSchemaLine(sourceStatus, "publicationRevision      Int       @default(0)");
		expectSchemaLine(sourceStatus, "retentionEpoch           Int       @default(0)");
		expectSchemaLine(sourceStatus, "collectHeadNext          Boolean   @default(true)");
		expectSchemaLine(sourceStatus, "nextBackfillPage         Int       @default(2)");
		expectSchemaLine(sourceStatus, "activeCollectionPage     Int?");
		expectSchemaLine(
			sourceStatus,
			"instance ServiceInstance @relation(fields: [instanceId], references: [id], onDelete: Cascade, onUpdate: Restrict)",
		);
		expectSchemaLine(sourceStatus, '@@map("history_source_statuses")');

		const lease = modelBlock(schema, "HistoryCollectionLease");
		expectSchemaLine(lease, "userId            String   @id");
		expectSchemaLine(lease, "claimToken        String?   @unique");
		expectSchemaLine(lease, "claimedAt         DateTime?");
		expectSchemaLine(lease, "heartbeatAt       DateTime?");
		expectSchemaLine(lease, "expiresAt         DateTime?");
		expectSchemaLine(lease, "lastAttemptAt     DateTime?");
		expectSchemaLine(lease, "lastAttemptResult String?");
		expectSchemaLine(lease, "lastAttemptReason String?");
		expectSchemaLine(lease, "nextSourceCursor  String?");
		expectSchemaLine(lease, "updatedAt         DateTime  @updatedAt");
		expectSchemaLine(
			lease,
			"user User @relation(fields: [userId], references: [id], onDelete: Cascade)",
		);
		expectSchemaLine(lease, '@@map("history_collection_leases")');

		for (const model of [observation, sourceStatus, lease]) {
			for (const forbidden of [
				"error",
				"url",
				"credential",
				"title",
				"providerTotal",
				"deletion",
				"mutationAuthority",
			]) {
				expect(model).not.toMatch(new RegExp(`^\\s*${forbidden}\\b`, "m"));
			}
		}
		expect(observation).not.toMatch(/^\s*userId\b/m);
		expect(observation).not.toContain("User @relation");
		expect(sourceStatus).not.toMatch(/^\s*userId\b/m);
		expect(sourceStatus).not.toContain("User @relation");
	});

	it("pushes a fresh SQLite schema and stores canonical rows", { timeout: 30_000 }, () => {
		const { database, databasePath } = freshDatabase("history-fresh-");
		try {
			insertUser(database, "user-a", "user-a");
			insertUser(database, "user-b", "user-b");
			insertInstance(database, "instance-a", "user-a", 7);
			insertObservation(database, "observation-a", "instance-a", 7, 12);
			database
				.prepare(
					`INSERT INTO history_source_statuses (instanceId, connectionGeneration)
					 VALUES (?, ?)`,
				)
				.run("instance-a", 7);
			database
				.prepare("INSERT INTO history_collection_leases (userId, updatedAt) VALUES (?, ?)")
				.run("user-a", "2026-09-03T00:00:00.000Z");
			database
				.prepare("INSERT INTO history_collection_leases (userId, updatedAt) VALUES (?, ?)")
				.run("user-b", "2026-09-03T00:00:00.000Z");
			insertUser(database, "user-c", "user-c");
			database
				.prepare("INSERT INTO history_collection_leases (userId, updatedAt) VALUES (?, ?)")
				.run("user-c", "2026-09-03T00:00:00.000Z");
			insertUser(database, "user-d", "user-d");
			database
				.prepare("INSERT INTO history_collection_leases (userId, updatedAt) VALUES (?, ?)")
				.run("user-d", "2026-09-03T00:00:00.000Z");
			insertUser(database, "user-e", "user-e");

			const observation = database
				.prepare(
					`SELECT instanceId, connectionGeneration, providerEventId, eventTypeKey,
					 searchText, normalizedPayload
					 FROM history_observations WHERE id = ?`,
				)
				.get("observation-a");
			expect(observation).toEqual({
				instanceId: "instance-a",
				connectionGeneration: 7,
				providerEventId: 12,
				eventTypeKey: "download",
				searchText: "synthetic search",
				normalizedPayload: '{"kind":"synthetic"}',
			});
			expect(
				database
					.prepare(
						"SELECT retainedObservationCount, publicationRevision, retentionEpoch FROM history_source_statuses",
					)
					.get(),
			).toEqual({ retainedObservationCount: 0, publicationRevision: 0, retentionEpoch: 0 });
			expect(
				database
					.prepare(
						"SELECT claimToken, claimedAt, nextSourceCursor FROM history_collection_leases WHERE userId = ?",
					)
					.get("user-a"),
			).toEqual({
				claimToken: null,
				claimedAt: null,
				nextSourceCursor: null,
			});

			database
				.prepare("UPDATE history_collection_leases SET claimToken = ? WHERE userId = ?")
				.run("claim-a", "user-a");
			database
				.prepare("UPDATE history_collection_leases SET claimToken = ? WHERE userId = ?")
				.run("claim-b", "user-b");
			expect(() =>
				database
					.prepare(
						"INSERT INTO history_collection_leases (userId, claimToken, updatedAt) VALUES (?, ?, ?)",
					)
					.run("user-e", "claim-a", "2026-09-03T00:00:00.000Z"),
			).toThrow();
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_collection_leases WHERE userId = ?")
					.get("user-e"),
			).toEqual({ count: 0 });
			expect(
				database
					.prepare(
						"SELECT COUNT(*) AS count FROM history_collection_leases WHERE claimToken IS NULL",
					)
					.get(),
			).toEqual({ count: 2 });
		} finally {
			database.close();
		}
		expect(databasePath).toContain("history-fresh-");
	});

	it("rejects orphan History rows at the database boundary", { timeout: 30_000 }, () => {
		const { database } = freshDatabase("history-owner-");
		try {
			insertUser(database, "owner-a", "owner-a");
			insertUser(database, "owner-b", "owner-b");
			insertInstance(database, "owner-instance-a", "owner-a", 1);
			insertInstance(database, "owner-instance-b", "owner-b", 1);
			insertObservation(database, "owner-observation", "owner-instance-a", 1, 1);
			database
				.prepare(
					"INSERT INTO history_source_statuses (instanceId, connectionGeneration) VALUES (?, ?)",
				)
				.run("owner-instance-a", 1);
			expect(() =>
				insertObservation(database, "cross-owner-observation", "missing-instance", 1, 2),
			).toThrow();
			expect(() =>
				database
					.prepare(
						"INSERT INTO history_source_statuses (instanceId, connectionGeneration) VALUES (?, ?)",
					)
					.run("missing-instance", 1),
			).toThrow();
		} finally {
			database.close();
		}
	});

	it("scopes deduplication by instance and connection generation", { timeout: 30_000 }, () => {
		const { database } = freshDatabase("history-dedup-");
		try {
			insertUser(database, "dedup-user-a", "dedup-user-a");
			insertUser(database, "dedup-user-b", "dedup-user-b");
			insertInstance(database, "dedup-instance-a", "dedup-user-a", 1);
			insertInstance(database, "dedup-instance-b", "dedup-user-b", 1);
			insertObservation(database, "dedup-one", "dedup-instance-a", 1, 99);
			expect(() => insertObservation(database, "dedup-copy", "dedup-instance-a", 1, 99)).toThrow();
			insertObservation(database, "dedup-other-instance", "dedup-instance-b", 1, 99);
			insertObservation(database, "dedup-other-generation", "dedup-instance-a", 2, 99);
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_observations WHERE providerEventId = ?")
					.get(99),
			).toEqual({ count: 3 });
			expect(
				database
					.prepare(
						"SELECT ServiceInstance.userId AS owner, COUNT(*) AS count FROM history_observations JOIN ServiceInstance ON ServiceInstance.id = history_observations.instanceId WHERE providerEventId = ? GROUP BY ServiceInstance.userId ORDER BY owner",
					)
					.all(99),
			).toEqual([
				{ owner: "dedup-user-a", count: 2 },
				{ owner: "dedup-user-b", count: 1 },
			]);
		} finally {
			database.close();
		}
	});

	it("cascades owned history and restricts instance identity updates", { timeout: 30_000 }, () => {
		const { database } = freshDatabase("history-cascade-");
		try {
			insertUser(database, "cascade-a", "cascade-a");
			insertUser(database, "cascade-b", "cascade-b");
			insertInstance(database, "cascade-instance-a", "cascade-a", 1);
			insertInstance(database, "cascade-instance-b", "cascade-b", 1);
			insertObservation(database, "cascade-observation-a", "cascade-instance-a", 1, 1);
			insertObservation(database, "cascade-observation-b", "cascade-instance-b", 1, 2);
			for (const [userId, instanceId] of [
				["cascade-a", "cascade-instance-a"],
				["cascade-b", "cascade-instance-b"],
			]) {
				database
					.prepare(
						"INSERT INTO history_source_statuses (instanceId, connectionGeneration) VALUES (?, ?)",
					)
					.run(instanceId, 1);
				database
					.prepare("INSERT INTO history_collection_leases (userId, updatedAt) VALUES (?, ?)")
					.run(userId, "2026-09-03T00:00:00.000Z");
			}

			expect(() =>
				database
					.prepare("UPDATE ServiceInstance SET id = ? WHERE id = ?")
					.run("renamed-instance", "cascade-instance-a"),
			).toThrow();
			database.prepare("DELETE FROM ServiceInstance WHERE id = ?").run("cascade-instance-a");
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_observations WHERE instanceId = ?")
					.get("cascade-instance-a"),
			).toEqual({ count: 0 });
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_source_statuses WHERE instanceId = ?")
					.get("cascade-instance-a"),
			).toEqual({ count: 0 });
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_collection_leases WHERE userId = ?")
					.get("cascade-a"),
			).toEqual({ count: 1 });

			database.prepare("DELETE FROM User WHERE id = ?").run("cascade-b");
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM ServiceInstance WHERE userId = ?")
					.get("cascade-b"),
			).toEqual({ count: 0 });
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_observations WHERE instanceId = ?")
					.get("cascade-instance-b"),
			).toEqual({ count: 0 });
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_source_statuses WHERE instanceId = ?")
					.get("cascade-instance-b"),
			).toEqual({ count: 0 });
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_collection_leases WHERE userId = ?")
					.get("cascade-b"),
			).toEqual({ count: 0 });
			expect(
				database
					.prepare("SELECT COUNT(*) AS count FROM history_collection_leases WHERE userId = ?")
					.get("cascade-a"),
			).toEqual({ count: 1 });
		} finally {
			database.close();
		}
	});

	it("preserves old synthetic rows during an additive schema push", { timeout: 30_000 }, () => {
		const databasePath = emptyDatabasePath("history-upgrade-");
		const oldSchemaPath = materializePreHistorySchema();
		syncSchema(oldSchemaPath, databasePath);
		const oldDatabase = new Database(databasePath);
		try {
			insertUser(oldDatabase, "legacy-owner", "legacy-owner");
			insertInstance(oldDatabase, "legacy-instance", "legacy-owner", 4);
			insertLegacyPlexCache(oldDatabase);
		} finally {
			oldDatabase.close();
		}
		syncSchema(schemaPath, databasePath);

		const upgraded = new Database(databasePath, { readonly: true });
		try {
			expect(
				upgraded
					.prepare(
						"SELECT id, userId, service, label, baseUrl, encryptedApiKey, encryptionIv, encryptedHttpAuthCredentials, httpAuthEncryptionIv, connectionGeneration, identityStatus, identityGeneration FROM ServiceInstance WHERE id = ?",
					)
					.get("legacy-instance"),
			).toEqual({
				id: "legacy-instance",
				userId: "legacy-owner",
				service: "PLEX",
				label: "Synthetic instance",
				baseUrl: "https://synthetic.example.invalid",
				encryptedApiKey: "synthetic-api-ciphertext",
				encryptionIv: "synthetic-api-iv",
				encryptedHttpAuthCredentials: "synthetic-http-ciphertext",
				httpAuthEncryptionIv: "synthetic-http-iv",
				connectionGeneration: 4,
				identityStatus: "unverified",
				identityGeneration: 0,
			});
			expect(
				upgraded
					.prepare(
						"SELECT instanceId, tmdbId, title, connectionGeneration, identityGeneration FROM plex_cache WHERE id = ?",
					)
					.get("legacy-cache"),
			).toEqual({
				instanceId: "legacy-instance",
				tmdbId: 321,
				title: "Synthetic legacy title",
				connectionGeneration: null,
				identityGeneration: null,
			});
			for (const table of [
				"history_observations",
				"history_source_statuses",
				"history_collection_leases",
			]) {
				expect(
					upgraded
						.prepare(
							"SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?",
						)
						.get(table),
				).toEqual({ count: 1 });
			}
			expect(upgraded.prepare("SELECT COUNT(*) AS count FROM history_observations").get()).toEqual({
				count: 0,
			});
		} finally {
			upgraded.close();
		}
	});

	it("proves the immutable pre-History schema identity before compatibility checks", () => {
		const oldSchemaPath = materializePreHistorySchema();
		const immutable = normalizeSchemaText(readFileSync(oldSchemaPath, "utf8"));
		expect(immutable).not.toContain("HistoryObservation");
		expect(immutable).not.toContain("HistorySourceStatus");
		expect(immutable).not.toContain("HistoryCollectionLease");
	});

	it("records the populated History outcome when pushing the immutable old schema", {
		timeout: 30_000,
	}, () => {
		const databasePath = emptyDatabasePath("history-old-schema-populated-");
		const oldSchemaPath = materializePreHistorySchema();
		syncSchema(oldSchemaPath, databasePath);
		const legacy = new Database(databasePath);
		try {
			insertUser(legacy, "old-owner", "old-owner");
			insertInstance(legacy, "old-instance", "old-owner", 9);
			insertLegacyPlexCache(legacy, "old-instance");
		} finally {
			legacy.close();
		}
		syncSchema(schemaPath, databasePath);
		const upgraded = new Database(databasePath);
		let beforeReverse: ReturnType<typeof captureHistoryCompatibilityState>;
		try {
			insertObservation(upgraded, "old-observation", "old-instance", 9, 41);
			upgraded
				.prepare(
					"INSERT INTO history_source_statuses (instanceId, connectionGeneration) VALUES (?, ?)",
				)
				.run("old-instance", 9);
			upgraded
				.prepare("INSERT INTO history_collection_leases (userId, updatedAt) VALUES (?, ?)")
				.run("old-owner", "2026-09-03T00:00:00.000Z");
			beforeReverse = captureHistoryCompatibilityState(upgraded);
		} finally {
			upgraded.close();
		}

		const outcome = trySyncSchema(oldSchemaPath, databasePath);
		expect(outcome).toBe("destructive-refusal");
		const reopened = new Database(databasePath, { readonly: true });
		try {
			expect(
				reopened.prepare("SELECT COUNT(*) AS count FROM User WHERE id = ?").get("old-owner"),
			).toEqual({
				count: 1,
			});
			expect(captureHistoryCompatibilityState(reopened)).toEqual(beforeReverse);
			expect(
				reopened
					.prepare("SELECT COUNT(*) AS count FROM history_observations WHERE id = ?")
					.get("old-observation"),
			).toEqual({ count: 1 });
			expect(
				reopened.prepare("SELECT COUNT(*) AS count FROM history_source_statuses").get(),
			).toEqual({
				count: 1,
			});
			expect(
				reopened.prepare("SELECT COUNT(*) AS count FROM history_collection_leases").get(),
			).toEqual({
				count: 1,
			});
		} finally {
			reopened.close();
		}
	});

	it("establishes the exact empty-History outcome without a data-loss flag", {
		timeout: 30_000,
	}, () => {
		const databasePath = emptyDatabasePath("history-old-schema-empty-");
		const oldSchemaPath = materializePreHistorySchema();
		const historyOnlyUpgradeSchemaPath = materializeHistoryOnlyUpgradeSchema();
		syncSchema(oldSchemaPath, databasePath);
		const legacy = new Database(databasePath);
		try {
			insertUser(legacy, "empty-owner", "empty-owner");
			insertInstance(legacy, "empty-instance", "empty-owner", 3);
			insertLegacyPlexCache(legacy, "empty-instance");
		} finally {
			legacy.close();
		}
		syncSchema(historyOnlyUpgradeSchemaPath, databasePath);
		const beforeReverse = new Database(databasePath, { readonly: true });
		const legacyBeforeReverse = captureLegacyCompatibilityState(beforeReverse);
		beforeReverse.close();
		const outcome = trySyncSchema(oldSchemaPath, databasePath);
		const reopened = new Database(databasePath, { readonly: true });
		try {
			expect(outcome).toBe("succeeded");
			expect(
				reopened.prepare("SELECT COUNT(*) AS count FROM User WHERE id = ?").get("empty-owner"),
			).toEqual({
				count: 1,
			});
			const historyTables = reopened
				.prepare(
					"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'history_%' ORDER BY name",
				)
				.all() as Array<{ name: string }>;
			expect(historyTables).toEqual([]);
			expect(captureLegacyCompatibilityState(reopened)).toEqual(legacyBeforeReverse);
		} finally {
			reopened.close();
		}
	});

	it("adds scheduling defaults while preserving a populated pre-05C8 status", {
		timeout: 30_000,
	}, () => {
		const databasePath = emptyDatabasePath("history-schedule-upgrade-");
		const oldSchemaPath = join(dirname(databasePath), "old-schema.prisma");
		writeFileSync(oldSchemaPath, removeSchedulingSchemaFields(readFileSync(schemaPath, "utf8")));
		syncSchema(oldSchemaPath, databasePath);
		const oldDatabase = new Database(databasePath);
		try {
			insertUser(oldDatabase, "schedule-owner", "schedule-owner");
			insertInstance(oldDatabase, "schedule-instance", "schedule-owner", 11);
			oldDatabase
				.prepare(
					`INSERT INTO history_source_statuses
					 (instanceId, connectionGeneration, publishedAt, publicationMetadata,
					  retainedObservationCount, lastAttemptAt, lastAttemptResult,
					  lastAttemptReason, retentionEpoch)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"schedule-instance",
					11,
					"2026-09-03T01:00:00.000Z",
					'{"synthetic":true}',
					4,
					"2026-09-03T02:00:00.000Z",
					"error",
					"provider-unavailable",
					3,
				);
		} finally {
			oldDatabase.close();
		}
		syncSchema(schemaPath, databasePath);
		const upgraded = new Database(databasePath, { readonly: true });
		try {
			expect(
				upgraded
					.prepare(
						`SELECT instanceId, connectionGeneration, publishedAt, publicationMetadata,
						 retainedObservationCount, lastAttemptAt, lastAttemptResult,
						 lastAttemptReason, retentionEpoch, collectHeadNext,
						 nextBackfillPage, activeCollectionPage
						 FROM history_source_statuses WHERE instanceId = ?`,
					)
					.get("schedule-instance"),
			).toEqual({
				instanceId: "schedule-instance",
				connectionGeneration: 11,
				publishedAt: "2026-09-03T01:00:00.000Z",
				publicationMetadata: '{"synthetic":true}',
				retainedObservationCount: 4,
				lastAttemptAt: "2026-09-03T02:00:00.000Z",
				lastAttemptResult: "error",
				lastAttemptReason: "provider-unavailable",
				retentionEpoch: 3,
				collectHeadNext: 1,
				nextBackfillPage: 2,
				activeCollectionPage: null,
			});
		} finally {
			upgraded.close();
		}
	});

	it("adds publication revision default while preserving a populated pre-05D3 status after restart", {
		timeout: 30_000,
	}, () => {
		const databasePath = emptyDatabasePath("history-publication-revision-upgrade-");
		const oldSchemaPath = join(dirname(databasePath), "old-schema.prisma");
		writeFileSync(
			oldSchemaPath,
			removePublicationRevisionSchemaField(readFileSync(schemaPath, "utf8")),
		);
		syncSchema(oldSchemaPath, databasePath);
		const oldDatabase = new Database(databasePath);
		try {
			insertUser(oldDatabase, "revision-owner", "revision-owner");
			insertInstance(oldDatabase, "revision-instance", "revision-owner", 11);
			oldDatabase
				.prepare(
					`INSERT INTO history_source_statuses
					 (instanceId, connectionGeneration, publishedAt, publicationMetadata,
					  retainedObservationCount, lastAttemptAt, lastAttemptResult,
					  lastAttemptReason, retentionEpoch)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					"revision-instance",
					11,
					"2026-09-03T01:00:00.000Z",
					'{"synthetic":true}',
					4,
					"2026-09-03T02:00:00.000Z",
					"error",
					"provider-unavailable",
					3,
				);
		} finally {
			oldDatabase.close();
		}
		syncSchema(schemaPath, databasePath);
		const upgraded = new Database(databasePath, { readonly: true });
		try {
			expect(
				upgraded
					.prepare(
						`SELECT instanceId, connectionGeneration, publishedAt, publicationMetadata,
						 retainedObservationCount, lastAttemptAt, lastAttemptResult,
						 lastAttemptReason, publicationRevision, retentionEpoch,
						 collectHeadNext, nextBackfillPage, activeCollectionPage
						 FROM history_source_statuses WHERE instanceId = ?`,
					)
					.get("revision-instance"),
			).toEqual({
				instanceId: "revision-instance",
				connectionGeneration: 11,
				publishedAt: "2026-09-03T01:00:00.000Z",
				publicationMetadata: '{"synthetic":true}',
				retainedObservationCount: 4,
				lastAttemptAt: "2026-09-03T02:00:00.000Z",
				lastAttemptResult: "error",
				lastAttemptReason: "provider-unavailable",
				publicationRevision: 0,
				retentionEpoch: 3,
				collectHeadNext: 1,
				nextBackfillPage: 2,
				activeCollectionPage: null,
			});
		} finally {
			upgraded.close();
		}
		const reopened = new Database(databasePath, { readonly: true });
		try {
			expect(
				reopened
					.prepare("SELECT publicationRevision FROM history_source_statuses WHERE instanceId = ?")
					.get("revision-instance"),
			).toEqual({ publicationRevision: 0 });
		} finally {
			reopened.close();
		}
	});

	it("exposes the required physical foreign keys and indexes", { timeout: 30_000 }, () => {
		const { database } = freshDatabase("history-physical-");
		try {
			const observationForeignKeys = foreignKeys(database, "history_observations");
			expect(observationForeignKeys).toEqual([
				{
					table: "ServiceInstance",
					from: "instanceId",
					to: "id",
					on_update: "RESTRICT",
					on_delete: "CASCADE",
				},
			]);
			expect(foreignKeys(database, "history_source_statuses")).toEqual([
				{
					table: "ServiceInstance",
					from: "instanceId",
					to: "id",
					on_update: "RESTRICT",
					on_delete: "CASCADE",
				},
			]);
			expect(foreignKeys(database, "history_collection_leases")).toEqual([
				{ table: "User", from: "userId", to: "id", on_update: "CASCADE", on_delete: "CASCADE" },
			]);

			expect(indexColumns(database, "history_observations")).toEqual(
				expect.arrayContaining([
					["instanceId", "connectionGeneration", "providerEventId"],
					["eventAt", "id"],
					["instanceId", "connectionGeneration", "eventAt", "id"],
					["instanceId", "connectionGeneration", "firstObservedAt", "id"],
				]),
			);
			expect(indexColumns(database, "history_source_statuses")).toEqual(
				expect.arrayContaining([["instanceId"]]),
			);
			expect(indexColumns(database, "history_collection_leases")).toEqual(
				expect.arrayContaining([["userId"], ["claimToken"]]),
			);
		} finally {
			database.close();
		}
	});

	it("removes exactly the History additions from CRLF schema text", () => {
		const schema = readFileSync(schemaPath, "utf8");
		const crlfSchema = schema.replace(/\r?\n/g, "\r\n");
		expect(crlfSchema).toContain("\r\n");
		const removed = removeHistorySchema(crlfSchema);
		expect(removed).not.toContain("HistoryObservation");
		expect(removed).not.toContain("HistorySourceStatus");
		expect(removed).not.toContain("HistoryCollectionLease");
	});
});

function normalizeSchemaText(schema: string): string {
	return schema.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function modelBlock(schema: string, model: string): string {
	const matches = schema.match(new RegExp(`^model ${model} \\{[\\s\\S]*?^\\}`, "gm")) ?? [];
	if (matches.length !== 1) {
		throw new Error(`History schema model ${model} must occur exactly once`);
	}
	return matches[0];
}

function countTrimmedLines(schema: string, expected: string): number {
	return normalizeSchemaText(schema)
		.split("\n")
		.filter((line) => line.trim().replace(/\s+/g, " ") === expected.replace(/\s+/g, " ")).length;
}

function expectSchemaLine(block: string, expected: string): void {
	const normalizedExpected = expected.trim().replace(/\s+/g, " ");
	expect(block.split("\n").map((line) => line.trim().replace(/\s+/g, " "))).toContain(
		normalizedExpected,
	);
}

function removeHistorySchema(schema: string): string {
	let normalized = normalizeSchemaText(schema);
	for (const [model, fragments] of [
		["User", historyUserRelations],
		["ServiceInstance", historyInstanceRelations],
	] as const) {
		for (const fragment of fragments) {
			const block = modelBlock(normalized, model);
			const lines = block.split("\n");
			const matching = lines.filter(
				(line) => line.trim().replace(/\s+/g, " ") === fragment.replace(/\s+/g, " "),
			);
			if (matching.length !== 1) {
				throw new Error("History schema additions do not match the expected removable fragments");
			}
			const removedBlock = lines
				.filter((line) => line.trim().replace(/\s+/g, " ") !== fragment.replace(/\s+/g, " "))
				.join("\n");
			normalized = normalized.replace(block, removedBlock);
		}
	}
	for (const model of historyModels) {
		const block = modelBlock(normalized, model);
		normalized = normalized.replace(block, "");
	}
	return normalized;
}

function removeLabelSyncMutationAttemptSchema(schema: string): string {
	let normalized = normalizeSchemaText(schema);
	for (const [model, fragment] of labelSyncMutationAttemptRelations) {
		const block = modelBlock(normalized, model);
		const lines = block.split("\n");
		const matching = lines.filter(
			(line) => line.trim().replace(/\s+/g, " ") === fragment.replace(/\s+/g, " "),
		);
		if (matching.length !== 1) {
			throw new Error(
				"Label-sync mutation schema additions do not match the expected removable fragments",
			);
		}
		const removedBlock = lines
			.filter((line) => line.trim().replace(/\s+/g, " ") !== fragment.replace(/\s+/g, " "))
			.join("\n");
		normalized = normalized.replace(block, removedBlock);
	}
	return normalized.replace(modelBlock(normalized, "LabelSyncMutationAttempt"), "");
}

function removeProviderObservationSchema(schema: string): string {
	let normalized = normalizeSchemaText(schema);
	for (const [model, fragment] of providerObservationRelations) {
		const block = modelBlock(normalized, model);
		const lines = block.split("\n");
		const matching = lines.filter(
			(line) => line.trim().replace(/\s+/g, " ") === fragment.replace(/\s+/g, " "),
		);
		if (matching.length !== 1) {
			throw new Error(
				"Provider-observation schema additions do not match the expected removable fragments",
			);
		}
		const removedBlock = lines
			.filter((line) => line.trim().replace(/\s+/g, " ") !== fragment.replace(/\s+/g, " "))
			.join("\n");
		normalized = normalized.replace(block, removedBlock);
	}
	for (const model of providerObservationModels) {
		normalized = normalized.replace(modelBlock(normalized, model), "");
	}
	return normalized;
}

function removeSchedulingSchemaFields(schema: string): string {
	return normalizeSchemaText(schema)
		.split("\n")
		.filter(
			(line) =>
				!line.includes("collectHeadNext") &&
				!line.includes("nextBackfillPage") &&
				!line.includes("activeCollectionPage"),
		)
		.join("\n");
}

function removePublicationRevisionSchemaField(schema: string): string {
	return normalizeSchemaText(schema)
		.split("\n")
		.filter((line) => !line.includes("publicationRevision"))
		.join("\n");
}

function freshDatabase(prefix: string): { database: Database.Database; databasePath: string } {
	const databasePath = emptyDatabasePath(prefix);
	syncSchema(schemaPath, databasePath);
	const database = new Database(databasePath);
	database.pragma("foreign_keys = ON");
	return { database, databasePath };
}

function emptyDatabasePath(prefix: string): string {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return join(directory, "schema.db");
}

function materializePreHistorySchema(): string {
	const directory =
		temporaryDirectories.at(-1) ?? mkdtempSync(join(tmpdir(), "history-schema-ledger-"));
	if (!temporaryDirectories.includes(directory)) temporaryDirectories.push(directory);
	const oldSchemaPath = join(directory, "pre-history-schema.prisma");
	const schema = readFileSync(preHistorySchemaPath, "utf8");
	writeFileSync(oldSchemaPath, schema, { mode: 0o600 });
	return resolve(oldSchemaPath);
}

function materializeHistoryOnlyUpgradeSchema(): string {
	const directory =
		temporaryDirectories.at(-1) ?? mkdtempSync(join(tmpdir(), "history-schema-isolation-"));
	if (!temporaryDirectories.includes(directory)) temporaryDirectories.push(directory);
	const isolatedSchemaPath = join(directory, "history-only-upgrade-schema.prisma");
	const withoutMutationAttempt = removeLabelSyncMutationAttemptSchema(
		readFileSync(schemaPath, "utf8"),
	);
	writeFileSync(isolatedSchemaPath, removeProviderObservationSchema(withoutMutationAttempt), {
		mode: 0o600,
	});
	return resolve(isolatedSchemaPath);
}

function syncSchema(schema: string, databasePath: string): void {
	const canonicalDatabasePath = resolve(databasePath);
	expect(
		temporaryDirectories.some((directory) => canonicalDatabasePath.startsWith(resolve(directory))),
	).toBe(true);
	try {
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], {
			cwd: apiRoot,
			env: { ...process.env, DATABASE_URL: `file:${canonicalDatabasePath}` },
			stdio: "pipe",
		});
	} catch (error) {
		const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "unknown";
		throw new Error(`Prisma schema push failed: ${stderr}`);
	}
}

function trySyncSchema(schema: string, databasePath: string): "succeeded" | "destructive-refusal" {
	const canonicalDatabasePath = resolve(databasePath);
	expect(
		temporaryDirectories.some((directory) => canonicalDatabasePath.startsWith(resolve(directory))),
	).toBe(true);
	try {
		execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", schema], {
			cwd: apiRoot,
			env: { ...process.env, DATABASE_URL: `file:${canonicalDatabasePath}` },
			stdio: "pipe",
		});
		return "succeeded";
	} catch (error) {
		const failure = error as { status?: unknown; stdout?: unknown; stderr?: unknown };
		const exitCode = typeof failure.status === "number" ? failure.status : null;
		const diagnostic = `${String(failure.stdout ?? "")}\n${String(failure.stderr ?? "")}`;
		if (classifySchemaPushFailure(exitCode, diagnostic) === "destructive-refusal") {
			return "destructive-refusal";
		}
		throw new Error("Schema push failed for an unexpected reason");
	}
}

function classifySchemaPushFailure(
	exitCode: number | null,
	diagnostic: string,
): "destructive-refusal" | "unexpected" {
	if (
		exitCode === 1 &&
		/accept-data-loss/i.test(diagnostic) &&
		/history_observations/.test(diagnostic) &&
		/history_source_statuses/.test(diagnostic) &&
		/history_collection_leases/.test(diagnostic)
	) {
		return "destructive-refusal";
	}
	return "unexpected";
}

function captureLegacyCompatibilityState(database: Database.Database) {
	const tables = database
		.prepare(
			"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT LIKE 'history_%' ORDER BY type, name",
		)
		.all();
	const tableNames = (tables as Array<{ type: string; name: string }>)
		.filter(({ type }) => type === "table")
		.map(({ name }) => name);
	return {
		user:
			database.prepare("SELECT * FROM User WHERE id = ?").get("old-owner") ??
			database.prepare("SELECT * FROM User WHERE id = ?").get("empty-owner"),
		serviceInstance:
			database.prepare("SELECT * FROM ServiceInstance WHERE id = ?").get("old-instance") ??
			database.prepare("SELECT * FROM ServiceInstance WHERE id = ?").get("empty-instance"),
		cache: database.prepare("SELECT * FROM plex_cache WHERE id = ?").get("legacy-cache"),
		tables,
		foreignKeys: Object.fromEntries(
			tableNames.map((table) => [table, foreignKeys(database, table)]),
		),
		indexes: Object.fromEntries(tableNames.map((table) => [table, indexColumns(database, table)])),
	};
}

function captureHistoryCompatibilityState(database: Database.Database) {
	return {
		legacy: captureLegacyCompatibilityState(database),
		observations: database.prepare("SELECT * FROM history_observations ORDER BY id").all(),
		statuses: database.prepare("SELECT * FROM history_source_statuses ORDER BY instanceId").all(),
		leases: database.prepare("SELECT * FROM history_collection_leases ORDER BY userId").all(),
		historyTables: database
			.prepare(
				"SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name LIKE 'history_%' ORDER BY type, name",
			)
			.all(),
		historyForeignKeys: {
			observations: foreignKeys(database, "history_observations"),
			statuses: foreignKeys(database, "history_source_statuses"),
			leases: foreignKeys(database, "history_collection_leases"),
		},
		historyIndexes: {
			observations: indexColumns(database, "history_observations"),
			statuses: indexColumns(database, "history_source_statuses"),
			leases: indexColumns(database, "history_collection_leases"),
		},
	};
}

function insertUser(database: Database.Database, id: string, username: string): void {
	database
		.prepare("INSERT INTO User (id, username, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
		.run(id, username, "2026-09-03T00:00:00.000Z", "2026-09-03T00:00:00.000Z");
}

function insertInstance(
	database: Database.Database,
	id: string,
	userId: string,
	connectionGeneration: number,
): void {
	database
		.prepare(`INSERT INTO ServiceInstance (
		id, userId, service, label, baseUrl, encryptedApiKey, encryptionIv,
		encryptedHttpAuthCredentials, httpAuthEncryptionIv, isDefault, enabled,
		hasLocalFilesystemAccess, connectionGeneration, createdAt, updatedAt
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			id,
			userId,
			"PLEX",
			"Synthetic instance",
			"https://synthetic.example.invalid",
			"synthetic-api-ciphertext",
			"synthetic-api-iv",
			"synthetic-http-ciphertext",
			"synthetic-http-iv",
			0,
			1,
			0,
			connectionGeneration,
			"2026-09-03T00:00:00.000Z",
			"2026-09-03T00:00:00.000Z",
		);
}

function insertObservation(
	database: Database.Database,
	id: string,
	instanceId: string,
	generation: number,
	providerEventId: number,
): void {
	database
		.prepare(`INSERT INTO history_observations (
		id, instanceId, connectionGeneration, providerEventId, eventAt,
		eventTypeKey, searchText, normalizedPayload, firstObservedAt, lastObservedAt
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			id,
			instanceId,
			generation,
			providerEventId,
			"2026-09-03T00:00:00.000Z",
			"download",
			"synthetic search",
			'{"kind":"synthetic"}',
			"2026-09-03T00:00:00.000Z",
			"2026-09-03T00:01:00.000Z",
		);
}

function insertLegacyPlexCache(database: Database.Database, instanceId = "legacy-instance"): void {
	database
		.prepare(`INSERT INTO plex_cache (
		id, instanceId, tmdbId, mediaType, sectionId, sectionTitle, title,
		watchedByUsers, collections, labels
	) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		.run(
			"legacy-cache",
			instanceId,
			321,
			"movie",
			"synthetic-section",
			"Synthetic section",
			"Synthetic legacy title",
			"[]",
			"[]",
			"[]",
		);
}

function foreignKeys(database: Database.Database, table: string): Array<Record<string, string>> {
	return (
		database.prepare(`PRAGMA foreign_key_list('${table}')`).all() as Array<
			Record<string, string | number>
		>
	).map((key) => ({
		table: String(key.table),
		from: String(key.from),
		to: String(key.to),
		on_update: String(key.on_update),
		on_delete: String(key.on_delete),
	}));
}

function indexColumns(database: Database.Database, table: string): string[][] {
	const indexes = database.prepare(`PRAGMA index_list('${table}')`).all() as Array<{
		name: string;
	}>;
	return indexes.map(({ name }) =>
		(
			database.prepare(`PRAGMA index_info('${name}')`).all() as Array<{
				name: string;
				seqno: number;
			}>
		)
			.sort((left, right) => left.seqno - right.seqno)
			.map((column) => column.name),
	);
}
