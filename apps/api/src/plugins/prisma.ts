import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import fp from "fastify-plugin";

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
		// In Prisma 7, we use Driver Adapters instead of passing datasourceUrl directly.
		// For SQLite, this means using @prisma/adapter-better-sqlite3.
		const databasePath = parseSqliteUrl(app.config.DATABASE_URL);
		const adapter = new PrismaBetterSqlite3({ url: databasePath });

		const prisma = new PrismaClient({ adapter });

		await prisma.$connect();

		app.decorate("prisma", prisma);

		app.addHook("onClose", async (server) => {
			await server.prisma.$disconnect();
		});
	},
	{
		name: "prisma",
	},
);

export type PrismaPlugin = ReturnType<typeof prismaPlugin>;
