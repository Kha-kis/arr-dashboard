import { describe, expect, it } from "vitest";
import { aggregateUserAnalytics, type SnapshotWithSessions } from "../lib/user-analytics-helpers.js";

function snapshot(overrides: Partial<SnapshotWithSessions> & { sessionsJson: string }): SnapshotWithSessions {
	return {
		capturedAt: new Date("2025-01-15T10:00:00Z"),
		...overrides,
	};
}

describe("aggregateUserAnalytics", () => {
	it("groups sessions by user and computes totals", () => {
		const snapshots = [
			snapshot({
				capturedAt: new Date("2025-01-15T10:00:00Z"),
				sessionsJson: JSON.stringify([
					{ user: "alice", title: "Movie A", bandwidth: 5000, state: "playing" },
					{ user: "bob", title: "Movie B", bandwidth: 3000, state: "playing" },
				]),
			}),
			snapshot({
				capturedAt: new Date("2025-01-15T10:05:00Z"),
				sessionsJson: JSON.stringify([
					{ user: "alice", title: "Movie A", bandwidth: 5000, state: "playing" },
				]),
			}),
		];

		const result = aggregateUserAnalytics(snapshots);
		expect(result.users).toHaveLength(2);
		expect(result.users[0]?.username).toBe("alice");
		expect(result.users[0]?.totalSessions).toBe(2);
		expect(result.users[0]?.estimatedWatchTimeMinutes).toBe(10);
		expect(result.users[1]?.username).toBe("bob");
		expect(result.users[1]?.totalSessions).toBe(1);
	});

	it("computes daily breakdown with user session counts", () => {
		const snapshots = [
			snapshot({
				capturedAt: new Date("2025-01-15T10:00:00Z"),
				sessionsJson: JSON.stringify([{ user: "alice", title: "X", bandwidth: 0, state: "playing" }]),
			}),
			snapshot({
				capturedAt: new Date("2025-01-16T10:00:00Z"),
				sessionsJson: JSON.stringify([{ user: "bob", title: "Y", bandwidth: 0, state: "playing" }]),
			}),
		];

		const result = aggregateUserAnalytics(snapshots);
		expect(result.dailyBreakdown).toHaveLength(2);
		expect(result.dailyBreakdown[0]?.date).toBe("2025-01-15");
		expect(result.dailyBreakdown[0]?.userSessions).toEqual({ alice: 1 });
		expect(result.dailyBreakdown[1]?.userSessions).toEqual({ bob: 1 });
	});

	it("returns empty analytics for no snapshots", () => {
		const result = aggregateUserAnalytics([]);
		expect(result.users).toEqual([]);
		expect(result.dailyBreakdown).toEqual([]);
	});

	it("handles malformed sessionsJson gracefully", () => {
		const result = aggregateUserAnalytics([
			snapshot({ sessionsJson: "not-json" }),
		]);
		expect(result.users).toEqual([]);
	});

	it("sorts users by total sessions descending", () => {
		const snapshots = [
			snapshot({
				sessionsJson: JSON.stringify([
					{ user: "charlie", title: "X", bandwidth: 0, state: "playing" },
					{ user: "charlie", title: "X", bandwidth: 0, state: "playing" },
					{ user: "alice", title: "Y", bandwidth: 0, state: "playing" },
				]),
			}),
		];
		// charlie has 2 sessions in one snapshot entry (2 entries in array)
		const result = aggregateUserAnalytics(snapshots);
		expect(result.users[0]?.username).toBe("charlie");
	});

	it("tracks mostRecentActivity correctly", () => {
		const snapshots = [
			snapshot({
				capturedAt: new Date("2025-01-10T10:00:00Z"),
				sessionsJson: JSON.stringify([{ user: "alice", title: "X", bandwidth: 0, state: "playing" }]),
			}),
			snapshot({
				capturedAt: new Date("2025-01-15T18:00:00Z"),
				sessionsJson: JSON.stringify([{ user: "alice", title: "Y", bandwidth: 0, state: "playing" }]),
			}),
		];

		const result = aggregateUserAnalytics(snapshots);
		expect(result.users[0]?.mostRecentActivity).toBe("2025-01-15T18:00:00.000Z");
	});
});
