import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
	beginNativeInventoryAttempt,
	publishNativeInventoriesInTransaction,
} from "../../provider-observation/native-inventory.js";
import { withCurrentProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import {
	withIsolatedRuntimePrismaBulkReadClient,
	withIsolatedRuntimePrismaReadClient,
} from "../restore-runtime-client.js";

type Boundary = "jellyfin-health" | "plex-library" | "plex-episode" | "tautulli" | "plex-native";
const observer = vi.hoisted(() => ({
	settled: undefined as ((boundary: Boundary, result: unknown) => Promise<void>) | undefined,
	phaseSettled: undefined as ((boundary: Boundary | undefined) => Promise<void>) | undefined,
}));
const evidenceScope = new AsyncLocalStorage<Boundary>();

// Observe only the admission seam: every real query/transaction still runs on
// its actual admitted native client and returns its unchanged result.
vi.mock("../restore-runtime-read-phases.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../restore-runtime-read-phases.js")>();
	const withRuntimeReadPhases: typeof actual.withRuntimeReadPhases = (admit, operation) =>
		actual.withRuntimeReadPhases(
			(read) =>
				admit(async (client) => {
					const boundary = evidenceScope.getStore();
					const result = await read(client);
					await observer.phaseSettled?.(boundary);
					return result;
				}),
			operation,
		);
	return { ...actual, withRuntimeReadPhases };
});

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

vi.mock("../../provider-observation/native-inventory.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../provider-observation/native-inventory.js")>();
	return {
		...actual,
		readNativeInventoryPage: async (...args: Parameters<typeof actual.readNativeInventoryPage>) => {
			expect(args[1]).toMatchObject({
				userId: "synthetic-user",
				instanceId: "synthetic-plex",
				domain: "library",
				limit: 1,
			});
			const result = await evidenceScope.run("plex-native", () =>
				actual.readNativeInventoryPage(...args),
			);
			await observer.settled?.("plex-native", result);
			return result;
		},
	};
});

const OWNER = "synthetic-user";
const PLEX = "synthetic-plex";
const JELLYFIN = "synthetic-jellyfin";
const TAUTULLI = "synthetic-tautulli";
let fixture: ScopedWriteFixture | undefined;
let fixtureIdentity: ReturnType<typeof lstatSync> | undefined;
const nativeHandles = new Set<Database.Database>();

function emit(value: unknown) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

afterEach(async () => {
	observer.settled = undefined;
	observer.phaseSettled = undefined;
	vi.unstubAllGlobals();
	let nativeReadHandlesClosedBeforeRemoval = false;
	if (fixture) {
		await fixture.client.close();
		await fixture.runtime.drain();
		await fixture.runtime.close();
		await fixture.plain.$disconnect();
		nativeReadHandlesClosedBeforeRemoval = [...nativeHandles]
			.filter((db) => db !== fixture!.writer)
			.every((db) => !db.open);
		expect(nativeReadHandlesClosedBeforeRemoval).toBe(true);
		const current = lstatSync(fixture.directory);
		expect([current.dev, current.ino]).toEqual([fixtureIdentity!.dev, fixtureIdentity!.ino]);
	}
	await closeScopedWriteFixtures();
	if (fixture) {
		const closure = {
			category: "synthetic-pulse-cache-workload-closure",
			nativeHandles: nativeHandles.size,
			nativeHandlesClosed: [...nativeHandles].every((db) => !db.open),
			writerClosed: !fixture.writer.open,
			fixtureRemoved: !existsSync(fixture.directory),
			nativeReadHandlesClosedBeforeRemoval,
		};
		emit(closure);
		expect(closure).toMatchObject({
			nativeHandlesClosed: true,
			writerClosed: true,
			fixtureRemoved: true,
		});
	}
	fixture = undefined;
	fixtureIdentity = undefined;
	nativeHandles.clear();
});

function signal() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function seedNativePublication(f: ScopedWriteFixture) {
	const instance = await f.plain.serviceInstance.findUniqueOrThrow({
		where: { id: PLEX, userId: OWNER },
	});
	const now = new Date(Date.now() - 1_000);
	const begun = await beginNativeInventoryAttempt(f.plain, {
		userId: OWNER,
		instance,
		domains: ["library"],
		now,
	});
	if (begun.status !== "acquired") throw new Error("Native Pulse publication admission failed");
	const published = await withCurrentProviderPublicationAuthority(f.plain, begun.authority, (tx) =>
		publishNativeInventoriesInTransaction(tx, {
			userId: OWNER,
			authority: begun.authority,
			attempt: begun.attempt,
			now,
			snapshots: [
				{
					domain: "library",
					scopeKeys: ["catalog"],
					rows: [1, 2, 3].map((id) => ({
						nativeId: `movie-${id}`,
						mediaType: "movie",
						libraryIds: ["catalog"],
						parentNativeId: null,
						seasonNumber: null,
						episodeNumber: null,
						title: "Synthetic published movie",
						externalIds: { tmdb: [id] },
					})),
				},
			],
		}),
	);
	expect(published).toMatchObject({
		matched: true,
		value: { status: "published", itemCounts: { library: 3 } },
	});
}

function fixtureBytes(directory: string): number {
	return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
		const path = join(directory, entry.name);
		return total + (entry.isDirectory() ? fixtureBytes(path) : statSync(path).size);
	}, 0);
}

async function bounded<T>(condition: Promise<T>, name: string): Promise<T> {
	const guard = new AbortController();
	try {
		return await Promise.race([
			condition,
			delay(1500, undefined, { signal: guard.signal }).then(() => {
				throw new Error(`Timed out waiting for ${name}`);
			}),
		]);
	} finally {
		guard.abort();
	}
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

function expectEvidence(boundary: Boundary, result: unknown) {
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
	} else if (boundary === "plex-native") {
		expect(result).toMatchObject({
			status: "available",
			itemCount: 3,
			scopeCount: 1,
			freshness: "current",
			complete: true,
			nextNativeId: "movie-1",
		});
		const page = result as { rows: unknown[] };
		expect(page.rows).toEqual([
			{
				nativeId: "movie-1",
				mediaType: "movie",
				libraryIds: ["catalog"],
				parentNativeId: null,
				seasonNumber: null,
				episodeNumber: null,
				title: "Synthetic published movie",
				externalIds: { tmdb: [1] },
			},
		]);
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
	// Each case catches loss of phase/bulk classification for its named reader,
	// while settled repository callbacks must no longer retain either bulk slot.
	it.each<Boundary>(["jellyfin-health", "plex-library", "plex-episode", "tautulli", "plex-native"])(
		"caps admitted %s read phases and frees their slots while callbacks hold settled evidence",
		async (boundary) => {
			const f = await createScopedWriteFixture();
			fixture = f;
			fixtureIdentity = lstatSync(f.directory);
			await seedUnavailablePublications(f);
			if (boundary === "plex-native") await seedNativePublication(f);
			const seededBytes = fixtureBytes(f.directory);
			expect(seededBytes).toBeLessThanOrEqual(256 * 1024 ** 2);
			const app = Fastify({ logger: false });
			app.decorate("prisma", f.client.prisma);
			const collector = pulseCollectors.find(
				(candidate) => candidate.name === "collectCacheStaleness",
			)!;
			const peerScope = new AsyncResource("synthetic-independent-pulse-probe");
			const phasesReady = signal(),
				releasePhases = signal(),
				targetReady = signal(),
				releaseTargets = signal(),
				releaseProbes = signal();
			const bulkProbeEntered = signal();
			const collectors: ReturnType<typeof collector>[] = [];
			const probes: Promise<unknown>[] = [];
			let ordinary: Promise<unknown> | undefined;
			let cappedBulk: Promise<unknown> | undefined;
			let admittedPhases = 0,
				cappedBulkEntered = false,
				targetCompletions = 0,
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
				expectEvidence(reader, result);
				if (++targetCompletions === 2) targetReady.resolve();
				await releaseTargets.promise;
			};
			observer.phaseSettled = async (reader) => {
				if (reader !== boundary || admittedPhases >= 2) return;
				if (++admittedPhases === 2) phasesReady.resolve();
				await releasePhases.promise;
			};
			try {
				for (let index = 0; index < 2; index++) {
					collectors.push(f.runtime.runOperation(() => collector(app, OWNER, app.log)));
				}
				const collectorsDone = Promise.all(collectors);
				await bounded(
					Promise.race([
						phasesReady.promise,
						collectorsDone.then(() => {
							throw new Error("Collectors completed without both selected phase barriers");
						}),
					]),
					`${boundary} admitted phase barriers`,
				);
				expect(noOpenTransactions()).toBe(true);
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
				await bounded(ordinary, "owned ordinary read during held phases");
				cappedBulk = peerScope.runInAsyncScope(() =>
					f.runtime.runOperation(() =>
						withIsolatedRuntimePrismaReadClient(
							f.client.prisma,
							async () => {
								cappedBulkEntered = true;
							},
							{ workload: "bulk-cache", maxWait: 50 },
						),
					),
				);
				await expect(cappedBulk).rejects.toMatchObject({ statusCode: 503 });
				expect(cappedBulkEntered).toBe(false);
				expect(admittedPhases).toBe(2);
				releasePhases.resolve();
				await bounded(
					Promise.race([
						targetReady.promise,
						collectorsDone.then(() => {
							throw new Error("Collectors completed without both settled evidence barriers");
						}),
					]),
					`${boundary} settled evidence barriers`,
				);
				expect(noOpenTransactions()).toBe(true);
				for (let index = 0; index < 2; index++) {
					probes.push(
						peerScope.runInAsyncScope(() =>
							f.runtime.runOperation(() =>
								withIsolatedRuntimePrismaBulkReadClient(f.client.prisma, async (reader) => {
									expect(await reader.serviceInstance.count({ where: { userId: OWNER } })).toBe(3);
									expect(noOpenTransactions()).toBe(true);
									if (++bulkProbeReads === 2) bulkProbeEntered.resolve();
									await releaseProbes.promise;
								}),
							),
						),
					);
				}
				await bounded(
					Promise.race([
						bulkProbeEntered.promise,
						Promise.all(probes).then(() => {
							throw new Error("Bulk probes completed without their barriers");
						}),
					]),
					"both bulk probes before settled callbacks release",
				);
				const bulkReadsBeforeRelease = bulkProbeReads;
				expect(bulkReadsBeforeRelease).toBe(2);
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
							boundary === "plex-native"
								? `plex-native-metadata-${PLEX}`
								: `plex-native-metadata-unavailable-${PLEX}`,
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
					admittedPhases,
					ordinaryReadDuringHeldPhases: true,
					cappedBulkEntered,
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
					seededBytes,
				});
			} finally {
				releasePhases.resolve();
				releaseTargets.resolve();
				releaseProbes.resolve();
				await Promise.allSettled([
					...collectors,
					...probes,
					...(ordinary ? [ordinary] : []),
					...(cappedBulk ? [cappedBulk] : []),
				]);
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
