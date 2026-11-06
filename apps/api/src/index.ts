import "dotenv/config";
import { envSchema } from "./config/env.js";
import {
	getRestoreRuntimeShutdownStatus,
	openRestoreRuntime,
	type RestoreRuntime,
} from "./lib/backup/restore-runtime-admission.js";
import { loadRestoreRuntimeStartupSettings } from "./lib/backup/restore-runtime-bootstrap.js";
import { logRestoreRuntimeLoss } from "./lib/backup/restore-runtime-loss.js";
import { synchronizeRuntimeSchema } from "./lib/backup/runtime-schema-startup.js";
import {
	getPortConfig,
	getSecurityConfig,
	logPortConfig,
	logSecurityConfig,
} from "./lib/config/port-config.js";
import {
	type CombinedStartupMessage,
	parseCombinedStartupMessage,
	readCombinedStartupMode,
	resolveCombinedStartupSettings,
} from "./lib/lifecycle/combined-startup.js";
import {
	getShutdownSchedulerStatus,
	type ShutdownPhase,
	startShutdownProgress,
} from "./lib/lifecycle/shutdown-progress.js";
import { LOG_DIR, LOG_LEVEL, logger } from "./lib/logger.js";
import { getAppVersionInfo } from "./lib/utils/version.js";
import { buildServer } from "./server.js";

// Validate unrelated environment settings before database I/O. Combined initial
// boot selects its API port from native DB settings first; validate that effective
// port in the resolver below, not a raw value that the saved setting overrides.
const combinedInitial =
	process.env.LAUNCHER_MANAGED === "true" &&
	process.env.ARR_COMBINED_STARTUP_PHASE === "initial" &&
	/^[a-f0-9]{64}$/.test(process.env.ARR_COMBINED_STARTUP_NONCE ?? "");
const envResult = envSchema.safeParse(
	combinedInitial ? { ...process.env, API_PORT: "3001" } : process.env,
);
if (!envResult.success) {
	console.error("\n========================================");
	console.error("ERROR: Invalid environment configuration");
	console.error("========================================\n");

	for (const issue of envResult.error.issues) {
		const envVar = issue.path.join(".");
		console.error(`  ✗ ${envVar}: ${issue.message}`);
		// Add helpful hints for common issues
		if (envVar === "SESSION_TTL_HOURS") {
			console.error("    Hint: Valid range is 1-720 hours (max 30 days). Default is 24 hours.");
		}
	}

	console.error("\nPlease check your environment variables and restart the container.\n");
	process.exit(1);
}
const validatedEnv = envResult.data;

const start = async () => {
	let app: ReturnType<typeof buildServer> | undefined;
	let runtime: RestoreRuntime | undefined;
	let initialization: Promise<void> = Promise.resolve();
	let shutdown: Promise<void> | undefined;
	let failedShutdown = false;
	let combinedMessage: CombinedStartupMessage | undefined;
	function closeAndExit(failed = false): Promise<void> {
		failedShutdown ||= failed;
		// Keep both listeners installed throughout the drain: a repeated signal
		// must not restore Node's default immediate termination behavior.
		shutdown ??= Promise.resolve()
			.then(async () => {
				let phase: Exclude<ShutdownPhase, "complete" | "failed"> = "initialization";
				let outcome: "complete" | "failed" | undefined;
				let failedPhase: "initialization" | "fastify" | "runtime" | undefined;
				const progress = startShutdownProgress({
					read: () => ({
						phase: outcome ?? phase,
						...(failedPhase ? { failedPhase } : {}),
						...(runtime ? { runtime: getRestoreRuntimeShutdownStatus(runtime) } : {}),
						...(app?.hasDecorator("lifecycle") ? app.lifecycle.getShutdownStatus() : {}),
						...(app?.hasDecorator("schedulerRegistry")
							? getShutdownSchedulerStatus(app.schedulerRegistry.list())
							: {}),
					}),
					report: (payload) => {
						const log = app?.log ?? logger;
						const data = { category: "shutdown-progress", ...payload };
						if (payload.phase === "failed") log.error(data, "API shutdown progress");
						else log.info(data, "API shutdown progress");
					},
				});
				try {
					runtime?.closeAdmission();
					await initialization.catch(() => {});
					phase = "fastify";
					progress.report();
					if (app) await (app.hasDecorator("lifecycle") ? app.lifecycle.shutdown() : app.close());
					// Also join an owner acquired before server construction, or before
					// Prisma registered its normal terminal close hook.
					phase = "runtime";
					progress.report();
					await runtime?.close();
					outcome = "complete";
					progress.report();
				} catch (error) {
					failedPhase = phase;
					outcome = "failed";
					progress.report();
					throw error;
				} finally {
					progress.stop();
				}
			})
			.catch(() => {
				failedShutdown = true;
				app?.log.error("API shutdown failed");
			})
			.then(() => {
				process.exit(failedShutdown ? 1 : 0);
			});
		return shutdown;
	}
	process.on("SIGTERM", () => void closeAndExit());
	process.on("SIGINT", () => void closeAndExit());
	initialization = Promise.resolve().then(async () => {
		if (shutdown) return;
		const combinedMode = readCombinedStartupMode(process.env);
		if (combinedMode && typeof process.send !== "function")
			throw new Error("Combined startup IPC is unavailable.");
		// Every actual API child validates, including managed replacements. A
		// combined handoff coordinates settings; it never bypasses this boundary.
		const schemaSettings = await synchronizeRuntimeSchema(validatedEnv.DATABASE_URL!);
		if (shutdown) return;
		runtime = await openRestoreRuntime({
			databaseUrl: validatedEnv.DATABASE_URL!,
			onUnavailable: (diagnostic) => {
				logRestoreRuntimeLoss(app?.log ?? logger, diagnostic);
				queueMicrotask(() => void closeAndExit(true));
			},
		});
		if (shutdown) return;
		const settings = await loadRestoreRuntimeStartupSettings(runtime);
		if (shutdown) return;
		const combined = combinedMode
			? resolveCombinedStartupSettings(schemaSettings, process.env, combinedMode.phase)
			: null;
		const portConfig = getPortConfig(
			settings,
			combined
				? { ...process.env, API_PORT: String(combined.apiPort), PORT: String(combined.webPort) }
				: process.env,
		);
		const securityConfig = getSecurityConfig(settings);
		if (combined && combinedMode) {
			process.env.PORT = String(combined.webPort);
			process.env.HOST = combined.listenAddress;
			process.env.API_HOST = combined.listenAddress;
			combinedMessage = parseCombinedStartupMessage(
				{ kind: "arr-combined-startup", version: 1, nonce: combinedMode.nonce, ...combined },
				combinedMode.nonce,
			);
		}
		process.env.API_PORT = String(portConfig.apiPort);
		process.env.TRUST_PROXY = String(securityConfig.trustProxy);
		if (securityConfig.secureCookies !== undefined)
			process.env.COOKIE_SECURE = String(securityConfig.secureCookies);
		app = buildServer({
			env: {
				...validatedEnv,
				...(combined ? { API_HOST: combined.listenAddress } : {}),
				API_PORT: portConfig.apiPort,
				TRUST_PROXY: securityConfig.trustProxy,
				COOKIE_SECURE: securityConfig.secureCookies,
			},
			restoreRuntime: runtime,
		});
		logPortConfig(portConfig, app.log);
		logSecurityConfig(securityConfig, app.log);
	});

	try {
		await initialization;
		if (shutdown) return;
		if (!app || !runtime) throw new Error("API initialization did not complete");
		const env = app.config;
		await app.listen({
			port: env.API_PORT,
			host: env.API_HOST,
		});
		if (shutdown) return;
		if (combinedMessage) {
			await new Promise<void>((resolve, reject) => {
				process.send!(combinedMessage!, (error) => (error ? reject(error) : resolve()));
			});
			if (shutdown) return;
		}
		const dbUrl = process.env.DATABASE_URL || "";
		const dbType = dbUrl.startsWith("postgresql") ? "PostgreSQL" : "SQLite";
		const versionInfo = getAppVersionInfo();
		app.log.info(
			{
				version: versionInfo.version,
				commit: versionInfo.commitSha,
				nodeVersion: process.version,
				database: dbType,
				logLevel: LOG_LEVEL,
				logDir: LOG_DIR,
				host: env.API_HOST,
				port: env.API_PORT,
			},
			`arr-dashboard v${versionInfo.version} started (commit: ${versionInfo.commitSha})`,
		);

		// Fire-and-forget startup notification
		void runtime
			.runIndependentOperation(() =>
				app!.notificationService.notify({
					eventType: "SYSTEM_STARTUP",
					title: "Arr Dashboard started",
					body: `Server listening on ${env.API_HOST}:${env.API_PORT}`,
					url: `http://${env.API_HOST === "0.0.0.0" ? "localhost" : env.API_HOST}:${env.API_PORT - 1}/dashboard`,
					metadata: {
						version: versionInfo.version,
						nodeVersion: process.version,
						database: dbType,
						host: env.API_HOST,
						port: env.API_PORT,
					},
				}),
			)
			.catch((err) => {
				app!.log.warn({ err }, "Startup notification failed (non-critical)");
			});
	} catch {
		// A concurrent termination request does not establish why listen failed.
		// Preserve the failure exit while joining the same accepted-work drain.
		// Log to both pino (file) and console (stderr). Pino uses an async worker
		// thread transport, so process.exit() can kill the process before pino
		// flushes. console.error is synchronous and guarantees visible output.
		app?.log.error("Failed to start API server");
		console.error("Failed to start API server");
		await closeAndExit(true);
	}
};

void start();
