/**
 * Tests for Sonarr statistics missing episode calculation
 *
 * Verifies that missingEpisodes counts only monitored episodes without files,
 * matching Sonarr's own missing count. Covers the fix for GitHub issue #131
 * where totalEpisodeCount (all episodes) was used instead of episodeCount
 * (monitored episodes only), inflating missing stats by 100x+.
 */

import type { LidarrClient } from "arr-sdk/lidarr";
import type { SonarrClient } from "arr-sdk/sonarr";
import { describe, expect, it, vi } from "vitest";
import {
	aggregateSonarrStatistics,
	fetchLidarrStatisticsWithSdk,
	fetchSonarrStatisticsWithSdk,
} from "../dashboard-statistics.js";

// ---------------------------------------------------------------------------
// Helpers – build mock SonarrClient
// ---------------------------------------------------------------------------

interface MockSeriesEntry {
	id: number;
	title: string;
	monitored: boolean;
	status: "continuing" | "ended";
	added: string;
	tags: number[];
	qualityProfileId: number;
	statistics: {
		totalEpisodeCount: number;
		episodeCount: number;
		episodeFileCount: number;
		sizeOnDisk: number;
		percentOfEpisodes?: number;
	};
}

function createMockSonarrClient(
	seriesList: MockSeriesEntry[],
	overrides?: {
		diskSpace?: Array<{ freeSpace: number; totalSpace: number }>;
		health?: Array<{ type: string; message: string }>;
		cutoffTotalRecords?: number;
	},
): SonarrClient {
	const diskSpace = overrides?.diskSpace ?? [
		{ freeSpace: 500_000_000_000, totalSpace: 1_000_000_000_000 },
	];
	const health = overrides?.health ?? [];
	const cutoffTotalRecords = overrides?.cutoffTotalRecords ?? 0;

	return {
		series: {
			getAll: vi.fn().mockResolvedValue(seriesList),
		},
		diskSpace: {
			getAll: vi.fn().mockResolvedValue(diskSpace),
		},
		health: {
			getAll: vi.fn().mockResolvedValue(health),
		},
		wanted: {
			cutoff: vi.fn().mockResolvedValue({ totalRecords: cutoffTotalRecords }),
		},
		qualityProfile: {
			getAll: vi.fn().mockResolvedValue([{ id: 1, name: "HD-1080p" }]),
		},
		tag: {
			getAll: vi.fn().mockResolvedValue([{ id: 1, label: "anime" }]),
		},
	} as unknown as SonarrClient;
}

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeSeries(overrides: Partial<MockSeriesEntry> & { id: number }): MockSeriesEntry {
	return {
		title: `Series ${overrides.id}`,
		monitored: true,
		status: "continuing",
		added: "2025-01-01T00:00:00Z",
		tags: [],
		qualityProfileId: 1,
		statistics: {
			totalEpisodeCount: 100,
			episodeCount: 80,
			episodeFileCount: 70,
			sizeOnDisk: 70_000_000_000,
		},
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchSonarrStatisticsWithSdk", () => {
	const INSTANCE = { id: "inst-1", name: "Sonarr Main", url: "http://sonarr:8989" };

	it("counts missing episodes using monitored episodeCount, not totalEpisodeCount (#131)", async () => {
		// Series with 200 total episodes but only 50 monitored, 40 have files
		// Old code: missing = 200 - 40 = 160 (WRONG)
		// New code: missing = 50 - 40 = 10  (CORRECT)
		const series = [
			makeSeries({
				id: 1,
				statistics: {
					totalEpisodeCount: 200,
					episodeCount: 50,
					episodeFileCount: 40,
					sizeOnDisk: 40_000_000_000,
				},
			}),
		];

		const client = createMockSonarrClient(series);
		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
		);

		expect(result.missingEpisodes).toBe(10);
		expect(result.totalEpisodes).toBe(50); // Uses monitored episodeCount for consistent % calculation
		expect(result.downloadedEpisodes).toBe(40);
	});

	it("handles large library with many unmonitored episodes (issue #131 scenario)", async () => {
		// Simulates the reporter's scenario: 9k+ total episodes but only ~60 actually missing
		const series = [
			// Show A: long-running, mostly unmonitored historical episodes
			makeSeries({
				id: 1,
				title: "Long Running Show",
				statistics: {
					totalEpisodeCount: 5000,
					episodeCount: 30,
					episodeFileCount: 20,
					sizeOnDisk: 20_000_000_000,
				},
			}),
			// Show B: similar pattern
			makeSeries({
				id: 2,
				title: "Another Long Show",
				statistics: {
					totalEpisodeCount: 4000,
					episodeCount: 50,
					episodeFileCount: 10,
					sizeOnDisk: 10_000_000_000,
				},
			}),
		];

		const client = createMockSonarrClient(series);
		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
		);

		// Old buggy calculation: (5000 - 20) + (4000 - 10) = 8970 (matches the ~9k report!)
		// Correct calculation: (30 - 20) + (50 - 10) = 50
		expect(result.missingEpisodes).toBe(50);
		expect(result.totalEpisodes).toBe(80); // 30 + 50 monitored episodes
	});

	it("excludes future unaired episodes from missing count", async () => {
		// A series with 100 total episodes but only 60 have aired (monitored)
		// 55 of those 60 have files
		const series = [
			makeSeries({
				id: 1,
				statistics: {
					totalEpisodeCount: 100,
					episodeCount: 60, // Only 60 are monitored/aired
					episodeFileCount: 55,
					sizeOnDisk: 55_000_000_000,
				},
			}),
		];

		const client = createMockSonarrClient(series);
		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
		);

		// Only 5 actually missing, not 45
		expect(result.missingEpisodes).toBe(5);
	});

	it("handles series with specials (season 0) included in totalEpisodeCount", async () => {
		// totalEpisodeCount includes season 0 specials, episodeCount excludes them when unmonitored
		const series = [
			makeSeries({
				id: 1,
				statistics: {
					totalEpisodeCount: 150, // 120 regular + 30 specials
					episodeCount: 120, // Only regular monitored episodes
					episodeFileCount: 115,
					sizeOnDisk: 115_000_000_000,
				},
			}),
		];

		const client = createMockSonarrClient(series);
		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
		);

		expect(result.missingEpisodes).toBe(5);
		expect(result.totalEpisodes).toBe(120); // Uses monitored episodeCount, excludes specials
	});

	it("falls back to totalEpisodeCount when episodeCount is missing", async () => {
		// Edge case: if the SDK doesn't return episodeCount, fall back safely
		const series = [
			makeSeries({
				id: 1,
				statistics: {
					totalEpisodeCount: 100,
					episodeCount: undefined as unknown as number,
					episodeFileCount: 90,
					sizeOnDisk: 90_000_000_000,
				},
			}),
		];

		const client = createMockSonarrClient(series);
		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
		);

		// Falls back to totalEpisodeCount when episodeCount unavailable
		expect(result.missingEpisodes).toBe(10);
	});

	it("never reports negative missing episodes", async () => {
		// episodeFileCount can exceed episodeCount if there are bonus files
		const series = [
			makeSeries({
				id: 1,
				statistics: {
					totalEpisodeCount: 50,
					episodeCount: 40,
					episodeFileCount: 45, // More files than monitored episodes
					sizeOnDisk: 45_000_000_000,
				},
			}),
		];

		const client = createMockSonarrClient(series);
		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
		);

		expect(result.missingEpisodes).toBe(0);
	});

	it("aggregates multiple series correctly", async () => {
		const series = [
			makeSeries({
				id: 1,
				statistics: {
					totalEpisodeCount: 500,
					episodeCount: 100,
					episodeFileCount: 95,
					sizeOnDisk: 95_000_000_000,
				},
			}),
			makeSeries({
				id: 2,
				statistics: {
					totalEpisodeCount: 300,
					episodeCount: 200,
					episodeFileCount: 180,
					sizeOnDisk: 180_000_000_000,
				},
			}),
			makeSeries({
				id: 3,
				statistics: {
					totalEpisodeCount: 50,
					episodeCount: 50,
					episodeFileCount: 50,
					sizeOnDisk: 50_000_000_000,
				},
			}),
		];

		const client = createMockSonarrClient(series);
		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
		);

		// Missing: (100-95) + (200-180) + (50-50) = 5 + 20 + 0 = 25
		expect(result.missingEpisodes).toBe(25);
		expect(result.totalEpisodes).toBe(350); // 100 + 200 + 50 monitored episodes
		expect(result.downloadedEpisodes).toBe(325);
	});
});

describe("aggregateSonarrStatistics", () => {
	it("sums missing episodes across multiple instances", () => {
		const instances = [
			{
				storageGroupId: null,
				shouldCountDisk: true,
				data: {
					totalSeries: 10,
					monitoredSeries: 8,
					continuingSeries: 5,
					endedSeries: 3,
					totalEpisodes: 1000,
					episodeFileCount: 900,
					downloadedEpisodes: 900,
					missingEpisodes: 15, // Already correctly computed per-instance
					downloadedPercentage: 90,
					cutoffUnmetCount: 5,
					qualityBreakdown: {},
					tagBreakdown: {},
					recentlyAdded7Days: 1,
					recentlyAdded30Days: 3,
					averageEpisodeSize: 1_000_000_000,
					diskTotal: 1_000_000_000_000,
					diskFree: 500_000_000_000,
					diskUsed: 500_000_000_000,
					diskUsagePercent: 50,
					healthIssues: 0,
					healthIssuesList: [],
				},
			},
			{
				storageGroupId: null,
				shouldCountDisk: true,
				data: {
					totalSeries: 5,
					monitoredSeries: 5,
					continuingSeries: 3,
					endedSeries: 2,
					totalEpisodes: 500,
					episodeFileCount: 460,
					downloadedEpisodes: 460,
					missingEpisodes: 30,
					downloadedPercentage: 92,
					cutoffUnmetCount: 2,
					qualityBreakdown: {},
					tagBreakdown: {},
					recentlyAdded7Days: 0,
					recentlyAdded30Days: 1,
					averageEpisodeSize: 1_200_000_000,
					diskTotal: 2_000_000_000_000,
					diskFree: 1_000_000_000_000,
					diskUsed: 1_000_000_000_000,
					diskUsagePercent: 50,
					healthIssues: 0,
					healthIssuesList: [],
				},
			},
		];

		const result = aggregateSonarrStatistics(instances);

		expect(result).toBeDefined();
		expect(result!.missingEpisodes).toBe(45); // 15 + 30
		expect(result!.totalSeries).toBe(15);
		expect(result!.downloadedEpisodes).toBe(1360);
	});

	it("returns undefined for empty instances array", () => {
		const result = aggregateSonarrStatistics([]);
		expect(result).toBeUndefined();
	});
});

// ===========================================================================
// Lidarr Statistics — Monitored track count (#209)
// ===========================================================================

interface MockArtistEntry {
	id: number;
	artistName: string;
	monitored: boolean;
	status: "continuing" | "ended";
	added: string;
	tags: number[];
	qualityProfileId: number;
	statistics: {
		albumCount: number;
		totalTrackCount: number;
		trackCount: number; // monitored album tracks only
		trackFileCount: number;
		sizeOnDisk: number;
	};
}

function createMockLidarrClient(artistList: MockArtistEntry[]): LidarrClient {
	return {
		artist: { getAll: vi.fn().mockResolvedValue(artistList) },
		diskSpace: {
			get: vi
				.fn()
				.mockResolvedValue([{ freeSpace: 500_000_000_000, totalSpace: 1_000_000_000_000 }]),
		},
		health: { get: vi.fn().mockResolvedValue([]) },
		wanted: { getCutoffUnmet: vi.fn().mockResolvedValue({ totalRecords: 0 }) },
		qualityProfile: { getAll: vi.fn().mockResolvedValue([{ id: 1, name: "Lossless" }]) },
		tag: { getAll: vi.fn().mockResolvedValue([]) },
	} as unknown as LidarrClient;
}

function makeArtist(overrides: Partial<MockArtistEntry> & { id: number }): MockArtistEntry {
	return {
		artistName: `Artist ${overrides.id}`,
		monitored: true,
		status: "continuing",
		added: "2025-01-01T00:00:00Z",
		tags: [],
		qualityProfileId: 1,
		statistics: {
			albumCount: 5,
			totalTrackCount: 100,
			trackCount: 60, // Only 60 of 100 tracks are from monitored albums
			trackFileCount: 50,
			sizeOnDisk: 50_000_000_000,
		},
		...overrides,
	};
}

const LIDARR_INSTANCE = { id: "lidarr-1", name: "Test Lidarr", url: "http://localhost:8686" };

describe("fetchLidarrStatisticsWithSdk", () => {
	it("uses trackCount (monitored albums) not totalTrackCount for missing calculation (#209)", async () => {
		// Artist with 100 total tracks but only 60 from monitored albums, 50 downloaded
		// Old bug: missing = 100 - 50 = 50 (WRONG — counts unmonitored album tracks)
		// Fix: missing = 60 - 50 = 10 (CORRECT — only monitored album tracks)
		const artists = [
			makeArtist({
				id: 1,
				statistics: {
					albumCount: 10,
					totalTrackCount: 100,
					trackCount: 60,
					trackFileCount: 50,
					sizeOnDisk: 50_000_000_000,
				},
			}),
		];

		const client = createMockLidarrClient(artists);
		const result = await fetchLidarrStatisticsWithSdk(
			client,
			LIDARR_INSTANCE.id,
			LIDARR_INSTANCE.name,
			LIDARR_INSTANCE.url,
		);

		expect(result.missingTracks).toBe(10);
		expect(result.totalTracks).toBe(60); // Uses monitored trackCount
		expect(result.downloadedTracks).toBe(50);
	});

	it("excludes unmonitored artists entirely from missing count", async () => {
		const artists = [
			makeArtist({
				id: 1,
				monitored: true,
				statistics: {
					albumCount: 5,
					totalTrackCount: 50,
					trackCount: 40,
					trackFileCount: 35,
					sizeOnDisk: 35_000_000_000,
				},
			}),
			makeArtist({
				id: 2,
				monitored: false,
				statistics: {
					albumCount: 20,
					totalTrackCount: 500,
					trackCount: 400,
					trackFileCount: 0,
					sizeOnDisk: 0,
				},
			}),
		];

		const client = createMockLidarrClient(artists);
		const result = await fetchLidarrStatisticsWithSdk(
			client,
			LIDARR_INSTANCE.id,
			LIDARR_INSTANCE.name,
			LIDARR_INSTANCE.url,
		);

		// Only artist 1 counts: 40 monitored tracks - 35 downloaded = 5 missing
		expect(result.missingTracks).toBe(5);
		expect(result.totalTracks).toBe(40);
		expect(result.downloadedTracks).toBe(35);
		// But total artists still counts both
		expect(result.totalArtists).toBe(2);
		expect(result.monitoredArtists).toBe(1);
	});

	it("falls back to totalTrackCount when trackCount is missing", async () => {
		const artists = [
			makeArtist({
				id: 1,
				statistics: {
					albumCount: 5,
					totalTrackCount: 80,
					trackCount: undefined as unknown as number,
					trackFileCount: 70,
					sizeOnDisk: 70_000_000_000,
				},
			}),
		];

		const client = createMockLidarrClient(artists);
		const result = await fetchLidarrStatisticsWithSdk(
			client,
			LIDARR_INSTANCE.id,
			LIDARR_INSTANCE.name,
			LIDARR_INSTANCE.url,
		);

		// Falls back to totalTrackCount when trackCount unavailable
		expect(result.missingTracks).toBe(10);
		expect(result.totalTracks).toBe(80);
	});
});

// ============================================================================
// Stream-error handling (issue #427 review-feedback fix)
// ============================================================================
//
// The 4 empty catches in dashboard-statistics.ts previously swallowed mid-
// stream failures silently — a 50k-artist Lidarr fetch that died halfway
// would render as "15k artists" with no operator signal. These tests verify
// the post-fix behavior:
//   (a) Counters reflect what was aggregated BEFORE the throw (not zero,
//       not stale).
//   (b) The injected log was called at warn level with itemsAggregated
//       context, so operators see the failure.

describe("fetchSonarrStatisticsWithSdk — stream-error degradation", () => {
	const INSTANCE = { id: "inst-1", name: "Sonarr Main", url: "http://sonarr:8989" };

	function makeLog() {
		const warn = vi.fn();
		const log = {
			warn,
			info: vi.fn(),
			debug: vi.fn(),
			error: vi.fn(),
			fatal: vi.fn(),
			trace: vi.fn(),
			silent: vi.fn(),
			level: "info",
			child: vi.fn(),
		};
		// `as never` lets us pass our mock through `StatsOptions.log?:
		// FastifyBaseLogger` without rebuilding the full pino surface.
		// The functions under test only call `.warn()`.
		return { log: log as never, warn };
	}

	// Helper: build a streamItems async generator that yields N items then throws.
	function makeFailingStreamItems<T>(items: T[], throwAfter: number) {
		return async function* (): AsyncGenerator<Record<string, unknown>, void, undefined> {
			let i = 0;
			for (const item of items) {
				if (i >= throwAfter) throw new Error("simulated mid-stream failure (ECONNRESET)");
				yield item as unknown as Record<string, unknown>;
				i++;
			}
		};
	}

	it("preserves partial counters when stream throws after N items", async () => {
		const client = createMockSonarrClient([]); // SDK path unused — streamItems wins
		const items = Array.from({ length: 100 }, (_, i) =>
			makeSeries({
				id: i + 1,
				statistics: {
					totalEpisodeCount: 10,
					episodeCount: 10,
					episodeFileCount: 5,
					sizeOnDisk: 1_000_000,
				},
			}),
		);
		const { log, warn } = makeLog();

		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
			undefined,
			{ streamItems: makeFailingStreamItems(items, 30), log },
		);

		// 30 items aggregated before failure — counters reflect this, not 0,
		// not 100. The whole point of the fix.
		expect(result.totalSeries).toBe(30);
		expect(result.downloadedEpisodes).toBe(150); // 30 × 5 files-per-series

		// Operator gets a signal. Pre-fix this was silent.
		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({
				instanceId: INSTANCE.id,
				service: "sonarr",
				itemsAggregated: 30,
			}),
			expect.stringMatching(/Stats stream aborted/),
		);
	});

	it("returns zero counters (not NaN) when stream throws before first item", async () => {
		const client = createMockSonarrClient([]);
		const { log } = makeLog();

		const result = await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
			undefined,
			{ streamItems: makeFailingStreamItems([], 0), log },
		);

		expect(result.totalSeries).toBe(0);
		expect(result.downloadedPercentage).toBe(0);
		expect(Number.isNaN(result.downloadedPercentage)).toBe(false);
	});

	it("does NOT log when stream completes successfully", async () => {
		const client = createMockSonarrClient([]);
		const items = [
			makeSeries({
				id: 1,
				statistics: {
					totalEpisodeCount: 10,
					episodeCount: 10,
					episodeFileCount: 10,
					sizeOnDisk: 1_000_000,
				},
			}),
		];
		const { log, warn } = makeLog();

		await fetchSonarrStatisticsWithSdk(
			client,
			INSTANCE.id,
			INSTANCE.name,
			INSTANCE.url,
			undefined,
			{
				streamItems: async function* (): AsyncGenerator<Record<string, unknown>, void, undefined> {
					for (const item of items) yield item as unknown as Record<string, unknown>;
				},
				log,
			},
		);

		// No warn calls — the happy path stays quiet.
		expect(warn).not.toHaveBeenCalled();
	});
});
