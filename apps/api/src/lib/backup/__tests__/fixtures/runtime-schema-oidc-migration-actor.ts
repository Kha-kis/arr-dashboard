import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import Database from "better-sqlite3";
import { acquireSqliteRestoreOperationLock } from "../../restore-runtime-sqlite.js";
import { synchronizeSqliteRuntimeSchema } from "../../runtime-schema-sqlite.js";

// Test-only native pauses on a temporary synthetic fixture; no production hooks.
process.once("message", async (input: unknown) => {
	try {
		if (
			!input ||
			typeof input !== "object" ||
			!("path" in input) ||
			typeof input.path !== "string" ||
			!("action" in input)
		)
			throw new Error();
		const path = resolve(input.path),
			directory = dirname(path);
		if (
			basename(path) !== "fixture.sqlite" ||
			!basename(directory).startsWith("arr-native-oidc-") ||
			dirname(directory) !== resolve(tmpdir())
		)
			throw new Error();
		const action = input.action;
		const checkpoint = () => process.send?.({ category: "native-checkpoint" });
		if (action === "hold-shared") {
			const lock = await acquireSqliteRestoreOperationLock(`file:${path}`);
			try {
				checkpoint();
				await new Promise<void>((done) => process.once("message", () => done()));
			} finally {
				await lock.close();
			}
		} else {
			if (
				![
					"after-create",
					"after-copy",
					"after-drop",
					"after-rename",
					"before-commit",
					"after-acknowledged-commit",
				].includes(action as string)
			)
				throw new Error();
			const pause = () => {
				checkpoint();
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
			};
			const original = Database.prototype.exec;
			Database.prototype.exec = function (this: Database.Database, sql: string) {
				if (this.name === path && action === "before-commit" && sql === "COMMIT") pause();
				const result = original.call(this, sql);
				if (
					this.name === path &&
					((action === "after-create" &&
						sql.startsWith('CREATE TABLE "ArrOidcProviderSchemaMigration"')) ||
						(action === "after-copy" &&
							sql.startsWith('INSERT INTO main."ArrOidcProviderSchemaMigration"')) ||
						(action === "after-drop" && sql === 'DROP TABLE main."oidc_providers"') ||
						(action === "after-rename" &&
							sql.startsWith('ALTER TABLE main."ArrOidcProviderSchemaMigration"')))
				)
					pause();
				return result;
			};
			await synchronizeSqliteRuntimeSchema(`file:${path}`);
			if (action === "after-acknowledged-commit") {
				checkpoint();
				await new Promise<void>((done) => process.once("message", () => done()));
			}
		}
		process.send?.({ category: "closed" });
	} catch {
		process.send?.({ category: "unavailable" });
		process.exitCode = 1;
	} finally {
		process.disconnect?.();
	}
});
