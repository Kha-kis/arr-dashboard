import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fastifyCookie from "@fastify/cookie";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../../../config/env.js";
import { registerOnDeckRoutes } from "../../../routes/plex/on-deck-routes.js";
import { registerRecentlyAddedRoutes } from "../../../routes/plex/recently-added-routes.js";
import { registerSessionValidationHook } from "../../../server.js";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { SessionService } from "../../auth/session.js";
import { PlexAuthorityService } from "../../plex/plex-authority-service.js";
import { createPlexSelectionProjection } from "../../plex/plex-canonical-projection.js";
import { encodeAuthoritativePlexGenerationMetadata } from "../../plex/plex-generation-metadata.js";
import { createPlexTargetLedgerBinding } from "../../plex/plex-generation-target-ledger.js";
import {
	withIsolatedRuntimePrismaBulkReadClient,
	withIsolatedRuntimePrismaReadClient,
} from "../restore-runtime-client.js";

const admission = vi.hoisted(() => ({
	observe: undefined as ((workload: "ordinary" | "bulk-cache") => void) | undefined,
}));

// Notification only: forward real admission calls, arguments and promises.
// This distinguishes the route phase from the real session lookup beforehand.
vi.mock("../restore-runtime-client.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../restore-runtime-client.js")>();
	return {
		...actual,
		withIsolatedRuntimePrismaReadClient: (
			...args: Parameters<typeof actual.withIsolatedRuntimePrismaReadClient>
		) => {
			const result = actual.withIsolatedRuntimePrismaReadClient(...args);
			admission.observe?.("ordinary");
			return result;
		},
		withIsolatedRuntimePrismaBulkReadClient: (
			...args: Parameters<typeof actual.withIsolatedRuntimePrismaBulkReadClient>
		) => {
			const result = actual.withIsolatedRuntimePrismaBulkReadClient(...args);
			admission.observe?.("bulk-cache");
			return result;
		},
	};
});

const OWNER = "synthetic-user";
const PLEX = "synthetic-plex";
const routeScope = new AsyncLocalStorage<{
	route: string;
	phase: "session" | "route";
}>();
let lastFixture: ScopedWriteFixture | undefined;
const nativeHandles = new Set<Database.Database>();

afterEach(async () => {
	admission.observe = undefined;
	vi.unstubAllGlobals();
	await closeScopedWriteFixtures();
	if (lastFixture) {
		expect([...nativeHandles].every((db) => !db.open)).toBe(true);
		process.stdout.write(
			`${JSON.stringify({
				category: "synthetic-plex-dashboard-workload-closure",
				nativeHandles: nativeHandles.size,
				nativeHandlesClosed: [...nativeHandles].every((db) => !db.open),
				writerClosed: !lastFixture.writer.open,
				fixtureRemoved: !existsSync(lastFixture.directory),
			})}\n`,
		);
	}
	lastFixture = undefined;
	nativeHandles.clear();
});

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function seedPlexDisplay(f: ScopedWriteFixture) {
	const observedAt = new Date(Date.now() - 1_000);
	const generationId = "synthetic-dashboard-generation";
	await f.plain.serviceInstance.update({
		where: { id: PLEX },
		data: {
			identityKind: "PLEX_MACHINE_IDENTIFIER",
			identityVerifiedAt: observedAt,
		},
	});
	const row = await f.plain.plexCache.update({
		where: { id: "synthetic-cache" },
		data: {
			tmdbId: 42,
			title: "Synthetic dashboard movie",
			ratingKey: "synthetic-movie-42",
			onDeck: true,
			addedAt: observedAt,
		},
	});
	const targets = [
		{
			instanceId: PLEX,
			generationId,
			sectionId: "synthetic-section",
			sectionUuid: "synthetic-section-uuid",
			mediaType: "movie" as const,
			tmdbId: 42,
			tvdbId: null,
			ratingKey: "synthetic-movie-42",
		},
	];
	const projection = createPlexSelectionProjection({
		rows: [row],
		selection: { kind: "all" },
		domains: ["membership", "display", "on-deck"],
	});
	const generationMetadata = encodeAuthoritativePlexGenerationMetadata({
		sections: [
			{
				key: "synthetic-section",
				uuid: "synthetic-section-uuid",
				title: "Synthetic",
				type: "movie",
				refreshing: false,
				scannedAt: 1,
				updatedAt: 1,
			},
		],
		itemCount: 1,
		canonicalizationVersion: 1,
		roots: Object.entries(projection.domains).map(([domain, digest]) => ({
			sectionKey: "synthetic-section",
			domain: domain as "membership" | "display" | "on-deck",
			digest,
		})),
		targetLedger: createPlexTargetLedgerBinding({
			instanceId: PLEX,
			generationId,
			connectionGeneration: 1,
			identityGeneration: 1,
			targets,
		}),
		partialReasons: [],
		coverageReceipt: {
			version: 1,
			provider: "plex",
			attemptStartedAt: new Date(observedAt.getTime() - 1_000).toISOString(),
			observedAt: observedAt.toISOString(),
			evidence: "complete",
			units: [
				{
					scopeKey: "section:synthetic-section",
					expectedRawCount: 1,
					pagesAttempted: 1,
					pagesCompleted: 1,
					rawObserved: 1,
					sourceBindings: 1,
					canonicalEntities: 1,
					acceptedSkips: [],
					fatalCount: 0,
				},
			],
		},
	});
	await f.plain.plexGenerationTarget.createMany({ data: targets });
	await f.plain.cacheRefreshStatus.create({
		data: {
			instanceId: PLEX,
			cacheType: "plex",
			lastRefreshedAt: observedAt,
			lastResult: "success",
			lastAttemptAt: observedAt,
			lastAttemptResult: "success",
			itemCount: 1,
			connectionGeneration: 1,
			identityGeneration: 1,
			generationId,
			generationMetadata,
		},
	});
}

describe("Plex Dashboard workload admission", { timeout: 20_000 }, () => {
	// Regression: either catalogue route using ordinary admission can take a
	// reserved ordinary lane. Real route/evidence results must remain correct.
	it("leaves ordinary capacity available while both real Plex catalogue routes await bulk admission", async () => {
		const f = await createScopedWriteFixture();
		lastFixture = f;
		await seedPlexDisplay(f);
		const token = "synthetic-plex-dashboard-session";
		const sessionId = createHash("sha256").update(token).digest("hex");
		await f.plain.session.create({
			data: { id: sessionId, userId: OWNER, expiresAt: new Date(Date.now() + 3_600_000) },
		});
		let providerIo = 0;
		vi.stubGlobal("fetch", () => {
			providerIo++;
			throw new Error("Unexpected provider I/O in cache-only admission regression");
		});
		const prepare = Database.prototype.prepare;
		let metadataWrites = 0;
		const routeSql: Record<string, { counts: number; selectedRows: number }> = {};
		vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database.Database,
			sql,
		) {
			const statement = prepare.call(this, sql);
			if (this.name !== f.path || this === f.writer) return statement;
			nativeHandles.add(this);
			for (const method of ["all", "run"] as const) {
				const invoke = statement[method];
				Reflect.set(statement, method, function (this: typeof statement, ...args: unknown[]) {
					const result = Reflect.apply(invoke, this, args);
					const unquoted = sql.replace(/["`]/g, "");
					if (/^\s*UPDATE\s+(?:main\.)?sessions\s/i.test(unquoted)) metadataWrites++;
					const scope = routeScope.getStore();
					if (scope?.phase === "route" && /\bplex_cache\b/i.test(sql) && Array.isArray(result)) {
						routeSql[scope.route] ??= { counts: 0, selectedRows: 0 };
						const stats = routeSql[scope.route]!;
						if (/\bCOUNT\s*\(/i.test(sql)) stats.counts++;
						else stats.selectedRows += result.length;
					}
					return result;
				});
			}
			return statement;
		});
		const noOpenTransactions = () => [...nativeHandles].every((db) => !db.inTransaction);
		const app = Fastify({ logger: false });
		const sessions = new SessionService(
			f.client.prisma,
			{ SESSION_COOKIE_NAME: "fixture_session" } as ApiEnv,
			app.log,
		);
		app.decorate("prisma", f.client.prisma);
		app.decorate("restoreRuntime", f.runtime);
		app.decorate("sessionService", sessions);
		app.decorateRequest("currentUser", null);
		app.decorateRequest("sessionToken", null);
		await app.register(fastifyCookie, {
			secret: "synthetic-plex-dashboard-signing-secret",
			hook: "onRequest",
		});
		registerSessionValidationHook(app);
		app.addHook("preHandler", async (request, reply) => {
			if (!request.currentUser) return reply.status(401).send({ error: "Unauthenticated" });
			const scope = routeScope.getStore();
			if (scope) scope.phase = "route";
		});
		app.addHook("preClose", async () => sessions.closeValidationAdmission());
		app.addHook("onClose", async () => sessions.drainValidations());
		await app.register(registerOnDeckRoutes, { prefix: "/plex/on-deck" });
		await app.register(registerRecentlyAddedRoutes, { prefix: "/plex/recently-added" });
		await app.ready();
		const peerScope = new AsyncResource("synthetic-independent-dashboard-probe");
		const releaseHolders = signal(),
			releaseRoutes = signal(),
			holdersReady = signal();
		const routesAttempted = signal(),
			evidenceFinished = signal();
		const attempts: { route: string; workload: string }[] = [];
		const finishedEvidence: string[] = [];
		let sessionAdmissions = 0,
			holderReads = 0;
		const holders: Promise<unknown>[] = [];
		const routes: Promise<Awaited<ReturnType<typeof app.inject>>>[] = [];
		let probe: Promise<unknown> | undefined;
		try {
			expect(
				(await f.runtime.runOperation(() => app.inject({ method: "GET", url: "/plex/on-deck" })))
					.statusCode,
			).toBe(401);
			admission.observe = (workload) => {
				const scope = routeScope.getStore();
				if (!scope) return;
				if (scope.phase === "session") {
					sessionAdmissions++;
					return;
				}
				attempts.push({ route: scope.route, workload });
				if (attempts.length === 2) routesAttempted.resolve();
			};
			const readEvidence = PlexAuthorityService.prototype.readUserSelectedDisplay;
			vi.spyOn(PlexAuthorityService.prototype, "readUserSelectedDisplay").mockImplementation(
				async function (this: PlexAuthorityService, input) {
					const evidence = await readEvidence.call(this, input);
					expect(input.userId).toBe(OWNER);
					expect(evidence).toMatchObject([
						{
							available: true,
							instanceId: PLEX,
							itemCount: 1,
							rows: [{ ratingKey: "synthetic-movie-42" }],
						},
					]);
					expect(noOpenTransactions()).toBe(true);
					finishedEvidence.push(routeScope.getStore()!.route);
					if (finishedEvidence.length === 2) evidenceFinished.resolve();
					// Hold only the callback lease AFTER the genuine reader returned.
					await releaseRoutes.promise;
					return evidence;
				},
			);
			for (let index = 0; index < 2; index++) {
				holders.push(
					f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaBulkReadClient(f.client.prisma, async (reader) => {
							expect(await reader.serviceInstance.count({ where: { userId: OWNER } })).toBe(2);
							expect(noOpenTransactions()).toBe(true);
							if (++holderReads === 2) holdersReady.resolve();
							await releaseHolders.promise;
						}),
					),
				);
			}
			await Promise.race([
				holdersReady.promise,
				Promise.all(holders).then(() => {
					throw new Error("Bulk holders did not remain pending");
				}),
			]);
			const cookie = `fixture_session=${encodeURIComponent(app.signCookie(token))}`;
			for (const [route, url] of [
				["on-deck", "/plex/on-deck"],
				["recently-added", "/plex/recently-added?limit=1"],
			] as const) {
				routes.push(
					routeScope.run({ route, phase: "session" }, () =>
						f.runtime.runOperation(() => app.inject({ method: "GET", url, headers: { cookie } })),
					),
				);
			}
			await Promise.race([
				routesAttempted.promise,
				Promise.all(routes).then(() => {
					throw new Error("Routes completed before both admission attempts");
				}),
			]);
			probe = peerScope.runInAsyncScope(() =>
				f.runtime.runOperation(() =>
					withIsolatedRuntimePrismaReadClient(f.client.prisma, async (reader) => {
						const session = await reader.session.findUnique({
							where: { id: sessionId },
							include: { user: true },
						});
						expect(session?.user.id).toBe(OWNER);
						return session!.user.id;
					}),
				),
			);
			const winner = await Promise.race([
				probe.then(() => "ordinary-probe"),
				evidenceFinished.promise.then(() => "plex-callbacks"),
			]);
			const evidenceBeforeRelease = [...finishedEvidence];
			expect(noOpenTransactions()).toBe(true);
			releaseHolders.resolve();
			releaseRoutes.resolve();
			const responses = await Promise.all(routes);
			await Promise.all([...holders, probe]);
			for (const response of responses) {
				expect(response.statusCode).toBe(200);
				expect(response.json()).toMatchObject({
					items: [
						{
							tmdbId: 42,
							title: "Synthetic dashboard movie",
							mediaType: "movie",
							instanceId: PLEX,
							ratingKey: "synthetic-movie-42",
						},
					],
					evidence: {
						availability: "current",
						authority: "authoritative",
						publicationLevel: "authoritative",
						completeness: "complete",
						reasonCodes: [],
					},
				});
				expect(response.json().items).toHaveLength(1);
			}
			expect(responses[1]!.json().items[0].addedAt).toEqual(expect.any(String));
			expect(routeSql).toEqual({
				"on-deck": { counts: 2, selectedRows: 1 },
				"recently-added": { counts: 2, selectedRows: 1 },
			});
			expect(sessionAdmissions).toBe(2);
			expect(providerIo).toBe(0);
			expect(f.losses).toEqual([]);
			process.stdout.write(
				`${JSON.stringify({ category: "synthetic-plex-dashboard-workload-admission", winner, attempts, sessionAdmissions, holderReads, evidenceBeforeRelease, routeSql, statuses: responses.map((r) => r.statusCode), itemCounts: responses.map((r) => r.json().items.length), providerIo, runtimeLosses: f.losses, noSqlTransactionHeld: noOpenTransactions(), measuredQaWorkload: false })}\n`,
			);
			expect(attempts).toHaveLength(2);
			expect(attempts).toEqual(
				expect.arrayContaining([
					{ route: "on-deck", workload: "bulk-cache" },
					{ route: "recently-added", workload: "bulk-cache" },
				]),
			);
			expect(winner).toBe("ordinary-probe");
		} finally {
			releaseHolders.resolve();
			releaseRoutes.resolve();
			await Promise.allSettled([...holders, ...routes, ...(probe ? [probe] : [])]);
			await app.close();
			peerScope.emitDestroy();
			admission.observe = undefined;
			process.stdout.write(
				`${JSON.stringify({ category: "synthetic-plex-dashboard-session-drain", metadataWrites, sessionValidationDrained: true })}\n`,
			);
		}
	});
});
