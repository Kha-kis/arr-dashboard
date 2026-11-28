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
		let admissionClosed = false;
		const pendingCleanups = new Set<Promise<void>>();

		const closeAdmission = () => {
			admissionClosed = true;
			if (cleanupInterval) {
				app.log.info("Stopping session cleanup scheduler");
				clearInterval(cleanupInterval);
				cleanupInterval = null;
			}
		};

		const runCleanup = async () => {
			if (admissionClosed) return;
			// Register before starting work; a queued callback must not enter after close.
			let settle!: () => void;
			const completion = new Promise<void>((resolve) => {
				settle = resolve;
			});
			pendingCleanups.add(completion);
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
			} finally {
				pendingCleanups.delete(completion);
				settle();
			}
		};

		app.addHook("onReady", async () => {
			app.log.info("Starting session cleanup scheduler (runs every hour)");

			// Run initial cleanup on startup
			await runCleanup();

			// Schedule periodic cleanup
			if (!admissionClosed) cleanupInterval = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
		});

		app.addHook("preClose", async () => {
			// Do not block sibling admission hooks while already accepted ticks settle.
			closeAdmission();
		});

		app.addHook("onClose", async () => {
			closeAdmission();
			while (pendingCleanups.size > 0) {
				await Promise.all(pendingCleanups);
			}
		});
	},
	{
		name: "session-cleanup",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default sessionCleanupPlugin;
