import { describe, expect, it } from "vitest";
import type { JellyfinSession } from "../../../lib/jellyfin/jellyfin-client.js";
import type { PlexSessionItem } from "../../../lib/plex/plex-client.js";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import { aggregateBandwidthAnalytics } from "../lib/bandwidth-analytics-helpers.js";
import { computeQualityScore } from "../lib/quality-score-helpers.js";
import { aggregateUserAnalytics } from "../lib/user-analytics-helpers.js";

const originalScope = { connectionGeneration: 0, identityGeneration: 0 };
type Scope = typeof originalScope;
type Provider = "PLEX" | "JELLYFIN" | "EMBY";

function capture(provider: Provider, scope?: Scope, username = "Original viewer") {
	const plex: PlexSessionItem = {
		sessionKey: "session",
		ratingKey: "item",
		title: "Synthetic title",
		type: "movie",
		user: { id: "7", title: username },
		player: { title: "Device", platform: "Platform", product: "Synthetic", state: "playing" },
		state: "playing",
		viewOffset: 0,
		duration: 60_000,
		videoDecision: "direct play",
		audioDecision: "direct play",
		bandwidth: 100,
		videoResolution: "1080",
	};
	const jellyfin: JellyfinSession = {
		id: "session",
		userId: "7",
		userName: username,
		isPaused: false,
		positionMs: 0,
		durationMs: 60_000,
		playMethod: "DirectPlay",
		transcodingInfo: { bitrate: 100_000, width: 1920, height: 1080 },
	};
	const snapshot =
		provider === "PLEX"
			? buildPlexSessionSnapshot([plex], scope)
			: buildJellyfinSessionSnapshot([jellyfin], provider, scope);
	return { ...snapshot, instanceId: "source", capturedAt: new Date("2026-10-05T00:00:00Z") };
}

describe("captured native source scope", () => {
	it("separates replacement generations in quality analytics", () => {
		const result = computeQualityScore([
			capture("PLEX", originalScope),
			capture("PLEX", { connectionGeneration: 1, identityGeneration: 1 }),
		]);
		expect(result.perUser).toHaveLength(2);
	});
	it("keeps unscoped quality measurements without certifying actor identity", () => {
		expect(computeQualityScore([capture("PLEX")])).toMatchObject({
			perUser: [],
			overallScore: 93,
			measurement: { scoredSessions: 1, unattributedSessions: 1 },
		});
	});
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"preserves explicitly captured active, idle and failed scope for %s",
		(provider) => {
			const scope = { connectionGeneration: 2, identityGeneration: 3 };
			const active = capture(provider, scope);
			const idle =
				provider === "PLEX"
					? buildPlexSessionSnapshot([], scope)
					: buildJellyfinSessionSnapshot([], provider, scope);
			const failed = buildFailedSessionSnapshot(provider, scope);
			for (const snapshot of [active, idle, failed]) {
				expect(JSON.parse(snapshot.measurementJson).sourceScope).toEqual(scope);
			}
		},
	);
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"separates reused native user IDs across identity and connection generations for %s",
		(provider) => {
			const original = capture(provider, originalScope);
			const replaced = capture(
				provider,
				{ connectionGeneration: 0, identityGeneration: 1 },
				"Replacement viewer",
			);
			const reconnected = capture(
				provider,
				{ connectionGeneration: 1, identityGeneration: 1 },
				"Reconnected viewer",
			);
			const snapshots = [original, replaced, reconnected];
			const users = aggregateUserAnalytics(snapshots);
			const quality = computeQualityScore(snapshots);
			expect(users.users).toHaveLength(3);
			expect(quality.perUser).toHaveLength(3);
			expect(new Set(users.users.map((user) => user.key)).size).toBe(3);
			expect(quality.perUser.map((user) => user.key).sort()).toEqual(
				users.users.map((user) => user.key).sort(),
			);
			expect(
				users.users.every((user) => user.totalSessions === 1 && user.avgBandwidth === 100),
			).toBe(true);
			expect(quality.overallScore).toBe(93);
		},
	);
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"keeps a renamed native user in one actor within the captured scope for %s",
		(provider) => {
			const renamed = {
				...capture(provider, originalScope, "Renamed viewer"),
				capturedAt: new Date("2026-10-05T00:05:00Z"),
			};
			const snapshots = [renamed, capture(provider, originalScope)];
			expect(aggregateUserAnalytics(snapshots).users).toMatchObject([
				{ username: "Renamed viewer", totalSessions: 2 },
			]);
			expect(computeQualityScore(snapshots).perUser).toMatchObject([
				{ username: "Renamed viewer", sessions: 2 },
			]);
		},
	);
	it("separates identical native IDs across provider and instance coordinates", () => {
		const snapshots = [
			capture("PLEX", originalScope),
			capture("JELLYFIN", originalScope),
			{ ...capture("PLEX", originalScope), instanceId: "another-source" },
		];
		expect(aggregateUserAnalytics(snapshots).users).toHaveLength(3);
		expect(computeQualityScore(snapshots).perUser).toHaveLength(3);
	});
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"leaves unscoped historical identity unattributed while preserving valid measurements for %s",
		(provider) => {
			const snapshot = capture(provider);
			expect(JSON.parse(snapshot.measurementJson)).not.toHaveProperty("sourceScope");
			expect(aggregateUserAnalytics([snapshot])).toMatchObject({
				users: [],
				measurement: {
					observedSessions: 1,
					attributedSessions: 0,
					unattributedSessions: 1,
					collection: { activeSnapshots: 1 },
				},
			});
			expect(computeQualityScore([snapshot])).toMatchObject({
				perUser: [],
				overallScore: 93,
				measurement: { observedSessions: 1, scoredSessions: 1, unattributedSessions: 1 },
			});
			expect(aggregateBandwidthAnalytics([snapshot])).toMatchObject({
				avgBandwidth: 100,
				measurement: { status: "complete", measuredSessions: 1 },
			});
		},
	);
});
