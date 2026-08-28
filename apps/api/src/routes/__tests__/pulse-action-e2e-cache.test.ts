/**
 * End-to-end integration test for the cache.refresh action path.
 *
 * Companion to pulse-action-e2e.test.ts (scheduler.enable). Asserts the
 * same chain across the cache.refresh dispatcher branch:
 *   1. A stale Plex cache surfaces with a cache.refresh envelope.
 *   2. POSTing the envelope invokes the real refresh pipeline
 *      (the owned Plex refresh boundary, stubbed) and 200s.
 *   3. The per-user Pulse cache is invalidated — next GET sees fresh
 *      state (we drop the stale row from the stub to model this).
 *   4. Ownership failure (InstanceNotFoundError from the persisted instance lookup)
 *      surfaces as a 404 from the action route, matching the codebase's
 *      "don't leak existence" convention.
 *
 * Stubbing notes: refreshOwnedPlexCache is mocked because the dispatcher
 * reaches for it at module level. The Prisma
 * `cacheRefreshStatus.findMany` surface is stubbed the same way the
 * staleness collector tests do it.
 */

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Dispatcher collaborators — must be mocked before the route module imports.
const refreshOwnedPlexCache = vi.fn();
const refreshJellyfinCache = vi.fn();
const requireJellyfinClient = vi.fn();
vi.mock("../../lib/plex/plex-refresh-orchestration.js", () => ({
	refreshOwnedPlexCache: (...args: unknown[]) => refreshOwnedPlexCache(...args),
}));
// Tautulli helpers are not exercised by this file but need stubs because
// the dispatcher module imports them at top level.
vi.mock("../../lib/tautulli/tautulli-cache-refresher.js", () => ({
	refreshOwnedTautulliCache: vi.fn(),
	summarizeTautulliRefreshResultForLog: vi.fn(),
}));
vi.mock("../../lib/tautulli/tautulli-helpers.js", () => ({
	requireTautulliClient: vi.fn(),
}));
vi.mock("../../lib/jellyfin/jellyfin-cache-refresher.js", () => ({
	createOwnedJellyfinPublicationSnapshot: (_encryptor: unknown, instance: unknown) => instance,
	refreshJellyfinCache: (...args: unknown[]) => refreshJellyfinCache(...args),
}));
vi.mock("../../lib/jellyfin/jellyfin-helpers.js", () => ({
	requireJellyfinClient: (...args: unknown[]) => requireJellyfinClient(...args),
}));

// Run only the staleness collector — keeps other collectors (ARR health,
// seerr, etc.) from needing plugin decorations we don't provide.
vi.mock("../../lib/pulse/collectors.js", async () => {
	const actual = await vi.importActual<typeof import("../../lib/pulse/collectors.js")>(
		"../../lib/pulse/collectors.js",
	);
	return { pulseCollectors: [actual.collectCacheStaleness] };
});

import { registerPulseRoutes } from "../pulse.js";
import { registerTestErrorHandler } from "./test-helpers.js";

type CacheStatusRow = {
	id: string;
	instanceId: string;
	cacheType: string;
	lastRefreshedAt: Date;
	lastResult: "success" | "error";
	lastErrorMessage: string | null;
	lastAttemptAt?: Date | null;
	lastAttemptResult?: string | null;
	lastAttemptErrorMessage?: string | null;
	itemCount: number;
	generationId?: string;
	generationMetadata?: string;
	connectionGeneration?: number;
	identityGeneration?: number;
	instance: {
		id?: string;
		userId?: string;
		label: string;
		service: string;
		enabled: boolean;
		expectedIdentity?: string;
		identityKind?: string;
		identityStatus?: string;
		identityVerifiedAt?: Date;
		connectionGeneration?: number;
		identityGeneration?: number;
		updatedAt?: Date;
	};
};

const HOURS = 60 * 60 * 1000;

function makeStaleRow(overrides: Partial<CacheStatusRow> = {}): CacheStatusRow {
	return {
		id: "plex-row",
		instanceId: "inst-plex",
		cacheType: "plex",
		lastRefreshedAt: new Date(Date.now() - 13 * HOURS),
		lastResult: "success",
		lastErrorMessage: null,
		lastAttemptAt: new Date(Date.now() - 13 * HOURS),
		lastAttemptResult: "success",
		lastAttemptErrorMessage: null,
		itemCount: 0,
		generationId: "plex-generation-1",
		generationMetadata: JSON.stringify({
			version: 3,
			publicationLevel: "authoritative",
			completeness: "complete",
			itemCount: 0,
			canonicalizationVersion: 1,
			sections: [
				{
					key: "movies",
					title: "Movies",
					type: "movie",
					uuid: "movies-uuid",
					refreshing: false,
					scannedAt: 1,
					updatedAt: 1,
				},
			],
			roots: [{ sectionKey: "movies", domain: "membership", digest: "a".repeat(64) }],
		}),
		connectionGeneration: 1,
		identityGeneration: 1,
		instance: {
			id: "inst-plex",
			label: "Home Plex",
			service: "PLEX",
			enabled: true,
			expectedIdentity: "plex-machine-1",
			identityKind: "plex-machine-identifier",
			identityStatus: "VERIFIED",
			identityVerifiedAt: new Date(Date.now() - 48 * HOURS),
			connectionGeneration: 1,
			identityGeneration: 1,
			updatedAt: new Date(Date.now() - 48 * HOURS),
		},
		...overrides,
	};
}

let app: FastifyInstance;
let cacheStatuses: CacheStatusRow[];
let userCounter = 0;
const findPlexInstance = vi.fn();

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

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(async () => {
	userCounter += 1;
	refreshOwnedPlexCache.mockReset();
	refreshJellyfinCache.mockReset();
	requireJellyfinClient.mockReset();

	app = Fastify({ logger: false });
	setupAuthGate(app, `e2e-cache-user-${userCounter}`);
	// Live Prisma stub: `upsert` mutates the `cacheStatuses` array in place
	// so a subsequent `findMany` reflects the post-action state (fresh
	// lastRefreshedAt). This is what proves the dispatcher's write-through
	// genuinely lets the staleness collector drop the row on the next poll
	// — without the upsert, the row would persist indefinitely.
	app.decorate("prisma", {
		serviceInstance: {
			findFirst: findPlexInstance,
			findMany: async () =>
				cacheStatuses
					.filter((status) => status.cacheType === "plex")
					.map((status) => ({
						...status.instance,
						id: status.instanceId,
						userId: `e2e-cache-user-${userCounter}`,
					})),
		},
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
		plexCache: { count: async () => 0 },
	} as unknown as never);
	findPlexInstance.mockReset().mockImplementation(async ({ where }) => {
		const row = cacheStatuses.find(
			(status) =>
				status.instanceId === where.id &&
				status.instance.service === "PLEX" &&
				status.instance.enabled,
		);
		return row && where.userId === `e2e-cache-user-${userCounter}` && where.enabled === true
			? { ...row.instance, id: row.instanceId, userId: where.userId }
			: null;
	});
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
		refreshOwnedPlexCache.mockImplementation(async () => {
			cacheStatuses[0] = {
				...cacheStatuses[0]!,
				lastRefreshedAt: new Date(),
				lastResult: "success",
				lastErrorMessage: null,
			};
			return {
				upserted: 42,
				errors: 0,
				errorMessages: [],
				complete: true,
				completedAt: new Date(),
			};
		});

		// 1. Collector surfaces the item with an action envelope.
		const first = await injectGet("/pulse");
		const firstBody = JSON.parse(first.payload);
		const staleItem = firstBody.items.find((i: { id: string }) => i.id === "cache-stale-plex-row");
		expect(staleItem.action).toEqual({
			kind: "cache.refresh",
			target: { instanceId: "inst-plex", cacheType: "plex" },
			label: "Refresh now",
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
		expect(findPlexInstance).toHaveBeenCalledWith({
			where: { id: "inst-plex", userId: `e2e-cache-user-${userCounter}`, enabled: true },
		});

		// Flush microtasks + give the refresh mock (synchronously resolved)
		// a tick to run its continuation + upsert the fresh lastRefreshedAt
		// into our stubbed cacheStatuses. In production this is what takes
		// time; in the test it's essentially instant — but we still have
		// to yield the event loop.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(refreshOwnedPlexCache).toHaveBeenCalledWith({
			prisma: app.prisma,
			encryptor: app.encryptor,
			instance: expect.objectContaining({ id: "inst-plex", service: "PLEX" }),
			log: expect.anything(),
		});

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

	it("clears a warning cached while the Jellyfin retry is still running (#663)", async () => {
		cacheStatuses = [
			makeStaleRow({
				id: "jellyfin-row",
				instanceId: "inst-jellyfin",
				cacheType: "jellyfin",
				lastResult: "error",
				lastErrorMessage: "fetch failed",
				instance: { label: "Home Jellyfin", service: "JELLYFIN", enabled: true },
			}),
		];
		requireJellyfinClient.mockResolvedValue({
			client: { id: "jellyfin-client" },
			instance: {
				service: "JELLYFIN",
				baseUrl: "https://jellyfin.example.com",
				encryptedApiKey: "encrypted-key",
				encryptionIv: "key-iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				connectionGeneration: 7,
			},
		});
		const refreshGate = deferred<{
			upserted: number;
			errors: number;
			errorMessages: string[];
			complete: boolean;
			completedAt: Date;
		}>();
		refreshJellyfinCache.mockReturnValue(refreshGate.promise);

		const first = await injectGet("/pulse");
		const failedItem = JSON.parse(first.payload).items.find(
			(i: { id: string }) => i.id === "cache-error-jellyfin-row",
		);
		expect(failedItem).toMatchObject({
			title: "Home Jellyfin: Jellyfin cache refresh failed",
			action: {
				kind: "cache.refresh",
				target: { instanceId: "inst-jellyfin", cacheType: "jellyfin" },
				label: "Retry refresh",
				destructive: false,
			},
		});

		const actionRes = await injectPost(
			`/pulse/${encodeURIComponent(failedItem.id)}/action`,
			failedItem.action,
		);
		expect(actionRes.statusCode).toBe(200);
		expect(requireJellyfinClient).toHaveBeenCalledTimes(1);
		expect(requireJellyfinClient.mock.calls[0]?.slice(1)).toEqual([
			`e2e-cache-user-${userCounter}`,
			"inst-jellyfin",
		]);
		expect(refreshJellyfinCache).toHaveBeenCalledTimes(1);

		// The route returns before a populated cache refresh completes. This
		// immediate GET legitimately sees and re-caches the old warning.
		const whilePending = await injectGet("/pulse");
		expect(
			JSON.parse(whilePending.payload).items.some(
				(item: { id: string }) => item.id === "cache-error-jellyfin-row",
			),
		).toBe(true);

		cacheStatuses[0] = {
			...cacheStatuses[0]!,
			lastRefreshedAt: new Date(),
			lastResult: "success",
			lastErrorMessage: null,
		};
		refreshGate.resolve({
			upserted: 12,
			errors: 0,
			errorMessages: [],
			complete: true,
			completedAt: new Date(),
		});
		await refreshGate.promise;
		await new Promise((resolve) => setTimeout(resolve, 0));

		// Completion invalidation must evict the warning cached above.
		const afterCompletion = await injectGet("/pulse");
		const cacheWarnings = JSON.parse(afterCompletion.payload).items.filter((item: { id: string }) =>
			item.id.endsWith("jellyfin-row"),
		);
		expect(cacheWarnings).toEqual([]);
	});

	it("ownership failure returns 404 (InstanceNotFoundError convention)", async () => {
		cacheStatuses = [makeStaleRow()];
		findPlexInstance.mockResolvedValueOnce(null);

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
		expect(refreshOwnedPlexCache).not.toHaveBeenCalled();
	});
});
