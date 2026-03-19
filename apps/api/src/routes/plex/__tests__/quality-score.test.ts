import { describe, expect, it } from "vitest";
import { computeQualityScore, type SnapshotForQuality } from "../lib/quality-score-helpers.js";

function snapshot(capturedAt: string, sessions: Array<Record<string, unknown>>): SnapshotForQuality {
	return {
		capturedAt: new Date(capturedAt),
		sessionsJson: JSON.stringify(sessions),
	};
}

describe("computeQualityScore", () => {
	it("returns 0 for no snapshots", () => {
		const result = computeQualityScore([]);
		expect(result.overallScore).toBe(0);
		expect(result.trend).toEqual([]);
		expect(result.perUser).toEqual([]);
	});

	it("scores 100% direct play + 1080p highly", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", [
				{ user: "alice", videoDecision: "direct play", videoResolution: "1080" },
			]),
		];

		const result = computeQualityScore(snapshots);
		// Direct play: 100, Resolution: 75, Transcode inverse: 100
		// Score = 100 * 0.4 + 75 * 0.3 + 100 * 0.3 = 40 + 22.5 + 30 = 92.5 → 93
		expect(result.overallScore).toBe(93);
		expect(result.breakdown.directPlayScore).toBe(100);
		expect(result.breakdown.resolutionScore).toBe(75);
		expect(result.breakdown.transcodeScore).toBe(100);
	});

	it("scores 100% transcode + SD poorly", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", [
				{ user: "bob", videoDecision: "transcode", videoResolution: "480" },
			]),
		];

		const result = computeQualityScore(snapshots);
		// Direct play: 0, Resolution: 25, Transcode inverse: 0
		// Score = 0 + 7.5 + 0 = 8
		expect(result.overallScore).toBe(8);
	});

	it("computes daily trend", () => {
		const snapshots = [
			snapshot("2025-01-14T10:00:00Z", [
				{ user: "alice", videoDecision: "transcode", videoResolution: "720" },
			]),
			snapshot("2025-01-15T10:00:00Z", [
				{ user: "alice", videoDecision: "direct play", videoResolution: "2160" },
			]),
		];

		const result = computeQualityScore(snapshots);
		expect(result.trend).toHaveLength(2);
		// Day 2 should score higher than day 1
		expect(result.trend[1]!.score).toBeGreaterThan(result.trend[0]!.score);
	});

	it("computes per-user scores", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", [
				{ user: "alice", videoDecision: "direct play", videoResolution: "2160" },
				{ user: "bob", videoDecision: "transcode", videoResolution: "480" },
			]),
		];

		const result = computeQualityScore(snapshots);
		const alice = result.perUser.find((u) => u.username === "alice");
		const bob = result.perUser.find((u) => u.username === "bob");
		expect(alice!.score).toBeGreaterThan(bob!.score);
	});

	it("treats missing videoDecision as unknown (not direct play)", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", [
				{ user: "alice", videoResolution: "1080" },
			]),
		];

		const result = computeQualityScore(snapshots);
		// null/undefined videoDecision is NOT counted as direct play
		expect(result.breakdown.directPlayScore).toBe(0);
		// It's also not a transcode, so transcodeScore stays at 100
		expect(result.breakdown.transcodeScore).toBe(100);
	});

	it("handles malformed sessionsJson", () => {
		const snapshots: SnapshotForQuality[] = [
			{ capturedAt: new Date(), sessionsJson: "bad" },
		];
		const result = computeQualityScore(snapshots);
		expect(result.overallScore).toBe(0);
	});
});
