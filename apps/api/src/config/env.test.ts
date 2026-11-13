import { describe, expect, it } from "vitest";
import { envSchema } from "./env.js";

describe("SQLite journal-mode configuration", () => {
	it("preserves the existing database mode unless an operator opts in", () => {
		expect(envSchema.parse({ NODE_ENV: "test" }).SQLITE_JOURNAL_MODE).toBe("preserve");
		expect(
			envSchema.parse({ NODE_ENV: "test", SQLITE_JOURNAL_MODE: "wal" }).SQLITE_JOURNAL_MODE,
		).toBe("wal");
	});

	it("rejects unsupported modes instead of silently ignoring them", () => {
		expect(envSchema.safeParse({ NODE_ENV: "test", SQLITE_JOURNAL_MODE: "unsafe" }).success).toBe(
			false,
		);
	});
});
