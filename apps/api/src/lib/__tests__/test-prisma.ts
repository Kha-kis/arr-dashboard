/**
 * Test Prisma Client Helper
 *
 * Provides a properly configured PrismaClient for tests.
 * In Prisma 7, a driver adapter is required.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../generated/prisma/client.js";

/**
 * Create a PrismaClient configured for testing.
 * Uses an in-memory SQLite database by default, or the test database URL if provided.
 *
 * @param databaseUrl - Optional database URL (defaults to in-memory)
 * @returns Configured PrismaClient instance
 */
export function createTestPrismaClient(databaseUrl = ":memory:"): InstanceType<typeof PrismaClient> {
	const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
	return new PrismaClient({ adapter });
}
