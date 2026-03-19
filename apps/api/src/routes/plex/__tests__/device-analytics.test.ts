import { describe, expect, it } from "vitest";
import { aggregateDeviceAnalytics, type SnapshotForDevice } from "../lib/device-analytics-helpers.js";

function snapshot(sessions: Array<Record<string, unknown>>): SnapshotForDevice {
	return { sessionsJson: JSON.stringify(sessions) };
}

describe("aggregateDeviceAnalytics", () => {
	it("counts platform and player distributions", () => {
		const snapshots = [
			snapshot([
				{ platform: "Roku", player: "Roku Ultra" },
				{ platform: "iOS", player: "Plex for iOS" },
			]),
			snapshot([
				{ platform: "Roku", player: "Roku Ultra" },
			]),
		];

		const result = aggregateDeviceAnalytics(snapshots);
		expect(result.totalSessions).toBe(3);
		expect(result.platforms[0]).toEqual({ platform: "Roku", sessions: 2, percent: 66.7 });
		expect(result.players[0]).toEqual({ player: "Roku Ultra", platform: "Roku", sessions: 2 });
	});

	it("treats missing platform/player as 'unknown'", () => {
		const snapshots = [snapshot([{ platform: null, player: null }])];

		const result = aggregateDeviceAnalytics(snapshots);
		expect(result.platforms[0]?.platform).toBe("unknown");
		expect(result.players[0]?.player).toBe("unknown");
	});

	it("returns empty results for no snapshots", () => {
		const result = aggregateDeviceAnalytics([]);
		expect(result.totalSessions).toBe(0);
		expect(result.platforms).toEqual([]);
	});

	it("groups same player on different platforms separately", () => {
		const snapshots = [
			snapshot([
				{ platform: "iOS", player: "Plex" },
				{ platform: "Android", player: "Plex" },
			]),
		];

		const result = aggregateDeviceAnalytics(snapshots);
		expect(result.players).toHaveLength(2);
	});
});
