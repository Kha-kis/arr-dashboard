/**
 * Integration tests for cache.refresh action emission on GET /pulse.
 *
 * Mirrors the structure of pulse-scheduler-health.test.ts: run the real
 * `collectCacheStaleness` against a stubbed Prisma surface and assert the
 * emission gate for each cacheType × status combination.
 *
 * The emission rule under test:
 *   emit action iff
 *     status.cacheType is refreshable, with stale successes offering
 *     "Refresh now" and failed/degraded attempts offering "Retry refresh".
 */

import type { ProviderObservationStatus } from "@arr/shared";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evidenceMocks = vi.hoisted(() => ({
	loadUserGenerationObservations: vi.fn(),
	getPublishedEpisodeGenerationObservation: vi.fn(),
	readOwnedTautulliObservation: vi.fn(),
	readOwnedJellyfinCacheHealthSources: vi.fn(),
}));

vi.mock("../../lib/plex/plex-evidence-repository.js", () => ({
	loadUserGenerationObservations: evidenceMocks.loadUserGenerationObservations,
	getPublishedEpisodeGenerationObservation: evidenceMocks.getPublishedEpisodeGenerationObservation,
}));
vi.mock("../../lib/tautulli/tautulli-observation-repository.js", () => ({
	readOwnedTautulliObservation: evidenceMocks.readOwnedTautulliObservation,
}));
vi.mock("../../lib/jellyfin/jellyfin-cache-health.js", () => ({
	DEFAULT_JELLYFIN_CACHE_HEALTH_MAX_AGE_MS: 12 * 60 * 60 * 1000,
	readOwnedJellyfinCacheHealthSources: evidenceMocks.readOwnedJellyfinCacheHealthSources,
}));

vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectCacheStaleness] };
});

import { registerPulseRoutes } from "../pulse.js";
import { createInjectAuthenticated, setupAuthInjection } from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let cacheStatuses: CacheStatusRow[];
let findCacheStatuses: ReturnType<typeof vi.fn>;
let findTautulliInstances: ReturnType<typeof vi.fn>;
let findJellyfinInstances: ReturnType<typeof vi.fn>;
let userCounter = 0;

type CacheStatusRow = {
	id: string;
	instanceId: string;
	cacheType: string;
	lastRefreshedAt: Date;
	lastResult: "success" | "error" | "partial";
	lastErrorMessage: string | null;
	lastAttemptAt?: Date | null;
	lastAttemptResult?: string | null;
	lastAttemptErrorMessage?: string | null;
	itemCount: number;
	generationId?: string | null;
	generationMetadata?: string | null;
	instance: { label: string; service: string; enabled: boolean };
};

const HOURS = 60 * 60 * 1000;

function makeRow(overrides: Partial<CacheStatusRow> = {}): CacheStatusRow {
	return {
		id: "row-1",
		instanceId: "inst-1",
		cacheType: "plex",
		lastRefreshedAt: new Date(Date.now() - 24 * HOURS), // stale
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 0,
		generationId: "generation-1",
		generationMetadata: JSON.stringify({ sections: [] }),
		instance: { label: "Home Plex", service: "PLEX", enabled: true },
		...overrides,
	};
}

type HealthStatus = {
	availability: "current" | "partial" | "last-known" | "unavailable";
	evidence: "complete" | "partial" | "positive-only" | "unknown";
	observedAt: string | null;
	ageSeconds: number | null;
	latestAttempt: "idle" | "running" | "failed" | "successful";
	reasonCodes: string[];
	domains?: ProviderObservationStatus["domains"];
};

type TautulliObservationStatus = {
	availability: "current" | "partial" | "last-known" | "unavailable";
	evidence: "complete" | "partial" | "positive-only" | "unknown";
	observedAt: string | null;
	ageSeconds: number | null;
	latestAttempt: "idle" | "running" | "failed" | "successful";
	reasonCodes: string[];
};

function makeTautulliObservation({
	instanceId = "inst-taut",
	availability = "partial",
	evidence = "positive-only",
	observedAt = "2026-09-01T00:00:00.000Z",
	ageSeconds = 3600,
	latestAttempt = "successful",
	reasonCodes = ["positive-only", "coverage-incomplete"],
	rowCount = 2,
}: {
	instanceId?: string;
	availability?: TautulliObservationStatus["availability"];
	evidence?: TautulliObservationStatus["evidence"];
	observedAt?: string | null;
	ageSeconds?: number | null;
	latestAttempt?: TautulliObservationStatus["latestAttempt"];
	reasonCodes?: string[];
	rowCount?: number;
} = {}) {
	return {
		instanceId,
		metadata: null,
		rows: Array.from({ length: rowCount }, (_, index) => ({
			id: `taut-row-${index}`,
			watchCount: 1,
		})),
		providerStatus: {
			availability,
			evidence,
			observedAt,
			ageSeconds,
			latestAttempt,
			reasonCodes,
		} satisfies TautulliObservationStatus,
	};
}

function makeHealthSource({
	instanceId = "inst-jellyfin",
	instanceName = "Home Jellyfin",
	service = "JELLYFIN",
	cacheType = "jellyfin",
	status: statusOverrides = {},
}: {
	instanceId?: string;
	instanceName?: string;
	service?: "JELLYFIN" | "EMBY";
	cacheType?: "jellyfin" | "jellyfin_episode" | "emby" | "emby_episode";
	status?: Partial<HealthStatus>;
} = {}) {
	const episode = cacheType.endsWith("_episode");
	const status: HealthStatus = {
		availability: "last-known",
		evidence: "complete",
		observedAt: "2026-09-01T00:00:00.000Z",
		ageSeconds: 3600,
		latestAttempt: "failed",
		reasonCodes: ["refresh-failed"],
		...statusOverrides,
	};
	const lastResult =
		status.availability === "current" && status.evidence === "complete"
			? "success"
			: status.availability === "unavailable"
				? status.latestAttempt === "running"
					? "in_progress"
					: "error"
				: status.latestAttempt === "running"
					? "in_progress"
					: status.reasonCodes.includes("refresh-failed")
						? "error"
						: "partial";
	const sourceCacheType = episode ? "jellyfin_episode" : "jellyfin";
	const sourceService = service === "EMBY" ? "emby" : "jellyfin";
	return {
		fallbackObservedAt: "2026-08-30T00:00:00.000Z",
		item: {
			instanceId,
			instanceName,
			cacheType,
			lastRefreshedAt: status.observedAt,
			lastResult,
			lastErrorMessage: null,
			itemCount: status.evidence === "complete" ? 4 : null,
			isStale: status.reasonCodes.includes("publication-stale"),
			providerStatus: {
				availability: status.availability,
				sources: [
					{
						instanceId,
						service: sourceService,
						cacheType: sourceCacheType,
						status,
					},
				],
			},
		},
	};
}

beforeEach(async () => {
	userCounter += 1;
	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-cache-${userCounter}`, username: "admin" });
	findCacheStatuses = vi.fn(async ({ where }: { where?: { cacheType?: { notIn?: string[] } } }) =>
		cacheStatuses.filter(
			(row) => row.instance.enabled && !(where?.cacheType?.notIn ?? []).includes(row.cacheType),
		),
	);
	findTautulliInstances = vi.fn().mockResolvedValue([]);
	findJellyfinInstances = vi.fn().mockResolvedValue([]);
	evidenceMocks.loadUserGenerationObservations.mockImplementation(async () =>
		cacheStatuses
			.filter((row) => row.cacheType === "plex")
			.map((row) => ({
				available: true,
				instanceId: row.instanceId,
				evidence: {
					publicationLevel: "authoritative",
					completeness: "complete",
					reasonCodes: [],
				},
			})),
	);
	evidenceMocks.getPublishedEpisodeGenerationObservation.mockImplementation(
		async (_prisma, input) => ({
			available: true,
			instanceId: input.instanceId,
			evidence: {
				publicationLevel: "authoritative",
				completeness: "complete",
				reasonCodes: [],
			},
		}),
	);
	evidenceMocks.readOwnedTautulliObservation.mockResolvedValue(null);
	evidenceMocks.readOwnedJellyfinCacheHealthSources.mockReset().mockResolvedValue([]);
	app.decorate("prisma", {
		cacheRefreshStatus: {
			findMany: findCacheStatuses,
		},
		serviceInstance: {
			findMany: (args: { where?: { service?: unknown } }) => {
				if (args.where?.service === "TAUTULLI") {
					return (findTautulliInstances as unknown as (input: unknown) => unknown)(args);
				}
				return (findJellyfinInstances as unknown as (input: unknown) => unknown)(args);
			},
		},
	} as unknown as never);
	await app.register(registerPulseRoutes);
	await app.ready();
	injectAuthenticated = createInjectAuthenticated(app);
});

afterEach(async () => {
	await app?.close();
});

describe("GET /pulse — cache.refresh action emission", () => {
	it("uses the owned Jellyfin health boundary and excludes raw Jellyfin status rows", async () => {
		cacheStatuses = [
			makeRow({
				id: "raw-jellyfin-status",
				cacheType: "jellyfin",
				instance: { label: "Raw Jellyfin", service: "JELLYFIN", enabled: true },
			}),
		];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "owned-jellyfin",
				label: "Owned Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-09-01T00:00:00.000Z"),
			},
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);

		expect(findCacheStatuses).toHaveBeenCalledWith({
			where: {
				instance: { userId: `user-cache-${userCounter}`, enabled: true },
				cacheType: { notIn: ["jellyfin", "jellyfin_episode", "tautulli"] },
			},
			include: { instance: { select: { label: true, service: true } } },
		});
		expect(findJellyfinInstances).toHaveBeenCalledWith({
			where: {
				userId: `user-cache-${userCounter}`,
				enabled: true,
				service: { in: ["JELLYFIN", "EMBY"] },
			},
			select: { id: true, label: true, service: true, createdAt: true },
		});
		expect(evidenceMocks.readOwnedJellyfinCacheHealthSources).toHaveBeenCalledTimes(1);
		expect(body.items.some((item: { id: string }) => item.id.includes("raw-jellyfin-status"))).toBe(
			false,
		);
	});

	it("emits collection progress when the latest attempt is running despite current data", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				status: {
					availability: "current",
					evidence: "complete",
					latestAttempt: "running",
					reasonCodes: [],
				},
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		expect(body.items.filter((item: { source: string }) => item.source === "jellyfin")).toEqual([
			expect.objectContaining({
				severity: "info",
				actionLabel: "View status",
				detail: "Cache collection is in progress.",
			}),
		]);
	});

	it("keeps stale complete evidence visible without implying it can be refreshed safely", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				status: {
					availability: "last-known",
					reasonCodes: ["publication-stale"],
					latestAttempt: "successful",
				},
			}),
			makeHealthSource({
				cacheType: "jellyfin_episode",
				status: {
					availability: "last-known",
					reasonCodes: ["publication-stale"],
					latestAttempt: "successful",
				},
			}),
		]);

		const first = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const second = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const library = first.items.find(
			(item: { id: string }) => item.id === "cache-jellyfin-error-inst-jellyfin-jellyfin",
		);
		const episode = first.items.find(
			(item: { id: string }) => item.id === "cache-jellyfin-error-inst-jellyfin-jellyfin_episode",
		);

		expect(library).toMatchObject({
			severity: "warning",
			title: "Home Jellyfin: Jellyfin cache evidence is unavailable",
			timestamp: "2026-09-01T00:00:00.000Z",
		});
		expect(library.action).toBeUndefined();
		expect(episode).toMatchObject({
			severity: "warning",
			title: "Home Jellyfin: Jellyfin episodes cache evidence is unavailable",
		});
		expect(episode.action).toBeUndefined();
		expect(second.items.find((item: { id: string }) => item.id === library.id)).toMatchObject({
			timestamp: library.timestamp,
		});
	});

	it("projects active running evidence as informational without an action", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				status: {
					availability: "last-known",
					latestAttempt: "running",
					reasonCodes: ["refresh-running"],
				},
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find((candidate: { id: string }) =>
			candidate.id.includes("refreshing"),
		);
		expect(item).toMatchObject({
			id: "cache-jellyfin-refreshing-inst-jellyfin-jellyfin",
			severity: "info",
			title: "Home Jellyfin: Jellyfin cache refresh is in progress",
			detail: "Cache collection is in progress.",
		});
		expect(item.action).toBeUndefined();
	});

	it("keeps a first refresh without a publication informational and actionless", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				status: {
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "running",
					reasonCodes: ["no-publication"],
				},
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { id: string }) =>
				candidate.id === "cache-jellyfin-refreshing-inst-jellyfin-jellyfin",
		);
		expect(item).toMatchObject({
			severity: "info",
			title: "Home Jellyfin: Jellyfin cache refresh is in progress",
			detail: "Cache collection is in progress.",
			timestamp: "2026-08-30T00:00:00.000Z",
		});
		expect(item.action).toBeUndefined();
	});

	it("projects failed evidence with separate durable retry actions", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({ status: { reasonCodes: ["refresh-failed"], latestAttempt: "failed" } }),
			makeHealthSource({
				cacheType: "jellyfin_episode",
				status: { reasonCodes: ["refresh-failed"], latestAttempt: "failed" },
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const items = body.items.filter((item: { source: string }) => item.source === "jellyfin");
		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			id: "cache-jellyfin-error-inst-jellyfin-jellyfin",
			title: "Home Jellyfin: Jellyfin cache refresh failed",
			action: {
				target: { instanceId: "inst-jellyfin", cacheType: "jellyfin" },
				label: "Retry refresh",
			},
		});
		expect(JSON.stringify(items[0])).not.toContain("fetch failed");
		expect(items[1].action).toMatchObject({
			target: { instanceId: "inst-jellyfin", cacheType: "jellyfin_episode" },
			label: "Retry refresh",
		});
	});

	it.each([
		["partial", "coverage-incomplete"],
		["positive-only", "positive-only"],
		["legacy unknown", "receipt-invalid"],
		["superseded", "publication-superseded"],
	] as const)(
		"keeps %s evidence non-retryable unless a refresh actually failed",
		async (_name, reasonCode) => {
			cacheStatuses = [];
			findJellyfinInstances.mockResolvedValueOnce([
				{
					id: "inst-jellyfin",
					label: "Home Jellyfin",
					service: "JELLYFIN",
					createdAt: new Date("2026-08-30T00:00:00.000Z"),
				},
			]);
			evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
				makeHealthSource({
					status: {
						availability: reasonCode === "receipt-invalid" ? "last-known" : "partial",
						evidence:
							reasonCode === "positive-only"
								? "positive-only"
								: reasonCode === "receipt-invalid" || reasonCode === "publication-superseded"
									? "unknown"
									: "partial",
						latestAttempt: "idle",
						reasonCodes: [reasonCode],
					},
				}),
			]);

			const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
			const item = body.items.find(
				(candidate: { source: string }) => candidate.source === "jellyfin",
			);
			expect(item).toBeDefined();
			expect(item.action).toBeUndefined();
			expect(JSON.stringify(item)).not.toContain(reasonCode);
		},
	);

	it("keeps accepted Jellyfin mapping gaps informational without a refresh retry", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				status: {
					availability: "partial",
					evidence: "partial",
					latestAttempt: "successful",
					reasonCodes: ["accepted-skips", "coverage-incomplete"],
					domains: [
						{
							domain: "library-inventory",
							availability: "current",
							evidence: "complete",
							valueSemantics: "exact",
							observedAt: "2026-09-07T00:00:00.000Z",
							reasonCodes: [],
						},
					],
				},
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { source: string }) => candidate.source === "jellyfin",
		);
		expect(item).toMatchObject({
			title: "Home Jellyfin: Jellyfin cache has informational coverage gaps",
			actionUrl: "/settings",
			actionLabel: "View status",
		});
		expect(item.action).toBeUndefined();
		expect(JSON.stringify(item)).not.toContain("accepted-skips");
	});

	it("keeps an active no-publication Jellyfin episode collection visible without a retry", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				cacheType: "jellyfin_episode",
				status: {
					availability: "unavailable",
					evidence: "unknown",
					latestAttempt: "running",
					reasonCodes: ["no-publication", "refresh-running"],
				},
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find((candidate: { id: string }) =>
			candidate.id.includes("cache-jellyfin-refreshing-inst-jellyfin-jellyfin_episode"),
		);
		expect(item).toMatchObject({
			severity: "info",
			title: "Home Jellyfin: Jellyfin episodes cache refresh is in progress",
			detail: "Cache collection is in progress.",
		});
		expect(item.action).toBeUndefined();
	});

	it("maps an Emby episode retry to the Jellyfin durable episode action", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-emby",
				label: "Home Emby",
				service: "EMBY",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				instanceId: "inst-emby",
				instanceName: "Home Emby",
				service: "EMBY",
				cacheType: "emby_episode",
				status: { latestAttempt: "failed", reasonCodes: ["refresh-failed"] },
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find((candidate: { source: string }) => candidate.source === "emby");
		expect(item).toMatchObject({
			action: {
				kind: "cache.refresh",
				target: { instanceId: "inst-emby", cacheType: "jellyfin_episode" },
				label: "Retry refresh",
			},
		});
	});

	it("keeps unavailable idle evidence in Settings without fabricating a retry", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				status: {
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "idle",
					reasonCodes: ["unknown-failure"],
				},
			}),
			makeHealthSource({
				cacheType: "jellyfin_episode",
				status: {
					availability: "unavailable",
					evidence: "unknown",
					observedAt: null,
					ageSeconds: null,
					latestAttempt: "idle",
					reasonCodes: ["unknown-failure"],
				},
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const items = body.items.filter((item: { source: string }) => item.source === "jellyfin");
		expect(items[0]).toMatchObject({
			id: "cache-jellyfin-error-inst-jellyfin-jellyfin",
			title: "Home Jellyfin: Jellyfin cache evidence is unavailable",
			timestamp: "2026-08-30T00:00:00.000Z",
		});
		expect(items[0].action).toBeUndefined();
		expect(items[1].action).toBeUndefined();
	});

	it("passes two owned instances once to the helper with one observation time and max age", async () => {
		cacheStatuses = [];
		const instances = [
			{
				id: "jellyfin-b",
				label: "Jellyfin B",
				service: "JELLYFIN" as const,
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
			{
				id: "emby-a",
				label: "Emby A",
				service: "EMBY" as const,
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		];
		findJellyfinInstances.mockResolvedValueOnce(instances);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([]);

		await injectAuthenticated("GET", "/pulse");
		expect(evidenceMocks.readOwnedJellyfinCacheHealthSources).toHaveBeenCalledTimes(1);
		const call = evidenceMocks.readOwnedJellyfinCacheHealthSources.mock.calls[0]![0];
		expect(call).toMatchObject({
			prisma: app.prisma,
			userId: `user-cache-${userCounter}`,
			instances,
			maxAgeMs: 12 * 60 * 60 * 1000,
			now: expect.any(Date),
		});
	});
	it("emits a cache.refresh action on a stale Plex cache row", async () => {
		cacheStatuses = [makeRow({ id: "plex-row", cacheType: "plex", instanceId: "inst-plex" })];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "cache-stale-plex-row");

		expect(item).toBeDefined();
		expect(item.action).toEqual({
			kind: "cache.refresh",
			target: { instanceId: "inst-plex", cacheType: "plex" },
			label: "Refresh now",
			destructive: false,
		});
	});

	it("surfaces a newer failed attempt as retryable instead of unqualified success", async () => {
		const failedAt = new Date();
		cacheStatuses = [
			makeRow({
				id: "degraded-row",
				lastRefreshedAt: new Date(Date.now() - HOURS),
				lastErrorMessage: "Plex pagination was incomplete",
				lastAttemptAt: failedAt,
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "Plex pagination was incomplete",
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((candidate: { id: string }) =>
			candidate.id.includes("degraded-row"),
		);

		expect(item).toMatchObject({
			id: "cache-error-degraded-row",
			title: "Home Plex: Plex cache refresh failed",
			action: { target: { instanceId: "inst-1", cacheType: "plex" }, label: "Retry refresh" },
		});
		expect(JSON.stringify(item)).not.toContain("Plex pagination was incomplete");
	});

	it("does not let an older failed attempt hide a newer current Plex publication", async () => {
		cacheStatuses = [
			makeRow({
				id: "older-failed-attempt",
				lastRefreshedAt: new Date(),
				lastAttemptAt: new Date(Date.now() - HOURS),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "old provider failure",
			}),
		];

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		expect(
			body.items.some((candidate: { id: string }) => candidate.id.includes("older-failed-attempt")),
		).toBe(false);
	});

	it.each(["missing_metadata", "unknown_metadata_version", "row_count_mismatch"] as const)(
		"reports successful-looking Plex status as unavailable for %s",
		async (reasonCode) => {
			cacheStatuses = [makeRow({ id: `invalid-${reasonCode}`, lastRefreshedAt: new Date() })];
			evidenceMocks.loadUserGenerationObservations.mockResolvedValueOnce([
				{
					available: false,
					instanceId: "inst-1",
					evidence: {
						publicationLevel: "unavailable",
						completeness: "unknown",
						reasonCodes: [reasonCode],
					},
				},
			]);

			const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
			const item = body.items.find((candidate: { id: string }) =>
				candidate.id.includes(`invalid-${reasonCode}`),
			);

			expect(item).toMatchObject({
				severity: "warning",
				title: "Home Plex: Plex cache evidence is unavailable",
			});
			expect(item.detail).toBe("Cache evidence is unavailable.");
			expect(item.action).toBeUndefined();
		},
	);

	it("keeps future positive-only Plex evidence informational", async () => {
		cacheStatuses = [makeRow({ id: "positive-only", lastRefreshedAt: new Date() })];
		evidenceMocks.loadUserGenerationObservations.mockResolvedValueOnce([
			{
				available: true,
				instanceId: "inst-1",
				evidence: {
					publicationLevel: "positive-only",
					completeness: "partial",
					reasonCodes: [],
				},
			},
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find((candidate: { id: string }) =>
			candidate.id.includes("positive-only"),
		);

		expect(item).toMatchObject({
			id: "cache-partial-positive-only",
			title: "Home Plex: Plex cache has informational coverage gaps",
		});
		expect(item.action).toBeUndefined();
	});

	it("keeps positive-only coverage informational without exposing internal diagnostics", async () => {
		cacheStatuses = [
			makeRow({
				id: "positive-diagnostic",
				itemCount: 7,
				lastRefreshedAt: new Date(),
				generationMetadata: JSON.stringify({
					version: 4,
					publicationLevel: "positive-only",
					completeness: "partial",
					itemCount: 7,
					canonicalizationVersion: 1,
					sections: [
						{
							key: "shows",
							uuid: "shows-uuid",
							title: "Shows",
							type: "show",
							refreshing: false,
							scannedAt: 1,
							updatedAt: 1,
						},
					],
					observedRoots: [
						{ sectionKey: "shows", domain: "episode-parents", digest: "a".repeat(64) },
					],
					capabilities: [
						{
							domain: "episode-parents",
							field: "membership",
							semantics: "observed-targets-only",
							operators: [],
						},
					],
					targetLedgerVersion: 1,
					targetCount: 1,
					targetDigest: "b".repeat(64),
					partialReasons: [
						{ code: "currentItemsWithoutTmdbMetadata", count: 2 },
						{ code: "onDeckFetchFailures", count: 1 },
					],
				}),
			}),
		];
		evidenceMocks.loadUserGenerationObservations.mockResolvedValueOnce([
			{
				available: true,
				instanceId: "inst-1",
				metadata: {
					version: 4,
					publicationLevel: "positive-only",
					completeness: "partial",
					partialReasons: [
						{ code: "currentItemsWithoutTmdbMetadata", count: 2 },
						{ code: "onDeckFetchFailures", count: 1 },
					],
				},
				evidence: {
					publicationLevel: "positive-only",
					completeness: "partial",
					reasonCodes: [],
				},
			},
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find((candidate: { id: string }) =>
			candidate.id.includes("positive-diagnostic"),
		);

		expect(item).toMatchObject({
			id: "cache-partial-positive-diagnostic",
			detail: "Current mapped data remains available; some provider coverage is bounded.",
		});
		expect(JSON.stringify(item)).not.toMatch(/itemCount:|partialReasons:|onDeckFetchFailures/i);
	});

	it("keeps positive-only episode coverage informational without internal diagnostics", async () => {
		cacheStatuses = [
			makeRow({
				id: "positive-episode-diagnostic",
				cacheType: "plex_episode",
				itemCount: 1,
				lastRefreshedAt: new Date(),
				generationMetadata: JSON.stringify({
					version: 3,
					publicationLevel: "positive-only",
					completeness: "partial",
					itemCount: 1,
					canonicalizationVersion: 1,
					capability: {
						domain: "episodes",
						field: "watchCount",
						semantics: "lower-bound",
						operator: "greater_than",
					},
					parentPlexGenerationId: "parent-v4",
					parentMetadataVersion: 4,
					parentPublicationLevel: "positive-only",
					parentTargetDigest: "a".repeat(64),
					episodeDigest: "b".repeat(64),
					partialReasons: [{ code: "currentItemsWithoutTmdbMetadata", count: 1 }],
					connectionGeneration: 1,
					identityGeneration: 1,
				}),
			}),
		];
		evidenceMocks.getPublishedEpisodeGenerationObservation.mockResolvedValueOnce({
			available: true,
			instanceId: "inst-1",
			evidence: {
				publicationLevel: "positive-only",
				completeness: "partial",
				reasonCodes: ["latest_attempt_partial"],
			},
		});

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find((candidate: { id: string }) =>
			candidate.id.includes("positive-episode-diagnostic"),
		);

		expect(item).toMatchObject({
			id: "cache-partial-positive-episode-diagnostic",
			detail: "Current mapped data remains available; some provider coverage is bounded.",
		});
		expect(JSON.stringify(item)).not.toMatch(/itemCount:|partialReasons:/i);
	});

	it("reports an opaque active Plex attempt as refreshing without exposing its token", async () => {
		const token = "in_progress:do-not-expose";
		cacheStatuses = [
			makeRow({
				id: "refreshing",
				lastRefreshedAt: new Date(),
				lastAttemptAt: new Date(),
				lastAttemptResult: token,
			}),
		];
		evidenceMocks.loadUserGenerationObservations.mockResolvedValueOnce([
			{
				available: true,
				instanceId: "inst-1",
				evidence: {
					availability: "last-known",
					authority: "unavailable",
					attemptState: "in_progress",
					publicationLevel: "unavailable",
					completeness: "unknown",
					reasonCodes: ["latest_attempt_in_progress"],
				},
			},
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find((candidate: { id: string }) =>
			candidate.id.includes("refreshing"),
		);

		expect(item).toMatchObject({
			id: "cache-refreshing-refreshing",
			severity: "info",
			title: "Home Plex: Plex cache refresh is in progress",
		});
		expect(item.detail).toContain("Current Plex values are unavailable");
		expect(JSON.stringify(item)).not.toContain(token);
	});

	it("does not let an older Plex in-progress marker hide a newer current publication", async () => {
		const publishedAt = new Date();
		cacheStatuses = [
			makeRow({
				id: "older-in-progress",
				lastRefreshedAt: publishedAt,
				lastAttemptAt: new Date(publishedAt.getTime() - 1),
				lastAttemptResult: "in_progress",
			}),
		];

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);

		expect(body.items).toEqual([]);
	});

	it("excludes Tautulli from raw status rows and reads each owned instance once", async () => {
		cacheStatuses = [makeRow({ id: "taut-row", cacheType: "tautulli", instanceId: "inst-taut" })];
		findTautulliInstances.mockResolvedValueOnce([
			{ id: "inst-taut", label: "Home Tautulli", createdAt: new Date("2026-08-28T12:00:00.000Z") },
		]);
		evidenceMocks.readOwnedTautulliObservation.mockResolvedValueOnce(makeTautulliObservation());

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { source: string }) => candidate.source === "tautulli",
		);

		expect(findCacheStatuses).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					cacheType: { notIn: expect.arrayContaining(["tautulli"]) },
				}),
			}),
		);
		expect(evidenceMocks.readOwnedTautulliObservation).toHaveBeenCalledWith(app.prisma, {
			userId: `user-cache-${userCounter}`,
			instanceId: "inst-taut",
		});
		expect(evidenceMocks.readOwnedTautulliObservation).toHaveBeenCalledOnce();
		expect(item).toMatchObject({
			id: "cache-tautulli-partial-inst-taut",
			severity: "info",
			title: "Home Tautulli: Tautulli observed coverage is partial",
			detail:
				"2 media items with observed recent positive activity are available; coverage is incomplete.",
			source: "tautulli",
		});
		expect(item.action).toBeUndefined();
	});

	it("describes one canonical media item rather than its watch events", async () => {
		cacheStatuses = [];
		findTautulliInstances.mockResolvedValueOnce([
			{ id: "inst-taut", label: "Home Tautulli", createdAt: new Date("2026-08-28T12:00:00.000Z") },
		]);
		const observation = makeTautulliObservation({ rowCount: 1 });
		observation.rows[0] = { id: "taut-row-one", watchCount: 3 };
		evidenceMocks.readOwnedTautulliObservation.mockResolvedValueOnce(observation);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { source: string }) => candidate.source === "tautulli",
		);

		expect(item).toMatchObject({
			detail:
				"1 media item with observed recent positive activity is available; coverage is incomplete.",
		});
		expect(item.detail).not.toContain("event");
		expect(item.detail).not.toContain("watch count");
	});

	it("projects last-known and running Tautulli observations without actions", async () => {
		cacheStatuses = [];
		findTautulliInstances.mockResolvedValueOnce([
			{ id: "inst-taut", label: "Home Tautulli", createdAt: new Date("2026-08-28T12:00:00.000Z") },
			{
				id: "inst-taut-2",
				label: "Second Tautulli",
				createdAt: new Date("2026-08-28T12:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedTautulliObservation
			.mockResolvedValueOnce(
				makeTautulliObservation({
					availability: "last-known",
					latestAttempt: "failed",
					rowCount: 1,
					reasonCodes: ["positive-only", "coverage-incomplete", "refresh-failed"],
				}),
			)
			.mockResolvedValueOnce(
				makeTautulliObservation({
					instanceId: "inst-taut-2",
					availability: "unavailable",
					evidence: "unknown",
					latestAttempt: "running",
					observedAt: null,
					ageSeconds: null,
					rowCount: 1,
					reasonCodes: ["no-publication", "refresh-running"],
				}),
			);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const items = body.items.filter(
			(candidate: { source: string }) => candidate.source === "tautulli",
		);

		expect(items).toHaveLength(2);
		expect(items[0]).toMatchObject({
			id: "cache-tautulli-error-inst-taut",
			severity: "warning",
			title: "Home Tautulli: observation refresh failed",
			detail: "Observation refresh did not complete.",
			action: { target: { cacheType: "tautulli" }, label: "Retry refresh" },
		});
		expect(items[1]).toMatchObject({
			id: "cache-tautulli-refreshing-inst-taut-2",
			severity: "info",
			title: "Second Tautulli: observation refresh is in progress",
			detail:
				"1 media item with observed recent positive activity remains available while the latest refresh is in progress.",
		});
		expect(items[1].action).toBeUndefined();
	});

	it("routes Tautulli identity uncertainty to Settings verification without a dispatcher mutation", async () => {
		cacheStatuses = [];
		findTautulliInstances.mockResolvedValueOnce([
			{ id: "inst-taut", label: "Home Tautulli", createdAt: new Date("2026-08-28T12:00:00.000Z") },
		]);
		evidenceMocks.readOwnedTautulliObservation.mockResolvedValueOnce(
			makeTautulliObservation({
				availability: "partial",
				latestAttempt: "successful",
				reasonCodes: ["identity-unverified", "positive-only"],
			}),
		);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { source: string }) => candidate.source === "tautulli",
		);
		expect(item).toMatchObject({
			title: "Home Tautulli: identity needs verification",
			actionUrl: "/settings",
			actionLabel: "Verify identity",
		});
		expect(item.action).toBeUndefined();
	});

	it("uses singular remaining grammar for one running observation", async () => {
		cacheStatuses = [];
		findTautulliInstances.mockResolvedValueOnce([
			{ id: "inst-taut", label: "Home Tautulli", createdAt: new Date("2026-08-28T12:00:00.000Z") },
		]);
		evidenceMocks.readOwnedTautulliObservation.mockResolvedValueOnce(
			makeTautulliObservation({
				availability: "partial",
				latestAttempt: "running",
				rowCount: 1,
				reasonCodes: ["positive-only", "coverage-incomplete", "refresh-running"],
			}),
		);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { source: string }) => candidate.source === "tautulli",
		);

		expect(item.detail).toBe(
			"1 media item with observed recent positive activity remains available while the latest refresh is in progress.",
		);
	});

	it("reports no publication for an enabled owned Tautulli instance without a status row", async () => {
		cacheStatuses = [];
		findTautulliInstances.mockResolvedValueOnce([
			{
				id: "inst-taut-missing",
				label: "Home Tautulli",
				createdAt: new Date("2026-08-28T12:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedTautulliObservation.mockResolvedValueOnce(
			makeTautulliObservation({
				instanceId: "inst-taut-missing",
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				ageSeconds: null,
				rowCount: 0,
				reasonCodes: ["no-publication"],
			}),
		);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { id: string }) =>
				candidate.id === "cache-tautulli-unavailable-inst-taut-missing",
		);

		expect(findTautulliInstances).toHaveBeenCalledWith({
			where: { userId: expect.any(String), enabled: true, service: "TAUTULLI" },
			select: { id: true, label: true, createdAt: true },
		});
		expect(item).toMatchObject({
			severity: "warning",
			title: "Home Tautulli: observations are unavailable",
			detail: "Tautulli observations are unavailable (no-publication).",
			source: "tautulli",
		});
		expect(item.action).toBeUndefined();
	});

	it("fails closed for an unexpected Tautulli status and does not leak raw fields", async () => {
		cacheStatuses = [];
		findTautulliInstances.mockResolvedValueOnce([
			{ id: "inst-taut", label: "Home Tautulli", createdAt: new Date("2026-08-28T12:00:00.000Z") },
		]);
		evidenceMocks.readOwnedTautulliObservation.mockResolvedValueOnce({
			...makeTautulliObservation({ rowCount: 1 }),
			providerStatus: {
				availability: "mystery",
				evidence: "positive-only",
				observedAt: "2026-09-01T00:00:00.000Z",
				ageSeconds: 3600,
				latestAttempt: "successful",
				reasonCodes: ["positive-only"],
				metadata: "receipt-secret",
				attemptToken: "in_progress:secret",
			},
		} as never);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { source: string }) => candidate.source === "tautulli",
		);
		expect(item).toMatchObject({
			severity: "warning",
			title: "Home Tautulli: observations are unavailable",
			detail: "Tautulli observations are unavailable (unknown-failure).",
		});
		expect(item.action).toBeUndefined();
		expect(JSON.stringify(item)).not.toContain("receipt-secret");
		expect(JSON.stringify(item)).not.toContain("secret");
	});

	it("does not suppress independent Plex and Jellyfin items when Tautulli is unavailable", async () => {
		cacheStatuses = [makeRow({ id: "plex-row", cacheType: "plex", instanceId: "inst-plex" })];
		findTautulliInstances.mockResolvedValueOnce([
			{ id: "inst-taut", label: "Home Tautulli", createdAt: new Date("2026-08-28T12:00:00.000Z") },
		]);
		findJellyfinInstances.mockResolvedValueOnce([
			{ id: "inst-jellyfin", label: "Home Jellyfin", service: "JELLYFIN", createdAt: new Date() },
		]);
		evidenceMocks.readOwnedTautulliObservation.mockResolvedValueOnce(
			makeTautulliObservation({
				availability: "unavailable",
				evidence: "unknown",
				observedAt: null,
				rowCount: 0,
				reasonCodes: ["provider-unavailable"],
			}),
		);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				status: {
					availability: "unavailable",
					evidence: "unknown",
					reasonCodes: ["provider-unavailable"],
				},
			}),
		]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		expect(body.items.some((candidate: { source: string }) => candidate.source === "plex")).toBe(
			true,
		);
		expect(
			body.items.some((candidate: { source: string }) => candidate.source === "jellyfin"),
		).toBe(true);
		expect(
			body.items.some((candidate: { source: string }) => candidate.source === "tautulli"),
		).toBe(true);
	});

	it("emits a durable retry action for stale Plex episode evidence", async () => {
		cacheStatuses = [
			makeRow({
				id: "episode-row",
				cacheType: "plex_episode",
				instanceId: "inst-plex",
				generationMetadata: JSON.stringify({
					version: 1,
					parentPlexGenerationId: "parent-1",
					parentPublicationLevel: "authoritative",
					connectionGeneration: 1,
					identityGeneration: 1,
				}),
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "cache-stale-episode-row");

		expect(item).toBeDefined();
		expect(item.action).toMatchObject({
			target: { instanceId: "inst-plex", cacheType: "plex_episode" },
			label: "Refresh now",
		});
	});

	it("reports a successful-looking episode status as unavailable when its parent is unavailable", async () => {
		cacheStatuses = [
			makeRow({
				id: "episode-parent-unavailable",
				cacheType: "plex_episode",
				lastRefreshedAt: new Date(),
			}),
		];
		evidenceMocks.getPublishedEpisodeGenerationObservation.mockResolvedValueOnce({
			available: false,
			instanceId: "inst-1",
			evidence: {
				publicationLevel: "unavailable",
				completeness: "unknown",
				reasonCodes: ["parent_generation_unavailable"],
			},
		});

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find((candidate: { id: string }) =>
			candidate.id.includes("episode-parent-unavailable"),
		);

		expect(item).toMatchObject({
			title: "Home Plex: Plex episodes cache evidence is unavailable",
		});
		expect(item.detail).toBe("Cache evidence is unavailable.");
		expect(item.action).toBeUndefined();
		expect(JSON.stringify(item)).not.toContain("parent_generation_unavailable");
	});

	it("keeps missing Plex evidence in Settings without a retry", async () => {
		cacheStatuses = [makeRow({ id: "missing-plex-evidence", lastRefreshedAt: new Date() })];
		evidenceMocks.loadUserGenerationObservations.mockResolvedValueOnce([]);

		const body = JSON.parse((await injectAuthenticated("GET", "/pulse")).payload);
		const item = body.items.find(
			(candidate: { id: string }) => candidate.id === "cache-unavailable-missing-plex-evidence",
		);

		expect(item).toMatchObject({
			title: "Home Plex: Plex cache evidence is unavailable",
			actionLabel: "Check settings",
		});
		expect(item.action).toBeUndefined();
	});

	it("emits a retry action on a cache-error row when the cache type is supported", async () => {
		cacheStatuses = [
			makeRow({
				id: "error-row",
				cacheType: "plex",
				lastResult: "error",
				lastErrorMessage: "ECONNREFUSED",
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "cache-error-error-row");

		expect(item).toBeDefined();
		expect(item.action).toEqual({
			kind: "cache.refresh",
			target: { instanceId: "inst-1", cacheType: "plex" },
			label: "Retry refresh",
			destructive: false,
		});
	});

	it("renders a failed Jellyfin cache with correct branding and a retry action (#663)", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-jellyfin",
				label: "Home Jellyfin",
				service: "JELLYFIN",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource(),
			makeHealthSource({ cacheType: "jellyfin_episode" }),
		]);

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find(
			(candidate: { id: string }) => candidate.id === "cache-jellyfin-error-inst-jellyfin-jellyfin",
		);

		expect(item).toMatchObject({
			title: "Home Jellyfin: Jellyfin cache refresh failed",
			source: "jellyfin",
			action: {
				kind: "cache.refresh",
				target: { instanceId: "inst-jellyfin", cacheType: "jellyfin" },
				label: "Retry refresh",
				destructive: false,
			},
		});
	});

	it("uses Emby branding for an Emby instance backed by the shared cache", async () => {
		cacheStatuses = [];
		findJellyfinInstances.mockResolvedValueOnce([
			{
				id: "inst-emby",
				label: "Home Emby",
				service: "EMBY",
				createdAt: new Date("2026-08-30T00:00:00.000Z"),
			},
		]);
		evidenceMocks.readOwnedJellyfinCacheHealthSources.mockResolvedValueOnce([
			makeHealthSource({
				instanceId: "inst-emby",
				instanceName: "Home Emby",
				service: "EMBY",
				cacheType: "emby",
			}),
		]);

		const res = await injectAuthenticated("GET", "/pulse");
		const item = JSON.parse(res.payload).items.find(
			(candidate: { id: string }) => candidate.id === "cache-emby-error-inst-emby-emby",
		);

		expect(item).toMatchObject({
			title: "Home Emby: Emby cache refresh failed",
			source: "emby",
			action: {
				target: { instanceId: "inst-emby", cacheType: "jellyfin" },
			},
		});
	});

	it("does not surface persisted cache rows for disabled instances", async () => {
		cacheStatuses = [
			makeRow({
				id: "disabled-jellyfin",
				cacheType: "jellyfin",
				lastResult: "error",
				lastErrorMessage: "fetch failed",
				instance: {
					label: "Disabled Jellyfin",
					service: "JELLYFIN",
					enabled: false,
				},
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		expect(JSON.parse(res.payload).items).toEqual([]);
		expect(findCacheStatuses).toHaveBeenCalledWith({
			where: {
				instance: { userId: `user-cache-${userCounter}`, enabled: true },
				cacheType: { notIn: ["jellyfin", "jellyfin_episode", "tautulli"] },
			},
			include: { instance: { select: { label: true, service: true } } },
		});
	});

	it("keeps a bounded Plex episode capacity result informational", async () => {
		cacheStatuses = [
			makeRow({
				id: "episode-capacity",
				cacheType: "plex_episode",
				lastResult: "partial",
				lastRefreshedAt: new Date(),
				lastErrorMessage:
					"Capacity degraded: 201 watched shows exceed the 200-show/24-hour freshness capacity.",
				generationMetadata: JSON.stringify({
					version: 1,
					parentPlexGenerationId: "parent-1",
					parentPublicationLevel: "authoritative",
					connectionGeneration: 1,
					identityGeneration: 1,
				}),
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find(
			(candidate: { id: string }) => candidate.id === "cache-partial-episode-capacity",
		);

		expect(item).toMatchObject({
			severity: "info",
			title: "Home Plex: Plex episodes cache has informational coverage gaps",
		});
		expect(item.detail).toBe(
			"Current mapped data remains available; some provider coverage is bounded.",
		);
		expect(item.action).toBeUndefined();
	});

	it("does not emit any item for a fresh cache row", async () => {
		cacheStatuses = [
			makeRow({
				id: "fresh-row",
				lastRefreshedAt: new Date(Date.now() - 1 * HOURS), // well under the 12h threshold
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const cacheItems = body.items.filter((i: { id: string }) => i.id.startsWith("cache-"));

		expect(cacheItems).toEqual([]);
	});
});
