/**
 * Integration tests for cache.refresh action emission on GET /pulse.
 *
 * Mirrors the structure of pulse-scheduler-health.test.ts: run the real
 * `collectCacheStaleness` against a stubbed Prisma surface and assert the
 * emission gate for each cacheType × status combination.
 *
 * The emission rule under test:
 *   emit action iff
 *     status.lastResult !== "error"
 *     AND status.lastRefreshedAt < now - STALE_CACHE_HOURS
 *     AND status.cacheType ∈ {"plex", "jellyfin"}
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
import {
	createInjectAuthenticated,
	makePulseDismissalStub,
	setupAuthInjection,
} from "./test-helpers.js";

let app: ReturnType<typeof Fastify>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;
let cacheStatuses: CacheStatusRow[];
let userCounter = 0;

type CacheStatusRow = {
	id: string;
	instanceId: string;
	cacheType: string;
	lastRefreshedAt: Date;
	lastResult: "success" | "error";
	lastErrorMessage: string | null;
	lastAttemptAt?: Date | null;
	lastAttemptResult?: "success" | "error" | "partial" | null;
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
	app.decorate("prisma", {
		pulseDismissal: makePulseDismissalStub(),
		cacheRefreshStatus: {
			findMany: async () => cacheStatuses,
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

	it("renders a lingering pre-3.0 tautulli cache row WITHOUT an action (ADR-0007)", async () => {
		// Tautulli was removed in 3.0; CacheRefreshStatus rows with
		// cacheType "tautulli" can linger until the migration dialog deletes
		// their instances. They must still render (operator visibility) but
		// must NOT carry a refresh button the dispatcher can no longer honor.
		cacheStatuses = [makeRow({ id: "taut-row", cacheType: "tautulli", instanceId: "inst-taut" })];

		const res = await injectAuthenticated("GET", "/pulse");
		const body = JSON.parse(res.payload);
		const item = body.items.find((i: { id: string }) => i.id === "cache-stale-taut-row");

		expect(item).toBeDefined();
		expect(item.action).toBeUndefined();
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

	it("emits a retry action for a failed Plex refresh", async () => {
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

	it("surfaces a newer failed attempt without replacing the last successful freshness", async () => {
		cacheStatuses = [
			makeRow({
				id: "newer-failure",
				lastRefreshedAt: new Date(Date.now() - HOURS),
				lastAttemptAt: new Date(),
				lastAttemptResult: "error",
				lastAttemptErrorMessage: "Plex history timed out",
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const item = JSON.parse(res.payload).items.find(
			(candidate: { id: string }) => candidate.id === "cache-partial-newer-failure",
		);

		expect(item).toMatchObject({
			detail: "Plex history timed out",
			action: { label: "Retry refresh" },
		});
	});

	it("uses the Emby label and source for the shared Jellyfin cache", async () => {
		cacheStatuses = [
			makeRow({
				id: "emby-failure",
				instanceId: "inst-emby",
				cacheType: "jellyfin",
				lastResult: "error",
				lastErrorMessage: "fetch failed",
				instance: { label: "Home Emby", service: "EMBY", enabled: true },
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		const item = JSON.parse(res.payload).items.find(
			(candidate: { id: string }) => candidate.id === "cache-error-emby-failure",
		);

		expect(item).toMatchObject({
			title: "Home Emby: Emby cache refresh failed",
			source: "emby",
			action: { target: { instanceId: "inst-emby", cacheType: "jellyfin" } },
		});
	});

	it("does not surface a disabled instance cache row", async () => {
		cacheStatuses = [
			makeRow({
				id: "disabled-row",
				instance: { label: "Disabled Plex", service: "PLEX", enabled: false },
			}),
		];

		const res = await injectAuthenticated("GET", "/pulse");
		expect(JSON.parse(res.payload).items).toEqual([]);
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
