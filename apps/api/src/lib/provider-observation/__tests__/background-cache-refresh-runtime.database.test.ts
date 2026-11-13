import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Encryptor } from "../../auth/encryption.js";
import { openRestoreRuntime, type RestoreRuntime } from "../../backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../backup/restore-runtime-client.js";
import {
	loadRuntimeSchemaRegistry,
	prepareRuntimeSchemaExecution,
} from "../../backup/runtime-schema-registry.js";
import {
	type JellyfinCacheRefreshResult,
	refreshOwnedJellyfinCacheWithAttempt,
} from "../../jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlightWithAttempt } from "../../jellyfin/jellyfin-cache-singleflight.js";
import type { JellyfinLibraryGenerationMetadataV1 } from "../../jellyfin/jellyfin-generation-metadata.js";
import { type CacheRefreshStatus, PrismaClient } from "../../prisma.js";
import {
	claimProviderCacheRefreshAttempt,
	type ProviderCacheRefreshAttempt,
} from "../../services/provider-cache-status.js";
import { createProviderPublicationAuthority } from "../../services/provider-identity-guard.js";
import { createRecoverableSqliteAdapter } from "../../sqlite-adapter.js";
import { startProviderCacheRefreshInBackground } from "../background-cache-refresh.js";

const log = pino({ level: "silent" });
const resources: Array<{
	directory: string;
	server: Server;
	db: Database.Database;
	close: () => Promise<void>;
}> = [];
const releases: Array<() => void> = [];
const backgroundTasks: Promise<void>[] = [];

function producerGate() {
	let release!: () => void;
	const ready = new Promise<void>((resolve) => {
		release = resolve;
	});
	releases.push(release);
	return { ready, release };
}

async function fixture(runtimeOwned: boolean) {
	const directory = mkdtempSync(join(tmpdir(), "arr-background-cache-runtime-"));
	const path = join(directory, "fixture.db");
	vi.stubEnv("DATABASE_URL", `file:${path}`);
	const methods: string[] = [];
	const unexpectedRequests: string[] = [];
	const providerState = {
		itemsUnavailable: false,
		failedItemRequests: 0,
		beforeItems: undefined as (() => Promise<void>) | undefined,
	};
	const routes = { identity: 0, users: 0, libraries: 0, items: 0, resume: 0, nextUp: 0 };
	const server = createServer((request, response) => {
		methods.push(request.method ?? "");
		const url = new URL(request.url ?? "/", "http://fixture.invalid");
		let data: unknown = {};
		if (
			request.method !== "GET" ||
			!request.headers.authorization?.startsWith('MediaBrowser Token="fixture-only-token",')
		) {
			unexpectedRequests.push("method-or-authorization");
			response.statusCode = 401;
		} else if (url.pathname === "/System/Info") {
			routes.identity++;
			data = { Id: "fixture-server", ServerName: "Fixture", Version: "10.11.11" };
		} else if (url.pathname === "/Users") {
			routes.users++;
			data = [
				{
					Id: "fixture-user",
					Name: "Fixture User",
					Policy: { IsAdministrator: true, IsDisabled: false },
				},
			];
		} else if (url.pathname === "/Users/fixture-user/Views") {
			routes.libraries++;
			data = {
				Items: [
					{
						Id: "fixture-library",
						Name: "Fixture Movies",
						Type: "CollectionFolder",
						CollectionType: "movies",
					},
				],
				TotalRecordCount: 1,
			};
		} else if (url.pathname === "/Users/fixture-user/Items") {
			routes.items++;
			const start = Number(url.searchParams.get("StartIndex") ?? 0);
			if (providerState.itemsUnavailable) {
				providerState.failedItemRequests++;
				response.statusCode = 401;
			} else {
				data = {
					Items:
						start === 0
							? [
									{
										Id: "fixture-movie",
										Name: "Fixture Movie",
										Type: "Movie",
										ProviderIds: { Tmdb: "42" },
										UserData: {
											Played: true,
											PlayCount: 1,
											LastPlayedDate: "2026-10-01T12:00:00.000Z",
										},
										DateCreated: "2026-09-01T12:00:00.000Z",
									},
								]
							: [],
					TotalRecordCount: 1,
					StartIndex: start,
				};
			}
		} else if (url.pathname === "/Users/fixture-user/Items/Resume") {
			routes.resume++;
			data = { Items: [], TotalRecordCount: 0 };
		} else if (url.pathname === "/Shows/NextUp") {
			routes.nextUp++;
			data = { Items: [], TotalRecordCount: 0 };
		} else {
			unexpectedRequests.push("unknown-route");
			response.statusCode = 404;
		}
		const send = () => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(data));
		};
		if (url.pathname === "/Users/fixture-user/Items" && providerState.beforeItems) {
			void providerState.beforeItems().then(send);
		} else send();
	});
	const db = new Database(path);
	const resource = { directory, server, db, close: async () => {} };
	resources.push(resource);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("fixture bind failed");
	db.pragma("foreign_keys=ON");
	db.pragma("journal_mode=WAL");
	await prepareRuntimeSchemaExecution(loadRuntimeSchemaRegistry("sqlite"), {
		provider: "sqlite",
		tables: [],
	}).execute((sql) => {
		db.exec(sql);
	});
	let client: PrismaClient;
	let runtime: RestoreRuntime | undefined;
	let run = <T>(operation: () => Promise<T>) => operation();
	if (runtimeOwned) {
		runtime = await openRestoreRuntime({ databaseUrl: `file:${path}`, onUnavailable: () => {} });
		const actor = runtime;
		resource.close = () => actor.close();
		const owned = createRuntimePrismaClient(actor);
		client = owned.prisma;
		resource.close = async () => {
			await owned.close();
			await actor.close();
		};
		await actor.bindDestination("fixture-destination");
		await actor.activate();
		run = (operation) => actor.runOperation(operation);
	} else {
		client = new PrismaClient({
			adapter: createRecoverableSqliteAdapter({ url: path, timeout: 5000 }),
		});
		resource.close = () => client.$disconnect();
	}
	return await run(async () => {
		await client.$connect();
		await client.user.create({ data: { id: "fixture-owner", username: "fixture-owner" } });
		const encryptor = new Encryptor("a".repeat(64));
		const key = encryptor.encrypt("fixture-only-token");
		const instance = await client.serviceInstance.create({
			data: {
				id: "fixture-jellyfin",
				userId: "fixture-owner",
				service: "JELLYFIN",
				label: "Fixture",
				baseUrl: `http://127.0.0.1:${address.port}`,
				encryptedApiKey: key.value,
				encryptionIv: key.iv,
				expectedIdentity: "fixture-server",
				identityKind: "JELLYFIN_SERVER_ID",
				identityStatus: "VERIFIED",
				identityVerifiedAt: new Date(),
				connectionGeneration: 3,
				identityGeneration: 7,
			},
		});
		return {
			client,
			db,
			encryptor,
			instance,
			methods,
			unexpectedRequests,
			providerState,
			routes,
			runtime,
			run,
		};
	});
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function claim(f: Fixture) {
	const result = await claimProviderCacheRefreshAttempt(
		f.client,
		"jellyfin",
		createProviderPublicationAuthority(f.instance),
	);
	if (result.status !== "acquired") throw new Error("fixture claim unavailable");
	return result;
}

function readStatus(f: Fixture) {
	return f.run(() =>
		f.client.cacheRefreshStatus.findUniqueOrThrow({
			where: {
				instanceId_cacheType: { instanceId: f.instance.id, cacheType: "jellyfin" },
			},
		}),
	);
}

function expectSuccessfulClaim(stored: CacheRefreshStatus, attempt: ProviderCacheRefreshAttempt) {
	expect(stored.lastAttemptResult).toBe("success");
	expect(stored.generationId).toEqual(expect.any(String));
	expect(stored.generationId).not.toBe("");
	const metadata = JSON.parse(
		stored.generationMetadata ?? "null",
	) as JellyfinLibraryGenerationMetadataV1 | null;
	expect(metadata).toMatchObject({
		connectionGeneration: 3,
		identityGeneration: 7,
		itemCount: 1,
		completeness: "complete",
	});
	expect(metadata?.coverageReceipt.attemptStartedAt).toBe(attempt.attemptedAt.toISOString());
	expect(metadata?.coverageReceipt.observedAt).toBe(stored.lastRefreshedAt?.toISOString());
	expect(stored.lastAttemptAt).toEqual(stored.lastRefreshedAt);
	expect(stored.lastRefreshedAt!.getTime()).toBeGreaterThanOrEqual(attempt.attemptedAt.getTime());
}

function expectProviderReads(f: Fixture) {
	expect(f.unexpectedRequests).toEqual([]);
	expect(f.methods.length).toBeGreaterThan(0);
	expect(f.methods.every((method) => method === "GET")).toBe(true);
	for (const count of Object.values(f.routes)) expect(count).toBeGreaterThan(0);
}

afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await Promise.allSettled(backgroundTasks.splice(0));
	try {
		for (const resource of resources.splice(0).reverse()) {
			await resource.close();
			resource.db.close();
			resource.server.closeAllConnections();
			if (resource.server.listening)
				await new Promise<void>((resolve, reject) => {
					resource.server.close((error) => (error ? reject(error) : resolve()));
				});
			expect(resource.directory.startsWith(join(tmpdir(), "arr-background-cache-runtime-"))).toBe(
				true,
			);
			expect(lstatSync(resource.directory).isSymbolicLink()).toBe(false);
			rmSync(resource.directory, { recursive: true });
		}
	} finally {
		vi.unstubAllEnvs();
	}
});

describe("accepted background cache refresh with real SQLite and Jellyfin HTTP", () => {
	it.each([false, true])(
		"reports canonical phase entry before a held HTTP collection and settles its original runtime claim with throwing logger: %s",
		async (throwTiming) => {
			const f = await fixture(true);
			const records: Record<string, unknown>[] = [];
			const diagnosticLog = pino(
				{ level: "info" },
				{
					write: (chunk: string) => {
						records.push(JSON.parse(chunk));
					},
				},
			);
			if (throwTiming) {
				const write = diagnosticLog.info.bind(diagnosticLog);
				diagnosticLog.info = ((record: Record<string, unknown>, message?: string) => {
					write(record, message);
					throw new Error("private timing logger failure");
				}) as typeof diagnosticLog.info;
			}
			const gate = producerGate();
			let entered!: () => void;
			const collecting = new Promise<void>((resolve) => {
				entered = resolve;
			});
			f.providerState.beforeItems = async () => {
				entered();
				await gate.ready;
			};
			await f.run(async () => {
				const original = await claim(f);
				const work = refreshOwnedJellyfinCacheWithAttempt(
					{ prisma: f.client, ...f, log: diagnosticLog },
					original.attempt,
				);
				await collecting;
				try {
					expect(
						records
							.filter((record) => record.category === "canonical-phase")
							.map((record) => record.stage),
					).toEqual([
						"preparing-owned-input",
						"before-identity-read",
						"collection",
						"native-admission",
						"user-discovery",
						"library-discovery",
						"library-item-collection",
						"library-page-request",
					]);
				} finally {
					gate.release();
					await work;
				}
				const result = await work;
				expect(result.complete).toBe(true);
				expectSuccessfulClaim(await readStatus(f), original.attempt);
				const diagnostics = records.filter((record) => record.category === "canonical-phase");
				expect(diagnostics.map((record) => record.stage)).toEqual([
					"preparing-owned-input",
					"before-identity-read",
					"collection",
					"native-admission",
					"user-discovery",
					"library-discovery",
					"library-item-collection",
					"library-page-request",
					"library-page-headers",
					"library-page-body",
					"library-page-validation",
					"library-page-accepted",
					"library-items-mapped",
					"on-deck-collection",
					"after-identity-read",
					"publication-admission",
					"transaction-publisher-entered",
					"attempt-settled",
				]);
				for (const record of diagnostics) {
					expect(Object.keys(record).sort()).toEqual([
						"cacheType",
						"category",
						"elapsedMs",
						"hostname",
						"level",
						"msg",
						"pid",
						"provider",
						"stage",
						"time",
					]);
					expect(record).toMatchObject({
						category: "canonical-phase",
						cacheType: "jellyfin",
						provider: "jellyfin",
						msg: "Provider canonical refresh phase",
					});
					expect(Number.isSafeInteger(record.elapsedMs)).toBe(true);
					expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
				}
				const serialized = JSON.stringify(diagnostics);
				for (const value of [
					"fixture-",
					"Fixture",
					f.instance.baseUrl,
					original.attempt.resultMarker,
					f.instance.encryptedApiKey,
					f.instance.encryptionIv,
				]) {
					expect(serialized).not.toContain(value);
				}
				expectProviderReads(f);
			});
		},
	);

	it.each([false, true])(
		"settles failed identity without publication when timing logger throws: %s",
		async (throwTiming) => {
			const f = await fixture(true);
			const records: Record<string, unknown>[] = [];
			const diagnosticLog = pino({ level: "info" }, { write: () => {} });
			diagnosticLog.info = ((record: Record<string, unknown>) => {
				records.push(record);
				if (throwTiming) throw new Error("private timing logger failure");
			}) as typeof diagnosticLog.info;
			await f.run(async () => {
				await f.client.serviceInstance.update({
					where: { id: f.instance.id },
					data: { expectedIdentity: "private-replacement-identity" },
				});
				f.instance.expectedIdentity = "private-replacement-identity";
				const original = await claim(f);
				const result = await refreshOwnedJellyfinCacheWithAttempt(
					{ prisma: f.client, ...f, log: diagnosticLog },
					original.attempt,
				);
				expect(result.complete).toBe(false);
				expect(result.errors).toBe(1);
				expect((await readStatus(f)).lastAttemptResult).toBe("error");
				expect(await f.client.jellyfinCache.count()).toBe(0);
				expect(f.routes.identity).toBe(1);
				expect(f.routes.users).toBe(0);
				expect(records.map((record) => record.stage)).toEqual([
					"preparing-owned-input",
					"before-identity-read",
					"failure-recording",
					"attempt-failed",
				]);
				expect(JSON.stringify(records)).not.toMatch(
					/private-|fixture-|Fixture|http|error|in_progress/,
				);
			});
		},
	);

	// These controls catch collector/publication regressions independently of detached admission.
	for (const runtimeOwned of [false, true]) {
		it(
			runtimeOwned
				? "settles the original claim with a runtime-owned client"
				: "settles the original claim with the production adapter",
			async () => {
				const f = await fixture(runtimeOwned);
				await f.run(async () => {
					const original = await claim(f);
					const result = await refreshOwnedJellyfinCacheWithAttempt(
						{ prisma: f.client, ...f, log },
						original.attempt,
					);
					expect(result.complete).toBe(true);
					expect(result.errors).toBe(0);
					expectSuccessfulClaim(await readStatus(f), original.attempt);
					expect(await f.client.jellyfinCache.count({ where: { instanceId: f.instance.id } })).toBe(
						1,
					);
					expectProviderReads(f);
				});
			},
		);
	}

	// Dropping runtime retention must strand this exact claim after its request returns.
	it("settles the accepted original claim after its runtime request ticket returns", async () => {
		const f = await fixture(true);
		const authority = createProviderPublicationAuthority(f.instance);
		const gate = producerGate();
		let requestReturned = false;
		let producerSawReturnedRequest = false;
		let original: ProviderCacheRefreshAttempt | undefined;
		let producedAttempt: ProviderCacheRefreshAttempt | undefined;
		let result: JellyfinCacheRefreshResult | undefined;
		const admission = await f.run(() =>
			startProviderCacheRefreshInBackground({
				cacheType: "jellyfin",
				log,
				claim: async () => {
					const acquired = await claim(f);
					original = acquired.attempt;
					return acquired;
				},
				produce: async (attempt) => {
					await gate.ready;
					producerSawReturnedRequest = requestReturned;
					producedAttempt = attempt;
					result = await runJellyfinCacheRefreshSingleFlightWithAttempt(
						authority,
						"jellyfin",
						attempt,
						() =>
							refreshOwnedJellyfinCacheWithAttempt(
								{ prisma: f.client, ...f, log, nativeInventoryMode: "force" },
								attempt,
							),
					);
					return result;
				},
			}),
		);
		backgroundTasks.push(admission.backgroundTask);
		requestReturned = true;
		expect(admission.accepted).toBe(true);
		expect(original).toBeDefined();
		const pending = await readStatus(f);
		expect(pending.lastAttemptResult).toBe(original!.resultMarker);
		expect(pending.lastAttemptAt).toEqual(original!.attemptedAt);
		gate.release();
		await admission.backgroundTask;
		expect(producerSawReturnedRequest).toBe(true);
		expect(producedAttempt).toBe(original);
		expect(result?.complete).toBe(true);
		expect(result?.errors).toBe(0);
		expect(result?.nativeInventoryStatus).toBe("scheduled");
		expectSuccessfulClaim(await readStatus(f), original!);
		expect(
			await f.run(() => f.client.jellyfinCache.count({ where: { instanceId: f.instance.id } })),
		).toBe(1);
		const native = await f.run(() =>
			f.client.providerNativeInventoryRun.findMany({
				where: { instanceId: f.instance.id },
				select: { workKey: true, connectionGeneration: true, identityGeneration: true },
				orderBy: { workKey: "asc" },
			}),
		);
		expect(native).toEqual([
			{ workKey: "episode", connectionGeneration: 3, identityGeneration: 7 },
			{ workKey: "library", connectionGeneration: 3, identityGeneration: 7 },
		]);
		expectProviderReads(f);
	});

	// Closing admission must wait for already accepted work and allow its real publication.
	it("drains accepted work after admission closes and settles its original claim", async () => {
		const f = await fixture(true);
		const gate = producerGate();
		let original: ProviderCacheRefreshAttempt | undefined;
		let result: JellyfinCacheRefreshResult | undefined;
		const admission = await f.run(() =>
			startProviderCacheRefreshInBackground({
				cacheType: "jellyfin",
				log,
				claim: async () => {
					const acquired = await claim(f);
					original = acquired.attempt;
					return acquired;
				},
				produce: async (attempt) => {
					await gate.ready;
					result = await refreshOwnedJellyfinCacheWithAttempt(
						{ prisma: f.client, ...f, log },
						attempt,
					);
					return result;
				},
			}),
		);
		backgroundTasks.push(admission.backgroundTask);
		f.runtime!.closeAdmission();
		let drained = false;
		const draining = f.runtime!.drain().then(() => {
			drained = true;
		});
		backgroundTasks.push(draining);
		await new Promise<void>((resolve) => setImmediate(resolve));
		const waitedForProducer = !drained;
		gate.release();
		await admission.backgroundTask;
		await draining;
		expect(waitedForProducer).toBe(true);
		expect(result?.complete).toBe(true);
		expect(result?.errors).toBe(0);
		// Ordinary admission is closed; inspect the owned fixture directly after drain.
		const row = f.db
			.prepare("SELECT * FROM cache_refresh_status WHERE instanceId = ? AND cacheType = ?")
			.get(f.instance.id, "jellyfin") as { lastAttemptResult: string; generationMetadata: string };
		expect(row.lastAttemptResult).toBe("success");
		const metadata = JSON.parse(row.generationMetadata) as JellyfinLibraryGenerationMetadataV1;
		expect(metadata.coverageReceipt.attemptStartedAt).toBe(original!.attemptedAt.toISOString());
		expectProviderReads(f);
	});

	// Provider failure must terminally settle the new claim without replacing last-good data.
	it("records a failed detached attempt while preserving the last-good generation", async () => {
		const f = await fixture(true);
		await f.run(async () => {
			const first = await claim(f);
			expect(
				(await refreshOwnedJellyfinCacheWithAttempt({ prisma: f.client, ...f, log }, first.attempt))
					.complete,
			).toBe(true);
		});
		const baseline = await readStatus(f);
		const rows = await f.run(() =>
			f.client.jellyfinCache.findMany({ where: { instanceId: f.instance.id } }),
		);
		f.providerState.itemsUnavailable = true;
		const gate = producerGate();
		let original: ProviderCacheRefreshAttempt | undefined;
		let result: JellyfinCacheRefreshResult | undefined;
		const admission = await f.run(() =>
			startProviderCacheRefreshInBackground({
				cacheType: "jellyfin",
				log,
				claim: async () => {
					const acquired = await claim(f);
					original = acquired.attempt;
					return acquired;
				},
				produce: async (attempt) => {
					await gate.ready;
					result = await refreshOwnedJellyfinCacheWithAttempt(
						{ prisma: f.client, ...f, log },
						attempt,
					);
					return result;
				},
			}),
		);
		backgroundTasks.push(admission.backgroundTask);
		gate.release();
		await admission.backgroundTask;
		const stored = await readStatus(f);
		expect(result?.complete).toBe(false);
		expect(result?.errors).toBe(1);
		expect(stored.lastAttemptResult).toBe("error");
		expect(stored.lastAttemptAt).toEqual(original!.attemptedAt);
		expect(stored.generationId).toBe(baseline.generationId);
		expect(stored.generationMetadata).toBe(baseline.generationMetadata);
		expect(stored.lastRefreshedAt).toEqual(baseline.lastRefreshedAt);
		expect(
			await f.run(() => f.client.jellyfinCache.findMany({ where: { instanceId: f.instance.id } })),
		).toEqual(rows);
		expect(f.providerState.failedItemRequests).toBeGreaterThan(0);
		expectProviderReads(f);
	});

	// Early exits must release retention; otherwise drain hangs despite no producer.
	for (const category of ["already-running", "superseded", "rejected"] as const) {
		it(`releases retained admission on ${category} without running a producer`, async () => {
			const f = await fixture(true);
			let produced = false;
			await f.run(async () => {
				const request = startProviderCacheRefreshInBackground({
					cacheType: "jellyfin",
					log,
					claim: async () => {
						if (category === "rejected") throw new Error("fixture-only claim failure");
						return category === "superseded"
							? { status: "superseded" as const }
							: {
									status: "already-running" as const,
									attempt: {
										attemptedAt: new Date(),
										resultMarker: "in_progress:00000000-0000-4000-8000-000000000001",
									},
								};
					},
					produce: async () => {
						produced = true;
						return { complete: true, completedAt: new Date() };
					},
				});
				if (category === "already-running") await (await request).backgroundTask;
				else
					await expect(request).rejects.toMatchObject({
						code: category === "superseded" ? "PUBLICATION_SUPERSEDED" : "REFRESH_UNAVAILABLE",
					});
			});
			await f.runtime!.drain();
			expect(produced).toBe(false);
			expect(f.methods).toEqual([]);
		});
	}
});
