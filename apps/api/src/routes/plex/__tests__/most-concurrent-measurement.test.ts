import { describe, expect, it } from "vitest";
import {
	buildFailedSessionSnapshot,
	buildPlexSessionSnapshot,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import {
	aggregateMostConcurrent,
	createMostConcurrentAccumulator,
	type SnapshotForConcurrent,
} from "../lib/most-concurrent-helpers.js";

function native(
	knownTotalKbps: number | null,
	compatibilityRate: number,
	options: { observed?: number; measured?: number; provider?: "PLEX" | "JELLYFIN" | "EMBY" } = {},
): SnapshotForConcurrent & { measurementJson: string } {
	const observed = options.observed ?? 1;
	const measured = options.measured ?? (knownTotalKbps === null ? 0 : observed);
	const provider = options.provider ?? "PLEX";
	return {
		id: "synthetic-native",
		capturedAt: new Date("2026-10-01T12:00:00Z"),
		concurrentStreams: observed,
		totalBandwidth: compatibilityRate,
		measurementJson: JSON.stringify({
			version: 1,
			provider,
			status: "active",
			observedSessions: observed,
			bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
			bandwidth: {
				status:
					knownTotalKbps === null ? "unavailable" : measured === observed ? "complete" : "partial",
				observedSessions: observed,
				measuredSessions: measured,
				knownTotalKbps,
			},
			methods: {
				directPlayCount: 0,
				transcodeCount: 0,
				directStreamCount: 0,
				unknownDecisionCount: observed,
			},
			network: { status: "unavailable", lanKbps: null, wanKbps: null },
		}),
	};
}

describe("concurrent peak native measurement truth", () => {
	it("retains partial event evidence as a subtotal rather than certifying its complete rate", () => {
		const result = aggregateMostConcurrent([native(1.5, 2, { observed: 2, measured: 1 })], {
			limit: 5,
		});
		expect(result).toMatchObject({
			peakConcurrent: 2,
			events: [
				{
					totalBandwidth: null,
					knownBandwidthSubtotal: 1.5,
					measurement: {
						concurrencyStatus: "native",
						bandwidthStatus: "partial",
						observedSessions: 2,
						measuredSessions: 1,
					},
				},
			],
		});
	});
	it("retains a declared legacy count but marks its event and rate unverified", () => {
		const { measurementJson: _receipt, ...legacy } = native(100, 9999, { observed: 4 });
		const result = aggregateMostConcurrent([legacy], { limit: 5 });
		expect(result).toMatchObject({
			peakConcurrent: 4,
			events: [
				{
					concurrentStreams: 4,
					totalBandwidth: null,
					knownBandwidthSubtotal: null,
					measurement: {
						concurrencyStatus: "legacy-unverified",
						bandwidthStatus: "unavailable",
						bandwidthBasis: null,
					},
				},
			],
			measurement: {
				scope: "per-source-snapshot",
				status: "unavailable",
				collection: { legacySnapshots: 1 },
			},
		});
	});
	it("distinguishes a successful native idle observation from no collection at all", () => {
		expect(aggregateMostConcurrent([], { limit: 5 })).toMatchObject({
			peakConcurrent: null,
			events: [],
			measurement: { status: "unavailable" },
		});
		expect(
			aggregateMostConcurrent(
				[{ ...buildPlexSessionSnapshot([]), capturedAt: new Date("2026-10-01T12:00:00Z") }],
				{ limit: 5 },
			),
		).toMatchObject({
			peakConcurrent: 0,
			events: [],
			measurement: { status: "complete", nativeSnapshots: 1, collection: { idleSnapshots: 1 } },
		});
	});
	it("rejects invalid receipts and count mismatches without allowing them to win the peak", () => {
		const result = aggregateMostConcurrent(
			[
				{ ...native(9999, 9999), measurementJson: "invalid", concurrentStreams: 99 },
				{ ...native(9999, 9999), concurrentStreams: 50 },
				native(1.5, 2),
			],
			{ limit: 5 },
		);
		expect(result).toMatchObject({
			peakConcurrent: 1,
			measurement: { status: "partial", collection: { invalidSnapshots: 2, activeSnapshots: 1 } },
		});
		expect(result.events).toHaveLength(1);
	});
	it("does not sum independent server snapshots into a simultaneous all-source count", () => {
		const result = aggregateMostConcurrent(
			[native(30, 30, { observed: 3 }), native(40, 40, { observed: 4, provider: "JELLYFIN" })],
			{ limit: 5 },
		);
		expect(result).toMatchObject({
			peakConcurrent: 4,
			measurement: { scope: "per-source-snapshot", observedSnapshots: 2 },
		});
		expect(result.events).toMatchObject([
			{
				concurrentStreams: 4,
				totalBandwidth: 40,
				measurement: { bandwidthBasis: "encoding-estimate" },
			},
		]);
	});
	it("retains complete raw collection counts after the top-event limit is exhausted", () => {
		const accumulator = createMostConcurrentAccumulator({ limit: 1 });
		accumulator.addSnapshots([native(10, 10, { observed: 2 }), native(null, 0)]);
		const first = accumulator.getResult();
		const result = accumulator.getResult({
			activeSnapshots: 2,
			idleSnapshots: 3,
			failedSnapshots: 4,
			legacySnapshots: 0,
			invalidSnapshots: 5,
		});
		expect(result.events).toHaveLength(1);
		expect(result).toMatchObject({
			peakConcurrent: 2,
			measurement: {
				status: "partial",
				observedSnapshots: 2,
				nativeSnapshots: 5,
				collection: {
					activeSnapshots: 2,
					idleSnapshots: 3,
					failedSnapshots: 4,
					invalidSnapshots: 5,
				},
			},
		});
		expect(first).toMatchObject({
			measurement: { collection: { failedSnapshots: 0, invalidSnapshots: 0 } },
		});
	});
	it("preserves a genuinely measured event zero beside a known active count", () => {
		expect(aggregateMostConcurrent([native(0, 9999)], { limit: 5 })).toMatchObject({
			peakConcurrent: 1,
			events: [{ totalBandwidth: 0, knownBandwidthSubtotal: 0 }],
		});
	});
	it("retains a known native concurrency peak without manufacturing its missing bandwidth", () => {
		const result = aggregateMostConcurrent([native(null, 0)], { limit: 5 });
		expect(result.peakConcurrent).toBe(1);
		expect(result.events).toMatchObject([{ concurrentStreams: 1, totalBandwidth: null }]);
	});
	it("uses the exact native event rate rather than its rounded integer projection", () => {
		const result = aggregateMostConcurrent([native(1.5, 2)], { limit: 5 });
		expect(result.events).toMatchObject([{ concurrentStreams: 1, totalBandwidth: 1.5 }]);
	});
	it("does not report a provider collection failure as a verified zero peak", () => {
		const result = aggregateMostConcurrent(
			[{ ...buildFailedSessionSnapshot("PLEX"), capturedAt: new Date("2026-10-01T12:00:00Z") }],
			{ limit: 5 },
		);
		expect(result.peakConcurrent).toBeNull();
		expect(result.events).toEqual([]);
	});
});
