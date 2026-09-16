import { describe, expect, it } from "vitest";
import type { PlexPositiveEpisodeParentTarget } from "../plex-episode-live-collector.js";
import {
	PLEX_EPISODE_PARENT_COPIES_PER_UNIT,
	planPlexEpisodeRefresh,
} from "../plex-episode-refresh-plan.js";

function target(index: number, overrides: Partial<PlexPositiveEpisodeParentTarget> = {}) {
	return {
		instanceId: "plex-1",
		generationId: "parent-generation-1",
		showTmdbId: index + 1,
		sectionId: "shows",
		sectionUuid: "shows-uuid",
		mediaType: "series" as const,
		tvdbId: index + 1000,
		ratingKey: `show-${index + 1}`,
		...overrides,
	};
}

describe("planPlexEpisodeRefresh", () => {
	it("creates deterministic bounded units for the 622-target scale fixture", () => {
		const targets = Array.from({ length: 622 }, (_, index) => target(index)).reverse();
		const plan = planPlexEpisodeRefresh(targets);
		const reordered = planPlexEpisodeRefresh([...targets].reverse());

		expect(plan.units).toHaveLength(13);
		expect(plan.units.map((unit) => unit.ordinal)).toEqual(
			Array.from({ length: 13 }, (_, index) => index),
		);
		expect(
			plan.units.every((unit) => unit.targets.length <= PLEX_EPISODE_PARENT_COPIES_PER_UNIT),
		).toBe(true);
		expect(plan.units.flatMap((unit) => unit.targets)).toHaveLength(622);
		expect(plan.targetCount).toBe(622);
		expect(plan.targetDigest).toBe(reordered.targetDigest);
		expect(plan.units.map((unit) => unit.scopeDigest)).toEqual(
			reordered.units.map((unit) => unit.scopeDigest),
		);
	});

	it.each([
		["showTmdbId", { showTmdbId: 9001 }],
		["sectionId", { sectionId: "shows-2" }],
		["sectionUuid", { sectionUuid: "shows-uuid-2" }],
		["ratingKey", { ratingKey: "show-changed" }],
		["tvdbId", { tvdbId: 9002 }],
	] as const)("changes the target digest when %s changes", (_field, change) => {
		const baseline = planPlexEpisodeRefresh([target(0), target(1)]);
		const changed = planPlexEpisodeRefresh([target(0), target(1, change)]);
		expect(changed.targetDigest).not.toBe(baseline.targetDigest);
	});

	it("retains separate source copies for the same TMDB show", () => {
		const plan = planPlexEpisodeRefresh([
			target(0, { ratingKey: "copy-a" }),
			target(0, { ratingKey: "copy-b", sectionId: "shows-4k", sectionUuid: "shows-4k-uuid" }),
		]);

		expect(plan.units.flatMap((unit) => unit.targets)).toEqual([
			target(0, { ratingKey: "copy-a" }),
			target(0, { ratingKey: "copy-b", sectionId: "shows-4k", sectionUuid: "shows-4k-uuid" }),
		]);
	});

	it.each([
		["mixed instance", { instanceId: "plex-2" }],
		["mixed generation", { generationId: "parent-generation-2" }],
		["empty instance", { instanceId: "" }],
		["empty generation", { generationId: "" }],
	] as const)("rejects %s authority before a unit is made", (_name, change) => {
		expect(() => planPlexEpisodeRefresh([target(0), target(1, change)])).toThrow();
	});

	it("rejects duplicate source rating keys instead of deduplicating", () => {
		expect(() =>
			planPlexEpisodeRefresh([target(0, { ratingKey: "same" }), target(1, { ratingKey: "same" })]),
		).toThrow(/duplicate/i);
	});
});
