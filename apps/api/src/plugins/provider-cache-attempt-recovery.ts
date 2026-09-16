import fastifyPlugin from "fastify-plugin";
import { reconcileInterruptedProviderCacheRefreshAttempts } from "../lib/services/provider-cache-status.js";

/**
 * Recover durable provider refresh claims inherited across an API restart.
 * Recovery is diagnostic-only: it never replays upstream work or changes the
 * last published cache generation.
 */
const providerCacheAttemptRecoveryPlugin = fastifyPlugin(
	async (app) => {
		app.addHook("onReady", async () => {
			try {
				const recovered = await reconcileInterruptedProviderCacheRefreshAttempts(app.prisma);
				if (recovered > 0) {
					app.log.warn(
						{ recovered, category: "provider-cache-attempt-recovery" },
						"Recovered interrupted provider cache attempts",
					);
				}
			} catch {
				app.log.error(
					{ category: "provider-cache-attempt-recovery-failed" },
					"Provider cache attempt recovery failed",
				);
				throw new Error("Provider cache attempt recovery failed");
			}
		});
	},
	{ name: "provider-cache-attempt-recovery", dependencies: ["prisma"] },
);

export default providerCacheAttemptRecoveryPlugin;
