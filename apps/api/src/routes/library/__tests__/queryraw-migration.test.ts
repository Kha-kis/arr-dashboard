/**
 * Integration test for the $queryRaw migration in fetch-routes.ts
 *
 * Verifies that the Prisma.sql tagged template with Prisma.join() and
 * nested Prisma.sql fragments produces correct SQL against real databases.
 *
 * - SQLite suite: TEST_DB=true (uses json_extract)
 * - PostgreSQL suite: TEST_PG_URL=postgresql://... (uses ->> JSON operator)
 *
 * Both suites test the exact query patterns from fetch-routes.ts.
 */

import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "../../../lib/prisma.js";
import type { PrismaClient } from "../../../lib/prisma.js";
import { createTestPrismaClient, createTestPgClient } from "../../../lib/__tests__/test-prisma.js";

const RUN_DB_TESTS = process.env.TEST_DB === "true";
const PG_URL = process.env.TEST_PG_URL;

// Use the pre-initialized test database with full schema
const TEST_DB_PATH = path.resolve(
	import.meta.dirname,
	"../../../../prisma/test-integration.db",
);

/** Shared test data setup */
async function seedTestData(prisma: PrismaClient) {
	const userId = "test-user-1";

	await prisma.user.create({
		data: { id: userId, username: "testuser" },
	});

	await prisma.serviceInstance.create({
		data: {
			id: "inst-sonarr-1",
			userId,
			service: "SONARR",
			label: "Sonarr 1",
			baseUrl: "http://localhost:8989",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		},
	});
	await prisma.serviceInstance.create({
		data: {
			id: "inst-radarr-1",
			userId,
			service: "RADARR",
			label: "Radarr 1",
			baseUrl: "http://localhost:7878",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
		},
	});

	await prisma.libraryCache.create({
		data: {
			instanceId: "inst-sonarr-1",
			arrItemId: 1,
			itemType: "series",
			title: "Breaking Bad",
			data: JSON.stringify({
				title: "Breaking Bad",
				remoteIds: { tmdbId: 1396, imdbId: "tt0903747" },
			}),
		},
	});

	await prisma.libraryCache.create({
		data: {
			instanceId: "inst-radarr-1",
			arrItemId: 100,
			itemType: "movie",
			title: "Inception",
			data: JSON.stringify({
				title: "Inception",
				remoteIds: { tmdbId: 27205, imdbId: "tt1375666" },
			}),
		},
	});

	await prisma.libraryCache.create({
		data: {
			instanceId: "inst-radarr-1",
			arrItemId: 200,
			itemType: "movie",
			title: "The Matrix",
			data: JSON.stringify({
				title: "The Matrix",
				remoteIds: { tmdbId: 603, imdbId: "tt0133093" },
			}),
		},
	});
}

async function cleanupTestData(prisma: PrismaClient) {
	await prisma.libraryCache.deleteMany({});
	await prisma.serviceInstance.deleteMany({});
	await prisma.user.deleteMany({});
}

/**
 * Shared test cases — parameterized by database provider.
 * The jsonExtractBuilder produces the provider-specific SQL fragment.
 */
function defineQueryRawTests(
	getClient: () => PrismaClient,
	jsonExtractBuilder: (tmdbId: number) => ReturnType<typeof Prisma.sql>,
) {
	it("finds item by tmdbId using Prisma.sql with nested fragments and Prisma.join", async () => {
		const instanceIds = ["inst-sonarr-1", "inst-radarr-1"];
		const tmdbId = 1396;

		const jsonExtract = jsonExtractBuilder(tmdbId);
		const rows = await getClient().$queryRaw<Array<{ data: string }>>(
			Prisma.sql`SELECT data FROM library_cache WHERE "instanceId" IN (${Prisma.join(instanceIds)}) AND ${jsonExtract} LIMIT 1`,
		);

		expect(rows).toHaveLength(1);
		const item = JSON.parse(rows[0]!.data);
		expect(item.title).toBe("Breaking Bad");
		expect(item.remoteIds.tmdbId).toBe(1396);
	});

	it("finds movie by tmdbId across multiple instances", async () => {
		const instanceIds = ["inst-sonarr-1", "inst-radarr-1"];
		const tmdbId = 27205;

		const jsonExtract = jsonExtractBuilder(tmdbId);
		const rows = await getClient().$queryRaw<Array<{ data: string }>>(
			Prisma.sql`SELECT data FROM library_cache WHERE "instanceId" IN (${Prisma.join(instanceIds)}) AND ${jsonExtract} LIMIT 1`,
		);

		expect(rows).toHaveLength(1);
		const item = JSON.parse(rows[0]!.data);
		expect(item.title).toBe("Inception");
	});

	it("returns empty array when tmdbId does not exist", async () => {
		const instanceIds = ["inst-sonarr-1", "inst-radarr-1"];
		const tmdbId = 999999;

		const jsonExtract = jsonExtractBuilder(tmdbId);
		const rows = await getClient().$queryRaw<Array<{ data: string }>>(
			Prisma.sql`SELECT data FROM library_cache WHERE "instanceId" IN (${Prisma.join(instanceIds)}) AND ${jsonExtract} LIMIT 1`,
		);

		expect(rows).toHaveLength(0);
	});

	it("scopes query to specified instance IDs only", async () => {
		const instanceIds = ["inst-sonarr-1"];
		const tmdbId = 27205;

		const jsonExtract = jsonExtractBuilder(tmdbId);
		const rows = await getClient().$queryRaw<Array<{ data: string }>>(
			Prisma.sql`SELECT data FROM library_cache WHERE "instanceId" IN (${Prisma.join(instanceIds)}) AND ${jsonExtract} LIMIT 1`,
		);

		expect(rows).toHaveLength(0);
	});
}

// ─── SQLite Suite ───────────────────────────────────────────────────────────

(RUN_DB_TESTS ? describe : describe.skip)(
	"$queryRaw migration: SQLite (json_extract)",
	() => {
		let prisma: PrismaClient;

		beforeEach(async () => {
			prisma = createTestPrismaClient(TEST_DB_PATH);
			await seedTestData(prisma);
		});

		afterEach(async () => {
			await cleanupTestData(prisma);
			await prisma.$disconnect();
		});

		defineQueryRawTests(
			() => prisma,
			(tmdbId) =>
				Prisma.sql`CAST(json_extract(data, '$.remoteIds.tmdbId') AS INTEGER) = ${tmdbId}`,
		);
	},
);

// ─── PostgreSQL Suite ───────────────────────────────────────────────────────

(PG_URL ? describe : describe.skip)(
	"$queryRaw migration: PostgreSQL (JSON ->> operator)",
	() => {
		let prisma: PrismaClient;
		let cleanup: () => Promise<void>;

		beforeEach(async () => {
			const pg = await createTestPgClient(PG_URL!);
			prisma = pg.prisma;
			cleanup = pg.cleanup;
			await seedTestData(prisma);
		});

		afterEach(async () => {
			await cleanupTestData(prisma);
			await cleanup();
		});

		defineQueryRawTests(
			() => prisma,
			(tmdbId) =>
				Prisma.sql`CAST("data"::json->'remoteIds'->>'tmdbId' AS INTEGER) = ${tmdbId}`,
		);
	},
);
