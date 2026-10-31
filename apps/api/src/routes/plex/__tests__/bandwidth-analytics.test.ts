import { describe, expect, it } from "vitest";
import {
	aggregateBandwidthAnalytics,
	createBandwidthAnalyticsAccumulator,
	type SnapshotForBandwidth,
} from "../lib/bandwidth-analytics-helpers.js";

function snapshot(
	date: string,
	concurrent: number,
	total: number,
	lan: number,
	wan: number,
): SnapshotForBandwidth & { measurementJson: string | null | undefined } {
	return {
		capturedAt: new Date(`${date}T12:00:00Z`),
		concurrentStreams: concurrent,
		totalBandwidth: total,
		lanBandwidth: lan,
		wanBandwidth: wan,
		measurementJson: activeReceipt(concurrent, total),
	};
}

function activeReceipt(
	observed: number,
	rate: number | null,
	measured = rate === null ? 0 : observed,
	provider: "PLEX" | "JELLYFIN" | "EMBY" = "PLEX",
): string {
	return JSON.stringify({
		version: 1,
		provider,
		status: "active",
		bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
		observedSessions: observed,
		bandwidth: {
			status: rate === null ? "unavailable" : measured === observed ? "complete" : "partial",
			observedSessions: observed,
			measuredSessions: measured,
			knownTotalKbps: rate,
		},
		methods: {
			directPlayCount: 0,
			transcodeCount: 0,
			directStreamCount: 0,
			unknownDecisionCount: observed,
		},
		network: { status: "unavailable", lanKbps: null, wanKbps: null },
	});
}

function markerReceipt(status: "idle" | "failed"): string {
	return JSON.stringify({
		version: 1,
		provider: "PLEX",
		status,
		bandwidthBasis: "provider-reported",
		observedSessions: status === "idle" ? 0 : null,
		bandwidth:
			status === "idle"
				? { status: "complete", observedSessions: 0, measuredSessions: 0, knownTotalKbps: 0 }
				: null,
		methods:
			status === "idle"
				? { directPlayCount: 0, transcodeCount: 0, directStreamCount: 0, unknownDecisionCount: 0 }
				: null,
		network:
			status === "idle"
				? { status: "complete", lanKbps: 0, wanKbps: 0 }
				: { status: "unavailable", lanKbps: null, wanKbps: null },
	});
}

describe("aggregateBandwidthAnalytics", () => {
	it("computes peaks, averages, and time series across multiple days", () => {
		const snapshots = [
			snapshot("2025-01-01", 3, 1000, 600, 400),
			snapshot("2025-01-01", 5, 2000, 1200, 800),
			snapshot("2025-01-02", 2, 500, 300, 200),
		];

		const result = aggregateBandwidthAnalytics(snapshots);
		expect(result.peakConcurrent).toBe(5);
		expect(result.peakBandwidth).toBe(2000);
		expect(result.avgBandwidth).toBeCloseTo(1166.6666666666667);
		expect(result.timeSeries).toHaveLength(2);
		// Native receipts have no active network measurement authority.
		expect(result.timeSeries[0]).toMatchObject({
			date: "2025-01-01",
			concurrent: 5,
			bandwidth: 1500,
			lanBandwidth: null,
			wanBandwidth: null,
		});
		// Day 2: single snapshot
		expect(result.timeSeries[1]).toMatchObject({
			date: "2025-01-02",
			concurrent: 2,
			bandwidth: 500,
			lanBandwidth: null,
			wanBandwidth: null,
		});
		expect(result.measurement).toEqual({
			version: 1,
			status: "complete",
			bandwidthBasis: "provider-reported",
			observedSessions: 10,
			measuredSessions: 10,
			observedSnapshots: 3,
			measuredSnapshots: 3,
			collection: {
				activeSnapshots: 3,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		});
		expect(result.parseFailures).toBe(0);
		expect(result.totalSnapshots).toBe(3);
	});

	it("returns unavailable rates for empty input", () => {
		const result = aggregateBandwidthAnalytics([]);
		expect(result.peakConcurrent).toBeNull();
		expect(result.peakBandwidth).toBeNull();
		expect(result.avgBandwidth).toBeNull();
		expect(result.timeSeries).toEqual([]);
		expect(result.totalSnapshots).toBe(0);
		expect(result.measurement).toMatchObject({
			status: "unavailable",
			bandwidthBasis: null,
			observedSessions: 0,
			measuredSessions: 0,
			observedSnapshots: 0,
			measuredSnapshots: 0,
		});
	});

	it("averages daily bandwidth correctly with multiple snapshots", () => {
		const snapshots = [
			snapshot("2025-03-10", 1, 100, 60, 40),
			snapshot("2025-03-10", 1, 200, 120, 80),
			snapshot("2025-03-10", 1, 300, 180, 120),
		];

		const result = aggregateBandwidthAnalytics(snapshots);
		expect(result.timeSeries).toHaveLength(1);
		expect(result.timeSeries[0]?.bandwidth).toBe(200);
		expect(result.timeSeries[0]?.lanBandwidth).toBeNull();
		expect(result.timeSeries[0]?.wanBandwidth).toBeNull();
	});

	it("reports zero parse failures for valid receipts", () => {
		const snapshots = [snapshot("2025-03-01", 1, 100, 50, 50)];
		const result = aggregateBandwidthAnalytics(snapshots);
		expect(result.parseFailures).toBe(0);
	});

	it("uses complete totals and daily counts across uneven pages", () => {
		const accumulator = createBandwidthAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot("2025-04-01", 2, 2, 1, 1)]);
		accumulator.addSnapshots([
			snapshot("2025-04-01", 4, 3, 2, 1),
			snapshot("2025-04-02", 1, 8, 5, 3),
		]);

		expect(accumulator.getResult()).toMatchObject({
			peakConcurrent: 4,
			peakBandwidth: 8,
			avgBandwidth: 4.333333333333333,
			timeSeries: [
				{
					date: "2025-04-01",
					concurrent: 4,
					bandwidth: 2.5,
					lanBandwidth: null,
					wanBandwidth: null,
					measurement: {
						observedSessions: 6,
						measuredSessions: 6,
						observedSnapshots: 2,
						measuredSnapshots: 2,
					},
				},
				{ date: "2025-04-02", concurrent: 1, bandwidth: 8, lanBandwidth: null, wanBandwidth: null },
			],
			parseFailures: 0,
			totalSnapshots: 3,
			measurement: {
				observedSessions: 7,
				measuredSessions: 7,
				observedSnapshots: 3,
				measuredSnapshots: 3,
			},
		});
	});

	it("distinguishes an explicit measured zero from missing bandwidth despite legacy numeric values", () => {
		const row = snapshot("2025-03-01", 1, 900, 500, 400);
		expect(
			aggregateBandwidthAnalytics([{ ...row, measurementJson: activeReceipt(1, 0) }]),
		).toMatchObject({
			peakBandwidth: 0,
			avgBandwidth: 0,
			measurement: { status: "complete", measuredSessions: 1, measuredSnapshots: 1 },
		});
		expect(
			aggregateBandwidthAnalytics([{ ...row, measurementJson: activeReceipt(1, null) }]),
		).toMatchObject({
			peakBandwidth: null,
			avgBandwidth: null,
			measurement: {
				status: "unavailable",
				observedSessions: 1,
				measuredSessions: 0,
				measuredSnapshots: 0,
			},
		});
	});

	it.each([null, undefined])(
		"treats absent receipt %s as legacy and leaves scalar rates unverified",
		(receipt) => {
			const result = aggregateBandwidthAnalytics([
				{ ...snapshot("2025-03-01", 4, 900, 500, 400), measurementJson: receipt },
			]);
			expect(result).toMatchObject({
				peakConcurrent: 4,
				peakBandwidth: null,
				avgBandwidth: null,
				parseFailures: 0,
				measurement: {
					status: "unavailable",
					bandwidthBasis: null,
					observedSessions: 4,
					measuredSessions: 0,
					observedSnapshots: 1,
					measuredSnapshots: 0,
					collection: { legacySnapshots: 1 },
				},
				timeSeries: [{ concurrent: 4, bandwidth: null, lanBandwidth: null, wanBandwidth: null }],
			});
		},
	);

	it.each([
		"{",
		"{}",
		activeReceipt(1, -1),
		activeReceipt(1, 1).replace('"version":1', '"version":2'),
		activeReceipt(1, 1).replace('"knownTotalKbps":1', '"knownTotalKbps":1e400'),
		activeReceipt(1, 1).replace('"measuredSessions":1', '"measuredSessions":2'),
	])("excludes malformed or contradictory receipts: %s", (receipt) => {
		expect(
			aggregateBandwidthAnalytics([
				{ ...snapshot("2025-03-01", 1, 900, 500, 400), measurementJson: receipt },
			]),
		).toMatchObject({
			peakConcurrent: null,
			peakBandwidth: null,
			avgBandwidth: null,
			parseFailures: 1,
			timeSeries: [],
			measurement: { observedSnapshots: 0, collection: { invalidSnapshots: 1 } },
		});
	});

	it("excludes a valid receipt whose observed count disagrees with the stored snapshot", () => {
		expect(
			aggregateBandwidthAnalytics([
				{ ...snapshot("2025-03-01", 9, 9999, 0, 0), measurementJson: activeReceipt(1, 10) },
			]),
		).toMatchObject({
			peakConcurrent: null,
			peakBandwidth: null,
			avgBandwidth: null,
			parseFailures: 1,
			measurement: { collection: { invalidSnapshots: 1 } },
		});
	});

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"rejects malformed legacy concurrency %s",
		(concurrent) => {
			expect(
				aggregateBandwidthAnalytics([
					{
						...snapshot("2025-03-01", 1, 9999, 0, 0),
						concurrentStreams: concurrent,
						measurementJson: null,
					},
				]),
			).toMatchObject({
				peakConcurrent: null,
				avgBandwidth: null,
				parseFailures: 1,
				measurement: {
					observedSessions: 0,
					observedSnapshots: 0,
					collection: { invalidSnapshots: 1, legacySnapshots: 0 },
				},
			});
		},
	);

	it("preserves partial known subtotals and measured versus observed coverage", () => {
		const result = aggregateBandwidthAnalytics([
			{ ...snapshot("2025-03-01", 3, 9999, 0, 0), measurementJson: activeReceipt(3, 12.5, 1) },
			{ ...snapshot("2025-03-01", 2, 0, 0, 0), measurementJson: activeReceipt(2, null) },
		]);
		expect(result).toMatchObject({
			peakBandwidth: 12.5,
			avgBandwidth: 12.5,
			measurement: {
				status: "partial",
				observedSessions: 5,
				measuredSessions: 1,
				observedSnapshots: 2,
				measuredSnapshots: 1,
			},
			timeSeries: [
				{
					bandwidth: 12.5,
					measurement: { status: "partial", measuredSessions: 1, observedSessions: 5 },
				},
			],
		});
	});

	it("keeps measurement counts when a receipt cannot represent a finite known total", () => {
		expect(
			aggregateBandwidthAnalytics([
				{ ...snapshot("2025-03-01", 2, 0, 0, 0), measurementJson: activeReceipt(2, null, 2) },
			]),
		).toMatchObject({
			peakBandwidth: null,
			avgBandwidth: null,
			measurement: {
				status: "unavailable",
				observedSessions: 2,
				measuredSessions: 2,
				measuredSnapshots: 0,
			},
		});
	});

	it("counts idle and failed collection without diluting active rates or creating activity points", () => {
		const result = aggregateBandwidthAnalytics([
			snapshot("2025-03-01", 1, 100, 50, 50),
			{ ...snapshot("2025-03-02", 0, 0, 0, 0), measurementJson: markerReceipt("idle") },
			{ ...snapshot("2025-03-03", 0, 0, 0, 0), measurementJson: markerReceipt("failed") },
		]);
		expect(result).toMatchObject({
			peakConcurrent: 1,
			peakBandwidth: 100,
			avgBandwidth: 100,
			totalSnapshots: 3,
			measurement: {
				status: "partial",
				observedSessions: 1,
				observedSnapshots: 1,
				measuredSnapshots: 1,
				collection: {
					activeSnapshots: 1,
					idleSnapshots: 1,
					failedSnapshots: 1,
					legacySnapshots: 0,
					invalidSnapshots: 0,
				},
			},
		});
		expect(result.timeSeries).toHaveLength(1);
	});

	it.each(["idle", "failed"] as const)(
		"keeps %s-only collection distinct from measured active zero",
		(status) => {
			expect(
				aggregateBandwidthAnalytics([
					{ ...snapshot("2025-03-01", 0, 0, 0, 0), measurementJson: markerReceipt(status) },
				]),
			).toMatchObject({
				peakConcurrent: status === "idle" ? 0 : null,
				peakBandwidth: null,
				avgBandwidth: null,
				timeSeries: [],
				measurement: {
					status: "unavailable",
					observedSnapshots: 0,
					measuredSnapshots: 0,
					collection: { [`${status}Snapshots`]: 1 },
				},
			});
		},
	);

	it("qualifies known rates when legacy or invalid rows are also present", () => {
		const result = aggregateBandwidthAnalytics([
			snapshot("2025-03-01", 1, 100, 50, 50),
			{ ...snapshot("2025-03-01", 4, 9000, 5000, 4000), measurementJson: null },
			{ ...snapshot("2025-03-01", 20, 99999, 0, 0), measurementJson: "{}" },
		]);
		expect(result).toMatchObject({
			peakConcurrent: 4,
			peakBandwidth: 100,
			avgBandwidth: 100,
			measurement: {
				status: "partial",
				observedSessions: 5,
				measuredSessions: 1,
				observedSnapshots: 2,
				measuredSnapshots: 1,
				collection: { legacySnapshots: 1, invalidSnapshots: 1 },
			},
		});
	});

	it("preserves fractional rates and native values beyond legacy integer capacity", () => {
		const result = aggregateBandwidthAnalytics([
			{ ...snapshot("2025-03-01", 1, 3, 0, 0), measurementJson: activeReceipt(1, 3.25) },
			{ ...snapshot("2025-03-01", 1, 8, 0, 0), measurementJson: activeReceipt(1, 7.75) },
			{ ...snapshot("2025-03-02", 1, 0, 0, 0), measurementJson: activeReceipt(1, 2147483648.25) },
		]);
		expect(result.peakBandwidth).toBe(2147483648.25);
		expect(result.timeSeries[0]?.bandwidth).toBe(5.5);
		expect(result.timeSeries[1]?.bandwidth).toBe(2147483648.25);
	});

	it("avoids overflowing the sum of finite native rates", () => {
		const row = { ...snapshot("2025-03-01", 1, 0, 0, 0), measurementJson: activeReceipt(1, 1e308) };
		const result = aggregateBandwidthAnalytics([row, row, row]);
		expect(result.avgBandwidth).toBe(1e308);
		expect(result.peakBandwidth).toBe(1e308);
		expect(result.timeSeries[0]?.bandwidth).toBe(1e308);
	});

	it("does not combine provider-reported rates and encoding estimates into a comparable aggregate", () => {
		const result = aggregateBandwidthAnalytics([
			snapshot("2025-03-01", 1, 10, 0, 0),
			{
				...snapshot("2025-03-01", 1, 20, 0, 0),
				measurementJson: activeReceipt(1, 20, 1, "JELLYFIN"),
			},
		]);
		expect(result).toMatchObject({
			peakConcurrent: 1,
			peakBandwidth: null,
			avgBandwidth: null,
			measurement: {
				status: "unavailable",
				bandwidthBasis: "mixed",
				observedSessions: 2,
				measuredSessions: 2,
			},
			timeSeries: [
				{ bandwidth: null, measurement: { status: "unavailable", bandwidthBasis: "mixed" } },
			],
		});
	});

	it("labels Jellyfin and Emby rates with a compatible encoding-estimate basis", () => {
		const result = aggregateBandwidthAnalytics([
			{
				...snapshot("2025-03-01", 1, 10, 0, 0),
				measurementJson: activeReceipt(1, 10, 1, "JELLYFIN"),
			},
			{ ...snapshot("2025-03-01", 1, 20, 0, 0), measurementJson: activeReceipt(1, 20, 1, "EMBY") },
		]);
		expect(result).toMatchObject({
			avgBandwidth: 15,
			measurement: { status: "complete", bandwidthBasis: "encoding-estimate" },
		});
	});

	it("preserves an unknown daily point between known days", () => {
		const result = aggregateBandwidthAnalytics([
			snapshot("2025-03-01", 1, 10, 0, 0),
			{ ...snapshot("2025-03-02", 1, 0, 0, 0), measurementJson: activeReceipt(1, null) },
			snapshot("2025-03-03", 1, 20, 0, 0),
		]);
		expect(result.timeSeries.map((point) => point.bandwidth)).toEqual([10, null, 20]);
		expect(result.avgBandwidth).toBe(15);
	});

	it("uses full reader counters without double-counting filtered rows or mutating internal counts", () => {
		const accumulator = createBandwidthAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot("2025-04-01", 1, 10, 0, 0)]);
		const collection = {
			activeSnapshots: 1,
			idleSnapshots: 7,
			failedSnapshots: 2,
			legacySnapshots: 0,
			invalidSnapshots: 3,
		};
		expect(accumulator.getResult(collection)).toMatchObject({
			avgBandwidth: 10,
			parseFailures: 3,
			measurement: { status: "partial", observedSessions: 1, observedSnapshots: 1, collection },
		});
		expect(accumulator.getResult().measurement?.collection).toMatchObject({
			activeSnapshots: 1,
			idleSnapshots: 0,
			failedSnapshots: 0,
			invalidSnapshots: 0,
		});
	});
});
