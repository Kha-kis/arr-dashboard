import { setImmediate as yieldEventLoop } from "node:timers/promises";
import fastifyPlugin from "fastify-plugin";
import { getRestoreRuntimeClientContext } from "../lib/backup/restore-runtime-admission.js";
import { createSearchGrabRepository } from "../lib/search/grab-repository.js";

/** Required bootstrap recovery, never an upstream replay or a read-route side effect. */
export default fastifyPlugin(
	async (app) => {
		app.addHook("onReady", async () => {
			try {
				const { runtimeEpoch } = getRestoreRuntimeClientContext(app.restoreRuntime);
				const totals = { unsentRejected: 0, uncertain: 0 };
				for (;;) {
					const prior = await app.prisma.searchGrabAttempt.findMany({
						take: 100,
						where: {
							state: { in: ["prepared", "submitting"] },
							OR: [{ workerEpoch: { not: runtimeEpoch } }, { workerEpoch: null }],
						},
						select: { userId: true },
						orderBy: [{ userId: "asc" }, { id: "asc" }],
					});
					if (prior.length === 0) break;
					for (const userId of new Set(prior.map((row) => row.userId))) {
						const recovered = await createSearchGrabRepository(
							app.prisma,
							app.restoreRuntime,
							app.encryptor,
							userId,
						).recoverPreviousRuntime();
						totals.unsentRejected += recovered.unsentRejected;
						totals.uncertain += recovered.uncertain;
					}
					await yieldEventLoop();
				}
				if (totals.unsentRejected + totals.uncertain > 0)
					app.log.warn(
						{ ...totals, category: "search-grab-recovery" },
						"Recovered interrupted search submissions",
					);
			} catch {
				app.log.error(
					{ category: "search-grab-recovery-failed" },
					"Search submission recovery failed",
				);
				throw new Error("Search submission recovery failed");
			}
		});
	},
	{ name: "search-grab-recovery", dependencies: ["prisma", "security"] },
);
