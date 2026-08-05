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

import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
		instance: { label: "Home Plex", service: "PLEX", enabled: true },
		...overrides,
	};
}

beforeEach(async () => {
	userCounter += 1;
	app = Fastify({ logger: false });
	setupAuthInjection(app, { id: `user-cache-${userCounter}`, username: "admin" });
	findCacheStatuses = vi.fn(async () => cacheStatuses.filter((row) => row.instance.enabled));
	app.decorate("prisma", {
		cacheRefreshStatus: {
			findMany: findCacheStatuses,
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

	it("shows a newer failed attempt as degraded instead of unqualified success", async () => {
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
			id: "cache-partial-degraded-row",
			title: "Home Plex: Plex cache coverage is degraded",
			detail: "Plex pagination was incomplete",
		});
	});

	it("emits a cache.refresh action on a stale Tautulli cache row", async () => {
		cacheStatuses = [makeRow({ id: "taut-row", cacheType: "tautulli", instanceId: "inst-taut" })];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "cache-stale-taut-row");

		expect(item.action?.kind).toBe("cache.refresh");
		expect(item.action?.target).toEqual({ instanceId: "inst-taut", cacheType: "tautulli" });
	});

	it("does NOT emit an action for unsupported cacheType (plex_episode)", async () => {
		// plex_episode exists in the data model but the dispatcher does not
		// support it. The row still renders (so the operator sees the
		// problem) but without a button they can't usefully click.
		cacheStatuses = [
			makeRow({ id: "episode-row", cacheType: "plex_episode", instanceId: "inst-plex" }),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "cache-stale-episode-row");

		expect(item).toBeDefined();
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
		cacheStatuses = [
			makeRow({
				id: "jellyfin-error",
				instanceId: "inst-jellyfin",
				cacheType: "jellyfin",
				lastResult: "error",
				lastErrorMessage: "fetch failed",
				instance: { label: "Home Jellyfin", service: "JELLYFIN", enabled: true },
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find(
			(candidate: { id: string }) => candidate.id === "cache-error-jellyfin-error",
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
		cacheStatuses = [
			makeRow({
				id: "emby-error",
				instanceId: "inst-emby",
				cacheType: "jellyfin",
				lastResult: "error",
				lastErrorMessage: "fetch failed",
				instance: { label: "Home Emby", service: "EMBY", enabled: true },
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const item = JSON.parse(res.payload).items.find(
			(candidate: { id: string }) => candidate.id === "cache-error-emby-error",
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
			where: { instance: { userId: `user-cache-${userCounter}`, enabled: true } },
			include: { instance: { select: { label: true, service: true } } },
		});
	});

	it("surfaces a first-class partial Plex episode capacity result", async () => {
		cacheStatuses = [
			makeRow({
				id: "episode-capacity",
				cacheType: "plex_episode",
				lastResult: "partial",
				lastRefreshedAt: new Date(),
				lastErrorMessage:
					"Capacity degraded: 201 watched shows exceed the 200-show/24-hour freshness capacity.",
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find(
			(candidate: { id: string }) => candidate.id === "cache-partial-episode-capacity",
		);

		expect(item).toMatchObject({
			severity: "warning",
			title: "Home Plex: Plex episodes cache coverage is degraded",
		});
		expect(item.detail).toContain("200-show/24-hour freshness capacity");
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
