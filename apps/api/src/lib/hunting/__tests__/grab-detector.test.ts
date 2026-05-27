/**
 * Tests for grab-detector.
 *
 * Issue #472 history:
 * - arr-sdk 0.6.0 sent `?eventType=grabbed` (string) to the Sonarr/Radarr/
 *   Lidarr/Readarr history endpoint. Current Servarr versions reject this
 *   ("The value 'grabbed' is not valid") because the .NET binder treats
 *   eventType as `int[]`, not the OpenAPI enum.
 * - arr-sdk 0.7.0 fixed it upstream by translating string event types to
 *   their numeric .NET enum value inside the SDK before forwarding the
 *   request. We pin to ^0.7.1 (which also fixed a union-client TS issue).
 * - This file's intermediate state (PR #479) used a client-side workaround
 *   that fetched unfiltered history and dropped non-grab records in JS.
 *   That workaround has been reverted now that the SDK fix is in place.
 *
 * These tests pin the current contract:
 *
 *   1. `client.history.get` IS called with `eventType: "grabbed"` so the
 *      SDK can encode it numerically and the server pre-filters. Dropping
 *      the eventType silently would shrink the detection window by mixing
 *      in import/delete/rename events from the same page.
 *   2. `pageSize` stays at 100 (pre-filtered grabs are dense — no need to
 *      widen the window the way the client-side workaround had to).
 *   3. The per-record `if (record.eventType !== "grabbed") continue;` guard
 *      stays as defense-in-depth — arr-sdk's encodeEventType returns
 *      `undefined` on unknown enum keys and buildQueryParams silently
 *      strips it, so a typo / SDK regression / upstream enum rename could
 *      bypass the server filter and over-count imports as grabs without
 *      the JS guard. Each `describe` block has a "rejects non-grabbed
 *      events client-side" test pinning this.
 *   4. Records older than `searchStartTime` are filtered out client-side.
 *   5. Grab records matching searched IDs (movie/series/episode/album/book)
 *      are returned in the result.
 *   6. The catch branch falls back to queue detection on history failures.
 */

import type { LidarrClient } from "arr-sdk/lidarr";
import type { RadarrClient } from "arr-sdk/radarr";
import type { ReadarrClient } from "arr-sdk/readarr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	detectGrabbedItemsFromHistoryWithSdk,
	detectLidarrGrabbedItems,
	detectReadarrGrabbedItems,
} from "../grab-detector.js";
import type { ApiCallCounter } from "../pagination-helpers.js";

const stubLogger = {
	child: vi.fn().mockReturnThis(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
};

interface HistoryRecord {
	eventType: string;
	date: string;
	movieId?: number;
	seriesId?: number;
	episodeId?: number;
	sourceTitle?: string;
}

function makeClient(records: HistoryRecord[]): {
	client: RadarrClient;
	getMock: ReturnType<typeof vi.fn>;
} {
	const getMock = vi.fn().mockResolvedValue({ records });
	const client = {
		history: { get: getMock },
	} as unknown as RadarrClient;
	return { client, getMock };
}

const FUTURE = new Date("2030-01-01T00:00:00Z");
const PAST = new Date("2020-01-01T00:00:00Z");

describe("detectGrabbedItemsFromHistoryWithSdk", () => {
	let counter: ApiCallCounter;

	beforeEach(() => {
		counter = { count: 0 };
		// Stub the 10s grab-check delay so tests are fast — the delay is
		// production-realism, not behavior under test.
		vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
			fn();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);
	});

	it("sends eventType='grabbed' to the history endpoint (issue #472 regression pin)", async () => {
		const { client, getMock } = makeClient([]);

		await detectGrabbedItemsFromHistoryWithSdk(
			client,
			PAST,
			[1],
			[],
			[],
			counter,
			stubLogger as never,
		);

		expect(getMock).toHaveBeenCalledTimes(1);
		const options = getMock.mock.calls[0]![0] as Record<string, unknown>;
		// arr-sdk 0.7.0+ translates this string to the numeric .NET enum value
		// before sending; a future revert to client-side filtering would drop
		// this property and trip this test.
		expect(options.eventType).toBe("grabbed");
		expect(options.sortKey).toBe("date");
		expect(options.sortDirection).toBe("descending");
		// pageSize stays tight at 100 because the server pre-filters to grabs
		// only. An accidental bump to 250 (the old workaround size) would
		// signal someone restoring the client-side filter.
		expect(options.pageSize).toBe(100);
	});

	it("filters out grabbed records older than searchStartTime", async () => {
		const { client } = makeClient([
			{
				eventType: "grabbed",
				date: "2026-05-26T12:00:00Z",
				movieId: 42,
				sourceTitle: "Old grab — predates this hunt",
			},
		]);

		const result = await detectGrabbedItemsFromHistoryWithSdk(
			client,
			FUTURE,
			[42],
			[],
			[],
			counter,
			stubLogger as never,
		);

		expect(result.failed).toBe(false);
		expect(result.items).toEqual([]);
	});

	it("returns grabbed records matching any of the searched ID buckets", async () => {
		// All records carry eventType="grabbed" since the server pre-filters
		// (post-#472, post-#479-revert). The fourth record's movieId 99 isn't
		// in any searched bucket and should be dropped by the ID match.
		const { client } = makeClient([
			{ eventType: "grabbed", date: "2026-05-26T12:00:00Z", movieId: 1, sourceTitle: "Movie 1" },
			{ eventType: "grabbed", date: "2026-05-26T12:00:00Z", seriesId: 2, sourceTitle: "Series 2" },
			{
				eventType: "grabbed",
				date: "2026-05-26T12:00:00Z",
				episodeId: 3,
				sourceTitle: "Episode 3",
			},
			{
				eventType: "grabbed",
				date: "2026-05-26T12:00:00Z",
				movieId: 99,
				sourceTitle: "Unmatched movie",
			},
		]);

		const result = await detectGrabbedItemsFromHistoryWithSdk(
			client,
			PAST,
			[1],
			[2],
			[3],
			counter,
			stubLogger as never,
		);

		expect(result.failed).toBe(false);
		expect(result.items.map((i) => i.title)).toEqual(["Movie 1", "Series 2", "Episode 3"]);
	});

	it("rejects non-grabbed events client-side even if the server returns them (defense)", async () => {
		// arr-sdk's encodeEventType returns undefined on unknown enum keys and
		// buildQueryParams strips undefined — so a typo, SDK regression, or
		// upstream enum rename could silently bypass the server-side filter
		// and return ALL event types. The per-record JS guard catches this:
		// without it, imports/deletes sharing a movieId with a searched item
		// would be over-counted as grabs.
		const { client } = makeClient([
			{
				eventType: "downloadFolderImported",
				date: "2026-05-26T12:00:00Z",
				movieId: 42,
				sourceTitle: "Should be ignored — import",
			},
			{
				eventType: "movieFileDeleted",
				date: "2026-05-26T12:00:00Z",
				movieId: 42,
				sourceTitle: "Should be ignored — delete",
			},
			{
				eventType: "grabbed",
				date: "2026-05-26T12:00:00Z",
				movieId: 42,
				sourceTitle: "The actual grab",
			},
		]);

		const result = await detectGrabbedItemsFromHistoryWithSdk(
			client,
			PAST,
			[42],
			[],
			[],
			counter,
			stubLogger as never,
		);

		expect(result.failed).toBe(false);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.title).toBe("The actual grab");
	});

	it("falls back to queue detection when history.get rejects", async () => {
		// Simulates network/auth/transient failure on the history call.
		// Queue fallback must still return matching items so itemsGrabbed is
		// reported accurately when only the history path is broken.
		const historyMock = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
		const queueMock = vi.fn().mockResolvedValue({
			records: [
				{
					movieId: 42,
					title: "From queue fallback",
					quality: { quality: { name: "WEBDL-1080p" } },
				},
			],
		});
		const client = {
			history: { get: historyMock },
			queue: { get: queueMock },
		} as unknown as RadarrClient;

		const result = await detectGrabbedItemsFromHistoryWithSdk(
			client,
			PAST,
			[42],
			[],
			[],
			counter,
			stubLogger as never,
		);

		expect(historyMock).toHaveBeenCalledTimes(1);
		expect(queueMock).toHaveBeenCalledTimes(1);
		expect(result.failed).toBe(false);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.title).toBe("From queue fallback");
	});
});

// ===========================================================================
// Lidarr parity tests (issue #472 regression pin across services)
//
// The fix was applied identically to Lidarr and Readarr — without service-
// specific tests, a future contributor "cleaning up" only one branch would
// silently re-introduce the bug for that service while these tests pass.
// ===========================================================================

describe("detectLidarrGrabbedItems", () => {
	let counter: ApiCallCounter;

	beforeEach(() => {
		counter = { count: 0 };
		vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
			fn();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);
	});

	it("sends eventType='grabbed' to the history endpoint (issue #472 regression pin)", async () => {
		const getMock = vi.fn().mockResolvedValue({ records: [] });
		const client = { history: { get: getMock } } as unknown as LidarrClient;

		await detectLidarrGrabbedItems(client, PAST, [1], counter, stubLogger as never);

		const options = getMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(options.eventType).toBe("grabbed");
		expect(options.pageSize).toBe(100);
	});

	it("matches by albumId on pre-filtered grab records", async () => {
		const getMock = vi.fn().mockResolvedValue({
			records: [
				{
					eventType: "grabbed",
					date: "2026-05-26T12:00:00Z",
					albumId: 7,
					sourceTitle: "The actual album grab",
				},
				{
					eventType: "grabbed",
					date: "2026-05-26T12:00:00Z",
					albumId: 99,
					sourceTitle: "Unmatched album",
				},
			],
		});
		const client = { history: { get: getMock } } as unknown as LidarrClient;

		const result = await detectLidarrGrabbedItems(client, PAST, [7], counter, stubLogger as never);

		expect(result.failed).toBe(false);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.title).toBe("The actual album grab");
	});

	it("rejects non-grabbed events client-side even if the server returns them (defense)", async () => {
		const getMock = vi.fn().mockResolvedValue({
			records: [
				{
					eventType: "trackFileImported",
					date: "2026-05-26T12:00:00Z",
					albumId: 7,
					sourceTitle: "Should be ignored — import",
				},
				{
					eventType: "grabbed",
					date: "2026-05-26T12:00:00Z",
					albumId: 7,
					sourceTitle: "The actual album grab",
				},
			],
		});
		const client = { history: { get: getMock } } as unknown as LidarrClient;

		const result = await detectLidarrGrabbedItems(client, PAST, [7], counter, stubLogger as never);

		expect(result.failed).toBe(false);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.title).toBe("The actual album grab");
	});
});

// ===========================================================================
// Readarr parity tests (issue #472 regression pin across services)
// ===========================================================================

describe("detectReadarrGrabbedItems", () => {
	let counter: ApiCallCounter;

	beforeEach(() => {
		counter = { count: 0 };
		vi.spyOn(global, "setTimeout").mockImplementation(((fn: () => void) => {
			fn();
			return 0 as unknown as ReturnType<typeof setTimeout>;
		}) as typeof setTimeout);
	});

	it("sends eventType='grabbed' to the history endpoint (issue #472 regression pin)", async () => {
		const getMock = vi.fn().mockResolvedValue({ records: [] });
		const client = { history: { get: getMock } } as unknown as ReadarrClient;

		await detectReadarrGrabbedItems(client, PAST, [1], counter, stubLogger as never);

		const options = getMock.mock.calls[0]![0] as Record<string, unknown>;
		expect(options.eventType).toBe("grabbed");
		expect(options.pageSize).toBe(100);
	});

	it("matches by bookId on pre-filtered grab records", async () => {
		const getMock = vi.fn().mockResolvedValue({
			records: [
				{
					eventType: "grabbed",
					date: "2026-05-26T12:00:00Z",
					bookId: 11,
					sourceTitle: "The actual book grab",
				},
				{
					eventType: "grabbed",
					date: "2026-05-26T12:00:00Z",
					bookId: 99,
					sourceTitle: "Unmatched book",
				},
			],
		});
		const client = { history: { get: getMock } } as unknown as ReadarrClient;

		const result = await detectReadarrGrabbedItems(
			client,
			PAST,
			[11],
			counter,
			stubLogger as never,
		);

		expect(result.failed).toBe(false);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.title).toBe("The actual book grab");
	});

	it("rejects non-grabbed events client-side even if the server returns them (defense)", async () => {
		const getMock = vi.fn().mockResolvedValue({
			records: [
				{
					eventType: "bookFileImported",
					date: "2026-05-26T12:00:00Z",
					bookId: 11,
					sourceTitle: "Should be ignored — import",
				},
				{
					eventType: "grabbed",
					date: "2026-05-26T12:00:00Z",
					bookId: 11,
					sourceTitle: "The actual book grab",
				},
			],
		});
		const client = { history: { get: getMock } } as unknown as ReadarrClient;

		const result = await detectReadarrGrabbedItems(
			client,
			PAST,
			[11],
			counter,
			stubLogger as never,
		);

		expect(result.failed).toBe(false);
		expect(result.items).toHaveLength(1);
		expect(result.items[0]!.title).toBe("The actual book grab");
	});
});
