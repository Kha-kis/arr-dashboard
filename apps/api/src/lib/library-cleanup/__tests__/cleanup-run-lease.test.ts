import { describe, expect, it, vi } from "vitest";
import { Prisma } from "../../prisma.js";
import {
	acquireCleanupRunLease,
	CleanupPolicyMutationConflictError,
	CleanupRunLeaseLostError,
	CleanupTopologyMutationConflictError,
	releaseCleanupRunLease,
	renewCleanupRunLease,
	withCleanupPolicyMutationLease,
	withCleanupTopologyMutationLease,
	withRenewableCleanupTopologyMutationLease,
} from "../cleanup-executor.js";
import type { CleanupExecutorDeps } from "../types.js";

function missingLeaseError() {
	return new Prisma.PrismaClientKnownRequestError("Synthetic missing lease", {
		code: "P2025",
		clientVersion: "test",
	});
}

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
		const update = vi.fn(async (query: Parameters<typeof updateMany>[0]) => {
			if ((await updateMany(query)).count !== 1) throw missingLeaseError();
			return { id: "config-1" };
		});
		const prisma = {
			libraryCleanupConfig: { updateMany, update },
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

	it("propagates an uncertain release without trying another write", async () => {
		const error = new Prisma.PrismaClientKnownRequestError("Synthetic release timeout", {
			code: "P1008",
			clientVersion: "test",
		});
		const update = vi.fn().mockRejectedValue(error);
		const prisma = { libraryCleanupConfig: { update } } as unknown as CleanupExecutorDeps["prisma"];

		await expect(releaseCleanupRunLease(prisma, "user-1", "config-1", "owner-1")).rejects.toBe(
			error,
		);
		expect(update).toHaveBeenCalledOnce();
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
		const updateMany = vi.fn(async () => {
			calls.push("acquire");
			return { count: 1 };
		});
		const prisma = {
			libraryCleanupConfig: {
				findUnique: vi.fn(async () => {
					calls.push("find");
					return null;
				}),
				create: vi.fn(async () => {
					calls.push("create");
					return { id: "config-1" };
				}),
				updateMany,
				update: vi.fn(async () => {
					calls.push("release");
					return { id: "config-1" };
				}),
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
		expect(calls).toEqual(["find", "create", "acquire", "mutate", "release"]);
	});

	it.each([
		{ code: "P2002", existing: { id: "concurrent-config" }, recovered: true, reads: 2 },
		{ code: "P2002", existing: null, recovered: false, reads: 2 },
		{ code: "P1008", existing: { id: "uncertain-config" }, recovered: false, reads: 1 },
	])(
		"admits only a confirmed concurrent config after $code (readback $reads)",
		async ({ code, existing, recovered, reads }) => {
			const error = new Prisma.PrismaClientKnownRequestError("Synthetic config creation failure", {
				code,
				clientVersion: "test",
			});
			const config = {
				findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(existing),
				create: vi.fn().mockRejectedValue(error),
				update: vi.fn().mockResolvedValue({ id: "concurrent-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			};
			const prisma = { libraryCleanupConfig: config } as unknown as CleanupExecutorDeps["prisma"];
			const log = { warn: vi.fn(), error: vi.fn() } as unknown as CleanupExecutorDeps["log"];
			const mutate = vi.fn(async () => "admitted");
			const admission = withCleanupTopologyMutationLease({ prisma, log }, "user-1", mutate);
			if (recovered) {
				await expect(admission).resolves.toBe("admitted");
				expect(config.updateMany).toHaveBeenCalledWith(
					expect.objectContaining({
						where: expect.objectContaining({ id: existing?.id, userId: "user-1" }),
					}),
				);
				expect(mutate).toHaveBeenCalledOnce();
			} else {
				await expect(admission).rejects.toBe(error);
				expect(config.updateMany).not.toHaveBeenCalled();
				expect(mutate).not.toHaveBeenCalled();
			}
			expect(config.create).toHaveBeenCalledOnce();
			expect(config.findUnique).toHaveBeenCalledTimes(reads);
			expect(config.findUnique).toHaveBeenLastCalledWith({
				where: { userId: "user-1" },
				select: { id: true },
			});
		},
	);

	it("refuses mutation when the config found by lookup cannot be claimed", async () => {
		const create = vi.fn();
		const updateMany = vi.fn().mockResolvedValue({ count: 0 });
		const prisma = {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "disappeared-config" }),
				create,
				updateMany,
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const log = { warn: vi.fn(), error: vi.fn() } as unknown as CleanupExecutorDeps["log"];
		const mutate = vi.fn();

		await expect(
			withCleanupTopologyMutationLease({ prisma, log }, "user-1", mutate),
		).rejects.toBeInstanceOf(CleanupTopologyMutationConflictError);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "disappeared-config", userId: "user-1" }),
			}),
		);
		expect(create).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
	});

	it("keeps bounded topology callbacks separate from renewable lease authority", async () => {
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const create = vi.fn();
		const update = vi.fn().mockResolvedValue({ id: "config-1" });
		const prisma = {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				create,
				updateMany,
				update,
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const log = { warn: vi.fn(), error: vi.fn() } as unknown as CleanupExecutorDeps["log"];
		const mutate = vi.fn(async (...args: unknown[]) => args.length);

		await expect(withCleanupTopologyMutationLease({ prisma, log }, "user-1", mutate)).resolves.toBe(
			0,
		);
		expect(mutate).toHaveBeenCalledWith();
		expect(create).not.toHaveBeenCalled();
		const token = updateMany.mock.calls[0]?.[0]?.data.runClaimToken;
		expect(token).toEqual(expect.any(String));
		expect(update).toHaveBeenCalledExactlyOnceWith({
			where: { id: "config-1", userId: "user-1", runClaimToken: token },
			data: { runClaimToken: null, runClaimedAt: null },
			select: { id: true },
		});
	});

	it("renews an explicit recovery topology lease through the ownership assertion", async () => {
		const calls: string[] = [];
		const updateMany = vi.fn(async ({ data }: { data: { runClaimToken?: string | null } }) => {
			calls.push(typeof data.runClaimToken === "string" ? "acquire" : "renew");
			return { count: 1 };
		});
		const prisma = {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				create: vi.fn(async () => ({ id: "config-1" })),
				updateMany,
				update: vi.fn(async () => {
					calls.push("release");
					return { id: "config-1" };
				}),
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const log = { warn: vi.fn(), error: vi.fn() } as unknown as CleanupExecutorDeps["log"];

		await withRenewableCleanupTopologyMutationLease({ prisma, log }, "user-1", async (runLease) => {
			await runLease.assertOwnership();
		});

		expect(calls).toEqual(["acquire", "renew", "release"]);
	});

	it("fails closed when an explicit recovery callback loses lease ownership", async () => {
		const updateMany = vi
			.fn()
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		const prisma = {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				create: vi.fn(async () => ({ id: "config-1" })),
				updateMany,
				update: vi.fn().mockRejectedValue(missingLeaseError()),
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const log = { warn: vi.fn(), error: vi.fn() } as unknown as CleanupExecutorDeps["log"];

		await expect(
			withRenewableCleanupTopologyMutationLease({ prisma, log }, "user-1", async (runLease) => {
				await runLease.assertOwnership();
			}),
		).rejects.toBeInstanceOf(CleanupRunLeaseLostError);
	});

	it("rejects a service topology mutation while cleanup owns the lease", async () => {
		const mutate = vi.fn();
		const prisma = {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				create: vi.fn().mockResolvedValue({ id: "config-1" }),
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
		const update = vi.fn().mockResolvedValue({ id: "config-1" });
		const prisma = {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				create: vi.fn().mockResolvedValue({ id: "config-1" }),
				updateMany,
				update,
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
		expect(updateMany).toHaveBeenCalledOnce();
		expect(update).toHaveBeenCalledExactlyOnceWith({
			where: { id: "config-1", userId: "user-1", runClaimToken: expect.any(String) },
			data: { runClaimToken: null, runClaimedAt: null },
			select: { id: true },
		});
	});

	it("rejects cleanup policy writes while a run owns the existing config lease", async () => {
		const mutate = vi.fn();
		const prisma = {
			libraryCleanupConfig: {
				findUnique: vi.fn().mockResolvedValue({ id: "config-1" }),
				create: vi.fn(),
				updateMany: vi.fn().mockResolvedValue({ count: 0 }),
			},
		} as unknown as CleanupExecutorDeps["prisma"];
		const log = {
			warn: vi.fn(),
			error: vi.fn(),
		} as unknown as CleanupExecutorDeps["log"];

		await expect(
			withCleanupPolicyMutationLease({ prisma, log }, "user-1", mutate, {
				configId: "config-1",
			}),
		).rejects.toBeInstanceOf(CleanupPolicyMutationConflictError);
		expect(prisma.libraryCleanupConfig.create).not.toHaveBeenCalled();
		expect(mutate).not.toHaveBeenCalled();
	});
});
