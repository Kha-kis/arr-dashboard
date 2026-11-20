import { writeSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { acquireSqliteRestoreOperationLock } from "../../restore-runtime-sqlite.js";
import { synchronizePostgresRuntimeSchema } from "../../runtime-schema-postgres.js";
import { synchronizeSqliteRuntimeSchema } from "../../runtime-schema-sqlite.js";

// Real child writer for the disposable native lifecycle tests; no credentials in
// argv, stdout, stderr or recorded environment. It cannot claim parent ownership.
process.once("message", async (input: unknown) => {
	try {
		if (
			!input ||
			typeof input !== "object" ||
			!("databaseUrl" in input) ||
			typeof input.databaseUrl !== "string"
		)
			throw new Error();
		if (input.databaseUrl.startsWith("file:")) {
			const path = resolve(input.databaseUrl.slice(5));
			if (
				basename(path) !== "fixture.sqlite" ||
				!basename(dirname(path)).startsWith("arr-native-schema-")
			)
				throw new Error();
			const action = "action" in input ? input.action : null;
			if (action === "hold-shared") {
				const lock = await acquireSqliteRestoreOperationLock(input.databaseUrl);
				try {
					writeSync(1, '{"category":"native-checkpoint"}\n');
					await new Promise<void>((done) => process.once("message", () => done()));
				} finally {
					await lock.close();
				}
			} else {
				if (
					![null, "after-first-ddl", "before-commit", "after-commit"].includes(
						action as string | null,
					)
				)
					throw new Error();
				const original = Database.prototype.exec;
				const pause = () => {
					writeSync(1, '{"category":"native-checkpoint"}\n');
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
				};
				// Test-only stop point around the real native call. There is no fake
				// writer, alternate SQLite engine, or production fault-injection hook.
				Database.prototype.exec = function (this: Database.Database, sql: string) {
					const main = this.name === path;
					if (main && action === "before-commit" && sql === "COMMIT") pause();
					const result = original.call(this, sql);
					if (
						main &&
						((action === "after-first-ddl" && sql.startsWith("CREATE TABLE ")) ||
							(action === "after-commit" && sql === "COMMIT"))
					)
						pause();
					return result;
				};
				await synchronizeSqliteRuntimeSchema(input.databaseUrl);
			}
		} else {
			const url = new URL(input.databaseUrl);
			if (
				url.hostname !== "127.0.0.1" ||
				!url.searchParams.get("schema")?.startsWith("startup_fixture_")
			)
				throw new Error();
			await synchronizePostgresRuntimeSchema(input.databaseUrl);
		}
		process.send?.({ category: "ready" });
	} catch {
		process.send?.({ category: "unavailable" });
		process.exitCode = 1;
	} finally {
		process.disconnect?.();
	}
});
