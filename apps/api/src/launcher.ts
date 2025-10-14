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

function log(message: string) {
	console.log(`[Launcher] ${message}`);
}

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

function startServer() {
	log("Starting application...");

	// Determine if we're in development or production
	const isDev = process.env.NODE_ENV !== "production";

	// In development, we need to use tsx since the source is TypeScript
	// In production, we use node with the compiled JS
	const command = isDev ? "tsx" : "node";
	const args = isDev
		? ["src/index.ts"]
		: ["--enable-source-maps", path.join(__dirname, "index.js")];

	// Spawn the actual server process
	const serverProcess = spawn(command, args, {
		stdio: "inherit",
		env: {
			...process.env,
			LAUNCHER_MANAGED: "true", // Signal to the app that it's managed by launcher
		},
		cwd: isDev ? process.cwd() : undefined,
	});

	serverProcess.on("exit", (code, signal) => {
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
			setTimeout(() => {
				startServer();
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

	// Handle launcher termination
	process.on("SIGTERM", () => {
		log("Received SIGTERM, shutting down...");
		serverProcess.kill("SIGTERM");
	});

	process.on("SIGINT", () => {
		log("Received SIGINT, shutting down...");
		serverProcess.kill("SIGINT");
	});
}

// Start the server
log("Launcher started");
startServer();
