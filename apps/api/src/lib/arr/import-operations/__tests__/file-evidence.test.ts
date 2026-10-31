import { describe, expect, it } from "vitest";
import { importCommandFingerprint } from "../../manual-import-command.js";
import { matchPositiveImportFiles } from "../file-evidence.js";

const startedAt = new Date("2026-09-30T12:00:00Z");
const source = "A".repeat(40);
const file = { path: "/synthetic/media", downloadId: source, movieId: 12 };
const row = {
	eventType: "downloadFolderImported",
	downloadId: source.toLowerCase(),
	movieId: 12,
	date: "2026-09-30T12:01:00Z",
	data: { droppedPath: file.path, fileId: "31" },
};

describe("positive per-file import evidence", () => {
	it("returns only fingerprints backed by a matching positive import event", () => {
		expect(matchPositiveImportFiles("radarr", [file], [row], startedAt)).toEqual([
			importCommandFingerprint([file]),
		]);
	});
	it.each([
		{ ...row, downloadId: "foreign" },
		{ ...row, movieId: 13 },
		{ ...row, date: "2026-09-30T11:59:00Z" },
		{ ...row, date: "invalid" },
		{ ...row, eventType: "grabbed" },
		{ ...row, data: { droppedPath: "/other", fileId: "31" } },
		{ ...row, data: { droppedPath: file.path } },
		{ ...row, data: { droppedPath: file.path, fileId: "9007199254740992" } },
		{ ...row, data: { droppedPath: file.path, fileId: 0 } },
		{ ...row, data: { droppedPath: file.path, fileId: -1 } },
		{ ...row, data: { droppedPath: file.path, fileId: 1.5 } },
	])("rejects stale, foreign, wrong-media/path/event or unverified file evidence", (bad) => {
		expect(matchPositiveImportFiles("radarr", [file], [bad], startedAt)).toEqual([]);
	});
	it("preserves exact case for opaque non-torrent source IDs", () => {
		const opaque = { ...file, downloadId: "opaque-ID" };
		expect(
			matchPositiveImportFiles(
				"radarr",
				[opaque],
				[{ ...row, downloadId: "opaque-ID" }],
				startedAt,
			),
		).toHaveLength(1);
		expect(
			matchPositiveImportFiles(
				"radarr",
				[opaque],
				[{ ...row, downloadId: "opaque-id" }],
				startedAt,
			),
		).toEqual([]);
	});
	it("reports positive subsets from multiple download sources without fabricating the rest", () => {
		const second = { ...file, path: "/second", downloadId: "second", movieId: 13 };
		const secondRow = {
			...row,
			downloadId: "second",
			movieId: 13,
			data: { droppedPath: second.path, fileId: 32 },
		};
		expect(matchPositiveImportFiles("radarr", [file, second], [row], startedAt)).toEqual([
			importCommandFingerprint([file]),
		]);
		expect(
			matchPositiveImportFiles("radarr", [file, second], [row, secondRow], startedAt),
		).toHaveLength(2);
	});
	it.each([
		{
			service: "lidarr" as const,
			eventType: "trackFileImported",
			media: { artistId: 12, albumId: 13 },
		},
		{
			service: "readarr" as const,
			eventType: "bookFileImported",
			media: { authorId: 12, bookId: 13 },
		},
	])("uses $service's own event and all its media coordinates", ({ service, eventType, media }) => {
		const selected = { path: file.path, downloadId: file.downloadId, ...media };
		const good = { ...row, movieId: undefined, ...media, eventType };
		expect(matchPositiveImportFiles(service, [selected], [good], startedAt)).toHaveLength(1);
		expect(
			matchPositiveImportFiles(
				service,
				[selected],
				[{ ...good, eventType: "downloadFolderImported" }],
				startedAt,
			),
		).toEqual([]);
		expect(
			matchPositiveImportFiles(
				service,
				[selected],
				[{ ...good, ...Object.fromEntries(Object.keys(media).map((key) => [key, 99])) }],
				startedAt,
			),
		).toEqual([]);
	});
	it("requires every selected Sonarr episode to resolve to the same imported file ID", () => {
		const compound = {
			path: file.path,
			downloadId: file.downloadId,
			seriesId: 12,
			episodeIds: [13, 14],
		};
		const rows = [13, 14].map((episodeId) => ({
			...row,
			movieId: undefined,
			seriesId: 12,
			episodeId,
		}));
		expect(matchPositiveImportFiles("sonarr", [compound], rows.slice(0, 1), startedAt)).toEqual([]);
		expect(matchPositiveImportFiles("sonarr", [compound], rows, startedAt)).toHaveLength(1);
		expect(
			matchPositiveImportFiles(
				"sonarr",
				[compound],
				[rows[0], { ...rows[1], data: { droppedPath: file.path, fileId: "32" } }],
				startedAt,
			),
		).toEqual([]);
		const subset = { ...compound, episodeIds: [14] };
		expect(matchPositiveImportFiles("sonarr", [subset], rows.slice(1), startedAt)).toHaveLength(1);
	});
	it("treats conflicting imported file IDs as ambiguous rather than choosing a record", () => {
		expect(
			matchPositiveImportFiles(
				"radarr",
				[file],
				[row, { ...row, data: { droppedPath: file.path, fileId: "32" } }],
				startedAt,
			),
		).toEqual([]);
	});
	it("accepts documented data-key casing without accepting malformed data", () => {
		expect(
			matchPositiveImportFiles(
				"radarr",
				[file],
				[{ ...row, data: { DroppedPath: file.path, FileId: 31 } }],
				startedAt,
			),
		).toHaveLength(1);
		expect(
			matchPositiveImportFiles("radarr", [file], [null, 1, {}, { ...row, data: null }], startedAt),
		).toEqual([]);
	});
	it("rejects invalid preparation time and file selection instead of claiming evidence", () => {
		expect(matchPositiveImportFiles("radarr", [file], [row], new Date("invalid"))).toEqual([]);
		expect(matchPositiveImportFiles("radarr", [{ ...file, movieId: 0 }], [row], startedAt)).toEqual(
			[],
		);
		expect(
			matchPositiveImportFiles(
				"sonarr",
				[{ ...file, seriesId: 12, episodeIds: [13, 13] }],
				[row],
				startedAt,
			),
		).toEqual([]);
	});
});
