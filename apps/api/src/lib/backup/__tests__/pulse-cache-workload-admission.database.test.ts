import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	closeScopedWriteFixtures,
	createScopedWriteFixture,
	type ScopedWriteFixture,
} from "../../__tests__/scoped-write-intent-fixture.js";
import { pulseCollectors } from "../../pulse/collectors.js";
import {
	withIsolatedRuntimePrismaBulkReadClient,
	withIsolatedRuntimePrismaReadClient,
} from "../restore-runtime-client.js";

type Boundary = "jellyfin-health" | "plex-library" | "plex-episode" | "tautulli";
const observer = vi.hoisted(() => ({
	settled: undefined as ((boundary: Boundary, result: unknown) => Promise<void>) | undefined,
}));
const evidenceScope = new AsyncLocalStorage<Boundary>();

// Forward every real reader, argument and result. The selected reader's test
// barrier runs only AFTER its genuine SQL and repository transactions settle.
vi.mock("../../jellyfin/jellyfin-cache-health.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../jellyfin/jellyfin-cache-health.js")>();
	return {
		...actual,
		readOwnedJellyfinCacheHealthSources: async (
			...args: Parameters<typeof actual.readOwnedJellyfinCacheHealthSources>
		) => {
			const result = await evidenceScope.run("jellyfin-health", () =>
				actual.readOwnedJellyfinCacheHealthSources(...args),
			);
			await observer.settled?.("jellyfin-health", result);
			return result;
		},
	};
});

vi.mock("../../plex/plex-persisted-observation-repository.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../plex/plex-persisted-observation-repository.js")>();
	return {
		...actual,
		loadUserGenerationObservations: async (
			...args: Parameters<typeof actual.loadUserGenerationObservations>
		) => {
			const result = await evidenceScope.run("plex-library", () =>
				actual.loadUserGenerationObservations(...args),
			);
			await observer.settled?.("plex-library", result);
			return result;
		},
		getPublishedEpisodeGenerationObservation: async (
			...args: Parameters<typeof actual.getPublishedEpisodeGenerationObservation>
		) => {
			const result = await evidenceScope.run("plex-episode", () =>
				actual.getPublishedEpisodeGenerationObservation(...args),
			);
			await observer.settled?.("plex-episode", result);
			return result;
		},
	};
});

vi.mock("../../tautulli/tautulli-observation-repository.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../tautulli/tautulli-observation-repository.js")>();
	return {
		...actual,
		readOwnedTautulliObservation: async (
			...args: Parameters<typeof actual.readOwnedTautulliObservation>
		) => {
			const result = await evidenceScope.run("tautulli", () =>
				actual.readOwnedTautulliObservation(...args),
			);
			await observer.settled?.("tautulli", result);
			return result;
		},
	};
});

const OWNER = "synthetic-user";
const PLEX = "synthetic-plex";
const JELLYFIN = "synthetic-jellyfin";
const TAUTULLI = "synthetic-tautulli";
let fixture: ScopedWriteFixture | undefined;
const nativeHandles = new Set<Database.Database>();

function emit(value: unknown) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

afterEach(async () => {
	observer.settled = undefined;
	vi.unstubAllGlobals();
	await closeScopedWriteFixtures();
	if (fixture) {
		const closure = {
			category: "synthetic-pulse-cache-workload-closure",
			nativeHandles: nativeHandles.size,
			nativeHandlesClosed: [...nativeHandles].every((db) => !db.open),
			writerClosed: !fixture.writer.open,
			fixtureRemoved: !existsSync(fixture.directory),
		};
		emit(closure);
		expect(closure).toMatchObject({
			nativeHandlesClosed: true,
			writerClosed: true,
			fixtureRemoved: true,
		});
	}
	fixture = undefined;
	nativeHandles.clear();
});

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function seedUnavailablePublications(f: ScopedWriteFixture) {
	await f.plain.user.create({ data: { id: "foreign-user", username: "foreign-user" } });
	await f.plain.serviceInstance.createMany({
		data: [
			{ id: TAUTULLI, service: "TAUTULLI" as const, userId: OWNER, label: "Synthetic" },
			{ id: "foreign-plex", service: "PLEX" as const, userId: "foreign-user", label: "Foreign" },
			{
				id: "foreign-jellyfin",
				service: "JELLYFIN" as const,
				userId: "foreign-user",
				label: "Foreign",
			},
			{
				id: "foreign-tautulli",
				service: "TAUTULLI" as const,
				userId: "foreign-user",
				label: "Foreign",
			},
		].map((instance) => ({
			...instance,
			baseUrl: "http://synthetic.invalid",
			encryptedApiKey: "synthetic-cipher",
			encryptionIv: "synthetic-iv",
			expectedIdentity: "synthetic-provider",
			identityStatus: "VERIFIED" as const,
			connectionGeneration: 1,
			identityGeneration: 1,
		})),
	});
	// Status rows reach both actual historical Plex readers. No metadata is
	// invented to turn this deliberately insufficient seed into authority.
	for (const instanceId of [PLEX, "foreign-plex"]) {
		for (const cacheType of ["plex", "plex_episode"]) {
			await f.plain.cacheRefreshStatus.create({
				data: {
					id: `${instanceId}-${cacheType}-status`,
					instanceId,
					cacheType,
					lastRefreshedAt: new Date(Date.now() - 1_000),
					lastResult: "success",
					itemCount: 1,
					connectionGeneration: 1,
					identityGeneration: 1,
				},
			});
		}
	}
}

function expectUnavailable(boundary: Boundary, result: unknown) {
	if (boundary === "jellyfin-health") {
		expect(result).toMatchObject([
			{ item: { instanceId: JELLYFIN, cacheType: "jellyfin", itemCount: null } },
			{ item: { instanceId: JELLYFIN, cacheType: "jellyfin_episode", itemCount: null } },
		]);
		for (const source of result as { item: { providerStatus: { availability: string } } }[]) {
			expect(source.item.providerStatus.availability).toBe("unavailable");
		}
	} else if (boundary === "plex-library" || boundary === "plex-episode") {
		const entries = boundary === "plex-library" ? (result as unknown[]) : [result];
		expect(entries).toHaveLength(1);
		for (const entry of entries) {
			expect(entry).toMatchObject({
				available: false,
				evidence: { publicationLevel: "unavailable" },
			});
			expect((entry as { evidence: { reasonCodes: string[] } }).evidence.reasonCodes).not.toContain(
				"query_failed",
			);
		}
		if (boundary === "plex-library") expect(entries[0]).toMatchObject({ instanceId: PLEX });
	} else {
		expect(result).toMatchObject({
			instanceId: TAUTULLI,
			rows: [],
			providerStatus: {
				availability: "unavailable",
				evidence: "unknown",
				reasonCodes: ["no-publication"],
			},
		});
	}
}

describe("Pulse cache catalogue workload admission", { timeout: 15_000 }, () => {
	// Each case catches a regression of just its named callback to ordinary
	// admission, even when all three other readers retain bulk admission.
	it.each<Boundary>(["jellyfin-health", "plex-library", "plex-episode", "tautulli"])(
		"reserves ordinary capacity while two real %s callbacks hold settled evidence",
		async (boundary) => {
			const f = await createScopedWriteFixture();
			fixture = f;
			await seedUnavailablePublications(f);
			const app = Fastify({ logger: false });
			app.decorate("prisma", f.client.prisma);
			const collector = pulseCollectors.find(
				(candidate) => candidate.name === "collectCacheStaleness",
			)!;
			const peerScope = new AsyncResource("synthetic-independent-pulse-probe");
			const targetReady = signal(),
				releaseTargets = signal(),
				releaseProbes = signal();
			const bulkProbeEntered = signal();
			const collectors: ReturnType<typeof collector>[] = [];
			const probes: Promise<unknown>[] = [];
			let ordinary: Promise<unknown> | undefined;
			let targetCompletions = 0,
				bulkProbeReads = 0,
				providerIo = 0;
			const queries: Partial<Record<Boundary, number>> = {};
			const nativeErrors: string[] = [];
			const noOpenTransactions = () => [...nativeHandles].every((db) => !db.inTransaction);
			vi.stubGlobal("fetch", () => {
				providerIo++;
				throw new Error("Unexpected provider I/O in cache-only Pulse regression");
			});
			const prepare = Database.prototype.prepare;
			vi.spyOn(Database.prototype, "prepare").mockImplementation(function (
				this: Database.Database,
				sql,
			) {
				const statement = prepare.call(this, sql);
				if (this.name !== f.path) return statement;
				nativeHandles.add(this);
				for (const method of ["all", "run"] as const) {
					const invoke = statement[method];
					Reflect.set(statement, method, function (this: typeof statement, ...args: unknown[]) {
						try {
							const result = Reflect.apply(invoke, this, args);
							const scope = evidenceScope.getStore();
							if (scope && /\bSELECT\b/i.test(sql)) queries[scope] = (queries[scope] ?? 0) + 1;
							return result;
						} catch (error) {
							if (error instanceof Database.SqliteError) nativeErrors.push(error.code);
							throw error;
						}
					});
				}
				return statement;
			});
			observer.settled = async (reader, result) => {
				if (reader !== boundary) return;
				expectUnavailable(reader, result);
				if (++targetCompletions === 2) targetReady.resolve();
				await releaseTargets.promise;
			};
			try {
				for (let index = 0; index < 2; index++) {
					collectors.push(f.runtime.runOperation(() => collector(app, OWNER, app.log)));
				}
				await Promise.race([
					targetReady.promise,
					Promise.all(collectors).then(() => {
						throw new Error("Collectors completed without both target barriers");
					}),
				]);
				expect(noOpenTransactions()).toBe(true);
				for (let index = 0; index < 2; index++) {
					probes.push(
						peerScope.runInAsyncScope(() =>
							f.runtime.runOperation(() =>
								withIsolatedRuntimePrismaBulkReadClient(f.client.prisma, async (reader) => {
									expect(await reader.serviceInstance.count({ where: { userId: OWNER } })).toBe(3);
									expect(noOpenTransactions()).toBe(true);
									bulkProbeReads++;
									bulkProbeEntered.resolve();
									await releaseProbes.promise;
								}),
							),
						),
					);
				}
				ordinary = peerScope.runInAsyncScope(() =>
					f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(f.client.prisma, async (reader) => {
							const instances = await reader.serviceInstance.findMany({
								where: { userId: OWNER },
								select: { id: true },
								orderBy: { id: "asc" },
							});
							expect(instances.map((instance) => instance.id)).toEqual([JELLYFIN, PLEX, TAUTULLI]);
						}),
					),
				);
				const winner = await Promise.race([
					ordinary.then(() => "ordinary-read"),
					bulkProbeEntered.promise.then(() => "extra-bulk-probe"),
					Promise.all(probes).then(() => {
						throw new Error("Bulk probes completed without their barriers");
					}),
				]);
				const bulkReadsBeforeRelease = bulkProbeReads;
				expect(noOpenTransactions()).toBe(true);
				releaseTargets.resolve();
				releaseProbes.resolve();
				const results = await Promise.all(collectors);
				await Promise.all([...probes, ordinary]);
				for (const items of results) {
					expect(items).toHaveLength(6);
					expect(items.map((item) => item.id)).toEqual(
						expect.arrayContaining([
							`cache-jellyfin-error-${JELLYFIN}-jellyfin`,
							`cache-jellyfin-error-${JELLYFIN}-jellyfin_episode`,
							`cache-unavailable-${PLEX}-plex-status`,
							`cache-unavailable-${PLEX}-plex_episode-status`,
							`plex-native-metadata-unavailable-${PLEX}`,
							`cache-tautulli-unavailable-${TAUTULLI}`,
						]),
					);
					expect(JSON.stringify(items)).not.toContain("foreign");
					expect(JSON.stringify(items)).not.toContain("Foreign");
				}
				expect(targetCompletions).toBe(2);
				expect(queries[boundary]).toBeGreaterThanOrEqual(2);
				expect(bulkProbeReads).toBe(2);
				expect(providerIo).toBe(0);
				expect(nativeErrors).toEqual([]);
				expect(f.losses).toEqual([]);
				emit({
					category: "synthetic-pulse-cache-workload-admission",
					boundary,
					winner,
					targetCompletions,
					bulkReadsBeforeRelease,
					bulkProbeReads,
					queries,
					collectorItemCounts: results.map((items) => items.length),
					providerIo,
					nativeErrors,
					runtimeLosses: f.losses,
					noSqlTransactionHeld: noOpenTransactions(),
					measuredQaWorkload: false,
				});
				expect(winner).toBe("ordinary-read");
				expect(bulkReadsBeforeRelease).toBe(0);
			} finally {
				releaseTargets.resolve();
				releaseProbes.resolve();
				await Promise.allSettled([...collectors, ...probes, ...(ordinary ? [ordinary] : [])]);
				await app.close();
				peerScope.emitDestroy();
				emit({
					category: "synthetic-pulse-cache-workload-drain",
					boundary,
					barriersReleased: true,
					operationsJoined: true,
				});
			}
		},
	);
});
