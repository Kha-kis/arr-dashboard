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
			throw new Error("Application is already shutting down");
		}

		this.isShuttingDown = true;

		this.app.log.warn(
			{
				reason,
				pid: process.pid,
				uptime: process.uptime(),
			},
			"Initiating application restart"
		);

		// Schedule the actual restart after allowing time for response to be sent
		setTimeout(async () => {
			await this.performRestart();
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
			if (this.shouldSpawnNewProcess()) {
				this.spawnNewProcess();
			}

			// Step 3: Exit current process
			// Use exit code 42 when launcher-managed to signal restart
			const isLauncherManaged = process.env.LAUNCHER_MANAGED === "true";
			const exitCode = isLauncherManaged ? 42 : 0;
			this.app.log.info({ exitCode, launcherManaged: isLauncherManaged }, "Exiting current process");
			process.exit(exitCode);
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
	 * Only spawn in production or when explicitly managed
	 */
	private shouldSpawnNewProcess(): boolean {
		const isProduction = process.env.NODE_ENV === "production";
		const isLauncherManaged = process.env.LAUNCHER_MANAGED === "true";
		const isDevelopment = !isProduction;

		if (isDevelopment && !isLauncherManaged) {
			this.app.log.info(
				"Development mode without launcher - manual restart required"
			);
			return false;
		}

		return true;
	}

	/**
	 * Spawn a new instance of the application
	 * Uses detached process to ensure it survives parent exit
	 */
	private spawnNewProcess(): void {
		try {
			this.app.log.info(
				{
					command: process.argv[0],
					args: process.argv.slice(1),
				},
				"Spawning new process"
			);

			const child = spawn(process.argv[0], process.argv.slice(1), {
				detached: true,
				stdio: "ignore",
				env: {
					...process.env,
					// Signal to new process that it's a restart
					PROCESS_RESTARTED: "true",
				},
			});

			// Unref allows parent to exit independently
			child.unref();

			this.app.log.info({ childPid: child.pid }, "New process spawned successfully");
		} catch (error) {
			this.app.log.error({ err: error }, "Failed to spawn new process");
			// Continue with exit anyway
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
