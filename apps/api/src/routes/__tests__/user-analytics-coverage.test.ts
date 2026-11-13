import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServiceInstance, SessionSnapshot } from "../../lib/prisma.js";
import { registerAnalyticsRoutes } from "../jellyfin/analytics-routes.js";
import { registerUserAnalyticsRoutes } from "../plex/user-analytics-routes.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const OWNER_ID = "synthetic-owner";
const CUTOFF = new Date("2026-10-05T12:59:00.000Z");

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-05T13:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

function sessionRows(services: string, count = 20_001): SessionSnapshot[] {
	return Array.from({ length: count }, (_, index) => ({
		id: `snapshot-${String(index).padStart(5, "0")}`,
		instanceId: services === "JELLYFIN" && index === 20_000 ? "owned-emby" : "owned-instance",
		capturedAt: new Date(CUTOFF.getTime() + index),
		concurrentStreams: 1,
		totalBandwidth: 0,
		lanBandwidth: 0,
		wanBandwidth: 0,
		directPlayCount: 0,
		transcodeCount: 0,
		directStreamCount: 0,
		measurementJson: JSON.stringify({
			userIdentity: "provider-native",
			sourceScope: { connectionGeneration: 0, identityGeneration: 0 },
			version: 1,
			provider: services === "JELLYFIN" && index === 20_000 ? "EMBY" : services,
			methodAxis: "video",
			status: "active",
			bandwidthBasis: services === "PLEX" ? "provider-reported" : "encoding-estimate",
			observedSessions: 1,
			bandwidth: {
				status: "complete",
				observedSessions: 1,
				measuredSessions: 1,
				knownTotalKbps: 7,
			},
			methods: {
				directPlayCount: 0,
				transcodeCount: 0,
				directStreamCount: 0,
				unknownDecisionCount: 1,
			},
			network: { status: "unavailable", lanKbps: null, wanKbps: null },
		}),
		sessionsJson: JSON.stringify([
			{
				userId: index === 20_000 ? "tail-id" : "head-id",
				user: index === 20_000 ? "tail-user" : "head-user",
				title: "Synthetic",
				bandwidth: 7,
			},
		]),
	}));
}

function queryRespectingPrisma(
	service: "PLEX" | "JELLYFIN" | "EMBY",
	options: { emptyScope?: boolean; failOnPage?: number; rows?: SessionSnapshot[] } = {},
) {
	const primaryInstance: ServiceInstance = {
		id: "owned-instance",
		userId: OWNER_ID,
		service,
		label: "synthetic",
		baseUrl: "http://example.invalid",
		encryptedApiKey: "synthetic",
		encryptionIv: "synthetic",
		externalUrl: null,
		encryptedHttpAuthCredentials: null,
		httpAuthEncryptionIv: null,
		enabled: true,
		isDefault: false,
		storageGroupId: null,
		hasLocalFilesystemAccess: false,
		pathPrefix: null,
		connectionGeneration: 0,
		expectedIdentity: null,
		identityKind: null,
		identityStatus: "UNVERIFIED",
		identityGeneration: 0,
		identityVerifiedAt: null,
		identityLastCheckedAt: null,
		createdAt: CUTOFF,
		updatedAt: CUTOFF,
	};
	const owned: ServiceInstance[] = options.emptyScope
		? []
		: [
				primaryInstance,
				...(service === "JELLYFIN"
					? [{ ...primaryInstance, id: "owned-emby", service: "EMBY" as const }]
					: []),
			];
	const rows = options.rows ?? sessionRows(service);
	const inventory = [
		...owned,
		{ ...primaryInstance, id: "foreign", userId: "foreign-owner" },
		{ ...primaryInstance, id: "disabled", enabled: false },
		{ ...primaryInstance, id: "wrong-service", service: "RADARR" as const },
	];
	let pageCount = 0;
	const sessionSnapshot = {
		findMany: vi.fn(async (args: Record<string, unknown>) => {
			pageCount += 1;
			if (options.failOnPage === pageCount) throw new Error("synthetic snapshot read failure");
			const where = args.where as {
				instanceId: { in: string[] };
				capturedAt: { gte: Date };
				OR?: Array<{ capturedAt?: { gt?: Date }; id?: { gt?: string } }>;
			};
			const cursor = where.OR?.[0];
			const selected = rows
				.filter(
					(row) =>
						where.instanceId.in.includes(row.instanceId) &&
						row.capturedAt >= where.capturedAt.gte &&
						(!cursor ||
							row.capturedAt > (cursor.capturedAt?.gt ?? new Date(0)) ||
							(row.capturedAt.getTime() === cursor.capturedAt?.gt?.getTime() &&
								row.id > (where.OR?.[1]?.id?.gt ?? ""))),
				)
				.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime() || a.id.localeCompare(b.id))
				.slice(0, Number(args.take));
			return selected.map(
				({ id, instanceId, capturedAt, sessionsJson, concurrentStreams, measurementJson }) => ({
					id,
					instanceId,
					capturedAt,
					sessionsJson,
					concurrentStreams,
					measurementJson,
				}),
			);
		}),
	};
	const serviceInstance = {
		findMany: vi.fn(async (args: Record<string, unknown>) => {
			const where = args.where as {
				userId: string;
				service: string | { in: string[] };
				enabled: boolean;
			};
			return inventory
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
	return {
		serviceInstance,
		sessionSnapshot,
		$transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
			work({ serviceInstance, sessionSnapshot }),
		),
	};
}

async function requestUserAnalytics(
	service: "PLEX" | "JELLYFIN" | "EMBY",
	route: typeof registerUserAnalyticsRoutes | typeof registerAnalyticsRoutes,
	url: string,
	options: { emptyScope?: boolean; failOnPage?: number; rows?: SessionSnapshot[] } = {},
) {
	const app = Fastify({ logger: false });
	const prisma = queryRespectingPrisma(service, options);
	app.decorate("prisma", prisma as never);
	setupAuthInjection(app);
	app.addHook("preHandler", async (request) => {
		request.currentUser = { id: OWNER_ID, username: "synthetic-owner" } as never;
	});
	await app.register(route, { prefix: "/analytics" });
	await app.ready();
	try {
		return {
			response: await createInjectAuthenticated(app)("GET", url),
			sessionSnapshot: prisma.sessionSnapshot,
		};
	} finally {
		await app.close();
	}
}

describe("user analytics cache coverage", () => {
	it.each([
		{ service: "PLEX" as const, route: registerUserAnalyticsRoutes, url: "/analytics/?days=30" },
		{
			service: "JELLYFIN" as const,
			route: registerAnalyticsRoutes,
			url: "/analytics/users?days=30",
		},
		{ service: "EMBY" as const, route: registerAnalyticsRoutes, url: "/analytics/users?days=30" },
	])(
		"does not fabricate source generations for $service observations",
		async ({ service, route, url }) => {
			const rows = sessionRows(service, 3);
			for (const row of rows) {
				const receipt = JSON.parse(row.measurementJson!);
				delete receipt.sourceScope;
				row.measurementJson = JSON.stringify(receipt);
			}
			const { response } = await requestUserAnalytics(service, route, url, { rows });
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				users: [],
				measurement: {
					status: "unavailable",
					observedSessions: 3,
					attributedSessions: 0,
					unattributedSessions: 3,
					collection: { activeSnapshots: 3 },
				},
			});
		},
	);
	it.each([
		{ service: "PLEX" as const, route: registerUserAnalyticsRoutes, url: "/analytics/?days=30" },
		{
			service: "JELLYFIN" as const,
			route: registerAnalyticsRoutes,
			url: "/analytics/users?days=30",
		},
		{ service: "EMBY" as const, route: registerAnalyticsRoutes, url: "/analytics/users?days=30" },
	])(
		"preserves native subsets, legacy coverage, marker-only days and ownership for $service",
		async ({ service, route, url }) => {
			const seed = sessionRows(service, 1)[0]!;
			const active = JSON.parse(seed.measurementJson!);
			const native: SessionSnapshot = {
				...seed,
				id: "native",
				capturedAt: new Date("2026-10-04T12:00:00Z"),
				concurrentStreams: 3,
				sessionsJson: JSON.stringify([
					{ userId: "head-id", user: "same-label", bandwidth: 0 },
					{ userId: "tail-id", user: "same-label", bandwidth: null },
					{ user: "missing-id", bandwidth: null },
				]),
				measurementJson: JSON.stringify({
					...active,
					observedSessions: 3,
					bandwidth: {
						status: "partial",
						observedSessions: 3,
						measuredSessions: 1,
						knownTotalKbps: 0,
					},
					methods: {
						directPlayCount: 0,
						transcodeCount: 0,
						directStreamCount: 0,
						unknownDecisionCount: 3,
					},
				}),
			};
			const marker = {
				...seed,
				capturedAt: new Date("2026-10-05T12:00:00Z"),
				concurrentStreams: 0,
				sessionsJson: "[]",
			};
			const rows = [
				native,
				{ ...seed, id: "legacy", capturedAt: native.capturedAt, measurementJson: null },
				{ ...seed, id: "bad-details", capturedAt: native.capturedAt, sessionsJson: "not-json" },
				{
					...marker,
					id: "idle",
					measurementJson: JSON.stringify({
						...active,
						status: "idle",
						observedSessions: 0,
						bandwidth: {
							status: "complete",
							observedSessions: 0,
							measuredSessions: 0,
							knownTotalKbps: 0,
						},
						methods: {
							directPlayCount: 0,
							transcodeCount: 0,
							directStreamCount: 0,
							unknownDecisionCount: 0,
						},
						network: { status: "complete", lanKbps: 0, wanKbps: 0 },
					}),
				},
				{
					...marker,
					id: "failed",
					measurementJson: JSON.stringify({
						...active,
						status: "failed",
						observedSessions: null,
						bandwidth: null,
						methods: null,
					}),
				},
				{ ...seed, id: "bad-receipt", capturedAt: native.capturedAt, measurementJson: "invalid" },
				{ ...native, id: "foreign", instanceId: "foreign" },
				{ ...native, id: "disabled", instanceId: "disabled" },
				{ ...native, id: "wrong-service", instanceId: "wrong-service" },
				{ ...native, id: "old", capturedAt: new Date("2026-08-01T00:00:00Z") },
			];
			const { response } = await requestUserAnalytics(service, route, url, { rows });
			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.measurement).toEqual({
				version: 1,
				attribution: "source-provider-user-id",
				status: "partial",
				observedSessions: 5,
				attributedSessions: 2,
				unattributedSessions: 3,
				invalidDetailSnapshots: 1,
				configuredSources: service === "JELLYFIN" ? 2 : 1,
				collection: {
					activeSnapshots: 2,
					idleSnapshots: 1,
					failedSnapshots: 1,
					legacySnapshots: 1,
					invalidSnapshots: 1,
				},
			});
			expect(body.users).toHaveLength(2);
			expect(body.users.map((user: { username: string }) => user.username)).toEqual([
				"same-label",
				"same-label",
			]);
			expect(
				body.users.map((user: { avgBandwidth: number | null }) => user.avgBandwidth).sort(),
			).toEqual([0, null]);
			expect(body.dailyBreakdown).toHaveLength(2);
			expect(body.dailyBreakdown[0].measurement).toMatchObject({
				observedSessions: 5,
				attributedSessions: 2,
				unattributedSessions: 3,
			});
			expect(body.dailyBreakdown[1]).toEqual({
				date: "2026-10-05",
				userSessions: {},
				measurement: {
					version: 1,
					attribution: "source-provider-user-id",
					status: "unavailable",
					observedSessions: 0,
					attributedSessions: 0,
					unattributedSessions: 0,
					invalidDetailSnapshots: 0,
					collection: {
						activeSnapshots: 0,
						idleSnapshots: 1,
						failedSnapshots: 1,
						legacySnapshots: 0,
						invalidSnapshots: 0,
					},
				},
			});
			expect(body).not.toHaveProperty("failedPreviews");
			expect(body).not.toHaveProperty("parseFailures");
		},
	);

	it.each([
		{ service: "PLEX" as const, route: registerUserAnalyticsRoutes, url: "/analytics/?days=30" },
		{
			service: "JELLYFIN" as const,
			route: registerAnalyticsRoutes,
			url: "/analytics/users?days=30",
		},
	])(
		"reaches a certified user beyond 20,000 unverified $service observations",
		async ({ service, route, url }) => {
			const rows = sessionRows(service);
			for (const row of rows.slice(0, 20_000)) row.measurementJson = null;
			const { response } = await requestUserAnalytics(service, route, url, { rows });
			expect(response.statusCode).toBe(200);
			expect(response.json().users).toHaveLength(1);
			expect(response.json().users[0]).toMatchObject({
				username: "tail-user",
				totalSessions: 1,
				avgBandwidth: 7,
				totalBandwidth: null,
			});
			expect(response.json().measurement).toMatchObject({
				observedSessions: 20_001,
				attributedSessions: 1,
				unattributedSessions: 20_000,
				status: "partial",
				collection: { activeSnapshots: 1, legacySnapshots: 20_000 },
			});
		},
	);

	it.each([
		{
			name: "Plex",
			service: "PLEX" as const,
			route: registerUserAnalyticsRoutes,
			url: "/analytics/?days=30",
		},
		{
			name: "Jellyfin and Emby",
			service: "JELLYFIN" as const,
			route: registerAnalyticsRoutes,
			url: "/analytics/users?days=30",
		},
	])("includes the complete eligible window for $name", async ({ service, route, url }) => {
		const { response } = await requestUserAnalytics(service, route, url);
		const keys =
			service === "PLEX"
				? [
						"1c80bd847bfb2534c9bf731c1a22c8f53f24073d7a011c7e527a64ae9ef82c80",
						"98b3b0ea7c7f4f388fa3a56629cd568cf90c5af78a0f85d8a86e9651fc7b68c4",
					]
				: [
						"e458c9f3eadf85b5c1182bbe5585642f66394b061e8120f60806746e5a035b8d",
						"59f898ff8eedea0981d1552eb98cd84a8f92b4d28c052b4143181b4ffcd82f60",
					];
		const measurement = {
			version: 1,
			attribution: "source-provider-user-id",
			status: "complete",
			observedSessions: 20_001,
			attributedSessions: 20_001,
			unattributedSessions: 0,
			invalidDetailSnapshots: 0,
			collection: {
				activeSnapshots: 20_001,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		};
		const bandwidthBasis = service === "PLEX" ? "provider-reported" : "encoding-estimate";

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			users: [
				{
					key: keys[0],
					username: "head-user",
					totalSessions: 20_000,
					totalBandwidth: null,
					avgBandwidth: 7,
					bandwidthMeasurement: {
						version: 1,
						bandwidthBasis,
						status: "complete",
						observedSessions: 20_000,
						measuredSessions: 20_000,
					},
					estimatedWatchTimeMinutes: 100_000,
					mostRecentActivity: new Date(CUTOFF.getTime() + 19_999).toISOString(),
				},
				{
					key: keys[1],
					username: "tail-user",
					totalSessions: 1,
					totalBandwidth: null,
					avgBandwidth: 7,
					bandwidthMeasurement: {
						version: 1,
						bandwidthBasis,
						status: "complete",
						observedSessions: 1,
						measuredSessions: 1,
					},
					estimatedWatchTimeMinutes: 5,
					mostRecentActivity: new Date(CUTOFF.getTime() + 20_000).toISOString(),
				},
			],
			dailyBreakdown: [
				{
					date: CUTOFF.toISOString().slice(0, 10),
					userSessions: { [keys[0]!]: 20_000, [keys[1]!]: 1 },
					measurement,
				},
			],
			measurement: { ...measurement, configuredSources: service === "PLEX" ? 1 : 2 },
		});
	});

	it.each([
		{
			service: "PLEX" as const,
			route: registerUserAnalyticsRoutes,
			url: "/analytics/?days=30",
		},
		{
			service: "JELLYFIN" as const,
			route: registerAnalyticsRoutes,
			url: "/analytics/users?days=30",
		},
	])(
		"does not publish partial metrics when a later $service snapshot page fails",
		async ({ service, route, url }) => {
			const { response } = await requestUserAnalytics(service, route, url, { failOnPage: 2 });

			expect(response.statusCode).toBe(500);
			expect(response.json()).not.toHaveProperty("users");
			const recovered = await requestUserAnalytics(service, route, url);
			expect(recovered.response.statusCode).toBe(200);
			expect(recovered.response.json().measurement).toMatchObject({
				observedSessions: 20_001,
				attributedSessions: 20_001,
			});
		},
	);

	it.each([
		{
			service: "PLEX" as const,
			route: registerUserAnalyticsRoutes,
			url: "/analytics/?days=30",
		},
		{
			service: "JELLYFIN" as const,
			route: registerAnalyticsRoutes,
			url: "/analytics/users?days=30",
		},
	])(
		"does not query snapshot pages when $service has no owned enabled instances",
		async ({ service, route, url }) => {
			const { response, sessionSnapshot } = await requestUserAnalytics(service, route, url, {
				emptyScope: true,
			});

			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual({
				users: [],
				dailyBreakdown: [],
				measurement: {
					version: 1,
					attribution: "source-provider-user-id",
					status: "unavailable",
					observedSessions: 0,
					attributedSessions: 0,
					unattributedSessions: 0,
					invalidDetailSnapshots: 0,
					configuredSources: 0,
					collection: {
						activeSnapshots: 0,
						idleSnapshots: 0,
						failedSnapshots: 0,
						legacySnapshots: 0,
						invalidSnapshots: 0,
					},
				},
			});
			expect(sessionSnapshot.findMany).not.toHaveBeenCalled();
		},
	);
});
