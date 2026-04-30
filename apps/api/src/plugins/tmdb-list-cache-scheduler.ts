import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshTmdbListCache } from "../lib/auto-tag/list-cache-refresher.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

const TICK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours
const STARTUP_DELAY_MS = 60 * 1000; // 1 minute after boot

const tmdbListCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let timer: NodeJS.Timeout | null = null;
		let inFlight = false;

		const tick = async () => {
			if (inFlight) {
				app.log.debug("TMDb list cache tick skipped — previous still in flight");
				return;
			}
			inFlight = true;
			try {
				await refreshTmdbListCache({
					prisma: app.prisma,
					encryptor: app.encryptor,
					log: app.log,
				});
			} catch (err) {
				app.log.error({ err }, "TMDb list cache tick threw");
			} finally {
				inFlight = false;
			}
		};

		app.addHook("onReady", async () => {
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.tmdbListCache,
				"TMDb list cache",
				async () => {
					app.log.info({ intervalMs: TICK_INTERVAL_MS }, "Starting TMDb list cache scheduler");

					setTimeout(() => {
						app.schedulerRegistry
							.track(JOB_ID.tmdbListCache, tick)
							.catch((err) => app.log.error({ err }, "Initial TMDb list cache tick failed"));
					}, STARTUP_DELAY_MS);

					timer = setInterval(() => {
						app.schedulerRegistry
							.track(JOB_ID.tmdbListCache, tick)
							.catch((err) => app.log.error({ err }, "Scheduled TMDb list cache tick failed"));
					}, TICK_INTERVAL_MS);
				},
			);
		});

		app.addHook("onClose", async () => {
			if (timer) {
				clearInterval(timer);
				timer = null;
				app.log.info("TMDb list cache scheduler stopped");
			}
		});
	},
	{
		name: "tmdb-list-cache-scheduler",
		dependencies: ["prisma", "scheduler-registry"],
	},
);

export default tmdbListCacheSchedulerPlugin;
