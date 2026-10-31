import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import hydrationPlugin from "../../../plugins/inode-index-hydration.js";
import lifecyclePlugin from "../../../plugins/lifecycle.js";
import { installNonDatabaseRuntimeFixture } from "../../__tests__/runtime-admission-fixture.js";
import { withCleanupMaintenanceGuard } from "../../library-cleanup/cleanup-maintenance-gate.js";

// Actual index.ts + Fastify/lifecycle/hydration. Replace only configuration,
// unrelated bootstrap, socket listen, process termination and process spawning.
// No application config, stored credentials, real database or providers.
const boundary = vi.hoisted(() => ({
	app: null as FastifyInstance | null,
	notifications: 0,
	spawns: 0,
}));
vi.mock("dotenv/config", () => ({}));
vi.mock("../../../config/env.js", () => ({
	envSchema: { safeParse: () => ({ success: true, data: { API_HOST: "127.0.0.1" } }) },
}));
vi.mock("../../config/port-config.js", () => ({
	getPortConfig: () => ({ apiPort: 29999 }),
	getSecurityConfig: () => ({ trustProxy: false }),
	logPortConfig: () => {},
	logSecurityConfig: () => {},
}));
vi.mock("../../logger.js", () => ({
	LOG_DIR: "synthetic",
	LOG_LEVEL: "fatal",
	logger: { error: vi.fn() },
}));
vi.mock("../../utils/version.js", () => ({
	getAppVersionInfo: () => ({ version: "synthetic", commitSha: "synthetic" }),
}));
vi.mock("../../../server.js", () => ({
	buildServer: ({ env }: { env: unknown }) => {
		boundary.app!.decorate("config", env as never);
		return boundary.app;
	},
}));
// This suite already replaces server/database setup. Keep the new owner and
// settings boundaries synthetic too; native entrypoint proof lives elsewhere.
vi.mock("../../backup/restore-runtime-admission.js", () => ({
	openRestoreRuntime: async () => boundary.app!.restoreRuntime,
}));
vi.mock("../../backup/restore-runtime-bootstrap.js", () => ({
	loadRestoreRuntimeStartupSettings: async () => null,
}));
vi.mock("../../backup/runtime-schema-startup.js", () => ({
	synchronizeRuntimeSchema: async () => null,
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	// Never pass or retain inherited process.env in a spy or assertion.
	spawn: () => {
		boundary.spawns++;
		return { pid: 12345, unref: () => {} };
	},
}));

const apps: FastifyInstance[] = [];
const releases: Array<() => void> = [];
const signals = new Map<string, () => void>();
const exitCodes: Array<string | number | null | undefined> = [];
let startupErrors = 0;
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	releases.push(resolve);
	return { promise, resolve };
}
async function settle() {
	for (let i = 0; i < 8; i++) await new Promise<void>((done) => setImmediate(done));
}
function emit(signal: "SIGTERM" | "SIGINT") {
	// Only invoke this entrypoint's registered handler; never emit a signal on
	// the test runner or affect an unrelated handler.
	signals.get(signal)?.();
}
async function boot(
	options: {
		readGate?: Promise<void>;
		initGate?: Promise<void>;
		readFails?: boolean;
		closeFails?: boolean;
		listenFails?: boolean;
		listenError?: Error;
		initFails?: boolean;
		environment?: "production" | "development";
		launcher?: boolean;
	} = {},
) {
	vi.stubEnv("NODE_ENV", options.environment ?? "production");
	vi.stubEnv("LAUNCHER_MANAGED", String(options.launcher ?? false));
	const app = Fastify({ logger: false });
	installNonDatabaseRuntimeFixture(app);
	const errors = vi.spyOn(app.log, "error");
	const closeError = new Error("Synthetic close unavailable");
	apps.push(app);
	boundary.app = app;
	const state = { pending: 0, reads: 0, teardown: false, afterTeardown: 0 };
	app.register(
		fp(
			async (instance) => {
				await options.initGate;
				if (options.initFails) throw new Error("Synthetic readiness unavailable");
				instance.decorate("prisma", {
					inodeIndexCache: {
						findMany: async (args: unknown) => {
							expect(args).toEqual({
								select: {
									instanceId: true,
									builtAt: true,
									serializedData: true,
									filesIndexed: true,
									instance: { select: { connectionGeneration: true } },
								},
							});
							state.reads++;
							state.pending++;
							if (state.teardown) state.afterTeardown++;
							try {
								await options.readGate;
								if (options.readFails) throw new Error("Synthetic snapshot read unavailable");
								return [];
							} finally {
								state.pending--;
								if (state.teardown) state.afterTeardown++;
							}
						},
					},
				} as unknown as FastifyInstance["prisma"]);
				instance.addHook("onClose", async () => {
					state.teardown = true;
					expect(state.pending).toBe(0);
					if (options.closeFails) throw closeError;
				});
			},
			{ name: "prisma" },
		),
	);
	app.register(fp(async () => {}, { name: "inode-correlation-upgrade" }));
	app.register(lifecyclePlugin);
	app.register(hydrationPlugin);
	app.decorate("notificationService", {
		notify: async () => {
			boundary.notifications++;
		},
	} as unknown as FastifyInstance["notificationService"]);
	vi.spyOn(app, "listen").mockImplementation(async () => {
		await app.ready();
		if (options.listenError) throw options.listenError;
		if (options.listenFails) throw new Error("Synthetic listener unavailable");
		return "synthetic";
	});
	const close = vi.spyOn(app, "close");
	await import("../../../index.js");
	await settle();
	return { app, state, close, errors, closeError };
}

beforeEach(() => {
	vi.resetModules();
	boundary.notifications = 0;
	boundary.spawns = 0;
	signals.clear();
	exitCodes.splice(0);
	startupErrors = 0;
	// index.ts overwrites these resolved configuration fields. Stub first so
	// teardown restores them, without ever reading/printing original values.
	vi.stubEnv("API_PORT", "29999");
	vi.stubEnv("TRUST_PROXY", "false");
	vi.stubEnv("COOKIE_SECURE", "false");
	const originalOn = process.on.bind(process);
	vi.spyOn(process, "on").mockImplementation((event, callback) => {
		if (event === "SIGTERM" || event === "SIGINT") {
			signals.set(event, callback as () => void);
			return process;
		}
		return originalOn(event, callback);
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exitCodes.push(code);
		return undefined as never;
	});
	vi.spyOn(console, "error").mockImplementation(() => {
		startupErrors++;
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Fixture forbids network");
	});
});
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	await settle();
	await Promise.all(apps.splice(0).map((app) => app.close().catch(() => {})));
	await settle();
	expect(globalThis.fetch).not.toHaveBeenCalled();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.useRealTimers();
	await expect(withCleanupMaintenanceGuard(async () => true)).resolves.toBe(true);
});

describe.each(["SIGTERM", "SIGINT"] as const)("API termination: %s", (signal) => {
	it.each([
		{ category: "unattributed", error: new Error("Synthetic listener unavailable") },
		{
			category: "bind-conflict",
			error: Object.assign(new Error("Synthetic bind unavailable"), { code: "EADDRINUSE" }),
		},
	])(
		"reports a $category listener failure during termination and still drains",
		async ({ error }) => {
			const init = deferred(),
				read = deferred();
			const { state } = await boot({
				initGate: init.promise,
				readGate: read.promise,
				listenError: error,
			});
			emit(signal);
			await settle();
			init.resolve();
			await settle();
			expect(exitCodes).toEqual([]);
			read.resolve();
			await settle();
			expect(state.afterTeardown).toBe(0);
			expect(exitCodes).toEqual([1]);
			expect(boundary.notifications).toBe(0);
			expect(startupErrors).toBe(1);
		},
	);

	it("reports a readiness failure racing termination without replacing the process", async () => {
		const init = deferred();
		const { close } = await boot({ initGate: init.promise, initFails: true });
		emit(signal);
		await settle();
		expect(exitCodes).toEqual([]);
		init.resolve();
		await settle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(exitCodes).toEqual([1]);
		expect(boundary.notifications).toBe(0);
		expect(boundary.spawns).toBe(0);
		expect(startupErrors).toBe(1);
	});

	it("reports a bounded close failure before lifecycle decoration exists", async () => {
		const init = deferred();
		const { app, close, errors } = await boot({
			initGate: init.promise,
			closeFails: true,
		});
		expect(app.hasDecorator("lifecycle")).toBe(false);
		emit(signal);
		await settle();
		init.resolve();
		await settle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(exitCodes).toEqual([1]);
		expect(errors).toHaveBeenCalledWith("API shutdown failed");
		expect(boundary.notifications).toBe(0);
		expect(boundary.spawns).toBe(0);
	});

	it.each([false, true])(
		"joins accepted hydration before exit (read rejects: %s)",
		async (readFails) => {
			const gate = deferred();
			const { app, state, close } = await boot({ readGate: gate.promise, readFails });
			expect(state.pending).toBe(1);
			emit(signal);
			await settle();
			expect(close).toHaveBeenCalledTimes(1);
			expect(exitCodes).toEqual([]);
			expect(state.teardown).toBe(false);
			await expect(app.lifecycle.runHttpHandler(async () => true)).rejects.toMatchObject({
				statusCode: 503,
			});
			emit(signal);
			emit(signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
			await settle();
			expect(close).toHaveBeenCalledTimes(1);
			gate.resolve();
			await settle();
			expect(exitCodes).toEqual([0]);
			expect(state.pending).toBe(0);
			expect(state.teardown).toBe(true);
			expect(state.afterTeardown).toBe(0);
			expect(boundary.spawns).toBe(0);
		},
	);

	it("handles termination before the lifecycle decoration exists and suppresses startup notification", async () => {
		const init = deferred(),
			read = deferred();
		const { app, state, close } = await boot({ initGate: init.promise, readGate: read.promise });
		expect(app.hasDecorator("lifecycle")).toBe(false);
		emit(signal);
		await settle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(exitCodes).toEqual([]);
		init.resolve();
		await settle();
		expect(state.pending).toBe(1);
		expect(boundary.notifications).toBe(0);
		expect(state.teardown).toBe(false);
		read.resolve();
		await settle();
		expect(exitCodes).toEqual([0]);
		expect(boundary.notifications).toBe(0);
		expect(state.afterTeardown).toBe(0);
	});

	it("exits unsuccessfully if database teardown fails, with no replacement", async () => {
		const { state } = await boot({ closeFails: true });
		emit(signal);
		await settle();
		expect(state.teardown).toBe(true);
		expect(exitCodes).toEqual([1]);
		expect(boundary.spawns).toBe(0);
	});

	it("drains an accepted HTTP handler, rejects new work, and waits for its actual result", async () => {
		const gate = deferred();
		const { app, close } = await boot();
		const flight = app.lifecycle.runHttpHandler(async () => {
			await gate.promise;
			return "settled";
		});
		emit(signal);
		await settle();
		expect(close).toHaveBeenCalledTimes(1);
		expect(exitCodes).toEqual([]);
		await expect(app.lifecycle.runHttpHandler(async () => true)).rejects.toMatchObject({
			statusCode: 503,
		});
		gate.resolve();
		await expect(flight).resolves.toBe("settled");
		await settle();
		expect(exitCodes).toEqual([0]);
	});
});

it("drains accepted startup work before exiting after a listen failure", async () => {
	const gate = deferred();
	const { state, close } = await boot({ readGate: gate.promise, listenFails: true });
	expect(state.pending).toBe(1);
	expect(close).toHaveBeenCalledTimes(1);
	expect(exitCodes).toEqual([]);
	expect(boundary.notifications).toBe(0);
	gate.resolve();
	await settle();
	expect(exitCodes).toEqual([1]);
	expect(state.afterTeardown).toBe(0);
	expect(boundary.spawns).toBe(0);
});

it("preserves ordinary startup without a shutdown request", async () => {
	const { state, close } = await boot();
	expect(boundary.notifications).toBe(1);
	expect(state.pending).toBe(0);
	expect(state.teardown).toBe(false);
	expect(close).not.toHaveBeenCalled();
	expect(exitCodes).toEqual([]);
	expect(boundary.spawns).toBe(0);
});

// Native module hooks stub only direct entrypoint configuration/bootstrap.
// The child imports current index.ts normally; it uses actual OS signals,
// Fastify, lifecycle and hydration with a held synthetic persistence read.
const signalChild = String.raw`
import {registerHooks} from "node:module";
import Fastify from "fastify";
import fp from "fastify-plugin";
import lifecyclePlugin from "./src/plugins/lifecycle.ts";
import hydrationPlugin from "./src/plugins/inode-index-hydration.ts";
import {installNonDatabaseRuntimeFixture} from "./src/lib/__tests__/runtime-admission-fixture.ts";
const indexUrl=new URL("./src/index.ts",import.meta.url).href;
const stubs=new Map([
 ["dotenv/config",""],
 ["./config/env.js",'export const envSchema={safeParse:()=>({success:true,data:{API_HOST:"127.0.0.1"}})};'],
 ["./lib/config/port-config.js",'export const getPortConfig=()=>({apiPort:29999});export const getSecurityConfig=()=>({trustProxy:false});export const logPortConfig=()=>{};export const logSecurityConfig=()=>{};'],
 ["./lib/logger.js",'export const LOG_DIR="synthetic";export const LOG_LEVEL="fatal";export const logger={error(){}};'],
 ["./lib/utils/version.js",'export const getAppVersionInfo=()=>({version:"synthetic",commitSha:"synthetic"});'],
 ["./server.js",'export const buildServer=({env})=>{globalThis.fixtureApp.decorate("config",env);return globalThis.fixtureApp;};'],
 ["./lib/backup/restore-runtime-admission.js",'export const openRestoreRuntime=async()=>globalThis.fixtureApp.restoreRuntime;'],
 ["./lib/backup/restore-runtime-bootstrap.js",'export const loadRestoreRuntimeStartupSettings=async()=>null;'],
 ["./lib/backup/runtime-schema-startup.js",'export const synchronizeRuntimeSchema=async()=>null;'],
]);
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===indexUrl && stubs.has(specifier)){
  return {url:"data:text/javascript,"+encodeURIComponent(stubs.get(specifier)),shortCircuit:true};
 }
 return next(specifier,context);
}});
let release;
const gate=new Promise(r=>release=r);
const state={reads:0,pending:0,closeCalls:0,teardown:false,network:0,forbidden:0};
globalThis.fetch=async()=>{state.network++;throw new Error("Network forbidden");};
const app=Fastify({logger:false});
installNonDatabaseRuntimeFixture(app);
app.register(fp(async server=>{
 server.decorate("prisma",{inodeIndexCache:{findMany:async args=>{
 const want={select:{instanceId:true,builtAt:true,serializedData:true,filesIndexed:true,instance:{select:{connectionGeneration:true}}}};
 if(JSON.stringify(args)!==JSON.stringify(want)){state.forbidden++;throw new Error("Query forbidden");}
 state.reads++;state.pending++;await gate;state.pending--;return [];
 }}});
 server.addHook("onClose",async()=>{state.teardown=true;if(process.env.TEST_CLOSE_FAILURE==="true")throw new Error("Synthetic close failure");});
},{name:"prisma"}));
app.register(fp(async()=>{},{name:"inode-correlation-upgrade"}));
app.register(lifecyclePlugin);
app.register(hydrationPlugin);
app.decorate("notificationService",{notify:async()=>{}});
app.listen=async()=>{await app.ready();return "synthetic";};
const originalClose=app.close.bind(app);
app.close=(...args)=>{state.closeCalls++;return originalClose(...args);};
globalThis.fixtureApp=app;
const realExit=process.exit.bind(process);
process.exit=code=>{process.stdout.write(JSON.stringify({phase:"exit",code,...state})+"\n");realExit(code);};
const keepAlive=setInterval(()=>{},1000);
await import(indexUrl);
for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
process.stdout.write(JSON.stringify({phase:"ready",...state})+"\n");
process.kill(process.pid,process.env.TEST_SIGNAL);
for(let i=0;i<8;i++)await new Promise(r=>setImmediate(r));
process.stdout.write(JSON.stringify({phase:"held",...state})+"\n");
release();
`;
describe.each(["SIGTERM", "SIGINT"] as const)("actual disposable-child signal: %s", (signal) => {
	it.each([false, true])(
		"exits only after the actual entrypoint drain (close fails: %s)",
		(closeFails) => {
			const result = spawnSync(
				process.execPath,
				["--import", import.meta.resolve("tsx/esm"), "--input-type=module", "--eval", signalChild],
				{
					cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
					env: {
						NODE_ENV: "test",
						LAUNCHER_MANAGED: "true",
						TEST_SIGNAL: signal,
						TEST_CLOSE_FAILURE: String(closeFails),
						LOG_LEVEL: "fatal",
					},
					encoding: "utf8",
					timeout: 5000,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.stderr).toBe("");
			expect(result.status).toBe(closeFails ? 1 : 0);
			expect(
				result.stdout
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).toEqual([
				{
					phase: "ready",
					reads: 1,
					pending: 1,
					closeCalls: 0,
					teardown: false,
					network: 0,
					forbidden: 0,
				},
				{
					phase: "held",
					reads: 1,
					pending: 1,
					closeCalls: 1,
					teardown: false,
					network: 0,
					forbidden: 0,
				},
				{
					phase: "exit",
					code: closeFails ? 1 : 0,
					reads: 1,
					pending: 0,
					closeCalls: 1,
					teardown: true,
					network: 0,
					forbidden: 0,
				},
			]);
		},
		8000,
	);
});
const modes = [
	{ environment: "production" as const, launcher: false },
	{ environment: "production" as const, launcher: true },
	{ environment: "development" as const, launcher: true },
	{ environment: "development" as const, launcher: false },
];
describe.each(modes)("termination versus restart: $environment / launcher=$launcher", (mode) => {
	it.each([
		{ phase: "queued", closeFails: false },
		{ phase: "draining", closeFails: false },
		{ phase: "queued", closeFails: true },
		{ phase: "draining", closeFails: true },
	])(
		"supersedes a $phase restart with one exit (close fails: $closeFails)",
		async ({ phase, closeFails }) => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const gate = deferred();
			const { app, state, close } = await boot({ ...mode, readGate: gate.promise, closeFails });
			await app.lifecycle.restart("synthetic-restart");
			if (phase === "draining") await vi.advanceTimersByTimeAsync(1500);
			emit("SIGTERM");
			await settle();
			await vi.advanceTimersByTimeAsync(1500);
			expect(close).toHaveBeenCalledTimes(1);
			expect(exitCodes).toEqual([]);
			gate.resolve();
			await settle();
			expect(state.afterTeardown).toBe(0);
			expect(boundary.spawns).toBe(0);
			expect(exitCodes).toEqual([closeFails ? 1 : 0]);
			await app.lifecycle.restart("late-restart");
			await vi.advanceTimersByTimeAsync(1500);
			expect(close).toHaveBeenCalledTimes(1);
			expect(boundary.spawns).toBe(0);
			expect(exitCodes).toEqual([closeFails ? 1 : 0]);
		},
	);
});
