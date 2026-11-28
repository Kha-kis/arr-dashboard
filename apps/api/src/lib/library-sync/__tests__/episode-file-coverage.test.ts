import { describe, expect, it } from "vitest";
import {
	cachedSonarrSeriesFileEvidence,
	createEpisodeFileInventoryReceipt,
	createEpisodeFileObservationReceipt,
	currentSonarrSeriesFileEvidence,
	episodeFileIdentitiesFromSonarr,
	hasCompleteEpisodeFileInventory,
	readEpisodeFileInventoryDisplay,
	readEpisodeFileInventorySource,
} from "../episode-file-coverage.js";

const cachedAt = new Date("2026-01-01T00:00:00.000Z");
const files = [
	{ arrEpisodeFileId: 11, path: "/synthetic/eleven", size: 11n },
	{ arrEpisodeFileId: 12, path: "/synthetic/twelve", size: 12n },
];
const evidence = { episodeWithFileCount: 3, sizeOnDisk: 23n };

describe("Sonarr episode-file coverage receipts", () => {
	it("requires positive safe episode counts and top-level normalized size from the cached series", () => {
		expect(
			cachedSonarrSeriesFileEvidence('{"statistics":{"episodeFileCount":3},"sizeOnDisk":23}'),
		).toEqual(evidence);
		expect(
			cachedSonarrSeriesFileEvidence('{"statistics":{"episodeFileCount":0},"sizeOnDisk":23}'),
		).toBeNull();
		expect(
			cachedSonarrSeriesFileEvidence('{"statistics":{"episodeFileCount":3},"sizeOnDisk":0}'),
		).toBeNull();
		expect(cachedSonarrSeriesFileEvidence("invalid")).toBeNull();
	});

	it("requires a current provider series identity and complete valid file-list shape", () => {
		expect(
			currentSonarrSeriesFileEvidence(
				{ id: 2, statistics: { episodeFileCount: 3, sizeOnDisk: 23 } },
				2,
			),
		).toEqual(evidence);
		expect(
			currentSonarrSeriesFileEvidence(
				{ id: 3, statistics: { episodeFileCount: 3, sizeOnDisk: 23 } },
				2,
			),
		).toBeNull();
		const providerFile = {
			id: 11,
			seriesId: 2,
			seasonNumber: 1,
			relativePath: "eleven",
			path: "/synthetic/eleven",
			size: 11,
		};
		expect(episodeFileIdentitiesFromSonarr([providerFile], 2)).toEqual([files[0]]);
		expect(episodeFileIdentitiesFromSonarr([providerFile, providerFile], 2)).toBeNull();
		expect(episodeFileIdentitiesFromSonarr([{ ...providerFile, path: null }], 2)).toBeNull();
		expect(episodeFileIdentitiesFromSonarr([{ ...providerFile, seriesId: 3 }], 2)).toBeNull();
		expect(episodeFileIdentitiesFromSonarr([{ ...providerFile, size: 0 }], 2)).toBeNull();
	});
	it("accepts one physical file covering multiple episodes when independent size agrees", () => {
		const receipt = createEpisodeFileInventoryReceipt(cachedAt, files, evidence);
		expect(receipt).not.toBeNull();
		expect(hasCompleteEpisodeFileInventory(receipt, cachedAt, [...files].reverse())).toBe(true);
		expect(
			createEpisodeFileInventoryReceipt(cachedAt, files, { ...evidence, sizeOnDisk: 24n }),
		).toBeNull();
	});

	it("retains exact timestamp fencing for the new observation format", () => {
		const legacy = createEpisodeFileInventoryReceipt(cachedAt, files, evidence)!;
		const receipt = JSON.stringify({
			...JSON.parse(legacy),
			v: 3,
			observedAt: cachedAt.toISOString(),
			seriesContentDigest: "a".repeat(64),
			sourceFingerprint: "b".repeat(64),
		});
		expect(hasCompleteEpisodeFileInventory(receipt, cachedAt, files)).toBe(true);
		expect(hasCompleteEpisodeFileInventory(receipt, new Date(cachedAt.getTime() + 1), files)).toBe(
			false,
		);
	});

	it("rejects missing, partial, stale, changed, and duplicate file identities", () => {
		const receipt = createEpisodeFileInventoryReceipt(cachedAt, files, evidence);
		expect(hasCompleteEpisodeFileInventory(null, cachedAt, files)).toBe(false);
		expect(hasCompleteEpisodeFileInventory(receipt, cachedAt, files.slice(0, 1))).toBe(false);
		expect(hasCompleteEpisodeFileInventory(receipt, new Date(cachedAt.getTime() + 1), files)).toBe(
			false,
		);
		expect(
			hasCompleteEpisodeFileInventory(receipt, cachedAt, [files[0]!, { ...files[1]!, size: 13n }]),
		).toBe(false);
		expect(hasCompleteEpisodeFileInventory(receipt, cachedAt, [files[0]!, files[0]!])).toBe(false);
		expect(hasCompleteEpisodeFileInventory("invalid", cachedAt, files)).toBe(false);
		expect(
			hasCompleteEpisodeFileInventory(JSON.stringify({ v: 1, fileCount: 2 }), cachedAt, files),
		).toBe(false);
	});
});

describe("independent episode inventory display evidence", () => {
	const sourceFingerprint = "b".repeat(64);
	const data = JSON.stringify({
		statistics: { episodeFileCount: 3 },
		sizeOnDisk: 23,
		_arrDashboardSource: { serviceFingerprint: sourceFingerprint },
	});
	const observedAt = new Date("2026-01-02T00:00:00.000Z");
	const windowMs = 6 * 60 * 60_000;
	const makeReceipt = () =>
		createEpisodeFileObservationReceipt(
			cachedAt,
			files,
			evidence,
			data,
			sourceFingerprint,
			observedAt,
		)!;
	const read = (
		receipt = makeReceipt(),
		now = observedAt.getTime(),
		currentData = data,
		currentSource = sourceFingerprint,
		currentFiles = files,
	) =>
		readEpisodeFileInventoryDisplay(
			receipt,
			new Date(cachedAt.getTime() + 1),
			currentFiles,
			currentData,
			currentSource,
			now,
		);

	it("uses the original provider clock across unchanged polls and expires exactly at six hours", () => {
		expect(read()).toMatchObject({
			complete: true,
			episodeInventory: { status: "fresh", observedAt: observedAt.toISOString() },
		});
		expect(read(makeReceipt(), observedAt.getTime() + windowMs - 1).complete).toBe(true);
		expect(read(makeReceipt(), observedAt.getTime() + windowMs)).toMatchObject({
			complete: false,
			episodeInventory: { status: "stale", observedAt: observedAt.toISOString() },
		});
		expect(read(makeReceipt(), observedAt.getTime() - 1)).toMatchObject({
			complete: false,
			episodeInventory: { status: "unknown", observedAt: null },
		});
	});

	it("requires trusted current source and serialized content before creating new observations", () => {
		const legacyData = JSON.stringify({ statistics: { episodeFileCount: 3 }, sizeOnDisk: 23 });
		expect(readEpisodeFileInventorySource(legacyData, null)).toEqual({ status: "legacy" });
		for (const marker of [null, {}, [], { serviceFingerprint: "changed" }]) {
			const badData = JSON.stringify({ ...JSON.parse(legacyData), _arrDashboardSource: marker });
			expect(readEpisodeFileInventorySource(badData, sourceFingerprint)).toEqual({
				status: "invalid",
			});
			expect(
				createEpisodeFileObservationReceipt(
					cachedAt,
					files,
					evidence,
					badData,
					sourceFingerprint,
					observedAt,
				),
			).toBeNull();
		}
		expect(
			createEpisodeFileObservationReceipt(
				cachedAt,
				files,
				evidence,
				legacyData,
				sourceFingerprint,
				observedAt,
			),
		).toBeNull();
		expect(
			createEpisodeFileObservationReceipt(cachedAt, files, evidence, data, null, observedAt),
		).toBeNull();
		expect(
			createEpisodeFileObservationReceipt(
				cachedAt,
				files,
				evidence,
				data,
				sourceFingerprint,
				new Date("invalid"),
			),
		).toBeNull();
	});

	it("rejects malformed, changed, duplicate and different-scope evidence without manufacturing an as-of time", () => {
		for (const changes of [
			{ observedAt: "invalid" },
			{ observedAt: "2026-01-02" },
			{ seriesContentDigest: "invalid" },
			{ sourceFingerprint: "a".repeat(64) },
			{ fileCount: 1 },
			{ digest: "a".repeat(64) },
			{ sourceSizeBytes: "24" },
			{ v: 99 },
		]) {
			const altered = JSON.stringify({ ...JSON.parse(makeReceipt()), ...changes });
			expect(read(altered)).toMatchObject({
				complete: false,
				episodeInventory: { status: "unknown", observedAt: null },
			});
		}
		expect(read(makeReceipt(), observedAt.getTime(), `${data} `)).toMatchObject({
			complete: false,
			sourceMatches: true,
			episodeInventory: { status: "unknown", observedAt: null },
		});
		expect(read(makeReceipt(), observedAt.getTime(), data, "a".repeat(64))).toMatchObject({
			complete: false,
			sourceMatches: false,
		});
		for (const changedFiles of [
			files.slice(0, 1),
			[files[0]!, files[0]!],
			[files[0]!, { ...files[1]!, path: "/changed" }],
			[files[0]!, { ...files[1]!, arrEpisodeFileId: 99 }],
			[files[0]!, { ...files[1]!, size: 13n }],
		]) {
			expect(
				read(makeReceipt(), observedAt.getTime(), data, sourceFingerprint, changedFiles),
			).toMatchObject({
				complete: false,
				episodeInventory: { status: "unknown", observedAt: null },
			});
		}
	});

	it("suppresses old-source positives even when a receipt is revoked, malformed, or legacy", () => {
		const legacy = createEpisodeFileInventoryReceipt(cachedAt, files, evidence)!;
		for (const receipt of [null, "invalid", legacy, makeReceipt()]) {
			expect(
				readEpisodeFileInventoryDisplay(receipt, cachedAt, files, data, "a".repeat(64)),
			).toMatchObject({
				complete: false,
				sourceMatches: false,
				episodeInventory: { status: "unknown", observedAt: null },
			});
		}
	});

	it("retains the legacy snapshot check without granting legacy data a new observation time", () => {
		const receipt = createEpisodeFileInventoryReceipt(cachedAt, files, evidence)!;
		expect(
			readEpisodeFileInventoryDisplay(
				receipt,
				cachedAt,
				files,
				data,
				sourceFingerprint,
				observedAt.getTime(),
			),
		).toEqual({ complete: true, sourceMatches: true });
		expect(read(receipt)).toEqual({ complete: false, sourceMatches: true });
		expect(readEpisodeFileInventoryDisplay(null, cachedAt, files, "{}", sourceFingerprint)).toEqual(
			{ complete: false, sourceMatches: true },
		);
	});
});
