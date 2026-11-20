/**
 * qui Torrent-State Sync Scheduler
 *
 * Periodically snapshots torrent state from every enabled qui instance into
 * LibraryCache so the Library page can offer a real (server-side, paginated)
 * Torrent State filter — not a per-page client-side hack.
 *
 * Runs every 10 minutes with a 30-second startup delay. The on-demand
 * /qui/library-item/torrent-state endpoint also write-throughs to the same
 * fields, so recently-viewed items stay fresher than the sync interval —
 * this scheduler is the staleness floor, not the ceiling.
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { runQuiTorrentStateSync } from "../lib/qui/torrent-state-sync.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

const INTERVAL_MS = 10 * 60_000;
const STARTUP_DELAY_MS = 30_000;

const quiTorrentStateSchedulerPlugin = fp(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;
		let closing = false;
		const pendingTicks = new Set<Promise<void>>();

		async function tick() {
			if (closing) return;
			if (isRunning) {
				app.log.warn("qui torrent-state sync already running, skipping tick");
				return;
			}
			isRunning = true;
			let finish!: () => void;
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			// Retain the initial lookup, complete publication and accepted notification handoff.
			pendingTicks.add(completion);
			try {
				await app.schedulerRegistry.track(JOB_ID.quiTorrentStateSync, async () => {
					await app.notificationService.runProducer(() => runQuiTorrentStateSync(app, app.log));
				});
			} catch (err) {
				// Registry already recorded the failure; preserve log semantics.
				app.log.error({ err }, "qui torrent-state scheduler tick failed");
			} finally {
				isRunning = false;
				pendingTicks.delete(completion);
				finish();
			}
		}

		app.addHook("onReady", async () => {
			if (closing) return;
			app.log.info(
				"qui torrent-state sync scheduler initialized (10min interval, 30s startup delay)",
			);

			timeoutHandle = setTimeout(() => {
				if (closing) return;
				tick().catch((err) => {
					app.log.error({ err }, "Failed during initial qui torrent-state sync");
				});

				if (closing) return;
				intervalHandle = setInterval(() => {
					tick().catch((err) => {
						app.log.error({ err }, "Failed during scheduled qui torrent-state sync");
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		function closeAdmission() {
			closing = true;
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
				timeoutHandle = null;
			}
			if (intervalHandle) {
				clearInterval(intervalHandle);
				intervalHandle = null;
			}
		}
		app.addHook("preClose", async () => closeAdmission());
		app.addHook("onClose", async () => {
			closeAdmission();
			while (pendingTicks.size > 0) await Promise.all([...pendingTicks]);
			app.log.info("qui torrent-state sync scheduler stopped");
		});
	},
	{
		name: "qui-torrent-state-scheduler",
		dependencies: ["prisma", "security", "notification-service", "scheduler-registry"],
	},
);

export default quiTorrentStateSchedulerPlugin;
