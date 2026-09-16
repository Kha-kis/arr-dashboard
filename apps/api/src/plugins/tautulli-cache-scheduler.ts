/**
 * Tautulli Cache Scheduler Plugin
 *
 * Periodically collects bounded positive Tautulli observations from all enabled
 * Tautulli instances. Runs every five minutes with a two-minute startup delay.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import type { ServiceInstance } from "../lib/prisma.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";
import { refreshOwnedTautulliCache } from "../lib/tautulli/tautulli-cache-refresher.js";

const INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STARTUP_DELAY_MS = 2 * 60_000; // 2 minutes — staggered after plex-cache (30s) to reduce peak memory

export async function refreshScheduledTautulliCacheInstance(
	app: Pick<FastifyInstance, "encryptor" | "prisma" | "log">,
	instance: ServiceInstance,
): Promise<void> {
	const startedAt = Date.now();
	try {
		const result = await refreshOwnedTautulliCache({
			prisma: app.prisma,
			encryptor: app.encryptor,
			instance,
			log: app.log,
		});
		const superseded = result.kind === "unpublished" && result.superseded === true;
		app.log.info(
			{
				provider: "tautulli",
				outcome: superseded ? "superseded" : result.kind,
				upserted: result.upserted,
				errors: result.errors,
				superseded,
				durationMs: Math.max(0, Date.now() - startedAt),
			},
			"Tautulli observation scheduler completed",
		);
	} catch {
		app.log.error(
			{ provider: "tautulli", reasonCode: "unknown_failure" },
			"Tautulli observation scheduler failed",
		);
	}
}

const tautulliCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;

		async function refreshAllTautulliCaches() {
			if (isRunning) {
				app.log.warn("Tautulli cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				await app.schedulerRegistry.track(JOB_ID.tautulliCache, async () => {
					const instances = await app.prisma.serviceInstance.findMany({
						where: { service: "TAUTULLI", enabled: true },
					});

					if (instances.length === 0) {
						app.log.debug("Tautulli observation scheduler: no enabled instances, skipping");
						return;
					}

					app.log.info({ count: instances.length }, "Starting Tautulli observation collection");

					for (const instance of instances) {
						await refreshScheduledTautulliCacheInstance(app, instance);
					}
				});
			} catch {
				app.log.error(
					{ provider: "tautulli", reasonCode: "scheduler_tick_failed" },
					"Tautulli observation scheduler failed",
				);
			} finally {
				isRunning = false;
			}
		}

		app.addHook("onReady", async () => {
			app.log.info(
				{ intervalMs: INTERVAL_MS, startupDelayMs: STARTUP_DELAY_MS },
				"Tautulli observation scheduler initialized",
			);

			timeoutHandle = setTimeout(() => {
				refreshAllTautulliCaches().catch(() => {
					app.log.error(
						{ provider: "tautulli", reasonCode: "startup_tick_failed" },
						"Tautulli observation scheduler failed",
					);
				});
				intervalHandle = setInterval(() => {
					refreshAllTautulliCaches().catch(() => {
						app.log.error(
							{ provider: "tautulli", reasonCode: "interval_tick_failed" },
							"Tautulli observation scheduler failed",
						);
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			app.log.info("Tautulli observation scheduler stopped");
		});
	},
	{
		name: "tautulli-cache-scheduler",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default tautulliCacheSchedulerPlugin;
