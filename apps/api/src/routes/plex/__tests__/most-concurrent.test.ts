import { describe, expect, it } from "vitest";
import {
	aggregateMostConcurrent,
	createMostConcurrentAccumulator,
	type SnapshotForConcurrent,
} from "../lib/most-concurrent-helpers.js";

const BASE_TIME = new Date("2025-09-01T12:00:00.000Z");

function snapshot(
	id: string,
	minutesAfter: number,
	concurrentStreams: number,
	totalBandwidth: number,
): SnapshotForConcurrent {
	return {
		id,
		capturedAt: new Date(BASE_TIME.getTime() + minutesAfter * 60_000),
		concurrentStreams,
		totalBandwidth,
		measurementJson: JSON.stringify({
			version: 1,
			provider: "PLEX",
			status: concurrentStreams === 0 ? "idle" : "active",
			observedSessions: concurrentStreams,
			bandwidthBasis: "provider-reported",
			bandwidth: {
				status: "complete",
				observedSessions: concurrentStreams,
				measuredSessions: concurrentStreams,
				knownTotalKbps: totalBandwidth,
			},
			methods: {
				directPlayCount: 0,
				directStreamCount: 0,
				transcodeCount: 0,
				unknownDecisionCount: concurrentStreams,
			},
			network:
				concurrentStreams === 0
					? { status: "complete", lanKbps: 0, wanKbps: 0 }
					: { status: "unavailable", lanKbps: null, wanKbps: null },
		}),
	};
}

describe("most-concurrent aggregation", () => {
	it("keeps the earliest ID-resolved peak and treats exactly 30 minutes as duplicate", () => {
		const result = aggregateMostConcurrent(
			[
				snapshot("peak-b", 0, 12, 120),
				snapshot("peak-a", 0, 12, 121),
				snapshot("at-boundary", 30, 11, 110),
				snapshot("after-boundary", 30.001, 8, 80),
			],
			{ limit: 2 },
		);

		expect(result).toMatchObject({
			peakConcurrent: 12,
			events: [
				{
					capturedAt: BASE_TIME.toISOString(),
					concurrentStreams: 12,
					totalBandwidth: 121,
				},
				{
					capturedAt: new Date(BASE_TIME.getTime() + 30.001 * 60_000).toISOString(),
					concurrentStreams: 8,
					totalBandwidth: 80,
				},
			],
		});
	});

	it("retains only the requested events while accumulating ranked page boundaries", () => {
		const accumulator = createMostConcurrentAccumulator({ limit: 2 });
		accumulator.addSnapshots([
			snapshot("001", 0, 12, 120),
			snapshot("002", 0, 12, 121),
			snapshot("003", 30, 11, 110),
		]);
		accumulator.addSnapshots([snapshot("004", 30, 9, 90)]);
		accumulator.addSnapshots([snapshot("005", 30.001, 8, 80), snapshot("006", 90, 7, 70)]);

		expect(accumulator.getResult()).toMatchObject({
			peakConcurrent: 12,
			events: [
				{
					capturedAt: BASE_TIME.toISOString(),
					concurrentStreams: 12,
					totalBandwidth: 120,
				},
				{
					capturedAt: new Date(BASE_TIME.getTime() + 30.001 * 60_000).toISOString(),
					concurrentStreams: 8,
					totalBandwidth: 80,
				},
			],
		});
	});

	it("keeps empty collection unknown, native idle zero, and respects a one-event limit", () => {
		const empty = createMostConcurrentAccumulator({ limit: 5 });
		expect(empty.getResult()).toMatchObject({ peakConcurrent: null, events: [] });

		const idle = createMostConcurrentAccumulator({ limit: 5 });
		idle.addSnapshots([snapshot("idle", 0, 0, 0)]);
		expect(idle.getResult()).toMatchObject({ peakConcurrent: 0, events: [] });

		expect(
			aggregateMostConcurrent([snapshot("first", 0, 10, 100), snapshot("later", 60, 9, 90)], {
				limit: 1,
			}),
		).toMatchObject({
			peakConcurrent: 10,
			events: [
				{
					capturedAt: BASE_TIME.toISOString(),
					concurrentStreams: 10,
					totalBandwidth: 100,
				},
			],
		});
	});
});
