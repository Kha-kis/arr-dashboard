import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Child = EventEmitter & { kill: (signal: string) => boolean };
const boundary = vi.hoisted(() => ({
	children: [] as Child[],
	forwarded: [] as string[],
	spawns: 0,
}));
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawn: (command: string, args: string[], options: { env: Record<string, string> }) => {
		expect(command).toBe(process.env.NODE_ENV === "production" ? "node" : "tsx");
		expect(args).toHaveLength(process.env.NODE_ENV === "production" ? 2 : 1);
		expect(options.env.LAUNCHER_MANAGED).toBe("true");
		// Do not retain or assert on inherited environment values.
		boundary.spawns++;
		const child = new EventEmitter() as Child;
		child.kill = (signal) => {
			boundary.forwarded.push(signal);
			return true;
		};
		boundary.children.push(child);
		return child;
	},
}));

const signals = new Map<string, () => void>();
const exits: Array<string | number | null | undefined> = [];
const currentChild = () => boundary.children[boundary.children.length - 1]!;
const emit = (signal: "SIGTERM" | "SIGINT") => signals.get(signal)!();
async function boot(environment: "production" | "development" = "production") {
	vi.stubEnv("NODE_ENV", environment);
	await import("../../../launcher.js");
}
async function restartTimes(count: number) {
	for (let i = 0; i < count; i++) {
		currentChild().emit("exit", 42, null);
		await vi.advanceTimersByTimeAsync(1000);
	}
}

beforeEach(() => {
	vi.resetModules();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
	vi.setSystemTime(new Date("2026-10-02T00:00:00.000Z"));
	boundary.children.splice(0);
	boundary.forwarded.splice(0);
	boundary.spawns = 0;
	signals.clear();
	exits.splice(0);
	const originalOn = process.on.bind(process);
	vi.spyOn(process, "on").mockImplementation((event, callback) => {
		if (event === "SIGTERM" || event === "SIGINT") {
			signals.set(event, callback as () => void);
			return process;
		}
		return originalOn(event, callback);
	});
	vi.spyOn(process, "exit").mockImplementation((code) => {
		exits.push(code);
		return undefined as never;
	});
	vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe.each(["SIGTERM", "SIGINT"] as const)("launcher termination: %s", (signal) => {
	it.each([0, 10])("supersedes a restart request after %i prior restarts", async (count) => {
		await boot();
		await restartTimes(count);
		emit(signal);
		expect(exits).toEqual([]);
		currentChild().emit("exit", 42, null);
		await vi.advanceTimersByTimeAsync(2000);
		expect(boundary.forwarded).toEqual([signal]);
		expect(boundary.spawns).toBe(count + 1);
		expect(exits).toEqual([0]);
	});

	it("forwards once and joins the child's normal exit despite duplicate signals", async () => {
		await boot();
		emit(signal);
		emit(signal);
		emit(signal === "SIGTERM" ? "SIGINT" : "SIGTERM");
		expect(exits).toEqual([]);
		currentChild().emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(2000);
		expect(boundary.forwarded).toEqual([signal]);
		expect(boundary.spawns).toBe(1);
		expect(exits).toEqual([0]);
	});

	it("cancels a pending replacement and exits without another child", async () => {
		await boot();
		currentChild().emit("exit", 42, null);
		emit(signal);
		await vi.advanceTimersByTimeAsync(2000);
		expect(boundary.forwarded).toEqual([]);
		expect(boundary.spawns).toBe(1);
		expect(exits).toEqual([0]);
	});

	it("preserves an actual child failure during requested termination", async () => {
		await boot();
		emit(signal);
		currentChild().emit("exit", 3, null);
		await vi.advanceTimersByTimeAsync(2000);
		expect(boundary.spawns).toBe(1);
		expect(exits).toEqual([3]);
	});

	it("still forwards and joins a clean child when the launcher log sink throws", async () => {
		await boot();
		vi.mocked(console.log).mockImplementation(() => {
			throw new Error("Synthetic sink unavailable");
		});
		expect(() => emit(signal)).not.toThrow();
		expect(boundary.forwarded).toEqual([signal]);
		expect(exits).toEqual([]);
		expect(() => currentChild().emit("exit", 0, null)).not.toThrow();
		await vi.advanceTimersByTimeAsync(2000);
		expect(exits).toEqual([0]);
		expect(boundary.spawns).toBe(1);
	});
});

it("retains the restart-loop guard when no termination was requested", async () => {
	await boot();
	await restartTimes(10);
	currentChild().emit("exit", 42, null);
	await vi.advanceTimersByTimeAsync(2000);
	expect(boundary.spawns).toBe(11);
	expect(exits).toEqual([1]);
});

it("allows an ordinary restart after the old rate-limit window expires", async () => {
	await boot();
	await restartTimes(10);
	await vi.advanceTimersByTimeAsync(60000);
	currentChild().emit("exit", 42, null);
	await vi.advanceTimersByTimeAsync(1000);
	expect(boundary.spawns).toBe(12);
	expect(exits).toEqual([]);
});

it.each(["production", "development"] as const)(
	"preserves ordinary managed restart and exit propagation in %s",
	async (environment) => {
		await boot(environment);
		currentChild().emit("exit", 42, null);
		await vi.advanceTimersByTimeAsync(1000);
		expect(boundary.spawns).toBe(2);
		expect(exits).toEqual([]);
		currentChild().emit("exit", 0, null);
		expect(exits).toEqual([0]);
	},
);

it("reports an unexpected signal death as failure without replacement", async () => {
	await boot();
	currentChild().emit("exit", null, "SIGKILL");
	await vi.advanceTimersByTimeAsync(2000);
	expect(boundary.spawns).toBe(1);
	expect(exits).toEqual([1]);
});

it("reports a spawn error without admitting a replacement", async () => {
	await boot();
	currentChild().emit("error", new Error("Synthetic spawn unavailable"));
	await vi.advanceTimersByTimeAsync(2000);
	expect(boundary.spawns).toBe(1);
	expect(exits).toEqual([1]);
});

describe("configured child shutdown grace", () => {
	it("allows a clean child beyond five seconds without renewing the deadline on duplicate signals", async () => {
		vi.stubEnv("SHUTDOWN_GRACE", "12");
		await boot();
		emit("SIGTERM");
		await vi.advanceTimersByTimeAsync(6500);
		emit("SIGINT");
		expect(boundary.forwarded).toEqual(["SIGTERM"]);
		expect(exits).toEqual([]);
		currentChild().emit("exit", 0, null);
		await vi.advanceTimersByTimeAsync(12000);
		expect(boundary.forwarded).toEqual(["SIGTERM"]);
		expect(exits).toEqual([0]);
		expect(boundary.spawns).toBe(1);
	});

	it.each([
		{ configured: "0", deadlineMs: 0 },
		{ configured: "1", deadlineMs: 0 },
		{ configured: "7", deadlineMs: 6000 },
		{ configured: "12", deadlineMs: 11000 },
		{ configured: "00012", deadlineMs: 11000 },
		{ configured: "2147483", deadlineMs: 2147482000 },
		{ configured: undefined, deadlineMs: 6000 },
		{ configured: "", deadlineMs: 6000 },
		{ configured: "-1", deadlineMs: 6000 },
		{ configured: "1.5", deadlineMs: 6000 },
		{ configured: " 12", deadlineMs: 6000 },
		{ configured: "abc", deadlineMs: 6000 },
		{ configured: "2147484", deadlineMs: 6000 },
		{ configured: "999999999999999999999999999", deadlineMs: 6000 },
	])(
		"forces a hung child once at the finite deadline: $configured",
		async ({ configured, deadlineMs }) => {
			vi.stubEnv("SHUTDOWN_GRACE", configured);
			await boot();
			emit("SIGTERM");
			if (deadlineMs > 0) {
				await vi.advanceTimersByTimeAsync(deadlineMs - 1);
				expect(boundary.forwarded).toEqual(["SIGTERM"]);
				expect(exits).toEqual([]);
			}
			await vi.advanceTimersByTimeAsync(deadlineMs > 0 ? 1 : 0);
			expect(boundary.forwarded).toEqual(["SIGTERM", "SIGKILL"]);
			expect(exits).toEqual([]);
			currentChild().emit("exit", null, "SIGKILL");
			await vi.advanceTimersByTimeAsync(12000);
			expect(boundary.forwarded).toEqual(["SIGTERM", "SIGKILL"]);
			expect(exits).toEqual([1]);
			expect(boundary.spawns).toBe(1);
		},
	);
});

// Disposable native processes import the current launcher and current API.
// Only configuration/bootstrap and socket listening are substituted. Signals,
// child exit, Fastify, lifecycle and accepted hydration work remain real.
const apiChild = String.raw`import {registerHooks} from "node:module";
import {writeSync} from "node:fs";
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
 if(context.parentURL===indexUrl&&stubs.has(specifier))
  return {url:"data:text/javascript,"+encodeURIComponent(stubs.get(specifier)),shortCircuit:true};
 return next(specifier,context);
}});
let release;
const gate=new Promise(resolve=>release=resolve);
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
 server.addHook("onClose",async()=>{state.teardown=true;if(process.env.TEST_CLOSE_FAILURE==="true")throw new Error("Synthetic close unavailable");});
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
const failSafe=setTimeout(()=>realExit(2),3500);failSafe.unref();
process.exit=code=>{
 const settled=state.reads===1&&state.pending===0&&state.closeCalls===1&&state.teardown&&state.network===0&&state.forbidden===0;
 realExit(settled?code:2);
};
await import(indexUrl);
const settle=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,async()=>{
 await settle();writeSync(1,JSON.stringify({phase:"held",...state})+"\n");
});
process.stdin.once("data",data=>{if(data.toString()!=="release\n")state.forbidden++;release();});
await settle();
writeSync(1,JSON.stringify({phase:"ready",...state})+"\n");`;
const launcherParent = String.raw`import {registerHooks} from "node:module";
import {spawn} from "node:child_process";
import {writeSync} from "node:fs";
const launcherUrl=new URL("./src/launcher.ts",import.meta.url).href;
const signal=process.env.TEST_SIGNAL;
const closeFails=process.env.TEST_CLOSE_FAILURE;
const state={spawns:0,forwarded:0,ready:false,drainHeld:false,childSettled:false,childCode:null,forbidden:0};
const apiCode=API_CODE_PLACEHOLDER;
const realExit=process.exit.bind(process);
process.exit=code=>{writeSync(1,JSON.stringify({phase:"launcher-exit",code,...state})+"\n");realExit(code);};
console.log=()=>{};
globalThis.fixtureSpawn=(command,args,options)=>{
 if(command!=="node"||args[0]!=="--enable-source-maps"||options.env.LAUNCHER_MANAGED!=="true"||options.stdio!=="inherit")state.forbidden++;
 state.spawns++;
 const child=spawn(process.execPath,["--import",import.meta.resolve("tsx/esm"),"--input-type=module","--eval",apiCode],{
  stdio:["pipe","pipe","pipe"],
  env:{NODE_ENV:"test",LAUNCHER_MANAGED:"true",TEST_CLOSE_FAILURE:closeFails,LOG_LEVEL:"fatal"}
 });
 const watchdog=setTimeout(()=>{state.forbidden++;child.stdin.end("release\n");child.kill("SIGTERM");},2500);watchdog.unref();
 child.once("exit",()=>clearTimeout(watchdog));
 const realKill=child.kill.bind(child);
 child.kill=s=>{state.forwarded++;return realKill(s);};
 let output="";
 child.stdout.on("data",data=>{
  output+=data.toString();
  while(output.includes("\n")){
   const end=output.indexOf("\n"),line=output.slice(0,end);output=output.slice(end+1);
   let row;try{row=JSON.parse(line);}catch{state.forbidden++;continue;}
   if(row.reads!==1||row.pending!==1||row.teardown||row.network!==0||row.forbidden!==0)state.forbidden++;
   if(row.phase==="ready"){
    if(row.closeCalls!==0)state.forbidden++;
    state.ready=true;process.kill(process.pid,signal);
   }else if(row.phase==="held"){
    if(row.closeCalls!==1||state.childSettled||!state.ready)state.forbidden++;
    state.drainHeld=true;
    process.kill(process.pid,signal);
    process.kill(process.pid,signal==="SIGTERM"?"SIGINT":"SIGTERM");
    child.stdin.end("release\n");
   }else state.forbidden++;
  }
 });
 child.stderr.on("data",()=>{state.forbidden++;});
 child.on("exit",code=>{state.childSettled=true;state.childCode=code;});
 return child;
};
registerHooks({resolve(specifier,context,next){
 if(context.parentURL===launcherUrl&&specifier==="node:child_process")
  return {url:"data:text/javascript,export const spawn=(...args)=>globalThis.fixtureSpawn(...args);",shortCircuit:true};
 return next(specifier,context);
}});
await import(launcherUrl);`;
describe.each(["SIGTERM", "SIGINT"] as const)("actual launcher/API handoff: %s", (signal) => {
	it.each([false, true])(
		"joins the API drain and propagates its exit (close fails: %s)",
		(closeFails) => {
			const result = spawnSync(
				process.execPath,
				[
					"--import",
					import.meta.resolve("tsx/esm"),
					"--input-type=module",
					"--eval",
					launcherParent.replace("API_CODE_PLACEHOLDER", JSON.stringify(apiChild)),
				],
				{
					cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
					env: {
						NODE_ENV: "production",
						TEST_SIGNAL: signal,
						TEST_CLOSE_FAILURE: String(closeFails),
					},
					encoding: "utf8",
					timeout: 5000,
				},
			);
			expect(result.error).toBeUndefined();
			expect(result.signal).toBeNull();
			expect(result.stderr).toBe("");
			expect(result.status).toBe(closeFails ? 1 : 0);
			expect(JSON.parse(result.stdout.trim())).toEqual({
				phase: "launcher-exit",
				code: closeFails ? 1 : 0,
				spawns: 1,
				forwarded: 1,
				ready: true,
				drainHeld: true,
				childSettled: true,
				childCode: closeFails ? 1 : 0,
				forbidden: 0,
			});
		},
		8000,
	);
});
