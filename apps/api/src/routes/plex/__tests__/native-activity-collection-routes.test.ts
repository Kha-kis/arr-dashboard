import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
} from "../../../plugins/lib/session-snapshot-measurements.js";
import { registerAnalyticsRoutes as registerJellyfinAnalyticsRoutes } from "../../jellyfin/analytics-routes.js";
import { registerLastWatchedRoutes } from "../last-watched-routes.js";
import { registerPlaysByDateRoutes } from "../plays-by-date-routes.js";
import { registerPopularMediaRoutes } from "../popular-media-routes.js";
import { registerTopMediaRoutes } from "../top-media-routes.js";
import { registerWatchHistoryRoutes } from "../watch-history-routes.js";

const date = new Date("2026-10-05T12:00:00Z");
const paths = ["history", "top-media", "popular-media", "last-watched", "plays-by-date"];
const apps: FastifyInstance[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	vi.useRealTimers();
	await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appFor(
	provider: "PLEX" | "JELLYFIN",
	rows: Record<string, unknown>[],
	configured = true,
) {
	const app = Fastify({ logger: false });
	apps.push(app);
	app.decorateRequest("currentUser", null);
	app.addHook("preHandler", async (request) => {
		request.currentUser = { id: "synthetic-owner" } as typeof request.currentUser;
	});
	app.decorate("prisma", {
		$transaction: async (callback: (tx: unknown) => unknown) =>
			callback({
				serviceInstance: { findMany: async () => (configured ? [{ id: "source" }] : []) },
				sessionSnapshot: { findMany: async () => rows },
			}),
	} as never);
	if (provider === "JELLYFIN")
		await app.register(registerJellyfinAnalyticsRoutes, { prefix: "/analytics" });
	else {
		await app.register(registerWatchHistoryRoutes, { prefix: "/analytics/history" });
		await app.register(registerTopMediaRoutes, { prefix: "/analytics/top-media" });
		await app.register(registerPopularMediaRoutes, { prefix: "/analytics/popular-media" });
		await app.register(registerLastWatchedRoutes, { prefix: "/analytics/last-watched" });
		await app.register(registerPlaysByDateRoutes, { prefix: "/analytics/plays-by-date" });
	}
	return app;
}

describe.each(["PLEX", "JELLYFIN"] as const)("%s activity collection coverage", (provider) => {
	it.each([
		{ detail: "empty", movies: null, other: null, invalid: 1, unidentified: 0 },
		{ detail: "missing-fields", movies: null, other: null, invalid: 1, unidentified: 0 },
		{ detail: "missing-category", movies: null, other: null, invalid: 1, unidentified: 0 },
		{ detail: "invalid-category", movies: null, other: null, invalid: 1, unidentified: 0 },
		{ detail: "blank-title", movies: 1, other: 0, invalid: 0, unidentified: 0 },
		{ detail: "known-other", movies: 0, other: 0, invalid: 0, unidentified: 0 },
		{ detail: "known-plus-unknown", movies: 1, other: null, invalid: 1, unidentified: 0 },
		{ detail: "missing-native-id", movies: null, other: null, invalid: 0, unidentified: 1 },
	])(
		"does not manufacture daily absence or discard independent playback evidence for $detail",
		async ({ detail, movies, other, invalid, unidentified }) => {
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(date);
			const scope = { connectionGeneration: 0, identityGeneration: 0 };
			const count = detail === "known-plus-unknown" ? 2 : 1;
			const active =
				provider === "PLEX"
					? buildPlexSessionSnapshot(
							Array.from({ length: count }, () => ({
								sessionKey: "playback",
								ratingKey: "item",
								title: "Synthetic title",
								type: "movie",
								user: { id: "actor", title: "Synthetic viewer" },
								player: { title: "Synthetic player" },
								state: "playing",
							})) as never,
							scope,
						)
					: buildJellyfinSessionSnapshot(
							Array.from({ length: count }, () => ({
								id: "playback",
								userId: "actor",
								userName: "Synthetic viewer",
								nowPlayingItem: { id: "item", name: "Synthetic title", type: "Movie" },
								client: "Synthetic client",
								deviceName: "Synthetic device",
								isPaused: false,
							})) as never,
							provider,
							scope,
						);
			const nativeRows = JSON.parse(active.sessionsJson) as Array<Record<string, unknown>>;
			const row = nativeRows[0]!;
			let details: Array<Record<string, unknown>> = nativeRows;
			if (detail === "empty") details = [];
			else if (detail === "missing-fields") details = [{}];
			else if (detail === "missing-category") delete row.mediaType;
			else if (detail === "invalid-category") row.mediaType = "uncategorized";
			else if (detail === "blank-title") row.title = "";
			else if (detail === "known-other") row.mediaType = "other";
			else if (detail === "known-plus-unknown") details[1] = {};
			else if (detail === "missing-native-id") {
				row.itemId = null;
				row.title = "";
			}
			const app = await appFor(provider, [
				{
					id: "incomplete-detail",
					instanceId: "source",
					capturedAt: date,
					...active,
					sessionsJson: JSON.stringify(details),
				},
			]);
			const response = await app.inject("/analytics/plays-by-date?days=1");
			expect(response.statusCode).toBe(200);
			const result = response.json();
			expect(result.series).toEqual([
				{ name: "Movies", data: [movies] },
				{ name: "TV", data: [other] },
				{ name: "Music", data: [other] },
			]);
			expect(result.invalidDetailSnapshots).toEqual([invalid]);
			expect(result.unidentifiedPlaybackSessions).toEqual([unidentified]);
			expect(result.measurement.collection.activeSnapshots).toBe(1);
		},
	);
	it("does not publish malformed active detail as a zero-play day", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(date);
		const active = buildPlexSessionSnapshot(
			[
				{
					sessionKey: "playback",
					ratingKey: "item",
					title: "Synthetic title",
					type: "movie",
					user: { id: "actor", title: "Synthetic viewer" },
					player: { title: "Synthetic player" },
					state: "playing",
				} as never,
			],
			{ connectionGeneration: 0, identityGeneration: 0 },
		);
		const app = await appFor(provider, [
			{
				id: "malformed",
				instanceId: "source",
				capturedAt: date,
				...active,
				sessionsJson: "not-json",
			},
		]);
		const response = await app.inject("/analytics/plays-by-date?days=1");
		expect(response.statusCode).toBe(200);
		expect(response.json().series[0].data).toEqual([null]);
		expect(response.json().invalidDetailSnapshots).toEqual([1]);
	});
	it.each(paths)(
		"preserves failed collection evidence in %s instead of an ordinary empty success",
		async (path) => {
			vi.spyOn(Date, "now").mockReturnValue(date.getTime());
			const failed = {
				id: "failed",
				instanceId: "source",
				capturedAt: date,
				...buildFailedSessionSnapshot(provider),
			};
			const app = await appFor(provider, [failed]);
			const response = await app.inject(`/analytics/${path}?days=1&mediaType=movie`);
			expect(response.statusCode).toBe(200);
			expect(response.json().measurement).toMatchObject({
				version: 1,
				configuredSources: 1,
				collection: {
					activeSnapshots: 0,
					idleSnapshots: 0,
					failedSnapshots: 1,
					legacySnapshots: 0,
					invalidSnapshots: 0,
				},
			});
			if (path === "plays-by-date") {
				expect(response.json().series[0].data).toEqual([null]);
				expect(response.json().measurement.collectionByDate["2026-10-05"].failedSnapshots).toBe(1);
			}
		},
	);
	it.each(paths)("distinguishes no configured source from no observations for %s", async (path) => {
		const app = await appFor(provider, [], false);
		const response = await app.inject(`/analytics/${path}?days=1&mediaType=movie`);
		expect(response.statusCode).toBe(200);
		expect(response.json().measurement).toMatchObject({
			configuredSources: 0,
			collection: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		});
	});
	it("distinguishes an observed idle day from an unsampled calendar gap", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(date);
		const idle = {
			id: "idle",
			instanceId: "source",
			capturedAt: date,
			...(provider === "PLEX"
				? buildPlexSessionSnapshot([])
				: buildJellyfinSessionSnapshot([], provider)),
		};
		const app = await appFor(provider, [idle]);
		const response = await app.inject("/analytics/plays-by-date?days=2");
		expect(response.statusCode).toBe(200);
		expect(response.json().categories).toEqual(["2026-10-04", "2026-10-05"]);
		expect(response.json().series[0].data).toEqual([null, 0]);
		expect(response.json().measurement.collection.idleSnapshots).toBe(1);
	});
});

it("the History read route retains legacy titles without certifying method/device defaults", async () => {
	vi.spyOn(Date, "now").mockReturnValue(date.getTime());
	const app = await appFor("PLEX", [
		{
			id: "legacy",
			instanceId: "source",
			capturedAt: date,
			concurrentStreams: 1,
			measurementJson: null,
			sessionsJson: JSON.stringify([
				{
					user: "Synthetic viewer",
					title: "Synthetic legacy title",
					platform: "Synthetic fallback",
					videoDecision: "direct play",
				},
			]),
		},
	]);
	const response = await app.inject("/analytics/history?days=1");
	expect(response.statusCode).toBe(200);
	expect(response.json().events[0]).toMatchObject({
		title: "Synthetic legacy title",
		platform: null,
		videoDecision: null,
	});
});
