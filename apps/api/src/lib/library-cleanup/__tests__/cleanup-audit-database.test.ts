import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../../generated/prisma/client.js";
import {
	approvalRecordToAuditSnapshot,
	recordApprovalRecoveryTransition,
} from "../cleanup-audit.js";

type TestDatabase = {
	clients: [PrismaClient, PrismaClient];
	cleanup: () => Promise<void>;
};

const sqliteDdl = [
	`CREATE TABLE "library_cleanup_configs" ("id" TEXT PRIMARY KEY NOT NULL)`,
	`CREATE TABLE "library_cleanup_audit_events" (
		"id" INTEGER PRIMARY KEY AUTOINCREMENT,
		"configId" TEXT NOT NULL,
		"actionId" TEXT NOT NULL,
		"correlationId" TEXT NOT NULL,
		"eventKey" TEXT NOT NULL UNIQUE,
		"sequence" INTEGER NOT NULL,
		"eventType" TEXT NOT NULL,
		"outcome" TEXT NOT NULL,
		"trigger" TEXT NOT NULL,
		"actorType" TEXT NOT NULL,
		"actorId" TEXT,
		"approvalId" TEXT,
		"runLogId" TEXT,
		"instanceId" TEXT NOT NULL,
		"arrItemId" INTEGER NOT NULL,
		"itemType" TEXT NOT NULL,
		"targetScope" TEXT NOT NULL,
		"arrEpisodeId" INTEGER,
		"title" TEXT NOT NULL,
		"ruleId" TEXT,
		"ruleName" TEXT,
		"action" TEXT NOT NULL,
		"reason" TEXT NOT NULL,
		"evidence" TEXT,
		"details" TEXT,
		"createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`,
];

const postgresDdl = [
	`CREATE TABLE "library_cleanup_configs" ("id" TEXT PRIMARY KEY NOT NULL)`,
	`CREATE TABLE "library_cleanup_audit_events" (
		"id" SERIAL PRIMARY KEY,
		"configId" TEXT NOT NULL,
		"actionId" TEXT NOT NULL,
		"correlationId" TEXT NOT NULL,
		"eventKey" TEXT NOT NULL UNIQUE,
		"sequence" INTEGER NOT NULL,
		"eventType" TEXT NOT NULL,
		"outcome" TEXT NOT NULL,
		"trigger" TEXT NOT NULL,
		"actorType" TEXT NOT NULL,
		"actorId" TEXT,
		"approvalId" TEXT,
		"runLogId" TEXT,
		"instanceId" TEXT NOT NULL,
		"arrItemId" INTEGER NOT NULL,
		"itemType" TEXT NOT NULL,
		"targetScope" TEXT NOT NULL,
		"arrEpisodeId" INTEGER,
		"title" TEXT NOT NULL,
		"ruleId" TEXT,
		"ruleName" TEXT,
		"action" TEXT NOT NULL,
		"reason" TEXT NOT NULL,
		"evidence" TEXT,
		"details" TEXT,
		"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`,
];

async function createSqliteDatabase(): Promise<TestDatabase> {
	const directory = await mkdtemp(join(tmpdir(), "cleanup-audit-sqlite-"));
	const databasePath = join(directory, "audit.db");
	const clients = [
		new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 25 }) }),
		new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 25 }) }),
	] as [PrismaClient, PrismaClient];
	await clients[0].$connect();
	for (const statement of sqliteDdl) await clients[0].$executeRawUnsafe(statement);
	await clients[0].$executeRawUnsafe(
		`INSERT INTO "library_cleanup_configs" ("id") VALUES ('config-1')`,
	);
	await clients[1].$connect();
	return {
		clients,
		cleanup: async () => {
			await Promise.all(clients.map((client) => client.$disconnect()));
			await rm(directory, { recursive: true, force: true });
		},
	};
}

async function createPostgresDatabase(url: string): Promise<TestDatabase> {
	const databaseName = new URL(url).pathname.replace(/^\//, "");
	if (!databaseName.includes("cleanup_audit_test")) {
		throw new Error(
			"CLEANUP_AUDIT_POSTGRES_URL must target a disposable cleanup_audit_test database",
		);
	}
	const pools = [new pg.Pool({ connectionString: url }), new pg.Pool({ connectionString: url })];
	const clients = pools.map(
		(pool) => new PrismaClient({ adapter: new PrismaPg(pool as never) }),
	) as [PrismaClient, PrismaClient];
	await clients[0].$connect();
	await clients[0].$executeRawUnsafe(`DROP TABLE IF EXISTS "library_cleanup_audit_events"`);
	await clients[0].$executeRawUnsafe(`DROP TABLE IF EXISTS "library_cleanup_configs"`);
	for (const statement of postgresDdl) await clients[0].$executeRawUnsafe(statement);
	await clients[0].$executeRawUnsafe(
		`INSERT INTO "library_cleanup_configs" ("id") VALUES ('config-1')`,
	);
	await clients[1].$connect();
	return {
		clients,
		cleanup: async () => {
			await Promise.all(clients.map((client) => client.$disconnect()));
			await Promise.all(pools.map((pool) => pool.end()));
		},
	};
}

function seedRows() {
	const rows = [];
	for (let id = 1; id <= 10_001; id++) {
		rows.push({
			configId: "config-1",
			actionId: id <= 2 ? "old" : "boundary",
			correlationId: `seed:${id}`,
			eventKey: `seed:${id}`,
			sequence: id,
			eventType: "seed",
			outcome: "info",
			trigger: "scheduled",
			actorType: "scheduler",
			actorId: null,
			approvalId: null,
			runLogId: null,
			instanceId: "radarr-1",
			arrItemId: 1,
			itemType: "movie",
			targetScope: "series",
			arrEpisodeId: null,
			title: "Seed",
			ruleId: null,
			ruleName: null,
			action: "delete",
			reason: "seed",
			evidence: null,
			details: null,
		});
	}
	return rows;
}

async function runConcurrentRetention(database: TestDatabase): Promise<void> {
	for (let offset = 0; offset < 10_001; offset += 250) {
		await database.clients[0].libraryCleanupAuditEvent.createMany({
			data: seedRows().slice(offset, offset + 250),
		});
	}
	const base = {
		configId: "config-1",
		instanceId: "radarr-1",
		arrItemId: 1,
		itemType: "movie",
		targetScope: "series",
		title: "Concurrent",
		matchedRuleId: "rule-1",
		matchedRuleName: "Old",
		action: "delete",
		reason: "Recovered",
		status: "pending",
	};
	const log = { warn: () => undefined };
	await Promise.all([
		recordApprovalRecoveryTransition(
			database.clients[0],
			{
				approval: approvalRecordToAuditSnapshot({ ...base, id: "old" }),
				correlationId: "concurrent-old",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Recovered",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			log as never,
		),
		recordApprovalRecoveryTransition(
			database.clients[1],
			{
				approval: approvalRecordToAuditSnapshot({ ...base, id: "new" }),
				correlationId: "concurrent-new",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Recovered",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			log as never,
		),
	]);
	const [oldAppend, newAppend, oldTimeline] = await Promise.all([
		database.clients[0].libraryCleanupAuditEvent.count({
			where: { eventKey: { contains: "concurrent-old" } },
		}),
		database.clients[0].libraryCleanupAuditEvent.count({
			where: { eventKey: { contains: "concurrent-new" } },
		}),
		database.clients[0].libraryCleanupAuditEvent.count({ where: { actionId: "old" } }),
	]);
	expect(oldAppend).toBe(1);
	expect(newAppend).toBe(1);
	expect(oldTimeline).toBeGreaterThanOrEqual(3);
}

describe("library cleanup audit database retention", () => {
	let active: TestDatabase | undefined;
	afterEach(async () => {
		await active?.cleanup();
		active = undefined;
	});

	it("does not sweep a concurrent SQLite append", async () => {
		active = await createSqliteDatabase();
		await runConcurrentRetention(active);
	}, 30_000);

	it("serializes a reverse-order SQLite writer before the config-first audit append", async () => {
		active = await createSqliteDatabase();
		const base = approvalRecordToAuditSnapshot({
			id: "reverse-order",
			configId: "config-1",
			instanceId: "radarr-1",
			arrItemId: 1,
			itemType: "movie",
			targetScope: "series",
			title: "Reverse",
			action: "delete",
			reason: "Recovered",
			status: "pending",
		});
		await recordApprovalRecoveryTransition(
			active.clients[0],
			{
				approval: base,
				correlationId: "reverse-seed",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Seed",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			{ warn: () => undefined } as never,
		);

		let releaseReverse!: () => void;
		const reverseGate = new Promise<void>((resolve) => {
			releaseReverse = resolve;
		});
		let reverseLocked!: () => void;
		const reverseLockAcquired = new Promise<void>((resolve) => {
			reverseLocked = resolve;
		});
		const reverseWriter = active.clients[0].$transaction(async (transaction) => {
			await transaction.libraryCleanupAuditEvent.update({
				where: { eventKey: "reverse-order:reverse-seed:recovery_transition" },
				data: { sequence: 1 },
			});
			reverseLocked();
			await reverseGate;
			await transaction.$executeRaw`
				UPDATE "library_cleanup_configs" SET "id" = "id" WHERE "id" = ${"config-1"}
			`;
		});
		await reverseLockAcquired;
		let appendSettled = false;
		const append = recordApprovalRecoveryTransition(
			active.clients[1],
			{
				approval: base,
				correlationId: "config-first-append",
				fromStatus: "approved",
				toStatus: "pending",
				reason: "Concurrent append",
				mutationOutcome: "not_started",
				trigger: "scheduled",
			},
			{ warn: () => undefined } as never,
		).finally(() => {
			appendSettled = true;
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 20));
		expect(appendSettled).toBe(false);
		releaseReverse();
		await Promise.all([reverseWriter, append]);
		expect(
			await active.clients[0].libraryCleanupAuditEvent.count({
				where: { eventKey: { contains: "config-first-append" } },
			}),
		).toBe(1);
	}, 30_000);

	it.runIf(Boolean(process.env.CLEANUP_AUDIT_POSTGRES_URL))(
		"does not sweep a concurrent PostgreSQL append",
		async () => {
			active = await createPostgresDatabase(process.env.CLEANUP_AUDIT_POSTGRES_URL!);
			await runConcurrentRetention(active);
		},
		30_000,
	);
});
