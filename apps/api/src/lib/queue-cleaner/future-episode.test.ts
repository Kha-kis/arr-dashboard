/**
 * Future Episode Filter Tests
 *
 * Tests for the isFutureEpisode helper and its integration
 * with the queue cleaner skip logic (issue #130).
 *
 * Run with: npx vitest run future-episode.test.ts
 */

import { describe, it, expect } from "vitest";
import { isFutureEpisode, type RawQueueItem } from "./queue-item-utils.js";

// ---------------------------------------------------------------------------
// Fixtures: Example Sonarr API queue responses
// ---------------------------------------------------------------------------

/** A real Sonarr queue item — downloading, episode already aired. Should NOT be skipped. */
const SONARR_QUEUE_ITEM_AIRED: RawQueueItem = {
	id: 101,
	title: "Show.S01E05.720p.WEB-DL",
	added: "2026-02-28T14:00:00Z",
	size: 500_000_000,
	sizeleft: 250_000_000,
	trackedDownloadStatus: "ok",
	trackedDownloadState: "downloading",
	protocol: "torrent",
	downloadClient: "qBittorrent",
	downloadId: "abc123",
	episode: {
		id: 42,
		seriesId: 7,
		seasonNumber: 1,
		episodeNumber: 5,
		title: "The One That Aired",
		airDateUtc: "2026-01-15T20:00:00Z", // In the past
		hasFile: false,
		monitored: true,
	},
};

/** A Sonarr queue item for a future episode (pre-grabbed before air date). Should be skipped. */
const SONARR_QUEUE_ITEM_FUTURE: RawQueueItem = {
	id: 102,
	title: "Show.S01E10.720p.WEB-DL",
	added: "2026-02-28T14:00:00Z",
	size: 500_000_000,
	sizeleft: 0,
	trackedDownloadStatus: "ok",
	trackedDownloadState: "importPending",
	protocol: "torrent",
	downloadClient: "qBittorrent",
	downloadId: "def456",
	episode: {
		id: 50,
		seriesId: 7,
		seasonNumber: 1,
		episodeNumber: 10,
		title: "The One That Hasn't Aired",
		airDateUtc: "2026-12-25T20:00:00Z", // Far in the future
		hasFile: false,
		monitored: true,
	},
};

/** A Radarr queue item — has movie object, not episode. Should NOT be skipped. */
const RADARR_QUEUE_ITEM: RawQueueItem = {
	id: 201,
	title: "Movie.2026.1080p.BluRay",
	added: "2026-02-28T10:00:00Z",
	size: 2_000_000_000,
	sizeleft: 1_000_000_000,
	trackedDownloadStatus: "warning",
	trackedDownloadState: "downloading",
	protocol: "usenet",
	downloadClient: "SABnzbd",
	downloadId: "ghi789",
	movie: {
		id: 99,
		title: "Some Movie",
		year: 2026,
	},
};

// ---------------------------------------------------------------------------
// Unit tests: isFutureEpisode
// ---------------------------------------------------------------------------

describe("isFutureEpisode", () => {
	const now = new Date("2026-03-01T12:00:00Z");

	it("returns true for a Sonarr queue item with a future air date", () => {
		expect(isFutureEpisode(SONARR_QUEUE_ITEM_FUTURE, now)).toBe(true);
	});

	it("returns false for a Sonarr queue item with a past air date", () => {
		expect(isFutureEpisode(SONARR_QUEUE_ITEM_AIRED, now)).toBe(false);
	});

	it("returns false for a Radarr queue item (no episode field)", () => {
		expect(isFutureEpisode(RADARR_QUEUE_ITEM, now)).toBe(false);
	});

	it("returns false when episode is null", () => {
		const item: RawQueueItem = { ...SONARR_QUEUE_ITEM_FUTURE, episode: null };
		expect(isFutureEpisode(item, now)).toBe(false);
	});

	it("returns false when episode is not an object", () => {
		const item: RawQueueItem = { ...SONARR_QUEUE_ITEM_FUTURE, episode: "not-an-object" };
		expect(isFutureEpisode(item, now)).toBe(false);
	});

	it("returns false when airDateUtc is missing from episode", () => {
		const item: RawQueueItem = {
			...SONARR_QUEUE_ITEM_FUTURE,
			episode: { id: 50, title: "No Air Date" },
		};
		expect(isFutureEpisode(item, now)).toBe(false);
	});

	it("returns false when airDateUtc is not a string", () => {
		const item: RawQueueItem = {
			...SONARR_QUEUE_ITEM_FUTURE,
			episode: { id: 50, airDateUtc: 12345 },
		};
		expect(isFutureEpisode(item, now)).toBe(false);
	});

	it("returns false when airDateUtc is an invalid date string", () => {
		const item: RawQueueItem = {
			...SONARR_QUEUE_ITEM_FUTURE,
			episode: { id: 50, airDateUtc: "not-a-date" },
		};
		expect(isFutureEpisode(item, now)).toBe(false);
	});

	it("returns false when episode has no properties (empty object)", () => {
		const item: RawQueueItem = { ...SONARR_QUEUE_ITEM_FUTURE, episode: {} };
		expect(isFutureEpisode(item, now)).toBe(false);
	});

	it("returns true when airDateUtc is just barely in the future", () => {
		const item: RawQueueItem = {
			...SONARR_QUEUE_ITEM_FUTURE,
			episode: { id: 50, airDateUtc: "2026-03-01T12:00:01Z" }, // 1 second in the future
		};
		expect(isFutureEpisode(item, now)).toBe(true);
	});

	it("returns false when airDateUtc is exactly now", () => {
		const item: RawQueueItem = {
			...SONARR_QUEUE_ITEM_FUTURE,
			episode: { id: 50, airDateUtc: "2026-03-01T12:00:00Z" }, // Exactly now
		};
		expect(isFutureEpisode(item, now)).toBe(false);
	});

	it("handles item with no episode field at all", () => {
		const item: RawQueueItem = { id: 300, title: "No episode field" };
		expect(isFutureEpisode(item, now)).toBe(false);
	});
});
