// Keep launcher/index/routes/lifecycle real; replace only startup and server I/O.
import { existsSync, readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const indexUrl = new URL("../../../../index.ts", import.meta.url).href;
const serverUrl = new URL("./restart-action-server.mjs", import.meta.url).href;
const loggerUrl = new URL("../../../logger.js", import.meta.url).href;
const versionUrl = new URL("../../../utils/version.js", import.meta.url).href;
const logger = `export const LOG_DIR='/synthetic-unused',LOG_LEVEL='fatal',LOG_MAX_FILES=1,LOG_MAX_SIZE=1,logger={error(){}};`;
const version = `export const getAppVersionInfo=()=>({version:'synthetic',commitSha:'synthetic'});`;
const stubs = new Map([
	["dotenv/config", ""],
	[
		"./config/env.js",
		`import{writeSync}from'node:fs';
const emit=(event,extra={})=>writeSync(1,JSON.stringify({event,pid:process.pid,...extra})+'\\n');
emit('child');process.on('exit',code=>emit('child-exit',{code}));
export const envSchema={safeParse:()=>({success:true,data:{DATABASE_URL:'file:/synthetic-never-opened',API_HOST:'127.0.0.1',API_PORT:3001}})};`,
	],
	[
		"./lib/backup/runtime-schema-startup.js",
		`export const synchronizeRuntimeSchema=async()=>({apiPort:3001,webPort:3000,listenAddress:'127.0.0.1'});`,
	],
	[
		"./lib/backup/restore-runtime-admission.js",
		`export const openRestoreRuntime=async()=>({closeAdmission(){},close:async()=>{},runOperation:async work=>work(),runIndependentOperation:async work=>work()});
export const getRestoreRuntimeShutdownStatus=()=>({});`,
	],
	[
		"./lib/backup/restore-runtime-bootstrap.js",
		`export const loadRestoreRuntimeStartupSettings=async()=>({apiPort:3001,webPort:3000,trustProxy:false,secureCookies:false});`,
	],
	["./lib/backup/restore-runtime-loss.js", "export const logRestoreRuntimeLoss=()=>{};"],
]);

registerHooks({
	resolve(specifier, context, next) {
		if (context.parentURL === indexUrl) {
			if (specifier === "./server.js") return { url: serverUrl, shortCircuit: true };
			if (stubs.has(specifier))
				return {
					url: `data:text/javascript,${encodeURIComponent(stubs.get(specifier))}`,
					shortCircuit: true,
				};
		}
		if (specifier === indexUrl.replace(/\.ts$/, ".js"))
			return { url: indexUrl, shortCircuit: true };
		if (context.parentURL?.startsWith("file:") && specifier.startsWith(".")) {
			const target = new URL(specifier, context.parentURL);
			const source =
				target.href === loggerUrl ? logger : target.href === versionUrl ? version : null;
			if (source !== null)
				return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
			if (specifier.endsWith(".js")) {
				target.pathname = target.pathname.replace(/\.js$/, ".ts");
				if (existsSync(target)) return { url: target.href, shortCircuit: true };
			}
		}
		return next(specifier, context);
	},
	load(url, context, next) {
		if (url.startsWith("file:") && url.endsWith(".ts"))
			return {
				format: "module",
				source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), {
					mode: "transform",
				}),
				shortCircuit: true,
			};
		return next(url, context);
	},
});
