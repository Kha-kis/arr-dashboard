/**
 * Tests for grab-detector.
 *
 * Issue #472 driver: Radarr 6.x / Sonarr 4.x reject `eventType=grabbed` as
 * an invalid history-endpoint query value ("The value 'grabbed' is not valid").
 * The fix dropped the server-side filter and moved it to client-side iteration.
 *
 * These tests pin the contract so a future contributor doesn't re-add the
 * broken server-side filter "for performance":
 *
 *   1. `client.history.get` is called WITHOUT `eventType` in the request options.
 *   2. Records whose `eventType !== "grabbed"` are filtered out client-side
 *      (otherwise we'd over-count by also matching imports/renames/deletes by ID).
 *   3. Records older than `searchStartTime` are still filtered out.
 *   4. Matching grab records (by movie/series/episode ID, with eventType=grabbed,
 *      newer than searchStartTime) are returned in the result.
 */

import type { RadarrClient } from "arr-sdk/radarr";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { detectGrabbedItemsFromHistoryWithSdk } from "../grab-detector.js";
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

	it("does NOT send eventType in the history request (issue #472 regression pin)", async () => {
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
		expect(options).not.toHaveProperty("eventType");
		// Sanity: still uses the expected sort + paging
		expect(options.sortKey).toBe("date");
		expect(options.sortDirection).toBe("descending");
		expect(options.pageSize).toBeGreaterThanOrEqual(100);
	});

	it("filters out non-grabbed event types client-side", async () => {
		// All three records match the searched movieId but only one is a grab.
		// Without client-side filtering, an import / delete would be miscounted
		// as a grab.
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
});
