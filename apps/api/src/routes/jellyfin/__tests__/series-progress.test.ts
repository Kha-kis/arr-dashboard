import { describe, expect, it } from "vitest";
import type {
	JellyfinDisplayInstance,
	JellyfinEpisodeDisplayEvidence,
} from "../../../lib/jellyfin/jellyfin-display-evidence.js";
import { jellyfinMappedSeriesProgressProof } from "../../../lib/jellyfin/jellyfin-generation-scoped-display.js";
import { projectJellyfinSeriesProgress } from "../series-progress-routes.js";

const instances: JellyfinDisplayInstance[] = [
	{ id: "first", label: "First", service: "JELLYFIN" },
	{ id: "second", label: "Second", service: "JELLYFIN" },
];
const firstObservedAt = "2026-11-10T10:00:00.000Z";
const secondObservedAt = "2026-11-10T11:00:00.000Z";
const coordinate = (episodeNumber: number, watched: boolean) => ({
	seasonNumber: 1,
	episodeNumber,
	watched,
});
const watchedRow = {
	id: "episode",
	instanceId: "first",
	jellyfinId: "native",
	showTmdbId: 42,
	title: "Synthetic episode",
	...coordinate(1, true),
	watchedByUsers: "[]",
	lastWatchedAt: null,
	connectionGeneration: 1,
	identityGeneration: 1,
};

function evidence(): JellyfinEpisodeDisplayEvidence {
	return {
		sources: [
			{
				instanceId: "first",
				instanceName: "First",
				rows: [watchedRow],
				[jellyfinMappedSeriesProgressProof]: {
					observedAt: firstObservedAt,
					coordinatesByShow: new Map([[42, [coordinate(1, true), coordinate(2, false)]]]),
				},
			},
			{
				instanceId: "second",
				instanceName: "Second",
				rows: [],
				[jellyfinMappedSeriesProgressProof]: {
					observedAt: secondObservedAt,
					coordinatesByShow: new Map([[42, [coordinate(1, false), coordinate(3, false)]]]),
				},
			},
		],
		providerStatus: {
			availability: "partial",
			sources: instances.map(({ id }, index) => ({
				instanceId: id,
				service: "jellyfin",
				cacheType: "jellyfin_episode",
				status: {
					availability: "partial",
					evidence: "positive-only",
					observedAt: index === 0 ? firstObservedAt : secondObservedAt,
					ageSeconds: 0,
					latestAttempt: "successful",
					reasonCodes: ["coverage-incomplete", "positive-only"],
				},
			})),
		},
	};
}

describe("Jellyfin mapped series progress projection", () => {
	it("deduplicates coordinates and reports the oldest contributing observation", () => {
		const display = evidence();
		const result = projectJellyfinSeriesProgress(instances, display, [42, 43]);
		expect(result.progress[42], "mapped denominator across sources").toEqual({
			status: "mapped",
			total: 3,
			watched: 1,
			percent: 33,
			watchedSemantics: "matched",
			observedAt: firstObservedAt,
		});
		expect(result.progress[43]).toMatchObject({ status: "unknown", total: null });
		expect(result.providerStatus).toEqual(display.providerStatus);
	});

	it("combines a retained mapped snapshot with complete evidence without promoting it to exact", () => {
		const display = evidence();
		const [first, second] = display.providerStatus!.sources;
		first!.status.availability = "last-known";
		first!.status.reasonCodes.push("refresh-running");
		second!.status = {
			...second!.status,
			availability: "current",
			evidence: "complete",
			reasonCodes: [],
		};
		const other = display.sources[1]!;
		delete other[jellyfinMappedSeriesProgressProof];
		other.rows.push({
			...watchedRow,
			instanceId: "second",
			...coordinate(3, false),
		});
		expect(projectJellyfinSeriesProgress(instances, display, [42]).progress[42]).toEqual({
			status: "mapped",
			total: 3,
			watched: 1,
			percent: 33,
			watchedSemantics: "matched",
			observedAt: firstObservedAt,
		});
	});

	it.each(["missing", "wrong observation time", "stale"] as const)(
		"keeps the watched lower bound when the other source is %s",
		(condition) => {
			const display = evidence();
			const other = display.sources[1]!;
			const status = display.providerStatus!.sources[1]!.status;
			if (condition === "missing") delete other[jellyfinMappedSeriesProgressProof];
			if (condition === "wrong observation time") status.observedAt = firstObservedAt;
			if (condition === "stale") status.reasonCodes.push("publication-stale");
			expect(projectJellyfinSeriesProgress(instances, display, [42]).progress[42]).toEqual({
				status: "partial",
				total: null,
				watched: 1,
				percent: null,
				watchedSemantics: "lower-bound",
			});
		},
	);
});
