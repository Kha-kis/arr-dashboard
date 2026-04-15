/**
 * End-to-end integration test for the cache.refresh action path.
 *
 * Companion to pulse-action-e2e.test.ts (scheduler.enable). Asserts the
 * same chain across the cache.refresh dispatcher branch:
 *   1. A stale Plex cache surfaces with a cache.refresh envelope.
 *   2. POSTing the envelope invokes the real refresh pipeline
 *      (requirePlexClient + refreshPlexCache, both stubbed) and 200s.
 *   3. The per-user Pulse cache is invalidated — next GET sees fresh
 *      state (we drop the stale row from the stub to model this).
 *   4. Ownership failure (InstanceNotFoundError from requirePlexClient)
 *      surfaces as a 404 from the action route, matching the codebase's
 *      "don't leak existence" convention.
 *
 * Stubbing notes: requirePlexClient / refreshPlexCache are mocked
 * because the dispatcher reaches for them at module level. The Prisma
 * `cacheRefreshStatus.findMany` surface is stubbed the same way the
 * staleness collector tests do it.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dispatcher collaborators — must be mocked before the route module imports.
const refreshPlexCache = vi.fn();
const requirePlexClient = vi.fn();
vi.mock("../../lib/plex/plex-cache-refresher.js", () => ({
	refreshPlexCache: (...args: unknown[]) => refreshPlexCache(...args),
}));
vi.mock("../../lib/plex/plex-helpers.js", () => ({
	requirePlexClient: (...args: unknown[]) => requirePlexClient(...args),
}));
// Tautulli helpers are not exercised by this file but need stubs because
// the dispatcher module imports them at top level.
vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshTautulliCache: vi.fn(),
}));
vi.mock("../../lib/tautulli/tautulli-helpers.js", () => ({
	requireTautulliClient: vi.fn(),
}));

// Run only the staleness collector — keeps other collectors (ARR health,
// seerr, etc.) from needing plugin decorations we don't provide.
vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectCacheStaleness] };
});

import { InstanceNotFoundError } from "../../lib/errors.js";
import { registerPulseRoutes } from "../pulse.js";
import { registerTestErrorHandler } from "./test-helpers.js";

type CacheStatusRow = {
	id: string;
	instanceId: string;
	cacheType: string;
	lastRefreshedAt: Date;
	lastResult: "success" | "error";
	lastErrorMessage: string | null;
	itemCount: number;
	instance: { label: string };
};

const HOURS = 60 * 60 * 1000;

function makeStaleRow(overrides: Partial<CacheStatusRow> = {}): CacheStatusRow {
	return {
		id: "plex-row",
		instanceId: "inst-plex",
		cacheType: "plex",
		lastRefreshedAt: new Date(Date.now() - 24 * HOURS),
		lastResult: "success",
		lastErrorMessage: null,
		itemCount: 0,
		instance: { label: "Home Plex" },
		...overrides,
	};
}

let app: FastifyInstance;
let cacheStatuses: CacheStatusRow[];
let userCounter = 0;

const AUTH_HEADER = "x-test-auth";

function setupAuthGate(app: FastifyInstance, userId: string) {
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (req: any) => {
		if (req.headers[AUTH_HEADER]) {
			req.currentUser = { id: userId, username: "admin" };
			req.sessionToken = "mock-session-token";
		}
	});
}

async function injectGet(url: string) {
	return app.inject({ method: "GET", url, headers: { [AUTH_HEADER]: "1" } });
}

async function injectPost(url: string, body: unknown) {
	return app.inject({
		method: "POST",
		url,
		headers: { [AUTH_HEADER]: "1", "content-type": "application/json" },
		payload: JSON.stringify(body),
	});
}

beforeEach(async () => {
	userCounter += 1;
	refreshPlexCache.mockReset();
	requirePlexClient.mockReset();

	app = Fastify({ logger: false });
	setupAuthGate(app, `e2e-cache-user-${userCounter}`);
	// Live Prisma stub: `upsert` mutates the `cacheStatuses` array in place
	// so a subsequent `findMany` reflects the post-action state (fresh
	// lastRefreshedAt). This is what proves the dispatcher's write-through
	// genuinely lets the staleness collector drop the row on the next poll
	// — without the upsert, the row would persist indefinitely.
	app.decorate("prisma", {
		cacheRefreshStatus: {
			findMany: async () => cacheStatuses,
			upsert: async (args: {
				where: { instanceId_cacheType: { instanceId: string; cacheType: string } };
				create: CacheStatusRow;
				update: Partial<CacheStatusRow>;
			}) => {
				const { instanceId, cacheType } = args.where.instanceId_cacheType;
				const idx = cacheStatuses.findIndex(
					(s) => s.instanceId === instanceId && s.cacheType === cacheType,
				);
				if (idx >= 0) {
					cacheStatuses[idx] = {
						...cacheStatuses[idx]!,
						...args.update,
					};
				} else {
					cacheStatuses.push(args.create);
				}
				return cacheStatuses[idx >= 0 ? idx : cacheStatuses.length - 1]!;
			},
		},
	} as unknown as never);
	registerTestErrorHandler(app);
	await app.register(registerPulseRoutes);
	await app.ready();
});

afterEach(async () => {
	await app?.close();
});

describe("Pulse actionability — cache.refresh end-to-end", () => {
	it("stale Plex cache → action item → POST 200 → cache invalidation drops the row on next poll", async () => {
		cacheStatuses = [makeStaleRow()];
		requirePlexClient.mockResolvedValue({ client: { id: "plex-client" }, instance: {} });
		refreshPlexCache.mockResolvedValue({ upserted: 42, errors: 0, errorMessages: [] });

		// 1. Collector surfaces the item with an action envelope.
		const first = await injectGet("/pulse");
		const firstBody = JSON.parse(first.payload);
		const staleItem = firstBody.items.find((i: { id: string }) => i.id === "cache-stale-plex-row");
		expect(staleItem.action).toEqual({
			kind: "cache.refresh",
			target: { instanceId: "inst-plex", cacheType: "plex" },
			label: "Refresh now",
			confirmLabel: "Click again to refresh",
			destructive: false,
		});

		// 2. POST the envelope verbatim.
		const actionRes = await injectPost(
			`/pulse/${encodeURIComponent(staleItem.id)}/action`,
			staleItem.action,
		);
		expect(actionRes.statusCode).toBe(200);
		// Wire shape (post fire-and-forget fix): only `status`. The route
		// returns before the refresh completes so we don't know the upsert
		// count yet — `detail` is intentionally absent.
		expect(JSON.parse(actionRes.payload)).toEqual({ status: "ok" });
		expect(requirePlexClient).toHaveBeenCalledWith(
			expect.any(Object), // app
			`e2e-cache-user-${userCounter}`,
			"inst-plex",
		);

		// Flush microtasks + give the refresh mock (synchronously resolved)
		// a tick to run its continuation + upsert the fresh lastRefreshedAt
		// into our stubbed cacheStatuses. In production this is what takes
		// time; in the test it's essentially instant — but we still have
		// to yield the event loop.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(refreshPlexCache).toHaveBeenCalledTimes(1);

		// 3. After the background task ran, the upsert callback has mutated
		//    cacheStatuses[0].lastRefreshedAt to `now`. The collector should
		//    read the fresh timestamp and not emit the stale row.
		const second = await injectGet("/pulse");
		const secondBody = JSON.parse(second.payload);
		const stillStale = secondBody.items.find(
			(i: { id: string }) => i.id === "cache-stale-plex-row",
		);
		expect(stillStale).toBeUndefined();
	});

	it("ownership failure returns 404 (InstanceNotFoundError convention)", async () => {
		cacheStatuses = [makeStaleRow()];
		requirePlexClient.mockRejectedValue(new InstanceNotFoundError("inst-plex"));

		const listing = await injectGet("/pulse");
		const staleItem = JSON.parse(listing.payload).items.find(
			(i: { id: string }) => i.id === "cache-stale-plex-row",
		);

		const actionRes = await injectPost(
			`/pulse/${encodeURIComponent(staleItem.id)}/action`,
			staleItem.action,
		);
		expect(actionRes.statusCode).toBe(404);
		expect(JSON.parse(actionRes.payload).error).toBe("InstanceNotFoundError");
		expect(refreshPlexCache).not.toHaveBeenCalled();
	});
});
