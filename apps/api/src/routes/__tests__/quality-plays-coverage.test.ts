import type { PlaysByDateResponse } from "@arr/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAnalyticsRoutes } from "../jellyfin/analytics-routes.js";
import { registerPlaysByDateRoutes } from "../plex/plays-by-date-routes.js";
import { registerQualityScoreRoutes } from "../plex/quality-score-routes.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const OWNER_ID = "quality-plays-owner";
const SNAPSHOT_COUNT = 20_001;
const HEAD_AT = new Date("2026-10-03T14:00:00.000Z");
const TAIL_AT = new Date("2026-10-04T14:00:00.000Z");

type Service = "PLEX" | "JELLYFIN" | "EMBY";
type AnalyticsPath = "quality-score" | "plays-by-date";
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

function makeSnapshot(
	id: string,
	instanceId: string,
	capturedAt: Date,
	session: Record<string, unknown>,
): SnapshotRow {
	const native = "videoDecision" in session || "mediaType" in session;
	const provider =
		instanceId === "owned-plex" ? "PLEX" : instanceId === "owned-emby" ? "EMBY" : "JELLYFIN";
	return {
		id,
		instanceId,
		capturedAt,
		sessionsJson: JSON.stringify([
			{
				...(native
					? {
							userId: `actor:${session.user}`,
							itemId: `item:${session.title}`,
							sessionId: `playback:${session.user}:${session.title}`,
						}
					: {}),
				...session,
			},
		]),
		concurrentStreams: 1,
		measurementJson: native
			? JSON.stringify({
					userIdentity: "provider-native",
					version: 1,
					provider,
					sourceScope: { connectionGeneration: 0, identityGeneration: 0 },
					status: "active",
					bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
					observedSessions: 1,
					bandwidth: {
						status: "unavailable",
						observedSessions: 1,
						measuredSessions: 0,
						knownTotalKbps: null,
					},
					methods: {
						directPlayCount: 0,
						directStreamCount: 0,
						transcodeCount: 0,
						unknownDecisionCount: 1,
					},
					network: { status: "unavailable", lanKbps: null, wanKbps: null },
				})
			: null,
	};
}

function makeSnapshots(service: Service, path: AnalyticsPath): SnapshotRow[] {
	const primaryId = service === "PLEX" ? "owned-plex" : "owned-jellyfin";
	const tailInstanceId = service === "JELLYFIN" ? "owned-emby" : primaryId;
	const headSession =
		path === "quality-score"
			? { user: "alice", videoDecision: "direct play", videoResolution: "1080" }
			: { user: "alice", title: "Head Film", mediaType: "movie" };
	const tailSession =
		path === "quality-score"
			? { user: "bob", videoDecision: "transcode", videoResolution: "480" }
			: {
					user: "tail-user",
					title: "Tail Episode",
					grandparentTitle: "Tail Series",
					mediaType: "series",
				};
	const rows = Array.from({ length: SNAPSHOT_COUNT - 1 }, (_, index) =>
		makeSnapshot(`snapshot-${String(index).padStart(5, "0")}`, primaryId, HEAD_AT, headSession),
	);
	rows.push(makeSnapshot("snapshot-20000-tail", tailInstanceId, TAIL_AT, tailSession));
	rows.push(
		makeSnapshot("foreign-owner-high", "foreign-owner", TAIL_AT, {
			user: "foreign",
			videoDecision: "transcode",
			videoResolution: "480",
			title: "Foreign Film",
			mediaType: "movie",
		}),
		makeSnapshot("disabled-instance-high", "disabled-instance", TAIL_AT, {
			user: "disabled",
			videoDecision: "transcode",
			videoResolution: "480",
			title: "Disabled Film",
			mediaType: "movie",
		}),
		makeSnapshot("wrong-service-high", "wrong-service", TAIL_AT, {
			user: "wrong-service",
			videoDecision: "transcode",
			videoResolution: "480",
			title: "Wrong Service Film",
			mediaType: "movie",
		}),
		makeSnapshot("before-cutoff", primaryId, new Date("2026-09-01T14:00:00.000Z"), {
			user: "old",
			videoDecision: "transcode",
			videoResolution: "480",
			title: "Old Film",
			mediaType: "movie",
		}),
	);
	return rows;
}

function queryRespectingPrisma(
	service: Service,
	path: AnalyticsPath,
	options: {
		emptyScope?: boolean;
		emptySnapshots?: boolean;
		failOnPage?: number;
		snapshotRows?: SnapshotRow[];
	} = {},
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
		{ id: "foreign-owner", userId: "other-owner", service, enabled: true },
		{ id: "disabled-instance", userId: OWNER_ID, service, enabled: false },
		{ id: "wrong-service", userId: OWNER_ID, service: "SONARR", enabled: true },
	];
	const rows = options.emptySnapshots ? [] : (options.snapshotRows ?? makeSnapshots(service, path));
	let orderedRows: SnapshotRow[] | undefined;
	let pageCount = 0;
	let failOnPage: number | undefined = options.failOnPage;
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
			pageCount += 1;
			if (failOnPage === pageCount) throw new Error("synthetic snapshot page failure");
			const where = args.where as {
				instanceId: { in: string[] };
				capturedAt: { gte: Date };
				OR?: Array<{ capturedAt?: Date | { gt?: Date }; id?: { gt?: string } }>;
			};
			if (!orderedRows) {
				orderedRows = rows
					.filter(
						(row) =>
							where.instanceId.in.includes(row.instanceId) &&
							row.capturedAt >= where.capturedAt.gte,
					)
					.sort(
						(left, right) =>
							left.capturedAt.getTime() - right.capturedAt.getTime() ||
							left.id.localeCompare(right.id),
					);
			}
			const cursorAfterAt = where.OR?.[0]?.capturedAt;
			const afterAt =
				cursorAfterAt && !(cursorAfterAt instanceof Date) ? cursorAfterAt.gt : undefined;
			const cursorEqualAt = where.OR?.[1]?.capturedAt;
			const equalAt = cursorEqualAt instanceof Date ? cursorEqualAt : undefined;
			const firstAfterCursor = where.OR
				? orderedRows.findIndex(
						(row) =>
							row.capturedAt > (afterAt ?? new Date(0)) ||
							(row.capturedAt.getTime() === equalAt?.getTime() &&
								row.id > (where.OR?.[1]?.id?.gt ?? "")),
					)
				: 0;
			const start = firstAfterCursor < 0 ? orderedRows.length : firstAfterCursor;
			const page = orderedRows.slice(start, start + Number(args.take));
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
		sessionSnapshot,
		serviceInstance,
		setFailOnPage(page: number | undefined) {
			failOnPage = page;
			pageCount = 0;
		},
	};
}

async function withAnalyticsRequest<T>(
	service: Service,
	path: AnalyticsPath,
	options: {
		emptyScope?: boolean;
		emptySnapshots?: boolean;
		failOnPage?: number;
		snapshotRows?: SnapshotRow[];
	} = {},
	run: (
		inject: ReturnType<typeof createInjectAuthenticated>,
		state: ReturnType<typeof queryRespectingPrisma>,
		url: string,
	) => Promise<T>,
) {
	const app = Fastify({ logger: false });
	const state = queryRespectingPrisma(service, path, options);
	app.decorate("prisma", state.prisma as never);
	setupAuthInjection(app, { id: OWNER_ID, username: OWNER_ID });
	if (service === "PLEX") {
		const route = path === "quality-score" ? registerQualityScoreRoutes : registerPlaysByDateRoutes;
		await app.register(route, { prefix: `/analytics/${path}` });
	} else {
		await app.register(registerAnalyticsRoutes, { prefix: "/analytics" });
	}
	await app.ready();
	try {
		const url = service === "PLEX" ? `/analytics/${path}/?days=30` : `/analytics/${path}?days=30`;
		return await run(createInjectAuthenticated(app), state, url);
	} finally {
		await app.close();
	}
}

const handlers = [
	{ name: "Plex quality score", service: "PLEX" as const, path: "quality-score" as const },
	{
		name: "Jellyfin/Emby quality score",
		service: "JELLYFIN" as const,
		path: "quality-score" as const,
	},
	{ name: "Plex plays by date", service: "PLEX" as const, path: "plays-by-date" as const },
	{
		name: "Jellyfin/Emby plays by date",
		service: "JELLYFIN" as const,
		path: "plays-by-date" as const,
	},
];

function qualityMeasurement(observed: number, configuredSources?: number) {
	return {
		version: 1,
		methodAxis: "video",
		status: observed > 0 ? "complete" : "unavailable",
		observedSessions: observed,
		methodMeasuredSessions: observed,
		resolutionMeasuredSessions: observed,
		scoredSessions: observed,
		invalidDetailSnapshots: 0,
		unattributedSessions: 0,
		collection: {
			activeSnapshots: observed,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
		...(configuredSources === undefined ? {} : { configuredSources }),
	};
}
function fullQualityResponse(service: Service) {
	return {
		// Raw joint-cohort score is 92.4957502; round once, not its displayed components.
		overallScore: 92,
		breakdown: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
		components: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
		measurement: qualityMeasurement(20_001, service === "JELLYFIN" ? 2 : 1),
		trend: [
			{
				date: "2026-10-03",
				score: 93,
				components: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
				measurement: qualityMeasurement(20_000),
			},
			{
				date: "2026-10-04",
				score: 8,
				components: { directPlayScore: 0, resolutionScore: 25, transcodeScore: 0 },
				measurement: qualityMeasurement(1),
			},
		],
		perUser: [
			{
				key: expect.stringMatching(/^[a-f0-9]{64}$/),
				username: "alice",
				score: 93,
				sessions: 20_000,
				components: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
				coverage: {
					observedSessions: 20_000,
					methodMeasuredSessions: 20_000,
					resolutionMeasuredSessions: 20_000,
					scoredSessions: 20_000,
				},
			},
			{
				key: expect.stringMatching(/^[a-f0-9]{64}$/),
				username: "bob",
				score: 8,
				sessions: 1,
				components: { directPlayScore: 0, resolutionScore: 25, transcodeScore: 0 },
				coverage: {
					observedSessions: 1,
					methodMeasuredSessions: 1,
					resolutionMeasuredSessions: 1,
					scoredSessions: 1,
				},
			},
		],
	};
}
function emptyQualityResponse(configuredSources: number) {
	return {
		overallScore: null,
		breakdown: { directPlayScore: null, resolutionScore: null, transcodeScore: null },
		components: { directPlayScore: null, resolutionScore: null, transcodeScore: null },
		measurement: qualityMeasurement(0, configuredSources),
		trend: [],
		perUser: [],
	};
}

const fullPlaysResponse = {
	categories: [
		"2026-09-06",
		"2026-09-07",
		"2026-09-08",
		"2026-09-09",
		"2026-09-10",
		"2026-09-11",
		"2026-09-12",
		"2026-09-13",
		"2026-09-14",
		"2026-09-15",
		"2026-09-16",
		"2026-09-17",
		"2026-09-18",
		"2026-09-19",
		"2026-09-20",
		"2026-09-21",
		"2026-09-22",
		"2026-09-23",
		"2026-09-24",
		"2026-09-25",
		"2026-09-26",
		"2026-09-27",
		"2026-09-28",
		"2026-09-29",
		"2026-09-30",
		"2026-10-01",
		"2026-10-02",
		"2026-10-03",
		"2026-10-04",
		"2026-10-05",
	],
	series: [
		{ name: "Movies", data: [...new Array(27).fill(null), 1, 0, null] },
		{ name: "TV", data: [...new Array(27).fill(null), 0, 1, null] },
		{ name: "Music", data: [...new Array(27).fill(null), 0, 0, null] },
	],
};

function assertPlaysCollection(
	body: PlaysByDateResponse,
	configuredSources: number,
	activeSnapshots: number,
) {
	expect(body.measurement).toMatchObject({
		version: 1,
		configuredSources,
		collection: {
			activeSnapshots,
			idleSnapshots: 0,
			failedSnapshots: 0,
			legacySnapshots: 0,
			invalidSnapshots: 0,
		},
	});
	expect(body.invalidDetailSnapshots).toEqual(new Array(30).fill(0));
	expect(body.unidentifiedPlaybackSessions).toEqual(new Array(30).fill(0));
	if (activeSnapshots > 0) {
		expect(body.measurement?.collectionByDate).toEqual({
			"2026-10-03": {
				activeSnapshots: 20_000,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
			"2026-10-04": {
				activeSnapshots: 1,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		});
	}
}

describe("quality and plays analytics full-window coverage", () => {
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"retains native %s quality subsets and collection failures without SD or false inverse-transcode defaults",
		async (service) => {
			const instanceId = service === "PLEX" ? "owned-plex" : "owned-jellyfin";
			function native(id: string, entries: Array<Record<string, unknown>>): SnapshotRow {
				const row = makeSnapshot(id, instanceId, TAIL_AT, { videoDecision: "unknown" });
				const receipt = JSON.parse(row.measurementJson!);
				receipt.provider = service;
				receipt.bandwidthBasis = service === "PLEX" ? "provider-reported" : "encoding-estimate";
				receipt.observedSessions = entries.length;
				receipt.bandwidth.observedSessions = entries.length;
				receipt.methods.unknownDecisionCount = entries.length;
				return {
					...row,
					concurrentStreams: entries.length,
					measurementJson: JSON.stringify(receipt),
					sessionsJson: JSON.stringify(entries),
				};
			}
			const usable = native("a-usable", [
				{
					user: "Synthetic A",
					userId: "actor-a",
					videoDecision: "direct play",
					videoResolution: "1920x1080",
				},
				{
					user: "Synthetic A",
					userId: "actor-a",
					videoDecision: "unknown",
					videoResolution: "720p",
				},
				{
					user: "Synthetic A",
					userId: "actor-a",
					videoDecision: "copy",
					audioDecision: "transcode",
					videoResolution: null,
				},
			]);
			const legacy = {
				...native("b-legacy", [
					{ user: "Synthetic legacy", videoDecision: "direct play", videoResolution: "4k" },
				]),
				concurrentStreams: 2,
				measurementJson: null,
			};
			const malformed = { ...native("c-malformed", [{ userId: "actor-a" }]), sessionsJson: "{" };
			const contradiction = native("d-contradiction", [
				{ user: "Synthetic B", userId: "actor-b", videoDecision: "copy", videoResolution: "4k" },
			]);
			const marked = JSON.parse(contradiction.measurementJson!);
			marked.methodAxis = "video";
			marked.methods = {
				directPlayCount: 1,
				directStreamCount: 0,
				transcodeCount: 0,
				unknownDecisionCount: 0,
			};
			contradiction.measurementJson = JSON.stringify(marked);
			function marker(id: string, status: "idle" | "failed"): SnapshotRow {
				const row = native(id, [{ videoDecision: "unknown" }]);
				const receipt = JSON.parse(row.measurementJson!);
				receipt.status = status;
				receipt.observedSessions = status === "idle" ? 0 : null;
				receipt.bandwidth =
					status === "idle"
						? { status: "complete", observedSessions: 0, measuredSessions: 0, knownTotalKbps: 0 }
						: null;
				receipt.methods =
					status === "idle"
						? {
								directPlayCount: 0,
								directStreamCount: 0,
								transcodeCount: 0,
								unknownDecisionCount: 0,
							}
						: null;
				receipt.network =
					status === "idle"
						? { status: "complete", lanKbps: 0, wanKbps: 0 }
						: { status: "unavailable", lanKbps: null, wanKbps: null };
				return {
					...row,
					concurrentStreams: 0,
					sessionsJson: "[]",
					measurementJson: JSON.stringify(receipt),
					capturedAt: new Date("2026-10-02T12:00:00Z"),
				};
			}
			await withAnalyticsRequest(
				service,
				"quality-score",
				{
					snapshotRows: [
						usable,
						legacy,
						malformed,
						contradiction,
						marker("e-failed", "failed"),
						marker("f-idle", "idle"),
						{ ...native("g-invalid", [{}]), measurementJson: "{" },
					],
				},
				async (inject, _state, url) => {
					const response = await inject("GET", url);
					expect(response.statusCode).toBe(200);
					const body = response.json();
					expect(body).toMatchObject({
						overallScore: 93,
						breakdown: { directPlayScore: 100, resolutionScore: 75, transcodeScore: 100 },
						components: { directPlayScore: 50, resolutionScore: 75, transcodeScore: 100 },
						measurement: {
							status: "partial",
							observedSessions: 7,
							methodMeasuredSessions: 2,
							resolutionMeasuredSessions: 3,
							scoredSessions: 1,
							invalidDetailSnapshots: 2,
							unattributedSessions: 3,
							configuredSources: service === "JELLYFIN" ? 2 : 1,
							collection: {
								activeSnapshots: 3,
								idleSnapshots: 1,
								failedSnapshots: 1,
								legacySnapshots: 1,
								invalidSnapshots: 1,
							},
						},
					});
					expect(body.trend).toHaveLength(2);
					expect(body.trend[0]).toMatchObject({
						date: "2026-10-02",
						score: null,
						measurement: {
							observedSessions: 0,
							scoredSessions: 0,
							collection: { idleSnapshots: 1, failedSnapshots: 1 },
						},
					});
					expect(body.trend[1]).toMatchObject({
						date: "2026-10-04",
						score: 93,
						measurement: {
							observedSessions: 7,
							scoredSessions: 1,
							collection: { activeSnapshots: 3, legacySnapshots: 1, invalidSnapshots: 1 },
						},
					});
					expect(body.perUser).toMatchObject([
						{ username: "Synthetic A", score: 93, sessions: 3, coverage: { scoredSessions: 1 } },
						{
							username: "Synthetic B",
							score: null,
							sessions: 1,
							components: { directPlayScore: null, resolutionScore: 100, transcodeScore: null },
							coverage: { scoredSessions: 0 },
						},
					]);
					expect(body).not.toHaveProperty("failedPreviews");
					expect(body).not.toHaveProperty("parseFailures");
				},
			);
		},
	);
	it.each(["PLEX", "JELLYFIN"] as const)(
		"certifies only native %s quality tail after 20,000 legacy rows",
		async (service) => {
			const rows = makeSnapshots(service, "quality-score");
			for (const row of rows.slice(0, 20_000)) row.measurementJson = null;
			await withAnalyticsRequest(
				service,
				"quality-score",
				{ snapshotRows: rows },
				async (inject, _state, url) => {
					const response = await inject("GET", url);
					expect(response.statusCode).toBe(200);
					expect(response.json()).toMatchObject({
						overallScore: 8,
						breakdown: { directPlayScore: 0, resolutionScore: 25, transcodeScore: 0 },
						measurement: {
							status: "partial",
							observedSessions: 20_001,
							methodMeasuredSessions: 1,
							resolutionMeasuredSessions: 1,
							scoredSessions: 1,
							unattributedSessions: 20_000,
							collection: { activeSnapshots: 1, legacySnapshots: 20_000 },
						},
						trend: [
							{ date: "2026-10-03", score: null },
							{ date: "2026-10-04", score: 8 },
						],
						perUser: [{ username: "bob", score: 8, sessions: 1 }],
					});
				},
			);
		},
	);
	it.each(handlers)("includes the $name tail beyond the former 20,000-row cap", async (handler) => {
		await withAnalyticsRequest(handler.service, handler.path, {}, async (inject, state, url) => {
			const response = await inject("GET", url);
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject(
				handler.path === "quality-score" ? fullQualityResponse(handler.service) : fullPlaysResponse,
			);
			if (handler.path === "plays-by-date")
				assertPlaysCollection(response.json(), handler.service === "JELLYFIN" ? 2 : 1, 20_001);
			expect(state.serviceInstance.findMany).toHaveBeenCalledWith({
				where: {
					userId: OWNER_ID,
					service: { in: handler.service === "PLEX" ? ["PLEX"] : ["JELLYFIN", "EMBY"] },
					enabled: true,
				},
				select: { id: true },
			});
		});
	});

	it.each(handlers)(
		"does not return partial data when a later $name page fails, then recovers",
		async (handler) => {
			await withAnalyticsRequest(
				handler.service,
				handler.path,
				{ failOnPage: 2 },
				async (inject, state, url) => {
					const failed = await inject("GET", url);
					expect(failed.statusCode).toBe(500);
					expect(failed.json()).not.toHaveProperty("overallScore");
					expect(failed.json()).not.toHaveProperty("categories");
					expect(state.sessionSnapshot.findMany).toHaveBeenCalledTimes(2);

					state.setFailOnPage(undefined);
					const recovered = await inject("GET", url);
					expect(recovered.statusCode).toBe(200);
					expect(recovered.json()).toMatchObject(
						handler.path === "quality-score"
							? fullQualityResponse(handler.service)
							: fullPlaysResponse,
					);
					if (handler.path === "plays-by-date")
						assertPlaysCollection(recovered.json(), handler.service === "JELLYFIN" ? 2 : 1, 20_001);
				},
			);
		},
	);

	it.each(handlers)("avoids snapshot reads for an unowned $name scope", async (handler) => {
		await withAnalyticsRequest(
			handler.service,
			handler.path,
			{ emptyScope: true },
			async (inject, state, url) => {
				const response = await inject("GET", url);
				expect(response.statusCode).toBe(200);
				expect(state.sessionSnapshot.findMany).not.toHaveBeenCalled();
				if (handler.path === "quality-score")
					expect(response.json()).toEqual(emptyQualityResponse(0));
				else {
					expect(response.json()).toMatchObject({
						categories: fullPlaysResponse.categories,
						series: [
							{ name: "Movies", data: new Array(30).fill(null) },
							{ name: "TV", data: new Array(30).fill(null) },
							{ name: "Music", data: new Array(30).fill(null) },
						],
						measurement: { configuredSources: 0, collection: { activeSnapshots: 0 } },
					});
					assertPlaysCollection(response.json(), 0, 0);
				}
			},
		);
	});

	it.each(handlers)("preserves the enabled-but-empty $name response", async (handler) => {
		await withAnalyticsRequest(
			handler.service,
			handler.path,
			{ emptySnapshots: true },
			async (inject, state, url) => {
				const response = await inject("GET", url);
				expect(response.statusCode).toBe(200);
				expect(state.sessionSnapshot.findMany).toHaveBeenCalledTimes(1);
				expect(response.json()).toMatchObject(
					handler.path === "quality-score"
						? emptyQualityResponse(handler.service === "JELLYFIN" ? 2 : 1)
						: {
								categories: fullPlaysResponse.categories,
								series: [
									{ name: "Movies", data: new Array(30).fill(null) },
									{ name: "TV", data: new Array(30).fill(null) },
									{ name: "Music", data: new Array(30).fill(null) },
								],
							},
				);
				if (handler.path === "plays-by-date")
					assertPlaysCollection(response.json(), handler.service === "JELLYFIN" ? 2 : 1, 0);
			},
		);
	});
});
