import { spawn } from "node:child_process";
import type { FastifyInstance } from "fastify";

/**
 * Lifecycle Service
 *
 * Handles application lifecycle operations like restart and shutdown
 * with proper cleanup and graceful handling.
 */
export class LifecycleService {
	private isShuttingDown = false;

	constructor(private app: FastifyInstance) {}

	/**
	 * Initiate a graceful restart of the application
	 *
	 * Security: Should only be called after authentication/authorization checks
	 *
	 * @param reason - Why the restart was triggered (for logging)
	 * @returns Promise that resolves when restart is initiated
	 */
	async restart(reason: string): Promise<void> {
		if (this.isShuttingDown) {
			this.app.log.warn("Restart already in progress; ignoring duplicate request");
			return;
		}

		this.isShuttingDown = true;

		this.app.log.warn(
			{
				reason,
				pid: process.pid,
				uptime: process.uptime(),
			},
			"Initiating application restart",
		);

		// Schedule the actual restart after allowing time for response to be sent
		setTimeout(() => {
			void this.performRestart();
		}, 1500);
	}

	/**
	 * Perform the actual restart
	 */
	private async performRestart(): Promise<void> {
		try {
			// Step 1: Graceful shutdown of connections
			this.app.log.info("Closing server connections gracefully");
			await this.gracefulShutdown();

			// Step 2: Spawn new process (production only)
			let spawnSuccess = true;
			if (this.shouldSpawnNewProcess()) {
				spawnSuccess = this.spawnNewProcess();
			}

			// Step 3: Conditionally exit current process
			// Only exit in launcher-managed mode or production
			const isLauncherManaged = process.env.LAUNCHER_MANAGED === "true";
			const isProduction = process.env.NODE_ENV === "production";

			if (isLauncherManaged || isProduction) {
				// Exit with code 1 if spawn failed, otherwise use appropriate success code
				const exitCode = !spawnSuccess ? 1 : isLauncherManaged ? 42 : 0;
				this.app.log.info(
					{ exitCode, launcherManaged: isLauncherManaged, production: isProduction, spawnSuccess },
					"Exiting current process",
				);
				process.exit(exitCode);
			} else {
				// Development without launcher - skip exit, let hot reload handle restart
				this.app.log.info(
					"Development mode without launcher - skipping exit, server will continue running",
				);
				this.isShuttingDown = false;
				return;
			}
		} catch (error) {
			this.app.log.error({ err: error }, "Error during restart");
			process.exit(1);
		}
	}

	/**
	 * Gracefully close all connections
	 */
	private async gracefulShutdown(): Promise<void> {
		try {
			await this.app.close();
		} catch (error) {
			this.app.log.error({ err: error }, "Error closing Fastify server");
		}
	}

	/**
	 * Determine if we should spawn a new process
	 * Only spawn in production when NOT launcher-managed
	 * (When launcher-managed, the launcher handles spawning via exit code 42)
	 */
	private shouldSpawnNewProcess(): boolean {
		const isLauncherManaged = process.env.LAUNCHER_MANAGED === "true";

		// If launcher-managed, let the launcher handle spawning
		if (isLauncherManaged) {
			this.app.log.info("Launcher-managed mode - launcher will handle restart");
			return false;
		}

		const isProduction = process.env.NODE_ENV === "production";
		const isDevelopment = !isProduction;

		if (isDevelopment) {
			this.app.log.info("Development mode without launcher - manual restart required");
			return false;
		}

		// Only self-spawn in production when not launcher-managed
		return true;
	}

	/**
	 * Spawn a new instance of the application
	 * Uses detached process to ensure it survives parent exit
	 * @returns true if spawn succeeded, false if spawn failed
	 */
	private spawnNewProcess(): boolean {
		try {
			// Ensure we have a valid node executable path
			const nodeExecutable = process.argv[0];
			if (!nodeExecutable) {
				throw new Error("Cannot determine node executable path");
			}

			this.app.log.info(
				{
					command: nodeExecutable,
					args: process.argv.slice(1),
				},
				"Spawning new process",
			);

			const child = spawn(nodeExecutable, process.argv.slice(1), {
				detached: true,
				stdio: ["ignore", "ignore", "ignore"],
				windowsHide: true,
				env: {
					...process.env,
					// Signal to new process that it's a restart
					PROCESS_RESTARTED: "true",
				},
			});

			// Unref allows parent to exit independently
			child.unref();

			this.app.log.info({ childPid: child.pid }, "New process spawned successfully");
			return true;
		} catch (error) {
			this.app.log.error({ err: error }, "Failed to spawn new process");
			return false;
		}
	}

	/**
	 * Check if restart is needed based on the current environment
	 */
	isRestartRequired(): boolean {
		// In development without launcher, restart is not automatic
		const isDevelopment = process.env.NODE_ENV !== "production";
		const isLauncherManaged = process.env.LAUNCHER_MANAGED === "true";

		return !isDevelopment || isLauncherManaged;
	}

	/**
	 * Get user-friendly restart message
	 */
	getRestartMessage(): string {
		if (this.isRestartRequired()) {
			return "The application will restart automatically in a few seconds...";
		}

		return "Please manually restart the application for changes to take effect. (Stop the server with Ctrl+C and run 'pnpm run dev' again)";
	}
}
