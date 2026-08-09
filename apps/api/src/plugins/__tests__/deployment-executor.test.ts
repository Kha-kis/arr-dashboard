import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import deploymentExecutorPlugin from "../deployment-executor.js";

const openApps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
	await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function dependencyPlugin(name: string, decorate: (app: FastifyInstance) => void) {
	return fp(
		async (app) => {
			decorate(app);
		},
		{ name },
	);
}

function createApp(prisma: Record<string, unknown>) {
	const app = Fastify({ logger: false });
	openApps.push(app);
	app.register(
		dependencyPlugin("prisma", (instance) => {
			instance.decorate("prisma", prisma as never);
		}),
	);
	app.register(
		dependencyPlugin("arr-client", (instance) => {
			instance.decorate("arrClientFactory", {} as never);
		}),
	);
	app.register(deploymentExecutorPlugin);
	return app;
}

describe("deployment executor startup reconciliation", () => {
	it("runs interrupted-history reconciliation exactly once before exposing the executor", async () => {
		const deploymentFindMany = vi.fn().mockResolvedValue([]);
		const syncFindMany = vi.fn().mockResolvedValue([]);
		const app = createApp({
			templateDeploymentHistory: { findMany: deploymentFindMany },
			trashSyncHistory: { findMany: syncFindMany },
		});

		await app.ready();

		expect(deploymentFindMany).toHaveBeenCalledOnce();
		expect(syncFindMany).toHaveBeenCalledOnce();
		expect(app.hasDecorator("deploymentExecutor")).toBe(true);
	});

	it("fails startup closed when reconciliation fails without exposing a successful recovery", async () => {
		const deploymentFindMany = vi.fn().mockRejectedValue(new Error("database unavailable"));
		const updateMany = vi.fn();
		const app = createApp({
			templateDeploymentHistory: { findMany: deploymentFindMany, updateMany },
			trashSyncHistory: { findMany: vi.fn(), updateMany },
		});

		await expect(app.ready()).rejects.toThrow("database unavailable");
		expect(deploymentFindMany).toHaveBeenCalledOnce();
		expect(updateMany).not.toHaveBeenCalled();
		expect(app.hasDecorator("deploymentExecutor")).toBe(false);
	});
});
