import { describe, expect, it, vi } from "vitest";
import { retireLegacyInodeCorrelations } from "../inode-correlation-upgrade.js";

describe("retireLegacyInodeCorrelations", () => {
	it("atomically removes only unversioned inode-derived hashes and state", async () => {
		const libraryUpdate = vi.fn().mockResolvedValue({ count: 7 });
		const episodeUpdate = vi.fn().mockResolvedValue({ count: 23 });
		const tx = {
			libraryCache: { updateMany: libraryUpdate },
			episodeFileCache: { updateMany: episodeUpdate },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		};

		await expect(retireLegacyInodeCorrelations(prisma as never)).resolves.toEqual({
			libraryRows: 7,
			episodeRows: 23,
		});
		expect(prisma.$transaction).toHaveBeenCalledOnce();
		for (const update of [libraryUpdate, episodeUpdate]) {
			expect(update).toHaveBeenCalledWith({
				where: { infoHashSource: "inode" },
				data: {
					infoHash: null,
					infoHashSource: null,
					torrentState: null,
					torrentRatio: null,
					torrentSyncedAt: null,
				},
			});
		}
	});

	it("propagates a failed update so startup cannot serve stale verification", async () => {
		const tx = {
			libraryCache: { updateMany: vi.fn().mockResolvedValue({ count: 7 }) },
			episodeFileCache: { updateMany: vi.fn().mockRejectedValue(new Error("database busy")) },
		};
		const prisma = {
			$transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<unknown>) =>
				callback(tx),
			),
		};
		await expect(retireLegacyInodeCorrelations(prisma as never)).rejects.toThrow("database busy");
	});
});
