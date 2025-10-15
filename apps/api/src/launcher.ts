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

/**
 * Log a message to stdout prefixed with "[Launcher]".
 *
 * @param message - The text to log
 */
function log(message: string) {
	console.log(`[Launcher] ${message}`);
}

// Handle launcher termination (registered once at module level)
// These handlers use the module-level serverProcess variable to avoid accumulation
process.on("SIGTERM", () => {
	// Prevent duplicate shutdown attempts
	if (isShuttingDown) {
		return;
	}

	isShuttingDown = true;
	log("Received SIGTERM, shutting down...");

	// Cancel any pending restart to avoid race conditions
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}

	// Attempt to kill the child process if it's running
	if (serverProcess) {
		serverProcess.kill("SIGTERM");
	} else {
		// No child process running (e.g., during restart delay), exit immediately
		log("No child process running, exiting launcher");
		process.exit(0);
	}
});

process.on("SIGINT", () => {
	// Prevent duplicate shutdown attempts
	if (isShuttingDown) {
		return;
	}

	isShuttingDown = true;
	log("Received SIGINT, shutting down...");

	// Cancel any pending restart to avoid race conditions
	if (restartTimer) {
		clearTimeout(restartTimer);
		restartTimer = null;
	}

	// Attempt to kill the child process if it's running
	if (serverProcess) {
		serverProcess.kill("SIGINT");
	} else {
		// No child process running (e.g., during restart delay), exit immediately
		log("No child process running, exiting launcher");
		process.exit(0);
	}
});

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
	restartTimestamps = restartTimestamps.filter(
		(timestamp) => now - timestamp < RESTART_WINDOW_MS
	);

	// Check if we've exceeded max restarts in the window
	if (restartTimestamps.length >= MAX_RESTARTS) {
		log(`ERROR: Too many restarts (${MAX_RESTARTS} in ${RESTART_WINDOW_MS}ms). Stopping to prevent restart loop.`);
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
	serverProcess = spawn(command, args, {
		stdio: "inherit",
		env: {
			...process.env,
			LAUNCHER_MANAGED: "true", // Signal to the app that it's managed by launcher
		},
		cwd: isDev ? process.cwd() : undefined,
	});

	serverProcess.on("exit", (code, signal) => {
		// Clear the process reference immediately so signal handlers know there's no live child
		serverProcess = null;

		if (signal) {
			log(`Application killed by signal ${signal}`);
			process.exit(1);
			return;
		}

		if (code === RESTART_CODE) {
			// Restart requested
			restartTimestamps.push(Date.now());
			restartCount++;

			if (!shouldAllowRestart()) {
				process.exit(1);
				return;
			}

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