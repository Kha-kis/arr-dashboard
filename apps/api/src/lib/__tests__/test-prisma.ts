/**
 * Test Prisma Client Helper
 *
 * Provides a properly configured PrismaClient for tests.
 * In Prisma 7, a driver adapter is required.
 *
 * Supports both SQLite (default) and PostgreSQL (via DATABASE_URL or explicit URL).
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../generated/prisma/client.js";

function isPostgresUrl(url: string): boolean {
	return /^postgres(ql)?:\/\//i.test(url);
}

/**
 * Create a PrismaClient configured for testing.
 * Uses an in-memory SQLite database by default, or the test database URL if provided.
 * Automatically detects PostgreSQL URLs and uses the appropriate adapter.
 *
 * @param databaseUrl - Optional database URL (defaults to in-memory SQLite)
 * @returns Configured PrismaClient instance
 */
export function createTestPrismaClient(databaseUrl = ":memory:"): InstanceType<typeof PrismaClient> {
	const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
	return new PrismaClient({ adapter });
}

/**
 * Create a PrismaClient configured for PostgreSQL testing.
 * Requires @prisma/adapter-pg and pg packages.
 *
 * @param connectionString - PostgreSQL connection string
 * @returns Object with prisma client and cleanup function to end the pool
 */
export async function createTestPgClient(connectionString: string): Promise<{
	prisma: InstanceType<typeof PrismaClient>;
	cleanup: () => Promise<void>;
}> {
	if (!isPostgresUrl(connectionString)) {
		throw new Error("Expected a PostgreSQL connection string");
	}

	const { PrismaPg } = await import("@prisma/adapter-pg");
	const pg = await import("pg");

	const pool = new pg.default.Pool({ connectionString });
	const adapter = new PrismaPg(pool);
	const prisma = new PrismaClient({ adapter });

	return {
		prisma,
		cleanup: async () => {
			await prisma.$disconnect();
			await pool.end();
		},
	};
}
