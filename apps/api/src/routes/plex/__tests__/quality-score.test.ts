import type { SnapshotCollectionCoverage } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
	parseSessionSnapshotMeasurement,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import {
	computeQualityScore,
	createQualityScoreAccumulator,
	type SnapshotForQuality,
} from "../lib/quality-score-helpers.js";

const noComponents = { directPlayScore: null, resolutionScore: null, transcodeScore: null };
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
function activeReceipt(observed: number, provider: "PLEX" | "JELLYFIN" | "EMBY" = "PLEX") {
	return JSON.stringify({
		version: 1,
		provider,
		userIdentity: "provider-native",
		sourceScope: { connectionGeneration: 0, identityGeneration: 0 },
		status: "active",
		observedSessions: observed,
		bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
		bandwidth: {
			status: "unavailable",
			observedSessions: observed,
			measuredSessions: 0,
			knownTotalKbps: null,
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
function snapshot(
	capturedAt: string,
	sessions: unknown[],
	overrides: Partial<SnapshotForQuality> = {},
): SnapshotForQuality {
	return {
		capturedAt: new Date(capturedAt),
		concurrentStreams: sessions.length,
		sessionsJson: JSON.stringify(sessions),
		measurementJson: activeReceipt(sessions.length),
		instanceId: "synthetic-source",
		...overrides,
	};
}
function session(
	videoDecision: unknown = "direct play",
	videoResolution: unknown = "1080",
	userId: unknown = "synthetic-user",
	user: unknown = "Synthetic user",
) {
	return { videoDecision, videoResolution, userId, user };
}

describe("computeQualityScore native video and resolution heuristic", () => {
	it("returns null scores and unavailable coverage for no snapshots", () => {
		expect(computeQualityScore([])).toEqual({
			overallScore: null,
			breakdown: noComponents,
			components: noComponents,
			trend: [],
			perUser: [],
			parseFailures: 0,
			totalSnapshots: 0,
			measurement: {
				version: 1,
				methodAxis: "video",
				status: "unavailable",
				observedSessions: 0,
				methodMeasuredSessions: 0,
				resolutionMeasuredSessions: 0,
				scoredSessions: 0,
				invalidDetailSnapshots: 0,
				unattributedSessions: 0,
				collection: collection(),
			},
		});
	});

	it("preserves a truthful complete Direct Play/1080p score", () => {
		const result = computeQualityScore([snapshot("2025-01-15T10:00:00Z", [session()])]);
		expect(result).toMatchObject({
			overallScore: 93,
			breakdown: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
			components: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
			measurement: {
				status: "complete",
				observedSessions: 1,
				methodMeasuredSessions: 1,
				resolutionMeasuredSessions: 1,
				scoredSessions: 1,
				unattributedSessions: 0,
			},
			perUser: [
				{
					username: "Synthetic user",
					score: 93,
					sessions: 1,
					coverage: {
						observedSessions: 1,
						methodMeasuredSessions: 1,
						resolutionMeasuredSessions: 1,
						scoredSessions: 1,
					},
				},
			],
		});
	});

	it("preserves a truthful complete video-transcode/SD score", () => {
		expect(
			computeQualityScore([snapshot("2025-01-15T10:00:00Z", [session("Transcode", "480")])]),
		).toMatchObject({
			overallScore: 8,
			breakdown: { directPlayScore: 0, resolutionScore: 25, transcodeScore: 0 },
			measurement: { status: "complete" },
		});
	});

	it.each([
		["4k", 100],
		[" 4K ", 100],
		["SD", 25],
		["2160p", 100],
		["3840x2160", 100],
		["1080", 75],
		["1080P", 75],
		["1920x1080", 75],
		["1080 X 1920", 75],
		[" 1920 x 1080 ", 75],
		["720", 50],
		["1280x720", 50],
		["576p", 35],
		["1024x576", 35],
		["480", 25],
		["1", 25],
		["4320", 100],
	])(
		"recognizes strict known resolution %s with tier score %s",
		(videoResolution, resolutionScore) => {
			expect(
				computeQualityScore([snapshot("2025-01-15T10:00:00Z", [session("copy", videoResolution)])]),
			).toMatchObject({
				components: { directPlayScore: 0, resolutionScore, transcodeScore: 100 },
				measurement: {
					methodMeasuredSessions: 1,
					resolutionMeasuredSessions: 1,
					scoredSessions: 1,
				},
			});
		},
	);

	it.each([
		undefined,
		null,
		"",
		"unknown",
		"FullHD",
		"0",
		"0p",
		"1920x0",
		"0x1080",
		"-1080",
		"1080.5",
		"1920x1080p",
		"1920 by 1080",
		"1080p extra",
		"1080pp",
		"Infinity",
		1080,
		{},
		["1080"],
	])("keeps unknown or malformed resolution %s unmeasured rather than SD", (videoResolution) => {
		const row = session();
		row.videoResolution = videoResolution;
		expect(computeQualityScore([snapshot("2025-01-15T10:00:00Z", [row])])).toMatchObject({
			overallScore: null,
			breakdown: noComponents,
			components: { directPlayScore: 100, resolutionScore: null, transcodeScore: 100 },
			measurement: {
				status: "unavailable",
				observedSessions: 1,
				methodMeasuredSessions: 1,
				resolutionMeasuredSessions: 0,
				scoredSessions: 0,
			},
		});
	});

	it.each([undefined, null, "", "unknown", "unrecognized", 42, {}, ["direct play"]])(
		"unknown video decision %s cannot improve inverse transcode scores",
		(videoDecision) => {
			const row = {
				...session(),
				videoDecision,
				audioDecision: "direct play",
				playbackDecision: "direct play",
			};
			expect(computeQualityScore([snapshot("2025-01-15T10:00:00Z", [row])])).toMatchObject({
				overallScore: null,
				breakdown: noComponents,
				components: { directPlayScore: null, resolutionScore: 75, transcodeScore: null },
				measurement: {
					status: "unavailable",
					observedSessions: 1,
					methodMeasuredSessions: 0,
					resolutionMeasuredSessions: 1,
					scoredSessions: 0,
				},
			});
		},
	);

	it("retains independent known components without manufacturing a composite from disjoint cohorts", () => {
		expect(
			computeQualityScore([
				snapshot("2025-01-15T10:00:00Z", [session("transcode", null), session(null, "2160")]),
			]),
		).toMatchObject({
			overallScore: null,
			breakdown: noComponents,
			components: { directPlayScore: 0, resolutionScore: 100, transcodeScore: 0 },
			measurement: {
				observedSessions: 2,
				methodMeasuredSessions: 1,
				resolutionMeasuredSessions: 1,
				scoredSessions: 0,
			},
			perUser: [
				{
					score: null,
					sessions: 2,
					coverage: {
						observedSessions: 2,
						methodMeasuredSessions: 1,
						resolutionMeasuredSessions: 1,
						scoredSessions: 0,
					},
				},
			],
		});
	});

	it("computes composite and breakdown only on the same jointly known rows", () => {
		expect(
			computeQualityScore([
				snapshot("2025-01-15T10:00:00Z", [
					session("direct play", "1080"),
					session("transcode", null),
					session(null, "2160"),
				]),
			]),
		).toMatchObject({
			overallScore: 93,
			breakdown: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
			components: { directPlayScore: 50, resolutionScore: 88, transcodeScore: 50 },
			measurement: {
				status: "partial",
				observedSessions: 3,
				methodMeasuredSessions: 2,
				resolutionMeasuredSessions: 2,
				scoredSessions: 1,
			},
		});
	});

	it("rounds the weighted composite once after unrounded joint-cohort components", () => {
		// Copy-only rows: resolution mean 85/3, inverse TC 100. Weighted score 38.5 -> 39.
		// Prematurely rounding the resolution component to 28 would instead return 38.
		expect(
			computeQualityScore([
				snapshot("2025-01-15T10:00:00Z", [
					session("copy", "480"),
					session("copy", "480"),
					session("copy", "576"),
				]),
			]),
		).toMatchObject({
			overallScore: 39,
			breakdown: { directPlayScore: 0, resolutionScore: 28, transcodeScore: 100 },
		});
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"scores actual %s native video-copy/audio-transcode captures by video and dimensions",
		(provider) => {
			const captured = buildJellyfinSessionSnapshot(
				[
					{
						id: "synthetic-session",
						userId: "synthetic-user",
						userName: "Synthetic user",
						isPaused: false,
						positionMs: 0,
						durationMs: 1000,
						playMethod: "Transcode",
						transcodingInfo: {
							isVideoDirect: true,
							isAudioDirect: false,
							width: 1920,
							height: 1080,
						},
					},
				],
				provider,
				{ connectionGeneration: 0, identityGeneration: 0 },
			);
			const priorReceipt = JSON.parse(captured.measurementJson);
			delete priorReceipt.userIdentity;
			captured.measurementJson = JSON.stringify(priorReceipt);
			expect(parseSessionSnapshotMeasurement(captured.measurementJson).status).toBe("verified");
			expect(
				computeQualityScore([
					{
						...captured,
						capturedAt: new Date("2025-01-15T10:00:00Z"),
						instanceId: "synthetic-source",
					},
				]),
			).toMatchObject({
				overallScore: 53,
				breakdown: { directPlayScore: 0, resolutionScore: 75, transcodeScore: 100 },
				measurement: { status: "complete", scoredSessions: 1 },
			});
		},
	);

	it("retains independent resolution and identity but no methods or composite for an explicit-axis contradiction", () => {
		const row = snapshot("2025-01-15T10:00:00Z", [session("copy", "1080")]);
		const receipt = JSON.parse(row.measurementJson!);
		receipt.methodAxis = "video";
		receipt.methods = {
			directPlayCount: 0,
			transcodeCount: 1,
			directStreamCount: 0,
			unknownDecisionCount: 0,
		};
		row.measurementJson = JSON.stringify(receipt);
		expect(computeQualityScore([row])).toMatchObject({
			overallScore: null,
			breakdown: noComponents,
			components: { directPlayScore: null, resolutionScore: 75, transcodeScore: null },
			parseFailures: 1,
			measurement: {
				observedSessions: 1,
				methodMeasuredSessions: 0,
				resolutionMeasuredSessions: 1,
				scoredSessions: 0,
				invalidDetailSnapshots: 1,
				unattributedSessions: 0,
			},
			perUser: [
				{
					sessions: 1,
					score: null,
					coverage: { resolutionMeasuredSessions: 1, methodMeasuredSessions: 0 },
				},
			],
		});
	});

	it.each([null, undefined])(
		"preserves legacy observations as unknown and unattributed with receipt %s",
		(measurementJson) => {
			expect(
				computeQualityScore([
					snapshot("2025-01-15T10:00:00Z", [session(), session()], { measurementJson }),
				]),
			).toMatchObject({
				overallScore: null,
				components: noComponents,
				breakdown: noComponents,
				perUser: [],
				parseFailures: 0,
				measurement: {
					status: "unavailable",
					observedSessions: 2,
					methodMeasuredSessions: 0,
					resolutionMeasuredSessions: 0,
					scoredSessions: 0,
					unattributedSessions: 2,
					collection: collection({ legacySnapshots: 1 }),
				},
			});
		},
	);

	it.each(["{", "null", "{}", "42", "[]", "[{},{}]"])(
		"keeps receipt count as unknown/unattributed for unusable detail %s",
		(sessionsJson) => {
			expect(
				computeQualityScore([snapshot("2025-01-15T10:00:00Z", [session()], { sessionsJson })]),
			).toMatchObject({
				overallScore: null,
				components: noComponents,
				perUser: [],
				parseFailures: 1,
				totalSnapshots: 1,
				measurement: {
					observedSessions: 1,
					methodMeasuredSessions: 0,
					resolutionMeasuredSessions: 0,
					scoredSessions: 0,
					invalidDetailSnapshots: 1,
					unattributedSessions: 1,
					collection: collection({ activeSnapshots: 1 }),
				},
			});
		},
	);

	it("preserves usable individual rows and counts malformed detail once without leaking private previews", () => {
		const result = computeQualityScore([
			snapshot("2025-01-15T10:00:00Z", [session(), null, [], "private detail sentinel", 42, {}]),
		]);
		expect(result).toMatchObject({
			overallScore: 93,
			parseFailures: 1,
			measurement: {
				status: "partial",
				observedSessions: 6,
				methodMeasuredSessions: 1,
				resolutionMeasuredSessions: 1,
				scoredSessions: 1,
				invalidDetailSnapshots: 1,
				unattributedSessions: 5,
			},
			perUser: [{ sessions: 1, score: 93 }],
		});
		expect(result).not.toHaveProperty("failedPreviews");
		expect(JSON.stringify(result)).not.toContain("private detail sentinel");
	});

	it.each(["{", "{}", "null"])(
		"excludes invalid receipt %s from observed counts",
		(measurementJson) => {
			expect(
				computeQualityScore([snapshot("2025-01-15T10:00:00Z", [session()], { measurementJson })]),
			).toMatchObject({
				overallScore: null,
				perUser: [],
				parseFailures: 1,
				measurement: {
					observedSessions: 0,
					unattributedSessions: 0,
					invalidDetailSnapshots: 0,
					collection: collection({ invalidSnapshots: 1 }),
				},
			});
		},
	);
	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
		"excludes invalid legacy count %s",
		(concurrentStreams) => {
			expect(
				computeQualityScore([
					snapshot("2025-01-15T10:00:00Z", [session()], {
						concurrentStreams,
						measurementJson: null,
					}),
				]),
			).toMatchObject({
				overallScore: null,
				parseFailures: 1,
				measurement: { observedSessions: 0, collection: collection({ invalidSnapshots: 1 }) },
			});
		},
	);
	it("excludes receipt/concurrency disagreement instead of trusting either count", () => {
		expect(
			computeQualityScore([
				snapshot("2025-01-15T10:00:00Z", [session()], { concurrentStreams: 2 }),
			]),
		).toMatchObject({
			overallScore: null,
			parseFailures: 1,
			measurement: {
				observedSessions: 0,
				invalidDetailSnapshots: 0,
				collection: collection({ invalidSnapshots: 1 }),
			},
		});
	});

	it("includes marker-only dates with null scores and recovers from failed to valid native batches", () => {
		const accumulator = createQualityScoreAccumulator();
		const capturedAt = new Date("2025-01-14T10:00:00Z");
		accumulator.addBatch([
			{ ...buildPlexSessionSnapshot([]), capturedAt },
			{ ...buildFailedSessionSnapshot("PLEX"), capturedAt },
		]);
		expect(accumulator.getResult()).toMatchObject({
			overallScore: null,
			trend: [{ date: "2025-01-14", score: null }],
			measurement: {
				observedSessions: 0,
				collection: collection({ idleSnapshots: 1, failedSnapshots: 1 }),
			},
		});
		accumulator.addBatch([snapshot("2025-01-15T10:00:00Z", [session()])]);
		expect(accumulator.getResult()).toMatchObject({
			overallScore: 93,
			measurement: { status: "partial", observedSessions: 1, scoredSessions: 1 },
			trend: [
				{ date: "2025-01-14", score: null },
				{ date: "2025-01-15", score: 93, measurement: { status: "complete" } },
			],
		});
	});

	it("uses full raw reader collection counts globally and daily without diluting known scores", () => {
		const accumulator = createQualityScoreAccumulator();
		accumulator.addBatch([snapshot("2025-01-15T10:00:00Z", [session()])]);
		const global = collection({
			activeSnapshots: 1,
			idleSnapshots: 8,
			failedSnapshots: 3,
			legacySnapshots: 2,
			invalidSnapshots: 4,
		});
		const day1 = collection({
			activeSnapshots: 1,
			idleSnapshots: 3,
			failedSnapshots: 1,
			legacySnapshots: 2,
			invalidSnapshots: 3,
		});
		const day2 = collection({ idleSnapshots: 5, failedSnapshots: 2, invalidSnapshots: 1 });
		const result = accumulator.getResult(global, { "2025-01-15": day1, "2025-01-16": day2 });
		expect(result).toMatchObject({
			overallScore: 93,
			parseFailures: 4,
			measurement: {
				status: "partial",
				observedSessions: 1,
				scoredSessions: 1,
				collection: global,
			},
			trend: [
				{ date: "2025-01-15", score: 93, measurement: { status: "partial", collection: day1 } },
				{
					date: "2025-01-16",
					score: null,
					components: noComponents,
					measurement: { status: "unavailable", observedSessions: 0, collection: day2 },
				},
			],
		});
		global.failedSnapshots = 99;
		day1.failedSnapshots = 99;
		expect(result.measurement.collection.failedSnapshots).toBe(3);
		expect(result.trend[0]?.measurement?.collection.failedSnapshots).toBe(1);
	});

	it("keeps user IDs with the same label separate and returns opaque identity keys", () => {
		const result = computeQualityScore([
			snapshot("2025-01-15T10:00:00Z", [
				session("direct play", "2160", "private-id-one", "Same label"),
				session("transcode", "480", "private-id-two", "Same label"),
			]),
		]);
		expect(result.perUser).toHaveLength(2);
		expect(result.perUser.map((u) => u.score).sort((a, b) => a! - b!)).toEqual([8, 100]);
		const keys = result.perUser.map((u) => u.key);
		expect(new Set(keys).size).toBe(2);
		for (const key of keys) expect(key).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(result)).not.toContain("private-id-");
	});

	it("scopes identical provider user IDs and labels by source and provider", () => {
		const result = computeQualityScore([
			snapshot("2025-01-15T10:00:00Z", [session()], { instanceId: "source-one" }),
			snapshot("2025-01-15T10:00:00Z", [session()], { instanceId: "source-two" }),
			snapshot("2025-01-15T10:00:00Z", [session()], {
				instanceId: "source-one",
				measurementJson: activeReceipt(1, "JELLYFIN"),
			}),
		]);
		expect(result.perUser).toHaveLength(3);
		expect(new Set(result.perUser.map((u) => u.key)).size).toBe(3);
		expect(result.perUser.every((u) => u.sessions === 1)).toBe(true);
	});

	it("merges label changes only for the same stable identity and keeps the latest nonempty label across reordered batches", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", [session("direct play", "2160", "user-one", "Old label")]),
			snapshot("2025-01-15T11:00:00Z", [session("direct play", "2160", "user-one", "New label")]),
			snapshot("2025-01-15T12:00:00Z", [session("direct play", "2160", "user-one", " ")]),
		];
		const result = computeQualityScore([snapshots[2]!, snapshots[1]!, snapshots[0]!]);
		expect(result.perUser).toMatchObject([{ username: "New label", score: 100, sessions: 3 }]);
		expect(result.perUser[0]?.key).toBe(computeQualityScore(snapshots).perUser[0]?.key);
	});

	it.each([undefined, null, "", " ", 7])(
		"keeps unattributable native user identity %s out of display-name buckets",
		(userId) => {
			const row = session();
			row.userId = userId;
			expect(computeQualityScore([snapshot("2025-01-15T10:00:00Z", [row])])).toMatchObject({
				overallScore: 93,
				perUser: [],
				measurement: { observedSessions: 1, unattributedSessions: 1 },
			});
		},
	);
	it.each([undefined, "", " "])(
		"requires source identity %s for native per-user attribution",
		(instanceId) => {
			expect(
				computeQualityScore([snapshot("2025-01-15T10:00:00Z", [session()], { instanceId })]),
			).toMatchObject({ overallScore: 93, perUser: [], measurement: { unattributedSessions: 1 } });
		},
	);
	it("includes attributable users with nullable scores and an honest unlabeled fallback", () => {
		expect(
			computeQualityScore([
				snapshot("2025-01-15T10:00:00Z", [session(null, "1080", "user-one", null)]),
			]),
		).toMatchObject({
			perUser: [
				{
					username: "Unlabeled user",
					score: null,
					sessions: 1,
					components: { directPlayScore: null, resolutionScore: 75, transcodeScore: null },
					coverage: {
						observedSessions: 1,
						methodMeasuredSessions: 0,
						resolutionMeasuredSessions: 1,
						scoredSessions: 0,
					},
				},
			],
			measurement: { unattributedSessions: 0 },
		});
	});

	it("combines uneven batches using complete weighted totals and merged day/user counts", () => {
		const snapshots = [
			snapshot("2025-01-15T10:00:00Z", [session("direct play", "2160")]),
			snapshot("2025-01-15T10:01:00Z", [session("direct play", "2160")]),
			snapshot("2025-01-15T10:02:00Z", [session("transcode", "480")]),
		];
		const accumulator = createQualityScoreAccumulator();
		accumulator.addBatch(snapshots.slice(0, 2));
		accumulator.addBatch([]);
		accumulator.addBatch(snapshots.slice(2));
		expect(accumulator.getResult()).toEqual(computeQualityScore(snapshots));
		expect(accumulator.getResult()).toMatchObject({
			overallScore: 69,
			breakdown: { directPlayScore: 67, resolutionScore: 75, transcodeScore: 67 },
			trend: [{ date: "2025-01-15", score: 69 }],
			perUser: [{ username: "Synthetic user", score: 69, sessions: 3 }],
			totalSnapshots: 3,
			measurement: { status: "complete", observedSessions: 3, scoredSessions: 3 },
		});
	});

	it("carries malformed detail diagnostics and independent evidence across uneven batches", () => {
		const accumulator = createQualityScoreAccumulator();
		accumulator.addBatch([snapshot("2025-01-14T10:00:00Z", [session()], { sessionsJson: "{" })]);
		accumulator.addBatch([
			snapshot("2025-01-15T10:00:00Z", [session()], { sessionsJson: "null" }),
			snapshot("2025-01-16T10:00:00Z", [session(), session("transcode", null)]),
		]);
		expect(accumulator.getResult()).toMatchObject({
			overallScore: 93,
			parseFailures: 2,
			totalSnapshots: 3,
			measurement: {
				status: "partial",
				observedSessions: 4,
				methodMeasuredSessions: 2,
				resolutionMeasuredSessions: 1,
				scoredSessions: 1,
				invalidDetailSnapshots: 2,
				unattributedSessions: 2,
			},
			trend: [
				{ date: "2025-01-14", score: null },
				{ date: "2025-01-15", score: null },
				{ date: "2025-01-16", score: 93 },
			],
		});
	});

	it("preserves old unmarked native Jellyfin video rows when the historical summary is overall Transcode", () => {
		const row = snapshot("2025-01-15T10:00:00Z", [session("copy", "1920x1080")], {
			measurementJson: activeReceipt(1, "JELLYFIN"),
		});
		const receipt = JSON.parse(row.measurementJson!);
		receipt.methods = {
			directPlayCount: 0,
			transcodeCount: 1,
			directStreamCount: 0,
			unknownDecisionCount: 0,
		};
		row.measurementJson = JSON.stringify(receipt);
		expect(computeQualityScore([row])).toMatchObject({
			overallScore: 53,
			breakdown: { directPlayScore: 0, resolutionScore: 75, transcodeScore: 100 },
			parseFailures: 0,
			measurement: { status: "complete", scoredSessions: 1, invalidDetailSnapshots: 0 },
		});
	});

	it("keeps complete known scores alongside healthy idle collection", () => {
		const result = computeQualityScore([
			snapshot("2025-01-15T10:00:00Z", [session()]),
			{ ...buildPlexSessionSnapshot([]), capturedAt: new Date("2025-01-15T11:00:00Z") },
		]);
		expect(result).toMatchObject({
			overallScore: 93,
			measurement: {
				status: "complete",
				observedSessions: 1,
				scoredSessions: 1,
				collection: collection({ activeSnapshots: 1, idleSnapshots: 1 }),
			},
		});
	});

	it("computes native daily trends from each day's own joint cohort", () => {
		const result = computeQualityScore([
			snapshot("2025-01-15T10:00:00Z", [session("direct play", "2160")]),
			snapshot("2025-01-14T10:00:00Z", [session("transcode", "720")]),
		]);
		expect(result.trend).toMatchObject([
			{
				date: "2025-01-14",
				score: 15,
				components: { directPlayScore: 0, resolutionScore: 50, transcodeScore: 0 },
			},
			{
				date: "2025-01-15",
				score: 100,
				components: { directPlayScore: 100, resolutionScore: 100, transcodeScore: 100 },
			},
		]);
	});

	it("sorts native users by observed counts and breaks ties by stable opaque key across batch order", () => {
		const high = snapshot("2025-01-15T10:00:00Z", [
			session("direct play", "1080", "frequent", "Frequent"),
			session("transcode", "720", "frequent", "Frequent"),
		]);
		const low = snapshot("2025-01-15T11:00:00Z", [
			session(null, null, "infrequent-one", "One"),
			session(null, null, "infrequent-two", "Two"),
		]);
		const result = computeQualityScore([low, high]);
		expect(result.perUser[0]).toMatchObject({ username: "Frequent", sessions: 2 });
		expect(result.perUser.slice(1).map((user) => user.sessions)).toEqual([1, 1]);
		expect(result.perUser[1]!.key! < result.perUser[2]!.key!).toBe(true);
		expect(result.perUser).toEqual(computeQualityScore([high, low]).perUser);
		expect(
			result.perUser.reduce((sum, user) => sum + user.sessions, 0) +
				result.measurement.unattributedSessions,
		).toBe(4);
	});
});
