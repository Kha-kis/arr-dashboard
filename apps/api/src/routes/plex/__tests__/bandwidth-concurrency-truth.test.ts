import { describe, expect, it } from "vitest";
import {
	buildFailedSessionSnapshot,
	buildPlexSessionSnapshot,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import { aggregateBandwidthAnalytics } from "../lib/bandwidth-analytics-helpers.js";

const capturedAt = new Date("2026-10-04T12:00:00Z");
describe("visible bandwidth consumer concurrency evidence", () => {
	it("leaves the peak unknown when no snapshot was collected", () => {
		expect(aggregateBandwidthAnalytics([]).peakConcurrent).toBeNull();
	});
	it("does not publish a failed provider collection as a zero observed peak", () => {
		const result = aggregateBandwidthAnalytics([
			{ ...buildFailedSessionSnapshot("PLEX"), capturedAt },
		]);
		expect(result.peakConcurrent).toBeNull();
		expect(result.measurement.collection.failedSnapshots).toBe(1);
	});
	it("retains zero established by successful native idle collection independently from missing active rates", () => {
		const result = aggregateBandwidthAnalytics([{ ...buildPlexSessionSnapshot([]), capturedAt }]);
		expect(result.peakConcurrent).toBe(0);
		expect(result.avgBandwidth).toBeNull();
		expect(result.measurement.collection.idleSnapshots).toBe(1);
	});
});
