import { describe, expect, it } from "vitest";
import { deduplicateWatchEvents, type SnapshotForHistory } from "../lib/watch-history-helpers.js";

function snapshot(capturedAt: string, sessions: Array<Record<string, unknown>>): SnapshotForHistory {
	return {
		capturedAt: new Date(capturedAt),
		sessionsJson: JSON.stringify(sessions),
	};
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

	it("keeps separate events when gap exceeds 10 minutes", () => {
		const snapshots = [
			snapshot("2025-01-15T11:00:00Z", [{ user: "alice", title: "Movie A" }]),
			snapshot("2025-01-15T10:00:00Z", [{ user: "alice", title: "Movie A" }]),
		];

		const result = deduplicateWatchEvents(snapshots, 50);
		// 60min gap → treated as two separate viewings
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
		const snapshots: SnapshotForHistory[] = [
			{ capturedAt: new Date(), sessionsJson: "not-json" },
		];
		const result = deduplicateWatchEvents(snapshots, 50);
		expect(result.events).toEqual([]);
	});
});
