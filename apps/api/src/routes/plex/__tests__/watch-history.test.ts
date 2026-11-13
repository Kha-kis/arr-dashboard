import { describe, expect, it } from "vitest";
import {
	createWatchHistoryAccumulator,
	deduplicateWatchEvents,
	type SnapshotForHistory,
} from "../lib/watch-history-helpers.js";
import { activitySnapshot } from "./native-activity-test-fixtures.js";

function snapshot(
	capturedAt: string,
	sessions: Array<Record<string, unknown>>,
): SnapshotForHistory {
	return activitySnapshot(capturedAt, sessions);
}

describe("deduplicateWatchEvents", () => {
	it("returns unique play events from snapshots", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", [
				{ user: "alice", title: "Movie A", platform: "Roku", videoDecision: "direct play" },
			]),
			snapshot("2025-01-15T09:00:00Z", [
				{ user: "bob", title: "Movie B", platform: null, videoDecision: "transcode" },
			]),
		];

		const result = deduplicateWatchEvents(snapshots, 50);
		expect(result.events).toHaveLength(2);
		expect(result.events[0]?.user).toBe("alice");
		expect(result.events[0]?.title).toBe("Movie A");
		expect(result.events[1]?.user).toBe("bob");
	});

	it("deduplicates consecutive sessions for same user+title within 10min", () => {
		const snapshots = [
			snapshot("2025-01-15T10:10:00Z", [{ user: "alice", title: "Movie A" }]),
			snapshot("2025-01-15T10:05:00Z", [{ user: "alice", title: "Movie A" }]),
			snapshot("2025-01-15T10:00:00Z", [{ user: "alice", title: "Movie A" }]),
		];

		const result = deduplicateWatchEvents(snapshots, 50);
		// All 3 are within 10 min windows, so they collapse to 1 event
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.timestamp).toBe("2025-01-15T10:10:00.000Z");
	});

	it("keeps continuous 0/5/10/15-minute ticks in one chained event using newest metadata", () => {
		const snapshots = [
			snapshot("2025-01-15T10:15:00Z", [
				{ user: "alice", title: "Movie A", platform: "Web", videoDecision: "direct play" },
			]),
			snapshot("2025-01-15T10:10:00Z", [
				{ user: "alice", title: "Movie A", platform: "Roku", videoDecision: "transcode" },
			]),
			snapshot("2025-01-15T10:05:00Z", [
				{ user: "alice", title: "Movie A", platform: "Tablet", videoDecision: "transcode" },
			]),
			snapshot("2025-01-15T10:00:00Z", [
				{ user: "alice", title: "Movie A", platform: "TV", videoDecision: "transcode" },
			]),
		];

		expect(deduplicateWatchEvents(snapshots, 50).events).toMatchObject([
			{
				user: "alice",
				title: "Movie A",
				timestamp: "2025-01-15T10:15:00.000Z",
				platform: "Web",
				videoDecision: "direct play",
			},
		]);
	});

	it("continues the tick chain across page boundaries", () => {
		const snapshots = [
			snapshot("2025-01-15T10:15:00Z", [
				{ user: "alice", title: "Movie A", platform: "Web", videoDecision: "direct play" },
			]),
			snapshot("2025-01-15T10:10:00Z", [
				{ user: "alice", title: "Movie A", platform: "Roku", videoDecision: "transcode" },
			]),
			snapshot("2025-01-15T10:05:00Z", [
				{ user: "alice", title: "Movie A", platform: "Tablet", videoDecision: "transcode" },
			]),
			snapshot("2025-01-15T10:00:00Z", [
				{ user: "alice", title: "Movie A", platform: "TV", videoDecision: "transcode" },
			]),
		];
		const accumulator = createWatchHistoryAccumulator(50);
		accumulator.addBatch(snapshots.slice(0, 2));
		accumulator.addBatch(snapshots.slice(2));
		expect(accumulator.getResult().events).toMatchObject([
			{
				user: "alice",
				title: "Movie A",
				timestamp: "2025-01-15T10:15:00.000Z",
				platform: "Web",
				videoDecision: "direct play",
			},
		]);
	});

	it("scans malformed rows after reaching the requested output limit", () => {
		const accumulator = createWatchHistoryAccumulator(1);
		accumulator.addBatch([
			snapshot("2025-01-15T10:15:00Z", [{ user: "alice", title: "Newest" }]),
			snapshot("2025-01-15T10:00:00Z", [{ user: "bob", title: "Older" }]),
			{ capturedAt: new Date("2025-01-15T09:00:00Z"), sessionsJson: "broken" },
		]);
		expect(accumulator.getResult()).toMatchObject({
			events: [
				{
					user: "alice",
					title: "Newest",
					timestamp: "2025-01-15T10:15:00.000Z",
					platform: null,
					videoDecision: null,
				},
			],
			parseFailures: 1,
			totalSnapshots: 3,
			failedPreviews: [],
		});
	});

	it("keeps separate events when gap exceeds 10 minutes", () => {
		const snapshots = [
			snapshot("2025-01-15T10:10:00.001Z", [{ user: "alice", title: "Movie A" }]),
			snapshot("2025-01-15T10:00:00Z", [{ user: "alice", title: "Movie A" }]),
		];

		const result = deduplicateWatchEvents(snapshots, 50);
		// One millisecond beyond the inclusive ten-minute boundary is a new event.
		expect(result.events).toHaveLength(2);
	});

	it("respects limit parameter", () => {
		const snapshots = Array.from({ length: 20 }, (_, i) =>
			snapshot(`2025-01-15T${String(i).padStart(2, "0")}:00:00Z`, [
				{ user: `user${i}`, title: `Movie ${i}` },
			]),
		);

		const result = deduplicateWatchEvents(snapshots, 5);
		expect(result.events).toHaveLength(5);
	});

	it("handles malformed sessionsJson", () => {
		const snapshots: SnapshotForHistory[] = [{ capturedAt: new Date(), sessionsJson: "not-json" }];
		const result = deduplicateWatchEvents(snapshots, 50);
		expect(result.events).toEqual([]);
	});

	it.each([
		["null", "null"],
		["empty object", "{}"],
		["number", "42"],
	])("treats valid-but-non-iterable JSON (%s) as a parse failure", (_label, sessionsJson) => {
		const result = deduplicateWatchEvents([{ capturedAt: new Date(), sessionsJson }], 50);
		expect(result.parseFailures).toBe(1);
		expect(result.failedPreviews).toEqual([]);
		expect(result.events).toEqual([]);
	});
});
