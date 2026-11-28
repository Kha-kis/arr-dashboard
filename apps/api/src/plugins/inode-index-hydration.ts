import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import {
	acquireIndependentCleanupOperationGuard,
	CleanupMaintenanceConflictError,
} from "../lib/library-cleanup/cleanup-maintenance-gate.js";
import { hydrateFileIdIndexFromDb } from "../lib/library-sync/infohash-backfill-by-inode.js";

/** Warm persisted indexes without delaying readiness or outliving Prisma. */
const inodeIndexHydrationPlugin = fp(
	async (app: FastifyInstance) => {
		let started = false;
		let closing = false;
		let completion: Promise<void> | undefined;

		async function hydrate(): Promise<void> {
			let release: (() => void) | undefined;
			try {
				release = acquireIndependentCleanupOperationGuard();
				const result = await hydrateFileIdIndexFromDb(app.prisma, app.log);
				app.log.info(
					{ loaded: result.loaded, failed: result.failed },
					"inode-index: startup hydration complete",
				);
			} catch (error) {
				if (error instanceof CleanupMaintenanceConflictError) {
					app.log.info("inode-index: startup hydration skipped during database maintenance");
				} else {
					app.log.warn("inode-index: startup hydration failed (non-critical)");
				}
			} finally {
				release?.();
			}
		}

		app.addHook("onReady", async () => {
			if (closing || started) return;
			started = true;
			// Own completion before the first read, including synchronous/reentrant
			// shutdown. Ready does not await it; onClose does.
			let finish!: () => void;
			completion = new Promise<void>((resolve) => {
				finish = resolve;
			});
			void app.restoreRuntime.runIndependentOperation(hydrate).then(finish, finish);
		});
		app.addHook("preClose", async () => {
			closing = true;
		});
		app.addHook("onClose", async () => {
			closing = true;
			await completion;
		});
	},
	{ name: "inode-index-hydration", dependencies: ["prisma", "inode-correlation-upgrade"] },
);

export default inodeIndexHydrationPlugin;
