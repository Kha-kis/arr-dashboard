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
import { reconcileAbandonedTrashRecoveryClaims } from "../lib/trash-guides/recovery-evidence.js";

const deploymentExecutorPlugin = fp(
	async (app) => {
		const reconciledClaims = await reconcileAbandonedTrashRecoveryClaims(app.prisma);
		if (reconciledClaims.total > 0) {
			app.log.info(reconciledClaims, "Reconciled abandoned TRaSH recovery claims");
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
