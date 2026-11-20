import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, vi } from "vitest";
import { openRestoreRuntime } from "../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../backup/runtime-schema-startup.js";
import { createProviderPublicationAuthority } from "../services/provider-identity-guard.js";
import { createTestPrismaClient } from "./test-prisma.js";

type Runtime = Awaited<ReturnType<typeof openRestoreRuntime>>;
type Client = ReturnType<typeof createRuntimePrismaClient>;
type PlainClient = ReturnType<typeof createTestPrismaClient>;
type Entry = {
	directory: string;
	path: string;
	writer?: Database.Database;
	plain?: PlainClient;
	runtime?: Runtime;
	clients: Client[];
	applications: Set<Database.Database>;
	losses: string[];
};
const entries: Entry[] = [];

export async function createScopedWriteFixture(options: { writeIntent?: boolean } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "arr-scoped-write-intent-"));
	chmodSync(directory, 0o700);
	const path = join(directory, "synthetic.sqlite");
	const entry: Entry = { directory, path, clients: [], applications: new Set(), losses: [] };
	entries.push(entry);
	// Use the application's real native bootstrap, not a Prisma CLI per fixture.
	await synchronizeRuntimeSchema(`file:${path}`);
	chmodSync(path, 0o600);
	const writer = new Database(path, { timeout: 0 });
	entry.writer = writer;
	writer.pragma("journal_mode=WAL");
	writer.exec(
		"CREATE TABLE CompetitionProbe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO CompetitionProbe VALUES(1,0)",
	);
	const plain = createTestPrismaClient(path);
	entry.plain = plain;
	await plain.user.create({ data: { id: "synthetic-user", username: "synthetic-user" } });
	for (const [id, service] of [
		["synthetic-plex", "PLEX"],
		["synthetic-jellyfin", "JELLYFIN"],
	] as const) {
		await plain.serviceInstance.create({
			data: {
				id,
				userId: "synthetic-user",
				service,
				label: "Synthetic",
				baseUrl: "http://synthetic.invalid",
				encryptedApiKey: "synthetic-cipher",
				encryptionIv: "synthetic-iv",
				expectedIdentity: "synthetic-provider",
				identityStatus: "VERIFIED",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
	}
	await plain.libraryCleanupConfig.create({
		data: { id: "synthetic-cleanup", userId: "synthetic-user" },
	});
	await plain.plexCache.create({
		data: {
			id: "synthetic-cache",
			instanceId: "synthetic-plex",
			tmdbId: 1,
			mediaType: "movie",
			sectionId: "synthetic-section",
			sectionTitle: "Synthetic",
			watchedByUsers: "[]",
			collections: "[]",
			labels: "[]",
			connectionGeneration: 1,
			identityGeneration: 1,
		},
	});
	const authority = createProviderPublicationAuthority(
		await plain.serviceInstance.findUniqueOrThrow({ where: { id: "synthetic-plex" } }),
	);
	const runtime = await openRestoreRuntime({
		databaseUrl: `file:${path}`,
		onUnavailable: (event) => entry.losses.push(event.reason),
	});
	entry.runtime = runtime;
	await runtime.bindDestination("synthetic-scoped-write-intent");
	await runtime.activate();
	const client = createRuntimePrismaClient(
		runtime,
		options.writeIntent ? { sqliteTransactionIntent: "write" } : undefined,
	);
	entry.clients.push(client);
	return {
		...entry,
		writer,
		plain,
		runtime,
		client,
		authority,
		newClient() {
			const next = createRuntimePrismaClient(runtime);
			entry.clients.push(next);
			return next;
		},
	};
}

export type ScopedWriteFixture = Awaited<ReturnType<typeof createScopedWriteFixture>>;

export function snapshotProtectedRows(f: ScopedWriteFixture) {
	return Object.fromEntries(
		[
			"RestoreRuntimeControl",
			"SqliteRestoreStorageBinding",
			"ServiceInstance",
			"library_cleanup_configs",
			"plex_cache",
		].map((table) => [table, f.writer.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]),
	);
}

export function interceptScopedWriteCompetition(
	f: ScopedWriteFixture,
	options: { compete?: boolean; holdBeforeReservation?: boolean } = {},
) {
	let armed = options.compete ?? false;
	let held = options.holdBeforeReservation ?? false;
	const receipt = {
		commits: 0,
		blocked: 0,
		rollbacks: 0,
		reservations: 0,
		nativeErrors: [] as string[],
		events: [] as string[],
	};
	const prepare = Database.prototype.prepare;
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		const statement = prepare.call(this, sql);
		if (this.name !== f.path || this === f.writer) return statement;
		const native = this;
		if (sql === "BEGIN") f.applications.add(native);
		for (const method of ["all", "run"] as const) {
			const invoke = statement[method];
			const wrapped = function (this: typeof statement, ...args: unknown[]) {
				try {
					const result = Reflect.apply(invoke, this, args);
					if (sql === "BEGIN" && held) {
						held = false;
						f.writer.exec("BEGIN IMMEDIATE");
						receipt.events.push("competing-writer-held");
					}
					if (sql === 'UPDATE "RestoreRuntimeControl" SET "id"="id" WHERE 0')
						receipt.reservations++;
					if (sql === "ROLLBACK") receipt.rollbacks++;
					if (
						f.applications.has(native) &&
						native.inTransaction &&
						sql.includes("FROM SqliteRestoreStorageBinding")
					) {
						receipt.events.push("guard-snapshot");
						if (armed) {
							armed = false;
							try {
								f.writer.exec(
									"BEGIN IMMEDIATE;UPDATE CompetitionProbe SET value=value+1 WHERE id=1;COMMIT",
								);
								receipt.commits++;
								receipt.events.push("competing-commit");
							} catch (error) {
								if (f.writer.inTransaction) f.writer.exec("ROLLBACK");
								if (!(error instanceof Database.SqliteError) || error.code !== "SQLITE_BUSY")
									throw error;
								receipt.blocked++;
								receipt.events.push("competing-blocked");
							}
						}
					}
					return result;
				} catch (error) {
					if (error instanceof Database.SqliteError) receipt.nativeErrors.push(error.code);
					throw error;
				}
			};
			Reflect.set(statement, method, wrapped);
		}
		return statement;
	});
	return receipt;
}

export function recordScopedWriteEvidence(name: string, value: unknown) {
	const directory = process.env.SCOPED_WRITE_INTENT_EVIDENCE_DIR;
	if (directory)
		writeFileSync(join(directory, `${name}.json`), JSON.stringify(value, null, 2) + "\n", {
			mode: 0o600,
		});
}

export async function closeScopedWriteFixtures() {
	vi.restoreAllMocks();
	for (const f of entries.splice(0)) {
		if (f.writer?.inTransaction) f.writer.exec("ROLLBACK");
		for (const client of f.clients) await client.close();
		const applicationClosed = [...f.applications].every((db) => !db.open);
		if (f.runtime) {
			await f.runtime.drain();
			await f.runtime.close();
		}
		await f.plain?.$disconnect();
		f.writer?.close();
		const writerClosed = !f.writer?.open;
		rmSync(f.directory, { recursive: true, force: true });
		const removed = !existsSync(f.directory);
		recordScopedWriteEvidence(`closure-${f.directory.split("/").at(-1)}`, {
			applicationHandles: f.applications.size,
			applicationClosed,
			writerClosed,
			runtimeClosed: Boolean(f.runtime),
			removed,
			losses: f.losses,
		});
		expect(applicationClosed).toBe(true);
		expect(writerClosed).toBe(true);
		expect(removed).toBe(true);
	}
}
