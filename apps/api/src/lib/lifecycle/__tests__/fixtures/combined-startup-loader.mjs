// Real launcher/API entrypoints and IPC; only native I/O/server/socket are fixtures.

import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const indexUrl = new URL("../../../../index.ts", import.meta.url).href;
const stubs = new Map([
	["dotenv/config", ""],
	[
		"./config/env.js",
		`process.stdout.write(JSON.stringify({event:'child',pid:process.pid})+'\\n');if(process.env.TEST_COMBINED_MODE==='duplicate'){const send=process.send.bind(process);process.send=(message,callback)=>send(message,error=>{if(!error)send(message,()=>process.stdout.write(JSON.stringify({event:'duplicate-sent'})+'\\n'));callback(error);});}export const envSchema={safeParse:()=>({success:true,data:{DATABASE_URL:'file:/synthetic-never-opened',API_HOST:'0.0.0.0',API_PORT:3001}})};`,
	],
	[
		"./lib/backup/runtime-schema-startup.js",
		`export async function synchronizeRuntimeSchema(){process.stdout.write(JSON.stringify({event:'native'})+'\\n');if(process.env.TEST_COMBINED_MODE==='held-native'){setInterval(()=>{},1000);process.stdout.write(JSON.stringify({event:'waiting-native'})+'\\n');await new Promise(()=>{});}if(process.env.TEST_COMBINED_MODE==='native-failure')throw Error('synthetic');return{apiPort:3011,webPort:3010,listenAddress:'127.0.0.1'};}`,
	],
	[
		"./lib/backup/restore-runtime-admission.js",
		`export const openRestoreRuntime=async()=>({closeAdmission(){},close:async()=>{},runIndependentOperation:async work=>work()});`,
	],
	[
		"./lib/backup/restore-runtime-bootstrap.js",
		`export const loadRestoreRuntimeStartupSettings=async()=>({apiPort:3011,webPort:3010,trustProxy:false,secureCookies:false});`,
	],
	["./lib/backup/restore-runtime-loss.js", "export const logRestoreRuntimeLoss=()=>{};"],
	["./lib/logger.js", `export const LOG_DIR='synthetic',LOG_LEVEL='fatal',logger={error(){}};`],
	[
		"./lib/utils/version.js",
		`export const getAppVersionInfo=()=>({version:'synthetic',commitSha:'synthetic'});`,
	],
	[
		"./server.js",
		`import{writeFileSync,existsSync}from'node:fs';
export function buildServer({env}){
  const afterConsumption=process.env.TEST_COMBINED_MODE==='restart-after-consumption';
  let restartPending=false;
  // Only the positive first restart waits for the real consumer to remove its channel.
  const timer=setInterval(()=>{
    if(restartPending&&!existsSync(process.env.ARR_COMBINED_STARTUP_DIR))process.exit(42);
  },afterConsumption?10:1000);
  return{config:env,hasDecorator:()=>false,close:async()=>{
    if(process.env.TEST_COMBINED_MODE==='duplicate')await new Promise(()=>{});
    clearInterval(timer);
  },log:{info(){},error(){},warn(){}},notificationService:{notify:async()=>{}},listen:async()=>{
    if(process.env.TEST_COMBINED_MODE==='wait'){
      process.stdout.write(JSON.stringify({event:'waiting'})+'\\n');await new Promise(()=>{});
    }
    if(process.env.TEST_COMBINED_MODE==='malformed')process.send({kind:'invalid'});
    process.stdout.write(JSON.stringify({event:'listening'})+'\\n');
    if(process.env.TEST_COMBINED_MODE==='restart'||afterConsumption){
      try{
        writeFileSync(process.env.TEST_CONTROL_DIR+'/restart-once','1',{flag:'wx',mode:384});
        if(afterConsumption)restartPending=true;
        else setTimeout(()=>process.exit(42),30);
      }catch(error){if(error.code!=='EEXIST')throw error;}
    }
  }};
}`,
	],
]);
registerHooks({
	resolve(specifier, context, next) {
		if (context.parentURL === indexUrl && stubs.has(specifier))
			return {
				url: `data:text/javascript,${encodeURIComponent(stubs.get(specifier))}`,
				shortCircuit: true,
			};
		if (specifier.startsWith("file:") && specifier === indexUrl.replace(/\.ts$/, ".js"))
			return { url: indexUrl, shortCircuit: true };
		if (context.parentURL?.startsWith("file:") && specifier.endsWith(".js")) {
			const target = new URL(specifier, context.parentURL);
			target.pathname = target.pathname.replace(/\.js$/, ".ts");
			if (existsSync(target)) return { url: target.href, shortCircuit: true };
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url.startsWith("file:") && url.endsWith(".ts"))
			return {
				format: "module",
				source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "strip" }),
				shortCircuit: true,
			};
		return next(url, context);
	},
});
