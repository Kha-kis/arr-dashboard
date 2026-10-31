import { type ChildProcess, execFile, fork } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prismaPlugin } from "../../../plugins/prisma.js";
import {
	withCleanupMaintenanceGuard,
	withCleanupOperationGuard,
	withIndependentCleanupOperationGuard,
} from "../../library-cleanup/cleanup-maintenance-gate.js";
import {
	clearFileIdIndexCache,
	readCachedFileIdCoverage,
	serializeFileIdIndex,
} from "../../library-sync/infohash-backfill-by-inode.js";
import {
	openRestoreRuntime,
	type RestoreRuntime,
	type RetainedRestoreRuntimeOperation,
	retainRestoreRuntimeOperation,
} from "../restore-runtime-admission.js";
import {
	registerRestoreBootstrapPlugin,
	registerRestoreRuntimeActivation,
} from "../restore-runtime-bootstrap.js";
import { createRuntimePrismaClient } from "../restore-runtime-client.js";
import { acquireSqliteRestoreRuntimeOwnership } from "../restore-runtime-sqlite.js";
import { seedRuntimeJellyfinFinalization } from "./fixtures/restore-runtime-finalizer-fixture.js";

describe("actual Fastify native runtime Prisma adoption", () => {
	let directory: string;
	let template: string;
	let path: string;
	let url: string;
	let app: FastifyInstance;
	let supplied: RestoreRuntime | undefined;
	let sequence = 0;
	const actors: Array<{ child: ChildProcess; exit: Promise<void> }> = [];
	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "arr-runtime-application-"));
		template = join(directory, "template.db");
		const api = resolve(import.meta.dirname, "../../../..");
		const source = readFileSync(join(api, "prisma/schema.prisma"), "utf8").replace(
			/generator client \{[\s\S]*?\}/,
			'generator client {\n provider = "prisma-client"\n output = "./unused-client"\n}',
		);
		const schema = join(directory, "schema.prisma"),
			config = join(directory, "safe.config.ts");
		writeFileSync(schema, source, { mode: 0o600 });
		writeFileSync(config, "export default {datasource:{url:process.env.DATABASE_URL}};\n", {
			mode: 0o600,
		});
		const env = Object.fromEntries(
			["PATH", "LANG", "LC_ALL", "TZ"].flatMap((key) =>
				process.env[key] ? [[key, process.env[key]]] : [],
			),
		);
		await promisify(execFile)(
			process.execPath,
			[
				join(api, "node_modules/prisma/build/index.js"),
				"db",
				"push",
				"--schema",
				schema,
				"--config",
				config,
				"--url",
				`file:${template}`,
			],
			{
				cwd: directory,
				env: { ...env, DATABASE_URL: `file:${template}`, CHECKPOINT_DISABLE: "1" },
				timeout: 60000,
			},
		);
		chmodSync(template, 0o600);
	}, 90000);
	beforeEach(() => {
		path = join(directory, `fixture-${++sequence}.db`);
		copyFileSync(template, path);
		chmodSync(path, 0o600);
		url = `file:${path}`;
		app = Fastify({ logger: false });
		app.decorate("config", {
			NODE_ENV: "test",
			API_HOST: "127.0.0.1",
			API_PORT: 0,
			API_CORS_ORIGIN: [],
			API_RATE_LIMIT_MAX: 200,
			API_RATE_LIMIT_WINDOW: "1 minute",
			DATABASE_URL: url,
			SQLITE_JOURNAL_MODE: "preserve",
			SESSION_COOKIE_NAME: "arr_session",
			SESSION_TTL_HOURS: 24,
			PASSWORD_POLICY: "strict",
			TRUST_PROXY: false,
			COOKIE_SECURE: false,
			APP_URL: "http://127.0.0.1",
			TMDB_BASE_URL: "https://synthetic.invalid",
			TMDB_IMAGE_BASE_URL: "https://synthetic.invalid",
		});
	});
	afterEach(async () => {
		for (const { child, exit } of actors.splice(0)) {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			await exit;
		}
		await app?.close();
		await supplied?.close();
		supplied = undefined;
		clearFileIdIndexCache("fixture-hydration");
		vi.restoreAllMocks();
	});
	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});
	function count() {
		const observer = new Database(path, { readonly: true });
		try {
			return (observer.prepare('SELECT COUNT(*) AS count FROM "User"').get() as { count: number })
				.count;
		} finally {
			observer.close();
		}
	}
	async function activate(runtime: RestoreRuntime) {
		await runtime.bindDestination("fixture-application");
		await runtime.activate();
	}
	it("the actual finalizer refuses an unbound worker before publication database access", async () => {
		const { executeJellyfinEpisodeFinalization } = await import(
			"../../jellyfin/jellyfin-episode-finalizer-worker.js"
		);
		const result = await executeJellyfinEpisodeFinalization({
			databaseUrl: url,
			userId: "synthetic",
			runId: "synthetic",
			scopes: [],
			attempt: { attemptedAt: new Date(), resultMarker: "synthetic" },
			now: new Date(),
			instance: {
				id: "synthetic",
				userId: "synthetic",
				service: "JELLYFIN",
				baseUrl: "http://127.0.0.1:1",
				apiKey: "synthetic",
				enabled: true,
				encryptedApiKey: "synthetic",
				encryptionIv: "synthetic",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				expectedIdentity: null,
				identityStatus: "UNVERIFIED",
				connectionGeneration: 1,
				identityGeneration: 1,
			},
		});
		expect(result).toMatchObject({
			status: "failed",
			failurePhase: "connection",
			failureStage: "connect",
		});
		expect(count()).toBe(0);
	});
	it("native worker attachment refuses context-free, expired and foreign-destination callers", async () => {
		await app.register(prismaPlugin);
		await activate(app.restoreRuntime);
		const { attachRestoreRuntimeWorker } = await import("../restore-runtime-admission.js");
		await expect(attachRestoreRuntimeWorker(url)).rejects.toThrow();
		await app.restoreRuntime.runOperation(async () => {
			await expect(attachRestoreRuntimeWorker(`file:${template}`)).rejects.toThrow();
		});
		let expired: Promise<unknown> | undefined;
		await app.restoreRuntime.runOperation(async () => {
			expired = new Promise<unknown>((resolve) => {
				setImmediate(() => {
					void attachRestoreRuntimeWorker(url).then(
						() => resolve(true),
						() => resolve(false),
					);
				});
			});
		});
		expect(await expired).toBe(false);
		expect(count()).toBe(0);
	});
	it.each([
		"running",
		"starting",
		"parent-loss",
		"port-loss",
		"wrong-epoch",
		"wrong-fence",
		"wrong-url",
		"child-loss",
		"forced-stop",
		"busy-loss",
		"borrowed-loss",
	] as const)(
		"real native follower confines admission and physical lifetime: %s",
		async (mode) => {
			await app.register(prismaPlugin);
			const runtime = app.restoreRuntime;
			if (mode === "starting") await runtime.bindDestination("fixture-application");
			else await activate(runtime);
			const admission = await import("../restore-runtime-admission.js");
			const actor = process.env.SQLITE_RESTORE_WORKER_FOLLOWER_ACTOR_FILE;
			if (!actor) throw new Error("Native follower fixture bundle missing");
			let worker: Worker | undefined;
			let exit: Promise<number> | undefined;
			let readyResolve!: (value: unknown) => void;
			const ready = new Promise<unknown>((resolve) => {
				readyResolve = resolve;
			});
			let bridge: Awaited<ReturnType<typeof admission.attachRestoreRuntimeWorker>> | undefined;
			const run =
				mode === "starting"
					? runtime.runStarting.bind(runtime)
					: runtime.runOperation.bind(runtime);
			const operation = run(async () => {
				bridge = await admission.attachRestoreRuntimeWorker();
				const binding = { ...bridge.binding };
				if (mode === "wrong-epoch")
					binding.record = {
						...binding.record,
						runtimeEpoch: "11111111-1111-4111-8111-111111111111",
					};
				if (mode === "wrong-fence") binding.fence = new SharedArrayBuffer(8);
				if (mode === "wrong-url") binding.databaseUrl = `${url}.wrong`;
				worker = new Worker(new URL(`file://${actor}`), {
					workerData: { binding, databaseUrl: url },
					transferList: [binding.port],
				});
				exit = new Promise<number>((resolve, reject) => {
					worker!.once("exit", resolve);
					worker!.once("error", reject);
				});
				worker.once("message", readyResolve);
				try {
					await exit;
				} finally {
					await bridge.close();
				}
			});
			const observed = operation.catch((error) => {
				readyResolve({ error });
				throw error;
			});
			void observed.catch(() => {});
			let closing: Promise<void> | undefined;
			try {
				const result = await ready;
				if (mode.startsWith("wrong-")) {
					expect(result).toEqual({ failed: true });
					await operation;
					expect(count()).toBe(0);
					return;
				}
				expect(result).toEqual({
					ready: true,
					noTicket: true,
					noActivation: true,
					noBinding: true,
				});
				expect(count()).toBe(1);
				if (mode === "busy-loss" || mode === "borrowed-loss") {
					const held = new Promise<unknown>((resolve) => worker!.once("message", resolve));
					worker!.postMessage(mode === "busy-loss" ? "busy" : "borrowed");
					expect(await held).toEqual({ held: true });
					const attempted = new Promise<unknown>((resolve) => worker!.once("message", resolve));
					admission.getRestoreRuntimeClientContext(runtime).unavailable();
					worker!.postMessage("resume");
					expect(await attempted).toEqual({ written: false });
					expect(count()).toBe(1);
				}
				if (mode === "parent-loss") admission.getRestoreRuntimeClientContext(runtime).unavailable();
				if (mode === "port-loss") await bridge!.close();
				if (mode === "parent-loss" || mode === "port-loss" || mode === "child-loss") {
					const attempted = new Promise<unknown>((resolve) => worker!.once("message", resolve));
					worker!.postMessage(mode === "child-loss" ? "lose" : "write");
					expect(await attempted).toEqual({ written: false });
					expect(count()).toBe(1);
					if (mode !== "port-loss")
						await expect(runtime.runOperation(() => app.prisma.user.count())).rejects.toThrow();
				}
				if (mode === "forced-stop") {
					await worker!.terminate();
					await operation;
				} else {
					let settled = false;
					// Fastify may already be auto-closing after loss. Join the actual
					// native lifetime, not a repeated framework close's early return.
					closing = (mode === "starting" ? runtime.activate() : runtime.close()).then(() => {
						settled = true;
					});
					for (let turn = 0; turn < 8; turn++)
						await new Promise<void>((resolve) => setImmediate(resolve));
					expect(settled).toBe(false);
					await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
					worker!.postMessage("release");
					await expect(exit).resolves.toBe(0);
					await operation;
					await closing;
				}
				await app.close();
				await runtime.close();
				const successor = await acquireSqliteRestoreRuntimeOwnership(url);
				await successor.close();
			} finally {
				if (worker && worker.threadId !== -1) await worker.terminate();
				await exit?.catch(() => {});
				await observed.catch(() => {});
				await closing?.catch(() => {});
			}
		},
		30000,
	);
	it.each(["startup", "running"] as const)(
		"native busy-response follower %s refuses unverified work without poisoning retry",
		async (mode) => {
			let losses = 0;
			supplied = await openRestoreRuntime({
				databaseUrl: url,
				onUnavailable: () => {
					losses++;
				},
			});
			app.decorate("restoreRuntime", supplied);
			await app.register(prismaPlugin);
			await activate(app.restoreRuntime);
			const { attachRestoreRuntimeWorker } = await import("../restore-runtime-admission.js");
			const actor = process.env.SQLITE_RESTORE_WORKER_FOLLOWER_ACTOR_FILE;
			if (!actor) throw new Error("Native follower bundle missing");
			let worker: Worker | undefined;
			let exit: Promise<number> | undefined;
			let writer: Database.Database | undefined;
			let readyResolve!: (value: unknown) => void;
			const ready = new Promise<unknown>((resolve) => {
				readyResolve = resolve;
			});
			const operation = app.restoreRuntime.runOperation(async () => {
				const bridge = await attachRestoreRuntimeWorker(url);
				try {
					if (mode === "startup") {
						writer = new Database(path, { timeout: 0 });
						writer.exec("BEGIN EXCLUSIVE");
					}
					worker = new Worker(new URL(`file://${actor}`), {
						workerData: { binding: bridge.binding, databaseUrl: url },
						transferList: [bridge.binding.port],
					});
					exit = new Promise<number>((resolve, reject) => {
						worker!.once("exit", resolve);
						worker!.once("error", reject);
					});
					worker.once("message", readyResolve);
					await exit;
				} finally {
					await bridge.close();
				}
			});
			void operation.catch((error) => readyResolve({ error }));
			try {
				const result = await ready;
				if (mode === "startup") {
					expect(result).toEqual({ failed: true });
					await operation;
					expect(losses).toBe(0);
					writer!.exec("ROLLBACK");
					writer!.close();
					writer = undefined;
					expect(count()).toBe(0);
					await app.restoreRuntime.runOperation(() =>
						app.prisma.user.create({ data: { username: "fixture-startup-retry" } }),
					);
					expect(count()).toBe(1);
				} else {
					expect(result).toMatchObject({ ready: true });
					writer = new Database(path, { timeout: 0 });
					writer.exec("BEGIN EXCLUSIVE");
					const refused = new Promise<unknown>((resolve) => worker!.once("message", resolve));
					worker!.postMessage("write");
					expect(await refused).toEqual({ written: false });
					expect(losses).toBe(0);
					writer.exec("ROLLBACK");
					writer.close();
					writer = undefined;
					expect(count()).toBe(1);
					const retried = new Promise<unknown>((resolve) => worker!.once("message", resolve));
					worker!.postMessage("write");
					expect(await retried).toEqual({ written: true });
					expect(count()).toBe(2);
					worker!.postMessage("release");
					await operation;
				}
				expect(losses).toBe(0);
				await app.restoreRuntime.runOperation(() => app.prisma.user.count());
			} finally {
				if (writer) {
					if (writer.inTransaction) writer.exec("ROLLBACK");
					writer.close();
				}
				if (worker && worker.threadId !== -1) await worker.terminate();
				await exit?.catch(() => {});
				await operation.catch(() => {});
			}
		},
		15000,
	);
	it.each(["ordinary-close", "parent-loss"] as const)(
		"the actual finalizer joins native admission through a held provider read and thread exit: %s",
		async (mode) => {
			await app.register(prismaPlugin);
			await activate(app.restoreRuntime);
			let seen!: () => void, finish!: () => void;
			const requestSeen = new Promise<void>((resolve) => {
				seen = resolve;
			});
			const responseAllowed = new Promise<void>((resolve) => {
				finish = resolve;
			});
			let requests = 0;
			const endpoint = createHttpServer(async (_request, response) => {
				requests++;
				seen();
				await responseAllowed;
				response.writeHead(503);
				response.end();
			});
			await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
			const address = endpoint.address();
			if (!address || typeof address === "string") throw new Error("Fixture listener");
			const baseUrl = `http://127.0.0.1:${address.port}`;
			const saved = await app.restoreRuntime.runOperation(async () => {
				const user = await app.prisma.user.create({ data: { username: "fixture-finalizer" } });
				return await app.prisma.serviceInstance.create({
					data: {
						userId: user.id,
						service: "JELLYFIN",
						label: "synthetic",
						baseUrl,
						encryptedApiKey: "synthetic",
						encryptionIv: "synthetic",
						enabled: true,
						expectedIdentity: "synthetic",
						identityStatus: "VERIFIED",
					},
				});
			});
			const { runJellyfinEpisodeFinalizerWorker } = await import(
				"../../jellyfin/jellyfin-episode-finalizer-worker-transport.js"
			);
			const actor = process.env.SQLITE_RESTORE_ACTUAL_FINALIZER_FILE;
			if (!actor) throw new Error("Actual finalizer bundle missing");
			let worker: Worker | undefined;
			const operation = app.restoreRuntime.runOperation(() =>
				runJellyfinEpisodeFinalizerWorker(
					{
						databaseUrl: url,
						userId: saved.userId,
						instance: { ...saved, service: "JELLYFIN", apiKey: "synthetic" },
						runId: "synthetic",
						scopes: [],
						attempt: { attemptedAt: new Date(), resultMarker: "synthetic" },
						now: new Date(),
					},
					{
						createWorker: (_target, workerData, transferList) => {
							worker = new Worker(new URL(`file://${actor}`), { workerData, transferList });
							return worker;
						},
					},
				),
			);
			void operation.catch(() => {});
			let closing: Promise<void> | undefined;
			try {
				await requestSeen;
				const { getRestoreRuntimeClientContext } = await import("../restore-runtime-admission.js");
				const context = getRestoreRuntimeClientContext(app.restoreRuntime);
				let settled = false;
				closing = app.restoreRuntime.close().then(() => {
					settled = true;
				});
				for (let turn = 0; turn < 8; turn++)
					await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
				if (mode === "parent-loss") {
					context.unavailable();
					await expect(operation).rejects.toMatchObject({ category: "worker-failed" });
				} else {
					finish();
					await expect(operation).resolves.toEqual({ status: "identity-unavailable" });
				}
				finish();
				await closing;
				expect(worker!.threadId).toBe(-1);
				expect(requests).toBe(1);
				expect(count()).toBe(1);
				const successor = await acquireSqliteRestoreRuntimeOwnership(url);
				await successor.close();
			} finally {
				finish();
				if (worker && worker.threadId !== -1) await worker.terminate();
				await operation.catch(() => {});
				await closing?.catch(() => {});
				endpoint.closeAllConnections();
				await new Promise<void>((resolve) => endpoint.close(() => resolve()));
			}
		},
		30000,
	);
	it("the actual DELETE-mode finalizer commits a spilled 500-row batch without fencing admission", async () => {
		const witness = new SharedArrayBuffer(16);
		let losses = 0;
		supplied = await openRestoreRuntime({
			databaseUrl: url,
			onUnavailable: () => {
				losses++;
				const observer = new Database(path, { timeout: 0 });
				try {
					observer.prepare("SELECT * FROM RestoreRuntimeControl").all();
				} catch (error) {
					if (error instanceof Database.SqliteError && error.code === "SQLITE_BUSY")
						Atomics.store(new Int32Array(witness), 1, 1);
				} finally {
					observer.close();
				}
			},
		});
		app.decorate("restoreRuntime", supplied);
		await app.register(prismaPlugin);
		await activate(app.restoreRuntime);
		const inspect = new Database(path);
		try {
			expect(inspect.pragma("journal_mode", { simple: true })).toBe("delete");
		} finally {
			inspect.close();
		}
		const endpoint = createHttpServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({ Id: "synthetic-server", ServerName: "Synthetic", Version: "1.0" }),
			);
		});
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		const address = endpoint.address();
		if (!address || typeof address === "string") throw new Error("Fixture listener");
		let physical: Worker | undefined;
		try {
			const seed = await app.restoreRuntime.runOperation(() =>
				seedRuntimeJellyfinFinalization(app.prisma, `http://127.0.0.1:${address.port}`, {
					episodeCount: 500,
					title: "Synthetic".repeat(100),
				}),
			);
			const actor = process.env.SQLITE_RESTORE_ACTUAL_FINALIZER_FILE;
			if (!actor) throw new Error("Actual finalizer bundle missing");
			const { runJellyfinEpisodeFinalizerWorker } = await import(
				"../../jellyfin/jellyfin-episode-finalizer-worker-transport.js"
			);
			const result = await app.restoreRuntime
				.runOperation(() =>
					runJellyfinEpisodeFinalizerWorker(
						{ databaseUrl: url, ...seed },
						{
							createWorker: (_target, workerData, transferList) => {
								// Force actual pager spilling, rather than assuming row size exceeds
								// the native connection's cache. No admission/publication code is mocked.
								const adapter = resolve(
									import.meta.dirname,
									"../../../../node_modules/@prisma/adapter-better-sqlite3/dist/index.mjs",
								);
								const entry = `(async()=>{const {PrismaBetterSqlite3}=await import(${JSON.stringify(new URL(`file://${adapter}`).href)});
					const {workerData}=require("node:worker_threads");
					const words=new Int32Array(workerData.fixtureSpillWitness);
					const Database=(await import("better-sqlite3")).default;
					const connect=PrismaBetterSqlite3.prototype.connect;
					PrismaBetterSqlite3.prototype.connect=async function(){
					 const driver=await connect.call(this);
					 await driver.queryRaw({sql:"PRAGMA cache_size = 8",args:[],argTypes:[]});
					 await driver.queryRaw({sql:"PRAGMA cache_spill = ON",args:[],argTypes:[]});
					 Atomics.store(words,0,1);
					 const instrument=(target)=>{for(const method of ["queryRaw","executeRaw"]){
					  const original=target[method].bind(target);
					  target[method]=async function(query){
					   Atomics.add(words,2,1);if(/^\\s*(INSERT|UPDATE|DELETE)/i.test(query.sql))Atomics.add(words,3,1);
					   const result=await original(query);
					   if(/^\\s*(INSERT|UPDATE|DELETE)/i.test(query.sql)){
					    const observer=new Database(workerData.databaseUrl.slice(5),{timeout:0});
					    try{observer.prepare("SELECT * FROM RestoreRuntimeControl").all();}
					    catch(error){if(error.code==="SQLITE_BUSY")Atomics.store(words,1,1);else throw error;}
					    finally{observer.close();}
					   }return result;
					  };
					 }return target;};
					 const start=driver.startTransaction.bind(driver);
					 driver.startTransaction=async(...args)=>instrument(await start(...args));
					 instrument(driver);
					 return driver;
					};await import(${JSON.stringify(new URL(`file://${actor}`).href)});})();`;
								physical = new Worker(entry, {
									eval: true,
									workerData: { ...workerData, fixtureSpillWitness: witness },
									transferList,
								});
								return physical;
							},
						},
					),
				)
				.then(
					(value) => ({ value }),
					(error: unknown) => ({ error }),
				);
			expect(losses, JSON.stringify(Array.from(new Int32Array(witness)))).toBe(0);
			expect(
				Array.from(new Int32Array(witness)).slice(0, 2),
				JSON.stringify(Array.from(new Int32Array(witness))),
			).toEqual([1, 1]);
			if ("error" in result) throw result.error;
			expect(result.value.status, JSON.stringify(result.value)).toBe("published");
			expect(result.value).toMatchObject({
				status: "published",
				itemCount: 500,
				cleanupFailed: false,
			});
			await app.restoreRuntime.runOperation(async () => {
				expect(
					await app.prisma.jellyfinEpisodeGenerationRow.count({
						where: { generationId: seed.runId },
					}),
				).toBe(500);
				expect(
					await app.prisma.jellyfinNativeWatchRow.count({ where: { runId: seed.runId } }),
				).toBe(500);
				expect(
					await app.prisma.jellyfinNativeWatchPublication.findUnique({
						where: { instanceId: seed.instance.id },
						select: { activeRunId: true },
					}),
				).toEqual({ activeRunId: seed.runId });
			});
		} finally {
			await physical?.terminate();
			await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		}
	}, 30000);
	it("contains an expired WAL staging transaction without losing the parent runtime", async () => {
		const journal = new Database(path);
		try {
			expect(journal.pragma("journal_mode=WAL", { simple: true })).toBe("wal");
		} finally {
			journal.close();
		}
		const lossReasons: string[] = [];
		supplied = await openRestoreRuntime({
			databaseUrl: url,
			onUnavailable: (diagnostic) => lossReasons.push(diagnostic.reason),
		});
		app.decorate("restoreRuntime", supplied);
		await app.register(prismaPlugin);
		await activate(app.restoreRuntime);
		const endpoint = createHttpServer((_request, response) => {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(
				JSON.stringify({ Id: "synthetic-server", ServerName: "Synthetic", Version: "1.0" }),
			);
		});
		await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
		const address = endpoint.address();
		if (!address || typeof address === "string") throw new Error("Fixture listener");
		const witness = new SharedArrayBuffer(32);
		const workers: Worker[] = [];
		try {
			const seed = await app.restoreRuntime.runOperation(() =>
				seedRuntimeJellyfinFinalization(app.prisma, `http://127.0.0.1:${address.port}`, {
					episodeCount: 500,
				}),
			);
			const actor = process.env.SQLITE_RESTORE_ACTUAL_FINALIZER_FILE;
			if (!actor) throw new Error("Actual finalizer bundle missing");
			const { runJellyfinEpisodeFinalizerWorker } = await import(
				"../../jellyfin/jellyfin-episode-finalizer-worker-transport.js"
			);
			const execute = (slow: boolean) =>
				app.restoreRuntime.runOperation(() =>
					runJellyfinEpisodeFinalizerWorker(
						{ databaseUrl: url, ...seed },
						{
							createWorker: (_target, workerData, transferList) => {
								let worker: Worker;
								if (slow) {
									const adapter = resolve(
										import.meta.dirname,
										"../../../../node_modules/@prisma/adapter-better-sqlite3/dist/index.mjs",
									);
									// Real SQL and real native results. Only return timing is delayed
									// after the first actual watch-row INSERT while its tx is open.
									const entry = `(async()=>{const {PrismaBetterSqlite3}=await import(${JSON.stringify(new URL(`file://${adapter}`).href)});
					const {workerData}=require("node:worker_threads");
					const words=new Int32Array(workerData.fixtureExpiryWitness);
					const connect=PrismaBetterSqlite3.prototype.connect;
					PrismaBetterSqlite3.prototype.connect=async function(){
					 const driver=await connect.call(this);
					 const instrument=(target)=>{for(const method of ["queryRaw","executeRaw"]){
					  const original=target[method].bind(target);
					  target[method]=async function(query){
					   const statement=query.sql.trim().toUpperCase();
					   if(statement==="COMMIT")Atomics.add(words,4,1);
					   if(statement==="ROLLBACK")Atomics.add(words,5,1);
					   const slow=/^\\s*INSERT/i.test(query.sql)&&query.sql.includes('jellyfin_native_watch_rows')&&Atomics.compareExchange(words,0,0,1)===0;
					   if(slow)Atomics.store(words,2,target.client.inTransaction?1:0);
					   const result=await original(query);
					   if(slow){
					    Atomics.store(words,3,target.client.inTransaction?1:0);
					    const began=Date.now();Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5800);
					    Atomics.store(words,1,Date.now()-began);
					    Atomics.store(words,6,target.client.inTransaction?1:0);
					   }return result;
					  };
					 }return target;};
					 const start=driver.startTransaction.bind(driver);
					 driver.startTransaction=async(...args)=>instrument(await start(...args));
					 instrument(driver);return driver;
					};await import(${JSON.stringify(new URL(`file://${actor}`).href)});})();`;
									worker = new Worker(entry, {
										eval: true,
										workerData: { ...workerData, fixtureExpiryWitness: witness },
										transferList,
									});
								} else {
									worker = new Worker(new URL(`file://${actor}`), { workerData, transferList });
								}
								workers.push(worker);
								return worker;
							},
						},
					),
				);
			const failed = await execute(true).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			);
			expect(Atomics.load(new Int32Array(witness), 0), JSON.stringify(failed)).toBe(1);
			expect(Atomics.load(new Int32Array(witness), 1)).toBeGreaterThanOrEqual(5800);
			expect(workers[0]!.threadId).toBe(-1);
			const observer = new Database(path, { readonly: true });
			try {
				expect(
					observer
						.prepare(
							"SELECT generationId,lastResult,itemCount FROM cache_refresh_status WHERE cacheType='jellyfin_episode'",
						)
						.get(),
				).toEqual({ generationId: "fixture-old", lastResult: "success", itemCount: 1 });
				expect(
					observer
						.prepare("SELECT COUNT(*) AS count FROM jellyfin_native_watch_publications")
						.get(),
				).toEqual({ count: 0 });
				expect(
					observer.prepare("SELECT COUNT(*) AS count FROM jellyfin_native_watch_rows").get(),
					JSON.stringify({ witness: Array.from(new Int32Array(witness)), lossReasons, failed }),
				).toEqual({ count: 0 });
			} finally {
				observer.close();
			}
			expect(lossReasons, JSON.stringify(failed)).toEqual([]);
			// The transaction fence can refuse the next native statement before
			// Prisma reports P2028. Assert the failed stage and measured timeout,
			// not an upstream error code that requires letting that statement run.
			expect(failed, JSON.stringify(failed)).toMatchObject({
				value: {
					status: "failed",
					failurePhase: "publication",
					failureStage: "native-watch-stage",
				},
			});
			if (!("value" in failed) || failed.value.status !== "failed")
				throw new Error("Fixture failure missing");
			expect(failed.value.nativeWatchTransactionElapsedMs).toBeGreaterThanOrEqual(5800);
			await expect(app.restoreRuntime.runOperation(() => app.prisma.user.count())).resolves.toBe(1);
			await expect(execute(false)).resolves.toMatchObject({
				status: "published",
				itemCount: 500,
				cleanupFailed: false,
			});
			expect(lossReasons).toEqual([]);
			expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
		} finally {
			for (const worker of workers) if (worker.threadId !== -1) await worker.terminate();
			endpoint.closeAllConnections();
			await new Promise<void>((resolve) => endpoint.close(() => resolve()));
		}
	}, 45000);
	it.each(["success", "identity-after-unavailable", "lost-result"] as const)(
		"actual native finalizer publishes/replays exact visible evidence: %s",
		async (mode) => {
			await app.register(prismaPlugin);
			await activate(app.restoreRuntime);
			let requests = 0;
			let stagedAtFailure = 0;
			const endpoint = createHttpServer((_request, response) => {
				requests++;
				if (mode === "identity-after-unavailable" && requests === 2) {
					const observer = new Database(path, { readonly: true });
					try {
						stagedAtFailure = (
							observer
								.prepare("SELECT COUNT(*) AS count FROM jellyfin_episode_generation_rows")
								.get() as { count: number }
						).count;
					} finally {
						observer.close();
					}
					response.writeHead(503);
					response.end();
					return;
				}
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(
					JSON.stringify({ Id: "synthetic-server", ServerName: "Synthetic", Version: "1.0" }),
				);
			});
			await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
			const address = endpoint.address();
			if (!address || typeof address === "string") throw new Error("Fixture listener");
			const workers: Worker[] = [];
			try {
				const seed = await app.restoreRuntime.runOperation(() =>
					seedRuntimeJellyfinFinalization(app.prisma, `http://127.0.0.1:${address.port}`),
				);
				const actor = process.env.SQLITE_RESTORE_ACTUAL_FINALIZER_FILE;
				if (!actor) throw new Error("Actual finalizer bundle missing");
				const { runJellyfinEpisodeFinalizerWorker } = await import(
					"../../jellyfin/jellyfin-episode-finalizer-worker-transport.js"
				);
				const { readCompletedJellyfinEpisodePublication } = await import(
					"../../jellyfin/jellyfin-episode-refresh-repository.js"
				);
				const { readOwnedJellyfinEpisodeDisplaySources } = await import(
					"../../jellyfin/jellyfin-display-evidence.js"
				);
				const execute = (loseResult = false) =>
					app.restoreRuntime.runOperation(() =>
						runJellyfinEpisodeFinalizerWorker(
							{ databaseUrl: url, ...seed },
							{
								createWorker: (_target, workerData, transferList) => {
									const physical = new Worker(new URL(`file://${actor}`), {
										workerData,
										transferList,
									});
									workers.push(physical);
									if (!loseResult) return physical;
									const adapter = {
										on: (event: string, listener: (...args: unknown[]) => void) => {
											if (event !== "message") physical.on(event, listener);
											return adapter;
										},
										terminate: physical.terminate.bind(physical),
									};
									return adapter as never;
								},
							},
						),
					);
				const visible = () =>
					app.restoreRuntime.runOperation(() =>
						app.prisma.cacheRefreshStatus.findUniqueOrThrow({
							where: {
								instanceId_cacheType: {
									instanceId: seed.instance.id,
									cacheType: "jellyfin_episode",
								},
							},
							select: { generationId: true, lastResult: true, itemCount: true },
						}),
					);
				if (mode === "identity-after-unavailable") {
					await expect(execute()).resolves.toEqual({ status: "identity-unavailable" });
					expect(stagedAtFailure).toBe(1);
					expect(await visible()).toEqual({
						generationId: "fixture-old",
						lastResult: "success",
						itemCount: 1,
					});
					await app.restoreRuntime.runOperation(async () => {
						expect(await app.prisma.jellyfinNativeWatchPublication.count()).toBe(0);
						const released = await app.prisma.jellyfinEpisodePreparation.findUniqueOrThrow({
							where: { runId: seed.runId },
							select: { leaseExpiresAt: true, token: true },
						});
						expect(released.token.length).toBeGreaterThan(0);
						expect(released.leaseExpiresAt.getTime()).toBeGreaterThanOrEqual(seed.now.getTime());
						expect(released.leaseExpiresAt.getTime()).toBeLessThanOrEqual(Date.now());
					});
				}
				if (mode === "lost-result")
					await expect(execute(true)).rejects.toMatchObject({ category: "worker-failed" });
				else
					await expect(execute()).resolves.toMatchObject({
						status: "published",
						itemCount: 1,
						cleanupFailed: false,
					});
				expect(await visible()).toEqual({
					generationId: seed.runId,
					lastResult: "success",
					itemCount: 1,
				});
				await app.restoreRuntime.runOperation(async () => {
					expect(
						await readCompletedJellyfinEpisodePublication(app.prisma, {
							userId: seed.userId,
							instanceId: seed.instance.id,
							runId: seed.runId,
							attempt: seed.attempt,
						}),
					).toBe(1);
					expect(
						await app.prisma.jellyfinEpisodeGenerationRow.findMany({
							where: { instanceId: seed.instance.id, generationId: seed.runId },
							select: { showTmdbId: true, seasonNumber: true, episodeNumber: true, watched: true },
						}),
					).toEqual([{ showTmdbId: 42, seasonNumber: 1, episodeNumber: 1, watched: true }]);
					expect(
						await app.prisma.jellyfinNativeWatchPublication.findUnique({
							where: { instanceId: seed.instance.id },
							select: { activeRunId: true },
						}),
					).toEqual({ activeRunId: seed.runId });
					expect(
						await app.prisma.jellyfinNativeWatchRow.count({ where: { runId: seed.runId } }),
					).toBe(1);
					expect(
						await app.prisma.jellyfinEpisodeObservationStage.count({
							where: { runId: seed.runId },
						}),
					).toBe(0);
					expect(
						await app.prisma.providerObservationRun.findUnique({
							where: { id: seed.runId },
							select: { state: true, activeSlotKey: true },
						}),
					).toEqual({ state: "complete", activeSlotKey: null });
					const displayed = await readOwnedJellyfinEpisodeDisplaySources({
						prisma: app.prisma,
						userId: seed.userId,
						instances: [{ id: seed.instance.id, label: "Synthetic", service: "JELLYFIN" }],
						showTmdbIds: [42],
						now: new Date(),
					});
					expect(displayed.sources[0]?.rows).toHaveLength(1);
					expect(displayed.providerStatus?.sources[0]?.status.availability).toBe("current");
				});
				const readsBeforeReplay = requests;
				await expect(execute()).resolves.toMatchObject({ status: "published", itemCount: 1 });
				expect(requests).toBe(readsBeforeReplay);
				await app.restoreRuntime.runOperation(async () => {
					expect(
						await app.prisma.jellyfinEpisodeGenerationRow.count({
							where: { generationId: seed.runId },
						}),
					).toBe(1);
					expect(
						await app.prisma.jellyfinNativeWatchRow.count({ where: { runId: seed.runId } }),
					).toBe(1);
				});
				expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
			} finally {
				for (const worker of workers) if (worker.threadId !== -1) await worker.terminate();
				endpoint.closeAllConnections();
				await new Promise<void>((resolve) => endpoint.close(() => resolve()));
			}
		},
		30000,
	);
	it("the real plugin owns a runtime before exposing a guarded bootstrap client", async () => {
		await app.register(prismaPlugin);
		const runtime = app.getDecorator<RestoreRuntime>("restoreRuntime");
		await expect(
			app.prisma.user.create({ data: { username: "fixture-no-ticket" } }),
		).rejects.toThrow();
		expect(count()).toBe(0);
		await runtime.runStarting(() =>
			app.prisma.user.create({ data: { username: "fixture-bootstrap" } }),
		);
		await activate(runtime);
		expect(await runtime.runOperation(() => app.prisma.user.count())).toBe(1);
	});
	it("the actual server finishes bootstrap before admitting authenticated database routes and scheduler work", async () => {
		const config = app.config;
		await app.close();
		const { buildServer } = await import("../../../server.js");
		app = buildServer({ logger: false, env: config });
		await app.ready();
		const journal = new Database(path, { readonly: true });
		try {
			const row = journal
				.prepare("SELECT phase, destinationInstallationId FROM RestoreRuntimeControl")
				.get() as { phase: string; destinationInstallationId: string };
			expect(row.phase).toBe("running");
			expect(row.destinationInstallationId).toBe(app.installationId);
		} finally {
			journal.close();
		}
		expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
		expect((await app.inject({ method: "GET", url: "/auth/me" })).statusCode).toBe(401);
		expect(
			await app.schedulerRegistry.track("session-cleanup", () => app.prisma.user.count()),
		).toBe(0);
		await expect(app.prisma.user.count()).rejects.toThrow();
	}, 30000);
	it("actual startup hydrates a current persisted inode index under native admission", async () => {
		const config = app.config;
		await app.register(prismaPlugin);
		const builtAt = new Date();
		await app.restoreRuntime.runStarting(async () => {
			const user = await app.prisma.user.create({ data: { username: "fixture-hydration" } });
			await app.prisma.serviceInstance.create({
				data: {
					id: "fixture-hydration",
					userId: user.id,
					service: "QUI",
					label: "synthetic",
					baseUrl: "http://synthetic.invalid",
					encryptedApiKey: "unused-synthetic",
					encryptionIv: "unused-synthetic",
					enabled: false,
					connectionGeneration: 3,
					inodeIndexCache: {
						create: {
							builtAt,
							filesIndexed: 1,
							serializedData: new Uint8Array(
								serializeFileIdIndex({
									byFileId: new Map([["1:2", new Set(["a".repeat(40)])]]),
									sourceConnectionGeneration: 3,
									fallbackOwnershipVersion: 4,
									statted: 1,
									skippedNoLinks: 0,
									skippedUnstatable: 0,
									inventoryComplete: true,
									incompleteDirectoryWalks: 0,
									issues: [],
									torrentInventoryFingerprint: "a".repeat(64),
								}),
							),
						},
					},
				},
			});
		});
		await app.close();
		clearFileIdIndexCache("fixture-hydration");
		const { buildServer } = await import("../../../server.js");
		app = buildServer({ logger: false, env: config });
		await app.ready();
		expect(readCachedFileIdCoverage({ id: "fixture-hydration", connectionGeneration: 3 })).toEqual({
			builtAtMs: builtAt.getTime(),
			inventoryComplete: true,
			skippedUnstatable: 0,
			incompleteDirectoryWalks: 0,
			issues: [],
			torrentInventoryFingerprint: "a".repeat(64),
		});
	}, 30000);
	it.each(["qui-prewarm", "infohash-probe", "notification-retention"] as const)(
		"the actual %s callback obtains native admission after startup has settled",
		async (producer) => {
			await app.register(prismaPlugin);
			const { securityPlugin } = await import("../../../plugins/security.js");
			registerRestoreBootstrapPlugin(app, securityPlugin);
			const timers = vi.spyOn(globalThis, "setTimeout");
			const intervals = vi.spyOn(globalThis, "setInterval");
			const info = vi.spyOn(app.log, "info");
			if (producer === "qui-prewarm") {
				vi.stubEnv("DISABLE_QUI_CACHE_PREWARM", "false");
				const { default: plugin } = await import("../../../plugins/qui-cache-prewarm.js");
				registerRestoreBootstrapPlugin(app, plugin);
			} else if (producer === "infohash-probe") {
				const { default: registry } = await import("../../../plugins/scheduler-registry.js");
				const { default: plugin } = await import("../../../plugins/infohash-backfill-scheduler.js");
				registerRestoreBootstrapPlugin(app, registry);
				registerRestoreBootstrapPlugin(app, plugin);
			} else {
				const { default: plugin } = await import("../../../plugins/notification-service.js");
				registerRestoreBootstrapPlugin(app, plugin);
			}
			registerRestoreRuntimeActivation(app);
			try {
				await app.ready();
				if (producer === "notification-retention") {
					await app.restoreRuntime.runOperation(() =>
						app.prisma.notificationLog.createMany({
							data: ["old", "recent"].map((age) => ({
								id: `fixture-${age}`,
								channelId: "synthetic-channel",
								channelType: "DISCORD",
								eventType: "TEST",
								title: "synthetic",
								body: "synthetic",
								status: "sent",
								sentAt: new Date(Date.now() - (age === "old" ? 100 : 1) * 86400000),
							})),
						}),
					);
					const index = intervals.mock.calls.findIndex(([, delay]) => delay === 6 * 60 * 60000);
					expect(index).toBeGreaterThanOrEqual(0);
					// Invoke the real registered callback without a request/bootstrap ticket.
					await (intervals.mock.calls[index]![0] as () => Promise<void>)();
					expect(
						await app.restoreRuntime.runOperation(() => app.prisma.notificationLog.count()),
					).toBe(1);
					expect(
						await app.restoreRuntime.runOperation(() =>
							app.prisma.notificationLog.findUnique({
								where: { id: "fixture-recent" },
							}),
						),
					).not.toBeNull();
				} else {
					let index = -1;
					timers.mock.calls.forEach(([, delay], candidate) => {
						if (delay === 30000) index = candidate;
					});
					expect(index).toBeGreaterThanOrEqual(0);
					clearTimeout(timers.mock.results[index]!.value);
					(timers.mock.calls[index]![0] as () => void)();
					await vi.waitFor(
						() =>
							expect(info).toHaveBeenCalledWith(
								producer === "qui-prewarm"
									? "qui cache pre-warm: no enabled qui instances, skipping"
									: "infoHash backfill: catch-up complete (backlog drained)",
							),
						{ timeout: 1500, interval: 10 },
					);
				}
			} finally {
				vi.unstubAllEnvs();
			}
		},
		30000,
	);
	it("a detached ARR warmer retains native ownership until its actual HTTP read settles", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let received!: () => void;
		const entered = new Promise<void>((resolve) => {
			received = resolve;
		});
		let requests = 0;
		const upstream = createHttpServer(async (request, response) => {
			requests++;
			if (request.method !== "GET" || request.url !== "/api/v3/system/status") {
				response.writeHead(404).end();
				return;
			}
			received();
			await gate;
			response.writeHead(200, { "content-type": "application/json" }).end(
				JSON.stringify({
					appName: "Sonarr",
					version: "4.0.0",
					instanceName: "synthetic",
					branch: "main",
				}),
			);
		});
		await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
		const address = upstream.address();
		if (!address || typeof address === "string") throw new Error("Synthetic listener missing");
		let warming: Promise<void> | undefined;
		let closing: Promise<void> | undefined;
		try {
			await app.register(prismaPlugin);
			const { securityPlugin } = await import("../../../plugins/security.js");
			const { arrClientPlugin } = await import("../../../plugins/arr-client.js");
			registerRestoreBootstrapPlugin(app, securityPlugin);
			registerRestoreBootstrapPlugin(app, arrClientPlugin);
			registerRestoreRuntimeActivation(app);
			await app.ready();
			const userId = await app.restoreRuntime.runOperation(async () => {
				const user = await app.prisma.user.create({ data: { username: "fixture-warmer" } });
				const key = app.encryptor.encrypt("synthetic-only-key");
				await app.prisma.serviceInstance.create({
					data: {
						userId: user.id,
						service: "SONARR",
						label: "synthetic",
						baseUrl: `http://127.0.0.1:${address.port}`,
						encryptedApiKey: key.value,
						encryptionIv: key.iv,
					},
				});
				return user.id;
			});
			const { warmConnectionsForUser } = await import("../../arr/connection-warmer.js");
			// The authentication handler's ticket is deliberately no longer present.
			warming = warmConnectionsForUser(app, userId);
			await vi.waitFor(() => expect(requests).toBe(1), { timeout: 1500, interval: 10 });
			await entered;
			let closed = false;
			closing = app.close().then(() => {
				closed = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
			release();
			await warming;
			await closing;
			const successor = await acquireSqliteRestoreRuntimeOwnership(url);
			await successor.close();
		} finally {
			release();
			await Promise.allSettled([warming, closing].filter((work) => work !== undefined));
			upstream.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				upstream.close((error) => (error ? reject(error) : resolve())),
			);
		}
	}, 30000);
	it.each([
		["success", 200, false, false],
		["permanent-failure", 400, false, false],
		["retry-preserved", 503, false, false],
		["revoked-recipient", 200, true, false],
		["context-free-health-entry", 200, false, true],
	] as const)(
		"an actual notification records %s before native close completes",
		async (_outcome, status, revoked, healthEntry) => {
			const eventType = healthEntry ? "VALIDATION_HEALTH_DEGRADED" : "HUNT_COMPLETED";
			const { integrationHealth } = await import("../../validation/integration-health.js");
			integrationHealth.reset();
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let requests = 0;
			const endpoint = createHttpServer(async (request, response) => {
				request.resume();
				if (request.method !== "POST" || request.url !== "/synthetic-notification") {
					response.writeHead(404).end();
					return;
				}
				requests++;
				await gate;
				response.writeHead(status).end();
			});
			await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
			const address = endpoint.address();
			if (!address || typeof address === "string") throw new Error("Synthetic listener missing");
			const logicalUrl = "https://synthetic-notification.invalid/synthetic-notification";
			const physicalUrl = `http://127.0.0.1:${address.port}/synthetic-notification`;
			const actualFetch = globalThis.fetch;
			// Stored configuration must pass the actual public-URL policy. Redirect
			// only this synthetic transport boundary to the real local HTTP gate.
			const fetchMapping = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
				if (input !== logicalUrl || init?.method !== "POST")
					throw new Error("Unexpected synthetic notification request");
				return actualFetch(physicalUrl, init);
			});
			let closing: Promise<void> | undefined;
			let notifying: Promise<void> | undefined;
			let queuedEvent: { id: string; dueAt: Date } | undefined;
			try {
				await app.register(prismaPlugin);
				const { securityPlugin } = await import("../../../plugins/security.js");
				const { default: notifications } = await import("../../../plugins/notification-service.js");
				registerRestoreBootstrapPlugin(app, securityPlugin);
				registerRestoreBootstrapPlugin(app, notifications);
				registerRestoreRuntimeActivation(app);
				await app.ready();
				const userId = await app.restoreRuntime.runOperation(async () => {
					const user = await app.prisma.user.create({
						data: { username: "fixture-queued-digest" },
					});
					const config = app.encryptor.encrypt(
						JSON.stringify({
							url: logicalUrl,
						}),
					);
					await app.prisma.notificationChannel.create({
						data: {
							id: "fixture-queued-digest",
							userId: user.id,
							name: "synthetic",
							type: "WEBHOOK",
							encryptedConfig: config.value,
							configIv: config.iv,
							subscriptions: { create: { eventType } },
						},
					});
					await app.prisma.notificationAggregationConfig.create({
						data: {
							userId: user.id,
							eventType,
							enabled: !healthEntry,
							windowSeconds: 60,
							maxBatchSize: 2,
						},
					});
					return user.id;
				});
				if (healthEntry) {
					// Actual registry callback, deliberately outside bootstrap/request admission.
					integrationHealth.record("synthetic", "synthetic", {
						total: 1,
						validated: 0,
						rejected: 1,
					});
					await vi.waitFor(() => expect(requests).toBe(1), { timeout: 1500, interval: 10 });
				} else {
					await app.restoreRuntime.runOperation(() =>
						app.notificationService.notify(
							{ eventType, title: "synthetic", body: "synthetic" },
							{ userId },
						),
					);
					expect(requests).toBe(0);
					await expect(withCleanupMaintenanceGuard(async () => true)).resolves.toBe(true);
					queuedEvent = await app.restoreRuntime.runOperation(() =>
						app.prisma.notificationOutboxEvent.findFirstOrThrow({
							where: { userId, stage: "aggregating" },
							select: { id: true, dueAt: true },
						}),
					);
					if (!revoked) {
						// A full batch, not shutdown, grants the digest's dispatch eligibility.
						// notify joins the actual send, so retain it while the HTTP gate is held.
						notifying = app.restoreRuntime.runOperation(() =>
							app.notificationService.notify(
								{ eventType, title: "synthetic-second", body: "synthetic" },
								{ userId },
							),
						);
						await vi.waitFor(() => expect(requests).toBe(1), { timeout: 1500, interval: 10 });
					}
				}
				if (revoked) {
					await app.restoreRuntime.runOperation(() =>
						app.prisma.notificationChannel.update({
							where: { id: "fixture-queued-digest" },
							data: { enabled: false },
						}),
					);
				}
				let closed = false;
				closing = app.close().then(() => {
					closed = true;
				});
				if (!revoked) {
					await vi.waitFor(() => expect(requests).toBe(1), { timeout: 1500, interval: 10 });
					expect(closed).toBe(false);
					await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
				}
				release();
				await notifying;
				await closing;
				if (healthEntry) {
					integrationHealth.record("synthetic-after-close", "synthetic", {
						total: 1,
						validated: 0,
						rejected: 1,
					});
					await new Promise<void>((resolve) => setImmediate(resolve));
					expect(requests).toBe(1);
				}
				const observer = new Database(path, { readonly: true });
				try {
					const results = observer
						.prepare("SELECT status FROM notification_logs WHERE channelId = ?")
						.all("fixture-queued-digest") as Array<{ status: string }>;
					expect(results.map((row) => row.status).sort()).toEqual(
						revoked ? [] : status === 200 ? ["sent"] : ["failed"],
					);
					const events = observer
						.prepare(
							'SELECT id, stage, dueAt, aggregateParentId FROM "NotificationOutboxEvent" WHERE userId = ?',
						)
						.all(userId) as Array<{
						id: string;
						stage: string;
						dueAt: string | number;
						aggregateParentId: string | null;
					}>;
					const deliveries = observer
						.prepare(
							'SELECT eventId, state, attemptOrdinal, nextAttemptAt FROM "NotificationOutboxDelivery" WHERE userId = ?',
						)
						.all(userId) as Array<{
						eventId: string;
						state: string;
						attemptOrdinal: number;
						nextAttemptAt: string | number;
					}>;
					if (revoked) {
						expect(events).toHaveLength(1);
						expect(events[0]).toMatchObject({
							id: queuedEvent!.id,
							stage: "aggregating",
							aggregateParentId: null,
						});
						expect(new Date(events[0]!.dueAt).getTime()).toBe(queuedEvent!.dueAt.getTime());
						expect(deliveries).toHaveLength(1);
						expect(deliveries[0]).toMatchObject({
							eventId: queuedEvent!.id,
							state: "waiting",
							attemptOrdinal: 0,
						});
						expect(new Date(deliveries[0]!.nextAttemptAt).getTime()).toBe(
							queuedEvent!.dueAt.getTime(),
						);
					} else {
						const digest = events.filter((event) => event.stage !== "grouped");
						expect(events).toHaveLength(healthEntry ? 1 : 3);
						expect(digest).toHaveLength(1);
						expect(digest[0]!.stage).toBe(status === 503 ? "ready" : "terminal");
						const actualDelivery = deliveries.filter(
							(delivery) => delivery.eventId === digest[0]!.id,
						);
						expect(deliveries).toHaveLength(healthEntry ? 1 : 3);
						expect(actualDelivery).toHaveLength(1);
						expect(actualDelivery[0]).toMatchObject({
							state: status === 200 ? "sent" : status === 503 ? "retry-waiting" : "rejected",
							attemptOrdinal: status === 503 ? 1 : 0,
						});
						if (!healthEntry) {
							expect(
								events
									.filter((event) => event.stage === "grouped")
									.map((event) => event.aggregateParentId),
							).toEqual([digest[0]!.id, digest[0]!.id]);
							expect(
								deliveries
									.filter((delivery) => delivery.eventId !== digest[0]!.id)
									.map((delivery) => delivery.state),
							).toEqual(["canceled", "canceled"]);
						}
						if (status === 503) {
							const failed = observer
								.prepare(
									"SELECT sentAt FROM notification_logs WHERE channelId = ? AND status = 'failed'",
								)
								.get("fixture-queued-digest") as { sentAt: string | number };
							expect(
								new Date(actualDelivery[0]!.nextAttemptAt).getTime() -
									new Date(failed.sentAt).getTime(),
							).toBe(30_000);
							expect(new Date(actualDelivery[0]!.nextAttemptAt).getTime()).toBeGreaterThan(
								Date.now(),
							);
						}
					}
					expect(
						observer
							.prepare("SELECT lastSendResult FROM notification_channels WHERE id = ?")
							.get("fixture-queued-digest"),
					).toEqual({ lastSendResult: revoked ? null : status === 200 ? "success" : "failed" });
					expect(requests).toBe(revoked ? 0 : 1);
				} finally {
					observer.close();
				}
				const successor = await acquireSqliteRestoreRuntimeOwnership(url);
				await successor.close();
			} finally {
				release();
				await Promise.allSettled([notifying, closing].filter((work) => work !== undefined));
				integrationHealth.reset();
				endpoint.closeAllConnections();
				await new Promise<void>((resolve, reject) =>
					endpoint.close((error) => (error ? reject(error) : resolve())),
				);
				fetchMapping.mockRestore();
			}
		},
		30000,
	);
	for (const [mode, revocation] of [
		["due", "none"],
		["due", "disabled"],
		["due", "unsubscribed"],
		["due", "transferred"],
		["shutdown", "none"],
		["shutdown", "disabled"],
		["shutdown", "unsubscribed"],
		["shutdown", "transferred"],
		["overflow", "none"],
	] as const) {
		it(
			`actual quiet-hours ${mode} settles without early delivery or revoked authority (${revocation})`,
			async () => {
				const revoked = revocation !== "none";
				const { createNotificationOutboxRepository } = await import(
					"../../notifications/outbox-repository.js"
				);
				const { createNotificationOutboxWorker } = await import(
					"../../notifications/outbox-worker.js"
				);
				const { NotificationDispatcher } = await import(
					"../../notifications/notification-dispatcher.js"
				);
				let release!: () => void;
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				let requests = 0;
				const endpoint = createHttpServer(async (request, response) => {
					request.resume();
					if (request.method !== "POST" || request.url !== "/synthetic") {
						response.writeHead(404).end();
						return;
					}
					requests++;
					await gate;
					response.writeHead(200).end();
				});
				await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
				const address = endpoint.address();
				if (!address || typeof address === "string") throw new Error("Synthetic listener missing");
				const logicalUrl = "https://synthetic-notification.invalid/synthetic";
				const physicalUrl = `http://127.0.0.1:${address.port}/synthetic`;
				const actualFetch = globalThis.fetch;
				const fetchMapping = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
					if (input !== logicalUrl || init?.method !== "POST")
						throw new Error("Unexpected synthetic notification request");
					return actualFetch(physicalUrl, init);
				});
				let flushing: Promise<void> | undefined;
				let closing: Promise<void> | undefined;
				let dueWorker: ReturnType<typeof createNotificationOutboxWorker> | undefined;
				let clockAt = new Date();
				const clock = () => new Date(clockAt);
				app.addHook("preClose", async () => dueWorker?.closeAdmission());
				app.addHook("onClose", async () => dueWorker?.drain());
				try {
					await app.register(prismaPlugin);
					const { securityPlugin } = await import("../../../plugins/security.js");
					const { default: notifications } = await import(
						"../../../plugins/notification-service.js"
					);
					registerRestoreBootstrapPlugin(app, securityPlugin);
					registerRestoreBootstrapPlugin(app, notifications);
					registerRestoreRuntimeActivation(app);
					await app.ready();
					const now = new Date();
					const start = new Date(now.getTime() - 120_000);
					const end = new Date(now.getTime() + 120_000);
					end.setUTCSeconds(0, 0);
					const userId = await app.restoreRuntime.runOperation(async () => {
						const user = await app.prisma.user.create({ data: { username: "fixture-quiet" } });
						const config = app.encryptor.encrypt(JSON.stringify({ url: logicalUrl }));
						await app.prisma.notificationChannel.create({
							data: {
								id: "fixture-quiet",
								userId: user.id,
								name: "synthetic",
								type: "WEBHOOK",
								encryptedConfig: config.value,
								configIv: config.iv,
								subscriptions: { create: { eventType: "HUNT_COMPLETED" } },
							},
						});
						await app.prisma.notificationRule.create({
							data: {
								userId: user.id,
								name: "synthetic",
								action: "quiet_hours",
								conditions: "[]",
								quietHoursStart: start.toISOString().slice(11, 16),
								quietHoursEnd: end.toISOString().slice(11, 16),
								quietHoursTimezone: "UTC",
							},
						});
						return user.id;
					});
					await app.restoreRuntime.runOperation(() =>
						app.notificationService.notify(
							{ eventType: "HUNT_COMPLETED", title: "synthetic", body: "synthetic" },
							{ userId },
						),
					);
					expect(requests).toBe(0);
					await expect(withCleanupMaintenanceGuard(async () => true)).resolves.toBe(true);
					if (mode === "overflow") {
						for (let index = 1; index <= 200; index++) {
							await app.restoreRuntime.runOperation(() =>
								app.notificationService.notify(
									{
										eventType: "HUNT_COMPLETED",
										title: `synthetic-${index}`,
										body: "synthetic",
									},
									{ userId },
								),
							);
						}
						expect(requests).toBe(0);
					}
					const accepted = await app.restoreRuntime.runOperation(() =>
						app.prisma.notificationOutboxEvent.findMany({
							where: { userId },
							select: { id: true, dueAt: true },
							orderBy: { id: "asc" },
						}),
					);
					expect(accepted).toHaveLength(mode === "overflow" ? 201 : 1);
					if (revocation === "disabled")
						await app.restoreRuntime.runOperation(() =>
							app.prisma.notificationChannel.update({
								where: { id: "fixture-quiet" },
								data: { enabled: false },
							}),
						);
					if (revocation === "unsubscribed")
						await app.restoreRuntime.runOperation(() =>
							app.prisma.notificationSubscription.deleteMany({
								where: { channelId: "fixture-quiet" },
							}),
						);
					if (revocation === "transferred")
						await app.restoreRuntime.runOperation(async () => {
							const owner = await app.prisma.user.create({
								data: { username: "fixture-quiet-other" },
							});
							await app.prisma.notificationChannel.update({
								where: { id: "fixture-quiet" },
								data: { userId: owner.id },
							});
						});
					if (mode === "due") {
						// Use the accepted deadline with the public worker/repository clock seam.
						// No private service access, re-admission, row promotion or forced flush.
						dueWorker = createNotificationOutboxWorker({
							repository: createNotificationOutboxRepository(
								app.prisma,
								app.restoreRuntime,
								app.encryptor,
								userId,
								{ clock },
							),
							runtime: app.restoreRuntime,
							dispatcher: new NotificationDispatcher(),
							logger: app.log,
							clock,
						});
						await dueWorker.start();
						expect(requests).toBe(0);
						clockAt = accepted[0]!.dueAt;
						await expect(withCleanupMaintenanceGuard(() => dueWorker!.wake())).rejects.toThrow();
						expect(requests).toBe(0);
						flushing = Promise.all([dueWorker.wake(), dueWorker.wake()]).then(() => undefined);
						if (!revoked)
							await vi.waitFor(() => expect(requests).toBe(1), { timeout: 1500, interval: 10 });
						else await flushing;
					}
					let closed = false;
					closing = app.close().then(() => {
						closed = true;
					});
					if (mode === "due" && !revoked) {
						await new Promise<void>((resolve) => setImmediate(resolve));
						expect(closed).toBe(false);
						await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
					}
					release();
					await flushing;
					await closing;
					const observer = new Database(path, { readonly: true });
					try {
						const logs = observer
							.prepare("SELECT status FROM notification_logs WHERE channelId = ?")
							.all("fixture-quiet") as Array<{ status: string }>;
						expect(logs.map((row) => row.status)).toEqual(
							mode === "due" && !revoked ? ["sent"] : [],
						);
						const events = observer
							.prepare(
								'SELECT id, stage, dueAt FROM "NotificationOutboxEvent" WHERE userId = ? ORDER BY id',
							)
							.all(userId) as Array<{ id: string; stage: string; dueAt: string | number }>;
						const deliveries = observer
							.prepare(
								'SELECT eventId, state, attemptOrdinal, nextAttemptAt FROM "NotificationOutboxDelivery" WHERE userId = ? ORDER BY eventId',
							)
							.all(userId) as Array<{
							eventId: string;
							state: string;
							attemptOrdinal: number;
							nextAttemptAt: string | number;
						}>;
						expect(events).toHaveLength(mode === "overflow" ? 201 : 1);
						expect(deliveries).toHaveLength(mode === "overflow" ? 201 : 1);
						expect(
							events.map((event) => ({
								id: event.id,
								stage: event.stage,
								dueAt: new Date(event.dueAt).getTime(),
							})),
						).toEqual(
							accepted.map((event) => ({
								id: event.id,
								stage: mode === "due" ? "terminal" : "deferred",
								dueAt: event.dueAt.getTime(),
							})),
						);
						expect(
							deliveries.map((delivery) => ({
								eventId: delivery.eventId,
								state: delivery.state,
								ordinal: delivery.attemptOrdinal,
								dueAt: new Date(delivery.nextAttemptAt).getTime(),
							})),
						).toEqual(
							accepted.map((event) => ({
								eventId: event.id,
								state: mode === "due" ? (revoked ? "canceled" : "sent") : "waiting",
								ordinal: 0,
								dueAt: event.dueAt.getTime(),
							})),
						);
						expect(
							observer
								.prepare(
									"SELECT lastSentAt, lastSendResult FROM notification_channels WHERE id = ?",
								)
								.get("fixture-quiet"),
						).toEqual({
							lastSentAt: mode === "due" && !revoked ? expect.anything() : null,
							lastSendResult: mode === "due" && !revoked ? "success" : null,
						});
						expect(requests).toBe(mode === "due" && !revoked ? 1 : 0);
					} finally {
						observer.close();
					}
					const successor = await acquireSqliteRestoreRuntimeOwnership(url);
					await successor.close();
				} finally {
					release();
					await Promise.allSettled([flushing, closing].filter((work) => work !== undefined));
					dueWorker?.closeAdmission();
					await dueWorker?.drain();
					endpoint.closeAllConnections();
					await new Promise<void>((resolve, reject) =>
						endpoint.close((error) => (error ? reject(error) : resolve())),
					);
					fetchMapping.mockRestore();
				}
			},
			// This case performs201 real, individually authorized native admissions.
			mode === "overflow" ? 90000 : 30000,
		);
	}
	it.each(["rejects", "returns-early", "throws", "native-stop"] as const)(
		"actual Worker/native parent lifetime waits for exit when termination %s",
		async (mode) => {
			await app.register(prismaPlugin);
			await activate(app.restoreRuntime);
			const { runJellyfinEpisodeFinalizerWorker } = await import(
				"../../jellyfin/jellyfin-episode-finalizer-worker-transport.js"
			);
			const actor = process.env.SQLITE_RESTORE_WORKER_EXIT_ACTOR_FILE;
			if (!actor) throw new Error("Native Worker fixture bundle missing");
			let worker: Worker | undefined;
			let actualExit: Promise<number> | undefined;
			let resultSeen!: () => void;
			const resultMessage = new Promise<void>((resolve) => {
				resultSeen = resolve;
			});
			let completed = false,
				closed = false;
			const running = app.restoreRuntime.runIndependentOperation(() =>
				runJellyfinEpisodeFinalizerWorker(
					{
						databaseUrl: url,
						userId: "synthetic",
						runId: "synthetic",
						scopes: [],
						attempt: { attemptedAt: new Date(), resultMarker: "synthetic" },
						now: new Date(),
						instance: {
							id: "synthetic",
							userId: "synthetic",
							service: "JELLYFIN",
							baseUrl: "http://127.0.0.1",
							apiKey: "synthetic",
							enabled: true,
							encryptedApiKey: "synthetic",
							encryptionIv: "synthetic",
							encryptedHttpAuthCredentials: null,
							httpAuthEncryptionIv: null,
							expectedIdentity: null,
							identityStatus: "UNVERIFIED",
							connectionGeneration: 1,
							identityGeneration: 1,
						},
					},
					{
						createWorker: () => {
							worker = new Worker(new URL(`file://${actor}`), { workerData: { databaseUrl: url } });
							actualExit = new Promise<number>((resolve) => worker!.once("exit", resolve));
							worker.once("message", resultSeen);
							const physical = worker;
							return {
								on: physical.on.bind(physical),
								terminate: () => {
									if (mode === "native-stop") return physical.terminate();
									if (mode === "throws") throw new Error("Synthetic termination refusal");
									if (mode === "rejects")
										return Promise.reject(new Error("Synthetic termination refusal"));
									return 0;
								},
							};
						},
					},
				),
			);
			const observed = running.then(
				() => {
					completed = true;
				},
				() => {
					completed = true;
				},
			);
			let closing: Promise<void> | undefined;
			try {
				await resultMessage;
				if (mode === "native-stop") {
					await running;
					expect(worker!.threadId).toBe(-1);
				} else {
					for (let turn = 0; turn < 8; turn++)
						await new Promise<void>((resolve) => setImmediate(resolve));
					expect(worker!.threadId).not.toBe(-1);
					expect(completed).toBe(false);
				}
				closing = app.close().then(() => {
					closed = true;
				});
				if (mode !== "native-stop") {
					for (let turn = 0; turn < 8; turn++)
						await new Promise<void>((resolve) => setImmediate(resolve));
					expect(closed).toBe(false);
					await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
				}
				worker!.postMessage("release");
				await expect(actualExit).resolves.toBe(mode === "native-stop" ? 1 : 0);
				await expect(running).resolves.toEqual({
					status: "published",
					itemCount: 0,
					finalizationCallMs: 0,
					outerOverheadMs: 0,
					cleanupMs: 0,
					cleanupFailed: false,
				});
				await closing;
				const successor = await acquireSqliteRestoreRuntimeOwnership(url);
				await successor.close();
			} finally {
				worker?.postMessage("release");
				await actualExit;
				await observed;
				await closing;
			}
		},
		30000,
	);
	it("retained work survives closed admission without reviving its expired parent context", async () => {
		await app.register(prismaPlugin);
		await activate(app.restoreRuntime);
		expect(retainRestoreRuntimeOperation()).toBeUndefined();
		let releaseParent!: () => void;
		const parentGate = new Promise<void>((resolve) => {
			releaseParent = resolve;
		});
		let oldQuery!: Promise<unknown>;
		let oldRetention!: Promise<unknown>;
		let retained: RetainedRestoreRuntimeOperation | undefined;
		try {
			await app.restoreRuntime.runOperation(async () => {
				retained = retainRestoreRuntimeOperation();
				oldQuery = parentGate.then(() => app.prisma.user.count());
				oldRetention = parentGate.then(() => retainRestoreRuntimeOperation());
			});
			const expiredQuery = expect(oldQuery).rejects.toThrow();
			const expiredRetention = expect(oldRetention).rejects.toThrow();
			releaseParent();
			await Promise.all([expiredQuery, expiredRetention]);
			app.restoreRuntime.closeAdmission();
			await expect(
				app.restoreRuntime.runOperation(() => app.prisma.user.count()),
			).rejects.toThrow();
			await retained!.run(() => app.prisma.user.create({ data: { username: "fixture-retained" } }));
			expect(count()).toBe(1);
			await retained!.release();
			await expect(retained!.run(() => app.prisma.user.count())).rejects.toThrow();
			await retained!.release();
		} finally {
			releaseParent();
			await retained?.release();
		}
	});
	it("native busy-response retained callback keeps close joined and retries after main-file unlock", async () => {
		let losses = 0;
		supplied = await openRestoreRuntime({
			databaseUrl: url,
			onUnavailable: () => {
				losses++;
			},
		});
		app.decorate("restoreRuntime", supplied);
		await app.register(prismaPlugin);
		await activate(app.restoreRuntime);
		let retained: RetainedRestoreRuntimeOperation | undefined;
		await app.restoreRuntime.runOperation(async () => {
			retained = retainRestoreRuntimeOperation();
		});
		const writer = new Database(path, { timeout: 0 });
		let closing: Promise<void> | undefined;
		try {
			app.restoreRuntime.closeAdmission();
			writer.exec("BEGIN EXCLUSIVE");
			let invoked = false;
			await expect(
				retained!.run(async () => {
					invoked = true;
					return app.prisma.user.create({ data: { username: "fixture-forbidden-busy" } });
				}),
			).rejects.toThrow();
			expect(invoked).toBe(false);
			expect(losses).toBe(0);
			let closed = false;
			closing = app.restoreRuntime.close().then(() => {
				closed = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
			writer.exec("ROLLBACK");
			await retained!.run(() =>
				app.prisma.user.create({ data: { username: "fixture-retained-retry" } }),
			);
			expect(count()).toBe(1);
			await retained!.release();
			await closing;
			expect(losses).toBe(0);
			const successor = await acquireSqliteRestoreRuntimeOwnership(url);
			await successor.close();
		} finally {
			if (writer.inTransaction) writer.exec("ROLLBACK");
			writer.close();
			await retained?.release();
			await closing?.catch(() => {});
		}
	});
	it("an idle starting continuation does not block activation and runs in the final phase", async () => {
		await app.register(prismaPlugin);
		let retained: RetainedRestoreRuntimeOperation | undefined;
		try {
			await app.restoreRuntime.runStarting(async () => {
				retained = retainRestoreRuntimeOperation();
			});
			await app.restoreRuntime.bindDestination("fixture-application");
			const activated = app.restoreRuntime.activate();
			const queued = retained!.run(() =>
				app.prisma.user.create({ data: { username: "fixture-after-activation" } }),
			);
			await activated;
			await queued;
			expect(count()).toBe(1);
			const observer = new Database(path, { readonly: true });
			try {
				expect(observer.prepare("SELECT phase FROM RestoreRuntimeControl").get()).toEqual({
					phase: "running",
				});
			} finally {
				observer.close();
			}
		} finally {
			await retained?.release();
		}
	});
	it("release joins an executing continuation and refuses both new work and a self-join", async () => {
		await app.register(prismaPlugin);
		await activate(app.restoreRuntime);
		let retained: RetainedRestoreRuntimeOperation | undefined;
		await app.restoreRuntime.runOperation(async () => {
			retained = retainRestoreRuntimeOperation();
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const started = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const work = retained!.run(async () => {
			await expect(retained!.release()).rejects.toThrow();
			entered();
			await gate;
			return app.prisma.user.create({ data: { username: "fixture-retained-drain" } });
		});
		let closing: Promise<void> | undefined;
		try {
			await started;
			let released = false;
			const disposal = retained!.release().then(() => {
				released = true;
			});
			await expect(retained!.run(() => app.prisma.user.count())).rejects.toThrow();
			let closed = false;
			closing = app.close().then(() => {
				closed = true;
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(released).toBe(false);
			expect(closed).toBe(false);
			await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
			release();
			await work;
			await disposal;
			await closing;
			expect(count()).toBe(1);
		} finally {
			release();
			await Promise.allSettled([work, retained!.release(), ...(closing ? [closing] : [])]);
		}
	});
	it("native journal loss fences a retained queue before its callback can write", async () => {
		await app.register(prismaPlugin);
		await activate(app.restoreRuntime);
		let retained: RetainedRestoreRuntimeOperation | undefined;
		await app.restoreRuntime.runOperation(async () => {
			retained = retainRestoreRuntimeOperation();
		});
		const observer = new Database(path);
		try {
			observer
				.prepare("UPDATE RestoreRuntimeControl SET runtimeEpoch = ?")
				.run("00000000-0000-4000-8000-000000000001");
		} finally {
			observer.close();
		}
		try {
			let invoked = false;
			await expect(
				retained!.run(async () => {
					invoked = true;
					return app.prisma.user.create({ data: { username: "fixture-forbidden" } });
				}),
			).rejects.toThrow();
			expect(invoked).toBe(false);
			expect(count()).toBe(0);
			await expect(
				app.restoreRuntime.runOperation(() => app.prisma.user.count()),
			).rejects.toThrow();
		} finally {
			await retained?.release();
		}
	});
	it("a genuine pre-opened runtime is reused, never replaced by an unguarded second pool", async () => {
		supplied = await openRestoreRuntime({ databaseUrl: url });
		app.decorate("restoreRuntime", supplied);
		await app.register(prismaPlugin);
		expect(app.getDecorator<RestoreRuntime>("restoreRuntime")).toBe(supplied);
		await activate(supplied);
		await expect(
			app.prisma.user.create({ data: { username: "fixture-unfenced" } }),
		).rejects.toThrow();
		await supplied.runOperation(() =>
			app.prisma.user.create({ data: { username: "fixture-admitted" } }),
		);
		expect(count()).toBe(1);
	});
	it("a detached cleanup producer owns native admission after its parent returns", async () => {
		await app.register(prismaPlugin);
		const runtime = app.restoreRuntime;
		await activate(runtime);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		let child!: Promise<unknown>;
		await runtime.runOperation(() =>
			withCleanupOperationGuard(async () => {
				child = withIndependentCleanupOperationGuard(async () => {
					entered();
					await gate;
					return app.prisma.user.create({ data: { username: "fixture-detached" } });
				});
			}),
		);
		await ready;
		let closed = false;
		const closing = app.close().then(() => {
			closed = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			release();
			await child;
			await closing;
			expect(count()).toBe(1);
		} finally {
			release();
			await Promise.allSettled([child, closing]);
		}
	});
	it("startup settings use a guarded actual database read before running opens", async () => {
		supplied = await openRestoreRuntime({ databaseUrl: url });
		const native = createRuntimePrismaClient(supplied);
		try {
			await supplied.runStarting(() =>
				native.prisma.systemSettings.create({
					data: { id: 1, apiPort: 4100, webPort: 4200, trustProxy: true, secureCookies: false },
				}),
			);
		} finally {
			await native.close();
		}
		const { loadRestoreRuntimeStartupSettings } = await import("../restore-runtime-bootstrap.js");
		expect(await loadRestoreRuntimeStartupSettings(supplied)).toEqual({
			apiPort: 4100,
			webPort: 4200,
			trustProxy: true,
			secureCookies: false,
		});
		await activate(supplied);
		await expect(loadRestoreRuntimeStartupSettings(supplied)).rejects.toThrow();
	});
	it("callback readiness work commits under starting permission before running activation", async () => {
		await app.register(prismaPlugin);
		registerRestoreBootstrapPlugin(
			app,
			fp(
				async (scope) => {
					await scope.restoreRuntime.bindDestination("fixture-callback");
					scope.addHook("onReady", function (done) {
						void this.prisma.systemSettings
							.create({ data: { id: 1, apiPort: 4300 } })
							.then(() => done(), done);
					});
				},
				{ name: "security", dependencies: ["prisma"] },
			),
		);
		registerRestoreRuntimeActivation(app);
		await app.ready();
		expect(
			await app.restoreRuntime.runOperation(() =>
				app.prisma.systemSettings.findUnique({ where: { id: 1 }, select: { apiPort: true } }),
			),
		).toEqual({ apiPort: 4300 });
	});
	it("bootstrap metadata still refuses a missing dependency before any initializer write", async () => {
		await app.register(prismaPlugin);
		registerRestoreBootstrapPlugin(
			app,
			fp(
				async (scope) => {
					await scope.prisma.user.create({ data: { username: "fixture-unreachable" } });
				},
				{ name: "fixture-dependent", dependencies: ["fixture-missing"] },
			),
		);
		await expect(app.ready()).rejects.toThrow();
		expect(count()).toBe(0);
	});
	it("a failed actual readiness hook never publishes running admission", async () => {
		await app.register(prismaPlugin);
		registerRestoreBootstrapPlugin(
			app,
			fp(
				async (scope) => {
					await scope.restoreRuntime.bindDestination("fixture-failed-ready");
					scope.addHook("onReady", async () => {
						await scope.prisma.user.create({ data: { username: "fixture-before-failure" } });
						throw new Error("Synthetic required readiness failure");
					});
				},
				{ name: "security", dependencies: ["prisma"] },
			),
		);
		registerRestoreRuntimeActivation(app);
		await expect(app.ready()).rejects.toThrow("Synthetic required readiness failure");
		const observer = new Database(path, { readonly: true });
		try {
			expect(observer.prepare("SELECT phase FROM RestoreRuntimeControl").get()).toEqual({
				phase: "starting",
			});
		} finally {
			observer.close();
		}
		await expect(app.restoreRuntime.runOperation(() => app.prisma.user.count())).rejects.toThrow();
	});
	it("actual session validation and authenticated reads retain detached metadata admission", async () => {
		const config = app.config;
		await app.close();
		const { buildServer } = await import("../../../server.js");
		app = buildServer({ logger: false, env: config });
		await app.ready();
		const session = await app.restoreRuntime.runOperation(async () => {
			const user = await app.prisma.user.create({
				data: { username: "fixture-session", mustChangePassword: false },
			});
			const session = await app.sessionService.createSession(user.id);
			await app.prisma.session.updateMany({ data: { lastAccessedAt: new Date(0) } });
			return session;
		});
		const result = await app.inject({
			method: "GET",
			url: "/auth/me",
			cookies: { arr_session: app.signCookie(session.token) },
		});
		expect(result.statusCode).toBe(200);
		await app.sessionService.drainValidations();
		const rows = await app.restoreRuntime.runOperation(() =>
			app.prisma.session.findMany({ select: { lastAccessedAt: true } }),
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.lastAccessedAt.getTime()).toBeGreaterThan(0);
	}, 30000);
	it("the actual entrypoint reads saved startup settings before listening and joins native shutdown", async () => {
		const listener = createServer();
		await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
		const address = listener.address();
		if (!address || typeof address === "string") throw new Error("Fixture listener missing");
		const expectedPort = address.port;
		await new Promise<void>((resolve, reject) =>
			listener.close((error) => (error ? reject(error) : resolve())),
		);
		const seed = new Database(path);
		try {
			seed
				.prepare(
					"INSERT INTO system_settings (id, apiPort, webPort, trustProxy, secureCookies, updatedAt) VALUES (1, ?, 4200, 1, 1, ?)",
				)
				.run(expectedPort, Date.now());
		} finally {
			seed.close();
		}
		const file = process.env.SQLITE_RESTORE_ADMISSION_ACTOR_FILE;
		if (!file) throw new Error("Native entrypoint actor bundle required");
		const safe = Object.fromEntries(
			["PATH", "LANG", "LC_ALL", "TZ"].flatMap((key) =>
				process.env[key] ? [[key, process.env[key]]] : [],
			),
		);
		const child = fork(file, [url, "", "api-entrypoint"], {
			cwd: directory,
			execArgv: [],
			stdio: ["ignore", "ignore", "pipe", "ipc"],
			env: {
				...safe,
				NODE_ENV: "test",
				DATABASE_URL: url,
				API_HOST: "127.0.0.1",
				LOG_DIR: join(directory, "logs"),
				TRASH_UPDATE_SCHEDULER_ENABLED: "false",
				DISABLE_QUI_CACHE_PREWARM: "true",
				HEAP_AUTO_SNAPSHOT: "0",
				HEAP_AUTO_SNAPSHOT_AT_WARN: "0",
			},
		});
		const exit = new Promise<void>((resolve) => child.once("exit", () => resolve()));
		actors.push({ child, exit });
		let stderr = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 8192) stderr += chunk.toString();
		});
		const port = await new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("exit", () => {
				const category = /does not provide an export/.test(stderr)
					? "missing-export"
					: /Cannot find|ERR_MODULE_NOT_FOUND/.test(stderr)
						? "missing-module"
						: /Dynamic require/.test(stderr)
							? "bundle-require"
							: /RestoreRuntime/.test(stderr)
								? "runtime-admission"
								: /EADDRINUSE/.test(stderr)
									? "occupied-port"
									: "startup-failure";
				reject(new Error(`Actual entrypoint exited before listening (${category})`));
			});
			child.on("message", (value) => {
				if (
					value &&
					typeof value === "object" &&
					"kind" in value &&
					value.kind === "entrypoint-listening" &&
					"port" in value &&
					typeof value.port === "number"
				)
					resolve(value.port);
			});
		});
		try {
			expect(port).toBe(expectedPort);
			expect((await fetch(`http://127.0.0.1:${port}/auth/setup-required`)).status).toBe(200);
			await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
			child.kill("SIGTERM");
			await exit;
			expect(child.exitCode).toBe(0);
			const owner = await acquireSqliteRestoreRuntimeOwnership(url);
			try {
				expect(await owner.tryAcquireExclusive()).toBe(true);
			} finally {
				await owner.close();
			}
		} finally {
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
			await exit;
		}
	}, 30000);
	it.each(["early-response", "aborted-socket"] as const)(
		"actual %s does not release a still-running database handler",
		async (kind) => {
			const config = app.config;
			await app.close();
			const { buildServer } = await import("../../../server.js");
			app = buildServer({ logger: false, env: config });
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			let entered!: () => void;
			const ready = new Promise<void>((resolve) => {
				entered = resolve;
			});
			app.register(async (scope) => {
				scope.get("/fixture-handler", async (_request, reply) => {
					await scope.prisma.user.count();
					entered();
					if (kind === "early-response") reply.send({ accepted: true });
					await gate;
					await scope.prisma.user.create({ data: { username: "fixture-handler" } });
					if (kind === "aborted-socket") return { completed: true };
				});
			});
			let request: ReturnType<typeof httpRequest> | undefined;
			try {
				if (kind === "early-response") {
					expect((await app.inject({ method: "GET", url: "/fixture-handler" })).statusCode).toBe(
						200,
					);
				} else {
					await app.listen({ port: 0, host: "127.0.0.1" });
					const address = app.server.address();
					if (!address || typeof address === "string") throw new Error("Fixture listener missing");
					request = httpRequest({
						host: "127.0.0.1",
						port: address.port,
						path: "/fixture-handler",
					});
					request.on("error", () => {});
					request.end();
				}
				await ready;
				if (request) {
					const socketClosed = new Promise<void>((resolve) => request!.once("close", resolve));
					request.destroy();
					await socketClosed;
				}
				let closed = false;
				const closing = app.close().then(() => {
					closed = true;
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(closed).toBe(false);
				await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
				release();
				await closing;
				expect(count()).toBe(1);
				const owner = await acquireSqliteRestoreRuntimeOwnership(url);
				try {
					expect(await owner.tryAcquireExclusive()).toBe(true);
				} finally {
					await owner.close();
				}
			} finally {
				release();
				request?.destroy();
			}
		},
		30000,
	);
	it("a cloned runtime fails startup without exposing an ordinary database client", async () => {
		supplied = await openRestoreRuntime({ databaseUrl: url });
		app.decorate("restoreRuntime", { ...supplied });
		await expect(
			Promise.resolve(app.register(prismaPlugin)).then(() => undefined),
		).rejects.toThrow();
		expect(app.hasDecorator("prisma")).toBe(false);
		expect(count()).toBe(0);
	});
	it("the plugin refuses a runtime bound to another configured database", async () => {
		const otherPath = join(directory, "other-destination.db");
		copyFileSync(template, otherPath);
		chmodSync(otherPath, 0o600);
		supplied = await openRestoreRuntime({ databaseUrl: `file:${otherPath}` });
		app.decorate("restoreRuntime", supplied);
		await expect(
			Promise.resolve(app.register(prismaPlugin)).then(() => undefined),
		).rejects.toThrow();
		expect(app.hasDecorator("prisma")).toBe(false);
		expect(count()).toBe(0);
	});
	it("Fastify close joins an accepted actual database producer before releasing native ownership", async () => {
		supplied = await openRestoreRuntime({ databaseUrl: url });
		app.decorate("restoreRuntime", supplied);
		await app.register(prismaPlugin);
		await activate(supplied);
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered!: () => void;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const producer = supplied.runIndependentOperation(async () => {
			entered();
			await gate;
			await app.prisma.user.create({ data: { username: "fixture-drained" } });
		});
		await ready;
		let closed = false;
		const closing = app.close().then(() => {
			closed = true;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			await expect(acquireSqliteRestoreRuntimeOwnership(url)).rejects.toThrow();
			release();
			await producer;
			await closing;
			expect(count()).toBe(1);
			const owner = await acquireSqliteRestoreRuntimeOwnership(url);
			try {
				expect(await owner.tryAcquireExclusive()).toBe(true);
			} finally {
				await owner.close();
			}
		} finally {
			release();
			await Promise.allSettled([producer, closing]);
		}
	});
});
