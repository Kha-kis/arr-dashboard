/**
 * Seerr Health Scheduler Plugin
 *
 * Periodically checks the health of all enabled Seerr instances by calling getStatus().
 * Records results in CacheRefreshStatus with cacheType "seerr_health".
 * Runs every 5 minutes with a 20-second startup delay.
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { SeerrClient } from "../lib/seerr/seerr-client.js";
import { getErrorMessage } from "../lib/utils/error-message.js";

const INTERVAL_MS = 5 * 60_000; // 5 minutes
const STARTUP_DELAY_MS = 20_000; // 20 seconds

const seerrHealthSchedulerPlugin = fp(
	async (app: FastifyInstance) => {
		let intervalHandle: ReturnType<typeof setInterval> | null = null;
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let isRunning = false;

		async function checkAllSeerrHealth() {
			if (isRunning) {
				app.log.warn("Seerr health check already running, skipping");
				return;
			}
			isRunning = true;
			try {
				// System-level scheduler: queries ALL enabled Seerr instances (no userId filter)
				// because health checks run as a background system task, not per-user.
				const instances = await app.prisma.serviceInstance.findMany({
					where: { service: "SEERR", enabled: true },
				});

				if (instances.length === 0) {
					app.log.debug("Seerr health check: no enabled Seerr instances, skipping");
					return;
				}

				for (const instance of instances) {
					try {
						const client = new SeerrClient(
							app.arrClientFactory,
							instance,
							app.log,
							app.seerrCircuitBreaker,
						);
						const status = await client.getStatus();

						await app.prisma.cacheRefreshStatus.upsert({
							where: {
								instanceId_cacheType: {
									instanceId: instance.id,
									cacheType: "seerr_health",
								},
							},
							create: {
								instanceId: instance.id,
								cacheType: "seerr_health",
								lastRefreshedAt: new Date(),
								lastResult: "success",
								lastErrorMessage: null,
								itemCount: 0,
							},
							update: {
								lastRefreshedAt: new Date(),
								lastResult: "success",
								lastErrorMessage: null,
							},
						});

						app.log.debug(
							{ instanceId: instance.id, version: status.version },
							"Seerr health check OK",
						);
					} catch (err) {
						app.log.warn(
							{ err, instanceId: instance.id, label: instance.label },
							"Seerr health check failed for instance",
						);

						await app.prisma.cacheRefreshStatus
							.upsert({
								where: {
									instanceId_cacheType: {
										instanceId: instance.id,
										cacheType: "seerr_health",
									},
								},
								create: {
									instanceId: instance.id,
									cacheType: "seerr_health",
									lastRefreshedAt: new Date(),
									lastResult: "error",
									lastErrorMessage: getErrorMessage(err, "Unknown error"),
									itemCount: 0,
								},
								update: {
									lastRefreshedAt: new Date(),
									lastResult: "error",
									lastErrorMessage: getErrorMessage(err, "Unknown error"),
								},
							})
							.catch((trackErr) => {
								app.log.warn(
									{ err: trackErr, instanceId: instance.id },
									"Failed to record Seerr health check failure status",
								);
							});
					}
				}
			} catch (err) {
				app.log.error({ err }, "Seerr health scheduler: failed to query instances");
			} finally {
				isRunning = false;
			}
		}

		app.addHook("onReady", async () => {
			app.log.info("Seerr health scheduler initialized (5min interval, 20s startup delay)");

			timeoutHandle = setTimeout(() => {
				checkAllSeerrHealth().catch((err) => {
					app.log.error({ err }, "Failed during initial Seerr health check");
				});

				intervalHandle = setInterval(() => {
					checkAllSeerrHealth().catch((err) => {
						app.log.error({ err }, "Failed during scheduled Seerr health check");
					});
				}, INTERVAL_MS);
			}, STARTUP_DELAY_MS);
		});

		app.addHook("onClose", async () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (intervalHandle) clearInterval(intervalHandle);
			app.log.info("Seerr health scheduler stopped");
		});
	},
	{
		name: "seerr-health-scheduler",
		dependencies: ["prisma", "security", "seerr-circuit-breaker"],
	},
);

export default seerrHealthSchedulerPlugin;
