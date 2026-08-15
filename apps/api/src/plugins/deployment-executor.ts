/**
 * Deployment Executor Singleton Plugin
 *
 * Registers a single DeploymentExecutorService on the Fastify instance,
 * ensuring the activeDeployments concurrency guard is shared across all
 * route handlers (deployment-routes, sync-routes, update-routes, template-routes,
 * and the trash-update-scheduler).
 */

import fp from "fastify-plugin";
import { DeploymentExecutorService } from "../lib/trash-guides/deployment-executor.js";
import { reconcileInterruptedDeploymentHistories } from "../lib/trash-guides/deployment-operation-gate.js";

const deploymentExecutorPlugin = fp(
	async (app) => {
		let reconciled: number;
		try {
			reconciled = await reconcileInterruptedDeploymentHistories(app.prisma);
		} catch (error) {
			app.log.error(
				{ err: error },
				"Failed to reconcile interrupted TRaSH deployment histories; startup remains blocked",
			);
			throw error;
		}
		if (reconciled > 0) {
			app.log.warn({ reconciled }, "Reconciled interrupted TRaSH deployment histories");
		}
		const service = new DeploymentExecutorService(app.prisma, app.arrClientFactory);
		app.decorate("deploymentExecutor", service);
	},
	{
		name: "deployment-executor",
		dependencies: ["prisma", "arr-client"],
	},
);

export default deploymentExecutorPlugin;
