import type { ManualImportServiceType, ManualImportSubmissionFile } from "@arr/shared";
import { describe, expect, it } from "vitest";
import { buildVerifiedImportSelection } from "../../lib/arr/import-operations/selection.js";
import {
	autoImportByDownloadIdWithSdk,
	collectAutoManualImportFiles,
	fetchManualImportCandidatesWithSdk,
	submitManualImportCommandWithSdk,
} from "../manual-import-utils.js";

const base = {
	id: 1,
	path: "/synthetic/file",
	downloadId: "source",
	quality: { quality: { id: 1 } },
};
const cases = [
	{
		service: "lidarr" as const,
		raw: {
			...base,
			artist: { id: 11 },
			album: { id: 12 },
			albumReleaseId: 13,
			tracks: [{ id: 15 }, { id: 14 }],
		},
		requested: { path: base.path, downloadId: "source", artistId: 11, albumId: 12 },
		want: { artistId: 11, albumId: 12, albumReleaseId: 13, trackIds: [14, 15] },
	},
	{
		service: "readarr" as const,
		raw: { ...base, author: { id: 21 }, book: { id: 22 }, foreignEditionId: "edition-1" },
		requested: { path: base.path, downloadId: "source", authorId: 21, bookId: 22 },
		want: { authorId: 21, bookId: 22, foreignEditionId: "edition-1" },
	},
];
function fixture(rows: unknown[]) {
	const sent: unknown[] = [];
	const client = {
		get: async () => rows,
		post: async (path: string, body: unknown) => {
			sent.push({ path, body });
			return { id: 51, name: "ManualImport", status: "queued", body };
		},
	} as unknown as Parameters<typeof fetchManualImportCandidatesWithSdk>[0];
	return { client, sent };
}
describe("raw provider mapping through exact dispatch", () => {
	it.each(cases)(
		"preserves $service mappings from fresh raw candidates",
		async ({ service, raw, requested, want }) => {
			const f = fixture([raw]);
			const candidates = await fetchManualImportCandidatesWithSdk(f.client, service, {});
			const selection = buildVerifiedImportSelection(service, [requested], candidates);
			await submitManualImportCommandWithSdk(f.client, service, selection.files, "copy");
			expect(f.sent).toEqual([
				{
					path: "/api/v1/command",
					body: {
						name: "ManualImport",
						importMode: "Copy",
						files: [
							{
								path: base.path,
								folderName: "",
								downloadId: "source",
								quality: { quality: { id: 1 } },
								languages: [],
								releaseGroup: undefined,
								indexerFlags: 0,
								...want,
							},
						],
					},
				},
			]);
			expect(selection.identities[0]?.identity).toMatchObject(want);
			const automatic = collectAutoManualImportFiles(service, candidates, "source");
			expect(automatic.files[0]).toMatchObject(want);
		},
	);
	it.each(cases)(
		"rejects contradictory client $service mapping before POST",
		async ({ service, raw, requested }) => {
			const f = fixture([raw]);
			const candidates = await fetchManualImportCandidatesWithSdk(f.client, service, {});
			const conflicts =
				service === "lidarr"
					? [
							{ trackIds: [14] },
							{ trackIds: [15, 15] },
							{ albumReleaseId: 99 },
							{ foreignEditionId: "edition-1" },
						]
					: [{ foreignEditionId: "edition-2" }, { trackIds: [14] }, { albumReleaseId: 13 }];
			for (const conflict of conflicts) {
				expect(() =>
					buildVerifiedImportSelection(service, [{ ...requested, ...conflict }], candidates),
				).toThrow();
			}
			expect(f.sent).toEqual([]);
		},
	);
	it.each([
		{ service: "lidarr", fields: { tracks: undefined } },
		{ service: "lidarr", fields: { tracks: [] } },
		{ service: "lidarr", fields: { tracks: [{ id: 0 }] } },
		{ service: "lidarr", fields: { tracks: [{ id: 1.5 }] } },
		{ service: "lidarr", fields: { tracks: [{ id: Number.MAX_SAFE_INTEGER + 1 }] } },
		{ service: "lidarr", fields: { tracks: [{ id: 14 }, { id: 14 }] } },
		{ service: "lidarr", fields: { tracks: [{ id: "14" }] } },
		{ service: "lidarr", fields: { albumReleaseId: undefined } },
		{ service: "lidarr", fields: { albumReleaseId: 0 } },
		{ service: "lidarr", fields: { albumReleaseId: 1.5 } },
		{ service: "lidarr", fields: { albumReleaseId: Number.MAX_SAFE_INTEGER + 1 } },
		{ service: "readarr", fields: { foreignEditionId: undefined } },
		{ service: "readarr", fields: { foreignEditionId: "" } },
		{ service: "readarr", fields: { foreignEditionId: " edition" } },
		{ service: "readarr", fields: { foreignEditionId: "x".repeat(1025) } },
	])(
		"rejects missing or invalid $service mapping without dispatch %#",
		async ({ service, fields }) => {
			const item = cases.find((item) => item.service === service)!;
			const f = fixture([{ ...item.raw, ...fields }]);
			await expect(
				autoImportByDownloadIdWithSdk(f.client, service as ManualImportServiceType, "source"),
			).rejects.toBeDefined();
			expect(f.sent).toEqual([]);
		},
	);
	it("rejects the whole raw list when a track mapping is malformed", async () => {
		const f = fixture([
			cases[0]!.raw,
			{ ...cases[0]!.raw, path: "/synthetic/second", tracks: [{ id: 0 }] },
		]);
		await expect(fetchManualImportCandidatesWithSdk(f.client, "lidarr", {})).rejects.toMatchObject({
			statusCode: 502,
		});
		expect(f.sent).toEqual([]);
	});
	it.each(cases)(
		"never automatically dispatches a healthy $service subset with an unmapped row",
		async ({ service, raw }) => {
			const unmapped = {
				...raw,
				path: "/synthetic/second",
				tracks: undefined,
				foreignEditionId: undefined,
			};
			const f = fixture([raw, unmapped]);
			await expect(
				autoImportByDownloadIdWithSdk(f.client, service, "source"),
			).rejects.toBeDefined();
			expect(f.sent).toEqual([]);
		},
	);
	it.each([
		{ service: "lidarr", file: { artistId: 11, albumId: 12 } },
		{ service: "lidarr", file: { artistId: 11, albumId: 12, albumReleaseId: 0, trackIds: [14] } },
		{
			service: "lidarr",
			file: { artistId: 11, albumId: 12, albumReleaseId: 13, trackIds: [14, 14] },
		},
		{ service: "readarr", file: { authorId: 21, bookId: 22 } },
	])("refuses incomplete direct $service commands before POST %#", async ({ service, file }) => {
		const f = fixture([]);
		await expect(
			submitManualImportCommandWithSdk(
				f.client,
				service as ManualImportServiceType,
				[{ path: base.path, downloadId: "source", ...file } as ManualImportSubmissionFile],
				"auto",
			),
		).rejects.toBeDefined();
		expect(f.sent).toEqual([]);
	});
});
