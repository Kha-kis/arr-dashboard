import { describe, expect, it } from "vitest";
import { importCommandFingerprint } from "../../manual-import-command.js";
import {
	accumulatePositiveImportWitnesses,
	mergeCoveredImportWitnesses,
	verifiedImportWitnessFiles,
} from "../file-evidence.js";

const started = new Date("2026-10-01T00:00:00Z");
const ended = new Date("2026-10-01T00:02:00Z");
const compound = {
	path: "/synthetic/media",
	downloadId: "synthetic-source",
	seriesId: 12,
	episodeIds: [13, 14],
};
const event = (episodeId: number, fileId = 31) => ({
	eventType: "downloadFolderImported",
	downloadId: "synthetic-source",
	seriesId: 12,
	episodeId,
	date: "2026-10-01T00:01:00Z",
	data: { droppedPath: "/synthetic/media", fileId },
});

describe("sanitized positive import witnesses across History pages", () => {
	it("joins separately covered positive episode facts without interpreting absence as negative evidence", () => {
		const fingerprint = importCommandFingerprint([compound])!;
		const first = {
			witnesses: [{ fileFingerprint: fingerprint, fileId: 31, episodeIds: [13] }],
			ambiguousFiles: [],
		};
		const later = {
			witnesses: [{ fileFingerprint: fingerprint, fileId: 31, episodeIds: [14] }],
			ambiguousFiles: [],
		};
		const merged = mergeCoveredImportWitnesses("sonarr", [compound], started, ended, first, later);
		expect(merged).toEqual({
			witnesses: [{ fileFingerprint: fingerprint, fileId: 31, episodeIds: [13, 14] }],
			ambiguousFiles: [],
		});
		expect(
			mergeCoveredImportWitnesses("sonarr", [compound], started, ended, merged, {
				witnesses: [],
				ambiguousFiles: [],
			}),
		).toEqual(merged);
		expect(first.witnesses[0]!.episodeIds).toEqual([13]);
	});
	it("keeps covered conflicting file IDs ambiguous through later matching facts", () => {
		const fingerprint = importCommandFingerprint([compound])!;
		const first = {
			witnesses: [{ fileFingerprint: fingerprint, fileId: 31, episodeIds: [13] }],
			ambiguousFiles: [],
		};
		const conflict = mergeCoveredImportWitnesses("sonarr", [compound], started, ended, first, {
			witnesses: [{ fileFingerprint: fingerprint, fileId: 32, episodeIds: [14] }],
			ambiguousFiles: [],
		});
		expect(conflict).toEqual({ witnesses: [], ambiguousFiles: [fingerprint] });
		expect(
			mergeCoveredImportWitnesses("sonarr", [compound], started, ended, conflict, first),
		).toEqual(conflict);
	});
	it("rejects foreign covered witnesses instead of carrying them into owned history", () => {
		expect(() =>
			mergeCoveredImportWitnesses(
				"sonarr",
				[compound],
				started,
				ended,
				{ witnesses: [], ambiguousFiles: [] },
				{
					witnesses: [{ fileFingerprint: `v1:${"f".repeat(64)}`, fileId: 31, episodeIds: [13] }],
					ambiguousFiles: [],
				},
			),
		).toThrow(/Import file evidence/);
	});
	it("joins a compound Sonarr file across page slices without claiming a partial file", () => {
		const first = accumulatePositiveImportWitnesses(
			"sonarr",
			[compound],
			[event(13)],
			started,
			ended,
		);
		expect(verifiedImportWitnessFiles("sonarr", [compound], first)).toEqual([]);
		const second = accumulatePositiveImportWitnesses(
			"sonarr",
			[compound],
			[event(14)],
			started,
			ended,
			first,
		);
		expect(verifiedImportWitnessFiles("sonarr", [compound], second)).toEqual([
			importCommandFingerprint([compound]),
		]);
		expect(JSON.stringify(second)).not.toContain("/synthetic/media");
		expect(JSON.stringify(second)).not.toContain("synthetic-source");
		expect(second.witnesses).toMatchObject([{ fileId: 31, episodeIds: [13, 14] }]);
	});
	it("retains cross-page conflicting file IDs as ambiguous instead of choosing one", () => {
		const first = accumulatePositiveImportWitnesses(
			"sonarr",
			[compound],
			[event(13)],
			started,
			ended,
		);
		const conflict = accumulatePositiveImportWitnesses(
			"sonarr",
			[compound],
			[event(14, 32)],
			started,
			ended,
			first,
		);
		const repeat = accumulatePositiveImportWitnesses(
			"sonarr",
			[compound],
			[event(14)],
			started,
			ended,
			conflict,
		);
		expect(repeat.witnesses).toEqual([]);
		expect(repeat.ambiguousFiles).toEqual([importCommandFingerprint([compound])]);
		expect(verifiedImportWitnessFiles("sonarr", [compound], repeat)).toEqual([]);
	});
	it("does not attribute a later command's import to an earlier failed command", () => {
		const later = { ...event(13), date: "2026-10-01T00:03:00Z" };
		const result = accumulatePositiveImportWitnesses(
			"sonarr",
			[compound],
			[later, event(14)],
			started,
			ended,
		);
		expect(verifiedImportWitnessFiles("sonarr", [compound], result)).toEqual([]);
	});
	it.each([
		{ ...event(13), downloadId: "foreign-source" },
		{ ...event(13), seriesId: 99 },
		{ ...event(13), date: "invalid" },
		{ ...event(13), date: "2026-09-30T23:59:00Z" },
		{ ...event(13), eventType: "grabbed" },
		{ ...event(13), data: { droppedPath: "/foreign", fileId: 31 } },
		{ ...event(13), data: { droppedPath: "/synthetic/media", fileId: 0 } },
	])("does not widen source/media/time/event/path authority across pages", (wrong) => {
		const result = accumulatePositiveImportWitnesses(
			"sonarr",
			[compound],
			[wrong, event(14)],
			started,
			ended,
		);
		expect(verifiedImportWitnessFiles("sonarr", [compound], result)).toEqual([]);
	});
	it.each([
		{ service: "radarr" as const, media: { movieId: 12 }, eventType: "downloadFolderImported" },
		{
			service: "lidarr" as const,
			media: { artistId: 12, albumId: 13 },
			eventType: "trackFileImported",
		},
		{
			service: "readarr" as const,
			media: { authorId: 12, bookId: 13 },
			eventType: "bookFileImported",
		},
	])(
		"retains $service's exact positive evidence without an episode inference",
		({ service, media, eventType }) => {
			const selected = { path: compound.path, downloadId: compound.downloadId, ...media };
			const row = { ...event(13), eventType, ...media };
			const result = accumulatePositiveImportWitnesses(service, [selected], [row], started, ended);
			expect(verifiedImportWitnessFiles(service, [selected], result)).toEqual([
				importCommandFingerprint([selected]),
			]);
			expect(result.witnesses).toMatchObject([{ fileId: 31, episodeIds: [] }]);
		},
	);
	it("rejects an invalid time window instead of accepting unbounded future evidence", () => {
		expect(() =>
			accumulatePositiveImportWitnesses(
				"sonarr",
				[compound],
				[event(13)],
				started,
				new Date("invalid"),
			),
		).toThrow(/Import file evidence/);
		expect(() =>
			accumulatePositiveImportWitnesses("sonarr", [compound], [event(13)], ended, started),
		).toThrow(/Import file evidence/);
	});
	it("rejects unowned or unselected continuation witnesses", () => {
		expect(() =>
			accumulatePositiveImportWitnesses("sonarr", [compound], [event(13)], started, ended, {
				witnesses: [{ fileFingerprint: `v1:${"a".repeat(64)}`, fileId: 31, episodeIds: [13] }],
				ambiguousFiles: [],
			}),
		).toThrow(/Import file evidence/);
	});
});
