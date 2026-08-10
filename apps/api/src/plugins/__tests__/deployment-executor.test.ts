import Fastify, { type FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { afterEach, describe, expect, it, vi } from "vitest";
import deploymentExecutorPlugin from "../deployment-executor.js";

function dependencyPlugin(name: string, decoration: string, value: unknown) {
	return fp(
		async (app: FastifyInstance) => {
			app.decorate(decoration, value as never);
		},
		{ name },
	);
}

function createPrisma(transactionResult: Array<{ count: number }> | Error) {
	const rollbackCount = transactionResult instanceof Error ? 0 : (transactionResult[0]?.count ?? 0);
	const undeployCount = transactionResult instanceof Error ? 0 : (transactionResult[1]?.count ?? 0);
	const syncCount = transactionResult instanceof Error ? 0 : (transactionResult[2]?.count ?? 0);
	const deploymentCount =
		transactionResult instanceof Error ? 0 : (transactionResult[3]?.count ?? 0);
	return {
		trashSyncHistory: {
			updateMany: vi
				.fn()
				.mockReturnValueOnce(Promise.resolve({ count: rollbackCount }))
				.mockReturnValueOnce(Promise.resolve({ count: syncCount })),
		},
		templateDeploymentHistory: {
			updateMany: vi
				.fn()
				.mockReturnValueOnce(Promise.resolve({ count: undeployCount }))
				.mockReturnValueOnce(Promise.resolve({ count: deploymentCount })),
		},
		$transaction: vi
			.fn()
			.mockImplementation(() =>
				transactionResult instanceof Error
					? Promise.reject(transactionResult)
					: Promise.resolve(transactionResult),
			),
	};
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
	await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

describe("deployment executor startup reconciliation", () => {
	it("reconciles and logs abandoned claims before exposing the executor", async () => {
		const app = Fastify({ logger: false });
		apps.push(app);
		const prisma = createPrisma([{ count: 4 }, { count: 1 }, { count: 2 }, { count: 3 }]);
		const info = vi.spyOn(app.log, "info");

		app.register(dependencyPlugin("prisma", "prisma", prisma));
		app.register(dependencyPlugin("arr-client", "arrClientFactory", {}));
		app.register(deploymentExecutorPlugin);
		await app.ready();

		expect(prisma.$transaction).toHaveBeenCalledTimes(1);
		expect(info).toHaveBeenCalledWith(
			{ rollback: 4, undeploy: 1, sync: 2, deployment: 3, total: 10 },
			"Reconciled abandoned TRaSH recovery claims",
		);
		expect(app.hasDecorator("deploymentExecutor")).toBe(true);
	});

	it("fails startup closed and does not expose the executor when reconciliation fails", async () => {
		const app = Fastify({ logger: false });
		apps.push(app);
		const prisma = createPrisma(new Error("database unavailable"));

		app.register(dependencyPlugin("prisma", "prisma", prisma));
		app.register(dependencyPlugin("arr-client", "arrClientFactory", {}));
		app.register(deploymentExecutorPlugin);

		let startupError: unknown;
		try {
			await app.ready();
		} catch (error) {
			startupError = error;
		}

		expect(startupError).toEqual(new Error("database unavailable"));
		expect(app.hasDecorator("deploymentExecutor")).toBe(false);
	});

	it("does not log reconciliation when startup finds no abandoned claims", async () => {
		const app = Fastify({ logger: false });
		apps.push(app);
		const prisma = createPrisma([{ count: 0 }, { count: 0 }, { count: 0 }, { count: 0 }]);
		const info = vi.spyOn(app.log, "info");

		app.register(dependencyPlugin("prisma", "prisma", prisma));
		app.register(dependencyPlugin("arr-client", "arrClientFactory", {}));
		app.register(deploymentExecutorPlugin);
		await app.ready();

		expect(info).not.toHaveBeenCalledWith(
			expect.objectContaining({ total: 0 }),
			"Reconciled abandoned TRaSH recovery claims",
		);
		expect(app.hasDecorator("deploymentExecutor")).toBe(true);
	});
});
