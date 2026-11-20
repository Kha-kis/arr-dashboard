import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { DEFAULT_TRASH_REPO, type TrashQualitySize } from "@arr/shared";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openRestoreRuntime } from "../../../lib/backup/restore-runtime-admission.js";
import { createRuntimePrismaClient } from "../../../lib/backup/restore-runtime-client.js";
import { synchronizeRuntimeSchema } from "../../../lib/backup/runtime-schema-startup.js";
import { createCacheManager } from "../../../lib/trash-guides/cache-manager.js";
import {
	applyQualitySizeToDefinitions,
	buildQualitySizeComparison,
} from "../../../lib/trash-guides/quality-size-matcher.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { registerTrashCacheRoutes } from "../cache-routes.js";
import { registerSettingsRoutes } from "../settings-routes.js";

// Real routes/services/native SQL. Warmup uses a strict synthetic fetch seam
// because its hardwired GitHub cache warmup cannot be disabled through this route.
describe("native TRaSH settings and cache route controls", () => {
	let populationCompleted: (() => void) | undefined;
	const populationLogs: Array<{
		level: number;
		msg: string;
		configType?: string;
		serviceType?: string;
		err?: { name?: string };
	}> = [];
	const releases: Array<() => void> = [];
	const pendingFetches = new Set<Promise<Response>>();
	let shutdownObservation: unknown;
	const findingObservations: unknown[] = [];
	const terminalWaiters: Array<{ label: string; resolve: () => void }> = [];
	const waitForPopulation = (label: string) =>
		new Promise<void>((resolve) => terminalWaiters.push({ label, resolve }));
	const stream = new Writable({
		write(chunk, _encoding, done) {
			for (const line of String(chunk).trim().split("\n")) {
				const entry = JSON.parse(line);
				populationLogs.push(entry);
				if (
					entry.msg.startsWith("Cache auto-population complete (") ||
					entry.msg.startsWith("Cache auto-population canceled (") ||
					entry.msg.startsWith("Cache auto-population incomplete (")
				) {
					populationCompleted?.();
					for (let index = terminalWaiters.length - 1; index >= 0; index--)
						if (entry.msg.endsWith(`(${terminalWaiters[index]!.label})`))
							terminalWaiters.splice(index, 1)[0]!.resolve();
				}
			}
			done();
		},
	});
	const app = Fastify({ logger: { level: "info", stream } });
	const settings = "/api/trash-guides/settings",
		cache = "/api/trash-guides/cache";
	let directory: string, database: string;
	let runtime: Awaited<ReturnType<typeof openRestoreRuntime>>;
	let native: ReturnType<typeof createRuntimePrismaClient>;
	let background: Promise<void> | undefined;
	const run = <T>(fn: () => Promise<T>) => runtime.runOperation(fn);
	const request = (method: string, url: string, body?: unknown) =>
		run(() => createInjectAuthenticated(app)(method, url, { body }));
	const settingsRows = () =>
		run(() => native.prisma.trashSettings.findMany({ orderBy: { userId: "asc" } }));
	const cacheRows = () =>
		run(() =>
			native.prisma.trashCache.findMany({
				orderBy: [{ serviceType: "asc" }, { configType: "asc" }],
			}),
		);
	function repositoryResponses(owner: string, marker: string) {
		const expected = new Map<string, unknown>();
		for (const service of ["radarr", "sonarr"]) {
			const values: Record<string, unknown> = {
				cf: { trash_id: "synthetic-cf", name: `Synthetic ${marker} CF`, specifications: [] },
				"cf-groups": {
					trash_id: "synthetic-group",
					name: `Synthetic ${marker} group`,
					custom_formats: [],
				},
				"quality-size": {
					trash_id: "shared-preset",
					type: "movie",
					qualities: [
						{ quality: "WEBDL-1080p", min: marker === "A" ? 111 : 222, preferred: 333, max: 444 },
					],
				},
				"quality-profiles": {
					trash_id: "synthetic-profile",
					name: `Synthetic ${marker} profile`,
					upgradeAllowed: true,
					cutoff: "WEBDL-1080p",
					items: [],
				},
				naming:
					service === "radarr"
						? { folder: { Shared: `${marker} folder` }, file: { Shared: `${marker} file` } }
						: {
								season: { Shared: `${marker} season` },
								series: { Shared: `${marker} series` },
								episodes: { standard: { Shared: `${marker} episode` }, daily: {}, anime: {} },
							},
			};
			for (const [category, data] of Object.entries(values)) {
				expected.set(
					`https://api.github.com/repos/${owner}/Guides/contents/docs/json/${service}/${category}?ref=master`,
					[{ name: "fixture.json", type: "file" }],
				);
				expected.set(
					`https://raw.githubusercontent.com/${owner}/Guides/refs/heads/master/docs/json/${service}/${category}/fixture.json`,
					data,
				);
			}
			expected.set(
				`https://raw.githubusercontent.com/${owner}/Guides/refs/heads/master/docs/json/${service}/quality-profile-groups/groups.json`,
				[],
			);
			expected.set(
				`https://raw.githubusercontent.com/${owner}/Guides/refs/heads/master/docs/json/${service}/conflicts.json`,
				{ custom_formats: [] },
			);
		}
		return expected;
	}
	function officialPeer(
		options: { hold?: boolean; invalidConflict?: boolean; failure?: "listing" | "file" } = {},
	) {
		const expected = repositoryResponses("TRaSH-Guides", "B");
		if (options.invalidConflict)
			expected.set(
				"https://raw.githubusercontent.com/TRaSH-Guides/Guides/refs/heads/master/docs/json/radarr/conflicts.json",
				{ custom_formats: "invalid synthetic payload" },
			);
		const listing =
			"https://api.github.com/repos/TRaSH-Guides/Guides/contents/docs/json/radarr/quality-size?ref=master";
		const missing =
			"https://raw.githubusercontent.com/TRaSH-Guides/Guides/refs/heads/master/docs/json/radarr/quality-size/missing.json";
		if (options.failure === "listing") expected.set(listing, { malformed: true });
		if (options.failure === "file") {
			expected.set(listing, [
				{ name: "fixture.json", type: "file" },
				{ name: "missing.json", type: "file" },
			]);
			expected.set(missing, { message: "Synthetic file missing" });
		}
		const seen: string[] = [],
			unexpected: string[] = [];
		let aborts = 0;
		let release!: () => void, markStarted!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		releases.push(release);
		vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
			const task = (async () => {
				const url = input instanceof Request ? input.url : String(input);
				if (
					!expected.has(url) ||
					seen.includes(url) ||
					(init?.method && init.method !== "GET") ||
					new Headers(init?.headers).has("authorization")
				) {
					unexpected.push(url);
					return new Response("Unexpected synthetic request", { status: 400 });
				}
				seen.push(url);
				markStarted();
				if (options.hold && seen.length === 1)
					await new Promise<void>((resolve, reject) => {
						const abort = () => {
							aborts++;
							reject(new DOMException("Synthetic fetch aborted", "AbortError"));
						};
						init?.signal?.addEventListener("abort", abort, { once: true });
						void held.then(() => {
							init?.signal?.removeEventListener("abort", abort);
							resolve();
						});
						if (init?.signal?.aborted) abort();
					});
				return Response.json(expected.get(url), {
					status: options.failure === "file" && url === missing ? 404 : 200,
				});
			})();
			pendingFetches.add(task);
			void task.then(
				() => pendingFetches.delete(task),
				() => pendingFetches.delete(task),
			);
			return task;
		});
		background = new Promise<void>((resolve) => {
			populationCompleted = resolve;
		});
		return { release, started, seen, unexpected, expected, aborts: () => aborts };
	}
	beforeAll(async () => {
		directory = await mkdtemp(join(tmpdir(), "trash-control-settings-"));
		database = join(directory, "fixture.db");
		new Database(database).close();
		await synchronizeRuntimeSchema(`file:${database}`);
		runtime = await openRestoreRuntime({ databaseUrl: `file:${database}` });
		await runtime.bindDestination("synthetic-trash-settings-control");
		await runtime.activate();
		native = createRuntimePrismaClient(runtime);
		app.decorate("prisma", native.prisma);
		app.decorate("restoreRuntime", runtime);
		setupAuthInjection(app, { id: "owner" });
		registerTestErrorHandler(app);
		await app.register(registerSettingsRoutes, { prefix: settings });
		await app.register(registerTrashCacheRoutes, { prefix: cache });
		await app.ready();
	});
	beforeEach(async () =>
		run(async () => {
			await native.prisma.trashCache.deleteMany();
			await native.prisma.user.deleteMany();
			await native.prisma.user.createMany({
				data: [
					{ id: "owner", username: "synthetic-owner" },
					{ id: "other", username: "synthetic-other" },
				],
			});
			await native.prisma.trashSettings.create({
				data: {
					userId: "other",
					checkFrequency: 71,
					backupRetention: 31,
					customRepoOwner: "SyntheticOther",
					customRepoName: "PrivateConfig",
					customRepoBranch: "other-branch",
					customRepoMode: "supplementary",
				},
			});
		}),
	);
	afterEach(async () => {
		for (const release of releases.splice(0)) release();
		await Promise.allSettled([...pendingFetches]);
		await background;
		expect(pendingFetches.size).toBe(0);
		vi.unstubAllGlobals();
	});
	afterAll(async () => {
		// The reset's product completion log is emitted only after every awaited
		// fetch/cache write, so drain that chain before closing native workers.
		await background;
		vi.unstubAllGlobals();
		await app.close();
		await native?.close();
		await runtime?.close();
		const checks = [];
		for (const file of [
			database,
			`${database}.arr-restore-runtime/owner.sqlite3`,
			`${database}.arr-restore-runtime/operations.sqlite3`,
		]) {
			const db = new Database(file, { readonly: true, fileMustExist: true });
			try {
				const quick = db.pragma("quick_check"),
					foreign = db.pragma("foreign_key_check");
				expect(quick).toEqual([{ quick_check: "ok" }]);
				expect(foreign).toEqual([]);
				checks.push({ file, quick, foreign });
			} finally {
				db.close();
				expect(db.open).toBe(false);
			}
		}
		expect(directory.startsWith(join(tmpdir(), "trash-control-settings-"))).toBe(true);
		await rm(directory, { recursive: true, force: false });
		if (process.env.ARR_AUTOMATION_EVIDENCE_DIR)
			await writeFile(
				join(process.env.ARR_AUTOMATION_EVIDENCE_DIR, "settings-control-closure.json"),
				JSON.stringify({
					nativeClosed: true,
					runtimeClosed: true,
					backgroundJoined: true,
					pendingFetches: pendingFetches.size,
					shutdownObservation,
					findingObservations,
					populationLogs,
					checks,
					cleanupRemoved: !existsSync(directory),
				}),
			);
	});
	it("S1 creates default settings then persists explicit PATCH/current readback for only the session owner", async () => {
		const before = await settingsRows();
		const defaults = await request("GET", settings);
		expect(defaults.statusCode).toBe(200);
		expect(defaults.json()).toMatchObject({
			defaultRepo: DEFAULT_TRASH_REPO,
			settings: {
				userId: "owner",
				checkFrequency: 12,
				autoRefreshCache: true,
				notifyOnUpdates: true,
				notifyOnSyncFail: true,
				backupRetention: 10,
				backupRetentionDays: 30,
				customRepoOwner: null,
				customRepoName: null,
				customRepoBranch: null,
				customRepoMode: "fork",
			},
		});
		const updates = {
			checkFrequency: 24,
			autoRefreshCache: false,
			notifyOnUpdates: false,
			notifyOnSyncFail: false,
			backupRetention: 7,
			backupRetentionDays: 0,
		};
		const patched = await request("PATCH", settings, updates);
		expect(patched.statusCode).toBe(200);
		expect(patched.json()).toMatchObject({
			settings: { userId: "owner", ...updates },
			cacheCleared: false,
		});
		const read = await request("GET", settings);
		expect(read.statusCode).toBe(200);
		expect(read.json().settings).toEqual(patched.json().settings);
		expect(
			await run(() =>
				native.prisma.trashSettings.findUniqueOrThrow({ where: { userId: "owner" } }),
			),
		).toMatchObject(updates);
		expect((await settingsRows()).filter((s) => s.userId === "other")).toEqual(before);
		expect(await cacheRows()).toEqual([]);
	});
	it("S2 rejects invalid settings without changing native config or current readback", async () => {
		expect((await request("GET", settings)).statusCode).toBe(200);
		const before = await settingsRows(),
			read = (await request("GET", settings)).json();
		for (const body of [
			{ checkFrequency: 0 },
			{ backupRetention: 101 },
			{ backupRetentionDays: -1 },
			{ customRepoOwner: "invalid/owner" },
			{ customRepoMode: "invalid" },
		])
			expect((await request("PATCH", settings, body)).statusCode).toBe(400);
		expect(await settingsRows()).toEqual(before);
		expect((await request("GET", settings)).json()).toEqual(read);
		expect(await cacheRows()).toEqual([]);
	});
	it("S3 resets only owner repository fields and drains strictly synthetic official-repo cache warmup", async () => {
		await run(async () => {
			await native.prisma.trashSettings.create({
				data: {
					userId: "owner",
					checkFrequency: 27,
					backupRetention: 9,
					backupRetentionDays: 0,
					notifyOnSyncFail: false,
					customRepoOwner: "SyntheticSelected",
					customRepoName: "SelectedConfig",
					customRepoBranch: "selected-branch",
					customRepoMode: "supplementary",
				},
			});
			await createCacheManager(native.prisma).set("RADARR", "CUSTOM_FORMATS", [
				{ name: "Synthetic old cache" },
			]);
		});
		const before = await settingsRows();
		const peer = officialPeer({ hold: true });
		const response = await request("POST", `${settings}/reset-repo`);
		await peer.started;
		expect(response.statusCode).toBe(200);
		expect(await run(() => native.prisma.trashCache.count())).toBe(0);
		expect(
			populationLogs.some((log) => log.msg.startsWith("Cache auto-population complete (")),
		).toBe(false);
		peer.release();
		await background;
		vi.unstubAllGlobals();
		expect(response.statusCode).toBe(200);
		expect(response.json().cacheEntriesCleared).toBe(1);
		expect(peer.unexpected).toEqual([]);
		expect(peer.seen.sort()).toEqual([...peer.expected.keys()].sort());
		const after = await settingsRows();
		expect(after.find((s) => s.userId === "other")).toEqual(
			before.find((s) => s.userId === "other"),
		);
		const selected = before.find((s) => s.userId === "owner")!;
		expect(after.find((s) => s.userId === "owner")).toEqual({
			...selected,
			customRepoOwner: null,
			customRepoName: null,
			customRepoBranch: null,
			customRepoMode: "fork",
			updatedAt: expect.any(Date),
		});
		expect((await request("GET", settings)).json().settings).toEqual(response.json().settings);
		expect(await run(() => native.prisma.trashCache.count())).toBe(14);
	});
	it("S4 repository-change warmup records a failed category without false publication, then explicit reset recovers", async () => {
		await run(() =>
			native.prisma.trashSettings.create({
				data: { userId: "owner", customRepoOwner: "SyntheticOld" },
			}),
		);
		const before = (await settingsRows()).find((s) => s.userId === "other");
		const logStart = populationLogs.length;
		const failed = officialPeer({ invalidConflict: true });
		const changed = await request("PATCH", settings, {
			customRepoOwner: "TRaSH-Guides",
			customRepoName: "Guides",
			customRepoBranch: "master",
		});
		expect(changed.statusCode).toBe(200);
		expect(changed.json().cacheCleared).toBe(true);
		await background;
		expect(failed.unexpected).toEqual([]);
		expect(failed.seen.sort()).toEqual([...failed.expected.keys()].sort());
		expect(await run(() => native.prisma.trashCache.count())).toBe(13);
		expect(
			await run(() =>
				native.prisma.trashCache.findUnique({
					where: { serviceType_configType: { serviceType: "RADARR", configType: "CONFLICTS" } },
				}),
			),
		).toBeNull();
		const categoryLogs = populationLogs
			.slice(logStart)
			.filter((log) => log.serviceType === "RADARR" && log.configType === "CONFLICTS");
		expect(
			categoryLogs.some(
				(log) => log.msg === "Failed to auto-populate cache entry (repo config change)" && log.err,
			),
		).toBe(true);
		expect(categoryLogs.some((log) => log.msg === "Auto-populated cache entry")).toBe(false);
		const recovered = officialPeer();
		const reset = await request("POST", `${settings}/reset-repo`);
		expect(reset.statusCode).toBe(200);
		expect(reset.json().cacheEntriesCleared).toBe(13);
		await background;
		expect(recovered.unexpected).toEqual([]);
		expect(recovered.seen.sort()).toEqual([...recovered.expected.keys()].sort());
		expect(await run(() => native.prisma.trashCache.count())).toBe(14);
		expect((await settingsRows()).find((s) => s.userId === "other")).toEqual(before);
	});
	it("C1 binds DELETE to its global service/config key and preserves other cached selections", async () => {
		await run(async () => {
			const manager = createCacheManager(native.prisma);
			await manager.set("RADARR", "CUSTOM_FORMATS", [{ name: "Synthetic selected" }]);
			await manager.set("RADARR", "CF_GROUPS", [{ name: "Synthetic peer config" }]);
			await manager.set("SONARR", "CUSTOM_FORMATS", [{ name: "Synthetic peer service" }]);
		});
		const before = await cacheRows();
		const read = await request("GET", `${cache}/RADARR/CUSTOM_FORMATS`);
		expect(read.statusCode).toBe(200);
		expect(read.json()).toMatchObject({ cached: true, data: [{ name: "Synthetic selected" }] });
		const deleted = await request("DELETE", `${cache}/RADARR/CUSTOM_FORMATS`);
		expect(deleted.statusCode).toBe(200);
		expect(deleted.json()).toMatchObject({ serviceType: "RADARR", configType: "CUSTOM_FORMATS" });
		// A missing keyed GET auto-fetches upstream. /entries is the existing
		// non-fetching GET readback for absence; do not trigger an unrelated refresh.
		expect((await request("DELETE", `${cache}/RADARR/CUSTOM_FORMATS`)).statusCode).toBe(404);
		// Compare exact peers before GET /entries legitimately touches their read timestamps.
		expect(await cacheRows()).toEqual(
			before.filter((r) => !(r.serviceType === "RADARR" && r.configType === "CUSTOM_FORMATS")),
		);
		const entries = await request("GET", `${cache}/entries?serviceType=RADARR`);
		expect(entries.statusCode).toBe(200);
		expect(entries.json().map((e: { configType: string }) => e.configType)).toEqual(["CF_GROUPS"]);
		expect((await request("GET", `${cache}/SONARR/CUSTOM_FORMATS`)).json()).toMatchObject({
			cached: true,
			data: [{ name: "Synthetic peer service" }],
		});
	});
	it("DS01 joins canceled fork-A before resetting/populating B and retains B preview/action data", async () => {
		await run(() =>
			native.prisma.trashSettings.create({
				data: { userId: "owner", checkFrequency: 27, notifyOnSyncFail: false },
			}),
		);
		const other = (await settingsRows()).find((s) => s.userId === "other");
		const expected = new Map([
			...repositoryResponses("SyntheticA", "A"),
			...repositoryResponses("TRaSH-Guides", "B"),
		]);
		let release!: () => void,
			entered!: () => void,
			aborts = 0;
		const held = new Promise<void>((resolve) => {
				release = resolve;
			}),
			started = new Promise<void>((resolve) => {
				entered = resolve;
			});
		releases.push(release);
		const seen: string[] = [],
			unexpected: string[] = [];
		vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
			const task = (async () => {
				const url = input instanceof Request ? input.url : String(input);
				if (
					!expected.has(url) ||
					seen.includes(url) ||
					(init?.method && init.method !== "GET") ||
					new Headers(init?.headers).has("authorization")
				) {
					unexpected.push(url);
					return new Response("Unexpected synthetic fetch", { status: 400 });
				}
				seen.push(url);
				if (
					url ===
					"https://api.github.com/repos/SyntheticA/Guides/contents/docs/json/radarr/cf?ref=master"
				) {
					const abort = () => {
						aborts++;
					};
					init?.signal?.addEventListener("abort", abort, { once: true });
					entered();
					try {
						await held;
						init?.signal?.throwIfAborted();
					} finally {
						init?.signal?.removeEventListener("abort", abort);
					}
				}
				return Response.json(expected.get(url));
			})();
			pendingFetches.add(task);
			void task.then(
				() => pendingFetches.delete(task),
				() => pendingFetches.delete(task),
			);
			return task;
		});
		const aDone = waitForPopulation("repo config change"),
			bDone = waitForPopulation("reset to official repo");
		background = Promise.all([aDone, bDone]).then(() => {});
		const a = await request("PATCH", settings, {
			customRepoOwner: "SyntheticA",
			customRepoName: "Guides",
			customRepoBranch: "master",
		});
		expect(a.statusCode).toBe(200);
		await started;
		const ordinary = await request("PATCH", settings, { backupRetention: 9 });
		expect(ordinary.statusCode).toBe(200);
		expect(ordinary.json().cacheCleared).toBe(false);
		const unchanged = await request("PATCH", settings, { customRepoOwner: "SyntheticA" });
		expect(unchanged.statusCode).toBe(200);
		expect(unchanged.json().cacheCleared).toBe(false);
		expect(aborts).toBe(0);
		let bSettled = false;
		const b = request("POST", `${settings}/reset-repo`).then((response) => {
			bSettled = true;
			return response;
		});
		let beforeRelease: unknown,
			settledBeforeRelease = false;
		try {
			await vi.waitFor(() => expect(aborts > 0 || bSettled).toBe(true));
			settledBeforeRelease = bSettled;
			beforeRelease = (await settingsRows()).find((s) => s.userId === "owner")?.customRepoOwner;
			if (aborts === 0) await bDone; // On the faulty parent, force B to finish before releasing obsolete A.
		} finally {
			release();
			await b;
			await background;
		}
		expect.soft(aborts).toBe(1);
		expect.soft(settledBeforeRelease).toBe(false);
		expect.soft(beforeRelease).toBe("SyntheticA");
		expect(unexpected).toEqual([]);
		expect(pendingFetches.size).toBe(0);
		const selected = (await settingsRows()).find((s) => s.userId === "owner");
		expect(selected).toMatchObject({
			customRepoOwner: null,
			checkFrequency: 27,
			notifyOnSyncFail: false,
			backupRetention: 9,
		});
		expect((await settingsRows()).find((s) => s.userId === "other")).toEqual(other);
		const manager = createCacheManager(native.prisma);
		const qualities = await run(() => manager.get<TrashQualitySize[]>("RADARR", "QUALITY_SIZE"));
		const naming = await run(() =>
			manager.get<Array<{ file: { Shared: string } }>>("RADARR", "NAMING_PRESETS"),
		);
		expect.soft(naming?.[0]?.file.Shared).toBe("B file");
		expect.soft(qualities?.[0]?.qualities[0]?.min).toBe(222);
		const definitions = [{ id: 7, title: "WEBDL-1080p", minSize: 0, preferredSize: 0, maxSize: 0 }];
		expect
			.soft(
				buildQualitySizeComparison(qualities![0]!.qualities, definitions).comparisons[0]?.trash.min,
			)
			.toBe(222);
		expect
			.soft(
				applyQualitySizeToDefinitions(qualities![0]!.qualities, definitions).updated[0]?.minSize,
			)
			.toBe(222);
		findingObservations.push({
			finding: "DS01",
			aborts,
			settledBeforeRelease,
			beforeRelease,
			currentMin: qualities?.[0]?.qualities[0]?.min,
			pendingFetches: pendingFetches.size,
		});
	});
	it.each(["listing", "file"] as const)(
		"DS02 refuses failed %s category without fresh empty/partial publication, then explicit reset recovers",
		async (failure) => {
			const logStart = populationLogs.length,
				other = (await settingsRows()).find((s) => s.userId === "other");
			const failed = officialPeer({ failure });
			expect((await request("POST", `${settings}/reset-repo`)).statusCode).toBe(200);
			await background;
			const rows = await cacheRows(),
				current = rows.find(
					(row) => row.serviceType === "RADARR" && row.configType === "QUALITY_SIZE",
				);
			expect.soft(current).toBeUndefined();
			expect.soft(rows).toHaveLength(13);
			expect(failed.unexpected).toEqual([]);
			const logs = populationLogs.slice(logStart);
			expect
				.soft(
					logs.some(
						(log) =>
							log.serviceType === "RADARR" &&
							log.configType === "QUALITY_SIZE" &&
							log.msg === "Auto-populated cache entry",
					),
				)
				.toBe(false);
			expect
				.soft(
					logs.some(
						(log) => log.msg === "Cache auto-population incomplete (reset to official repo)",
					),
				)
				.toBe(true);
			expect
				.soft(
					logs.some((log) => log.msg === "Cache auto-population complete (reset to official repo)"),
				)
				.toBe(false);
			const recovery = officialPeer();
			expect((await request("POST", `${settings}/reset-repo`)).statusCode).toBe(200);
			await background;
			expect(await cacheRows()).toHaveLength(14);
			expect(recovery.unexpected).toEqual([]);
			const quality = await run(() =>
				createCacheManager(native.prisma).get<TrashQualitySize[]>("RADARR", "QUALITY_SIZE"),
			);
			expect(quality?.[0]?.qualities[0]?.min).toBe(222);
			expect((await settingsRows()).find((s) => s.userId === "other")).toEqual(other);
			findingObservations.push({
				finding: "DS02",
				failure,
				failedPublished: Boolean(current),
				failedCount: rows.length,
				recoveredCount: (await cacheRows()).length,
			});
		},
	);
	it("S5 held post-response warmup permits physical close within the six-second launcher budget", {
		timeout: 15_000,
	}, async () => {
		const logStart = populationLogs.length;
		const peer = officialPeer({ hold: true });
		const response = await request("POST", `${settings}/reset-repo`);
		expect(response.statusCode).toBe(200);
		await peer.started;
		let closed = false;
		let closedAtMs: number | undefined;
		const started = Date.now();
		const closing = (async () => {
			await app.close();
			await runtime.close();
			await native.close();
			closed = true;
			closedAtMs = Date.now() - started;
		})();
		let closedAtBudget = false;
		try {
			// Joined observation timer, not a race that detaches the real shutdown.
			await new Promise<void>((resolve) => setTimeout(resolve, 6_000));
			closedAtBudget = closed;
			shutdownObservation = {
				elapsedMs: Date.now() - started,
				closedAtBudget,
				abortedFetches: peer.aborts(),
				closedAtMs,
			};
		} finally {
			peer.release();
			await background;
			await closing;
		}
		expect(peer.unexpected).toEqual([]);
		expect(pendingFetches.size).toBe(0);
		expect(peer.aborts()).toBe(1);
		expect(peer.seen).toHaveLength(1);
		expect(
			populationLogs.slice(logStart).some((log) => log.msg === "Auto-populated cache entry"),
		).toBe(false);
		const closedDb = new Database(database, { readonly: true, fileMustExist: true });
		try {
			expect(closedDb.prepare("SELECT COUNT(*) AS count FROM trash_cache").get()).toEqual({
				count: 0,
			});
		} finally {
			closedDb.close();
		}
		expect(
			closedAtBudget,
			"physical close must not wait beyond launcher budget for a held warmup fetch",
		).toBe(true);
	});
});
