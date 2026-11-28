import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createTestPgClient } from "./test-prisma.js";

const url = process.env.TEST_PG_HELPER_URL;
const pgDescribe = process.env.INTEGRATION_TESTS === "true" && url ? describe : describe.skip;

pgDescribe("native PostgreSQL test client integration", () => {
	it("shares actual PostgreSQL rows between peers and cleans up idempotently", async () => {
		const first = await createTestPgClient(url!);
		let second: Awaited<ReturnType<typeof createTestPgClient>> | undefined;
		const userId = `helper-peer-${randomUUID()}`;
		try {
			second = await createTestPgClient(url!);
			await first.prisma.user.create({ data: { id: userId, username: userId } });
			expect(await second.prisma.user.findUnique({ where: { id: userId } })).toMatchObject({
				id: userId,
				username: userId,
			});
			expect(await second.prisma.$queryRawUnsafe("SELECT current_database() AS name")).toEqual([
				{ name: new URL(url!).pathname.slice(1) },
			]);
		} finally {
			try {
				await first.prisma.user.deleteMany({ where: { id: userId } });
			} finally {
				try {
					await second?.cleanup();
				} finally {
					await Promise.all([first.cleanup(), first.cleanup()]);
				}
			}
		}
	}, 30_000);

	it("rolls back a real failed transaction and permits an explicit retry", async () => {
		const client = await createTestPgClient(url!);
		const userId = `helper-retry-${randomUUID()}`;
		try {
			await expect(
				client.prisma.$transaction(async (tx) => {
					await tx.user.create({ data: { id: userId, username: userId } });
					await tx.$queryRawUnsafe("SELECT 1 / 0");
				}),
			).rejects.toThrow();
			expect(await client.prisma.user.findUnique({ where: { id: userId } })).toBeNull();
			await client.prisma.user.create({ data: { id: userId, username: userId } });
			expect(await client.prisma.user.findUnique({ where: { id: userId } })).toMatchObject({
				id: userId,
			});
		} finally {
			try {
				await client.prisma.user.deleteMany({ where: { id: userId } });
			} finally {
				await client.cleanup();
			}
		}
	}, 30_000);
});
