/**
 * Tautulli Cache Scheduler Plugin
 *
 * Refreshes the guarded Tautulli cache for every enabled instance every six
 * hours. The refresher owns generation publication and durable attempt status;
 * this plugin only schedules work and records failures that happen before the
 * refresher boundary can start.
 */

import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import type { ServiceInstance } from "../lib/prisma.js";
import { providerConnectionIdentity } from "../lib/services/provider-connection-guard.js";
import { recordProviderCacheRefreshFailure } from "../lib/services/provider-cache-status.js";
import { refreshTautulliCache } from "../lib/tautulli/tautulli-cache-refresher.js";
import { createTautulliClient } from "../lib/tautulli/tautulli-client.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

const INTERVAL_MS = 6 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 2 * 60_000;

/**
 * Runs the reviewed cache-publication boundary for one current Tautulli
 * instance. A disabled or changed instance is skipped before client creation;
 * the boundary repeats that guard transactionally before publication.
 */
export async function refreshScheduledTautulliCacheInstance(
	app: Pick<FastifyInstance, "encryptor" | "prisma" | "log">,
	instance: ServiceInstance,
): Promise<void> {
	if (!instance.enabled || instance.service !== "TAUTULLI") return;

	const expectedConnection = providerConnectionIdentity(instance);
	const tautulliInstance = instance as ServiceInstance & { service: "TAUTULLI" };
	try {
		const client = createTautulliClient(app.encryptor, tautulliInstance, app.log);
		const result = await refreshTautulliCache(
			client,
			app.prisma,
			instance.id,
			app.log,
			expectedConnection,
		);
		app.log.info(
			{ instanceId: instance.id, complete: result.complete, superseded: result.superseded },
			"Tautulli cache refresh completed for instance",
		);
	} catch (error) {
		app.log.error(
			{ err: error, instanceId: instance.id },
			"Tautulli cache refresh failed for instance",
		);
		await recordProviderCacheRefreshFailure(
			app.prisma,
			instance.id,
			"tautulli",
			getErrorMessage(error, "Tautulli cache refresh failed"),
			expectedConnection,
			app.log,
		);
	}
}

const tautulliCacheSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;

		async function refreshAllTautulliCaches(): Promise<void> {
			if (isRunning) {
				app.log.warn("Tautulli cache refresh already running, skipping");
				return;
			}
			isRunning = true;
			try {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: "TAUTULLI", enabled: true },
				});
				if (instances.length === 0) {
					app.log.debug("Tautulli cache refresh: no enabled Tautulli instances, skipping");
					return;
				}

				for (const instance of instances) {
					await refreshScheduledTautulliCacheInstance(app, instance);
				}
			} finally {
				isRunning = false;
			}
		}

		app.addHook("onReady", async () => {
			app.log.info("Tautulli cache scheduler initialized (6h interval, 2min startup delay)");
			timeoutHandle = setTimeout(() => {
				void refreshAllTautulliCaches().catch((error) => {
					app.log.error({ err: error }, "Initial Tautulli cache refresh failed");
				});
				intervalHandle = setInterval(() => {
					void refreshAllTautulliCaches().catch((error) => {
						app.log.error({ err: error }, "Scheduled Tautulli cache refresh failed");
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
		});
	},
	{ name: "tautulli-cache-scheduler" },
);

export default tautulliCacheSchedulerPlugin;
