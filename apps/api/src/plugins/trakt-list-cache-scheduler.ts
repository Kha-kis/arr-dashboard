import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshTraktListCache } from "../lib/auto-tag/list-cache-refresher.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

const TICK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STARTUP_DELAY_MS = 90 * 1000; // offset from TMDb scheduler so they don't co-spike

const traktListCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let timer: NodeJS.Timeout | null = null;
		let startupTimer: NodeJS.Timeout | null = null;
		let inFlight = false;
		let closing = false;
		const pendingRounds = new Set<Promise<void>>();

		const tick = async () => {
			if (inFlight) {
				app.log.debug("Trakt list cache tick skipped — previous still in flight");
				return;
			}
			inFlight = true;
			try {
				await refreshTraktListCache(
					{ prisma: app.prisma, encryptor: app.encryptor, log: app.log },
					{ traktClientId: process.env.TRAKT_CLIENT_ID ?? null },
				);
			} catch (err) {
				app.log.error({ err }, "Trakt list cache tick threw");
			} finally {
				inFlight = false;
			}
		};

		async function runTrackedTick() {
			if (closing) return;
			let finish!: () => void;
			const completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			// Retain the whole round, including publication, orphan cleanup and registry release.
			pendingRounds.add(completion);
			try {
				await app.schedulerRegistry.track(JOB_ID.traktListCache, tick);
			} finally {
				pendingRounds.delete(completion);
				finish();
			}
		}

		app.addHook("onReady", async () => {
			if (closing) return;
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.traktListCache,
				"Trakt list cache",
				async () => {
					if (closing) return;
					app.log.info({ intervalMs: TICK_INTERVAL_MS }, "Starting Trakt list cache scheduler");

					startupTimer = setTimeout(() => {
						startupTimer = null;
						runTrackedTick().catch((err: unknown) =>
							app.log.error({ err }, "Initial Trakt list cache tick failed"),
						);
					}, STARTUP_DELAY_MS);

					timer = setInterval(() => {
						runTrackedTick().catch((err: unknown) =>
							app.log.error({ err }, "Scheduled Trakt list cache tick failed"),
						);
					}, TICK_INTERVAL_MS);
				},
			);
		});

		function closeAdmission() {
			closing = true;
			if (startupTimer) {
				clearTimeout(startupTimer);
				startupTimer = null;
			}
			if (timer) {
				clearInterval(timer);
				timer = null;
				app.log.info("Trakt list cache scheduler stopped");
			}
		}
		app.addHook("preClose", async () => closeAdmission());
		app.addHook("onClose", async () => {
			closeAdmission();
			while (pendingRounds.size > 0) await Promise.all([...pendingRounds]);
		});
	},
	{
		name: "trakt-list-cache-scheduler",
		dependencies: ["prisma", "scheduler-registry"],
	},
);

export default traktListCacheSchedulerPlugin;
