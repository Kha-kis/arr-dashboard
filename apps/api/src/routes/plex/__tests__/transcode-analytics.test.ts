import type { SnapshotCollectionCoverage } from "@arr/shared";
import { describe, expect, it } from "vitest";
import type { JellyfinSession } from "../../../lib/jellyfin/jellyfin-client.js";
import type { PlexSessionItem } from "../../../lib/plex/plex-client.js";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
	parseSessionSnapshotMeasurement,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import {
	aggregateTranscodeAnalytics,
	createTranscodeAnalyticsAccumulator,
	readVideoMethods,
	type SnapshotForTranscode,
} from "../lib/transcode-analytics-helpers.js";

function collection(
	overrides: Partial<SnapshotCollectionCoverage> = {},
): SnapshotCollectionCoverage {
	return {
		activeSnapshots: 0,
		idleSnapshots: 0,
		failedSnapshots: 0,
		legacySnapshots: 0,
		invalidSnapshots: 0,
		...overrides,
	};
}

function activeReceipt(
	observed: number,
	methods = {
		directPlayCount: 0,
		transcodeCount: 0,
		directStreamCount: 0,
		unknownDecisionCount: observed,
	},
	methodAxis?: string,
): string {
	return JSON.stringify({
		version: 1,
		provider: "PLEX",
		status: "active",
		bandwidthBasis: "provider-reported",
		observedSessions: observed,
		bandwidth: {
			status: "unavailable",
			observedSessions: observed,
			measuredSessions: 0,
			knownTotalKbps: null,
		},
		methods,
		...(methodAxis === undefined ? {} : { methodAxis }),
		network: { status: "unavailable", lanKbps: null, wanKbps: null },
	});
}

function rows(date: string, detail: unknown[]): SnapshotForTranscode {
	return {
		capturedAt: new Date(`${date}T12:00:00Z`),
		concurrentStreams: detail.length,
		sessionsJson: JSON.stringify(detail),
		measurementJson: activeReceipt(detail.length),
		// Compatibility columns deliberately contradict native video evidence.
		directPlayCount: 777,
		transcodeCount: 888,
		directStreamCount: 999,
	};
}

function snapshot(date: string, directPlay: number, transcode: number, directStream: number) {
	return rows(date, [
		...Array.from({ length: directPlay }, () => ({ videoDecision: "direct play" })),
		...Array.from({ length: transcode }, () => ({ videoDecision: "transcode" })),
		...Array.from({ length: directStream }, () => ({ videoDecision: "copy" })),
	]);
}

function plex(): PlexSessionItem {
	return {
		sessionKey: "synthetic-session",
		ratingKey: "synthetic-item",
		title: "Synthetic item",
		type: "movie",
		user: { id: "7", title: "Synthetic user" },
		player: {
			title: "Synthetic player",
			platform: "Synthetic",
			product: "Synthetic",
			state: "playing",
		},
		state: "playing",
		viewOffset: 500,
		duration: 1000,
		videoDecision: "copy",
		audioDecision: "transcode",
	};
}

function jellyfin(): JellyfinSession {
	return {
		id: "synthetic-session",
		userId: "synthetic-user",
		isPaused: false,
		positionMs: 500,
		durationMs: 1000,
		playMethod: "Transcode",
		transcodingInfo: { isVideoDirect: true, isAudioDirect: false },
	};
}

describe("aggregateTranscodeAnalytics native video evidence", () => {
	it("shares usable native rows and per-row video decisions for matched-cohort consumers", () => {
		const input = rows("2025-01-01", [
			{ videoDecision: "copy", videoResolution: "1920x1080" },
			null,
		]);
		const parsed = parseSessionSnapshotMeasurement(input.measurementJson);
		if (parsed.status !== "verified" || parsed.measurement.status !== "active")
			throw new Error("Invalid test receipt");
		expect(readVideoMethods(input.sessionsJson, parsed.measurement)).toMatchObject({
			rows: [{ videoDecision: "copy", videoResolution: "1920x1080" }, null],
			decisions: ["direct_stream", "unknown"],
			invalidDetail: true,
		});
	});
	it("retains independent row evidence when an explicit video summary contradicts its methods", () => {
		const input = rows("2025-01-01", [{ videoDecision: "copy", videoResolution: "1920x1080" }]);
		const parsed = parseSessionSnapshotMeasurement(
			activeReceipt(
				1,
				{ directPlayCount: 1, transcodeCount: 0, directStreamCount: 0, unknownDecisionCount: 0 },
				"video",
			),
		);
		if (parsed.status !== "verified" || parsed.measurement.status !== "active")
			throw new Error("Invalid test receipt");
		expect(readVideoMethods(input.sessionsJson, parsed.measurement)).toMatchObject({
			rows: [{ videoDecision: "copy", videoResolution: "1920x1080" }],
			decisions: null,
			counts: { directPlay: 0, directStream: 0, transcode: 0, unknown: 1 },
			invalidDetail: true,
		});
	});
	it("aggregates native video totals and daily breakdown across multiple days", () => {
		const result = aggregateTranscodeAnalytics([
			snapshot("2025-01-01", 3, 1, 2),
			snapshot("2025-01-01", 1, 2, 0),
			snapshot("2025-01-02", 5, 0, 1),
		]);
		expect(result).toMatchObject({
			directPlay: 9,
			transcode: 3,
			directStream: 3,
			unknown: 0,
			totalSessions: 15,
			parseFailures: 0,
			totalSnapshots: 3,
		});
		expect(result.measurement).toEqual({
			version: 1,
			methodAxis: "video",
			status: "complete",
			observedSessions: 15,
			measuredSessions: 15,
			invalidDetailSnapshots: 0,
			collection: collection({ activeSnapshots: 3 }),
		});
		expect(result.dailyBreakdown).toMatchObject([
			{
				date: "2025-01-01",
				directPlay: 4,
				transcode: 3,
				directStream: 2,
				unknown: 0,
				measurement: {
					observedSessions: 9,
					measuredSessions: 9,
					collection: collection({ activeSnapshots: 2 }),
				},
			},
			{
				date: "2025-01-02",
				directPlay: 5,
				transcode: 0,
				directStream: 1,
				unknown: 0,
				measurement: {
					observedSessions: 6,
					measuredSessions: 6,
					collection: collection({ activeSnapshots: 1 }),
				},
			},
		]);
	});

	it("leaves empty input unavailable rather than certifying a healthy zero-method result", () => {
		expect(aggregateTranscodeAnalytics([])).toEqual({
			directPlay: 0,
			transcode: 0,
			directStream: 0,
			unknown: 0,
			totalSessions: 0,
			dailyBreakdown: [],
			parseFailures: 0,
			totalSnapshots: 0,
			measurement: {
				version: 1,
				methodAxis: "video",
				status: "unavailable",
				observedSessions: 0,
				measuredSessions: 0,
				invalidDetailSnapshots: 0,
				collection: collection(),
			},
		});
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"keeps %s video-copy/audio-transcode native captures comparable with Plex",
		(provider) => {
			const capturedAt = new Date("2025-01-01T12:00:00Z");
			for (const captured of [
				buildPlexSessionSnapshot([plex()]),
				buildJellyfinSessionSnapshot([jellyfin()], provider),
			]) {
				expect(parseSessionSnapshotMeasurement(captured.measurementJson).status).toBe("verified");
				expect(aggregateTranscodeAnalytics([{ ...captured, capturedAt }])).toMatchObject({
					directPlay: 0,
					transcode: 0,
					directStream: 1,
					unknown: 0,
					totalSessions: 1,
					measurement: { status: "complete", measuredSessions: 1 },
				});
			}
		},
	);

	it.each(["JELLYFIN", "EMBY"] as const)(
		"recovers old v1 %s video rows despite an overall Transcode receipt and scalar summary",
		(provider) => {
			const captured = buildJellyfinSessionSnapshot([jellyfin()], provider);
			const receipt = JSON.parse(captured.measurementJson);
			delete receipt.methodAxis;
			receipt.methods = {
				directPlayCount: 0,
				transcodeCount: 1,
				directStreamCount: 0,
				unknownDecisionCount: 0,
			};
			const result = aggregateTranscodeAnalytics([
				{
					...captured,
					capturedAt: new Date("2025-01-01T12:00:00Z"),
					directPlayCount: 0,
					transcodeCount: 1,
					directStreamCount: 0,
					measurementJson: JSON.stringify(receipt),
				},
			]);
			expect(result).toMatchObject({
				directPlay: 0,
				transcode: 0,
				directStream: 1,
				unknown: 0,
				totalSessions: 1,
				parseFailures: 0,
				measurement: { status: "complete", invalidDetailSnapshots: 0 },
			});
		},
	);

	it.each(["direct play", "DirectPlay", " DIRECT PLAY "])(
		"recognizes explicit native Direct Play (%s)",
		(videoDecision) => {
			expect(aggregateTranscodeAnalytics([rows("2025-01-01", [{ videoDecision }])])).toMatchObject({
				directPlay: 1,
				transcode: 0,
				directStream: 0,
				unknown: 0,
			});
		},
	);
	it.each(["copy", "DirectStream", " direct stream "])(
		"recognizes explicit native video copy (%s)",
		(videoDecision) => {
			expect(aggregateTranscodeAnalytics([rows("2025-01-01", [{ videoDecision }])])).toMatchObject({
				directPlay: 0,
				transcode: 0,
				directStream: 1,
				unknown: 0,
			});
		},
	);
	it.each(["Transcode", " transcode "])(
		"recognizes explicit native video transcode (%s)",
		(videoDecision) => {
			expect(aggregateTranscodeAnalytics([rows("2025-01-01", [{ videoDecision }])])).toMatchObject({
				directPlay: 0,
				transcode: 1,
				directStream: 0,
				unknown: 0,
			});
		},
	);

	it.each([undefined, null, "", "unknown", "unrecognized", 7, {}, ["direct play"]])(
		"never imputes an unknown video method (%s) from audio, overall method, or scalar defaults",
		(videoDecision) => {
			expect(
				aggregateTranscodeAnalytics([
					rows("2025-01-01", [
						{ videoDecision, audioDecision: "direct play", playbackDecision: "direct play" },
					]),
				]),
			).toMatchObject({
				directPlay: 0,
				transcode: 0,
				directStream: 0,
				unknown: 1,
				totalSessions: 1,
				parseFailures: 0,
				measurement: {
					status: "unavailable",
					observedSessions: 1,
					measuredSessions: 0,
					invalidDetailSnapshots: 0,
				},
			});
		},
	);

	it.each([null, undefined])(
		"preserves historical observation counts as unknown with absent receipt %s",
		(measurementJson) => {
			expect(
				aggregateTranscodeAnalytics([{ ...snapshot("2025-01-01", 2, 1, 1), measurementJson }]),
			).toMatchObject({
				directPlay: 0,
				transcode: 0,
				directStream: 0,
				unknown: 4,
				totalSessions: 4,
				parseFailures: 0,
				measurement: {
					status: "unavailable",
					observedSessions: 4,
					measuredSessions: 0,
					collection: collection({ legacySnapshots: 1 }),
				},
			});
		},
	);

	it("reports measured subtotals with unknown observations as partial coverage", () => {
		const result = aggregateTranscodeAnalytics([
			rows("2025-01-01", [{ videoDecision: "copy" }, {}, { videoDecision: "transcode" }]),
			{ ...snapshot("2025-01-01", 2, 0, 0), measurementJson: null },
		]);
		expect(result).toMatchObject({
			directPlay: 0,
			transcode: 1,
			directStream: 1,
			unknown: 3,
			totalSessions: 5,
			measurement: {
				status: "partial",
				observedSessions: 5,
				measuredSessions: 2,
				collection: collection({ activeSnapshots: 1, legacySnapshots: 1 }),
			},
		});
	});

	it.each(["{", "null", "{}", "[{}]", "[]", "[{},{}]"])(
		"retains receipt observation count as unknown for malformed, nonarray or wrong-length detail %s",
		(sessionsJson) => {
			expect(
				aggregateTranscodeAnalytics([
					{
						...rows("2025-01-01", [{ videoDecision: "copy" }, { videoDecision: "transcode" }, {}]),
						sessionsJson,
					},
				]),
			).toMatchObject({
				directPlay: 0,
				transcode: 0,
				directStream: 0,
				unknown: 3,
				totalSessions: 3,
				parseFailures: 1,
				measurement: {
					status: "unavailable",
					observedSessions: 3,
					measuredSessions: 0,
					invalidDetailSnapshots: 1,
					collection: collection({ activeSnapshots: 1 }),
				},
			});
		},
	);

	it.each([undefined, "video"])(
		"preserves individually valid video decisions when null/nonobject rows have matching count (axis %s)",
		(methodAxis) => {
			const row = rows("2025-01-01", [{ videoDecision: "copy" }, null, [], "private row", 42, {}]);
			row.measurementJson = activeReceipt(
				6,
				{ directPlayCount: 0, transcodeCount: 0, directStreamCount: 1, unknownDecisionCount: 5 },
				methodAxis,
			);
			const result = aggregateTranscodeAnalytics([row]);
			expect(result).toMatchObject({
				directPlay: 0,
				transcode: 0,
				directStream: 1,
				unknown: 5,
				totalSessions: 6,
				parseFailures: 1,
				measurement: {
					status: "partial",
					observedSessions: 6,
					measuredSessions: 1,
					invalidDetailSnapshots: 1,
				},
			});
			expect(JSON.stringify(result)).not.toContain("private row");
		},
	);

	it("keeps measured method coverage complete alongside healthy idle markers", () => {
		const result = aggregateTranscodeAnalytics([
			snapshot("2025-01-01", 1, 0, 0),
			{ ...buildPlexSessionSnapshot([]), capturedAt: new Date("2025-01-01T13:00:00Z") },
		]);
		expect(result).toMatchObject({
			directPlay: 1,
			unknown: 0,
			totalSessions: 1,
			measurement: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				collection: collection({ activeSnapshots: 1, idleSnapshots: 1 }),
			},
		});
	});

	it("certifies matching explicit video-axis receipts against actual detail counts", () => {
		const row = rows("2025-01-01", [{ videoDecision: "copy" }, { videoDecision: "Transcode" }, {}]);
		row.measurementJson = activeReceipt(
			3,
			{ directPlayCount: 0, transcodeCount: 1, directStreamCount: 1, unknownDecisionCount: 1 },
			"video",
		);
		expect(aggregateTranscodeAnalytics([row])).toMatchObject({
			directPlay: 0,
			transcode: 1,
			directStream: 1,
			unknown: 1,
			totalSessions: 3,
			parseFailures: 0,
			measurement: { status: "partial", measuredSessions: 2, invalidDetailSnapshots: 0 },
		});
	});

	it("invalidates all native method evidence when an explicit video-axis receipt contradicts detail", () => {
		const row = rows("2025-01-01", [{ videoDecision: "copy" }, { videoDecision: "direct play" }]);
		row.measurementJson = activeReceipt(
			2,
			{ directPlayCount: 0, transcodeCount: 2, directStreamCount: 0, unknownDecisionCount: 0 },
			"video",
		);
		expect(aggregateTranscodeAnalytics([row])).toMatchObject({
			directPlay: 0,
			transcode: 0,
			directStream: 0,
			unknown: 2,
			totalSessions: 2,
			parseFailures: 1,
			measurement: {
				status: "unavailable",
				measuredSessions: 0,
				invalidDetailSnapshots: 1,
				collection: collection({ activeSnapshots: 1 }),
			},
		});
	});

	it.each([
		"{",
		"{}",
		"null",
		activeReceipt(1, undefined, "overall"),
		activeReceipt(1, {
			directPlayCount: 1,
			transcodeCount: 1,
			directStreamCount: 0,
			unknownDecisionCount: 0,
		}),
	])("excludes invalid receipt %s from observation totals", (measurementJson) => {
		expect(
			aggregateTranscodeAnalytics([{ ...snapshot("2025-01-01", 1, 0, 0), measurementJson }]),
		).toMatchObject({
			directPlay: 0,
			transcode: 0,
			directStream: 0,
			unknown: 0,
			totalSessions: 0,
			parseFailures: 1,
			measurement: {
				status: "unavailable",
				observedSessions: 0,
				measuredSessions: 0,
				invalidDetailSnapshots: 0,
				collection: collection({ invalidSnapshots: 1 }),
			},
		});
	});

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"excludes invalid historical observation count %s",
		(concurrentStreams) => {
			expect(
				aggregateTranscodeAnalytics([
					{ ...snapshot("2025-01-01", 1, 0, 0), concurrentStreams, measurementJson: null },
				]),
			).toMatchObject({
				totalSessions: 0,
				unknown: 0,
				parseFailures: 1,
				measurement: { collection: collection({ invalidSnapshots: 1 }) },
			});
		},
	);

	it("rejects receipt/concurrency mismatches rather than accepting either count", () => {
		expect(
			aggregateTranscodeAnalytics([{ ...snapshot("2025-01-01", 1, 0, 0), concurrentStreams: 2 }]),
		).toMatchObject({
			totalSessions: 0,
			unknown: 0,
			parseFailures: 1,
			measurement: { observedSessions: 0, collection: collection({ invalidSnapshots: 1 }) },
		});
	});

	it("keeps idle and failed captures as collection outcomes without adding activity and recovers later native reads", () => {
		const accumulator = createTranscodeAnalyticsAccumulator();
		const capturedAt = new Date("2025-01-01T12:00:00Z");
		accumulator.addSnapshots([
			{ ...buildPlexSessionSnapshot([]), capturedAt },
			{ ...buildFailedSessionSnapshot("PLEX"), capturedAt },
		]);
		expect(accumulator.getResult()).toMatchObject({
			totalSessions: 0,
			unknown: 0,
			measurement: {
				status: "unavailable",
				collection: collection({ idleSnapshots: 1, failedSnapshots: 1 }),
			},
		});
		accumulator.addSnapshots([snapshot("2025-01-02", 1, 0, 0)]);
		expect(accumulator.getResult()).toMatchObject({
			directPlay: 1,
			totalSessions: 1,
			measurement: {
				status: "partial",
				observedSessions: 1,
				measuredSessions: 1,
				collection: collection({ activeSnapshots: 1, idleSnapshots: 1, failedSnapshots: 1 }),
			},
			dailyBreakdown: [
				{ date: "2025-01-01", measurement: { status: "unavailable" } },
				{ date: "2025-01-02", directPlay: 1, measurement: { status: "complete" } },
			],
		});
	});

	it("uses full reader raw collection counters globally and daily, including dates with markers only", () => {
		const accumulator = createTranscodeAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot("2025-01-01", 1, 0, 0)]);
		const global = collection({
			activeSnapshots: 1,
			idleSnapshots: 12,
			failedSnapshots: 3,
			legacySnapshots: 2,
			invalidSnapshots: 4,
		});
		const day1 = collection({
			activeSnapshots: 1,
			idleSnapshots: 5,
			failedSnapshots: 1,
			legacySnapshots: 2,
			invalidSnapshots: 3,
		});
		const day2 = collection({ idleSnapshots: 7, failedSnapshots: 2, invalidSnapshots: 1 });
		const result = accumulator.getResult(global, { "2025-01-01": day1, "2025-01-02": day2 });
		expect(result).toMatchObject({
			directPlay: 1,
			unknown: 0,
			totalSessions: 1,
			parseFailures: 4,
			totalSnapshots: 1,
			measurement: {
				status: "partial",
				observedSessions: 1,
				measuredSessions: 1,
				collection: global,
			},
			dailyBreakdown: [
				{ date: "2025-01-01", directPlay: 1, measurement: { status: "partial", collection: day1 } },
				{
					date: "2025-01-02",
					directPlay: 0,
					transcode: 0,
					directStream: 0,
					unknown: 0,
					measurement: {
						status: "unavailable",
						observedSessions: 0,
						measuredSessions: 0,
						collection: day2,
					},
				},
			],
		});
		global.failedSnapshots = 99;
		day1.failedSnapshots = 99;
		expect(result.measurement.collection.failedSnapshots).toBe(3);
		expect(result.dailyBreakdown[0]?.measurement?.collection.failedSnapshots).toBe(1);
	});

	it("accumulates daily and global native totals over uneven pages without losing unknowns", () => {
		const accumulator = createTranscodeAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot("2025-07-01", 3, 1, 0)]);
		accumulator.addSnapshots([
			snapshot("2025-07-01", 2, 4, 1),
			rows("2025-07-02", [{ videoDecision: "DirectPlay" }, {}, { videoDecision: "copy" }]),
		]);
		accumulator.addSnapshots([]);
		expect(accumulator.getResult()).toMatchObject({
			directPlay: 6,
			transcode: 5,
			directStream: 2,
			unknown: 1,
			totalSessions: 14,
			dailyBreakdown: [
				{
					date: "2025-07-01",
					directPlay: 5,
					transcode: 5,
					directStream: 1,
					unknown: 0,
					measurement: {
						observedSessions: 11,
						measuredSessions: 11,
						collection: collection({ activeSnapshots: 2 }),
					},
				},
				{
					date: "2025-07-02",
					directPlay: 1,
					transcode: 0,
					directStream: 1,
					unknown: 1,
					measurement: {
						observedSessions: 3,
						measuredSessions: 2,
						collection: collection({ activeSnapshots: 1 }),
					},
				},
			],
			parseFailures: 0,
			totalSnapshots: 3,
			measurement: {
				status: "partial",
				observedSessions: 14,
				measuredSessions: 13,
				invalidDetailSnapshots: 0,
				collection: collection({ activeSnapshots: 3 }),
			},
		});
	});
});
