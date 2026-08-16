import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { assertCompleteCacheRefresh } from "../lib/cache-refresh-status.js";
import { CleanupScheduler } from "../lib/library-cleanup/cleanup-scheduler.js";
import {
	buildFreshCompleteFileIdIndex,
	getAllHashesForFileIdComplete,
} from "../lib/library-sync/infohash-backfill-by-inode.js";
import {
	createOwnedJellyfinPublicationSnapshot,
	refreshJellyfinCache,
} from "../lib/jellyfin/jellyfin-cache-refresher.js";
import {
	createOwnedPlexPublicationSnapshot,
	refreshPlexCache,
} from "../lib/plex/plex-cache-refresher.js";
import { createQuiClient } from "../lib/qui/client-factory.js";
import { runSchedulerInit } from "../lib/scheduler-registry/init-helpers.js";
import { JOB_ID } from "../lib/scheduler-registry/job-definitions.js";

declare module "fastify" {
	interface FastifyInstance {
		cleanupScheduler: CleanupScheduler;
	}
}

const libraryCleanupSchedulerPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			await runSchedulerInit(
				{ registry: app.schedulerRegistry, log: app.log },
				JOB_ID.libraryCleanup,
				"library cleanup",
				async () => {
					app.log.info("Initializing library cleanup scheduler");

					const scheduler = new CleanupScheduler(
						app.prisma,
						app.arrClientFactory,
						app.encryptor,
						app.log,
						(payload) => app.notificationService.notify(payload),
						{
							trackTick: (fn) => app.schedulerRegistry.track(JOB_ID.libraryCleanup, fn),
							quiClientFactory: (instance) => createQuiClient(app, instance),
							quiFileHashIndexFactory: async (instance) => {
								const index = await buildFreshCompleteFileIdIndex(
									createQuiClient(app, instance),
									instance,
									app.log,
								);
								return {
									resolve: (path) => getAllHashesForFileIdComplete(path, index),
								};
							},
							externalRuleCacheRefresher: async (source, instance, context) => {
								const result =
									source === "plex"
										? await refreshPlexCache({
												prisma: app.prisma,
												instance: createOwnedPlexPublicationSnapshot(app.encryptor, instance),
												log: app.log,
												cleanupRunClaimToken: context?.cleanupRunClaimToken,
											})
										: await refreshJellyfinCache({
												prisma: app.prisma,
												instance: createOwnedJellyfinPublicationSnapshot(app.encryptor, instance),
												log: app.log,
												cleanupRunClaimToken: context?.cleanupRunClaimToken,
											});
								assertCompleteCacheRefresh(source, result);
							},
						},
					);
					app.decorate("cleanupScheduler", scheduler);

					scheduler.start();
					app.log.info("Library cleanup scheduler started successfully");
				},
			);
		});

		app.addHook("onClose", async () => {
			if (app.cleanupScheduler) {
				app.log.info("Stopping library cleanup scheduler");
				app.cleanupScheduler.stop();
			}
		});
	},
	{
		name: "library-cleanup-scheduler",
		dependencies: ["prisma", "arr-client", "scheduler-registry"],
	},
);

export default libraryCleanupSchedulerPlugin;
