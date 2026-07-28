import { describe, expect, it, vi } from "vitest";
import {
	acquireCleanupRunLease,
	CleanupTopologyMutationConflictError,
	releaseCleanupRunLease,
	renewCleanupRunLease,
	withCleanupTopologyMutationLease,
} from "../cleanup-executor.js";
import type { CleanupExecutorDeps } from "../types.js";

describe("library cleanup database run lease", () => {
	it("allows only one owner and requires the same token to release it", async () => {
		let storedToken: string | null = null;
		let claimedAt: Date | null = null;
		const updateMany = vi.fn(
			async ({
				where,
				data,
			}: {
				where: {
					runClaimToken?: string;
					OR?: Array<{ runClaimToken?: null; runClaimedAt?: null | { lt: Date } }>;
				};
				data: { runClaimToken: string | null; runClaimedAt: Date | null };
			}) => {
				if (where.OR) {
					const staleBefore = where.OR.find(
						(entry) => entry.runClaimedAt && typeof entry.runClaimedAt === "object",
					)?.runClaimedAt as { lt: Date } | undefined;
					if (storedToken && claimedAt && (!staleBefore || claimedAt >= staleBefore.lt)) {
						return { count: 0 };
					}
				} else if (where.runClaimToken !== storedToken) {
					return { count: 0 };
				}
				storedToken = data.runClaimToken;
				claimedAt = data.runClaimedAt;
				return { count: 1 };
			},
		);
		const prisma = {
			libraryCleanupConfig: { updateMany },
		} as unknown as CleanupExecutorDeps["prisma"];
		const now = new Date("2026-07-27T12:00:00.000Z");

		await expect(
			acquireCleanupRunLease(prisma, "user-1", "config-1", now, "owner-1"),
		).resolves.toBe("owner-1");
		await expect(
			acquireCleanupRunLease(prisma, "user-1", "config-1", now, "owner-2"),
		).resolves.toBeNull();
		await expect(releaseCleanupRunLease(prisma, "user-1", "config-1", "owner-2")).resolves.toBe(
			false,
		);
		await expect(releaseCleanupRunLease(prisma, "user-1", "config-1", "owner-1")).resolves.toBe(
			true,
		);
		await expect(
			acquireCleanupRunLease(prisma, "user-1", "config-1", now, "owner-2"),
		).resolves.toBe("owner-2");
	});

	it("reclaims a lease only after its timeout", async () => {
		let storedToken: string | null = "crashed-owner";
		let claimedAt: Date | null = new Date("2026-07-27T09:00:00.000Z");
		const updateMany = vi.fn(
			async ({
				where,
				data,
			}: {
				where: { OR: Array<{ runClaimedAt?: null | { lt: Date } }> };
				data: { runClaimToken: string; runClaimedAt: Date };
			}) => {
				const staleBefore = where.OR.find(
					(entry) => entry.runClaimedAt && typeof entry.runClaimedAt === "object",
				)?.runClaimedAt as { lt: Date };
				if (storedToken && claimedAt && claimedAt >= staleBefore.lt) return { count: 0 };
				storedToken = data.runClaimToken;
				claimedAt = data.runClaimedAt;
				return { count: 1 };
			},
		);
		const prisma = {
			libraryCleanupConfig: { updateMany },
		} as unknown as CleanupExecutorDeps["prisma"];

		await expect(
			acquireCleanupRunLease(
				prisma,
				"user-1",
				"config-1",
				new Date("2026-07-27T12:00:00.000Z"),
				"recovery-owner",
			),
		).resolves.toBe("recovery-owner");
	});

	it("keeps a long-running owner exclusive when its heartbeat renews the lease", async () => {
		let storedToken: string | null = null;
		let claimedAt: Date | null = null;
		const updateMany = vi.fn(
			async ({
				where,
				data,
			}: {
				where: {
					runClaimToken?: string;
					OR?: Array<{ runClaimedAt?: null | { lt: Date } }>;
				};
				data: { runClaimToken?: string; runClaimedAt: Date };
			}) => {
				if (where.OR) {
					const staleBefore = where.OR.find(
						(entry) => entry.runClaimedAt && typeof entry.runClaimedAt === "object",
					)?.runClaimedAt as { lt: Date };
					if (storedToken && claimedAt && claimedAt >= staleBefore.lt) return { count: 0 };
					storedToken = data.runClaimToken ?? storedToken;
				} else {
					if (where.runClaimToken !== storedToken) return { count: 0 };
				}
				claimedAt = data.runClaimedAt;
				return { count: 1 };
			},
		);
		const prisma = {
			libraryCleanupConfig: { updateMany },
		} as unknown as CleanupExecutorDeps["prisma"];

		await expect(
			acquireCleanupRunLease(
				prisma,
				"user-1",
				"config-1",
				new Date("2026-07-27T12:00:00.000Z"),
				"owner-1",
			),
		).resolves.toBe("owner-1");
		await expect(
			renewCleanupRunLease(
				prisma,
				"user-1",
				"config-1",
				"owner-1",
				new Date("2026-07-27T13:50:00.000Z"),
			),
		).resolves.toBe(true);
		await expect(
			acquireCleanupRunLease(
				prisma,
				"user-1",
				"config-1",
				new Date("2026-07-27T14:30:00.000Z"),
				"owner-2",
			),
		).resolves.toBeNull();
	});

	it("holds the cleanup lease across a service topology mutation", async () => {
		const calls: string[] = [];
		const updateMany = vi.fn(async ({ data }: { data: { runClaimToken: string | null } }) => {
			calls.push(data.runClaimToken === null ? "release" : "acquire");
			return { count: 1 };
		});
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn(async () => {
					calls.push("upsert");
					return { id: "config-1" };
				}),
				updateMany,
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const log = {
			warn: vi.fn(),
			error: vi.fn(),
		} as unknown as CleanupExecutorDeps["log"];

		await expect(
			withCleanupTopologyMutationLease({ prisma, log }, "user-1", async () => {
				calls.push("mutate");
				return "created";
			}),
		).resolves.toBe("created");
		expect(calls).toEqual(["upsert", "acquire", "mutate", "release"]);
	});

	it("rejects a service topology mutation while cleanup owns the lease", async () => {
		const mutate = vi.fn();
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "config-1" }),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const log = {
			warn: vi.fn(),
			error: vi.fn(),
		} as unknown as CleanupExecutorDeps["log"];

		await expect(
			withCleanupTopologyMutationLease({ prisma, log }, "user-1", mutate),
		).rejects.toBeInstanceOf(CleanupTopologyMutationConflictError);
		expect(mutate).not.toHaveBeenCalled();
	});

	it("releases the topology lease when the service mutation fails", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "config-1" }),
				updateMany,
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const log = {
			warn: vi.fn(),
			error: vi.fn(),
		} as unknown as CleanupExecutorDeps["log"];

		await expect(
			withCleanupTopologyMutationLease({ prisma, log }, "user-1", async () => {
				throw new Error("write failed");
			}),
		).rejects.toThrow("write failed");
		expect(updateMany).toHaveBeenCalledTimes(2);
		expect(updateMany.mock.calls[1]![0]).toMatchObject({
			where: { id: "config-1", userId: "user-1", runClaimToken: expect.any(String) },
			data: { runClaimToken: null, runClaimedAt: null },
		});
	});
});
