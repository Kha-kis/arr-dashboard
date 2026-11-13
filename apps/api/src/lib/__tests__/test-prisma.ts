/**
 * Test Prisma Client Helper
 *
 * Provides a properly configured PrismaClient for tests.
 * In Prisma 7, a driver adapter is required.
 *
 * SQLite is the default. PostgreSQL uses an explicit isolated test URL and
 * a privately generated native client; this helper never initializes a schema.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../../generated/prisma/client.js";

const execFileAsync = promisify(execFile);

function requirePostgresTestUrl(value: string): URL {
	const message =
		"PostgreSQL test clients require a plain loopback URL and a database ending in _test";
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(message);
	}
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
		!/^\/[A-Za-z_][A-Za-z0-9_]*_test$/.test(url.pathname) ||
		url.searchParams.size > 0 ||
		url.hash !== ""
	)
		throw new Error(message);
	return url;
}

/**
 * Create a PrismaClient configured for testing.
 * Uses an in-memory SQLite database by default, or the test database URL if provided.
 * PostgreSQL callers must use createTestPgClient explicitly.
 *
 * @param databaseUrl - Optional database URL (defaults to in-memory SQLite)
 * @returns Configured PrismaClient instance
 */
export function createTestPrismaClient(
	databaseUrl = ":memory:",
): InstanceType<typeof PrismaClient> {
	const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
	return new PrismaClient({ adapter });
}

/**
 * Create a PrismaClient configured for PostgreSQL testing.
 * Requires a plain loopback URL whose database name ends in _test. Query
 * parameters cannot override the effective driver target or schema. The caller
 * owns database/schema initialization; peers using the same URL share rows.
 *
 * @param connectionString - PostgreSQL connection string
 * @returns Object with prisma client and cleanup function to end the pool
 */
export async function createTestPgClient(connectionString: string): Promise<{
	prisma: InstanceType<typeof PrismaClient>;
	cleanup: () => Promise<void>;
}> {
	const url = requirePostgresTestUrl(connectionString);
	const directory = await mkdtemp(join(tmpdir(), "native-pg-test-client-"));
	let pool: import("pg").Pool | undefined;
	let prisma: InstanceType<typeof PrismaClient> | undefined;
	const cleanupResources = async () => {
		try {
			await prisma?.$disconnect();
		} finally {
			try {
				await pool?.end();
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	};

	try {
		const apiDir = resolve(import.meta.dirname, "../../..");
		const source = await readFile(join(apiDir, "prisma/schema.prisma"), "utf8");
		const generator = /generator client \{[\s\S]*?\}\n\n/;
		const datasource = /datasource db \{\s*provider = "sqlite"\s*\}/;
		if (!generator.test(source) || !datasource.test(source))
			throw new Error("Unsupported schema layout for private PostgreSQL client generation");
		const schema = source
			.replace(
				generator,
				'generator client {\n  provider = "prisma-client"\n  output = "./generated"\n}\n\n',
			)
			.replace(datasource, 'datasource db {\n  provider = "postgresql"\n}');
		const schemaFile = join(directory, "schema.prisma");
		await writeFile(schemaFile, schema, { mode: 0o600 });
		await execFileAsync("pnpm", ["exec", "prisma", "generate", "--schema", schemaFile], {
			cwd: apiDir,
			env: { ...process.env, DATABASE_URL: url.toString() },
			timeout: 60_000,
		});
		const generated = await import(
			/* @vite-ignore */ pathToFileURL(join(directory, "generated/client.ts")).href
		);
		const { PrismaClient: NativePgClient } = (generated.default ?? generated) as {
			PrismaClient: new (options: { adapter: unknown }) => InstanceType<typeof PrismaClient>;
		};
		const { PrismaPg } = await import("@prisma/adapter-pg");
		const pg = await import("pg");
		pool = new pg.default.Pool({ connectionString: url.toString() });
		prisma = new NativePgClient({ adapter: new PrismaPg(pool) });
		let cleanupPromise: Promise<void> | undefined;
		return {
			prisma,
			cleanup: () => (cleanupPromise ??= cleanupResources()),
		};
	} catch (error) {
		await cleanupResources();
		throw error;
	}
}
