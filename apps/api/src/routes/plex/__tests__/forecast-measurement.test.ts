import { describe, expect, it } from "vitest";
import {
	buildFailedSessionSnapshot,
	buildPlexSessionSnapshot,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import {
	computeForecast,
	createForecastAccumulator,
	type SnapshotForForecast,
} from "../lib/forecast-helpers.js";

function native(
	capturedAt: string,
	knownTotalKbps: number | null,
	compatibilityRate = 0,
	options: { provider?: "PLEX" | "JELLYFIN" | "EMBY"; observed?: number; measured?: number } = {},
): SnapshotForForecast & { measurementJson: string } {
	const provider = options.provider ?? "PLEX";
	const observed = options.observed ?? 1;
	const measured = options.measured ?? (knownTotalKbps === null ? 0 : observed);
	return {
		capturedAt: new Date(capturedAt),
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

describe("forecast native measurement truth", () => {
	it("retains partial known subtotals without fitting them as complete-rate peaks", () => {
		const result = computeForecast([
			native("2026-10-01T12:00:00Z", 100, 9999, { observed: 2, measured: 1 }),
			native("2026-10-02T12:00:00Z", null),
		]);
		expect(result.historicalDaily).toMatchObject([
			{
				date: "2026-10-01",
				avgBandwidth: null,
				peakBandwidth: null,
				avgKnownSubtotal: 100,
				peakKnownSubtotal: 100,
			},
			{
				date: "2026-10-02",
				avgBandwidth: null,
				peakBandwidth: null,
				avgKnownSubtotal: null,
				peakKnownSubtotal: null,
			},
		]);
		expect(result.forecast).toEqual([]);
		expect(result).toMatchObject({
			trend: "unknown",
			measurement: {
				status: "partial",
				observedSessions: 3,
				measuredSessions: 1,
				completeTotalSnapshots: 0,
				eligibleDays: 0,
				projectionStatus: "insufficient-data",
			},
		});
	});
	it("keeps complete-rate means separate from mixed complete and partial subtotals", () => {
		const result = computeForecast([
			native("2026-10-01T12:00:00Z", 0),
			native("2026-10-01T12:30:00Z", 100, 9999, { observed: 2, measured: 1 }),
		]);
		expect(result.historicalDaily).toMatchObject([
			{ avgBandwidth: 0, peakBandwidth: 0, avgKnownSubtotal: 50, peakKnownSubtotal: 100 },
		]);
		expect(result.peakHours).toMatchObject([
			{ hour: 12, avgConcurrent: 1.5, avgBandwidth: 0, avgKnownSubtotal: 50 },
		]);
	});
	it("never combines provider-reported and encoding-estimate bases in a regression", () => {
		const result = computeForecast([
			native("2026-10-01T12:00:00Z", 100),
			native("2026-10-02T12:00:00Z", 200, 9999, { provider: "JELLYFIN" }),
		]);
		expect(result.forecast).toEqual([]);
		expect(result).toMatchObject({
			trend: "unknown",
			measurement: { bandwidthBasis: "mixed", projectionStatus: "mixed-basis" },
		});
	});
	it("does not let idle, failed or invalid collection dilute active native rates", () => {
		const result = computeForecast([
			native("2026-10-01T12:00:00Z", 10),
			{ ...buildPlexSessionSnapshot([]), capturedAt: new Date("2026-10-01T12:05:00Z") },
			{ ...buildFailedSessionSnapshot("PLEX"), capturedAt: new Date("2026-10-02T12:00:00Z") },
			{ ...native("2026-10-01T12:10:00Z", 9999), measurementJson: "invalid" },
		]);
		expect(result.historicalDaily).toMatchObject([
			{ date: "2026-10-01", avgBandwidth: 10, peakBandwidth: 10 },
			{ date: "2026-10-02", avgBandwidth: null, peakBandwidth: null },
		]);
		expect(result).toMatchObject({
			measurement: {
				status: "partial",
				collection: {
					activeSnapshots: 1,
					idleSnapshots: 1,
					failedSnapshots: 1,
					invalidSnapshots: 1,
				},
			},
		});
	});
	it("retains raw route collection coverage without double-counting helper inputs", () => {
		const accumulator = createForecastAccumulator();
		accumulator.addSnapshots([native("2026-10-01T12:00:00Z", 10)]);
		expect(
			accumulator.getResult(
				7,
				{
					activeSnapshots: 1,
					idleSnapshots: 2,
					failedSnapshots: 3,
					legacySnapshots: 0,
					invalidSnapshots: 1,
				},
				{
					"2026-10-02": {
						activeSnapshots: 0,
						idleSnapshots: 0,
						failedSnapshots: 3,
						legacySnapshots: 0,
						invalidSnapshots: 0,
					},
				},
			),
		).toMatchObject({
			historicalDaily: [
				{ date: "2026-10-01", peakBandwidth: 10 },
				{ date: "2026-10-02", peakBandwidth: null },
			],
			measurement: {
				observedSessions: 1,
				collection: {
					activeSnapshots: 1,
					idleSnapshots: 2,
					failedSnapshots: 3,
					invalidSnapshots: 1,
				},
			},
		});
	});
	it("preserves a finite large measured rate while marking non-finite extrapolation unavailable", () => {
		const result = computeForecast([
			native("2026-10-01T12:00:00Z", Number.MAX_VALUE),
			native("2026-10-02T12:00:00Z", Number.MAX_VALUE),
		]);
		expect(result.historicalDaily[0]?.avgBandwidth).toBe(Number.MAX_VALUE);
		expect(result.forecast.every((row) => Number.isFinite(row.predictedPeak))).toBe(true);
		const overflow = computeForecast([
			native("2026-10-01T12:00:00Z", 0),
			native("2026-10-02T12:00:00Z", Number.MAX_VALUE),
		]);
		expect(overflow.forecast).toEqual([]);
		expect(overflow).toMatchObject({
			measurement: { projectionStatus: "numeric-unavailable" },
			trend: "unknown",
		});
	});
	it("keeps an earlier returned coverage receipt unchanged when later pages arrive", () => {
		const accumulator = createForecastAccumulator();
		accumulator.addSnapshots([native("2026-10-01T12:00:00Z", 10)]);
		const first = accumulator.getResult();
		accumulator.addSnapshots([native("2026-10-02T12:00:00Z", 20)]);
		expect(first).toMatchObject({
			measurement: { observedSnapshots: 1, observedSessions: 1 },
			forecast: [],
		});
		expect(accumulator.getResult()).toMatchObject({
			measurement: { observedSnapshots: 2, observedSessions: 2 },
		});
	});
	it("uses exact native fractional rates instead of compatibility integer columns", () => {
		const result = computeForecast([
			native("2026-10-01T12:00:00Z", 0.5),
			native("2026-10-02T12:00:00Z", 1.5),
		]);
		expect(result.historicalDaily).toMatchObject([
			{ date: "2026-10-01", avgBandwidth: 0.5, peakBandwidth: 0.5 },
			{ date: "2026-10-02", avgBandwidth: 1.5, peakBandwidth: 1.5 },
		]);
	});
	it("keeps a genuinely measured zero distinct from a missing native rate", () => {
		const result = computeForecast([
			native("2026-10-01T12:00:00Z", 0),
			native("2026-10-02T12:00:00Z", null),
		]);
		expect(result.historicalDaily).toMatchObject([
			{ date: "2026-10-01", avgBandwidth: 0, peakBandwidth: 0 },
			{ date: "2026-10-02", avgBandwidth: null, peakBandwidth: null },
		]);
		expect(result.forecast).toEqual([]);
		expect(result.trend).toBe("unknown");
	});
	it("does not certify legacy numeric rates as forecast inputs", () => {
		const result = computeForecast([
			{ capturedAt: new Date("2026-10-01T12:00:00Z"), totalBandwidth: 100, concurrentStreams: 1 },
			{ capturedAt: new Date("2026-10-02T12:00:00Z"), totalBandwidth: 200, concurrentStreams: 1 },
		]);
		expect(result.forecast).toEqual([]);
		expect(result.trend).toBe("unknown");
	});
	it("regresses against elapsed calendar days instead of compressing an unsampled day", () => {
		const result = computeForecast([
			native("2026-10-01T12:00:00Z", 100, 100),
			native("2026-10-03T12:00:00Z", 300, 300),
		]);
		expect(result.forecast[0]?.date).toBe("2026-10-04");
		expect(result.forecast[0]?.predictedPeak).toBeCloseTo(400, 8);
	});
});
