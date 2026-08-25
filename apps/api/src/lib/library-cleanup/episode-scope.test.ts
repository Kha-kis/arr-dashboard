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
	it("matches a fresh episode watch count without changing the parent series identity", () => {
		const item = candidate();
		const match = evaluateEpisodeWatchCountRule(item, {
			id: "rule-episode",
			name: "Remove watched episodes",
			parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
			action: "delete",
			scanMediaServerAfterDelete: false,
		});

		expect(match).toEqual({
			ruleId: "rule-episode",
			ruleName: "Remove watched episodes",
			reason: "Plex watch count 1 > 0",
			action: "delete",
		});
		expect(item.arrSeriesId).toBe(42);
		expect(item.arrEpisodeId).toBe(4201);
	});

	it("does not match at or below the configured threshold", () => {
		expect(
			evaluateEpisodeWatchCountRule(candidate({ watchCount: 1 }), {
				id: "rule-episode",
				name: "Remove watched episodes",
				parameters: JSON.stringify({ operator: "greater_than", count: 1 }),
				action: "delete_files",
			}),
		).toBeNull();
	});

	it("keys two episode targets in the same series independently", () => {
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

	it("fails closed instead of defaulting a malformed persisted action to delete", () => {
		expect(
			evaluateEpisodeWatchCountRule(candidate(), {
				id: "rule-episode",
				name: "Malformed persisted rule",
				parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
				action: "destroy_everything",
			}),
		).toBeNull();
	});

	it("does not sum watch evidence from unrelated Plex instances", () => {
		const item = candidate({
			watchCount: 1,
			plexWatchEvidence: [
				candidate().plexWatchEvidence[0]!,
				{
					...candidate().plexWatchEvidence[0]!,
					plexInstanceId: "plex-2",
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

	it("selects an episode only when one positive lower-bound source is above the threshold", () => {
		const positiveSource = {
			...candidate().plexWatchEvidence[0]!,
			watchCount: 0,
			lowerBound: 2,
		};
		const rule = {
			id: "rule-episode",
			name: "Remove watched episodes",
			parameters: JSON.stringify({ operator: "greater_than", count: 1 }),
			action: "delete",
		};

		expect(
			evaluateEpisodeWatchCountRule(
				candidate({ watchCount: 0, plexWatchEvidence: [positiveSource] }),
				rule,
			),
		).toMatchObject({ reason: "Plex watch count 2 > 1" });
		expect(
			evaluateEpisodeWatchCountRule(
				candidate({ watchCount: 0, plexWatchEvidence: [positiveSource] }),
				{ ...rule, parameters: JSON.stringify({ operator: "greater_than", count: 2 }) },
			),
		).toBeNull();
		expect(
			evaluateEpisodeWatchCountRule(candidate({ watchCount: 0, plexWatchEvidence: [] }), rule),
		).toBeNull();
	});

	it("matches only reporter episode A while omitted and zero episodes remain unknown", () => {
		const positiveSource = {
			...candidate().plexWatchEvidence[0]!,
			watchCount: 0,
			lowerBound: 2,
		};
		const reporterRule = {
			id: "reporter-episode-rule",
			name: "Remove watched episodes",
			parameters: JSON.stringify({ operator: "greater_than", count: 0 }),
			action: "delete",
		};
		const reporterEpisodes = [
			{ id: "A", plexWatchEvidence: [positiveSource] },
			{ id: "B", plexWatchEvidence: [] },
			{ id: "C", plexWatchEvidence: [] },
		];

		expect(
			reporterEpisodes.flatMap((episode) =>
				evaluateEpisodeWatchCountRule(
					candidate({ watchCount: 0, plexWatchEvidence: episode.plexWatchEvidence }),
					reporterRule,
				)
					? [episode.id]
					: [],
			),
		).toEqual(["A"]);
	});

	it.each([
		["negative threshold", "greater_than", -1],
		["less-than", "less_than", 3],
		["equality", "equals", 2],
	] as const)("keeps positive-only %s rules unknown", (_case, operator, count) => {
		expect(
			evaluateEpisodeWatchCountRule(
				candidate({
					watchCount: 0,
					plexWatchEvidence: [
						{ ...candidate().plexWatchEvidence[0]!, watchCount: 0, lowerBound: 2 },
					],
				}),
				{
					id: "unsupported-positive-rule",
					name: "Unsupported positive rule",
					parameters: JSON.stringify({ operator, count }),
					action: "delete",
				},
			),
		).toBeNull();
	});
});
