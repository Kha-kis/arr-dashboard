import { describe, expect, it } from "vitest";
import {
	cachedSonarrSeriesFileEvidence,
	createEpisodeFileInventoryReceipt,
	currentSonarrSeriesFileEvidence,
	episodeFileIdentitiesFromSonarr,
	hasCompleteEpisodeFileInventory,
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
