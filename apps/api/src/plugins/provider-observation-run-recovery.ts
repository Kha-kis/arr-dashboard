import type { FastifyInstance } from "fastify";
import fastifyPlugin from "fastify-plugin";
import { recoverAbandonedObservationRuns } from "../lib/provider-observation/observation-run-repository.js";

const providerObservationRunRecoveryPlugin = fastifyPlugin(
	async (app: FastifyInstance) => {
		app.addHook("onReady", async () => {
			try {
				const recovered = await recoverAbandonedObservationRuns(app.prisma);
				if (recovered > 0) {
					app.log.warn(
						{ recovered, category: "provider-observation-run-recovery" },
						"Recovered abandoned provider observation units",
					);
				}
			} catch {
				app.log.error(
					{ category: "provider-observation-run-recovery-failed" },
					"Provider observation run recovery failed",
				);
				throw new Error("Provider observation run recovery failed");
			}
		});
	},
	{
		name: "provider-observation-run-recovery",
		dependencies: ["prisma", "security", "provider-cache-attempt-recovery"],
	},
);

export default providerObservationRunRecoveryPlugin;
