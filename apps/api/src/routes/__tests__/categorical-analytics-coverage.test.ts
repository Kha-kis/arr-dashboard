import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSnapshot } from "../../lib/prisma.js";
import {
	buildFailedSessionSnapshot,
	buildJellyfinSessionSnapshot,
	buildPlexSessionSnapshot,
} from "../../plugins/lib/session-snapshot-measurements.js";
import { registerAnalyticsRoutes } from "../jellyfin/analytics-routes.js";
import { registerCodecAnalyticsRoutes } from "../plex/codec-analytics-routes.js";
import { registerDeviceAnalyticsRoutes } from "../plex/device-analytics-routes.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "./test-helpers.js";

const OWNER_ID = "synthetic-owner";
const OTHER_OWNER_ID = "synthetic-other";
const CUTOFF = new Date("2026-10-05T12:59:00.000Z");
const HEAD_COUNT = 20_000;

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-05T13:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

type Service = "PLEX" | "JELLYFIN" | "EMBY" | "SONARR";
type AnalyticsCase = {
	name: string;
	family: "codec" | "device";
	service: "PLEX" | "JELLYFIN";
	path: string;
};

const cases: AnalyticsCase[] = [
	{ name: "Plex codec", family: "codec", service: "PLEX", path: "/analytics/?days=30" },
	{ name: "Plex device", family: "device", service: "PLEX", path: "/analytics/?days=30" },
	{
		name: "Jellyfin and Emby codec",
		family: "codec",
		service: "JELLYFIN",
		path: "/analytics/codec?days=30",
	},
	{
		name: "Jellyfin and Emby device",
		family: "device",
		service: "JELLYFIN",
		path: "/analytics/devices?days=30",
	},
];

function session(index: number, family: "codec" | "device") {
	if (index === HEAD_COUNT) {
		return family === "codec"
			? {
					videoCodec: "tail-video",
					audioCodec: "tail-audio",
					videoResolution: "2160",
				}
			: { platform: "tail-platform", player: "tail-player" };
	}
	return family === "codec"
		? { videoCodec: "h264", audioCodec: "aac", videoResolution: "1080" }
		: { platform: "Roku", player: "Roku Ultra" };
}

function nativeReceipt(provider: string, count = 1) {
	return JSON.stringify({
		version: 1,
		provider,
		deviceLabelAxis: provider === "PLEX" ? "platform" : "client",
		status: "active",
		observedSessions: count,
		bandwidthBasis: provider === "PLEX" ? "provider-reported" : "encoding-estimate",
		bandwidth: {
			status: "unavailable",
			observedSessions: count,
			measuredSessions: 0,
			knownTotalKbps: null,
		},
		methods: {
			directPlayCount: 0,
			transcodeCount: 0,
			directStreamCount: 0,
			unknownDecisionCount: count,
		},
		network: { status: "unavailable", lanKbps: null, wanKbps: null },
	});
}

function createPrisma(testCase: AnalyticsCase, emptyScope: boolean, sessionForIndex = session) {
	const instances = [
		{ id: "plex-owned", userId: OWNER_ID, service: "PLEX" as const, enabled: true },
		{ id: "jellyfin-owned", userId: OWNER_ID, service: "JELLYFIN" as const, enabled: true },
		{ id: "emby-owned", userId: OWNER_ID, service: "EMBY" as const, enabled: true },
		{ id: "sonarr-owned", userId: OWNER_ID, service: "SONARR" as const, enabled: true },
		{ id: "jellyfin-disabled", userId: OWNER_ID, service: "JELLYFIN" as const, enabled: false },
		{
			id: "jellyfin-other-owner",
			userId: OTHER_OWNER_ID,
			service: "JELLYFIN" as const,
			enabled: true,
		},
	];
	const headInstanceId = testCase.service === "PLEX" ? "plex-owned" : "jellyfin-owned";
	const tailInstanceId = testCase.service === "PLEX" ? headInstanceId : "emby-owned";
	const rows: Pick<
		SessionSnapshot,
		"id" | "instanceId" | "capturedAt" | "sessionsJson" | "concurrentStreams" | "measurementJson"
	>[] = Array.from({ length: HEAD_COUNT + 1 }, (_, index) => ({
		id: `snapshot-${String(index).padStart(5, "0")}`,
		instanceId: index === HEAD_COUNT ? tailInstanceId : headInstanceId,
		capturedAt: new Date(CUTOFF.getTime() + index),
		sessionsJson: JSON.stringify([sessionForIndex(index, testCase.family)]),
		concurrentStreams: 1,
		measurementJson: nativeReceipt(
			index === HEAD_COUNT && testCase.service !== "PLEX" ? "EMBY" : testCase.service,
		),
	}));
	rows.push(
		{
			id: "wrong-owner",
			instanceId: "jellyfin-other-owner",
			capturedAt: CUTOFF,
			sessionsJson: JSON.stringify([session(HEAD_COUNT, testCase.family)]),
			concurrentStreams: 1,
			measurementJson: null,
		},
		{
			id: "disabled-service",
			instanceId: "jellyfin-disabled",
			capturedAt: CUTOFF,
			sessionsJson: JSON.stringify([session(HEAD_COUNT, testCase.family)]),
			concurrentStreams: 1,
			measurementJson: null,
		},
		{
			id: "wrong-service",
			instanceId: "sonarr-owned",
			capturedAt: CUTOFF,
			sessionsJson: JSON.stringify([session(HEAD_COUNT, testCase.family)]),
			concurrentStreams: 1,
			measurementJson: null,
		},
	);

	let failOnPage: number | undefined;
	let pageCalls = 0;
	const sessionSnapshot = {
		findMany: vi.fn(async (args: Record<string, unknown>) => {
			pageCalls++;
			if (pageCalls === failOnPage) throw new Error("synthetic later page failure");
			const where = args.where as {
				instanceId: { in: string[] };
				capturedAt: { gte: Date };
				OR?: Array<{ capturedAt?: { gt?: Date }; id?: { gt?: string } }>;
			};
			const afterAt = where.OR?.[0]?.capturedAt?.gt;
			const afterId = where.OR?.[1]?.id?.gt;
			return rows
				.filter(
					(row) =>
						where.instanceId.in.includes(row.instanceId) &&
						row.capturedAt >= where.capturedAt.gte &&
						(!afterAt ||
							row.capturedAt > afterAt ||
							(row.capturedAt.getTime() === afterAt.getTime() && row.id > (afterId ?? ""))),
				)
				.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime() || a.id.localeCompare(b.id))
				.slice(0, Number(args.take))
				.map(({ id, capturedAt, sessionsJson, concurrentStreams, measurementJson }) => ({
					id,
					capturedAt,
					sessionsJson,
					concurrentStreams,
					measurementJson,
				}));
		}),
	};
	const serviceInstance = {
		findMany: vi.fn(async (args: Record<string, unknown>) => {
			if (emptyScope) return [];
			const where = args.where as {
				userId: string;
				service: Service | { in: Service[] };
				enabled: boolean;
			};
			return instances
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
	const prisma = {
		serviceInstance,
		sessionSnapshot,
		$transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
			work({ serviceInstance, sessionSnapshot }),
		),
	};
	return {
		prisma,
		rows,
		sessionSnapshot,
		setFailOnPage(page: number | undefined) {
			failOnPage = page;
			pageCalls = 0;
		},
	};
}

async function setup(testCase: AnalyticsCase, emptyScope = false, sessionForIndex = session) {
	const app = Fastify({ logger: false });
	const persistence = createPrisma(testCase, emptyScope, sessionForIndex);
	app.decorate("prisma", persistence.prisma as never);
	setupAuthInjection(app, { id: OWNER_ID, username: "synthetic-owner" });
	registerTestErrorHandler(app);
	if (testCase.service === "PLEX") {
		await app.register(
			testCase.family === "codec" ? registerCodecAnalyticsRoutes : registerDeviceAnalyticsRoutes,
			{ prefix: "/analytics" },
		);
	} else {
		await app.register(registerAnalyticsRoutes, { prefix: "/analytics" });
	}
	await app.ready();
	return {
		app,
		persistence,
		request: () => createInjectAuthenticated(app)("GET", testCase.path),
	};
}

function expected(testCase: AnalyticsCase) {
	if (testCase.family === "codec") {
		return {
			videoCodecs: [
				{ codec: "h264", count: HEAD_COUNT, percent: 100 },
				{ codec: "tail-video", count: 1, percent: 0 },
			],
			audioCodecs: [
				{ codec: "aac", count: HEAD_COUNT, percent: 100 },
				{ codec: "tail-audio", count: 1, percent: 0 },
			],
			resolutions: [
				{ resolution: "1080", count: HEAD_COUNT, percent: 100 },
				{ resolution: "2160", count: 1, percent: 0 },
			],
			totalSessions: 20_001,
			measurement: {
				version: 1,
				status: "complete",
				observedSessions: 20_001,
				videoCodecMeasuredSessions: 20_001,
				audioCodecMeasuredSessions: 20_001,
				resolutionMeasuredSessions: 20_001,
				invalidDetailSnapshots: 0,
				configuredSources: testCase.service === "PLEX" ? 1 : 2,
				collection: {
					activeSnapshots: 20_001,
					idleSnapshots: 0,
					failedSnapshots: 0,
					legacySnapshots: 0,
					invalidSnapshots: 0,
				},
			},
		};
	}
	return {
		platforms: [
			{ platform: "Roku", sessions: HEAD_COUNT, percent: 100 },
			{ platform: "tail-platform", sessions: 1, percent: 0 },
		],
		players: [
			{ player: "Roku Ultra", platform: "Roku", sessions: HEAD_COUNT },
			{ player: "tail-player", platform: "tail-platform", sessions: 1 },
		],
		totalSessions: 20_001,
		measurement: {
			version: 1,
			status: "complete",
			observedSessions: 20_001,
			platformMeasuredSessions: 20_001,
			playerMeasuredSessions: 20_001,
			platformAxis: testCase.service === "PLEX" ? "platform" : "client",
			unverifiedPlatformSnapshots: 0,
			invalidDetailSnapshots: 0,
			configuredSources: testCase.service === "PLEX" ? 1 : 2,
			collection: {
				activeSnapshots: 20_001,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		},
	};
}

describe("categorical analytics full-window coverage", () => {
	it.each(cases)(
		"retains raw collection coverage and independent usable detail in $name",
		async (testCase) => {
			const { app, request, persistence } = await setup(testCase);
			const provider = testCase.service;
			const idle =
				provider === "PLEX"
					? buildPlexSessionSnapshot([])
					: buildJellyfinSessionSnapshot([], "JELLYFIN");
			const failed = buildFailedSessionSnapshot(provider);
			const retained = persistence.rows.slice(0, 5);
			persistence.rows.splice(0, persistence.rows.length, ...retained);
			Object.assign(retained[0]!, {
				measurementJson: nativeReceipt(provider, 2),
				concurrentStreams: 2,
				sessionsJson: JSON.stringify([
					{
						videoCodec: " H264 ",
						audioCodec: "AAC",
						videoResolution: "1920x1080",
						platform: " Roku ",
						player: " Player ",
					},
					null,
				]),
			});
			Object.assign(retained[1]!, { measurementJson: null, concurrentStreams: 3 });
			Object.assign(retained[2]!, {
				measurementJson: idle.measurementJson,
				concurrentStreams: 0,
				sessionsJson: "[]",
			});
			Object.assign(retained[3]!, {
				measurementJson: failed.measurementJson,
				concurrentStreams: 0,
				sessionsJson: "[]",
			});
			Object.assign(retained[4]!, { measurementJson: "invalid", concurrentStreams: 1 });
			try {
				const response = await request();
				expect(response.statusCode).toBe(200);
				expect(response.json()).toEqual(
					testCase.family === "codec"
						? {
								totalSessions: 5,
								videoCodecs: [
									{ codec: "unknown", count: 4, percent: 80 },
									{ codec: "h264", count: 1, percent: 20 },
								],
								audioCodecs: [
									{ codec: "unknown", count: 4, percent: 80 },
									{ codec: "aac", count: 1, percent: 20 },
								],
								resolutions: [
									{ resolution: "unknown", count: 4, percent: 80 },
									{ resolution: "1080", count: 1, percent: 20 },
								],
								measurement: {
									version: 1,
									status: "partial",
									observedSessions: 5,
									videoCodecMeasuredSessions: 1,
									audioCodecMeasuredSessions: 1,
									resolutionMeasuredSessions: 1,
									invalidDetailSnapshots: 2,
									configuredSources: provider === "PLEX" ? 1 : 2,
									collection: {
										activeSnapshots: 1,
										idleSnapshots: 1,
										failedSnapshots: 1,
										legacySnapshots: 1,
										invalidSnapshots: 1,
									},
								},
							}
						: {
								totalSessions: 5,
								platforms: [
									{ platform: "unknown", sessions: 4, percent: 80 },
									{ platform: "Roku", sessions: 1, percent: 20 },
								],
								players: [
									{ player: "unknown", platform: "unknown", sessions: 4 },
									{ player: "Player", platform: "Roku", sessions: 1 },
								],
								measurement: {
									version: 1,
									status: "partial",
									observedSessions: 5,
									platformMeasuredSessions: 1,
									playerMeasuredSessions: 1,
									platformAxis: provider === "PLEX" ? "platform" : "client",
									unverifiedPlatformSnapshots: 0,
									invalidDetailSnapshots: 2,
									configuredSources: provider === "PLEX" ? 1 : 2,
									collection: {
										activeSnapshots: 1,
										idleSnapshots: 1,
										failedSnapshots: 1,
										legacySnapshots: 1,
										invalidSnapshots: 1,
									},
								},
							},
				);
			} finally {
				await app.close();
			}
		},
	);
	it.each(cases)(
		"retains native tail after 20k unverified legacy observations in $name",
		async (testCase) => {
			const { app, request, persistence } = await setup(testCase);
			for (const row of persistence.rows.slice(0, HEAD_COUNT)) row.measurementJson = null;
			try {
				const response = await request();
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject(
					testCase.family === "codec"
						? {
								totalSessions: 20_001,
								videoCodecs: [
									{ codec: "unknown", count: 20_000, percent: 100 },
									{ codec: "tail-video", count: 1, percent: 0 },
								],
								audioCodecs: [
									{ codec: "unknown", count: 20_000, percent: 100 },
									{ codec: "tail-audio", count: 1, percent: 0 },
								],
								resolutions: [
									{ resolution: "unknown", count: 20_000, percent: 100 },
									{ resolution: "2160", count: 1, percent: 0 },
								],
								measurement: {
									status: "partial",
									observedSessions: 20_001,
									videoCodecMeasuredSessions: 1,
									audioCodecMeasuredSessions: 1,
									resolutionMeasuredSessions: 1,
									collection: { activeSnapshots: 1, legacySnapshots: 20_000 },
								},
							}
						: {
								totalSessions: 20_001,
								platforms: [
									{ platform: "unknown", sessions: 20_000, percent: 100 },
									{ platform: "tail-platform", sessions: 1, percent: 0 },
								],
								players: [
									{ player: "unknown", platform: "unknown", sessions: 20_000 },
									{ player: "tail-player", platform: "tail-platform", sessions: 1 },
								],
								measurement: {
									status: "partial",
									platformMeasuredSessions: 1,
									playerMeasuredSessions: 1,
									observedSessions: 20_001,
									collection: { activeSnapshots: 1, legacySnapshots: 20_000 },
								},
							},
				);
			} finally {
				await app.close();
			}
		},
	);
	it.each(cases.filter((testCase) => testCase.family === "device"))(
		"keeps delimiter-colliding pairs distinct across the final page in $name",
		async (testCase) => {
			const { app, request } = await setup(testCase, false, (index) =>
				index === HEAD_COUNT
					? { player: "Player", platform: "Variant::Host" }
					: { player: "Player::Variant", platform: "Host" },
			);
			try {
				const response = await request();
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({
					platforms: [
						{ platform: "Host", sessions: HEAD_COUNT, percent: 100 },
						{ platform: "Variant::Host", sessions: 1, percent: 0 },
					],
					players: [
						{ player: "Player::Variant", platform: "Host", sessions: HEAD_COUNT },
						{ player: "Player", platform: "Variant::Host", sessions: 1 },
					],
					totalSessions: HEAD_COUNT + 1,
				});
			} finally {
				await app.close();
			}
		},
	);

	it.each(cases)("includes the final category in $name", async (testCase) => {
		const { app, request } = await setup(testCase);
		try {
			const response = await request();
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual(expected(testCase));
		} finally {
			await app.close();
		}
	});

	it.each(cases)(
		"does not query snapshot pages without owned instances for $name",
		async (testCase) => {
			const { app, request, persistence } = await setup(testCase, true);
			try {
				const response = await request();
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject(
					testCase.family === "codec"
						? {
								videoCodecs: [],
								audioCodecs: [],
								resolutions: [],
								totalSessions: 0,
								measurement: { status: "unavailable", configuredSources: 0 },
							}
						: {
								platforms: [],
								players: [],
								totalSessions: 0,
								measurement: { status: "unavailable", configuredSources: 0 },
							},
				);
				expect(persistence.sessionSnapshot.findMany).not.toHaveBeenCalled();
			} finally {
				await app.close();
			}
		},
	);

	it.each(cases)(
		"fails and then recovers from a later-page read failure for $name",
		async (testCase) => {
			const { app, request, persistence } = await setup(testCase);
			try {
				persistence.setFailOnPage(2);
				const failed = await request();
				expect(failed.statusCode).toBe(500);
				expect(failed.json()).not.toHaveProperty("totalSessions");

				persistence.setFailOnPage(undefined);
				const recovered = await request();
				expect(recovered.statusCode).toBe(200);
				expect(recovered.json()).toEqual(expected(testCase));
			} finally {
				await app.close();
			}
		},
	);
});
