import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { type Prisma, PrismaClient } from "../../../generated/prisma/client.js";
import { createTestPgClient } from "../../__tests__/test-prisma.js";
import {
	acquireHistoryCollectionLease,
	HISTORY_COLLECTION_LEASE_CURSOR_MAX_BYTES,
	HISTORY_COLLECTION_LEASE_HEARTBEAT_MS,
	HISTORY_COLLECTION_LEASE_TOKEN_MAX_BYTES,
	heartbeatHistoryCollectionLease,
	releaseHistoryCollectionLease,
	withHistoryCollectionLeaseAuthority,
} from "../history-collection-lease.js";

const databases: Array<{ clients: PrismaClient[]; directory: string }> = [];
const postgresCleanups: Array<() => Promise<void>> = [];
const postgresUsers: Array<{ prisma: PrismaClient; userId: string }> = [];

afterEach(async () => {
	for (const { clients, directory } of databases.splice(0)) {
		await Promise.all(clients.map(async (client) => await client.$disconnect()));
		rmSync(directory, { recursive: true, force: true });
	}
	for (const { prisma, userId } of postgresUsers.splice(0)) {
		await prisma.user.deleteMany({ where: { id: userId } });
	}
	for (const cleanup of postgresCleanups.splice(0)) await cleanup();
});

describe("owner-global History collection lease", { timeout: 30_000 }, () => {
	it("allows exactly one winner for two concurrent first claims", async () => {
		const { clients, prisma } = await createDatabase(2);
		await createUser(prisma, "owner-first");

		const claims = await Promise.all(
			clients.map(
				async (client) =>
					await acquireHistoryCollectionLease(client, "owner-first", { dialect: "sqlite" }),
			),
		);

		expect(claims.filter(Boolean)).toHaveLength(1);
		expect(claims.filter((claim) => claim?.claimToken)).toHaveLength(1);
		expect(await countRows(prisma, "owner-first")).toBe(1);
	});

	it("denies an active owner without changing any lease field", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-active");
		const first = await acquireHistoryCollectionLease(prisma, "owner-active", {
			dialect: "sqlite",
		});
		if (!first) throw new Error("expected first claim");
		await prisma.historyCollectionLease.update({
			where: { userId: "owner-active" },
			data: {
				lastAttemptResult: "failed",
				lastAttemptReason: "synthetic",
				nextSourceCursor: "cursor-a",
			},
		});
		const before = await readLease(prisma, "owner-active");

		expect(
			await acquireHistoryCollectionLease(prisma, "owner-active", { dialect: "sqlite" }),
		).toBeNull();
		expect(await readLease(prisma, "owner-active")).toEqual(before);
	});

	it("reclaims an expired row once and rejects the stale token", async () => {
		const { clients, prisma } = await createDatabase(2);
		await createUser(prisma, "owner-reclaim");
		const original = await acquireHistoryCollectionLease(prisma, "owner-reclaim", {
			dialect: "sqlite",
		});
		if (!original) throw new Error("expected first claim");
		await prisma.$executeRawUnsafe(
			`UPDATE history_collection_leases
			 SET expiresAt = datetime(CURRENT_TIMESTAMP, '-1 second'),
			     claimedAt = datetime(CURRENT_TIMESTAMP, '-301 seconds'),
			     heartbeatAt = datetime(CURRENT_TIMESTAMP, '-301 seconds')
			 WHERE userId = ?`,
			"owner-reclaim",
		);

		const reclaims = await Promise.all(
			clients.map(
				async (client) =>
					await acquireHistoryCollectionLease(client, "owner-reclaim", { dialect: "sqlite" }),
			),
		);
		const replacement = reclaims.find((claim) => claim);
		if (!replacement) throw new Error("expected replacement claim");
		expect(reclaims.filter(Boolean)).toHaveLength(1);
		expect(replacement.claimToken).not.toBe(original.claimToken);
		expect(await readLease(prisma, "owner-reclaim")).toMatchObject({
			claimToken: replacement.claimToken,
		});
		expect(
			await heartbeatHistoryCollectionLease(prisma, original, "stale", { dialect: "sqlite" }),
		).toBe(false);
		expect(await releaseHistoryCollectionLease(prisma, original, { dialect: "sqlite" })).toBe(
			false,
		);
		expect(await readLease(prisma, "owner-reclaim")).toMatchObject({
			claimToken: replacement.claimToken,
			nextSourceCursor: null,
		});
	});

	it("fails closed when an existing fairness cursor is malformed", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-bad-cursor");
		await prisma.historyCollectionLease.create({
			data: {
				userId: "owner-bad-cursor",
				nextSourceCursor: "x".repeat(HISTORY_COLLECTION_LEASE_CURSOR_MAX_BYTES + 1),
			},
		});
		const before = await readLease(prisma, "owner-bad-cursor");
		expect(
			await acquireHistoryCollectionLease(prisma, "owner-bad-cursor", { dialect: "sqlite" }),
		).toBeNull();
		expect(await readLease(prisma, "owner-bad-cursor")).toEqual(before);
	});

	it.each([
		{
			name: "null token with claim fields",
			token: null,
			claimed: "datetime(CURRENT_TIMESTAMP, '-1 second')",
		},
		{
			name: "token with null expiry",
			token: "partial-token",
			claimed: "CURRENT_TIMESTAMP",
			expiry: "NULL",
		},
	])(
		"fails closed for a malformed partial-claim shape: $name",
		async ({ token, claimed, expiry }) => {
			const { prisma } = await createDatabase();
			await createUser(prisma, "owner-malformed");
			await prisma.historyCollectionLease.create({ data: { userId: "owner-malformed" } });
			await prisma.$executeRawUnsafe(
				`UPDATE history_collection_leases
			 SET claimToken = ?, claimedAt = ${claimed}, heartbeatAt = ${claimed}, expiresAt = ${expiry ?? "CURRENT_TIMESTAMP"}
			 WHERE userId = ?`,
				token,
				"owner-malformed",
			);
			const before = await readLease(prisma, "owner-malformed");

			expect(
				await acquireHistoryCollectionLease(prisma, "owner-malformed", { dialect: "sqlite" }),
			).toBeNull();
			expect(await readLease(prisma, "owner-malformed")).toEqual(before);
		},
	);

	it("heartbeats only the exact unexpired token and persists a bounded cursor", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-heartbeat");
		const claim = await acquireHistoryCollectionLease(prisma, "owner-heartbeat", {
			dialect: "sqlite",
		});
		if (!claim) throw new Error("expected claim");
		// Keep the live fixture beyond this test's timeout but below the renewed five-minute TTL.
		await prisma.$executeRawUnsafe(
			`UPDATE history_collection_leases SET expiresAt = datetime(CURRENT_TIMESTAMP, '+60 seconds') WHERE userId = ?`,
			"owner-heartbeat",
		);
		const before = await readLease(prisma, "owner-heartbeat");

		expect(
			await heartbeatHistoryCollectionLease(prisma, claim, "cursor-b", { dialect: "sqlite" }),
		).toBe(true);
		const after = await readLease(prisma, "owner-heartbeat");
		expect(after).toMatchObject({ claimToken: claim.claimToken, nextSourceCursor: "cursor-b" });
		expect(new Date(String(after.expiresAt)).getTime()).toBeGreaterThan(
			new Date(String(before.expiresAt)).getTime(),
		);
		expect(HISTORY_COLLECTION_LEASE_HEARTBEAT_MS).toBe(30_000);
		expect(
			await heartbeatHistoryCollectionLease(
				prisma,
				{ ...claim, claimToken: "wrong-token" },
				"cursor-c",
				{ dialect: "sqlite" },
			),
		).toBe(false);
		expect(
			await heartbeatHistoryCollectionLease(prisma, claim, "\u0000", { dialect: "sqlite" }),
		).toBe(false);
		expect(
			await heartbeatHistoryCollectionLease(
				prisma,
				claim,
				"x".repeat(HISTORY_COLLECTION_LEASE_CURSOR_MAX_BYTES + 1),
				{ dialect: "sqlite" },
			),
		).toBe(false);
		expect(await readLease(prisma, "owner-heartbeat")).toMatchObject({
			nextSourceCursor: "cursor-b",
		});
		await prisma.$executeRawUnsafe(
			`UPDATE history_collection_leases SET expiresAt = datetime(CURRENT_TIMESTAMP, '-1 second') WHERE userId = ?`,
			"owner-heartbeat",
		);
		expect(
			await heartbeatHistoryCollectionLease(prisma, claim, "expired", { dialect: "sqlite" }),
		).toBe(false);
	});

	it("releases only the exact claim fields and preserves cursor and attempt history", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-release");
		const claim = await acquireHistoryCollectionLease(prisma, "owner-release", {
			dialect: "sqlite",
		});
		if (!claim) throw new Error("expected claim");
		await prisma.historyCollectionLease.update({
			where: { userId: "owner-release" },
			data: {
				lastAttemptResult: "failed",
				lastAttemptReason: "synthetic",
				nextSourceCursor: "cursor-preserved",
			},
		});

		expect(await releaseHistoryCollectionLease(prisma, claim, { dialect: "sqlite" })).toBe(true);
		expect(await readLease(prisma, "owner-release")).toMatchObject({
			claimToken: null,
			claimedAt: null,
			heartbeatAt: null,
			expiresAt: null,
			lastAttemptResult: "failed",
			lastAttemptReason: "synthetic",
			nextSourceCursor: "cursor-preserved",
		});
	});

	it("allows the exact owner to release an already expired claim", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-expired-release");
		const claim = await acquireHistoryCollectionLease(prisma, "owner-expired-release", {
			dialect: "sqlite",
		});
		if (!claim) throw new Error("expected claim");
		await prisma.$executeRawUnsafe(
			`UPDATE history_collection_leases SET expiresAt = datetime(CURRENT_TIMESTAMP, '-1 second') WHERE userId = ?`,
			"owner-expired-release",
		);
		expect(await releaseHistoryCollectionLease(prisma, claim, { dialect: "sqlite" })).toBe(true);
		expect(await readLease(prisma, "owner-expired-release")).toMatchObject({
			claimToken: null,
			expiresAt: null,
		});
	});

	it("preserves a valid prior fairness cursor when acquiring", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-cursor");
		await prisma.historyCollectionLease.create({
			data: { userId: "owner-cursor", nextSourceCursor: "cursor-old" },
		});
		const claim = await acquireHistoryCollectionLease(prisma, "owner-cursor", {
			dialect: "sqlite",
		});
		expect(claim?.nextSourceCursor).toBe("cursor-old");
	});

	it("does not invoke the callback when the initial authority fence fails", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-fence");
		const action = async () => {
			throw new Error("callback must not run");
		};
		const result = await withHistoryCollectionLeaseAuthority(
			prisma,
			{ userId: "owner-fence", claimToken: "missing-token" },
			action,
			{ dialect: "sqlite" },
		);
		expect(result).toEqual({ matched: false });
	});

	it("rolls back callback writes when the final fence loses the token", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-final-fence");
		const claim = await acquireHistoryCollectionLease(prisma, "owner-final-fence", {
			dialect: "sqlite",
		});
		if (!claim) throw new Error("expected claim");
		const before = await readLease(prisma, "owner-final-fence");
		await expect(
			withHistoryCollectionLeaseAuthority(
				prisma,
				claim,
				async (tx) => {
					await tx.$executeRawUnsafe(
						"UPDATE history_collection_leases SET claimToken = ? WHERE userId = ?",
						"replacement",
						"owner-final-fence",
					);
					await tx.$executeRawUnsafe(
						"UPDATE User SET username = ? WHERE id = ?",
						"callback-write",
						"owner-final-fence",
					);
					return "value";
				},
				{ dialect: "sqlite", nextSourceCursor: "callback-cursor" },
			),
		).resolves.toEqual({ matched: false });
		expect(await readLease(prisma, "owner-final-fence")).toEqual(before);
		expect(
			(
				await prisma.user.findUnique({
					where: { id: "owner-final-fence" },
					select: { username: true },
				})
			)?.username,
		).toBe("owner-final-fence");
	});

	it("retries the complete callback only for retryable transaction errors", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-retry");
		const claim = await acquireHistoryCollectionLease(prisma, "owner-retry", { dialect: "sqlite" });
		if (!claim) throw new Error("expected claim");
		expect(
			await heartbeatHistoryCollectionLease(prisma, claim, "cursor-before", {
				dialect: "sqlite",
			}),
		).toBe(true);
		let attempts = 0;
		const result = await withHistoryCollectionLeaseAuthority(
			prisma,
			claim,
			async (tx) => {
				attempts += 1;
				await tx.$executeRawUnsafe(
					"UPDATE User SET username = ? WHERE id = ?",
					`attempt-${attempts}`,
					"owner-retry",
				);
				if (attempts === 1) throw { code: "P2034" };
				return "committed";
			},
			{ dialect: "sqlite", nextSourceCursor: undefined },
		);
		expect(result).toEqual({ matched: true, value: "committed" });
		expect(attempts).toBe(2);
		expect(
			(await prisma.user.findUnique({ where: { id: "owner-retry" }, select: { username: true } }))
				?.username,
		).toBe("attempt-2");
		expect(await readLease(prisma, "owner-retry")).toMatchObject({
			nextSourceCursor: "cursor-before",
		});
	});

	it("finds nested retry codes and rejects lookalike messages", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-nested-retry");
		const claim = await acquireHistoryCollectionLease(prisma, "owner-nested-retry", {
			dialect: "sqlite",
		});
		if (!claim) throw new Error("expected claim");
		let attempts = 0;
		await expect(
			withHistoryCollectionLeaseAuthority(
				prisma,
				claim,
				async () => {
					attempts += 1;
					if (attempts === 1) {
						throw { cause: { message: "transaction-write-conflict" } };
					}
					return "nested";
				},
				{ dialect: "sqlite" },
			),
		).resolves.toEqual({ matched: true, value: "nested" });
		expect(attempts).toBe(2);

		let lookalikeAttempts = 0;
		await expect(
			withHistoryCollectionLeaseAuthority(
				prisma,
				claim,
				async () => {
					lookalikeAttempts += 1;
					throw new Error("not a serialization failure");
				},
				{ dialect: "sqlite" },
			),
		).rejects.toThrow("History collection action failed");
		expect(lookalikeAttempts).toBe(1);
	});

	it("never converts exhausted or arbitrary transaction errors into success", async () => {
		const { prisma } = await createDatabase();
		await createUser(prisma, "owner-errors");
		const claim = await acquireHistoryCollectionLease(prisma, "owner-errors", {
			dialect: "sqlite",
		});
		if (!claim) throw new Error("expected claim");
		let exhaustedAttempts = 0;
		await expect(
			withHistoryCollectionLeaseAuthority(
				prisma,
				claim,
				async () => {
					exhaustedAttempts += 1;
					throw { code: "P2034" };
				},
				{ dialect: "sqlite" },
			),
		).rejects.toMatchObject({ code: "P2034" });
		expect(exhaustedAttempts).toBe(3);
		await expect(
			withHistoryCollectionLeaseAuthority(
				prisma,
				claim,
				async () => {
					throw new Error("arbitrary failure");
				},
				{ dialect: "sqlite" },
			),
		).rejects.toThrow("History collection action failed");
	});

	it("does not expose rejected values or raw database errors", async () => {
		const { prisma } = await createDatabase();
		const userId = "owner-private";
		const token = "x".repeat(HISTORY_COLLECTION_LEASE_TOKEN_MAX_BYTES + 1);
		await expect(
			acquireHistoryCollectionLease(prisma, "\u0000private", { dialect: "sqlite" }),
		).resolves.toBeNull();
		await expect(
			heartbeatHistoryCollectionLease(prisma, { userId, claimToken: token }, null, {
				dialect: "sqlite",
			}),
		).resolves.toBe(false);
		const raw = `${userId} ${token} cursor-private raw database value`;
		const failingPrisma = {
			$executeRawUnsafe: async () => {
				throw Object.assign(new Error(raw), { code: raw });
			},
		} as unknown as PrismaClient;
		await expect(
			heartbeatHistoryCollectionLease(failingPrisma, { userId, claimToken: "safe-token" }, null, {
				dialect: "sqlite",
			}),
		).rejects.toThrow("History collection lease database operation failed");
		await expect(
			heartbeatHistoryCollectionLease(failingPrisma, { userId, claimToken: "safe-token" }, null, {
				dialect: "sqlite",
			}),
		).rejects.not.toThrow(raw);
		await expect(
			heartbeatHistoryCollectionLease(failingPrisma, { userId, claimToken: "safe-token" }, null, {
				dialect: "sqlite",
			}),
		).rejects.not.toHaveProperty("code");
		await createUser(prisma, "owner-private-transaction");
		const transactionClaim = await acquireHistoryCollectionLease(
			prisma,
			"owner-private-transaction",
			{ dialect: "sqlite" },
		);
		if (!transactionClaim) throw new Error("expected claim");
		const failingTransaction = withTransactionFailures(prisma, [new Error(raw)]);
		await expect(
			withHistoryCollectionLeaseAuthority(
				failingTransaction,
				transactionClaim,
				async () => "unreachable",
				{
					dialect: "sqlite",
				},
			),
		).rejects.toThrow("History collection lease database operation failed");
		await expect(
			withHistoryCollectionLeaseAuthority(
				prisma,
				transactionClaim,
				async () => {
					throw Object.assign(new Error(raw), { code: raw });
				},
				{ dialect: "sqlite" },
			),
		).rejects.toHaveProperty("code", undefined);
	});
});

const postgresUrl = process.env.HISTORY_LEASE_POSTGRES_URL ?? "";
const postgresDescribe = isGuardedPostgresUrl(postgresUrl) ? describe : describe.skip;

postgresDescribe("guarded disposable PostgreSQL History lease", () => {
	it("excludes a concurrent first claim and rejects a stale token", async () => {
		const { clients, prisma } = await createPostgresDatabase(2);
		const userId = `pg-owner-first-${randomUUID()}`;
		postgresUsers.push({ prisma, userId });
		await prisma.user.create({
			data: { id: userId, username: userId, hashedPassword: "synthetic" },
		});
		const claims = await Promise.all(
			clients.map(
				async (client) =>
					await acquireHistoryCollectionLease(client, userId, { dialect: "postgresql" }),
			),
		);
		expect(claims.filter(Boolean)).toHaveLength(1);
		const winner = claims.find((claim) => claim);
		if (!winner) throw new Error("expected PostgreSQL claim");
		expect(
			await heartbeatHistoryCollectionLease(prisma, { ...winner, claimToken: "stale" }, null, {
				dialect: "postgresql",
			}),
		).toBe(false);
	});

	it("rolls back a callback write when PostgreSQL final CAS is lost", async () => {
		const { prisma } = await createPostgresDatabase();
		const userId = `pg-owner-fence-${randomUUID()}`;
		postgresUsers.push({ prisma, userId });
		await prisma.user.create({
			data: { id: userId, username: userId, hashedPassword: "synthetic" },
		});
		const claim = await acquireHistoryCollectionLease(prisma, userId, { dialect: "postgresql" });
		if (!claim) throw new Error("expected PostgreSQL claim");
		await expect(
			withHistoryCollectionLeaseAuthority(
				prisma,
				claim,
				async (tx) => {
					await tx.$executeRawUnsafe(
						'UPDATE "history_collection_leases" SET "claimToken" = $1 WHERE "userId" = $2',
						"replacement",
						userId,
					);
					await tx.$executeRawUnsafe(
						'UPDATE "User" SET username = $1 WHERE id = $2',
						"callback-write",
						userId,
					);
				},
				{ dialect: "postgresql", nextSourceCursor: "pg-cursor" },
			),
		).resolves.toEqual({ matched: false });
		expect(
			(await prisma.user.findUnique({ where: { id: userId }, select: { username: true } }))
				?.username,
		).toBe(userId);
	});
});

async function createDatabase(
	clientCount = 1,
): Promise<{ clients: PrismaClient[]; prisma: PrismaClient }> {
	const directory = mkdtempSync(join(tmpdir(), "history-lease-"));
	const databasePath = join(directory, "history.db");
	execFileSync("pnpm", ["exec", "prisma", "db", "push", "--schema", "prisma/schema.prisma"], {
		cwd: process.cwd(),
		env: { ...process.env, DATABASE_URL: `file:${databasePath}` },
		stdio: "pipe",
	});
	const clients = Array.from(
		{ length: clientCount },
		() =>
			new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: databasePath, timeout: 5_000 }) }),
	);
	await Promise.all(clients.map(async (client) => await client.$connect()));
	databases.push({ clients, directory });
	return { clients, prisma: clients[0]! };
}

function withTransactionFailures(prisma: PrismaClient, failures: unknown[]): PrismaClient {
	let index = 0;
	return {
		$transaction: async (
			action: (tx: Prisma.TransactionClient) => Promise<unknown>,
			options: { isolationLevel: "Serializable"; timeout: number },
		) => {
			if (index < failures.length) throw failures[index++];
			return await prisma.$transaction(action, options);
		},
	} as unknown as PrismaClient;
}

async function createPostgresDatabase(
	clientCount = 1,
): Promise<{ clients: PrismaClient[]; prisma: PrismaClient }> {
	const clients = await Promise.all(
		Array.from({ length: clientCount }, async () => await createTestPgClient(postgresUrl)),
	);
	postgresCleanups.push(async () => {
		await Promise.all(clients.map(async ({ cleanup }) => await cleanup()));
	});
	return { clients: clients.map(({ prisma }) => prisma), prisma: clients[0]!.prisma };
}

function isGuardedPostgresUrl(value: string): boolean {
	if (!/^postgres(?:ql)?:\/\//i.test(value)) return false;
	try {
		return new URL(value).pathname === "/history_lease_test";
	} catch {
		return false;
	}
}

async function createUser(prisma: PrismaClient, id: string): Promise<void> {
	await prisma.user.create({ data: { id, username: id, hashedPassword: "synthetic" } });
}

async function countRows(prisma: PrismaClient, userId: string): Promise<number> {
	const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
		"SELECT COUNT(*) AS count FROM history_collection_leases WHERE userId = ?",
		userId,
	);
	return Number(rows[0]?.count ?? 0);
}

async function readLease(prisma: PrismaClient, userId: string): Promise<Record<string, unknown>> {
	const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
		`SELECT claimToken, claimedAt, heartbeatAt, expiresAt, lastAttemptAt,
			lastAttemptResult, lastAttemptReason, nextSourceCursor, updatedAt
		 FROM history_collection_leases WHERE userId = ?`,
		userId,
	);
	return rows[0] ?? {};
}
