import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";

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
				const deletedCount = await app.sessionService.cleanupExpiredSessions();
				if (deletedCount > 0) {
					app.log.info({ deletedCount }, "Cleaned up expired sessions");
				}
			} catch (error) {
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
		dependencies: ["prisma", "security"],
	},
);

export default sessionCleanupPlugin;
