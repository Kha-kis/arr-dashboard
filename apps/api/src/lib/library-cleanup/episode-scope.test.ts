import { describe, expect, it } from "vitest";
import {
	buildEpisodeTargetKey,
	type EpisodeCleanupCandidate,
	evaluateEpisodeWatchCountRule,
} from "./episode-scope.js";

function candidate(overrides: Partial<EpisodeCleanupCandidate> = {}): EpisodeCleanupCandidate {
	return {
		instanceId: "sonarr-1",
		arrSeriesId: 42,
		arrEpisodeId: 4201,
		seasonNumber: 1,
		episodeNumber: 1,
		episodeFileId: 7001,
		episodeFileConsumerIds: [4201],
		seriesTitle: "Bluey",
		episodeTitle: "Magic Xylophone",
		monitored: true,
		respectQuiSeeding: true,
		watchCount: 1,
		lastWatchedAt: new Date("2026-07-29T12:00:00.000Z"),
		watchedByUsers: ["Parent"],
		plexWatchEvidence: [
			{
				plexInstanceId: "plex-1",
				sourceFingerprint: "plex-source-1",
				ratingKey: "episode-1",
				watchCount: 1,
				lastWatchedAt: new Date("2026-07-29T12:00:00.000Z"),
				watchedByUsers: ["Parent"],
				refreshedAt: new Date("2026-07-29T12:05:00.000Z"),
			},
		],
		file: {
			arrEpisodeFileId: 7001,
			path: "/tv/Bluey/Season 01/Bluey.S01E01.mkv",
			size: 1234n,
			infoHash: null,
			torrentState: null,
		},
		...overrides,
	};
}

describe("episode cleanup scope", () => {
	it("matches only when the watch count is above the exact configured threshold", () => {
		expect(
			evaluateEpisodeWatchCountRule(candidate({ watchCount: 1 }), {
				id: "rule-episode",
				name: "Remove watched episodes",
				parameters: JSON.stringify({ operator: "greater_than", count: 1 }),
				action: "delete_files",
			}),
		).toBeNull();

		expect(
			evaluateEpisodeWatchCountRule(candidate({ watchCount: 2 }), {
				id: "rule-episode",
				name: "Remove watched episodes",
				parameters: JSON.stringify({ operator: "greater_than", count: 1 }),
				action: "delete_files",
			}),
		).toMatchObject({ action: "delete_files", reason: "Plex watch count 2 > 1" });
	});

	it("keys sibling episodes as independent cleanup targets", () => {
		expect(buildEpisodeTargetKey(candidate())).not.toBe(
			buildEpisodeTargetKey(
				candidate({
					arrEpisodeId: 4202,
					episodeNumber: 2,
					episodeFileId: 7002,
					episodeFileConsumerIds: [4202],
				}),
			),
		);
	});

	it("rejects malformed persisted actions instead of defaulting them to delete", () => {
		expect(
			evaluateEpisodeWatchCountRule(candidate(), {
				id: "rule-episode",
				name: "Malformed persisted rule",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
				action: "destroy_everything",
			}),
		).toBeNull();
	});

	it("does not aggregate watch counts across Plex sources", () => {
		const item = candidate({
			watchCount: 1,
			plexWatchEvidence: [
				candidate().plexWatchEvidence[0]!,
				{
					...candidate().plexWatchEvidence[0]!,
					plexInstanceId: "plex-2",
					sourceFingerprint: "plex-source-2",
					ratingKey: "other-copy",
				},
			],
		});
		expect(
			evaluateEpisodeWatchCountRule(item, {
				id: "rule-episode",
				name: "More than one play",
				parameters: JSON.stringify({ operator: "greater_than", count: 1 }),
				action: "delete",
			}),
		).toBeNull();
	});
});
