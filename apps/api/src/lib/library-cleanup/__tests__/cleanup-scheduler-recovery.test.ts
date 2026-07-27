import { afterEach, describe, expect, it, vi } from "vitest";
import { CleanupScheduler } from "../cleanup-scheduler.js";

describe("library cleanup scheduler recovery", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("recovers stale execution rows only when their config has no active run lease", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-27T15:00:00.000Z"));

		const rows = [
			{
				id: "active",
				status: "executing",
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: {
					runClaimToken: "live-owner",
					runClaimedAt: new Date("2026-07-27T14:59:00.000Z"),
				},
			},
			{
				id: "unleased",
				status: "executing",
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: { runClaimToken: null, runClaimedAt: null },
			},
			{
				id: "stale-lease",
				status: "retry_executing",
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: {
					runClaimToken: "crashed-owner",
					runClaimedAt: new Date("2026-07-27T12:00:00.000Z"),
				},
			},
			{
				id: "approved-after-crash",
				status: "approved",
				reviewedAt: new Date("2026-07-27T13:00:00.000Z"),
				config: { runClaimToken: null, runClaimedAt: null },
			},
		];
		const approvalUpdateMany = vi.fn(
			async ({
				where,
				data,
			}: {
				where: {
					status: string;
					reviewedAt?: { lt: Date };
					config?: { OR: Array<{ runClaimedAt?: null | { lt: Date }; runClaimToken?: null }> };
				};
				data: { status: string; executionToken?: null; lastExecutionError?: string };
			}) => {
				let count = 0;
				const staleLeaseBefore = where.config?.OR.find(
					(condition) => condition.runClaimedAt && typeof condition.runClaimedAt === "object",
				)?.runClaimedAt as { lt: Date } | undefined;
				for (const row of rows) {
					if (row.status !== where.status) continue;
					if (where.reviewedAt && row.reviewedAt >= where.reviewedAt.lt) continue;
					if (where.config) {
						const leaseIsRecoverable =
							row.config.runClaimToken === null ||
							row.config.runClaimedAt === null ||
							(staleLeaseBefore !== undefined && row.config.runClaimedAt < staleLeaseBefore.lt);
						if (!leaseIsRecoverable) continue;
					}
					Object.assign(row, data);
					count++;
				}
				return { count };
			},
		);
		const prisma = {
			libraryCleanupApproval: { updateMany: approvalUpdateMany },
			libraryCleanupConfig: { findFirst: vi.fn().mockResolvedValue(null) },
		};
		const log = {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		};
		const scheduler = new CleanupScheduler(prisma as never, {} as never, {} as never, log as never);

		await (
			scheduler as unknown as {
				checkAndRun: () => Promise<void>;
			}
		).checkAndRun();

		expect(rows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "active", status: "executing" }),
				expect.objectContaining({ id: "unleased", status: "pending" }),
				expect.objectContaining({ id: "stale-lease", status: "retry_pending" }),
				expect.objectContaining({ id: "approved-after-crash", status: "pending" }),
			]),
		);
		expect(
			approvalUpdateMany.mock.calls.find(([args]) => args.where.status === "executing")?.[0].where
				.config,
		).toBeDefined();
	});
});
