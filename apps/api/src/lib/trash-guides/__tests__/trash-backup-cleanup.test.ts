import { describe, expect, it, vi } from "vitest";
import { TrashBackupCleanupService } from "../trash-backup-cleanup.js";

describe("TrashBackupCleanupService", () => {
	it("excludes snapshots referenced by nonterminal recovery work from expiry cleanup", async () => {
		const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
		const service = new TrashBackupCleanupService(
			{
				trashBackup: {
					deleteMany,
					findMany: vi.fn().mockResolvedValue([]),
				},
			} as never,
			{ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
		);

		await service.runCleanup();

		const expiryWhere = deleteMany.mock.calls[0]?.[0]?.where;
		expect(expiryWhere.syncHistory).toEqual({
			none: {
				rolledBack: false,
				OR: [
					{
						rollbackStatus: { not: null },
						NOT: { rollbackStatus: "COMPLETED" },
					},
					{ status: { in: ["IN_PROGRESS", "RUNNING"] } },
				],
			},
		});
		expect(expiryWhere.deploymentHistory).toEqual({
			none: {
				rolledBack: false,
				OR: [
					{
						undeployStatus: { not: null },
						NOT: { undeployStatus: "COMPLETED" },
					},
					{ status: "PARTIAL_UNDEPLOY", undeployStatus: null },
					{ status: "IN_PROGRESS" },
				],
			},
		});
	});
});
