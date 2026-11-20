#!/usr/bin/env node

/**
 * Application Launcher
 *
 * This launcher wraps the main application and handles automatic restarts.
 * When the app exits with code 42, it will automatically restart.
 * Any other exit code will terminate the launcher.
 *
 * This enables backup restore to trigger a restart without relying on
 * external process managers (Docker, PM2, systemd).
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseCombinedStartupMessage,
	publishCombinedStartupResult,
	readCombinedStartupChannel,
	revokeCombinedStartupResult,
	type CombinedStartupMessage,
} from "./lib/lifecycle/combined-startup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RESTART_CODE = 42;
let restartCount = 0;
const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 60000; // 1 minute
let restartTimestamps: number[] = [];

// Module-level variable to track the current server process
// This prevents signal handler accumulation on restarts
let serverProcess: ReturnType<typeof spawn> | null = null;

// Module-level state for coordinated shutdown and pending restart cancellation
let isShuttingDown = false;
let restartTimer: NodeJS.Timeout | null = null;
const combinedChannel = readCombinedStartupChannel(process.env);
let combinedSettings: CombinedStartupMessage | null = null;
let combinedFailed = false;
let combinedFailureTimer: NodeJS.Timeout | null = null;
let forcedShutdown = false;

type ShutdownFailureReason =
	| "forced-child-termination"
	| "handoff-revocation-failed"
	| "combined-handoff-rejected";

function revokeHandoff(): boolean {
	if (!combinedChannel) return true;
	try {
		return revokeCombinedStartupResult(combinedChannel);
	} catch {
		combinedFailed = true;
		logShutdownFailure("handoff-revocation-failed");
		return false;
	}
}

function terminateChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
	child.kill(signal);
	const rawGrace = process.env.SHUTDOWN_GRACE;
	const configuredGrace =
		rawGrace !== undefined && /^[0-9]+$/.test(rawGrace) ? Number(rawGrace) : NaN;
	// Leave the parent one second to join us. Reject values whose timer would
	// overflow Node's signed 32-bit delay instead of forcing an immediate kill.
	const grace =
		Number.isSafeInteger(configuredGrace) && configuredGrace <= 2147483 ? configuredGrace : 90;
	const delay = Math.max(0, grace * 1000 - 1000);
	combinedFailureTimer ??= setTimeout(() => {
		if (serverProcess === child) {
			forcedShutdown = true;
			logShutdownFailure("forced-child-termination");
			child.kill("SIGKILL");
		}
	}, delay);
}

/**
 * Best-effort output: logging must never interrupt process lifecycle control.
 * Text retains its launcher prefix; fixed diagnostics are standalone JSON.
 */
function log(
	message: string | { category: "launcher-shutdown-failure"; reason: ShutdownFailureReason },
) {
	try {
		console.log(typeof message === "string" ? `[Launcher] ${message}` : JSON.stringify(message));
	} catch {
		// Child termination, joins and failure exits remain authoritative without a sink.
	}
}

function logShutdownFailure(reason: ShutdownFailureReason) {
	log({ category: "launcher-shutdown-failure", reason });
}

// Handle launcher termination (registered once at module level)
// These handlers use the module-level serverProcess variable to avoid accumulation
function requestShutdown(signal: "SIGTERM" | "SIGINT") {
	// Prevent duplicate shutdown attempts
	if (isShuttingDown) {
		return;
	}

	isShuttingDown = true;
	revokeHandoff();
	log(`Received ${signal}, shutting down...`);

	// Cancel any pending restart to avoid race conditions
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}

	// Attempt to kill the child process if it's running
	if (serverProcess) {
		terminateChild(serverProcess, signal);
	} else {
		// No child process running (e.g., during restart delay), exit immediately
		log("No child process running, exiting launcher");
		process.exit(combinedFailed ? 1 : 0);
	}
}
process.on("SIGTERM", () => requestShutdown("SIGTERM"));
process.on("SIGINT", () => requestShutdown("SIGINT"));

/**
 * Decides whether a new restart is permitted based on recent restart history.
 *
 * Cleans up recorded restart timestamps older than the configured window, logs an error if the recent restart count has reached the maximum, and updates internal state accordingly.
 *
 * @returns `true` if a restart is allowed, `false` if the maximum number of restarts within the window has been reached
 */
function shouldAllowRestart(): boolean {
	const now = Date.now();

	// Clean up old timestamps outside the window
	restartTimestamps = restartTimestamps.filter((timestamp) => now - timestamp < RESTART_WINDOW_MS);

	// Check if we've exceeded max restarts in the window
	if (restartTimestamps.length >= MAX_RESTARTS) {
		log(
			`ERROR: Too many restarts (${MAX_RESTARTS} in ${RESTART_WINDOW_MS}ms). Stopping to prevent restart loop.`,
		);
		return false;
	}

	return true;
}

/**
 * Spawn and manage the application process, restarting it when it exits with the designated restart code.
 *
 * Starts the child application in either development mode (runs the TypeScript source via `tsx`) or production mode (runs the compiled `index.js` with source maps), sets `LAUNCHER_MANAGED` in the child's environment, and inherits stdio. If the child exits with the restart code, records the restart, enforces the restart rate limit, and schedules a restart after one second; if the child exits normally or with any other code, the launcher exits with that code. The spawned process is assigned to the module-level `serverProcess` variable, which is used by the top-level signal handlers to forward termination signals.
 */
function startServer() {
	// Prevent spawning during shutdown to avoid race conditions
	if (isShuttingDown) {
		log("Shutdown in progress, skipping server start");
		return;
	}

	log("Starting application...");

	// Determine if we're in development or production
	const isDev = process.env.NODE_ENV !== "production";

	// In development, we need to use tsx since the source is TypeScript
	// In production, we use node with the compiled JS
	const command = isDev ? "tsx" : "node";
	const args = isDev
		? ["src/index.ts"]
		: ["--enable-source-maps", path.join(__dirname, "index.js")];

	// Spawn the actual server process and assign to module-level variable
	const child = spawn(command, args, {
		stdio: combinedChannel ? ["inherit", "inherit", "inherit", "ipc"] : "inherit",
		env: {
			...process.env,
			LAUNCHER_MANAGED: "true", // Signal to the app that it's managed by launcher
			...(combinedChannel
				? {
						ARR_COMBINED_STARTUP_NONCE: combinedChannel.nonce,
						ARR_COMBINED_STARTUP_PHASE: combinedSettings ? "restart" : "initial",
					}
				: {}),
			...(combinedSettings
				? {
						API_PORT: String(combinedSettings.apiPort),
						PORT: String(combinedSettings.webPort),
						HOST: combinedSettings.listenAddress,
						API_HOST: combinedSettings.listenAddress,
					}
				: {}),
		},
		cwd: isDev ? process.cwd() : undefined,
	});
	serverProcess = child;
	if (combinedChannel) {
		let received = false;
		child.on("message", (input) => {
			// A former child or shutdown callback can never publish readiness.
			if (serverProcess !== child || isShuttingDown || child.exitCode !== null) return;
			try {
				if (received) throw new Error("Duplicate combined handoff.");
				received = true;
				const message = parseCombinedStartupMessage(input, combinedChannel.nonce);
				if (combinedSettings) {
					if (
						message.apiPort !== combinedSettings.apiPort ||
						message.webPort !== combinedSettings.webPort ||
						message.listenAddress !== combinedSettings.listenAddress
					)
						throw new Error("Combined bindings changed.");
				} else {
					publishCombinedStartupResult(combinedChannel, message);
					combinedSettings = message;
				}
			} catch {
				combinedFailed = true;
				isShuttingDown = true;
				logShutdownFailure("combined-handoff-rejected");
				revokeHandoff();
				log("ERROR: Combined startup handoff rejected; joining the API child.");
				terminateChild(child, "SIGTERM");
			}
		});
	}

	// Handle spawn errors (e.g., command not found, permission denied)
	child.on("error", (err) => {
		if (serverProcess !== child) return;
		revokeHandoff();
		log(`ERROR: Failed to spawn server process: ${err.message}`);
		serverProcess = null;
		process.exit(1);
	});

	child.on("exit", (code, signal) => {
		if (serverProcess !== child) return;
		const consumed = revokeHandoff();
		// Clear the process reference immediately so signal handlers know there's no live child
		serverProcess = null;
		if (combinedFailureTimer) {
			clearTimeout(combinedFailureTimer);
			combinedFailureTimer = null;
		}
		if (combinedFailed || forcedShutdown) {
			process.exit(1);
			return;
		}

		if (signal) {
			log(`Application killed by signal ${signal}`);
			process.exit(1);
			return;
		}

		if (code === RESTART_CODE) {
			// Termination supersedes restart policy, even at the loop limit.
			if (isShuttingDown) {
				log("Shutdown in progress, skipping restart");
				process.exit(0);
				return;
			}
			if (combinedChannel && (!combinedSettings || !consumed)) {
				log("ERROR: Initial API exited before combined startup completed.");
				process.exit(1);
				return;
			}

			// Restart requested - check if we should allow it first
			if (!shouldAllowRestart()) {
				process.exit(1);
				return;
			}

			// Only record the restart after we know it's allowed
			restartTimestamps.push(Date.now());
			restartCount++;

			log(`Restart requested (count: ${restartCount}). Restarting in 1 second...`);
			restartTimer = setTimeout(() => {
				// Check if shutdown was initiated during the delay
				if (!isShuttingDown) {
					startServer();
				}
			}, 1000);
		} else {
			// Normal exit or error
			if (code === 0) {
				log("Application exited normally");
			} else {
				log(`Application exited with code ${code}`);
			}
			process.exit(code || 0);
		}
	});
}

// Start the server
log("Launcher started");
startServer();
