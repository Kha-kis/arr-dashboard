import { describe, expect, it } from "vitest";
import { buildPlexSessionSnapshot } from "../../../plugins/lib/session-snapshot-measurements.js";
import { aggregatePlaysByDate } from "../lib/plays-by-date-helpers.js";
import { aggregateTopMedia } from "../lib/top-media-helpers.js";
import { deduplicateWatchEvents } from "../lib/watch-history-helpers.js";

function sample(
	overrides: {
		instanceId?: string;
		userId?: string;
		user?: string;
		itemId?: string;
		sessionId?: string;
		generation?: number;
		time?: string;
	} = {},
) {
	return {
		instanceId: overrides.instanceId ?? "source",
		capturedAt: new Date(overrides.time ?? "2026-10-05T12:00:00Z"),
		...buildPlexSessionSnapshot(
			[
				{
					sessionKey: overrides.sessionId ?? "playback",
					ratingKey: overrides.itemId ?? "item",
					title: "Synthetic shared label",
					type: "movie",
					user: {
						id: overrides.userId ?? "actor",
						title: overrides.user ?? "Synthetic shared viewer",
					},
					player: { title: "Synthetic player", platform: "Synthetic platform" },
					state: "playing",
					videoDecision: "direct play",
				} as never,
			],
			{ connectionGeneration: 0, identityGeneration: overrides.generation ?? 0 },
		),
	};
}

function assertPlays(rows: ReturnType<typeof sample>[], count: number) {
	expect(aggregateTopMedia(rows, { mediaType: "movie", limit: 10 }).items[0]?.playCount).toBe(
		count,
	);
	expect(deduplicateWatchEvents(rows, 50).events).toHaveLength(count);
	expect(
		aggregatePlaysByDate(rows, { days: 1, now: new Date("2026-10-05T13:00:00Z") }).series[0]?.data,
	).toEqual([count]);
}

describe("native source/actor/playback identity instead of display labels", () => {
	it("returns distinct opaque event keys for identical display labels across sources", () => {
		const events = deduplicateWatchEvents(
			[sample(), sample({ instanceId: "source-two" })],
			50,
		).events;
		expect(new Set(events.map((event) => event.key)).size).toBe(2);
		expect(events.every((event) => /^[a-f0-9]{64}$/.test(event.key ?? ""))).toBe(true);
	});
	it("keeps two independent sources with identical labels and native IDs separate", () => {
		const rows = [sample(), sample({ instanceId: "source-two" })];
		assertPlays(rows, 2);
		expect(
			aggregateTopMedia(rows, { mediaType: "movie", limit: 10 }).items[0]?.distinctUserCount,
		).toBe(2);
	});
	it("keeps reused user IDs across captured server replacements separate", () => {
		const rows = [sample(), sample({ generation: 1 })];
		assertPlays(rows, 2);
		expect(
			aggregateTopMedia(rows, { mediaType: "movie", limit: 10 }).items[0]?.distinctUserCount,
		).toBe(2);
	});
	it("deduplicates renamed labels for the same source-scoped actor/playback", () => {
		const rows = [
			sample(),
			sample({ user: "Synthetic renamed viewer", time: "2026-10-05T12:05:00Z" }),
		];
		assertPlays(rows, 1);
		expect(
			aggregateTopMedia(rows, { mediaType: "movie", limit: 10 }).items[0]?.distinctUserCount,
		).toBe(1);
	});
	it.each([{ itemId: "other-item" }, { sessionId: "other-playback" }])(
		"does not collapse distinct native playback coordinates $itemId $sessionId",
		(other) => {
			const rows = [sample(), sample(other)];
			assertPlays(rows, 2);
			expect(
				aggregateTopMedia(rows, { mediaType: "movie", limit: 10 }).items[0]?.distinctUserCount,
			).toBe(1);
		},
	);
	it("retains legacy observations without inventing a common Unknown viewer or play", () => {
		const rows = [sample(), sample()].map((row) => ({ ...row, measurementJson: null }));
		const item = aggregateTopMedia(rows, { mediaType: "movie", limit: 10 }).items[0];
		expect(item).toMatchObject({
			title: "Synthetic shared label",
			playCount: 0,
			distinctUserCount: 0,
			unattributedSessions: 2,
			unidentifiedPlaybackSessions: 2,
		});
		expect(deduplicateWatchEvents(rows, 50).events).toHaveLength(2);
	});
});
