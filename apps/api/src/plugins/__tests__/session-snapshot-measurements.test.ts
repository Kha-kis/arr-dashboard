import { describe, expect, it } from "vitest";
import type { JellyfinSession } from "../../lib/jellyfin/jellyfin-client.js";
import type { PlexSessionItem } from "../../lib/plex/plex-client.js";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
	parseSessionSnapshotMeasurement,
	readSessionSnapshotActorKey,
	type SessionSnapshotMeasurement,
} from "../lib/session-snapshot-measurements.js";

function plex(overrides: Partial<PlexSessionItem> = {}): PlexSessionItem {
	return {
		sessionKey: "session-1",
		ratingKey: "item-1",
		title: "Synthetic item",
		type: "movie",
		user: { id: "7", title: "Synthetic user" },
		player: {
			title: "Synthetic player",
			platform: "Synthetic platform",
			product: "Synthetic",
			state: "playing",
		},
		state: "playing",
		viewOffset: 500,
		duration: 1000,
		videoDecision: "unknown",
		audioDecision: "unknown",
		...overrides,
	};
}
function jellyfin(overrides: Partial<JellyfinSession> = {}): JellyfinSession {
	return {
		id: "session-1",
		userId: "user-1",
		isPaused: false,
		positionMs: 500,
		durationMs: 1000,
		...overrides,
	};
}

describe("native snapshot measurement provenance", () => {
	it("hashes the captured actor tuple exactly without labels or playback coordinates", () => {
		const snapshot = buildPlexSessionSnapshot([plex()], {
			connectionGeneration: 0,
			identityGeneration: 0,
		});
		const receipt = JSON.parse(snapshot.measurementJson);
		expect(
			readSessionSnapshotActorKey(
				"source",
				{ userId: "7", user: "Renamed", sessionId: "another" },
				receipt,
			),
		).toBe("52e216655de675b7307f143efeec1d9206b44598aade5741b6a6e18ac609906e");
	});
	it.each([
		null,
		{},
		{ connectionGeneration: 0 },
		{ connectionGeneration: -1, identityGeneration: 0 },
		{ connectionGeneration: 0, identityGeneration: 0.5 },
		{ connectionGeneration: 2_147_483_648, identityGeneration: 0 },
		{ connectionGeneration: 0, identityGeneration: "0" },
		{ connectionGeneration: 0, identityGeneration: 0, unexpected: true },
	])(
		"rejects malformed supplied scope without silently repairing measurements (%j)",
		(sourceScope) => {
			const receipt = JSON.parse(buildPlexSessionSnapshot([plex()]).measurementJson);
			const malformed = { ...receipt, sourceScope };
			expect(parseSessionSnapshotMeasurement(JSON.stringify(malformed))).toEqual({
				status: "invalid",
			});
			expect(
				readSessionSnapshotActorKey(
					"source",
					{ userId: "7" },
					malformed as SessionSnapshotMeasurement,
				),
			).toBeNull();
			for (const build of [
				() => buildPlexSessionSnapshot([], sourceScope as never),
				() => buildJellyfinSessionSnapshot([jellyfin()], "JELLYFIN", sourceScope as never),
				() => buildFailedSessionSnapshot("EMBY", sourceScope as never),
			])
				expect(build).toThrow();
		},
	);
	it("accepts explicit Int32 generation bounds without inventing scope for historical rows", () => {
		const scope = { connectionGeneration: 0, identityGeneration: 2_147_483_647 };
		const scoped = buildFailedSessionSnapshot("PLEX", scope);
		expect(parseSessionSnapshotMeasurement(scoped.measurementJson)).toMatchObject({
			status: "verified",
			measurement: { sourceScope: scope },
		});
		const historical = buildPlexSessionSnapshot([plex({ bandwidth: 1 })]);
		const parsed = parseSessionSnapshotMeasurement(historical.measurementJson);
		expect(parsed).toMatchObject({
			status: "verified",
			measurement: { bandwidth: { knownTotalKbps: 1 } },
		});
		if (parsed.status !== "verified") throw new Error("Historical receipt rejected");
		expect(parsed.measurement).not.toHaveProperty("sourceScope");
		expect(readSessionSnapshotActorKey("source", { userId: "7" }, parsed.measurement)).toBeNull();
	});
	it.each([
		{ instanceId: "", row: { userId: "7" } },
		{ instanceId: "  ", row: { userId: "7" } },
		{ instanceId: null, row: { userId: "7" } },
		{ instanceId: 7, row: { userId: "7" } },
		{ instanceId: "source", row: null },
		{ instanceId: "source", row: {} },
		{ instanceId: "source", row: { userId: "  " } },
		{ instanceId: "source", row: { userId: 7 } },
	])(
		"does not invent actor coordinates from invalid source or native ID (%j)",
		({ instanceId, row }) => {
			const receipt = JSON.parse(
				buildPlexSessionSnapshot([plex()], { connectionGeneration: 0, identityGeneration: 0 })
					.measurementJson,
			);
			expect(readSessionSnapshotActorKey(instanceId, row, receipt)).toBeNull();
		},
	);
	it("requires provider and the historical Plex native-identity marker even with explicit scope", () => {
		const receipt = JSON.parse(
			buildPlexSessionSnapshot([plex()], { connectionGeneration: 0, identityGeneration: 0 })
				.measurementJson,
		);
		delete receipt.userIdentity;
		expect(readSessionSnapshotActorKey("source", { userId: "7" }, receipt)).toBeNull();
		expect(
			readSessionSnapshotActorKey("source", { userId: "7" }, { ...receipt, provider: "TAUTULLI" }),
		).toBeNull();
	});
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"validates the explicit device label axis without rejecting historical %s receipts",
		(provider) => {
			const old = JSON.parse(buildFailedSessionSnapshot(provider).measurementJson);
			delete old.deviceLabelAxis;
			expect(parseSessionSnapshotMeasurement(JSON.stringify(old)).status).toBe("verified");
			const axis = provider === "PLEX" ? "platform" : "client";
			expect(
				parseSessionSnapshotMeasurement(JSON.stringify({ ...old, deviceLabelAxis: axis })).status,
			).toBe("verified");
			for (const deviceLabelAxis of [
				provider === "PLEX" ? "client" : "platform",
				"device",
				null,
				1,
			]) {
				expect(
					parseSessionSnapshotMeasurement(JSON.stringify({ ...old, deviceLabelAxis })).status,
				).toBe("invalid");
			}
		},
	);
	it("preserves old native measurement receipts without certifying historical Plex IDs", () => {
		const receipt = JSON.parse(buildPlexSessionSnapshot([plex()]).measurementJson);
		delete receipt.userIdentity;
		expect(parseSessionSnapshotMeasurement(JSON.stringify(receipt))).toMatchObject({
			status: "verified",
			measurement: { provider: "PLEX", observedSessions: 1 },
		});
		for (const userIdentity of ["coerced", 1, null])
			expect(
				parseSessionSnapshotMeasurement(JSON.stringify({ ...receipt, userIdentity })).status,
			).toBe("invalid");
	});
	it.each(["JELLYFIN", "EMBY"] as const)(
		"counts audio-only transcoding as video copy consistently with Plex for %s",
		(provider) => {
			const snapshots = [
				buildPlexSessionSnapshot([plex({ videoDecision: "copy", audioDecision: "transcode" })]),
				buildJellyfinSessionSnapshot(
					[
						jellyfin({
							playMethod: "Transcode",
							transcodingInfo: { isVideoDirect: true, isAudioDirect: false },
						}),
					],
					provider,
				),
			];
			for (const snapshot of snapshots) {
				expect(JSON.parse(snapshot.measurementJson)).toMatchObject({
					methods: {
						directPlayCount: 0,
						directStreamCount: 1,
						transcodeCount: 0,
						unknownDecisionCount: 0,
					},
				});
				expect(snapshot.directStreamCount).toBe(1);
				expect(snapshot.transcodeCount).toBe(0);
			}
			for (const snapshot of snapshots)
				expect(JSON.parse(snapshot.measurementJson).methodAxis).toBe("video");
		},
	);
	it("retains unmarked native v1 receipts but rejects unsupported method axes", () => {
		const receipt = JSON.parse(buildPlexSessionSnapshot([plex()]).measurementJson);
		delete receipt.methodAxis;
		expect(parseSessionSnapshotMeasurement(JSON.stringify(receipt)).status).toBe("verified");
		expect(
			parseSessionSnapshotMeasurement(JSON.stringify({ ...receipt, methodAxis: "video" })).status,
		).toBe("verified");
		expect(
			parseSessionSnapshotMeasurement(JSON.stringify({ ...receipt, methodAxis: "overall" })).status,
		).toBe("invalid");
	});
	it("distinguishes missing Plex rates from measured zero and keeps unknown methods separate", () => {
		const result = buildPlexSessionSnapshot([
			plex(),
			plex({ bandwidth: 0, videoDecision: "direct play" }),
		]);
		expect(result.directPlayCount).toBe(1);
		expect(result.totalBandwidth).toBe(0);
		expect(
			JSON.parse(result.sessionsJson).map((row: { bandwidth: unknown }) => row.bandwidth),
		).toEqual([null, 0]);
		expect(JSON.parse(result.measurementJson)).toMatchObject({
			version: 1,
			provider: "PLEX",
			status: "active",
			bandwidthBasis: "provider-reported",
			observedSessions: 2,
			bandwidth: { status: "partial", observedSessions: 2, measuredSessions: 1, knownTotalKbps: 0 },
			methods: {
				directPlayCount: 1,
				directStreamCount: 0,
				transcodeCount: 0,
				unknownDecisionCount: 1,
			},
			network: { status: "unavailable", lanKbps: null, wanKbps: null },
		});
	});
	it("retains native Plex quality, coordinates and playback offsets without optional enrichment", () => {
		const result = buildPlexSessionSnapshot([
			plex({
				videoDecision: "copy",
				audioDecision: "transcode",
				bandwidth: 123.25,
				videoCodec: "h264",
				audioCodec: "aac",
				videoResolution: "1920x1080",
			}),
		]);
		expect(JSON.parse(result.sessionsJson)[0]).toMatchObject({
			provider: "PLEX",
			sessionId: "session-1",
			itemId: "item-1",
			userId: "7",
			positionMs: 500,
			durationMs: 1000,
			videoDecision: "copy",
			audioDecision: "transcode",
			videoCodec: "h264",
			audioCodec: "aac",
			videoResolution: "1920x1080",
			bandwidth: 123.25,
			platform: "Synthetic platform",
			player: "Synthetic player",
		});
		expect(JSON.parse(result.measurementJson).bandwidth.knownTotalKbps).toBe(123.25);
		expect(result.directStreamCount).toBe(1);
	});
	it.each([undefined, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"never stores an invalid rate as measured zero (%s)",
		(bandwidth) => {
			const result = buildPlexSessionSnapshot([plex({ bandwidth })]);
			expect(JSON.parse(result.sessionsJson)[0].bandwidth).toBeNull();
			expect(JSON.parse(result.measurementJson).bandwidth).toEqual({
				status: "unavailable",
				observedSessions: 1,
				measuredSessions: 0,
				knownTotalKbps: null,
			});
		},
	);
	it("keeps a finite large rate in the receipt without overflowing the compatibility Int column", () => {
		const result = buildPlexSessionSnapshot([plex({ bandwidth: 3_000_000_000.25 })]);
		expect(result.totalBandwidth).toBe(0);
		expect(JSON.parse(result.measurementJson).bandwidth.knownTotalKbps).toBe(3_000_000_000.25);
	});
	it("reports unavailable aggregate on numeric overflow rather than serializing Infinity as known zero", () => {
		const result = buildPlexSessionSnapshot([
			plex({ bandwidth: Number.MAX_VALUE }),
			plex({ bandwidth: Number.MAX_VALUE }),
		]);
		expect(JSON.parse(result.measurementJson).bandwidth).toEqual({
			status: "unavailable",
			observedSessions: 2,
			measuredSessions: 2,
			knownTotalKbps: null,
		});
		expect(parseSessionSnapshotMeasurement(result.measurementJson).status).toBe("verified");
	});
	it.each(["JELLYFIN", "EMBY"] as const)(
		"uses the same per-track native projection for %s without Direct Play defaults",
		(provider) => {
			const result = buildJellyfinSessionSnapshot(
				[
					jellyfin(),
					jellyfin({
						playMethod: "Transcode",
						transcodingInfo: {
							isVideoDirect: true,
							isAudioDirect: false,
							bitrate: 1234.5,
							width: 1920,
							height: 1080,
							videoCodec: "h264",
							audioCodec: "aac",
						},
					}),
					jellyfin({ playMethod: "DirectPlay", transcodingInfo: { bitrate: 0 } }),
				],
				provider,
			);
			expect(result.directPlayCount).toBe(1);
			expect(result.transcodeCount).toBe(0);
			expect(result.directStreamCount).toBe(1);
			expect(
				JSON.parse(result.sessionsJson).map(
					(row: { videoDecision: string; audioDecision: string; bandwidth: unknown }) => [
						row.videoDecision,
						row.audioDecision,
						row.bandwidth,
					],
				),
			).toEqual([
				["unknown", "unknown", null],
				["copy", "transcode", 1.2345],
				["direct play", "direct play", 0],
			]);
			expect(JSON.parse(result.sessionsJson)[1]).toMatchObject({
				provider,
				sessionId: "session-1",
				userId: "user-1",
				positionMs: 500,
				durationMs: 1000,
				videoResolution: "1920x1080",
			});
			expect(JSON.parse(result.measurementJson)).toMatchObject({
				provider,
				bandwidthBasis: "encoding-estimate",
				observedSessions: 3,
				bandwidth: {
					status: "partial",
					observedSessions: 3,
					measuredSessions: 2,
					knownTotalKbps: 1.2345,
				},
				methods: { unknownDecisionCount: 1 },
			});
		},
	);
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"separates healthy idle from provider failure for %s",
		(provider) => {
			const idle =
				provider === "PLEX"
					? buildPlexSessionSnapshot([])
					: buildJellyfinSessionSnapshot([], provider);
			const failed = buildFailedSessionSnapshot(provider);
			expect(JSON.parse(idle.measurementJson)).toMatchObject({
				status: "idle",
				observedSessions: 0,
				bandwidth: {
					status: "complete",
					observedSessions: 0,
					measuredSessions: 0,
					knownTotalKbps: 0,
				},
				network: { status: "complete", lanKbps: 0, wanKbps: 0 },
			});
			expect(JSON.parse(failed.measurementJson)).toMatchObject({
				status: "failed",
				observedSessions: null,
				bandwidth: null,
				methods: null,
				network: { status: "unavailable", lanKbps: null, wanKbps: null },
			});
			expect(idle.sessionsJson).toBe("[]");
			expect(failed.sessionsJson).toBe("[]");
			expect(parseSessionSnapshotMeasurement(idle.measurementJson).status).toBe("verified");
			expect(parseSessionSnapshotMeasurement(failed.measurementJson).status).toBe("verified");
		},
	);
	it.each([null, undefined])("only absent provenance is legacy (%s)", (receipt) => {
		expect(parseSessionSnapshotMeasurement(receipt)).toEqual({ status: "legacy" });
	});
	it.each(["", "{}", "null", "not json", JSON.stringify({ version: 2 })])(
		"never certifies malformed provenance (%s)",
		(receipt) => {
			expect(parseSessionSnapshotMeasurement(receipt)).toEqual({ status: "invalid" });
		},
	);
	it.each([
		{ observedSessions: 0 },
		{ provider: "TAUTULLI" },
		{ bandwidthBasis: "encoding-estimate" },
		{
			methods: {
				directPlayCount: 0,
				directStreamCount: 0,
				transcodeCount: 0,
				unknownDecisionCount: 0,
			},
		},
		{
			bandwidth: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 0,
				knownTotalKbps: 0,
			},
		},
		{
			bandwidth: { status: "partial", observedSessions: 1, measuredSessions: 1, knownTotalKbps: 1 },
		},
		{
			bandwidth: {
				status: "complete",
				observedSessions: 2,
				measuredSessions: 2,
				knownTotalKbps: 1,
			},
		},
		{ network: { status: "complete", lanKbps: 0, wanKbps: 0 } },
	])("rejects contradictory active receipts %j", (change) => {
		const receipt = JSON.parse(
			buildPlexSessionSnapshot([plex({ bandwidth: 0, videoDecision: "direct play" })])
				.measurementJson,
		);
		expect(parseSessionSnapshotMeasurement(JSON.stringify({ ...receipt, ...change }))).toEqual({
			status: "invalid",
		});
	});
});
