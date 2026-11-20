import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";

function initializePrismaSchema(path: string): void {
	execFileSync(
		"pnpm",
		["exec", "prisma", "db", "push", "--schema", resolve(process.cwd(), "prisma/schema.prisma")],
		{
			cwd: process.cwd(),
			env: { ...process.env, DATABASE_URL: `file:${path}` },
			stdio: "pipe",
			timeout: 60_000,
		},
	);
}

function assertStandalone(path: string): void {
	if (!lstatSync(path).isFile() || lstatSync(path).nlink !== 1) {
		throw new Error("SQLite schema template must be an ordinary private file");
	}
	for (const suffix of ["-journal", "-wal", "-shm"]) {
		if (existsSync(`${path}${suffix}`)) throw new Error("SQLite schema template has a sidecar");
	}
}

function fingerprint(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** A per-test-file template; each destination remains owned by its caller. */
export class SqliteSchemaFixture {
	private state: "new" | "initializing" | "ready" | "failed" | "disposed" = "new";
	private directory: string | undefined;
	private path: string | undefined;
	private pristineFingerprint: string | undefined;

	// An injected initializer must synchronously finish and close all of its drivers.
	constructor(private readonly initializeSchema: (path: string) => void = initializePrismaSchema) {}

	initialize(): void {
		if (this.state !== "new") throw new Error("SQLite schema fixture cannot be initialized again");
		this.state = "initializing";
		try {
			this.directory = mkdtempSync(join(tmpdir(), "sqlite-schema-template-"));
			this.path = join(this.directory, "schema.db");
			this.initializeSchema(this.path);
			assertStandalone(this.path);
			const db = new Database(this.path, { readonly: true, fileMustExist: true });
			try {
				if (db.pragma("quick_check", { simple: true }) !== "ok") {
					throw new Error("SQLite schema template failed integrity validation");
				}
				const tables = db
					.prepare(
						"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
					)
					.all() as Array<{ name: string }>;
				if (tables.length === 0) throw new Error("SQLite schema template has no schema");
				for (const { name } of tables) {
					const table = `"${name.replaceAll('"', '""')}"`;
					if (db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()) {
						throw new Error("SQLite schema template must be empty");
					}
				}
			} finally {
				db.close();
			}
			assertStandalone(this.path);
			this.pristineFingerprint = fingerprint(this.path);
			this.state = "ready";
		} catch (error) {
			this.state = "failed";
			this.removeTemplate();
			throw error;
		}
	}

	copyTo(path: string): void {
		if (this.state !== "ready" || !this.path) {
			throw new Error("SQLite schema fixture is not ready");
		}
		assertStandalone(this.path);
		if (fingerprint(this.path) !== this.pristineFingerprint) {
			throw new Error("SQLite schema template changed after initialization");
		}
		copyFileSync(this.path, path, constants.COPYFILE_EXCL);
	}

	dispose(): void {
		this.state = "disposed";
		this.removeTemplate();
	}

	private removeTemplate(): void {
		if (this.directory) {
			rmSync(this.directory, { recursive: true, force: true });
			this.directory = undefined;
		}
	}
}
