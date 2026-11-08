import { AsyncLocalStorage } from "node:async_hooks";
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
import { type RuntimeReadTiming, withRuntimeReadTiming } from "../restore-runtime-read-timing.js";

const OWNER = "synthetic-user";
const INSTANCE = "synthetic-jellyfin";
// A bounded representative fixture, not a high-cardinality timing benchmark.
const ROWS = 2_000;
type Trace = {
	routeClass: string;
	cacheRowsRead: number;
	catalogQueries: number;
	statementCalls: number;
	runtime?: RuntimeReadTiming;
	nativeTiming?: Record<string, unknown>;
	nativeRuntime?: RuntimeReadTiming;
	wallMs?: number;
};
const requestScope = new AsyncLocalStorage<Trace>();

afterEach(closeScopedWriteFixtures);

async function seed(f: ScopedWriteFixture) {
	const observedAt = new Date();
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
		domains: ["library"],
		now: observedAt,
	});
	if (attempt.status !== "acquired") throw new Error("Synthetic native attempt not acquired");
	await f.plain.$transaction((tx) =>
		publishNativeInventoriesInTransaction(tx, {
			userId: OWNER,
			authority: attempt.authority,
			attempt: attempt.attempt,
			now: observedAt,
			snapshots: [
				{
					domain: "library",
					scopeKeys: ["movies"],
					rows: [
						{
							nativeId: "movie-1",
							mediaType: "movie",
							libraryIds: ["movies"],
							parentNativeId: null,
							seasonNumber: null,
							episodeNumber: null,
							title: "Synthetic movie",
						},
					],
				},
			],
		}),
	);
}

function observeRealCatalogTransactions(f: ScopedWriteFixture) {
	const catalogTransactions = new Set<Database.Database>();
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
		for (const method of ["all", "run"] as const) {
			const invoke = statement[method];
			Reflect.set(statement, method, function (this: typeof statement, ...args: unknown[]) {
				const result = Reflect.apply(invoke, this, args);
				const trace = requestScope.getStore();
				if (trace) {
					trace.statementCalls++;
					if (
						/\bjellyfin_cache\b/i.test(sql) &&
						/^\s*SELECT\b/i.test(sql) &&
						Array.isArray(result)
					) {
						trace.catalogQueries++;
						trace.cacheRowsRead += result.length;
						if (result.length > 0 && db.inTransaction) {
							catalogTransactions.add(db);
							maxCatalogTransactions = Math.max(maxCatalogTransactions, catalogTransactions.size);
							if (catalogTransactions.size === 2) signalOverlap();
						}
					}
				}
				if (/^\s*(?:COMMIT|ROLLBACK)\s*;?\s*$/i.test(sql)) catalogTransactions.delete(db);
				return result;
			});
		}
		return statement;
	});
	return {
		twoCatalogTransactions,
		get maxCatalogTransactions() {
			return maxCatalogTransactions;
		},
		get activeCatalogTransactions() {
			return catalogTransactions.size;
		},
	};
}

describe("real cached-route fanout composition", { timeout: 30_000 }, () => {
	it("characterizes four populated cached GETs competing with authenticated native inventory", async () => {
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
		const logger: FastifyBaseLogger = pino(
			{ level: "info" },
			{
				write(line) {
					const record = JSON.parse(line);
					const trace = requestScope.getStore();
					if (!trace) return;
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
		const inflight: Promise<unknown>[] = [];
		try {
			app.decorate("prisma", f.client.prisma);
			app.decorate("restoreRuntime", f.runtime);
			app.decorate("sessionService", sessions);
			app.decorate(
				"arrClientFactory",
				new Proxy({} as FastifyInstance["arrClientFactory"], {
					get(target, property, receiver) {
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
			await app.register(registerOnDeckRoutes, { prefix: "/jellyfin/on-deck" });
			await app.register(registerRecentlyAddedRoutes, { prefix: "/jellyfin/recently-added" });
			await app.register(registerWatchEnrichmentRoutes, { prefix: "/jellyfin/watch-enrichment" });
			await app.ready();
			const observer = observeRealCatalogTransactions(f);
			const cookie = `fixture_session=${encodeURIComponent(app.signCookie(token))}`;
			const nativeUrl = `/library/provider-inventory?instanceId=${INSTANCE}&domain=library`;
			const measured = (routeClass: string, url: string) => {
				const trace: Trace = { routeClass, cacheRowsRead: 0, catalogQueries: 0, statementCalls: 0 };
				const started = performance.now();
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
						trace.wallMs = Math.round(performance.now() - started);
						return { trace, response };
					});
				inflight.push(request);
				return request;
			};
			expect(
				(await f.runtime.runOperation(() => app.inject({ method: "GET", url: nativeUrl })))
					.statusCode,
			).toBe(401);
			const baselineCpu = process.cpuUsage();
			const baseline = await measured("bare-native", nativeUrl);
			const baselineCpuUsed = process.cpuUsage(baselineCpu);
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
			const composed = await measured("composed-native", nativeUrl);
			const cached = await allFanout;
			const fanoutCpuUsed = process.cpuUsage(fanoutCpu);
			const summary = {
				category: "synthetic-real-route-fanout-characterization",
				rowsPerPublication: ROWS,
				twoRealCatalogTransactionsObserved: overlapped,
				maxCatalogTransactions: observer.maxCatalogTransactions,
				baseline: baseline.trace,
				composed: composed.trace,
				cached: cached.map(({ trace, response }) => ({
					...trace,
					httpStatus: response.statusCode,
					availability: response.json().providerStatus?.availability ?? null,
				})),
				cpuMicroseconds: { baseline: baselineCpuUsed, fanoutIncludingNative: fanoutCpuUsed },
				inclusiveRuntimeSpansOverlap: true,
				providerIo,
				qaHolderAttribution: "UNKNOWN",
			};
			process.stdout.write(JSON.stringify(summary) + "\n");
			for (const result of [baseline, composed]) {
				expect(result.response.statusCode).toBe(200);
				expect(result.response.json()).toMatchObject({
					status: "available",
					itemCount: 1,
					complete: true,
					rows: [{ nativeId: "movie-1" }],
				});
			}
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
		} finally {
			await Promise.allSettled(inflight);
			await app.close();
			vi.restoreAllMocks();
		}
	});
});
