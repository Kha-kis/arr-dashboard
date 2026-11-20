import fp from "fastify-plugin";
import {
	getRestoreRuntimeClientContext,
	openRestoreRuntime,
	RestoreRuntimeAdmissionError,
	type RestoreRuntime,
} from "../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../lib/backup/restore-runtime-client.js";
import { resolveSqliteRestoreStorage } from "../lib/backup/restore-runtime-sqlite-storage.js";
import { configureSqliteJournalMode } from "../lib/sqlite-journal-mode.js";

type DbProvider = "sqlite" | "postgresql";

/**
 * Detect database provider from the DATABASE_URL connection string.
 * PostgreSQL URLs start with postgres:// or postgresql://.
 * Everything else (including file: paths) is treated as SQLite.
 */
function detectDbProvider(url: string): DbProvider {
	return /^postgres(ql)?:\/\//i.test(url) ? "postgresql" : "sqlite";
}

export const prismaPlugin = fp(
	async (app) => {
		const databaseUrl = app.config.DATABASE_URL!;
		const provider = detectDbProvider(databaseUrl);
		const supplied = app.hasDecorator("restoreRuntime");
		const runtime = supplied
			? app.getDecorator<RestoreRuntime>("restoreRuntime")
			: await openRestoreRuntime({
					databaseUrl,
					onUnavailable: () => {
						queueMicrotask(() => {
							const shutdown = app.hasDecorator("lifecycle")
								? app.lifecycle.shutdown()
								: app.close();
							void shutdown.catch(() => app.log.error("Database runtime shutdown failed"));
						});
					},
				});
		let native!: ReturnType<typeof createRuntimePrismaClient>;
		let clientRegistered = false;
		try {
			const context = getRestoreRuntimeClientContext(runtime);
			const configured =
				provider === "postgresql"
					? databaseUrl
					: `file:${resolveSqliteRestoreStorage(databaseUrl).databasePath}`;
			if (context.databaseUrl !== configured) throw new RestoreRuntimeAdmissionError();
			native = createRuntimePrismaClient(runtime);
			clientRegistered = true;
			await runtime.runStarting(async () => {
				await native.prisma.$connect();
				if (provider === "sqlite") {
					const journalMode = await configureSqliteJournalMode(
						native.prisma,
						app.config.SQLITE_JOURNAL_MODE,
					);
					app.log.info({ sqliteJournalMode: journalMode }, "SQLite journal mode verified");
				}
			});
		} catch (error) {
			// A rejected foreign/forged runtime is not ours to close. Once a
			// client is registered, the actual runtime owns its joined cleanup.
			if (!supplied || clientRegistered) await runtime.close();
			throw error;
		}
		if (!supplied) app.decorate("restoreRuntime", runtime);
		app.decorate("prisma", native.prisma);
		app.decorate("dbProvider", provider);
		app.log.info({ dbProvider: provider }, "Database connected");
		app.addHook("preClose", async () => {
			runtime.closeAdmission();
		});
		app.addHook("onClose", async () => {
			// Drain accepted work before the runtime disconnects registered
			// native clients and releases its owner; socket closure is not drain.
			await runtime.close();
		});
	},
	{
		name: "prisma",
	},
);

declare module "fastify" {
	interface FastifyInstance {
		restoreRuntime: RestoreRuntime;
	}
}
