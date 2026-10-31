import { describe, expect, it } from "vitest";
import { manualImportCandidateSchema, manualImportSubmissionFileSchema } from "../manual-import.js";

const base = { id: 1, path: "/synthetic/file", downloadId: "source" };
describe("provider-selected import mapping", () => {
	it("retains Lidarr's exact positive tracks", () => {
		expect(
			manualImportCandidateSchema.parse({
				...base,
				service: "lidarr",
				tracks: [{ id: 31 }, { id: 32 }],
				albumReleaseId: 30,
			}),
		).toMatchObject({ tracks: [{ id: 31 }, { id: 32 }], albumReleaseId: 30 });
	});
	it("retains Readarr's exact edition in candidates and submission", () => {
		expect(
			manualImportCandidateSchema.parse({
				...base,
				service: "readarr",
				foreignEditionId: "edition-1",
			}),
		).toHaveProperty("foreignEditionId", "edition-1");
		expect(
			manualImportSubmissionFileSchema.parse({
				path: base.path,
				downloadId: base.downloadId,
				foreignEditionId: "edition-1",
			}),
		).toHaveProperty("foreignEditionId", "edition-1");
	});
	it.each(
		[
			[],
			[{ id: 0 }],
			[{ id: -1 }],
			[{ id: 1.5 }],
			[{ id: Number.MAX_SAFE_INTEGER + 1 }],
			[{ id: 31 }, { id: 31 }],
			Array.from({ length: 1001 }, (_, id) => ({ id: id + 1 })),
		].map((tracks) => ({ tracks })),
	)("rejects invalid or duplicate provider tracks %#", ({ tracks }) => {
		expect(
			manualImportCandidateSchema.safeParse({ ...base, service: "lidarr", tracks }).success,
		).toBe(false);
	});
	it.each(["", " edition", "edition ", "x".repeat(1025), null, 1])(
		"rejects invalid provider edition %#",
		(foreignEditionId) => {
			expect(
				manualImportCandidateSchema.safeParse({ ...base, service: "readarr", foreignEditionId })
					.success,
			).toBe(false);
		},
	);
});
