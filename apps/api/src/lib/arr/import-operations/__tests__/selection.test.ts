import type {
	ManualImportCandidate,
	ManualImportServiceType,
	ManualImportSubmissionFile,
} from "@arr/shared";
import { describe, expect, it } from "vitest";
import { buildVerifiedImportSelection, importRequestFingerprint } from "../selection.js";

const source = "A".repeat(40);
const baseCandidate = {
	id: 1,
	path: "/synthetic/file",
	downloadId: source,
	quality: { revision: 2 },
	languages: [1],
	folderName: "current",
	indexerFlags: 2,
};
type ServiceCase = {
	service: ManualImportServiceType;
	candidate: ManualImportCandidate;
	file: ManualImportSubmissionFile;
	identity: object;
};
const cases: [ServiceCase, ServiceCase, ServiceCase, ServiceCase] = [
	{
		service: "sonarr",
		candidate: {
			...baseCandidate,
			service: "sonarr",
			series: { id: 11 },
			episodes: [{ id: 12 }, { id: 13 }],
			episodeFileId: 0,
		},
		file: {
			path: baseCandidate.path,
			downloadId: source,
			seriesId: 11,
			episodeIds: [13, 12],
			episodeFileId: 0,
		},
		identity: { seriesId: 11, episodeIds: [12, 13], episodeFileId: 0 },
	},
	{
		service: "radarr",
		candidate: { ...baseCandidate, service: "radarr", movie: { id: 21 }, movieFileId: 0 },
		file: { path: baseCandidate.path, downloadId: source, movieId: 21, movieFileId: 0 },
		identity: { movieId: 21, movieFileId: 0 },
	},
	{
		service: "lidarr",
		candidate: {
			...baseCandidate,
			service: "lidarr",
			artist: { id: 31 },
			album: { id: 32 },
			albumReleaseId: 33,
			tracks: [{ id: 34 }],
		},
		file: {
			path: baseCandidate.path,
			downloadId: source,
			artistId: 31,
			albumId: 32,
			albumReleaseId: 33,
		},
		identity: { artistId: 31, albumId: 32, albumReleaseId: 33, trackIds: [34] },
	},
	{
		service: "readarr",
		candidate: {
			...baseCandidate,
			service: "readarr",
			author: { id: 41 },
			book: { id: 42 },
			foreignEditionId: "edition-1",
		},
		file: { path: baseCandidate.path, downloadId: source, authorId: 41, bookId: 42 },
		identity: { authorId: 41, bookId: 42, foreignEditionId: "edition-1" },
	},
];

function first<T>(rows: T[]): T {
	const value = rows[0];
	if (value === undefined) throw new Error("Expected a populated fixture result");
	return value;
}

describe("server-verified import selection", () => {
	it.each([
		{
			media: { seriesId: 11, episodeIds: [12] },
			want: "v1:cf8a7aab5e02ba2a8f7b56dd66838b6386f65b810d8b06830191f3ac959a58c1",
		},
		{
			media: { movieId: 21 },
			want: "v1:3000bd79a0ddbaf290832bca8252bf9bd7e26c74936338e351c5c06c25dd4f32",
		},
		{
			media: { artistId: 31, albumId: 32 },
			want: "v1:1743ddebf6951b819051e338f86b8f0666d47a88113fc05f3ae986fc26ae9412",
		},
		{
			media: { authorId: 41, bookId: 42 },
			want: "v1:2b8c6f182aff1656b46e04731a8c400da1df42108865b5cc3947dbc78d59ed96",
		},
	])("preserves historical v1 request bindings without edition %#", ({ media, want }) => {
		expect(
			importRequestFingerprint([{ path: "/old/file", downloadId: "old-source", ...media }]),
		).toBe(want);
	});
	it("binds an explicit Readarr edition in the user intention", () => {
		const file = { path: "/old/file", downloadId: "old-source", authorId: 41, bookId: 42 };
		expect(importRequestFingerprint([{ ...file, foreignEditionId: "edition-1" }])).not.toBe(
			importRequestFingerprint([{ ...file, foreignEditionId: "edition-2" }]),
		);
	});
	it.each(cases)(
		"builds $service commands from current candidates, not client metadata",
		({ service, candidate, file, identity }) => {
			const result = buildVerifiedImportSelection(
				service,
				[
					{
						...file,
						quality: { clientOnly: true },
						folderName: "untrusted",
						languages: [99],
						releaseGroup: "untrusted",
						indexerFlags: 99,
					},
				],
				[candidate],
			);
			expect(result.files).toHaveLength(1);
			expect(result.files[0]).toMatchObject({
				path: candidate.path,
				quality: candidate.quality,
				folderName: "current",
				languages: [1],
				indexerFlags: 2,
			});
			expect(first(result.files).releaseGroup).toBeUndefined();
			expect(first(result.identities).identity).toMatchObject(identity);
			expect(first(result.identities).identity.pathHash).toMatch(/^[a-f0-9]{64}$/);
			expect(first(result.identities).downloadKey).toMatch(/^[a-f0-9]{64}$/);
			expect(result.commandFingerprint).toMatch(/^v1:[a-f0-9]{64}$/);
			expect(result.requestFingerprint).toBe(importRequestFingerprint([file]));
			expect(JSON.stringify(result.identities)).not.toContain(candidate.path);
		},
	);
	it.each(cases)(
		"rejects $service targets absent from current provider evidence",
		({ service, file }) => {
			expect(() => buildVerifiedImportSelection(service, [file], [])).toThrow(
				/current import selection is unverified/i,
			);
		},
	);
	it.each(cases)("rejects ambiguous $service candidate rows", ({ service, file, candidate }) => {
		expect(() => buildVerifiedImportSelection(service, [file], [candidate, candidate])).toThrow(
			/current import selection is unverified/i,
		);
	});
	it.each(cases)("rejects $service source/path/media changes", ({ service, file, candidate }) => {
		expect(() =>
			buildVerifiedImportSelection(service, [{ ...file, path: "/other" }], [candidate]),
		).toThrow();
		expect(() =>
			buildVerifiedImportSelection(service, [{ ...file, downloadId: "other-source" }], [candidate]),
		).toThrow();
		const changed = structuredClone(candidate);
		switch (changed.service) {
			case "sonarr":
				changed.series = { id: 91 };
				break;
			case "radarr":
				changed.movie = { id: 91 };
				break;
			case "lidarr":
				changed.album = { id: 91 };
				break;
			case "readarr":
				changed.book = { id: 91 };
				break;
		}
		expect(() => buildVerifiedImportSelection(service, [file], [changed])).toThrow();
	});
	it("preserves a deliberately selected Sonarr episode subset", () => {
		const fixture = cases[0];
		const result = buildVerifiedImportSelection(
			"sonarr",
			[{ ...fixture.file, episodeIds: [13] }],
			[fixture.candidate],
		);
		expect(first(result.files).episodeIds).toEqual([13]);
		expect(first(result.identities).identity).toMatchObject({ seriesId: 11, episodeIds: [13] });
		expect(() =>
			buildVerifiedImportSelection(
				"sonarr",
				[{ ...fixture.file, episodeIds: [99] }],
				[fixture.candidate],
			),
		).toThrow();
		expect(() =>
			buildVerifiedImportSelection(
				"sonarr",
				[{ ...fixture.file, episodeIds: [13, 13] }],
				[fixture.candidate],
			),
		).toThrow();
	});
	it("matches case-insensitive torrent hashes but preserves opaque identifier case", () => {
		const fixture = cases[1];
		expect(
			first(
				buildVerifiedImportSelection(
					"radarr",
					[{ ...fixture.file, downloadId: source.toLowerCase() }],
					[fixture.candidate],
				).files,
			).downloadId,
		).toBe(source.toLowerCase());
		expect(() =>
			buildVerifiedImportSelection(
				"radarr",
				[{ ...fixture.file, downloadId: "opaque-ID" }],
				[{ ...fixture.candidate, downloadId: "opaque-id" }],
			),
		).toThrow();
	});
	it("rejects unknown file coordinates rather than trusting client-only IDs", () => {
		const fixture = cases[3];
		expect(() =>
			buildVerifiedImportSelection(
				"readarr",
				[{ ...fixture.file, bookFileId: 99 }],
				[fixture.candidate],
			),
		).toThrow();
		const music = cases[2];
		expect(() =>
			buildVerifiedImportSelection(
				"lidarr",
				[{ ...music.file, trackIds: [99] }],
				[music.candidate],
			),
		).toThrow();
	});
	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		"rejects nonpositive or unsafe current media ID %s",
		(id) => {
			const fixture = cases[1];
			expect(() =>
				buildVerifiedImportSelection(
					"radarr",
					[{ ...fixture.file, movieId: id }],
					[{ ...fixture.candidate, service: "radarr", movie: { id } }],
				),
			).toThrow();
		},
	);
	it("rejects wrong-service fields, duplicate selections, and duplicate source paths", () => {
		const fixture = cases[1];
		expect(() =>
			buildVerifiedImportSelection(
				"radarr",
				[{ ...fixture.file, seriesId: 11 }],
				[fixture.candidate],
			),
		).toThrow();
		expect(() =>
			buildVerifiedImportSelection("radarr", [fixture.file, fixture.file], [fixture.candidate]),
		).toThrow();
		expect(() =>
			buildVerifiedImportSelection(
				"radarr",
				[fixture.file],
				[fixture.candidate, { ...fixture.candidate, downloadId: "other" }],
			),
		).toThrow();
	});
	it("bounds selections and refuses a silent empty or reduced batch", () => {
		const fixture = cases[1];
		expect(() => buildVerifiedImportSelection("radarr", [], [])).toThrow();
		expect(() =>
			buildVerifiedImportSelection(
				"radarr",
				Array.from({ length: 1001 }, () => fixture.file),
				[fixture.candidate],
			),
		).toThrow();
		expect(() =>
			buildVerifiedImportSelection(
				"radarr",
				[fixture.file, { ...fixture.file, path: "/missing" }],
				[fixture.candidate],
			),
		).toThrow();
	});
	it("binds both sources and keeps fingerprints stable across selection order", () => {
		const fixture = cases[1];
		const second = { ...fixture.file, path: "/second", downloadId: "other", movieId: 22 };
		const candidates = [
			fixture.candidate,
			{
				...fixture.candidate,
				service: "radarr" as const,
				path: "/second",
				downloadId: "other",
				movie: { id: 22 },
			},
		];
		const first = buildVerifiedImportSelection("radarr", [fixture.file, second], candidates);
		const reverse = buildVerifiedImportSelection("radarr", [second, fixture.file], candidates);
		expect(first.identities).toHaveLength(2);
		expect(new Set(first.identities.map((file) => file.downloadKey)).size).toBe(2);
		expect(first.commandFingerprint).toBe(reverse.commandFingerprint);
		expect(first.requestFingerprint).toBe(reverse.requestFingerprint);
	});
});
