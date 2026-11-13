import { describe, expect, it } from "vitest";
import {
	aggregatePlaysByDate,
	createPlaysByDateAccumulator,
	type SnapshotForPlaysByDate,
} from "../lib/plays-by-date-helpers.js";
import { activitySnapshot } from "./native-activity-test-fixtures.js";

function snapshot(capturedAt: string, sessions: unknown): SnapshotForPlaysByDate {
	return Array.isArray(sessions)
		? activitySnapshot(capturedAt, sessions)
		: { capturedAt: new Date(capturedAt), sessionsJson: JSON.stringify(sessions) };
}

describe("aggregatePlaysByDate", () => {
	it("preserves a user-title dedup anchor across pages and the inclusive ten-minute boundary", () => {
		const rows = [
			snapshot("2026-10-04T23:55:00.000Z", [{ user: "alice", title: "Film", mediaType: "movie" }]),
			snapshot("2026-10-05T00:05:00.000Z", [{ user: "alice", title: "Film", mediaType: "movie" }]),
			snapshot("2026-10-05T00:15:00.000Z", [{ user: "alice", title: "Film", mediaType: "movie" }]),
			snapshot("2026-10-05T00:25:00.001Z", [{ user: "alice", title: "Film", mediaType: "movie" }]),
		];
		const accumulator = createPlaysByDateAccumulator({
			days: 2,
			now: new Date("2026-10-05T12:00:00.000Z"),
		});
		accumulator.addBatch(rows.slice(0, 2));
		accumulator.addBatch(rows.slice(2, 3));
		accumulator.addBatch(rows.slice(3));

		expect(accumulator.getResult()).toEqual({
			categories: ["2026-10-04", "2026-10-05"],
			unidentifiedPlaybackSessions: [0, 0],
			invalidDetailSnapshots: [0, 0],
			series: [
				{ name: "Movies", data: [1, 1] },
				{ name: "TV", data: [0, 0] },
				{ name: "Music", data: [0, 0] },
			],
		});
	});

	it("keeps the array API sorted and ignores malformed, non-array, and unsupported rows", () => {
		const rows = [
			snapshot("2026-10-05T00:10:00.000Z", [{ user: "alice", title: "Film", mediaType: "movie" }]),
			snapshot("2026-10-05T00:00:00.000Z", [{ user: "alice", title: "Film", mediaType: "movie" }]),
			{ capturedAt: new Date("2026-10-05T00:12:00.000Z"), sessionsJson: "null" },
			{ capturedAt: new Date("2026-10-05T00:13:00.000Z"), sessionsJson: "not-json" },
			snapshot("2026-10-05T00:14:00.000Z", [{ user: "alice", title: "Other", mediaType: "other" }]),
		];
		expect(aggregatePlaysByDate(rows, { days: 1, now: new Date("2026-10-05T12:00:00Z") })).toEqual({
			categories: ["2026-10-05"],
			unidentifiedPlaybackSessions: [0],
			invalidDetailSnapshots: [2],
			series: [
				{ name: "Movies", data: [1] },
				{ name: "TV", data: [0] },
				{ name: "Music", data: [0] },
			],
		});
	});
});
