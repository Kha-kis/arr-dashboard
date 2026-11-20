import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlexSessionSnapshot } from "../../plugins/lib/session-snapshot-measurements.js";
import { registerAnalyticsRoutes } from "../jellyfin/analytics-routes.js";
import { registerLastWatchedRoutes } from "../plex/last-watched-routes.js";
import { registerPopularMediaRoutes } from "../plex/popular-media-routes.js";
import { registerTopMediaRoutes } from "../plex/top-media-routes.js";
import { registerWatchHistoryRoutes } from "../plex/watch-history-routes.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const OWNER_ID = "top-history-owner";
const HISTORY_RECENT_ROWS = 20_001;
const HISTORY_OLDER_AT = new Date("2026-10-03T12:00:00.000Z");
const HISTORY_RECENT_AT = new Date("2026-10-04T12:00:00.000Z");
const LEADERBOARD_START = new Date("2026-09-17T00:00:00.000Z");

type Service = "PLEX" | "JELLYFIN";
type LeaderboardPath = "top-media" | "popular-media" | "last-watched";
type SnapshotRow = {
	id: string;
	instanceId: string;
	capturedAt: Date;
	sessionsJson: string;
	concurrentStreams: number;
	measurementJson: string | null;
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-05T13:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

function snapshot(
	id: string,
	instanceId: string,
	capturedAt: Date,
	sessions: Array<Record<string, unknown>>,
): SnapshotRow {
	const provider =
		instanceId === "owned-plex" ? "PLEX" : instanceId === "owned-emby" ? "EMBY" : "JELLYFIN";
	const native = buildPlexSessionSnapshot(
		sessions.map((row) => ({
			sessionKey: `playback:${row.user}:${row.title}`,
			ratingKey: `item:${row.title}`,
			title: row.title,
			grandparentTitle: row.grandparentTitle,
			type: row.mediaType === "series" ? "episode" : row.mediaType === "music" ? "track" : "movie",
			user: { id: `actor:${row.user}`, title: row.user },
			player: { platform: row.platform, title: "Synthetic player" },
			videoDecision: row.videoDecision,
			state: "playing",
		})) as never,
		{ connectionGeneration: 0, identityGeneration: 0 },
	);
	// Complete synthetic normalized capture fixtures, not a real provider read.
	const receipt = JSON.parse(native.measurementJson);
	receipt.provider = provider;
	receipt.bandwidthBasis = provider === "PLEX" ? "provider-reported" : "encoding-estimate";
	if (provider !== "PLEX") receipt.deviceLabelAxis = "client";
	const normalized = JSON.parse(native.sessionsJson) as Array<Record<string, unknown>>;
	for (const row of normalized) row.provider = provider;
	return {
		id,
		instanceId,
		capturedAt,
		sessionsJson: JSON.stringify(normalized),
		concurrentStreams: sessions.length,
		measurementJson: JSON.stringify(receipt),
	};
}

function leaderboardRows(service: Service): SnapshotRow[] {
	const primaryInstance = service === "PLEX" ? "owned-plex" : "owned-jellyfin";
	const tailInstance = service === "PLEX" ? primaryInstance : "owned-emby";
	const rows: SnapshotRow[] = [];
	for (let index = 0; index < 19_998; index++) {
		rows.push(
			snapshot(
				`head-${String(index).padStart(5, "0")}`,
				primaryInstance,
				new Date(LEADERBOARD_START.getTime() + index * 60_000),
				[{ user: "main-user", title: "Main Movie", mediaType: "movie" }],
			),
		);
	}
	rows.push(
		snapshot(
			"head-series",
			primaryInstance,
			new Date(LEADERBOARD_START.getTime() + 19_998 * 60_000),
			[
				{
					user: "series-user",
					title: "Pilot",
					grandparentTitle: "Main Series",
					mediaType: "series",
				},
			],
		),
		snapshot(
			"head-music",
			primaryInstance,
			new Date(LEADERBOARD_START.getTime() + 19_999 * 60_000),
			[{ user: "music-user", title: "Main Album", mediaType: "music" }],
		),
		snapshot("tail-movie", tailInstance, new Date("2026-10-02T12:00:00.000Z"), [
			{ user: "tail-movie-user", title: "Tail Movie", mediaType: "movie" },
		]),
		snapshot("tail-series", tailInstance, new Date("2026-10-03T12:00:00.000Z"), [
			{
				user: "tail-series-user",
				title: "Episode",
				grandparentTitle: "Tail Series",
				mediaType: "series",
			},
		]),
		snapshot("tail-music", tailInstance, new Date("2026-10-04T12:00:00.000Z"), [
			{ user: "tail-music-user", title: "Tail Album", mediaType: "music" },
		]),
	);
	rows.push(
		snapshot("excluded-foreign-owner", "foreign-owner", new Date("2026-10-04T23:00:00.000Z"), [
			{ user: "foreign", title: "Excluded Movie", mediaType: "movie" },
		]),
		snapshot("excluded-disabled", "disabled-instance", new Date("2026-10-04T23:01:00.000Z"), [
			{ user: "disabled", title: "Excluded Movie", mediaType: "movie" },
		]),
		snapshot("excluded-wrong-service", "wrong-service", new Date("2026-10-04T23:02:00.000Z"), [
			{ user: "wrong-service", title: "Excluded Movie", mediaType: "movie" },
		]),
		snapshot("excluded-cutoff", primaryInstance, new Date("2026-08-01T00:00:00.000Z"), [
			{ user: "old", title: "Excluded Movie", mediaType: "movie" },
		]),
	);
	return rows;
}

function historyRows(service: Service): SnapshotRow[] {
	const primaryInstance = service === "PLEX" ? "owned-plex" : "owned-jellyfin";
	const rows = Array.from({ length: HISTORY_RECENT_ROWS }, (_, index) =>
		snapshot(`recent-${String(index).padStart(5, "0")}`, primaryInstance, HISTORY_RECENT_AT, [
			{
				user: "alice",
				title: "Recent Movie",
				platform: "Web",
				videoDecision: "direct play",
			},
		]),
	);
	rows.push(
		snapshot("older-distinct-event", primaryInstance, HISTORY_OLDER_AT, [
			{ user: "bob", title: "Earlier Movie", platform: "Roku", videoDecision: "transcode" },
		]),
	);
	return rows;
}

function smallRows(service: Service, path: LeaderboardPath | "history"): SnapshotRow[] {
	const instanceId = service === "PLEX" ? "owned-plex" : "owned-jellyfin";
	if (path === "history") {
		return [
			...Array.from({ length: 500 }, (_, index) =>
				snapshot(`recent-${String(index).padStart(4, "0")}`, instanceId, HISTORY_RECENT_AT, [
					{ user: "alice", title: "Recent Movie", platform: "Web", videoDecision: "direct play" },
				]),
			),
			snapshot("older", instanceId, HISTORY_OLDER_AT, [
				{ user: "bob", title: "Earlier Movie", platform: "Roku", videoDecision: "transcode" },
			]),
		];
	}
	return [
		...Array.from({ length: 500 }, (_, index) =>
			snapshot(`head-${String(index).padStart(4, "0")}`, instanceId, HISTORY_RECENT_AT, [
				{ user: "alice", title: "Main Movie", mediaType: "movie" },
			]),
		),
		snapshot("tail", instanceId, new Date("2026-10-04T13:00:00.000Z"), [
			{ user: "bob", title: "Tail Movie", mediaType: "movie" },
		]),
	];
}

function queryRespectingPrisma(
	service: Service,
	path: LeaderboardPath | "history",
	options: { rows?: SnapshotRow[]; emptyScope?: boolean; failOnPage?: number } = {},
) {
	const instances = [
		{
			id: service === "PLEX" ? "owned-plex" : "owned-jellyfin",
			userId: OWNER_ID,
			service,
			enabled: true,
		},
		...(service === "JELLYFIN"
			? [{ id: "owned-emby", userId: OWNER_ID, service: "EMBY" as const, enabled: true }]
			: []),
		{ id: "foreign-owner", userId: "someone-else", service, enabled: true },
		{ id: "disabled-instance", userId: OWNER_ID, service, enabled: false },
		{ id: "wrong-service", userId: OWNER_ID, service: "SONARR", enabled: true },
	];
	const rows =
		options.rows ?? (path === "history" ? historyRows(service) : leaderboardRows(service));
	let pageCount = 0;
	let failOnPage = options.failOnPage;
	let orderedRows: SnapshotRow[] | undefined;
	const serviceInstance = {
		findMany: vi.fn(async (args: Record<string, unknown>) => {
			const where = args.where as {
				userId: string;
				service: string | { in: string[] };
				enabled: boolean;
			};
			return (options.emptyScope ? [] : instances)
				.filter(
					(instance) =>
						instance.userId === where.userId &&
						instance.enabled === where.enabled &&
						(typeof where.service === "string"
							? instance.service === where.service
							: where.service.in.includes(instance.service)),
				)
				.map(({ id }) => ({ id }));
		}),
	};
	const sessionSnapshot = {
		findMany: vi.fn(async (args: Record<string, unknown>) => {
			pageCount++;
			if (failOnPage === pageCount) throw new Error("synthetic snapshot page failure");
			const where = args.where as {
				instanceId: { in: string[] };
				capturedAt: { gte: Date };
				OR?: Array<{
					capturedAt?: { lt?: Date; gt?: Date } | Date;
					id?: { lt?: string; gt?: string };
				}>;
			};
			if (!orderedRows) {
				orderedRows = rows.filter(
					(row) =>
						where.instanceId.in.includes(row.instanceId) && row.capturedAt >= where.capturedAt.gte,
				);
			}
			const requestedOrder = args.orderBy;
			const orders = Array.isArray(requestedOrder)
				? requestedOrder
				: requestedOrder
					? [requestedOrder]
					: [{ capturedAt: "asc" }];
			const capturedDirection = (orders[0] as { capturedAt?: "asc" | "desc" }).capturedAt ?? "asc";
			const idDirection =
				(orders[1] as { id?: "asc" | "desc" } | undefined)?.id ?? capturedDirection;
			orderedRows.sort((left, right) => {
				const timeDifference = left.capturedAt.getTime() - right.capturedAt.getTime();
				if (timeDifference !== 0)
					return capturedDirection === "asc" ? timeDifference : -timeDifference;
				const idDifference = left.id.localeCompare(right.id);
				return idDirection === "asc" ? idDifference : -idDifference;
			});
			const cursorAt = where.OR?.[0]?.capturedAt;
			const cursorTime = cursorAt instanceof Date ? cursorAt : (cursorAt?.lt ?? cursorAt?.gt);
			const cursorId = where.OR?.[1]?.id;
			const afterCursor = where.OR
				? orderedRows.filter((row) => {
						if (!cursorTime) return true;
						const timeDifference = row.capturedAt.getTime() - cursorTime.getTime();
						if (timeDifference !== 0) {
							return cursorAt && "lt" in cursorAt ? timeDifference < 0 : timeDifference > 0;
						}
						const idDifference = row.id.localeCompare(cursorId?.lt ?? cursorId?.gt ?? "");
						return cursorId && "lt" in cursorId ? idDifference < 0 : idDifference > 0;
					})
				: orderedRows;
			const page = afterCursor.slice(0, Number(args.take));
			const select = args.select as Record<string, boolean>;
			return page.map((row) =>
				Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof SnapshotRow]])),
			);
		}),
	};
	const prisma = {
		serviceInstance,
		sessionSnapshot,
		$transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
			work({ serviceInstance, sessionSnapshot }),
		),
	};
	return {
		prisma,
		serviceInstance,
		sessionSnapshot,
		setFailOnPage(page: number | undefined) {
			failOnPage = page;
			pageCount = 0;
		},
	};
}

async function withRoute<T>(
	service: Service,
	path: LeaderboardPath | "history",
	run: (
		inject: ReturnType<typeof createInjectAuthenticated>,
		state: ReturnType<typeof queryRespectingPrisma>,
		url: string,
	) => Promise<T>,
	options: { rows?: SnapshotRow[]; emptyScope?: boolean; failOnPage?: number } = {},
) {
	const app = Fastify({ logger: false });
	const state = queryRespectingPrisma(service, path, options);
	app.decorate("prisma", state.prisma as never);
	setupAuthInjection(app, { id: OWNER_ID, username: OWNER_ID });
	if (service === "JELLYFIN") {
		await app.register(registerAnalyticsRoutes, { prefix: "/analytics" });
	} else if (path === "history") {
		await app.register(registerWatchHistoryRoutes, { prefix: "/analytics/history" });
	} else {
		const plugin =
			path === "top-media"
				? registerTopMediaRoutes
				: path === "popular-media"
					? registerPopularMediaRoutes
					: registerLastWatchedRoutes;
		await app.register(plugin, { prefix: `/analytics/${path}` });
	}
	await app.ready();
	try {
		const prefix = service === "PLEX" ? `/analytics/${path}/` : `/analytics/${path}`;
		const url =
			path === "history"
				? `${prefix}?days=30&limit=10`
				: `${prefix}?days=30&limit=10&mediaType=movie`;
		return await run(createInjectAuthenticated(app), state, url);
	} finally {
		await app.close();
	}
}

function expectedItems(path: LeaderboardPath, mediaType: "movie" | "series" | "music") {
	const main =
		mediaType === "movie"
			? {
					title: "Main Movie",
					mediaType,
					playCount: 1,
					distinctUserCount: 1,
					totalDurationMinutes: 99_990,
					lastWatchedAt: "2026-09-30T21:17:00.000Z",
				}
			: mediaType === "series"
				? {
						title: "Main Series",
						mediaType,
						playCount: 1,
						distinctUserCount: 1,
						totalDurationMinutes: 5,
						lastWatchedAt: "2026-09-30T21:18:00.000Z",
					}
				: {
						title: "Main Album",
						mediaType,
						playCount: 1,
						distinctUserCount: 1,
						totalDurationMinutes: 5,
						lastWatchedAt: "2026-09-30T21:19:00.000Z",
					};
	const tail = {
		title:
			mediaType === "movie" ? "Tail Movie" : mediaType === "series" ? "Tail Series" : "Tail Album",
		mediaType,
		playCount: 1,
		distinctUserCount: 1,
		totalDurationMinutes: 5,
		lastWatchedAt:
			mediaType === "movie"
				? "2026-10-02T12:00:00.000Z"
				: mediaType === "series"
					? "2026-10-03T12:00:00.000Z"
					: "2026-10-04T12:00:00.000Z",
	};
	const identified = { unattributedSessions: 0, unidentifiedPlaybackSessions: 0 };
	if (path === "top-media" && mediaType === "movie")
		return [
			{ ...main, ...identified },
			{ ...tail, ...identified },
		];
	if (path === "top-media" || path === "popular-media" || path === "last-watched") {
		return [
			{ ...tail, ...identified },
			{ ...main, ...identified },
		];
	}
	return [];
}

const leaderboardHandlers = [
	{ name: "Plex top-media", service: "PLEX" as const, path: "top-media" as const },
	{ name: "Jellyfin/Emby top-media", service: "JELLYFIN" as const, path: "top-media" as const },
	{ name: "Plex popular-media", service: "PLEX" as const, path: "popular-media" as const },
	{
		name: "Jellyfin/Emby popular-media",
		service: "JELLYFIN" as const,
		path: "popular-media" as const,
	},
	{ name: "Plex last-watched", service: "PLEX" as const, path: "last-watched" as const },
	{
		name: "Jellyfin/Emby last-watched",
		service: "JELLYFIN" as const,
		path: "last-watched" as const,
	},
];

const allHandlers = [
	...leaderboardHandlers,
	{ name: "Plex history", service: "PLEX" as const, path: "history" as const },
	{ name: "Jellyfin/Emby history", service: "JELLYFIN" as const, path: "history" as const },
];

function expectedSmallResponse(path: LeaderboardPath | "history") {
	if (path === "history") {
		return {
			events: [
				{
					user: "alice",
					title: "Recent Movie",
					timestamp: "2026-10-04T12:00:00.000Z",
					platform: "Web",
					videoDecision: "direct play",
				},
				{
					user: "bob",
					title: "Earlier Movie",
					timestamp: "2026-10-03T12:00:00.000Z",
					platform: "Roku",
					videoDecision: "transcode",
				},
			],
		};
	}
	const main = {
		title: "Main Movie",
		mediaType: "movie",
		playCount: 1,
		distinctUserCount: 1,
		totalDurationMinutes: 2_500,
		lastWatchedAt: "2026-10-04T12:00:00.000Z",
	};
	const tail = {
		title: "Tail Movie",
		mediaType: "movie",
		playCount: 1,
		distinctUserCount: 1,
		totalDurationMinutes: 5,
		lastWatchedAt: "2026-10-04T13:00:00.000Z",
	};
	return { items: path === "top-media" ? [main, tail] : [tail, main] };
}

function collection(activeSnapshots: number, configuredSources: number) {
	return {
		version: 1,
		configuredSources,
		collection: {
			activeSnapshots,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
	};
}

describe("historical media and watch history full-window coverage", () => {
	it.each(leaderboardHandlers)(
		"includes complete $name results across all media types",
		async (handler) => {
			for (const mediaType of ["movie", "series", "music"] as const) {
				await withRoute(handler.service, handler.path, async (inject, state, baseUrl) => {
					const response = await inject(
						"GET",
						baseUrl.replace("mediaType=movie", `mediaType=${mediaType}`),
					);
					expect(response.statusCode).toBe(200);
					expect(response.json()).toMatchObject({ items: expectedItems(handler.path, mediaType) });
					expect(response.json().measurement).toEqual(
						collection(20_003, handler.service === "PLEX" ? 1 : 2),
					);
					expect(state.serviceInstance.findMany).toHaveBeenCalledWith({
						where: {
							userId: OWNER_ID,
							service: { in: handler.service === "PLEX" ? ["PLEX"] : ["JELLYFIN", "EMBY"] },
							enabled: true,
						},
						select: { id: true },
					});
				});
			}
		},
	);

	it.each([
		{ name: "Plex history", service: "PLEX" as const },
		{ name: "Jellyfin/Emby history", service: "JELLYFIN" as const },
	])("includes an older distinct $name event beyond the raw-row cap", async ({ service }) => {
		await withRoute(service, "history", async (inject, _state, url) => {
			const response = await inject("GET", url);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				events: [
					{
						user: "alice",
						title: "Recent Movie",
						timestamp: "2026-10-04T12:00:00.000Z",
						platform: "Web",
						videoDecision: "direct play",
					},
					{
						user: "bob",
						title: "Earlier Movie",
						timestamp: "2026-10-03T12:00:00.000Z",
						platform: "Roku",
						videoDecision: "transcode",
					},
				],
			});
			expect(response.json().measurement).toEqual(collection(20_002, service === "PLEX" ? 1 : 2));
			expect(
				response.json().events.every((event: { key: string }) => /^[a-f0-9]{64}$/.test(event.key)),
			).toBe(true);
		});
	});

	it.each(allHandlers)(
		"fails closed on a later $name page and recovers exactly",
		async (handler) => {
			await withRoute(
				handler.service,
				handler.path,
				async (inject, state, url) => {
					const failed = await inject("GET", url);
					expect(failed.statusCode).toBe(500);
					expect(failed.json()).not.toHaveProperty("items");
					expect(failed.json()).not.toHaveProperty("events");
					expect(state.sessionSnapshot.findMany).toHaveBeenCalledTimes(2);

					state.setFailOnPage(undefined);
					const recovered = await inject("GET", url);
					expect(recovered.statusCode).toBe(200);
					expect(recovered.json()).toMatchObject(expectedSmallResponse(handler.path));
					expect(recovered.json().measurement).toEqual(
						collection(501, handler.service === "PLEX" ? 1 : 2),
					);
				},
				{ rows: smallRows(handler.service, handler.path), failOnPage: 2 },
			);
		},
	);

	it.each(allHandlers)(
		"returns the exact empty shape for an unowned $name scope without snapshot reads",
		async (handler) => {
			await withRoute(
				handler.service,
				handler.path,
				async (inject, state, url) => {
					const response = await inject("GET", url);
					expect(response.statusCode).toBe(200);
					expect(response.json()).toMatchObject(
						handler.path === "history" ? { events: [] } : { items: [] },
					);
					expect(response.json().measurement).toEqual(collection(0, 0));
					expect(state.sessionSnapshot.findMany).not.toHaveBeenCalled();
				},
				{ emptyScope: true },
			);
		},
	);

	it.each(allHandlers)(
		"returns the exact empty shape for an enabled-but-empty $name scope",
		async (handler) => {
			await withRoute(
				handler.service,
				handler.path,
				async (inject, state, url) => {
					const response = await inject("GET", url);
					expect(response.statusCode).toBe(200);
					expect(response.json()).toMatchObject(
						handler.path === "history" ? { events: [] } : { items: [] },
					);
					expect(response.json().measurement).toEqual(
						collection(0, handler.service === "PLEX" ? 1 : 2),
					);
					expect(state.sessionSnapshot.findMany).toHaveBeenCalledTimes(1);
				},
				{ rows: [] },
			);
		},
	);
});
