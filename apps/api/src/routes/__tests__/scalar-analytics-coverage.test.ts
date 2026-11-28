import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAnalyticsRoutes } from "../jellyfin/analytics-routes.js";
import { registerBandwidthAnalyticsRoutes } from "../plex/bandwidth-analytics-routes.js";
import { registerForecastRoutes } from "../plex/forecast-routes.js";
import { registerMostConcurrentRoutes } from "../plex/most-concurrent-routes.js";
import { registerTranscodeAnalyticsRoutes } from "../plex/transcode-analytics-routes.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

const OWNER_ID = "scalar-coverage-owner";
const CAPTURED_AT = new Date("2026-10-04T14:15:00.000Z");
const SNAPSHOT_COUNT = 50_001;

type Service = "PLEX" | "JELLYFIN" | "EMBY";
type SnapshotRow = {
	id: string;
	instanceId: string;
	capturedAt: Date;
	concurrentStreams: number;
	totalBandwidth: number;
	lanBandwidth: number;
	wanBandwidth: number;
	directPlayCount: number;
	transcodeCount: number;
	directStreamCount: number;
	sessionsJson: string;
	measurementJson?: string | null;
};

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date("2026-10-05T13:00:00.000Z"));
});

afterEach(() => {
	vi.useRealTimers();
});

function makeSnapshots(service: Service): SnapshotRow[] {
	return Array.from({ length: SNAPSHOT_COUNT }, (_, index) => {
		const tail = index === SNAPSHOT_COUNT - 1;
		return {
			id: `scalar-${String(index).padStart(5, "0")}`,
			instanceId: service === "JELLYFIN" && tail ? "owned-emby" : "owned-primary",
			capturedAt: CAPTURED_AT,
			concurrentStreams: tail ? 99 : 1,
			totalBandwidth: tail ? 777 : 2,
			lanBandwidth: tail ? 700 : 1,
			wanBandwidth: tail ? 77 : 1,
			directPlayCount: tail ? 0 : 1,
			transcodeCount: tail ? 7 : 0,
			directStreamCount: tail ? 3 : 0,
			sessionsJson: "[]",
		};
	});
}

function forecastRow(
	id: string,
	instanceId: string,
	capturedAt: string,
	totalBandwidth: number,
	concurrentStreams: number,
): SnapshotRow {
	return {
		id,
		instanceId,
		capturedAt: new Date(capturedAt),
		concurrentStreams,
		totalBandwidth,
		lanBandwidth: totalBandwidth,
		wanBandwidth: 0,
		directPlayCount: 0,
		transcodeCount: 0,
		directStreamCount: 0,
		sessionsJson: "[]",
	};
}

function queryRespectingPrisma(
	service: Service,
	options: {
		emptyScope?: boolean;
		emptySnapshots?: boolean;
		failOnPage?: number;
		snapshotRows?: SnapshotRow[];
	} = {},
) {
	const instances = [
		{ id: "owned-primary", userId: OWNER_ID, service, enabled: true },
		...(service === "JELLYFIN"
			? [{ id: "owned-emby", userId: OWNER_ID, service: "EMBY" as const, enabled: true }]
			: []),
		{ id: "foreign-instance", userId: "other-owner", service, enabled: true },
		{ id: "disabled-instance", userId: OWNER_ID, service, enabled: false },
		{ id: "wrong-service-instance", userId: OWNER_ID, service: "SONARR", enabled: true },
	];
	const allRows = options.emptySnapshots
		? []
		: [
				...(options.snapshotRows ?? makeSnapshots(service)),
				{
					...makeSnapshots("PLEX")[SNAPSHOT_COUNT - 1]!,
					id: "foreign-high-metric",
					instanceId: "foreign-instance",
				},
				{
					...makeSnapshots("PLEX")[SNAPSHOT_COUNT - 1]!,
					id: "disabled-high-metric",
					instanceId: "disabled-instance",
				},
				{
					...makeSnapshots("PLEX")[SNAPSHOT_COUNT - 1]!,
					id: "wrong-service-high-metric",
					instanceId: "wrong-service-instance",
				},
				{
					...makeSnapshots("PLEX")[SNAPSHOT_COUNT - 1]!,
					id: "out-of-cutoff-high-metric",
					instanceId: "owned-primary",
					capturedAt: new Date("2026-09-05T12:59:59.999Z"),
				},
			];
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
			if (failOnPage === pageCount) throw new Error("synthetic metrics page failure");
			const where = args.where as {
				instanceId: { in: string[] };
				capturedAt: { gte: Date };
				OR?: Array<{
					concurrentStreams?: number | { lt: number };
					capturedAt?: Date | { gt: Date };
					id?: { gt: string };
				}>;
			};
			const ordering = Array.isArray(args.orderBy)
				? (args.orderBy as Array<Record<string, "asc" | "desc">>)
				: [args.orderBy as Record<string, "asc" | "desc">];
			if (!orderedRows) {
				orderedRows = allRows
					.filter(
						(row) =>
							where.instanceId.in.includes(row.instanceId) &&
							row.capturedAt >= where.capturedAt.gte,
					)
					.sort((left, right) => {
						for (const order of ordering) {
							const [field, direction] = Object.entries(order)[0] ?? [];
							if (!field || !direction) continue;
							const a = left[field as keyof SnapshotRow];
							const b = right[field as keyof SnapshotRow];
							const compared =
								a instanceof Date && b instanceof Date
									? a.getTime() - b.getTime()
									: typeof a === "number" && typeof b === "number"
										? a - b
										: String(a).localeCompare(String(b));
							if (compared !== 0) return direction === "asc" ? compared : -compared;
						}
						return 0;
					});
			}
			const firstAfterCursor = where.OR
				? orderedRows.findIndex((row) =>
						where.OR?.some((clause) => {
							if (clause.concurrentStreams && typeof clause.concurrentStreams === "object") {
								return row.concurrentStreams < clause.concurrentStreams.lt;
							}
							if (typeof clause.concurrentStreams === "number") {
								if (row.concurrentStreams !== clause.concurrentStreams) return false;
							}
							if (clause.capturedAt && !(clause.capturedAt instanceof Date)) {
								return row.capturedAt > clause.capturedAt.gt;
							}
							if (
								clause.capturedAt instanceof Date &&
								row.capturedAt.getTime() !== clause.capturedAt.getTime()
							) {
								return false;
							}
							if (clause.id) return row.id > clause.id.gt;
							return false;
						}),
					)
				: 0;
			const page = orderedRows.slice(
				firstAfterCursor < 0 ? orderedRows.length : firstAfterCursor,
				(firstAfterCursor < 0 ? orderedRows.length : firstAfterCursor) + Number(args.take),
			);
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

async function withScalarAnalytics<T>(
	service: Service,
	path: "bandwidth" | "transcode" | "forecast" | "most-concurrent",
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
	const state = queryRespectingPrisma(service, options);
	const { prisma } = state;
	app.decorate("prisma", prisma as never);
	setupAuthInjection(app, { id: OWNER_ID, username: OWNER_ID });
	if (service === "PLEX") {
		const routes = {
			bandwidth: registerBandwidthAnalyticsRoutes,
			transcode: registerTranscodeAnalyticsRoutes,
			forecast: registerForecastRoutes,
			"most-concurrent": registerMostConcurrentRoutes,
		};
		await app.register(routes[path], { prefix: `/analytics/${path}` });
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

async function requestScalarAnalytics(
	service: Service,
	path: "bandwidth" | "transcode" | "forecast" | "most-concurrent",
	options: {
		emptyScope?: boolean;
		emptySnapshots?: boolean;
		failOnPage?: number;
		snapshotRows?: SnapshotRow[];
	} = {},
) {
	return withScalarAnalytics(service, path, options, async (inject, state, url) => ({
		response: await inject("GET", url),
		sessionSnapshot: state.sessionSnapshot,
		serviceInstance: state.serviceInstance,
	}));
}

const plexCases = [
	{ name: "Plex bandwidth", service: "PLEX" as const, path: "bandwidth" as const },
	{ name: "Plex transcode", service: "PLEX" as const, path: "transcode" as const },
	{ name: "Plex forecast", service: "PLEX" as const, path: "forecast" as const },
	{ name: "Plex most-concurrent", service: "PLEX" as const, path: "most-concurrent" as const },
];

const jellyfinCases = [
	{ name: "Jellyfin/Emby bandwidth", service: "JELLYFIN" as const, path: "bandwidth" as const },
	{ name: "Jellyfin/Emby transcode", service: "JELLYFIN" as const, path: "transcode" as const },
	{ name: "Jellyfin/Emby forecast", service: "JELLYFIN" as const, path: "forecast" as const },
	{
		name: "Jellyfin/Emby most-concurrent",
		service: "JELLYFIN" as const,
		path: "most-concurrent" as const,
	},
];

function emptyResult(path: (typeof plexCases)[number]["path"], configuredSources = 0) {
	if (path === "bandwidth") {
		return {
			peakConcurrent: null,
			peakBandwidth: null,
			avgBandwidth: null,
			timeSeries: [],
			measurement: {
				version: 1,
				status: "unavailable",
				bandwidthBasis: null,
				observedSessions: 0,
				measuredSessions: 0,
				observedSnapshots: 0,
				measuredSnapshots: 0,
				configuredSources,
				collection: {
					activeSnapshots: 0,
					idleSnapshots: 0,
					failedSnapshots: 0,
					legacySnapshots: 0,
					invalidSnapshots: 0,
				},
			},
		};
	}
	if (path === "transcode") {
		return {
			directPlay: 0,
			transcode: 0,
			directStream: 0,
			unknown: 0,
			totalSessions: 0,
			dailyBreakdown: [],
			measurement: {
				version: 1,
				methodAxis: "video",
				status: "unavailable",
				observedSessions: 0,
				measuredSessions: 0,
				invalidDetailSnapshots: 0,
				configuredSources,
				collection: {
					activeSnapshots: 0,
					idleSnapshots: 0,
					failedSnapshots: 0,
					legacySnapshots: 0,
					invalidSnapshots: 0,
				},
			},
		};
	}
	if (path === "forecast") {
		return {
			historicalDaily: [],
			forecast: [],
			peakHours: [],
			trend: "unknown",
			measurement: {
				version: 1,
				status: "unavailable",
				bandwidthBasis: null,
				observedSessions: 0,
				measuredSessions: 0,
				observedSnapshots: 0,
				measuredSnapshots: 0,
				completeTotalSnapshots: 0,
				eligibleDays: 0,
				projectionStatus: "insufficient-data",
				configuredSources,
				collection: {
					activeSnapshots: 0,
					idleSnapshots: 0,
					failedSnapshots: 0,
					legacySnapshots: 0,
					invalidSnapshots: 0,
				},
			},
		};
	}
	return {
		peakConcurrent: null,
		events: [],
		measurement: {
			version: 1,
			scope: "per-source-snapshot",
			status: "unavailable",
			observedSnapshots: 0,
			nativeSnapshots: 0,
			configuredSources,
			collection: {
				activeSnapshots: 0,
				idleSnapshots: 0,
				failedSnapshots: 0,
				legacySnapshots: 0,
				invalidSnapshots: 0,
			},
		},
	};
}

function expectRecoveredTail(path: (typeof plexCases)[number]["path"], body: Record<string, any>) {
	if (path === "bandwidth") {
		expect(body.peakConcurrent).toBe(99);
		expect(body.peakBandwidth).toBeNull();
		expect(body.measurement.collection.legacySnapshots).toBe(50_001);
	} else if (path === "transcode") {
		expect(body.totalSessions).toBe(50_099);
		expect(body.unknown).toBe(50_099);
		expect(body.transcode).toBe(0);
		expect(body.measurement.collection.legacySnapshots).toBe(50_001);
	} else if (path === "forecast") {
		expect(body.historicalDaily[0]).toMatchObject({
			date: "2026-10-04",
			avgBandwidth: null,
			peakBandwidth: null,
			measurement: { observedSessions: 50_099, collection: { legacySnapshots: 50_001 } },
		});
		expect(body.forecast).toEqual([]);
		expect(body.trend).toBe("unknown");
	} else {
		expect(body.peakConcurrent).toBe(99);
		expect(body.events[0]).toMatchObject({
			capturedAt: CAPTURED_AT.toISOString(),
			concurrentStreams: 99,
			totalBandwidth: null,
			measurement: { concurrencyStatus: "legacy-unverified" },
		});
	}
}

describe("scalar analytics full-window coverage", () => {
	it.each([...plexCases, ...jellyfinCases])(
		"includes the $name tail row beyond the former 50,000-row cap",
		async ({ service, path }) => {
			const { response, sessionSnapshot, serviceInstance } = await requestScalarAnalytics(
				service,
				path,
			);
			expect(response.statusCode).toBe(200);
			expect(serviceInstance.findMany).toHaveBeenCalledWith({
				where: {
					userId: OWNER_ID,
					service: service === "PLEX" ? { in: ["PLEX"] } : { in: ["JELLYFIN", "EMBY"] },
					enabled: true,
				},
				select: { id: true },
			});
			expect(sessionSnapshot.findMany).toHaveBeenCalled();
			for (const [args] of sessionSnapshot.findMany.mock.calls) {
				if (path === "transcode")
					expect((args.select as Record<string, unknown>).sessionsJson).toBe(true);
				else expect((args.select as Record<string, unknown>).sessionsJson).toBeUndefined();
				expect((args.where as { instanceId: { in: string[] } }).instanceId.in).toEqual(
					service === "PLEX" ? ["owned-primary"] : ["owned-primary", "owned-emby"],
				);
			}

			const body = response.json();
			if (path === "bandwidth") {
				expect(body).toMatchObject({
					peakConcurrent: 99,
					peakBandwidth: null,
					avgBandwidth: null,
					measurement: {
						status: "unavailable",
						observedSessions: 50_099,
						measuredSessions: 0,
						observedSnapshots: 50_001,
						measuredSnapshots: 0,
						collection: { activeSnapshots: 0, legacySnapshots: 50_001 },
					},
					timeSeries: [
						{
							date: "2026-10-04",
							concurrent: 99,
							bandwidth: null,
							lanBandwidth: null,
							wanBandwidth: null,
						},
					],
				});
			} else if (path === "transcode") {
				expect(body).toMatchObject({
					directPlay: 0,
					transcode: 0,
					directStream: 0,
					unknown: 50_099,
					totalSessions: 50_099,
					measurement: {
						status: "unavailable",
						observedSessions: 50_099,
						measuredSessions: 0,
						collection: { legacySnapshots: 50_001 },
					},
					dailyBreakdown: [
						{ date: "2026-10-04", directPlay: 0, transcode: 0, directStream: 0, unknown: 50_099 },
					],
				});
			} else if (path === "forecast") {
				expect(body.historicalDaily).toHaveLength(1);
				expectRecoveredTail(path, body);
				expect(body.peakHours).toHaveLength(1);
				expect(body.peakHours[0]).toMatchObject({ hour: 14, avgBandwidth: null });
				expect(body.peakHours[0].avgConcurrent).toBeCloseTo(50_099 / 50_001, 8);
			} else {
				expect(body).toMatchObject({
					peakConcurrent: 99,
					events: [
						{
							capturedAt: CAPTURED_AT.toISOString(),
							concurrentStreams: 99,
							totalBandwidth: null,
							measurement: { concurrencyStatus: "legacy-unverified" },
						},
					],
					measurement: {
						status: "unavailable",
						observedSnapshots: 50_001,
						collection: { legacySnapshots: 50_001 },
						configuredSources: service === "JELLYFIN" ? 2 : 1,
					},
				});
			}
		},
	);

	it.each([
		{ name: "Plex", service: "PLEX" as const, instanceId: "owned-primary" },
		{ name: "Jellyfin/Emby", service: "JELLYFIN" as const, instanceId: "owned-emby" },
	])(
		"projects native forecast peaks from the next UTC day for $name",
		async ({ service, instanceId }) => {
			const provider = service === "PLEX" ? "PLEX" : "EMBY";
			const { response } = await requestScalarAnalytics(service, "forecast", {
				snapshotRows: [
					{
						...nativeBandwidthRow(provider, "forecast-day-1", 1, 100, 1),
						instanceId,
						capturedAt: new Date("2026-10-01T12:00:00.000Z"),
					},
					{
						...nativeBandwidthRow(provider, "forecast-day-2", 2, 200, 2),
						instanceId,
						capturedAt: new Date("2026-10-02T12:00:00.000Z"),
					},
				],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json().forecast.slice(0, 2)).toEqual([
				{ date: "2026-10-03", predictedPeak: 300 },
				{ date: "2026-10-04", predictedPeak: 400 },
			]);
		},
	);

	it.each([...plexCases, ...jellyfinCases])(
		"fails closed on a later $name page read and recovers on retry",
		async ({ service, path }) => {
			await withScalarAnalytics(service, path, { failOnPage: 2 }, async (inject, state, url) => {
				const failed = await inject("GET", url);
				expect(failed.statusCode).toBe(500);
				expect(failed.json()).not.toHaveProperty("peakConcurrent");
				expect(state.sessionSnapshot.findMany).toHaveBeenCalledTimes(2);

				state.setFailOnPage(undefined);
				const recovered = await inject("GET", url);
				expect(recovered.statusCode).toBe(200);
				expectRecoveredTail(path, recovered.json());
			});
		},
	);

	it.each([...plexCases, ...jellyfinCases])(
		"returns the exact empty shape for $name when no owned enabled service exists",
		async ({ service, path }) => {
			const { response, sessionSnapshot } = await requestScalarAnalytics(service, path, {
				emptyScope: true,
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual(emptyResult(path));
			expect(sessionSnapshot.findMany).not.toHaveBeenCalled();
		},
	);

	it.each([...plexCases, ...jellyfinCases])(
		"returns the exact empty shape for $name when owned enabled services have no snapshots",
		async ({ service, path }) => {
			const { response, sessionSnapshot } = await requestScalarAnalytics(service, path, {
				emptySnapshots: true,
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toEqual(emptyResult(path, service === "JELLYFIN" ? 2 : 1));
			expect(sessionSnapshot.findMany).toHaveBeenCalledTimes(1);
		},
	);
});

function nativeBandwidthRow(
	service: Service,
	id: string,
	observed: number,
	knownTotal: number | null,
	measured: number,
	status: "active" | "idle" | "failed" = "active",
): SnapshotRow {
	return {
		...forecastRow(id, "owned-primary", CAPTURED_AT.toISOString(), 9999, observed),
		measurementJson: JSON.stringify({
			version: 1,
			provider: service,
			status,
			bandwidthBasis: service === "PLEX" ? "provider-reported" : "encoding-estimate",
			observedSessions: status === "failed" ? null : observed,
			bandwidth:
				status === "failed"
					? null
					: {
							status:
								knownTotal === null
									? "unavailable"
									: measured === observed
										? "complete"
										: "partial",
							observedSessions: observed,
							measuredSessions: measured,
							knownTotalKbps: knownTotal,
						},
			methods:
				status === "failed"
					? null
					: {
							directPlayCount: 0,
							transcodeCount: 0,
							directStreamCount: 0,
							unknownDecisionCount: observed,
						},
			network:
				status === "idle"
					? { status: "complete", lanKbps: 0, wanKbps: 0 }
					: { status: "unavailable", lanKbps: null, wanKbps: null },
		}),
	};
}

function nativeVideoRow(service: Service, id: string, decisions: unknown[]): SnapshotRow {
	return {
		...nativeBandwidthRow(service, id, decisions.length, null, 0),
		sessionsJson: JSON.stringify(
			decisions.map((videoDecision) => ({ videoDecision, audioDecision: "transcode" })),
		),
	};
}

describe("video-method route measurement truth", () => {
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"uses native video rows for %s, never legacy scalars or overall audio-only transcoding",
		async (service) => {
			const native = nativeVideoRow(service, "a-native", ["direct play", "copy", "unknown"]);
			const oldReceipt = JSON.parse(native.measurementJson!);
			oldReceipt.methods = {
				directPlayCount: 1,
				transcodeCount: 1,
				directStreamCount: 0,
				unknownDecisionCount: 1,
			};
			native.measurementJson = JSON.stringify(oldReceipt);
			const malformed = {
				...nativeVideoRow(service, "c-malformed", ["direct play", "copy"]),
				sessionsJson: "{}",
			};
			const contradiction = nativeVideoRow(service, "d-contradiction", ["transcode"]);
			const markedReceipt = JSON.parse(contradiction.measurementJson!);
			markedReceipt.methodAxis = "video";
			markedReceipt.methods = {
				directPlayCount: 1,
				transcodeCount: 0,
				directStreamCount: 0,
				unknownDecisionCount: 0,
			};
			contradiction.measurementJson = JSON.stringify(markedReceipt);
			const failed = {
				...nativeBandwidthRow(service, "e-failed", 0, null, 0, "failed"),
				capturedAt: new Date("2026-10-02T12:00:00Z"),
			};
			const { response, sessionSnapshot } = await requestScalarAnalytics(service, "transcode", {
				snapshotRows: [
					native,
					forecastRow("b-legacy", "owned-primary", CAPTURED_AT.toISOString(), 9999, 3),
					malformed,
					contradiction,
					failed,
					nativeBandwidthRow(service, "f-idle", 0, 0, 0, "idle"),
					{ ...nativeVideoRow(service, "g-invalid", ["direct play"]), measurementJson: "{" },
				],
			});
			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body).toMatchObject({
				directPlay: 1,
				directStream: 1,
				transcode: 0,
				unknown: 7,
				totalSessions: 9,
				measurement: {
					version: 1,
					methodAxis: "video",
					status: "partial",
					observedSessions: 9,
					measuredSessions: 2,
					invalidDetailSnapshots: 2,
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
			expect(body.dailyBreakdown).toHaveLength(2);
			expect(body.dailyBreakdown[0]).toMatchObject({
				date: "2026-10-02",
				directPlay: 0,
				directStream: 0,
				transcode: 0,
				unknown: 0,
				measurement: {
					status: "unavailable",
					observedSessions: 0,
					collection: { failedSnapshots: 1 },
				},
			});
			expect(body.dailyBreakdown[1]).toMatchObject({
				date: "2026-10-04",
				unknown: 7,
				measurement: {
					invalidDetailSnapshots: 2,
					collection: {
						activeSnapshots: 3,
						idleSnapshots: 1,
						legacySnapshots: 1,
						invalidSnapshots: 1,
						failedSnapshots: 0,
					},
				},
			});
			for (const [args] of sessionSnapshot.findMany.mock.calls)
				expect((args.select as Record<string, unknown>).sessionsJson).toBe(true);
			expect(body).not.toHaveProperty("failedPreviews");
			expect(body).not.toHaveProperty("parseFailures");
		},
	);
	it.each(["PLEX", "JELLYFIN"] as const)(
		"keeps certified %s tail methods after 50,000 legacy observations and retries a failed later page",
		async (service) => {
			const rows = makeSnapshots(service);
			rows[rows.length - 1] = {
				...nativeVideoRow(service === "PLEX" ? "PLEX" : "EMBY", rows[rows.length - 1]!.id, [
					"direct play",
					"copy",
					"transcode",
					...Array(96).fill("unknown"),
				]),
				instanceId: service === "PLEX" ? "owned-primary" : "owned-emby",
			};
			await withScalarAnalytics(
				service,
				"transcode",
				{ snapshotRows: rows, failOnPage: 2 },
				async (inject, state, url) => {
					const failed = await inject("GET", url);
					expect(failed.statusCode).toBe(500);
					expect(failed.json()).not.toHaveProperty("measurement");
					state.setFailOnPage(undefined);
					const recovered = await inject("GET", url);
					expect(recovered.statusCode).toBe(200);
					expect(recovered.json()).toMatchObject({
						directPlay: 1,
						directStream: 1,
						transcode: 1,
						totalSessions: 50_099,
						unknown: 50_096,
						measurement: {
							status: "partial",
							observedSessions: 50_099,
							measuredSessions: 3,
							collection: { activeSnapshots: 1, legacySnapshots: 50_000 },
						},
					});
				},
			);
		},
	);
});

describe("bandwidth route measurement truth", () => {
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"preserves zero and fractions with full collection coverage for %s",
		async (service) => {
			const rows = [
				nativeBandwidthRow(service, "a-zero", 1, 0, 1),
				nativeBandwidthRow(service, "b-partial", 2, 1.5, 1),
				nativeBandwidthRow(service, "c-missing", 1, null, 0),
				forecastRow("d-legacy", "owned-primary", CAPTURED_AT.toISOString(), 9999, 1),
				nativeBandwidthRow(service, "e-failed", 0, null, 0, "failed"),
				nativeBandwidthRow(service, "f-idle", 0, 0, 0, "idle"),
				{
					...forecastRow("g-invalid", "owned-primary", CAPTURED_AT.toISOString(), 9999, 1),
					measurementJson: "{",
				},
			];
			const { response } = await requestScalarAnalytics(service, "bandwidth", {
				snapshotRows: rows,
			});
			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.peakConcurrent).toBe(2);
			expect(body.peakBandwidth).toBe(1.5);
			expect(body.avgBandwidth).toBe(0.75);
			expect(body.measurement).toEqual({
				version: 1,
				status: "partial",
				bandwidthBasis: service === "PLEX" ? "provider-reported" : "encoding-estimate",
				observedSessions: 5,
				measuredSessions: 2,
				observedSnapshots: 4,
				measuredSnapshots: 2,
				configuredSources: service === "JELLYFIN" ? 2 : 1,
				collection: {
					activeSnapshots: 3,
					idleSnapshots: 1,
					failedSnapshots: 1,
					legacySnapshots: 1,
					invalidSnapshots: 1,
				},
			});
			expect(body.timeSeries[0]).toMatchObject({
				date: "2026-10-04",
				concurrent: 2,
				bandwidth: 0.75,
				lanBandwidth: null,
				wanBandwidth: null,
			});
			expect(body.timeSeries[0].measurement.collection).toEqual({
				activeSnapshots: 3,
				idleSnapshots: 1,
				failedSnapshots: 1,
				legacySnapshots: 1,
				invalidSnapshots: 1,
			});
		},
	);

	it.each(["PLEX", "JELLYFIN"] as const)(
		"retains verified %s tail rates beyond 50,000 legacy rows",
		async (service) => {
			const rows = makeSnapshots(service);
			rows[rows.length - 1] = {
				...nativeBandwidthRow(
					service === "PLEX" ? "PLEX" : "EMBY",
					rows[rows.length - 1]!.id,
					99,
					777,
					99,
				),
				instanceId: service === "PLEX" ? "owned-primary" : "owned-emby",
			};
			const { response } = await requestScalarAnalytics(service, "bandwidth", {
				snapshotRows: rows,
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				peakConcurrent: 99,
				peakBandwidth: 777,
				avgBandwidth: 777,
				measurement: {
					observedSessions: 50_099,
					measuredSessions: 99,
					observedSnapshots: 50_001,
					measuredSnapshots: 1,
					collection: { activeSnapshots: 1, legacySnapshots: 50_000 },
				},
			});
		},
	);

	it.each(["PLEX", "JELLYFIN"] as const)(
		"does not disguise failed-only %s collection as zero bandwidth",
		async (service) => {
			const { response } = await requestScalarAnalytics(service, "bandwidth", {
				snapshotRows: [nativeBandwidthRow(service, "failed", 0, null, 0, "failed")],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				peakBandwidth: null,
				avgBandwidth: null,
				timeSeries: [],
				measurement: {
					status: "unavailable",
					collection: { failedSnapshots: 1, activeSnapshots: 0 },
				},
			});
		},
	);

	it("rejects impossible legacy concurrency before full-window coverage is certified", async () => {
		const { response } = await requestScalarAnalytics("PLEX", "bandwidth", {
			snapshotRows: [
				nativeBandwidthRow("PLEX", "known", 1, 10, 1),
				forecastRow("invalid-legacy", "owned-primary", CAPTURED_AT.toISOString(), 9999, -1),
			],
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			peakBandwidth: 10,
			avgBandwidth: 10,
			measurement: {
				status: "partial",
				collection: { activeSnapshots: 1, legacySnapshots: 0, invalidSnapshots: 1 },
			},
		});
	});
});

describe("forecast route native measurement truth", () => {
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"retains partial native rates, unknowns and raw collection for %s",
		async (service) => {
			const zero = {
				...nativeBandwidthRow(service, "a-zero", 1, 0, 1),
				capturedAt: new Date("2026-10-01T12:00:00Z"),
			};
			const partial = {
				...nativeBandwidthRow(service, "b-partial", 2, 1.5, 1),
				capturedAt: new Date("2026-10-01T12:15:00Z"),
			};
			const missing = {
				...nativeBandwidthRow(service, "c-missing", 1, null, 0),
				capturedAt: new Date("2026-10-02T12:00:00Z"),
			};
			const failed = {
				...nativeBandwidthRow(service, "e-failed", 0, null, 0, "failed"),
				capturedAt: new Date("2026-10-03T12:00:00Z"),
			};
			const idle = {
				...nativeBandwidthRow(service, "f-idle", 0, 0, 0, "idle"),
				capturedAt: new Date("2026-10-03T12:10:00Z"),
			};
			const invalid = {
				...nativeBandwidthRow(service, "g-invalid", 1, 9999, 1),
				measurementJson: "invalid",
				capturedAt: new Date("2026-10-03T12:20:00Z"),
			};
			const { response } = await requestScalarAnalytics(service, "forecast", {
				snapshotRows: [
					zero,
					partial,
					missing,
					forecastRow("d-legacy", "owned-primary", "2026-10-02T12:10:00Z", 9999, 2),
					failed,
					idle,
					invalid,
				],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				historicalDaily: [
					{
						date: "2026-10-01",
						avgBandwidth: 0,
						peakBandwidth: 0,
						avgKnownSubtotal: 0.75,
						peakKnownSubtotal: 1.5,
					},
					{ date: "2026-10-02", avgBandwidth: null, peakBandwidth: null },
					{
						date: "2026-10-03",
						avgBandwidth: null,
						peakBandwidth: null,
						measurement: {
							collection: { failedSnapshots: 1, idleSnapshots: 1, invalidSnapshots: 1 },
						},
					},
				],
				forecast: [],
				trend: "unknown",
				measurement: {
					status: "partial",
					observedSessions: 6,
					measuredSessions: 2,
					completeTotalSnapshots: 1,
					eligibleDays: 1,
					projectionStatus: "insufficient-data",
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
		},
	);
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"projects exact native %s samples across a calendar gap",
		async (service) => {
			const { response } = await requestScalarAnalytics(service, "forecast", {
				snapshotRows: [
					{
						...nativeBandwidthRow(service, "day-one", 1, 0.5, 1),
						capturedAt: new Date("2026-10-01T12:00:00Z"),
					},
					{
						...nativeBandwidthRow(service, "day-three", 1, 1.5, 1),
						capturedAt: new Date("2026-10-03T12:00:00Z"),
					},
				],
			});
			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.forecast[0]?.date).toBe("2026-10-04");
			expect(body.forecast[0]?.predictedPeak).toBeCloseTo(2, 8);
			expect(body).toMatchObject({
				measurement: {
					status: "complete",
					eligibleDays: 2,
					projectionStatus: "available",
					bandwidthBasis: service === "PLEX" ? "provider-reported" : "encoding-estimate",
					configuredSources: service === "JELLYFIN" ? 2 : 1,
				},
			});
		},
	);
});

describe("concurrent route native measurement truth", () => {
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"leaves failed-only %s bandwidth concurrency unknown",
		async (service) => {
			const { response } = await requestScalarAnalytics(service, "bandwidth", {
				snapshotRows: [nativeBandwidthRow(service, "failed", 0, null, 0, "failed")],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				peakConcurrent: null,
				timeSeries: [],
				measurement: { collection: { failedSnapshots: 1 } },
			});
		},
	);
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"retains native idle-only %s bandwidth concurrency zero after read filtering",
		async (service) => {
			const { response } = await requestScalarAnalytics(service, "bandwidth", {
				snapshotRows: [nativeBandwidthRow(service, "idle", 0, 0, 0, "idle")],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				peakConcurrent: 0,
				peakBandwidth: null,
				avgBandwidth: null,
				timeSeries: [],
				measurement: { collection: { idleSnapshots: 1 } },
			});
		},
	);
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"retains independent %s event counts, native subtotals, and raw coverage",
		async (service) => {
			const { response } = await requestScalarAnalytics(service, "most-concurrent", {
				snapshotRows: [
					forecastRow("legacy", "owned-primary", "2026-10-04T12:00:00Z", 9999, 3),
					{
						...nativeBandwidthRow(service, "partial", 2, 1.5, 1),
						capturedAt: new Date("2026-10-04T14:00:00Z"),
					},
					{
						...nativeBandwidthRow(service, "missing", 1, null, 0),
						capturedAt: new Date("2026-10-04T16:00:00Z"),
					},
					{
						...nativeBandwidthRow(service, "zero", 1, 0, 1),
						capturedAt: new Date("2026-10-04T18:00:00Z"),
					},
					nativeBandwidthRow(service, "failed", 0, null, 0, "failed"),
					nativeBandwidthRow(service, "idle", 0, 0, 0, "idle"),
					{ ...nativeBandwidthRow(service, "invalid", 99, 9999, 99), measurementJson: "invalid" },
				],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				peakConcurrent: 3,
				events: [
					{
						concurrentStreams: 3,
						totalBandwidth: null,
						knownBandwidthSubtotal: null,
						measurement: { concurrencyStatus: "legacy-unverified" },
					},
					{
						concurrentStreams: 2,
						totalBandwidth: null,
						knownBandwidthSubtotal: 1.5,
						measurement: {
							concurrencyStatus: "native",
							bandwidthStatus: "partial",
							measuredSessions: 1,
						},
					},
					{ concurrentStreams: 1, totalBandwidth: null, knownBandwidthSubtotal: null },
					{ concurrentStreams: 1, totalBandwidth: 0, knownBandwidthSubtotal: 0 },
				],
				measurement: {
					status: "partial",
					scope: "per-source-snapshot",
					observedSnapshots: 4,
					nativeSnapshots: 4,
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
		},
	);
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"keeps successful idle-only %s collection zero, not unknown",
		async (service) => {
			const { response } = await requestScalarAnalytics(service, "most-concurrent", {
				snapshotRows: [nativeBandwidthRow(service, "idle", 0, 0, 0, "idle")],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				peakConcurrent: 0,
				events: [],
				measurement: {
					status: "complete",
					nativeSnapshots: 1,
					collection: { idleSnapshots: 1 },
					configuredSources: service === "JELLYFIN" ? 2 : 1,
				},
			});
		},
	);
	it.each(["PLEX", "JELLYFIN", "EMBY"] as const)(
		"does not convert failed-only %s collection into a verified zero peak",
		async (service) => {
			const { response } = await requestScalarAnalytics(service, "most-concurrent", {
				snapshotRows: [nativeBandwidthRow(service, "failed", 0, null, 0, "failed")],
			});
			expect(response.statusCode).toBe(200);
			expect(response.json()).toMatchObject({
				peakConcurrent: null,
				events: [],
				measurement: {
					status: "unavailable",
					nativeSnapshots: 0,
					collection: { failedSnapshots: 1 },
					configuredSources: service === "JELLYFIN" ? 2 : 1,
				},
			});
		},
	);
});
