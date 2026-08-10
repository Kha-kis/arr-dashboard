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

		expect(deleteMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({
					syncHistory: { none: expect.objectContaining({ rolledBack: false }) },
					deploymentHistory: { none: expect.objectContaining({ rolledBack: false }) },
				}),
			}),
		);
	});
});
