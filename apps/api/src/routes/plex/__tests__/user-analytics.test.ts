import type { SnapshotCollectionCoverage } from "@arr/shared";
import { describe, expect, it } from "vitest";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
	parseSessionSnapshotMeasurement,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import { computeQualityScore } from "../lib/quality-score-helpers.js";
import {
	aggregateUserAnalytics,
	createUserAnalyticsAccumulator,
	type SnapshotWithSessions,
} from "../lib/user-analytics-helpers.js";

const ALICE_KEY = "3ae7dfa9a3997030d6e048c02128183b911e29f92535bfeaaf7a53225730448b";
const BOB_KEY = "403461222daddcd985866d23069ddd293a6d820fe092b17605fd87a2293a7757";
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
function receipt(
	observed: number,
	measured = 0,
	total: number | null = null,
	provider: "PLEX" | "JELLYFIN" | "EMBY" = "PLEX",
) {
	return JSON.stringify({
		version: 1,
		provider,
		userIdentity: "provider-native",
		sourceScope: { connectionGeneration: 0, identityGeneration: 0 },
		status: "active",
		observedSessions: observed,
		bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
		bandwidth: {
			status: total === null ? "unavailable" : measured === observed ? "complete" : "partial",
			observedSessions: observed,
			measuredSessions: measured,
			knownTotalKbps: total,
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
	rows: unknown[],
	measured = 0,
	total: number | null = null,
	overrides: Partial<SnapshotWithSessions> = {},
): SnapshotWithSessions {
	return {
		capturedAt: new Date(capturedAt),
		sessionsJson: JSON.stringify(rows),
		concurrentStreams: rows.length,
		measurementJson: receipt(rows.length, measured, total),
		instanceId: "source-one",
		...overrides,
	};
}
function session(userId: unknown = "alice-id", user: unknown = "alice", bandwidth?: unknown) {
	return { userId, user, bandwidth };
}

describe("aggregateUserAnalytics native source/user evidence", () => {
	it("groups native user observations and exposes measured means rather than rate sums", () => {
		const result = aggregateUserAnalytics([
			snapshot(
				"2025-01-15T10:00:00Z",
				[session("alice-id", "alice", 5000), session("bob-id", "bob", 3000)],
				2,
				8000,
			),
			snapshot("2025-01-15T10:05:00Z", [session("alice-id", "alice", 7000)], 1, 7000),
		]);
		expect(result.users).toEqual([
			{
				key: ALICE_KEY,
				username: "alice",
				totalSessions: 2,
				totalBandwidth: null,
				avgBandwidth: 6000,
				estimatedWatchTimeMinutes: 10,
				mostRecentActivity: "2025-01-15T10:05:00.000Z",
				bandwidthMeasurement: {
					version: 1,
					bandwidthBasis: "provider-reported",
					status: "complete",
					observedSessions: 2,
					measuredSessions: 2,
				},
			},
			{
				key: BOB_KEY,
				username: "bob",
				totalSessions: 1,
				totalBandwidth: null,
				avgBandwidth: 3000,
				estimatedWatchTimeMinutes: 5,
				mostRecentActivity: "2025-01-15T10:00:00.000Z",
				bandwidthMeasurement: {
					version: 1,
					bandwidthBasis: "provider-reported",
					status: "complete",
					observedSessions: 1,
					measuredSessions: 1,
				},
			},
		]);
		expect(result.measurement).toEqual({
			version: 1,
			attribution: "source-provider-user-id",
			status: "complete",
			observedSessions: 3,
			attributedSessions: 3,
			unattributedSessions: 0,
			invalidDetailSnapshots: 0,
			collection: collection({ activeSnapshots: 2 }),
		});
	});

	it("computes daily opaque user counts and sample-weighted estimates across a discontinuous window", () => {
		const result = aggregateUserAnalytics([
			snapshot("2025-01-16T10:00:00Z", [session("alice-id", "alice", 0)], 1, 0),
			snapshot(
				"2025-01-15T10:00:00Z",
				[session("alice-id", "alice", 0), session("bob-id", "bob", 0)],
				2,
				0,
			),
		]);
		expect(result.dailyBreakdown).toMatchObject([
			{
				date: "2025-01-15",
				userSessions: { [ALICE_KEY]: 1, [BOB_KEY]: 1 },
				measurement: { observedSessions: 2, attributedSessions: 2, unattributedSessions: 0 },
			},
			{
				date: "2025-01-16",
				userSessions: { [ALICE_KEY]: 1 },
				measurement: { observedSessions: 1, attributedSessions: 1, unattributedSessions: 0 },
			},
		]);
		expect(result.users[0]).toMatchObject({
			key: ALICE_KEY,
			estimatedWatchTimeMinutes: 10,
			mostRecentActivity: "2025-01-16T10:00:00.000Z",
		});
	});

	it("returns unavailable attribution and empty results for no snapshots", () => {
		expect(aggregateUserAnalytics([])).toEqual({
			users: [],
			dailyBreakdown: [],
			parseFailures: 0,
			totalSnapshots: 0,
			measurement: {
				version: 1,
				attribution: "source-provider-user-id",
				status: "unavailable",
				observedSessions: 0,
				attributedSessions: 0,
				unattributedSessions: 0,
				invalidDetailSnapshots: 0,
				collection: collection(),
			},
		});
	});

	it.each([null, undefined])(
		"retains legacy scalar observations as unattributed without certifying identity or rates (%s)",
		(measurementJson) => {
			expect(
				aggregateUserAnalytics([
					snapshot("2025-01-15T10:00:00Z", [session("alice-id", "alice", 5000)], 1, 5000, {
						measurementJson,
						concurrentStreams: 3,
					}),
				]),
			).toMatchObject({
				users: [],
				dailyBreakdown: [
					{
						userSessions: {},
						measurement: { observedSessions: 3, attributedSessions: 0, unattributedSessions: 3 },
					},
				],
				parseFailures: 0,
				measurement: {
					status: "unavailable",
					observedSessions: 3,
					attributedSessions: 0,
					unattributedSessions: 3,
					collection: collection({ legacySnapshots: 1 }),
				},
			});
		},
	);

	it("keeps same-name native user IDs separate and returns no raw identity coordinates", () => {
		const result = aggregateUserAnalytics([
			snapshot(
				"2025-01-15T10:00:00Z",
				[session("private-id-one", "Same label", 10), session("private-id-two", "Same label", 20)],
				2,
				30,
			),
		]);
		expect(result.users).toHaveLength(2);
		expect(new Set(result.users.map((u) => u.key)).size).toBe(2);
		expect(result.users.map((u) => u.avgBandwidth).sort((a, b) => a! - b!)).toEqual([10, 20]);
		for (const user of result.users) expect(user.key).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(result)).not.toContain("private-id-");
	});

	it("scopes the same native ID and label by instance and provider while preserving rate bases", () => {
		const result = aggregateUserAnalytics([
			snapshot("2025-01-15T10:00:00Z", [session("alice-id", "Same label", 10)], 1, 10),
			snapshot("2025-01-15T10:00:00Z", [session("alice-id", "Same label", 20)], 1, 20, {
				instanceId: "source-two",
			}),
			snapshot("2025-01-15T10:00:00Z", [session("alice-id", "Same label", 30)], 1, 30, {
				measurementJson: receipt(1, 1, 30, "JELLYFIN"),
			}),
			snapshot("2025-01-15T10:00:00Z", [session("alice-id", "Same label", 40)], 1, 40, {
				measurementJson: receipt(1, 1, 40, "EMBY"),
			}),
		]);
		expect(result.users).toHaveLength(4);
		expect(new Set(result.users.map((u) => u.key)).size).toBe(4);
		expect(result.users.map((u) => u.avgBandwidth).sort((a, b) => a! - b!)).toEqual([
			10, 20, 30, 40,
		]);
		expect(
			result.users.filter((u) => u.bandwidthMeasurement?.bandwidthBasis === "encoding-estimate"),
		).toHaveLength(2);
	});

	it("uses the same source/native identity key as quality scoring", () => {
		const row = snapshot("2025-01-15T10:00:00Z", [session()]);
		expect(aggregateUserAnalytics([row]).users[0]?.key).toBe(ALICE_KEY);
		expect(computeQualityScore([row]).perUser[0]?.key).toBe(ALICE_KEY);
	});

	it("keeps the latest nonempty label and max activity even when batches arrive out of order", () => {
		const rows = [
			snapshot("2025-01-15T12:00:00Z", [session("alice-id", " ")]),
			snapshot("2025-01-15T11:00:00Z", [session("alice-id", "New label")]),
			snapshot("2025-01-15T10:00:00Z", [session("alice-id", "Old label")]),
		];
		expect(aggregateUserAnalytics(rows).users).toMatchObject([
			{
				key: ALICE_KEY,
				username: "New label",
				totalSessions: 3,
				estimatedWatchTimeMinutes: 15,
				mostRecentActivity: "2025-01-15T12:00:00.000Z",
			},
		]);
		expect(aggregateUserAnalytics(rows).users).toEqual(
			aggregateUserAnalytics([...rows].reverse()).users,
		);
	});
	it("breaks equal-timestamp label ties deterministically", () => {
		const first = snapshot("2025-01-15T10:00:00Z", [session("alice-id", "Alpha")]);
		const second = snapshot("2025-01-15T10:00:00Z", [session("alice-id", "Zulu")]);
		expect(aggregateUserAnalytics([first, second]).users).toEqual(
			aggregateUserAnalytics([second, first]).users,
		);
		expect(aggregateUserAnalytics([first, second]).users[0]?.username).toBe("Zulu");
	});
	it.each([undefined, null, "", " ", 7, {}, ["alice-id"]])(
		"leaves invalid native user ID %s unattributed instead of fabricating a label bucket",
		(userId) => {
			const row = { ...session(), userId };
			expect(aggregateUserAnalytics([snapshot("2025-01-15T10:00:00Z", [row])])).toMatchObject({
				users: [],
				measurement: {
					status: "unavailable",
					observedSessions: 1,
					attributedSessions: 0,
					unattributedSessions: 1,
				},
				dailyBreakdown: [{ userSessions: {} }],
			});
		},
	);
	it.each([undefined, "", " "])(
		"requires native source identity %s for attribution",
		(instanceId) => {
			expect(
				aggregateUserAnalytics([
					snapshot("2025-01-15T10:00:00Z", [session()], 0, null, { instanceId }),
				]),
			).toMatchObject({
				users: [],
				measurement: { observedSessions: 1, attributedSessions: 0, unattributedSessions: 1 },
			});
		},
	);
	it.each([undefined, null, "", " ", 42])(
		"preserves identified native users with an honest fallback for missing label %s",
		(user) => {
			expect(
				aggregateUserAnalytics([snapshot("2025-01-15T10:00:00Z", [{ ...session(), user }])]),
			).toMatchObject({
				users: [{ key: ALICE_KEY, username: "Unlabeled user", totalSessions: 1 }],
				measurement: { status: "complete", attributedSessions: 1, unattributedSessions: 0 },
			});
		},
	);

	it("distinguishes measured zero/fractional rates from missing values and reports partial rate coverage", () => {
		const result = aggregateUserAnalytics([
			snapshot(
				"2025-01-15T10:00:00Z",
				[session("alice-id", "alice", 0), session("alice-id", "alice", 2.5), session()],
				2,
				2.5,
			),
		]);
		expect(result.users).toMatchObject([
			{
				totalSessions: 3,
				totalBandwidth: null,
				avgBandwidth: 1.25,
				bandwidthMeasurement: {
					version: 1,
					status: "partial",
					observedSessions: 3,
					measuredSessions: 2,
				},
			},
		]);
		expect(result.measurement).toMatchObject({ status: "complete", invalidDetailSnapshots: 0 });
	});
	it("returns measured zero rather than null when native rate is explicitly zero", () => {
		expect(
			aggregateUserAnalytics([
				snapshot("2025-01-15T10:00:00Z", [session("alice-id", "alice", 0)], 1, 0),
			]).users,
		).toMatchObject([
			{
				avgBandwidth: 0,
				totalBandwidth: null,
				bandwidthMeasurement: { status: "complete", measuredSessions: 1 },
			},
		]);
	});
	it.each([undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, "0", {}, []])(
		"never certifies missing, invalid or nonnumeric native rate %s as zero",
		(bandwidth) => {
			expect(
				aggregateUserAnalytics([
					snapshot("2025-01-15T10:00:00Z", [session("alice-id", "alice", bandwidth)]),
				]),
			).toMatchObject({
				users: [
					{
						totalBandwidth: null,
						avgBandwidth: null,
						bandwidthMeasurement: {
							status: "unavailable",
							observedSessions: 1,
							measuredSessions: 0,
						},
					},
				],
				parseFailures: 0,
				measurement: { status: "complete", invalidDetailSnapshots: 0 },
			});
		},
	);
	it("rejects nonfinite numbers parsed from otherwise valid JSON", () => {
		const row = snapshot("2025-01-15T10:00:00Z", [session()], 0, null, {
			sessionsJson: '[{"userId":"alice-id","user":"alice","bandwidth":1e309}]',
		});
		expect(aggregateUserAnalytics([row]).users).toMatchObject([
			{ avgBandwidth: null, bandwidthMeasurement: { measuredSessions: 0, status: "unavailable" } },
		]);
	});

	it.each([
		[2, 21],
		[1, 10],
		[0, null],
	] as const)(
		"invalidates all snapshot rates for receipt disagreement (measured %s, total %s) while retaining identities",
		(measured, total) => {
			const result = aggregateUserAnalytics([
				snapshot(
					"2025-01-15T10:00:00Z",
					[session("alice-id", "alice", 10), session("bob-id", "bob", 10)],
					measured,
					total,
				),
			]);
			expect(result.users).toHaveLength(2);
			for (const user of result.users)
				expect(user).toMatchObject({
					totalSessions: 1,
					avgBandwidth: null,
					totalBandwidth: null,
					bandwidthMeasurement: { observedSessions: 1, measuredSessions: 0, status: "unavailable" },
				});
			expect(result).toMatchObject({
				parseFailures: 1,
				measurement: {
					status: "partial",
					observedSessions: 2,
					attributedSessions: 2,
					invalidDetailSnapshots: 1,
				},
			});
		},
	);
	it("checks full-array rate coverage including unattributed rows before granting any rate authority", () => {
		const rows = [session("alice-id", "alice", 10), { user: "Unattributed", bandwidth: 20 }];
		const result = aggregateUserAnalytics([snapshot("2025-01-15T10:00:00Z", rows, 1, 10)]);
		expect(result).toMatchObject({
			users: [
				{ key: ALICE_KEY, avgBandwidth: null, bandwidthMeasurement: { measuredSessions: 0 } },
			],
			parseFailures: 1,
			measurement: {
				observedSessions: 2,
				attributedSessions: 1,
				unattributedSessions: 1,
				invalidDetailSnapshots: 1,
			},
		});
	});
	it("can certify attributable rates after full-array agreement even with unattributed measured rows", () => {
		const result = aggregateUserAnalytics([
			snapshot(
				"2025-01-15T10:00:00Z",
				[session("alice-id", "alice", 10), { bandwidth: 20 }],
				2,
				30,
			),
		]);
		expect(result).toMatchObject({
			users: [
				{ avgBandwidth: 10, bandwidthMeasurement: { status: "complete", measuredSessions: 1 } },
			],
			parseFailures: 0,
			measurement: { status: "partial", attributedSessions: 1, unattributedSessions: 1 },
		});
	});
	it("keeps a finite per-user mean when the full snapshot rate sum overflows", () => {
		const result = aggregateUserAnalytics([
			snapshot(
				"2025-01-15T10:00:00Z",
				[
					session("alice-id", "alice", Number.MAX_VALUE),
					session("alice-id", "alice", Number.MAX_VALUE),
				],
				2,
				null,
			),
		]);
		expect(result.users).toMatchObject([
			{
				avgBandwidth: Number.MAX_VALUE,
				totalBandwidth: null,
				bandwidthMeasurement: { status: "complete", observedSessions: 2, measuredSessions: 2 },
			},
		]);
		expect(result.parseFailures).toBe(0);
		expect(Number.isFinite(result.users[0]?.avgBandwidth)).toBe(true);
	});
	it("weights the finite measured mean by observations over uneven batches", () => {
		const accumulator = createUserAnalyticsAccumulator();
		accumulator.addSnapshots([
			snapshot("2025-01-15T10:00:00Z", [session("alice-id", "alice", 0)], 1, 0),
		]);
		accumulator.addSnapshots([
			snapshot(
				"2025-01-15T10:05:00Z",
				[session("alice-id", "alice", 30), session("alice-id", "alice", 60)],
				2,
				90,
			),
		]);
		expect(accumulator.getResult().users).toMatchObject([
			{ totalSessions: 3, avgBandwidth: 30, bandwidthMeasurement: { measuredSessions: 3 } },
		]);
	});

	it("retains independent identity and rates when video-axis summary contradicts methods", () => {
		const row = snapshot(
			"2025-01-15T10:00:00Z",
			[{ ...session("alice-id", "alice", 10), videoDecision: "copy" }],
			1,
			10,
		);
		const metadata = JSON.parse(row.measurementJson!);
		metadata.methodAxis = "video";
		metadata.methods = {
			directPlayCount: 0,
			transcodeCount: 1,
			directStreamCount: 0,
			unknownDecisionCount: 0,
		};
		row.measurementJson = JSON.stringify(metadata);
		expect(aggregateUserAnalytics([row])).toMatchObject({
			users: [
				{
					totalSessions: 1,
					avgBandwidth: 10,
					bandwidthMeasurement: { status: "complete", measuredSessions: 1 },
				},
			],
			parseFailures: 1,
			measurement: {
				status: "partial",
				observedSessions: 1,
				attributedSessions: 1,
				invalidDetailSnapshots: 1,
			},
		});
	});

	it.each(["not-json", "null", "{}", "42", "[]", "[{},{}]"])(
		"retains observation count as unattributed for unusable detail %s",
		(sessionsJson) => {
			expect(
				aggregateUserAnalytics([
					snapshot("2025-01-15T10:00:00Z", [session()], 0, null, { sessionsJson }),
				]),
			).toMatchObject({
				users: [],
				parseFailures: 1,
				totalSnapshots: 1,
				measurement: {
					status: "unavailable",
					observedSessions: 1,
					attributedSessions: 0,
					unattributedSessions: 1,
					invalidDetailSnapshots: 1,
				},
			});
		},
	);
	it("retains valid individual rows with one detail failure and no private previews", () => {
		const result = aggregateUserAnalytics([
			snapshot(
				"2025-01-15T10:00:00Z",
				[session("alice-id", "alice", 5), null, [], "private detail sentinel", 42, {}],
				1,
				5,
			),
		]);
		expect(result).toMatchObject({
			users: [{ totalSessions: 1, avgBandwidth: 5 }],
			parseFailures: 1,
			measurement: {
				observedSessions: 6,
				attributedSessions: 1,
				unattributedSessions: 5,
				invalidDetailSnapshots: 1,
			},
		});
		expect(result).not.toHaveProperty("failedPreviews");
		expect(JSON.stringify(result)).not.toContain("private detail sentinel");
	});
	it("counts malformed rows and contradictory rates only once per snapshot", () => {
		expect(
			aggregateUserAnalytics([
				snapshot("2025-01-15T10:00:00Z", [session("alice-id", "alice", 5), null], 0, null),
			]),
		).toMatchObject({
			users: [{ avgBandwidth: null }],
			parseFailures: 1,
			measurement: { invalidDetailSnapshots: 1 },
		});
	});
	it.each(["{", "{}", "null"])(
		"excludes invalid receipt %s rather than trusting details or legacy scalars",
		(measurementJson) => {
			expect(
				aggregateUserAnalytics([
					snapshot("2025-01-15T10:00:00Z", [session()], 0, null, { measurementJson }),
				]),
			).toMatchObject({
				users: [],
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
		"excludes invalid legacy observation count %s",
		(concurrentStreams) => {
			expect(
				aggregateUserAnalytics([
					snapshot("2025-01-15T10:00:00Z", [session()], 0, null, {
						concurrentStreams,
						measurementJson: null,
					}),
				]),
			).toMatchObject({
				users: [],
				parseFailures: 1,
				measurement: { observedSessions: 0, collection: collection({ invalidSnapshots: 1 }) },
			});
		},
	);
	it("excludes receipt/concurrency mismatches before attribution", () => {
		expect(
			aggregateUserAnalytics([
				snapshot("2025-01-15T10:00:00Z", [session()], 0, null, { concurrentStreams: 2 }),
			]),
		).toMatchObject({
			users: [],
			parseFailures: 1,
			measurement: { observedSessions: 0, collection: collection({ invalidSnapshots: 1 }) },
		});
	});

	it.each(["JELLYFIN", "EMBY"] as const)(
		"aggregates real %s native captures and encoding-estimate rate basis",
		(provider) => {
			const captured = buildJellyfinSessionSnapshot(
				[
					{
						id: "synthetic-session",
						userId: "alice-id",
						userName: "alice",
						isPaused: false,
						positionMs: 0,
						durationMs: 1000,
						playMethod: "Transcode",
						transcodingInfo: { bitrate: 5000, isVideoDirect: true, isAudioDirect: false },
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
				aggregateUserAnalytics([
					{ ...captured, capturedAt: new Date("2025-01-15T10:00:00Z"), instanceId: "source-one" },
				]),
			).toMatchObject({
				users: [
					{
						username: "alice",
						totalSessions: 1,
						avgBandwidth: 5,
						bandwidthMeasurement: {
							bandwidthBasis: "encoding-estimate",
							status: "complete",
							measuredSessions: 1,
						},
					},
				],
				parseFailures: 0,
				measurement: { status: "complete", attributedSessions: 1 },
			});
		},
	);

	it("keeps idle and failed marker-only days and recovers later native user observations", () => {
		const accumulator = createUserAnalyticsAccumulator();
		const capturedAt = new Date("2025-01-14T10:00:00Z");
		accumulator.addSnapshots([
			{ ...buildPlexSessionSnapshot([]), capturedAt },
			{ ...buildFailedSessionSnapshot("PLEX"), capturedAt },
		]);
		expect(accumulator.getResult()).toMatchObject({
			users: [],
			dailyBreakdown: [
				{
					date: "2025-01-14",
					userSessions: {},
					measurement: {
						status: "unavailable",
						observedSessions: 0,
						collection: collection({ idleSnapshots: 1, failedSnapshots: 1 }),
					},
				},
			],
		});
		accumulator.addSnapshots([snapshot("2025-01-15T10:00:00Z", [session()])]);
		expect(accumulator.getResult()).toMatchObject({
			users: [{ totalSessions: 1 }],
			measurement: { status: "partial", observedSessions: 1, attributedSessions: 1 },
			dailyBreakdown: [
				{ date: "2025-01-14", userSessions: {} },
				{
					date: "2025-01-15",
					userSessions: { [ALICE_KEY]: 1 },
					measurement: { status: "complete" },
				},
			],
		});
	});
	it("uses full raw global/day reader counters and preserves marker-only dates without observation dilution", () => {
		const accumulator = createUserAnalyticsAccumulator();
		accumulator.addSnapshots([snapshot("2025-01-15T10:00:00Z", [session()])]);
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
			users: [{ totalSessions: 1 }],
			parseFailures: 4,
			measurement: {
				status: "partial",
				observedSessions: 1,
				attributedSessions: 1,
				collection: global,
			},
			dailyBreakdown: [
				{
					date: "2025-01-15",
					userSessions: { [ALICE_KEY]: 1 },
					measurement: { status: "partial", collection: day1 },
				},
				{
					date: "2025-01-16",
					userSessions: {},
					measurement: { status: "unavailable", observedSessions: 0, collection: day2 },
				},
			],
		});
		global.failedSnapshots = 99;
		day1.failedSnapshots = 99;
		expect(result.measurement.collection.failedSnapshots).toBe(3);
		expect(result.dailyBreakdown[0]?.measurement?.collection.failedSnapshots).toBe(1);
	});
	it("sorts observation totals descending and uses stable opaque keys for ties", () => {
		const result = aggregateUserAnalytics([
			snapshot("2025-01-15T10:00:00Z", [
				session("charlie-id", "charlie"),
				session("charlie-id", "charlie"),
				session("alice-id", "alice"),
				session("bob-id", "bob"),
			]),
		]);
		expect(result.users.map((u) => [u.username, u.totalSessions])).toEqual([
			["charlie", 2],
			["alice", 1],
			["bob", 1],
		]);
	});
	it("conserves daily and global observations over independent uneven pages and unknown legacy details", () => {
		const rows = [
			snapshot(
				"2025-01-15T10:00:00Z",
				[session("alice-id", "alice", 20), session("bob-id", "bob", 30)],
				2,
				50,
			),
			snapshot("2025-01-16T10:00:00Z", [session("alice-id", "alice", 40)], 1, 40),
			snapshot("2025-01-16T10:05:00Z", [session()], 0, null, { sessionsJson: "broken-json" }),
			snapshot("2025-01-16T10:10:00Z", [session(), session()], 0, null, { measurementJson: null }),
		];
		const accumulator = createUserAnalyticsAccumulator();
		accumulator.addSnapshots(rows.slice(0, 1));
		accumulator.addSnapshots([]);
		accumulator.addSnapshots(rows.slice(1));
		const result = accumulator.getResult();
		expect(result).toEqual(aggregateUserAnalytics(rows));
		expect(result).toMatchObject({
			users: [
				{ key: ALICE_KEY, totalSessions: 2, avgBandwidth: 30, estimatedWatchTimeMinutes: 10 },
				{ key: BOB_KEY, totalSessions: 1, avgBandwidth: 30 },
			],
			parseFailures: 1,
			totalSnapshots: 4,
			measurement: {
				status: "partial",
				observedSessions: 6,
				attributedSessions: 3,
				unattributedSessions: 3,
				invalidDetailSnapshots: 1,
				collection: collection({ activeSnapshots: 3, legacySnapshots: 1 }),
			},
			dailyBreakdown: [
				{
					date: "2025-01-15",
					userSessions: { [ALICE_KEY]: 1, [BOB_KEY]: 1 },
					measurement: { observedSessions: 2, attributedSessions: 2, unattributedSessions: 0 },
				},
				{
					date: "2025-01-16",
					userSessions: { [ALICE_KEY]: 1 },
					measurement: { observedSessions: 4, attributedSessions: 1, unattributedSessions: 3 },
				},
			],
		});
		for (const day of result.dailyBreakdown)
			expect(
				Object.values(day.userSessions).reduce((sum, count) => sum + count, 0) +
					day.measurement!.unattributedSessions,
			).toBe(day.measurement!.observedSessions);
		expect(
			result.users.reduce((sum, user) => sum + user.totalSessions, 0) +
				result.measurement.unattributedSessions,
		).toBe(6);
	});
});
