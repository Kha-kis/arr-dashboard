import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import {
	openRestoreRuntime,
	type RestoreRuntime,
} from "../../lib/backup/restore-runtime-admission.js";

/**
 * Genuine native admission for scheduler lifecycle tests with synthetic
 * persistence/providers. This does not prove application SQL or provider writes.
 */
export async function installRuntimeFixture(
	app: FastifyInstance,
	options: { activate?: boolean } = {},
) {
	const directory = mkdtempSync(join(tmpdir(), "arr-scheduler-runtime-"));
	const path = join(directory, "fixture.db");
	const databaseUrl = `file:${path}`;
	let runtime: RestoreRuntime | undefined;
	try {
		chmodSync(directory, 0o700);
		const database = new Database(path);
		try {
			chmodSync(path, 0o600);
			database.exec(`
				CREATE TABLE RestoreRuntimeControl (
					id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL, phase TEXT NOT NULL,
					runtimeEpoch TEXT, ownerBackendPid INTEGER, activeRestoreId TEXT,
					lastCommittedRestoreId TEXT, lastCommittedAt DATETIME, destinationInstallationId TEXT);
				CREATE TABLE SqliteRestoreStorageBinding (
					id INTEGER PRIMARY KEY, protocolVersion INTEGER NOT NULL,
					databaseDevice TEXT NOT NULL, databaseInode TEXT NOT NULL,
					directoryDevice TEXT NOT NULL, directoryInode TEXT NOT NULL,
					coordinationDevice TEXT NOT NULL, coordinationInode TEXT NOT NULL,
					ownerDevice TEXT NOT NULL, ownerInode TEXT NOT NULL,
					operationsDevice TEXT NOT NULL, operationsInode TEXT NOT NULL);
			`);
		} finally {
			database.close();
		}
		runtime = await openRestoreRuntime({ databaseUrl });
		await runtime.bindDestination("synthetic-scheduler-destination");
		if (options.activate !== false) await runtime.activate();
		const owned = runtime;
		app.decorate("restoreRuntime", owned);
		// Register before scheduler/notification/persistence plugins. Fastify's
		// reverse onClose order joins their accepted work before native teardown.
		app.addHook("onClose", async () => {
			await owned.close();
			rmSync(directory, { recursive: true, force: true });
		});
		return { runtime: owned, directory, databaseUrl };
	} catch (error) {
		// A failed native close must retain storage rather than delete held files.
		await runtime?.close();
		rmSync(directory, { recursive: true, force: true });
		throw error;
	}
}
