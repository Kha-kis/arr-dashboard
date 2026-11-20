import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import fastifyCookie from "@fastify/cookie";
import Database from "better-sqlite3";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import { registerOnDeckRoutes } from "../../../routes/jellyfin/on-deck-routes.js";
import { registerRecentlyAddedRoutes } from "../../../routes/jellyfin/recently-added-routes.js";
import { registerWatchEnrichmentRoutes } from "../../../routes/jellyfin/watch-enrichment-routes.js";
import { registerImageProxyRoutes } from "../../../routes/library/image-proxy-routes.js";
import { registerProviderInventoryRoutes } from "../../../routes/library/provider-inventory-routes.js";
import { registerSessionValidationHook } from "../../../server.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { SessionService } from "../../auth/session.js";
import type { JellyfinLibraryRow } from "../../jellyfin/jellyfin-evidence-repository.js";
import {
	encodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
} from "../../jellyfin/jellyfin-generation-metadata.js";
import {
	beginNativeInventoryAttempt,
	publishNativeInventoriesInTransaction,
} from "../../provider-observation/native-inventory.js";
import { withIsolatedRuntimePrismaReadClient } from "../restore-runtime-client.js";
import { type RuntimeReadTiming, withRuntimeReadTiming } from "../restore-runtime-read-timing.js";

const OWNER = "synthetic-user";
const INSTANCE = "synthetic-jellyfin";
const RADARR = "synthetic-radarr";
const SONARR = "synthetic-sonarr";
// A bounded representative fixture, not a high-cardinality timing benchmark.
const ROWS = 2_000;
const POSTERS = 55;
// Valid 2x2 JPEG, generated from a synthetic blue raster. Each delivery gets a
// fresh buffer and Response; no provider client, socket or file is involved.
const POSTER_JPEG =
	"/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABwEBAQAAAAAAAAAAAAAAAAAABQcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCOAL+Lf//Z";
type Trace = {
	routeClass: string;
	cacheRowsRead: number;
	catalogQueries: number;
	statementCalls: number;
	arrRowsRead: number;
	ownedEnabledPosterRows: number;
	arrQueries: {
		rows: number;
		startedAtMs: number;
		endedAtMs: number;
		activeBulkTransactions: number;
	}[];
	startedAtMs: number;
	endedAtMs?: number;
	runtime?: RuntimeReadTiming;
	nativeSubphases: { stage: string; outcome: string; elapsedMs: number }[];
	nativeTiming?: Record<string, unknown>;
	nativeRuntime?: RuntimeReadTiming;
	wallMs?: number;
};
const requestScope = new AsyncLocalStorage<Trace>();

afterEach(closeScopedWriteFixtures);

async function seed(f: ScopedWriteFixture) {
	const observedAt = new Date();
	await f.plain.serviceInstance.createMany({
		data: [
			{ id: RADARR, service: "RADARR" as const },
			{ id: SONARR, service: "SONARR" as const },
		].map((instance) => ({
			...instance,
			userId: OWNER,
			enabled: true,
			label: "Synthetic ARR",
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
		})),
	});
	const arrRows = Array.from({ length: ROWS }, (_, index) => ({
		id: `synthetic-arr-${String(index).padStart(6, "0")}`,
		instanceId: index < ROWS / 2 ? RADARR : SONARR,
		arrItemId: (index % (ROWS / 2)) + 1,
		itemType: index < ROWS / 2 ? ("movie" as const) : ("series" as const),
		title: "Synthetic ARR item",
		data: JSON.stringify({
			remoteIds: index < ROWS / 2 ? { tmdbId: index + 1 } : { tvdbId: index - ROWS / 2 + 1 },
		}),
	}));
	for (let start = 0; start < arrRows.length; start += 500) {
		await f.plain.libraryCache.createMany({ data: arrRows.slice(start, start + 500) });
	}
	const rows: (JellyfinLibraryRow & { mediaType: "movie" })[] = Array.from(
		{ length: ROWS },
		(_, index) => ({
			id: `synthetic-fanout-${String(index).padStart(6, "0")}`,
			instanceId: INSTANCE,
			tmdbId: index + 1,
			mediaType: "movie",
			libraryId: "movies",
			libraryName: "Synthetic movies",
			title: "Synthetic movie",
			jellyfinId: `movie-${index + 1}`,
			lastWatchedAt: observedAt,
			watchCount: 1,
			watchedByUsers: '["synthetic-viewer"]',
			onDeck: index < 50,
			userRating: null,
			collections: "[]",
			addedAt: observedAt,
			thumb: null,
			connectionGeneration: 1,
			identityGeneration: 1,
		}),
	);
	for (let start = 0; start < rows.length; start += 500) {
		await f.plain.jellyfinCache.createMany({ data: rows.slice(start, start + 500) });
	}
	await f.plain.cacheRefreshStatus.create({
		data: {
			instanceId: INSTANCE,
			cacheType: "jellyfin",
			lastRefreshedAt: observedAt,
			lastResult: "success",
			lastAttemptAt: observedAt,
			lastAttemptResult: "success",
			itemCount: ROWS,
			generationId: "synthetic-fanout-library-generation",
			connectionGeneration: 1,
			identityGeneration: 1,
			generationMetadata: encodeJellyfinLibraryGenerationMetadata({
				version: 1,
				provider: "jellyfin",
				cacheType: "jellyfin",
				publicationLevel: "authoritative",
				completeness: "complete",
				canonicalizationVersion: 1,
				itemCount: ROWS,
				connectionGeneration: 1,
				identityGeneration: 1,
				contentFingerprint: fingerprintJellyfinLibraryRows(rows),
				coverageReceipt: {
					version: 1,
					provider: "jellyfin",
					attemptStartedAt: observedAt.toISOString(),
					observedAt: observedAt.toISOString(),
					evidence: "complete",
					units: [
						{
							scopeKey: "movies",
							expectedRawCount: ROWS,
							pagesAttempted: 1,
							pagesCompleted: 1,
							rawObserved: ROWS,
							sourceBindings: ROWS,
							canonicalEntities: ROWS,
							acceptedSkips: [],
							fatalCount: 0,
						},
					],
					publishedCanonicalEntities: ROWS,
				},
			}),
		},
	});
	const instance = await f.plain.serviceInstance.findUniqueOrThrow({ where: { id: INSTANCE } });
	const attempt = await beginNativeInventoryAttempt(f.plain, {
		userId: OWNER,
		instance,
		domains: ["library", "episode"],
		now: observedAt,
	});
	if (attempt.status !== "acquired") throw new Error("Synthetic native attempt not acquired");
	const publication = await f.plain.$transaction((tx) =>
		publishNativeInventoriesInTransaction(tx, {
			userId: OWNER,
			authority: attempt.authority,
			attempt: attempt.attempt,
			now: observedAt,
			snapshots: [
				{
					domain: "library",
					scopeKeys: ["movies", "shows"],
					rows: [
						{
							nativeId: "movie-1",
							mediaType: "movie",
							libraryIds: ["movies"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Synthetic movie",
							externalIds: { tmdb: [1] },
						},
						{
							nativeId: "series-1",
							mediaType: "series",
							libraryIds: ["shows"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Synthetic series",
							externalIds: { tvdb: [1] },
						},
					],
				},
				{
					domain: "episode",
					scopeKeys: ["shows"],
					rows: [
						{
							nativeId: "episode-1",
							mediaType: "episode",
							libraryIds: ["shows"],
							parentNativeId: "series-1",
							seasonNumber: 1,
							episodeNumber: 1,
							title: "Synthetic episode",
						},
					],
				},
			],
		}),
	);
	expect(publication).toMatchObject({
		status: "published",
		itemCounts: { library: 2, episode: 1 },
	});
}

function observeRealCatalogTransactions(f: ScopedWriteFixture) {
	let sessionMetadataWrites = 0;
	const catalogTransactions = new Set<Database.Database>();
	const bulkIntervals: {
		routeClass: string;
		startedAtMs: number;
		endedAtMs?: number;
	}[] = [];
	const openBulkIntervals = new Map<Database.Database, (typeof bulkIntervals)[number]>();
	let maxCatalogTransactions = 0;
	let signalOverlap!: () => void;
	const twoCatalogTransactions = new Promise<void>((resolve) => {
		signalOverlap = resolve;
	});
	const prepare = Database.prototype.prepare;
	// Observation only: original preparation and statement invocation receive the
	// original arguments, execute synchronously and return their original result.
	vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
		this: Database.Database,
		sql,
	) {
		const statement = prepare.call(this, sql);
		if (this.name !== f.path || this === f.writer) return statement;
		const db = this;
		let boundValues: unknown[] = [];
		if (/\blibrary_cache\b/i.test(sql) && /^\s*SELECT\b/i.test(sql)) {
			const bind = statement.bind;
			Reflect.set(statement, "bind", function (this: typeof statement, ...args: unknown[]) {
				const result = Reflect.apply(bind, this, args);
				boundValues = args.flat();
				return result;
			});
		}
		for (const method of ["all", "run"] as const) {
			const invoke = statement[method];
			Reflect.set(statement, method, function (this: typeof statement, ...args: unknown[]) {
				const startedAtMs = performance.now();
				const result = Reflect.apply(invoke, this, args);
				const endedAtMs = performance.now();
				const trace = requestScope.getStore();
				const unquotedSql = sql.replace(/["`]/g, "");
				if (/^\s*UPDATE\s+(?:main\.)?sessions\s/i.test(unquotedSql)) sessionMetadataWrites++;
				if (trace) {
					trace.statementCalls++;
					if (
						/\blibrary_cache\b/i.test(sql) &&
						/^\s*SELECT\b/i.test(sql) &&
						Array.isArray(result)
					) {
						trace.arrRowsRead += result.length;
						// Observe the real compiled lookup and bound values, without
						// replacing Prisma or altering a statement's result or lifetime.
						if (
							trace.routeClass === "poster" &&
							/\bServiceInstance\b/.test(sql) &&
							["userId", "enabled", "service"].every((column) =>
								new RegExp(`\\b${column}\\s*=\\s*\\?`).test(unquotedSql),
							) &&
							[OWNER, RADARR, "RADARR", 1].every((value) => boundValues.includes(value))
						) {
							trace.ownedEnabledPosterRows += result.length;
						}
						trace.arrQueries.push({
							rows: result.length,
							startedAtMs,
							endedAtMs,
							activeBulkTransactions: catalogTransactions.size,
						});
					}
					if (
						/\bjellyfin_cache\b/i.test(sql) &&
						/^\s*SELECT\b/i.test(sql) &&
						Array.isArray(result)
					) {
						trace.catalogQueries++;
						trace.cacheRowsRead += result.length;
						if (result.length > 0 && db.inTransaction) {
							if (!catalogTransactions.has(db)) {
								const interval = { routeClass: trace.routeClass, startedAtMs };
								bulkIntervals.push(interval);
								openBulkIntervals.set(db, interval);
							}
							catalogTransactions.add(db);
							maxCatalogTransactions = Math.max(maxCatalogTransactions, catalogTransactions.size);
							if (catalogTransactions.size === 2) signalOverlap();
						}
					}
				}
				if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) {
					catalogTransactions.delete(db);
					const interval = openBulkIntervals.get(db);
					if (interval) interval.endedAtMs = endedAtMs;
					openBulkIntervals.delete(db);
				}
				return result;
			});
		}
		return statement;
	});
	return {
		get sessionMetadataWrites() {
			return sessionMetadataWrites;
		},
		twoCatalogTransactions,
		bulkIntervals,
		get maxCatalogTransactions() {
			return maxCatalogTransactions;
		},
		get activeCatalogTransactions() {
			return catalogTransactions.size;
		},
	};
}

describe("real cached-route fanout composition", { timeout: 30_000 }, () => {
	it("characterizes four populated cached GETs with two Library and one episode inventory GETs", async () => {
		const f = await createScopedWriteFixture();
		await seed(f);
		const token = "synthetic-fanout-session";
		await f.plain.session.create({
			data: {
				id: createHash("sha256").update(token).digest("hex"),
				userId: OWNER,
				expiresAt: new Date(Date.now() + 3_600_000),
			},
		});
		let onNativeSubphase: ((stage: string) => void) | undefined;
		// A queued independent request must not inherit the route's expiring ticket.
		const peerScope = new AsyncResource("synthetic-independent-cached-read");
		const logger: FastifyBaseLogger = pino(
			{ level: "info" },
			{
				write(line) {
					const record = JSON.parse(line);
					const trace = requestScope.getStore();
					if (!trace) return;
					if (record.category === "provider-inventory-read-subphase") {
						const { stage, outcome, elapsedMs } = record;
						trace.nativeSubphases.push({ stage, outcome, elapsedMs });
						onNativeSubphase?.(stage);
					}
					if (record.category === "provider-inventory-read-timing") {
						const { readAdmissionMs, repositoryMs, releaseMs, postReadMs, totalMs, outcome } =
							record;
						trace.nativeTiming = {
							readAdmissionMs,
							repositoryMs,
							releaseMs,
							postReadMs,
							totalMs,
							outcome,
						};
					}
					if (record.category === "provider-inventory-runtime-timing")
						trace.nativeRuntime = record.stages;
				},
			},
		);
		const app = Fastify({ loggerInstance: logger });
		const sessions = new SessionService(
			f.client.prisma,
			{ SESSION_COOKIE_NAME: "fixture_session" } as ApiEnv,
			app.log,
		);
		let providerIo = 0;
		let syntheticPosterDeliveries = 0;
		const deliveredPosterIds = new Set<number>();
		let observer: ReturnType<typeof observeRealCatalogTransactions> | undefined;
		const inflight: Promise<unknown>[] = [];
		const releaseHeldReads: (() => void)[] = [];
		try {
			app.decorate("prisma", f.client.prisma);
			app.decorate("restoreRuntime", f.runtime);
			app.decorate("sessionService", sessions);
			app.decorate(
				"arrClientFactory",
				new Proxy({} as FastifyInstance["arrClientFactory"], {
					get(target, property, receiver) {
						if (property === "rawRequest") {
							return async (
								instance: {
									id: string;
									userId: string;
									service: string;
									enabled: boolean;
									baseUrl: string;
								},
								path: string,
								options: unknown,
							) => {
								expect(instance).toMatchObject({
									id: RADARR,
									userId: OWNER,
									service: "RADARR",
									enabled: true,
									baseUrl: "http://synthetic.invalid",
								});
								expect(options).toEqual({ method: "GET", timeout: 5000, redirect: "error" });
								const match = /^\/MediaCover\/([1-9]\d*)\/poster\.jpg$/.exec(path);
								expect(match).not.toBeNull();
								const itemId = Number(match?.[1]);
								expect(itemId).toBeGreaterThanOrEqual(1);
								expect(itemId).toBeLessThanOrEqual(POSTERS);
								expect(deliveredPosterIds.has(itemId)).toBe(false);
								deliveredPosterIds.add(itemId);
								syntheticPosterDeliveries++;
								return new Response(Buffer.from(POSTER_JPEG, "base64"), {
									headers: { "content-type": "image/jpeg" },
								});
							};
						}
						if (typeof property === "string" && property.startsWith("create")) {
							return () => {
								providerIo++;
								throw new Error("Unexpected provider I/O in cached characterization");
							};
						}
						return Reflect.get(target, property, receiver);
					},
				}),
			);
			app.decorateRequest("currentUser", null);
			app.decorateRequest("sessionToken", null);
			await app.register(fastifyCookie, {
				secret: "synthetic-only-fanout-signing-secret",
				hook: "onRequest",
			});
			registerSessionValidationHook(app);
			app.addHook("preHandler", async (request, reply) => {
				if (!request.currentUser) return reply.status(401).send({ error: "Unauthenticated" });
			});
			app.addHook("preClose", async () => sessions.closeValidationAdmission());
			app.addHook("onClose", async () => sessions.drainValidations());
			await app.register(registerProviderInventoryRoutes);
			await app.register(registerImageProxyRoutes);
			await app.register(registerOnDeckRoutes, { prefix: "/jellyfin/on-deck" });
			await app.register(registerRecentlyAddedRoutes, { prefix: "/jellyfin/recently-added" });
			await app.register(registerWatchEnrichmentRoutes, { prefix: "/jellyfin/watch-enrichment" });
			await app.ready();
			observer = observeRealCatalogTransactions(f);
			const cookie = `fixture_session=${encodeURIComponent(app.signCookie(token))}`;
			const nativeUrl = `/library/provider-inventory?instanceId=${INSTANCE}&domain=library`;
			const episodeUrl = `/library/provider-inventory?instanceId=${INSTANCE}&domain=episode`;
			const measured = (routeClass: string, url: string) => {
				const started = performance.now();
				const trace: Trace = {
					routeClass,
					cacheRowsRead: 0,
					catalogQueries: 0,
					statementCalls: 0,
					arrRowsRead: 0,
					ownedEnabledPosterRows: 0,
					arrQueries: [],
					nativeSubphases: [],
					startedAtMs: started,
				};
				const request = requestScope
					.run(trace, () =>
						withRuntimeReadTiming(
							() =>
								f.runtime.runOperation(() =>
									app.inject({ method: "GET", url, headers: { cookie } }),
								),
							(runtime) => {
								trace.runtime = runtime;
							},
						),
					)
					.then((response) => {
						trace.endedAtMs = performance.now();
						trace.wallMs = Math.round(trace.endedAtMs - started);
						return { trace, response };
					});
				inflight.push(request);
				return request;
			};
			expect(
				(await f.runtime.runOperation(() => app.inject({ method: "GET", url: nativeUrl })))
					.statusCode,
			).toBe(401);
			const fanoutCpu = process.cpuUsage();
			const fanout = [
				measured("on-deck", "/jellyfin/on-deck"),
				measured("recently-added", "/jellyfin/recently-added?limit=20"),
				measured("watch-enrichment", "/jellyfin/watch-enrichment?tmdbIds=1&types=movie"),
				measured(
					"watch-enrichment-second-batch",
					"/jellyfin/watch-enrichment?tmdbIds=2&types=movie",
				),
			];
			const allFanout = Promise.all(fanout);
			// Notification only. No DB, evidence or pool callback is ever held.
			const overlapped = await Promise.race([
				observer.twoCatalogTransactions.then(() => true),
				allFanout.then(() => false),
			]);
			const primary = [
				measured("library-primary-one", nativeUrl),
				measured("library-primary-two", nativeUrl),
				measured("episode-primary", episodeUrl),
			];
			const [primaries, cached] = await Promise.all([Promise.all(primary), allFanout]);
			const fanoutCpuUsed = process.cpuUsage(fanoutCpu);
			const overlaps = (left: Trace, right: Trace) =>
				Math.max(left.startedAtMs, right.startedAtMs) < Math.min(left.endedAtMs!, right.endedAtMs!);
			const summary = {
				category: "synthetic-real-route-fanout-characterization",
				rowsPerPublication: ROWS,
				ownedArrCatalogRows: ROWS,
				twoRealCatalogTransactionsObserved: overlapped,
				maxCatalogTransactions: observer.maxCatalogTransactions,
				bulkIntervals: observer.bulkIntervals,
				primaries: primaries.map(({ trace, response }) => ({
					...trace,
					httpStatus: response.statusCode,
					availability: response.json().status,
					arrQueryCount: trace.arrQueries.length,
					otherPrimaryRequestsOverlapped: primaries
						.filter((other) => other.trace !== trace && overlaps(trace, other.trace))
						.map((other) => other.trace.routeClass),
					cachedRequestsOverlapped: cached
						.filter((other) => overlaps(trace, other.trace))
						.map((other) => other.trace.routeClass),
				})),
				cached: cached.map(({ trace, response }) => ({
					...trace,
					httpStatus: response.statusCode,
					availability: response.json().providerStatus?.availability ?? null,
				})),
				cpuMicroseconds: { fanoutIncludingNative: fanoutCpuUsed },
				inclusiveRuntimeSpansOverlap: true,
				providerIo,
				qaHolderAttribution: "UNKNOWN",
			};
			process.stdout.write(JSON.stringify(summary) + "\n");
			for (const result of primaries) {
				expect(result.response.statusCode).toBe(200);
				expect(result.response.json()).toMatchObject({
					status: "available",
					freshness: "current",
					complete: true,
				});
				expect(result.trace.arrRowsRead).toBe(
					result.trace.routeClass === "episode-primary" ? ROWS / 2 : ROWS,
				);
				expect(result.trace.arrQueries.length).toBeGreaterThan(0);
				expect(result.trace.nativeTiming).toMatchObject({ outcome: "available" });
				expect(
					result.trace.nativeSubphases.map(({ stage, outcome }) => ({ stage, outcome })),
				).toEqual([
					{ stage: "native-page", outcome: "returned" },
					{ stage: "arr-catalog", outcome: "returned" },
					{ stage: "native-postcheck", outcome: "returned" },
				]);
			}
			for (const result of primaries.slice(0, 2)) {
				expect(result.response.json()).toMatchObject({
					itemCount: 2,
					rows: [
						{
							nativeId: "movie-1",
							connection: { status: "matched", arrItems: [{ instanceId: RADARR, arrItemId: 1 }] },
						},
						{
							nativeId: "series-1",
							connection: { status: "matched", arrItems: [{ instanceId: SONARR, arrItemId: 1 }] },
						},
					],
				});
			}
			expect(primaries[2]!.response.json()).toMatchObject({
				itemCount: 1,
				rows: [
					{
						nativeId: "episode-1",
						parentNativeId: "series-1",
						seasonNumber: 1,
						episodeNumber: 1,
						connection: { status: "matched", arrItems: [{ instanceId: SONARR, arrItemId: 1 }] },
						watch: { state: "unknown", valueSemantics: "unknown" },
					},
				],
			});
			for (const { trace, response } of cached) {
				expect(response.statusCode).toBe(200);
				expect(response.json().providerStatus).toMatchObject({
					availability: "current",
					sources: [{ instanceId: INSTANCE, status: { evidence: "complete" } }],
				});
				expect(trace.cacheRowsRead).toBeGreaterThanOrEqual(ROWS);
			}
			expect(cached[0]!.response.json().items).toHaveLength(50);
			expect(cached[1]!.response.json().items).toHaveLength(20);
			expect(cached[2]!.response.json().items["movie:1"]).toMatchObject({
				instanceId: INSTANCE,
				watchCount: null,
				watchCountSemantics: "unknown",
				jellyfinId: "movie-1",
			});
			expect(cached[3]!.response.json().items["movie:2"]).toMatchObject({
				instanceId: INSTANCE,
				watchCount: null,
				watchCountSemantics: "unknown",
				jellyfinId: "movie-2",
			});
			// Non-overlap is a valid measured outcome, not an invented failure.
			expect(observer.maxCatalogTransactions).toBeGreaterThan(0);
			expect(observer.maxCatalogTransactions).toBeLessThanOrEqual(2);
			expect(observer.activeCatalogTransactions).toBe(0);
			expect(providerIo).toBe(0);
			expect(f.losses).toEqual([]);

			// Separate unheld measurement: keep the seven-request baseline above,
			// then launch every request below before awaiting any route completion.
			// Regression mutations: bypassing the real owned/enabled poster lookup
			// or returning failed/blank primary inventories must fail these checks.
			const burstStartedAtMs = performance.now();
			const burstCpu = process.cpuUsage();
			const burstCached = [
				measured("on-deck", "/jellyfin/on-deck"),
				measured("recently-added", "/jellyfin/recently-added?limit=20"),
				measured("watch-enrichment", "/jellyfin/watch-enrichment?tmdbIds=1&types=movie"),
				measured(
					"watch-enrichment-second-batch",
					"/jellyfin/watch-enrichment?tmdbIds=2&types=movie",
				),
			];
			const burstPrimary = [
				measured("library-primary-one", nativeUrl),
				measured("library-primary-two", nativeUrl),
				measured("episode-primary", episodeUrl),
			];
			const burstPosters = Array.from({ length: POSTERS }, (_, index) =>
				measured("poster", `/library/poster/${RADARR}/movie/${index + 1}`),
			);
			const [posterCached, posterPrimaries, posters] = await Promise.all([
				Promise.all(burstCached),
				Promise.all(burstPrimary),
				Promise.all(burstPosters),
			]);
			const burstCpuUsed = process.cpuUsage(burstCpu);
			const burstWallMs = performance.now() - burstStartedAtMs;
			const classSummary = (results: typeof posters) => ({
				count: results.length,
				statuses: results.reduce<Record<string, number>>((counts, { response }) => {
					counts[response.statusCode] = (counts[response.statusCode] ?? 0) + 1;
					return counts;
				}, {}),
				requests: results.map(({ trace, response }) => ({
					...trace,
					httpStatus: response.statusCode,
				})),
			});
			process.stdout.write(
				JSON.stringify({
					category: "synthetic-authenticated-poster-fanout-characterization",
					rowsPerPublication: ROWS,
					ownedArrCatalogRows: ROWS,
					wallMs: burstWallMs,
					cpuMicroseconds: burstCpuUsed,
					ancillary: classSummary(posterCached),
					primary: classSummary(posterPrimaries),
					posters: classSummary(posters),
					syntheticPosterDeliveries,
					providerIo,
					inclusiveRuntimeSpansOverlap: true,
					qaHolderAttribution: "UNKNOWN",
				}) + "\n",
			);
			for (const { trace, response } of posterPrimaries) {
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({
					status: "available",
					freshness: "current",
					complete: true,
				});
				expect(trace.arrRowsRead).toBe(trace.routeClass === "episode-primary" ? ROWS / 2 : ROWS);
				expect(trace.arrQueries.length).toBeGreaterThan(0);
				expect(trace.nativeTiming).toMatchObject({ outcome: "available" });
				expect(trace.nativeSubphases.map(({ stage, outcome }) => ({ stage, outcome }))).toEqual([
					{ stage: "native-page", outcome: "returned" },
					{ stage: "arr-catalog", outcome: "returned" },
					{ stage: "native-postcheck", outcome: "returned" },
				]);
			}
			for (const { response } of posterPrimaries.slice(0, 2)) {
				expect(response.json()).toMatchObject({
					itemCount: 2,
					rows: [
						{
							nativeId: "movie-1",
							connection: { status: "matched", arrItems: [{ instanceId: RADARR, arrItemId: 1 }] },
						},
						{
							nativeId: "series-1",
							connection: { status: "matched", arrItems: [{ instanceId: SONARR, arrItemId: 1 }] },
						},
					],
				});
			}
			expect(posterPrimaries[2]!.response.json()).toMatchObject({
				itemCount: 1,
				rows: [
					{
						nativeId: "episode-1",
						parentNativeId: "series-1",
						seasonNumber: 1,
						episodeNumber: 1,
						connection: { status: "matched", arrItems: [{ instanceId: SONARR, arrItemId: 1 }] },
						watch: { state: "unknown", valueSemantics: "unknown" },
					},
				],
			});
			for (const { trace, response } of posterCached) {
				expect(response.statusCode).toBe(200);
				expect(response.json().providerStatus).toMatchObject({
					availability: "current",
					sources: [{ instanceId: INSTANCE, status: { evidence: "complete" } }],
				});
				expect(trace.cacheRowsRead).toBeGreaterThanOrEqual(ROWS);
			}
			expect(posterCached[0]!.response.json().items).toHaveLength(50);
			expect(posterCached[1]!.response.json().items).toHaveLength(20);
			for (const [index, key, nativeId] of [
				[2, "movie:1", "movie-1"],
				[3, "movie:2", "movie-2"],
			] as const) {
				expect(posterCached[index]!.response.json().items[key]).toMatchObject({
					instanceId: INSTANCE,
					watchCount: null,
					watchCountSemantics: "unknown",
					jellyfinId: nativeId,
				});
			}
			for (const { trace, response } of posters) {
				expect(response.statusCode).toBe(200);
				expect(response.headers["content-type"]).toBe("image/jpeg");
				expect(response.rawPayload).toEqual(Buffer.from(POSTER_JPEG, "base64"));
				expect(trace.arrRowsRead).toBe(1);
				expect(trace.ownedEnabledPosterRows).toBe(1);
				expect(trace.runtime?.guard.count).toBeGreaterThan(0);
			}
			expect(syntheticPosterDeliveries).toBe(POSTERS);
			expect(observer.activeCatalogTransactions).toBe(0);
			expect(providerIo).toBe(0);
			expect(f.losses).toEqual([]);

			// Separate deterministic regression, NOT a measured QA workload: reserve
			// three idle callbacks so the real route must lend its finished phase's
			// fourth lane to a peer. No transaction or SQL statement is held open.
			const entered: Promise<void>[] = [];
			for (const workload of ["bulk-cache", "bulk-cache", undefined] as const) {
				let markEntered!: () => void;
				entered.push(new Promise<void>((resolve) => (markEntered = resolve)));
				const released = new Promise<void>((resolve) => releaseHeldReads.push(resolve));
				const held = f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(
						f.client.prisma,
						async () => {
							markEntered();
							await released;
						},
						{ workload },
					),
				);
				inflight.push(held);
			}
			await Promise.all(entered);
			const ordering: string[] = [];
			let peerRead: Promise<unknown> | undefined;
			onNativeSubphase = (stage) => {
				ordering.push(stage);
				if (stage !== "native-page" || peerRead) return;
				peerRead = peerScope.runInAsyncScope(() =>
					f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(f.client.prisma, async (prisma) => {
							const owner = await prisma.user.findUnique({ where: { id: OWNER } });
							expect(owner?.id).toBe(OWNER);
							ordering.push("ordinary-peer");
						}),
					),
				);
				inflight.push(peerRead);
			};
			const fairness = await measured("phase-fairness-regression", nativeUrl);
			onNativeSubphase = undefined;
			expect(fairness.response.statusCode).toBe(200);
			expect(fairness.response.json()).toMatchObject({ status: "available", complete: true });
			expect(peerRead).toBeDefined();
			await peerRead;
			expect(ordering.indexOf("ordinary-peer")).toBeGreaterThan(-1);
			expect(ordering.indexOf("ordinary-peer")).toBeLessThan(ordering.indexOf("native-postcheck"));
		} finally {
			for (const release of releaseHeldReads) release();
			await Promise.allSettled(inflight);
			await app.close();
			process.stdout.write(
				JSON.stringify({
					category: "synthetic-authenticated-fanout-session-drain",
					sessionValidationDrained: true,
					sessionMetadataWrites: observer?.sessionMetadataWrites,
					syntheticPosterDeliveries,
				}) + "\n",
			);
			peerScope.emitDestroy();
			vi.restoreAllMocks();
		}
	});
});
