import { describe, expect, it, vi } from "vitest";
import { createTestPgClient, createTestPrismaClient } from "./test-prisma.js";

// Trap the external connection boundary: unsafe inputs must fail before it.
vi.mock("pg", () => ({
	default: {
		Pool: class {
			constructor() {
				throw new Error("Unexpected PostgreSQL pool construction");
			}
		},
	},
}));

describe("test Prisma target authorization without network access", () => {
	it.each([
		"postgresql://synthetic.invalid:5432/history_lease_test",
		"postgresql://127.0.0.1:5432/",
		"postgresql://127.0.0.1:5432/dashboard",
		"postgresql://127.0.0.1:5432/history_lease_test?host=synthetic.invalid",
		"postgresql://127.0.0.1:5432/history_lease_test?port=1",
		"postgresql://127.0.0.1:5432/history_lease_test?schema=public",
		"postgresql://127.0.0.1:5432/history_lease_test?options=-c%20search_path=public",
		"https://127.0.0.1:5432/history_lease_test",
		"not-a-url",
	])("rejects unsafe target %s before creating any pool", async (value) => {
		await expect(createTestPgClient(value)).rejects.toThrow(
			"PostgreSQL test clients require a plain loopback URL and a database ending in _test",
		);
	});

	it("retains the real default SQLite client", async () => {
		const prisma = createTestPrismaClient();
		try {
			expect(await prisma.$queryRawUnsafe("SELECT 1 AS value")).toEqual([{ value: 1n }]);
		} finally {
			await prisma.$disconnect();
		}
	});
});
