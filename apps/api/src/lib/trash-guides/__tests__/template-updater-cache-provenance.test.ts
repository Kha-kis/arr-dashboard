import { describe, expect, it, vi } from "vitest";
import { TemplateUpdater } from "../template-updater.js";

describe("TemplateUpdater cache provenance", () => {
	it("publishes cache entries only from the commit recorded with them", async () => {
		const commitHash = "0123456789abcdef0123456789abcdef01234567";
		const fetchConfigsAtCommit = vi.fn().mockResolvedValue([]);
		const fetchConfigs = vi.fn();
		const setVerified = vi.fn();
		const expectedProvenance = {
			version: 1 as const,
			repository: "trash-guides/guides",
			commitHash,
		};
		const updater = new TemplateUpdater(
			{} as never,
			{
				getLatestCommit: vi.fn().mockResolvedValue({ commitHash }),
			} as never,
			{
				getSnapshot: vi.fn().mockResolvedValue(null),
				getProvenance: vi.fn().mockResolvedValue({
					...expectedProvenance,
					commitHash: "old",
				}),
				setVerified,
			} as never,
			{
				getCommitProvenance: vi.fn().mockReturnValue(expectedProvenance),
				fetchConfigsAtCommit,
				fetchConfigs,
			} as never,
		);

		const result = await updater.refreshAllCaches("RADARR");

		expect(result).toMatchObject({ refreshed: 6, failed: 0, errors: [] });
		expect(fetchConfigsAtCommit).toHaveBeenCalledTimes(6);
		expect(fetchConfigsAtCommit).toHaveBeenCalledWith("RADARR", "CUSTOM_FORMATS", commitHash);
		expect(fetchConfigs).not.toHaveBeenCalled();
		expect(setVerified).toHaveBeenCalledTimes(6);
		for (const call of setVerified.mock.calls) {
			expect(call[3]).toEqual(expectedProvenance);
		}
	});
});
