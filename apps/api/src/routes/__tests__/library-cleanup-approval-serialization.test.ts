import { describe, expect, it } from "vitest";
import { serializeApproval } from "../library-cleanup.js";

describe("library cleanup approval serialization", () => {
	it("returns the persisted execution error for an actionable retry", () => {
		const timestamp = new Date("2026-07-27T12:00:00.000Z");

		expect(
			serializeApproval({
				id: "approval-1",
				instanceId: "radarr-4k",
				arrItemId: 101,
				itemType: "movie",
				title: "Example Movie",
				matchedRuleId: "rule-1",
				matchedRuleName: "4K cleanup",
				reason: "Matched 4K profile",
				action: "delete",
				sizeOnDisk: 1000n,
				year: 2024,
				rating: 8,
				status: "pending",
				lastExecutionError: "Skipped for safety: shared Plex risk",
				reviewedAt: null,
				executedAt: null,
				createdAt: timestamp,
				expiresAt: timestamp,
			}),
		).toMatchObject({
			id: "approval-1",
			targetScope: "series",
			arrEpisodeId: null,
			seasonNumber: null,
			episodeNumber: null,
			seriesTitle: "Example Movie",
			episodeTitle: null,
			status: "pending",
			lastExecutionError: "Skipped for safety: shared Plex risk",
		});
	});

	it("serializes an episode approval's immutable coordinates without changing title", () => {
		const timestamp = new Date("2026-08-12T00:00:00.000Z");

		expect(
			serializeApproval({
				id: "approval-episode",
				targetScope: "episode",
				arrEpisodeId: 456,
				seasonNumber: 2,
				episodeNumber: 7,
				title: "Example Series",
				episodeTitle: "Episode Seven",
				sizeOnDisk: 42n,
				createdAt: timestamp,
				expiresAt: timestamp,
			}),
		).toMatchObject({
			targetScope: "episode",
			arrEpisodeId: 456,
			seasonNumber: 2,
			episodeNumber: 7,
			title: "Example Series",
			seriesTitle: "Example Series",
			episodeTitle: "Episode Seven",
		});
	});

	it("normalizes approvals without an execution error to null", () => {
		const timestamp = new Date("2026-07-27T12:00:00.000Z");

		expect(
			serializeApproval({
				id: "approval-1",
				sizeOnDisk: 0n,
				createdAt: timestamp,
				expiresAt: timestamp,
			}).lastExecutionError,
		).toBeNull();
	});
});
