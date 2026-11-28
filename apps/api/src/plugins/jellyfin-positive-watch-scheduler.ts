import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { refreshOwnedJellyfinPositiveWatch } from "../lib/jellyfin/jellyfin-positive-watch-refresher.js";
import type { ServiceInstance } from "../lib/prisma.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

const INTERVAL_MS = 5 * 60_000;
const STARTUP_DELAY_MS = 90_000;

export async function refreshScheduledJellyfinPositiveWatchInstances(
	app: Pick<FastifyInstance, "prisma" | "encryptor" | "log">,
	instances: readonly ServiceInstance[],
	shouldStop: () => boolean = () => false,
	signal?: AbortSignal,
): Promise<void> {
	for (const instance of instances) {
		if (shouldStop() || signal?.aborted) break;
		try {
			const result = await refreshOwnedJellyfinPositiveWatch({
				prisma: app.prisma,
				encryptor: app.encryptor,
				instance,
				log: app.log,
				signal,
			});
			app.log.info(
				{
					provider: "jellyfin",
					cacheType: "jellyfin_episode_positive",
					outcome: result.kind,
					...(result.kind === "published"
						? {
								itemCount: result.itemCount,
								scopeCount: result.scopeCount,
								durationMs: result.durationMs,
							}
						: { reason: result.reason }),
				},
				"Jellyfin positive watch refresh completed",
			);
		} catch {
			app.log.error(
				{
					provider: "jellyfin",
					cacheType: "jellyfin_episode_positive",
					reasonCode: "instance_refresh_failed",
				},
				"Jellyfin positive watch instance refresh failed",
			);
		}
	}
}

const jellyfinPositiveWatchSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let startupHandle: ReturnType<typeof setTimeout> | null = null;
		let running: Promise<void> | null = null;
		let closing = false;
		const shutdown = new AbortController();

		async function tick(): Promise<void> {
			if (closing || running) return;
			running = (async () => {
				await app.schedulerRegistry.track(JOB_ID.jellyfinPositiveWatch, async () => {
					const instances = await app.prisma.serviceInstance.findMany({
						where: { service: "JELLYFIN", enabled: true, identityStatus: "VERIFIED" },
					});
					await refreshScheduledJellyfinPositiveWatchInstances(
						app,
						instances,
						() => closing,
						shutdown.signal,
					);
				});
			})()
				.catch(() => {
					app.log.error(
						{ provider: "jellyfin", reasonCode: "scheduler_tick_failed" },
						"Jellyfin positive watch scheduler failed",
					);
				})
				.finally(() => {
					running = null;
				});
			await running;
		}

		app.addHook("onReady", async () => {
			if (closing) return;
			startupHandle = setTimeout(() => {
				if (closing) return;
				void tick();
				if (closing) return;
				intervalHandle = setInterval(() => void tick(), INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});
		function closeAdmission() {
			if (closing) return;
			closing = true;
			shutdown.abort();
			if (startupHandle) clearTimeout(startupHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			startupHandle = null;
			intervalHandle = null;
		}
		app.addHook("preClose", async () => closeAdmission());
		app.addHook("onClose", async () => {
			closeAdmission();
			if (running) await running;
		});
	},
	{
		name: "jellyfin-positive-watch-scheduler",
		dependencies: ["prisma", "security", "scheduler-registry"],
	},
);

export default jellyfinPositiveWatchSchedulerPlugin;
