import { describe, expect, it, vi } from "vitest";
import { TrashCacheManager } from "../cache-manager.js";

describe("TrashCacheManager snapshots", () => {
	it("returns payload and provenance from the same cache row", async () => {
		const findUnique = vi.fn().mockResolvedValue({
			data: JSON.stringify([{ trash_id: "cf-1", name: "Test" }]),
			commitHash: "verified:v1:TRaSH-Guides%2FGuides:0123456789abcdef0123456789abcdef01234567",
		});
		const updateMany = vi.fn().mockResolvedValue({ count: 1 });
		const manager = new TrashCacheManager(
			{
				trashCache: {
					findUnique,
					updateMany,
				},
			} as never,
			{ compressionEnabled: false },
		);

		const snapshot = await manager.getSnapshot("RADARR", "CUSTOM_FORMATS");

		expect(snapshot).toEqual({
			data: [{ trash_id: "cf-1", name: "Test" }],
			commitHash: "0123456789abcdef0123456789abcdef01234567",
			provenance: {
				version: 1,
				repository: "TRaSH-Guides/Guides",
				commitHash: "0123456789abcdef0123456789abcdef01234567",
			},
		});
		expect(findUnique).toHaveBeenCalledTimes(1);
		expect(updateMany).toHaveBeenCalledTimes(1);
	});

	it("does not trust a legacy plain commit hash after restart", async () => {
		const manager = new TrashCacheManager(
			{
				trashCache: {
					findUnique: vi.fn().mockResolvedValue({
						data: "[]",
						commitHash: "0123456789abcdef0123456789abcdef01234567",
					}),
					updateMany: vi.fn().mockResolvedValue({ count: 1 }),
				},
			} as never,
			{ compressionEnabled: false },
		);

		await expect(manager.getSnapshot("RADARR", "CUSTOM_FORMATS")).resolves.toEqual({
			data: [],
			commitHash: null,
			provenance: null,
		});
	});
});
