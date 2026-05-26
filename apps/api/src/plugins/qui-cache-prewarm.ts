/**
 * qui Torrent-List Cache Pre-Warm (boot-tick)
 *
 * Eliminates the cold-start cliff on the `/qui` home page. Without this,
 * the very first user to hit `/qui` after a container restart eats the
 * full paginated `listAllTorrents()` walk (up to 50 pages × 2000) —
 * commonly ~3.5s. The SWR cache then keeps subsequent navigations
 * instant, but that *first* user always pays.
 *
 * This plugin runs the same walk in the background after the API
 * server stabilizes, so the cache is already populated by the time any
 * user navigates. The SWR cache's in-flight dedup makes the pre-warm
 * race-safe — if a user request and the pre-warm fire concurrently,
 * they share the same promise.
 *
 * OOM safety considerations (deliberate, not over-engineered):
 *
 *   1. **30s startup delay** — boot-time co-spike avoidance. Library
 *      sync, Prisma client generation, schedulers, and inode-index
 *      hydration all run early; the pre-warm waits for the dust to
 *      settle before adding load.
 *   2. **Sequential per-instance fetch** — peak memory is bounded to
 *      `baseline + one instance`, not `baseline + N instances`. A
 *      typical 10k-torrent qBit decodes to ~10–20 MB cached; a 100k
 *      monster is ~100–200 MB. Two or three parallel could approach
 *      the 768 MB per-process heap cap during fetch+parse; sequential
 *      can't.
 *   3. **Per-instance 60s timeout** — a slow or hung qui can't pile
 *      up and starve subsequent instances. The instance is skipped
 *      and logged; the next one proceeds.
 *   4. **`.unref()` on the timeout handle** — pre-warm scheduling
 *      doesn't keep the event loop alive during graceful shutdown.
 *   5. **`DISABLE_QUI_CACHE_PREWARM=true` opt-out** — for memory-
 *      constrained deployments. The SWR cache still works without
 *      pre-warm; the first user just pays the cold cost.
 *
 * The cache is process-local, so a redeploy starts cold again — that's
 * exactly the window pre-warm covers.
 *
 * The interesting logic lives in `lib/qui/cache-prewarm.ts` for
 * testability; this file is a thin Fastify shim around it.
 */

import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { prewarmAllSequential, prewarmInstance } from "../lib/qui/cache-prewarm.js";
import { createQuiClient } from "../lib/qui/client-factory.js";
import { getCachedAllTorrents } from "../lib/qui/torrent-list-cache.js";

const STARTUP_DELAY_MS = 30_000;
const PER_INSTANCE_TIMEOUT_MS = 60_000;

const quiCachePrewarmPlugin = fp(
	async (app: FastifyInstance) => {
		let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
		let cancelled = false;

		async function runPrewarm(): Promise<void> {
			if (cancelled) return;
			const instances = await app.prisma.serviceInstance.findMany({
				where: { service: "QUI", enabled: true },
			});
			// `prewarmAllSequential` is generic — the full Prisma
			// `ServiceInstance` flows straight through to
			// `createQuiClient` without a downcast. The lib only reads
			// `id` and `label` from each row.
			await prewarmAllSequential(instances, {
				prewarmOne: (instance) =>
					prewarmInstance(instance, {
						createClient: () => createQuiClient(app, instance),
						getCachedAllTorrents,
						timeoutMs: PER_INSTANCE_TIMEOUT_MS,
						logger: app.log,
					}),
				isCancelled: () => cancelled,
				logger: app.log,
			});
		}

		app.addHook("onReady", async () => {
			if (process.env.DISABLE_QUI_CACHE_PREWARM === "true") {
				app.log.info(
					"qui cache pre-warm disabled via DISABLE_QUI_CACHE_PREWARM — first /qui visit will pay the cold-start cost",
				);
				return;
			}
			app.log.info(
				{ startupDelayMs: STARTUP_DELAY_MS },
				"qui cache pre-warm scheduled (one-shot, sequential, post-boot delay)",
			);
			timeoutHandle = setTimeout(() => {
				runPrewarm().catch((err) => {
					app.log.error({ err }, "qui cache pre-warm failed at the top level");
				});
			}, STARTUP_DELAY_MS);
			// Don't hold the event loop alive during graceful shutdown.
			timeoutHandle.unref();
		});

		app.addHook("onClose", async () => {
			cancelled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
		});
	},
	{
		name: "qui-cache-prewarm",
		dependencies: ["prisma", "security"],
	},
);

export default quiCachePrewarmPlugin;
