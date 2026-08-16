import { describe, expect, it, vi } from "vitest";
import { computeTemplateDiff } from "../template-differ.js";

describe("template diff cache provenance", () => {
	it("refreshes and rereads all preview payloads when one snapshot is not at the target", async () => {
		const targetCommit = "0123456789abcdef0123456789abcdef01234567";
		const repository = "trash-guides/guides";
		const expectedProvenance = { version: 1 as const, repository, commitHash: targetCommit };
		let readRound = 0;
		const getSnapshot = vi.fn(async (_serviceType: string, configType: string) => {
			if (configType === "CUSTOM_FORMATS") readRound++;
			return {
				data: [],
				commitHash: configType === "QUALITY_PROFILES" && readRound === 1 ? "old" : targetCommit,
				provenance:
					configType === "QUALITY_PROFILES" && readRound === 1
						? { ...expectedProvenance, commitHash: "old" }
						: expectedProvenance,
			};
		});
		const setVerified = vi.fn();
		const fetchConfigsAtCommit = vi.fn().mockResolvedValue([]);

		const result = await computeTemplateDiff(
			{
				id: "template-1",
				name: "Template",
				serviceType: "RADARR",
				configData: JSON.stringify({ customFormats: [], customFormatGroups: [] }),
				trashGuidesCommitHash: "old",
				hasUserModifications: false,
				changeLog: null,
				sourceQualityProfileTrashId: null,
			},
			targetCommit,
			{ getSnapshot, setVerified } as never,
			{
				getCommitProvenance: vi.fn().mockReturnValue(expectedProvenance),
				fetchConfigsAtCommit,
			} as never,
		);

		expect(result.latestCommit).toBe(targetCommit);
		expect(getSnapshot).toHaveBeenCalledTimes(3);
		expect(fetchConfigsAtCommit).toHaveBeenCalledTimes(3);
		expect(setVerified).toHaveBeenCalledTimes(3);
	});
});
