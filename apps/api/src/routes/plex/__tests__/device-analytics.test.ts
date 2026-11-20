import { describe, expect, it } from "vitest";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import {
	aggregateDeviceAnalytics,
	createDeviceAnalyticsAccumulator,
	type SnapshotForDevice,
} from "../lib/device-analytics-helpers.js";

function snapshot(
	sessions: unknown[],
	provider: "PLEX" | "JELLYFIN" | "EMBY" = "PLEX",
	axis: string | null = provider === "PLEX" ? "platform" : "client",
): SnapshotForDevice & { concurrentStreams: number; measurementJson: string } {
	return {
		sessionsJson: JSON.stringify(sessions),
		concurrentStreams: sessions.length,
		measurementJson: JSON.stringify({
			version: 1,
			provider,
			...(axis === null ? {} : { deviceLabelAxis: axis }),
			status: "active",
			observedSessions: sessions.length,
			bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
			bandwidth: {
				status: "unavailable",
				observedSessions: sessions.length,
				measuredSessions: 0,
				knownTotalKbps: null,
			},
			methods: {
				directPlayCount: 0,
				transcodeCount: 0,
				directStreamCount: 0,
				unknownDecisionCount: sessions.length,
			},
			network: { status: "unavailable", lanKbps: null, wanKbps: null },
		}),
	};
}

describe("aggregateDeviceAnalytics", () => {
	it.each([null, 7, {}, [], "", " ", "Roku\u0000", "x".repeat(257), " UNKNOWN "])(
		"keeps malformed label %s unknown without discarding independent player evidence",
		(platform) => {
			const result = aggregateDeviceAnalytics([snapshot([{ platform, player: "Player" }])]);
			expect(result).toMatchObject({
				platforms: [{ platform: "unknown", sessions: 1, percent: 100 }],
				players: [{ platform: "unknown", player: "Player", sessions: 1 }],
				measurement: {
					platformMeasuredSessions: 0,
					playerMeasuredSessions: 1,
					observedSessions: 1,
				},
			});
		},
	);
	it.each(["JELLYFIN", "EMBY"] as const)(
		"retains native %s device labels without certifying old client/platform fallback",
		(provider) => {
			const result = aggregateDeviceAnalytics([
				snapshot([{ platform: "Named device", player: "Named device" }], provider, null),
			]);
			expect(result).toMatchObject({
				platforms: [{ platform: "unknown", sessions: 1, percent: 100 }],
				players: [{ platform: "unknown", player: "Named device", sessions: 1 }],
				measurement: {
					platformMeasuredSessions: 0,
					playerMeasuredSessions: 1,
					unverifiedPlatformSnapshots: 1,
					platformAxis: "client",
				},
			});
			const current = aggregateDeviceAnalytics([
				snapshot([{ platform: "Client app", player: "Named device" }], provider),
			]);
			expect(current).toMatchObject({
				platforms: [{ platform: "Client app", sessions: 1, percent: 100 }],
				players: [{ platform: "Client app", player: "Named device", sessions: 1 }],
				measurement: { status: "complete", unverifiedPlatformSnapshots: 0, platformAxis: "client" },
			});
		},
	);
	it.each(["broken", "[]", "null", "{}"])(
		"retains the native denominator when detail %s is unusable",
		(sessionsJson) => {
			const result = aggregateDeviceAnalytics([{ ...snapshot([{}]), sessionsJson }]);
			expect(result).toMatchObject({
				totalSessions: 1,
				platforms: [{ platform: "unknown", sessions: 1, percent: 100 }],
				players: [{ platform: "unknown", player: "unknown", sessions: 1 }],
				measurement: { invalidDetailSnapshots: 1, status: "unavailable" },
			});
		},
	);
	it("distinguishes invalid, failed and idle collection and retains raw read coverage", () => {
		const result = aggregateDeviceAnalytics([
			buildFailedSessionSnapshot("PLEX"),
			buildPlexSessionSnapshot([]),
			{ ...snapshot([{}]), concurrentStreams: 2 },
		]);
		expect(result).toMatchObject({
			totalSessions: 0,
			measurement: { collection: { failedSnapshots: 1, idleSnapshots: 1, invalidSnapshots: 1 } },
		});
		const accumulator = createDeviceAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot([{ platform: "Roku", player: "Player" }])]);
		expect(
			accumulator.getResult({
				activeSnapshots: 1,
				failedSnapshots: 2,
				idleSnapshots: 3,
				legacySnapshots: 0,
				invalidSnapshots: 1,
			}),
		).toMatchObject({
			totalSnapshots: 7,
			parseFailures: 1,
			measurement: {
				status: "partial",
				collection: {
					activeSnapshots: 1,
					failedSnapshots: 2,
					idleSnapshots: 3,
					invalidSnapshots: 1,
				},
			},
		});
	});
	it.each(["JELLYFIN", "EMBY"] as const)(
		"never substitutes a %s device name for the absent client app during capture",
		(provider) => {
			const row = buildJellyfinSessionSnapshot(
				[
					{
						id: "session",
						isPaused: false,
						positionMs: 0,
						durationMs: 0,
						deviceName: "Named device",
					},
				],
				provider,
			);
			expect(JSON.parse(row.sessionsJson)).toMatchObject([
				{ platform: null, player: "Named device" },
			]);
			expect(JSON.parse(row.measurementJson)).toMatchObject({ deviceLabelAxis: "client" });
		},
	);
	it("keeps usable neighbours and independently counts missing labels in native detail", () => {
		const result = aggregateDeviceAnalytics([
			{
				sessionsJson: JSON.stringify([
					{ platform: " Roku ", player: " Player " },
					{ player: "Other player" },
					null,
				]),
				concurrentStreams: 3,
				measurementJson: JSON.stringify({
					version: 1,
					provider: "PLEX",
					status: "active",
					observedSessions: 3,
					bandwidthBasis: "provider-reported",
					bandwidth: {
						status: "unavailable",
						observedSessions: 3,
						measuredSessions: 0,
						knownTotalKbps: null,
					},
					methods: {
						directPlayCount: 0,
						transcodeCount: 0,
						directStreamCount: 0,
						unknownDecisionCount: 3,
					},
					network: { status: "unavailable", lanKbps: null, wanKbps: null },
				}),
			} as SnapshotForDevice & { concurrentStreams: number; measurementJson: string },
		]);
		expect(result).toMatchObject({
			totalSessions: 3,
			platforms: [
				{ platform: "unknown", sessions: 2, percent: 66.7 },
				{ platform: "Roku", sessions: 1, percent: 33.3 },
			],
			players: [
				{ player: "Player", platform: "Roku", sessions: 1 },
				{ player: "Other player", platform: "unknown", sessions: 1 },
				{ player: "unknown", platform: "unknown", sessions: 1 },
			],
			measurement: {
				status: "partial",
				observedSessions: 3,
				platformMeasuredSessions: 1,
				playerMeasuredSessions: 2,
				invalidDetailSnapshots: 1,
			},
		});
	});
	it("preserves declared legacy observations without certifying legacy device labels", () => {
		const result = aggregateDeviceAnalytics([
			{
				sessionsJson: JSON.stringify([{ platform: "Roku", player: "Player" }]),
				concurrentStreams: 4,
				measurementJson: null,
			} as SnapshotForDevice & { concurrentStreams: number; measurementJson: null },
		]);
		expect(result).toMatchObject({
			totalSessions: 4,
			platforms: [{ platform: "unknown", sessions: 4, percent: 100 }],
			players: [{ player: "unknown", platform: "unknown", sessions: 4 }],
			measurement: {
				status: "unavailable",
				observedSessions: 4,
				platformMeasuredSessions: 0,
				playerMeasuredSessions: 0,
				collection: { legacySnapshots: 1 },
			},
		});
	});
	it("counts platform and player distributions", () => {
		const snapshots = [
			snapshot([
				{ platform: "Roku", player: "Roku Ultra" },
				{ platform: "iOS", player: "Plex for iOS" },
			]),
			snapshot([{ platform: "Roku", player: "Roku Ultra" }]),
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

	it.each(["HTPC::Player", 'Player::"quoted"::🎬'])(
		"preserves the full player label %s",
		(player) => {
			const result = aggregateDeviceAnalytics([snapshot([{ platform: "Host", player }])]);
			expect(result.players).toEqual([{ player, platform: "Host", sessions: 1 }]);
		},
	);

	it("keeps delimiter-colliding player/platform pairs distinct across pages", () => {
		const accumulator = createDeviceAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot([{ player: "Player::Variant", platform: "Host" }])]);
		accumulator.addSnapshots([snapshot([{ player: "Player", platform: "Variant::Host" }])]);
		expect(accumulator.getResult().players).toEqual([
			{ player: "Player::Variant", platform: "Host", sessions: 1 },
			{ player: "Player", platform: "Variant::Host", sessions: 1 },
		]);
	});

	it("aggregates repeated delimiter-containing pairs without truncating labels", () => {
		const accumulator = createDeviceAnalyticsAccumulator();
		for (let page = 0; page < 2; page++) {
			accumulator.addSnapshots([snapshot([{ player: "Player::Variant", platform: "Host::OS" }])]);
		}
		expect(accumulator.getResult().players).toEqual([
			{ player: "Player::Variant", platform: "Host::OS", sessions: 2 },
		]);
	});

	it("keeps an earlier result stable when later pages add sessions", () => {
		const accumulator = createDeviceAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot([{ player: "Player", platform: "Host" }])]);
		const first = accumulator.getResult();
		accumulator.addSnapshots([snapshot([{ player: "Player", platform: "Host" }])]);
		expect(first.players).toEqual([{ player: "Player", platform: "Host", sessions: 1 }]);
		expect(accumulator.getResult().players).toEqual([
			{ player: "Player", platform: "Host", sessions: 2 },
		]);
	});

	it("does not let mutation of a returned player alter accumulator counts", () => {
		const accumulator = createDeviceAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot([{ player: "Player", platform: "Host" }])]);
		accumulator.getResult().players[0]!.sessions = 99;
		expect(accumulator.getResult().players).toEqual([
			{ player: "Player", platform: "Host", sessions: 1 },
		]);
	});

	it("does not coerce a native numeric player label into a measured device", () => {
		expect(aggregateDeviceAnalytics([snapshot([{ player: 7, platform: "Host" }])]).players).toEqual(
			[{ player: "unknown", platform: "Host", sessions: 1 }],
		);
	});

	it.each([
		["null", "null"],
		["empty object", "{}"],
		["number", "42"],
	])("treats valid-but-non-iterable JSON (%s) as a parse failure", (_label, sessionsJson) => {
		const result = aggregateDeviceAnalytics([{ sessionsJson }]);
		expect(result.parseFailures).toBe(1);
		expect(result.failedPreviews).toEqual([]);
		expect(result.totalSessions).toBe(0);
	});

	it("accumulates uneven pages before calculating global platform percentages", () => {
		const batches = [
			[snapshot([{ platform: "Roku", player: "Roku Ultra" }])],
			[
				snapshot([
					{ platform: "iOS", player: "Plex" },
					{ platform: "iOS", player: "Plex" },
				]),
				snapshot([{ platform: null, player: null }]),
				{ sessionsJson: "broken-json" },
				{ sessionsJson: "null" },
			],
		];
		const accumulator = createDeviceAnalyticsAccumulator();
		for (const batch of batches) accumulator.addSnapshots(batch);
		const expected = {
			platforms: [
				{ platform: "iOS", sessions: 2, percent: 50 },
				{ platform: "Roku", sessions: 1, percent: 25 },
				{ platform: "unknown", sessions: 1, percent: 25 },
			],
			players: [
				{ player: "Plex", platform: "iOS", sessions: 2 },
				{ player: "Roku Ultra", platform: "Roku", sessions: 1 },
				{ player: "unknown", platform: "unknown", sessions: 1 },
			],
			totalSessions: 4,
			parseFailures: 2,
			totalSnapshots: 5,
			failedPreviews: [],
		};
		expect(accumulator.getResult()).toMatchObject(expected);
		expect(aggregateDeviceAnalytics(batches.flat())).toMatchObject(expected);
	});
});
