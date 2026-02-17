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

export const deploymentExecutorPlugin = fp(
	async (app) => {
		const service = new DeploymentExecutorService(app.prisma, app.arrClientFactory);
		app.decorate("deploymentExecutor", service);
	},
	{
		name: "deployment-executor",
		dependencies: ["prisma", "arr-client"],
	},
);

export default deploymentExecutorPlugin;
