import type { PrismaClient } from "../generated/prisma/client.js";

export type SqliteJournalModePreference = "preserve" | "wal" | "delete";

type JournalModeRow = { journal_mode?: unknown };

/** Apply an operator-selected mode before background jobs acquire database connections. */
export async function configureSqliteJournalMode(
	prisma: Pick<PrismaClient, "$queryRawUnsafe">,
	preference: SqliteJournalModePreference,
): Promise<string> {
	try {
		const rows = await prisma.$queryRawUnsafe<JournalModeRow[]>(
			preference === "wal"
				? "PRAGMA journal_mode=WAL"
				: preference === "delete"
					? "PRAGMA journal_mode=DELETE"
					: "PRAGMA journal_mode",
		);
		const actual = rows[0]?.journal_mode;
		if (typeof actual !== "string" || !actual) throw new Error("Invalid journal-mode result");
		const normalized = actual.toLowerCase();
		if (preference !== "preserve" && normalized !== preference)
			throw new Error("Requested journal mode was not activated");
		return normalized;
	} catch {
		throw new Error(
			preference === "wal"
				? "SQLite WAL mode unavailable"
				: preference === "delete"
					? "SQLite rollback-journal mode unavailable"
					: "SQLite journal mode unavailable",
		);
	}
}
