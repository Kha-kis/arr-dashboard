import { PrismaClient } from "../generated/prisma/client.js";
import fp from "fastify-plugin";

type DbProvider = "sqlite" | "postgresql";

/**
 * Detect database provider from the DATABASE_URL connection string.
 * PostgreSQL URLs start with postgres:// or postgresql://.
 * Everything else (including file: paths) is treated as SQLite.
 */
function detectDbProvider(url: string): DbProvider {
	return /^postgres(ql)?:\/\//i.test(url) ? "postgresql" : "sqlite";
}

/**
 * Parse SQLite URL to file path for better-sqlite3 adapter.
 * The adapter accepts the path directly (without 'file:' prefix).
 * Supports formats:
 * - file:./dev.db -> ./dev.db
 * - file:/app/data/prod.db -> /app/data/prod.db
 * - ./dev.db -> ./dev.db (raw path passthrough)
 */
function parseSqliteUrl(url: string): string {
	if (url.startsWith("file:")) {
		return url.slice(5);
	}
	return url;
}

export const prismaPlugin = fp(
	async (app) => {
		const databaseUrl = app.config.DATABASE_URL!;
		const provider = detectDbProvider(databaseUrl);

		let adapter: ConstructorParameters<typeof PrismaClient>[0] extends { adapter?: infer A } ? A : never;
		let pgPool: import("pg").Pool | null = null;

		if (provider === "postgresql") {
			let PrismaPg: Awaited<typeof import("@prisma/adapter-pg")>["PrismaPg"];
			let pg: Awaited<typeof import("pg")>;
			try {
				({ PrismaPg } = await import("@prisma/adapter-pg"));
				pg = await import("pg");
			} catch {
				throw new Error(
					"PostgreSQL was detected from DATABASE_URL but the required packages " +
					"(@prisma/adapter-pg, pg) are not installed. " +
					"Install them with: pnpm add @prisma/adapter-pg pg",
				);
			}
			pgPool = new pg.default.Pool({ connectionString: databaseUrl });
			adapter = new PrismaPg(pgPool);
		} else {
			const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
			const dbPath = parseSqliteUrl(databaseUrl);
			adapter = new PrismaBetterSqlite3({ url: dbPath });
		}

		const prisma = new PrismaClient({ adapter });

		await prisma.$connect();

		app.decorate("prisma", prisma);
		app.decorate("dbProvider", provider);

		app.log.info({ dbProvider: provider }, "Database connected");

		app.addHook("onClose", async (server) => {
			await server.prisma.$disconnect();
			if (pgPool) {
				await pgPool.end();
			}
		});
	},
	{
		name: "prisma",
	},
);

export type PrismaPlugin = ReturnType<typeof prismaPlugin>;
