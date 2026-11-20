import { describe, expect, it } from "vitest";
import {
	aggregateLastWatched,
	aggregatePopularMedia,
	aggregateTopMedia,
	createTopMediaAccumulator,
	type SnapshotForTopMedia,
} from "../lib/top-media-helpers.js";
import { activitySnapshot } from "./native-activity-test-fixtures.js";

function snapshot(
	capturedAt: string,
	sessions: Array<Record<string, unknown>>,
): SnapshotForTopMedia {
	return activitySnapshot(capturedAt, sessions);
}

function sessionsFor(mediaType: "movie" | "series" | "music") {
	const grouping = mediaType === "series" ? { grandparentTitle: "Main Show" } : {};
	const tieGrouping = mediaType === "series" ? { grandparentTitle: "Tie Show" } : {};
	const newestGrouping = mediaType === "series" ? { grandparentTitle: "Newest Show" } : {};
	return [
		snapshot("2025-01-15T10:31:00Z", [
			{
				user: "carol",
				title: mediaType === "series" ? "Newest Episode" : "Newest Title",
				mediaType,
				...newestGrouping,
			},
		]),
		snapshot("2025-01-15T10:30:00Z", [
			{
				user: "sam",
				title: mediaType === "series" ? "Tie Episode 2" : "Tie Title",
				mediaType,
				...tieGrouping,
			},
		]),
		snapshot("2025-01-15T10:20:00Z", [
			{
				user: "alice",
				title: mediaType === "series" ? "Episode 1" : "Main Title",
				mediaType,
				...grouping,
			},
		]),
		snapshot("2025-01-15T10:19:00Z", [
			{
				user: "sam",
				title: mediaType === "series" ? "Tie Episode 1" : "Tie Title",
				mediaType,
				...tieGrouping,
			},
		]),
		snapshot("2025-01-15T10:15:00Z", [
			{
				user: "alice",
				title: mediaType === "series" ? "Episode 2" : "Main Title",
				mediaType,
				...grouping,
			},
		]),
		snapshot("2025-01-15T10:10:00Z", [
			{
				user: "alice",
				title: mediaType === "series" ? "Episode 3" : "Main Title",
				mediaType,
				...grouping,
			},
		]),
		snapshot("2025-01-15T10:00:00Z", [
			{
				user: "bob",
				title: mediaType === "series" ? "Episode 4" : "Main Title",
				mediaType,
				...grouping,
			},
		]),
	];
}

describe("top media aggregators", () => {
	it.each(["movie", "series", "music"] as const)(
		"incrementally preserves ranking, grouped titles, distinct users, duration, and latest date for %s",
		(mediaType) => {
			const rows = sessionsFor(mediaType);
			const accumulator = createTopMediaAccumulator(mediaType);
			accumulator.addBatch(rows.slice(0, 3));
			accumulator.addBatch(rows.slice(3));

			const mainTitle = mediaType === "series" ? "Main Show" : "Main Title";
			const newestTitle = mediaType === "series" ? "Newest Show" : "Newest Title";
			const main = {
				title: mainTitle,
				mediaType,
				playCount: mediaType === "series" ? 4 : 2,
				distinctUserCount: 2,
				totalDurationMinutes: 20,
				lastWatchedAt: "2025-01-15T10:20:00.000Z",
			};
			const tie = {
				title: mediaType === "series" ? "Tie Show" : "Tie Title",
				mediaType,
				playCount: 2,
				distinctUserCount: 1,
				totalDurationMinutes: 10,
				lastWatchedAt: "2025-01-15T10:30:00.000Z",
			};
			const newest = {
				title: newestTitle,
				mediaType,
				playCount: 1,
				distinctUserCount: 1,
				totalDurationMinutes: 5,
				lastWatchedAt: "2025-01-15T10:31:00.000Z",
			};
			expect(accumulator.getResult("top", 10)).toMatchObject({
				items: [main, tie, newest],
				parseFailures: 0,
				totalSnapshots: 7,
				failedPreviews: [],
			});
			expect(accumulator.getResult("popular", 10).items).toMatchObject([main, tie, newest]);
			expect(accumulator.getResult("last-watched", 10).items).toMatchObject([newest, tie, main]);
		},
	);

	it("keeps the array helpers compatible while deriving results through the accumulator", () => {
		const rows = sessionsFor("movie").reverse();
		const expected = {
			items: [
				{
					title: "Main Title",
					mediaType: "movie",
					playCount: 2,
					distinctUserCount: 2,
					totalDurationMinutes: 20,
					lastWatchedAt: "2025-01-15T10:20:00.000Z",
				},
				{
					title: "Tie Title",
					mediaType: "movie",
					playCount: 2,
					distinctUserCount: 1,
					totalDurationMinutes: 10,
					lastWatchedAt: "2025-01-15T10:30:00.000Z",
				},
				{
					title: "Newest Title",
					mediaType: "movie",
					playCount: 1,
					distinctUserCount: 1,
					totalDurationMinutes: 5,
					lastWatchedAt: "2025-01-15T10:31:00.000Z",
				},
			],
			parseFailures: 0,
			totalSnapshots: 7,
			failedPreviews: [],
		};
		expect(aggregateTopMedia(rows, { mediaType: "movie", limit: 10 })).toMatchObject(expected);
		expect(aggregatePopularMedia(rows, { mediaType: "movie", limit: 10 })).toMatchObject(expected);
		expect(aggregateLastWatched(rows, { mediaType: "movie", limit: 10 }).items).toMatchObject([
			expected.items[2],
			expected.items[1],
			expected.items[0],
		]);
	});
});
