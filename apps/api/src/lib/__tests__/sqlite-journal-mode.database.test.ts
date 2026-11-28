import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "../../generated/prisma/client.js";
import { createRecoverableSqliteAdapter } from "../sqlite-adapter.js";
import { configureSqliteJournalMode } from "../sqlite-journal-mode.js";

const directories: string[] = [];
const clients: PrismaClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) await client.$disconnect();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

async function connect(): Promise<{ path: string; prisma: PrismaClient }> {
	const directory = mkdtempSync(join(tmpdir(), "sqlite-journal-mode-"));
	directories.push(directory);
	const path = join(directory, "fixture.db");
	const prisma = new PrismaClient({ adapter: createRecoverableSqliteAdapter({ url: path }) });
	clients.push(prisma);
	await prisma.$connect();
	return { path, prisma };
}

describe("SQLite journal-mode admission", () => {
	it("preserves the existing rollback-journal mode by default", async () => {
		const { path, prisma } = await connect();
		expect(await configureSqliteJournalMode(prisma, "preserve")).toBe("delete");
		const observer = new Database(path);
		try {
			expect(observer.pragma("journal_mode", { simple: true })).toBe("delete");
		} finally {
			observer.close();
		}
	});

	it("enters WAL only when requested and persists it across connections", async () => {
		const { path, prisma } = await connect();
		expect(await configureSqliteJournalMode(prisma, "wal")).toBe("wal");
		expect(await configureSqliteJournalMode(prisma, "preserve")).toBe("wal");
		const observer = new Database(path);
		try {
			expect(observer.pragma("journal_mode", { simple: true })).toBe("wal");
		} finally {
			observer.close();
		}
	});

	it("keeps committed reads available during a separate uncommitted writer", async () => {
		const { path, prisma } = await connect();
		expect(await configureSqliteJournalMode(prisma, "wal")).toBe("wal");
		const writer = new Database(path, { timeout: 25 });
		const reader = new Database(path, { timeout: 25 });
		try {
			writer.exec("CREATE TABLE observations (id INTEGER PRIMARY KEY)");
			writer.exec("INSERT INTO observations(id) VALUES (1)");
			writer.exec("BEGIN EXCLUSIVE; INSERT INTO observations(id) VALUES (2)");
			expect(reader.prepare("SELECT COUNT(*) AS count FROM observations").get()).toEqual({
				count: 1,
			});
			writer.exec("COMMIT");
			expect(reader.prepare("SELECT COUNT(*) AS count FROM observations").get()).toEqual({
				count: 2,
			});
		} finally {
			if (writer.inTransaction) writer.exec("ROLLBACK");
			reader.close();
			writer.close();
		}
	});

	it("can explicitly return a stopped WAL database to rollback journaling", async () => {
		const { path, prisma } = await connect();
		expect(await configureSqliteJournalMode(prisma, "wal")).toBe("wal");
		expect(await configureSqliteJournalMode(prisma, "delete")).toBe("delete");
		const observer = new Database(path);
		try {
			expect(observer.pragma("journal_mode", { simple: true })).toBe("delete");
		} finally {
			observer.close();
		}
	});

	it("rejects a requested WAL mode if SQLite reports it did not activate", async () => {
		const query = vi.fn().mockResolvedValue([{ journal_mode: "delete" }]);
		await expect(
			configureSqliteJournalMode({ $queryRawUnsafe: query } as never, "wal"),
		).rejects.toThrow("SQLite WAL mode unavailable");
	});
});
