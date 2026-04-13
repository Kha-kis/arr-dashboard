import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

/**
 * Session cleanup interval in milliseconds
 * Runs every hour to clean up expired sessions
 */
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Plugin that periodically cleans up expired sessions from the database.
 *
 * This prevents session table bloat over time by removing sessions that have
 * already expired. Sessions are naturally cleaned up when accessed (in validateRequest),
 * but this scheduled cleanup handles sessions that are never accessed again after expiry.
 */
const sessionCleanupPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let cleanupInterval: ReturnType<typeof setInterval> | null = null;

		const runCleanup = async () => {
			try {
				// Route the tick through the scheduler registry so last run /
				// duration / failure counts are visible via /api/system/jobs.
				await app.schedulerRegistry.track(JOB_ID.sessionCleanup, async () => {
					const deletedCount = await app.sessionService.cleanupExpiredSessions();
					if (deletedCount > 0) {
						app.log.info({ deletedCount }, "Cleaned up expired sessions");
					}
				});
			} catch (error) {
				// Registry already recorded the failure; preserve existing log behavior.
				app.log.error({ err: error }, "Failed to clean up expired sessions");
			}
		};

		app.addHook("onReady", async () => {
			app.log.info("Starting session cleanup scheduler (runs every hour)");

			// Run initial cleanup on startup
			await runCleanup();

			// Schedule periodic cleanup
			cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
		});

		app.addHook("onClose", async () => {
			if (cleanupInterval) {
				app.log.info("Stopping session cleanup scheduler");
				clearInterval(cleanupInterval);
				cleanupInterval = null;
			}
		});
	},
	{
		name: "session-cleanup",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default sessionCleanupPlugin;
