import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { deploymentRoutes } from "../deployment-routes.js";
import { registerSyncRoutes } from "../sync-routes.js";
import { registerTemplateRoutes } from "../template-routes.js";

const templateId = "cdef0123456789abcdef01234";
const instanceId = "cdef0123456789abcdef01235";
const executionToken = "a".repeat(64);

async function createApp(
	registerRoutes: FastifyPluginAsync,
	prisma: unknown = {},
	deploymentExecutor: unknown = {},
) {
	const app = Fastify({ logger: false });
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	app.decorate("prisma", prisma as never);
	app.decorate("arrClientFactory", {} as never);
	app.decorate("deploymentExecutor", deploymentExecutor as never);
	await app.register(registerRoutes);
	await app.ready();
	return app;
}

describe("user-triggered deployment token enforcement", () => {
	let app: FastifyInstance | undefined;

	afterEach(async () => {
		await app?.close();
		app = undefined;
	});

	it("rejects tokenless execution on both deployment route surfaces", async () => {
		for (const [routes, path] of [
			[deploymentRoutes, "/execute"],
			[registerTemplateRoutes, "/deployment/execute"],
		] as const) {
			app = await createApp(routes);
			const response = await createInjectAuthenticated(app)("POST", path, {
				body: { templateId, instanceId },
			});
			expect(response.statusCode).toBe(400);
			expect(response.json().message).toBe("Invalid payload");
			await app.close();
			app = undefined;
		}
	});

	it("forwards the exact reviewed token to the deployment executor", async () => {
		const deploySingleInstance = vi.fn().mockResolvedValue({
			instanceId,
			instanceLabel: "Radarr",
			success: true,
			customFormatsCreated: 0,
			customFormatsUpdated: 0,
			customFormatsSkipped: 0,
			errors: [],
		});
		app = await createApp(deploymentRoutes, {}, { deploySingleInstance });

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: { templateId, instanceId, executionToken },
		});

		expect(response.statusCode).toBe(200);
		expect(deploySingleInstance).toHaveBeenCalledWith(
			templateId,
			instanceId,
			"user-1",
			undefined,
			undefined,
			executionToken,
		);
	});

	it.each([
		[deploymentRoutes, "/execute-bulk"],
		[registerTemplateRoutes, "/deployment/bulk"],
	] as const)("rejects missing and extra bulk tokens on %s", async (routes, path) => {
		app = await createApp(routes);
		const secondInstanceId = "cdef0123456789abcdef01236";

		const missing = await createInjectAuthenticated(app)("POST", path, {
			body: {
				templateId,
				instanceIds: [instanceId, secondInstanceId],
				executionTokens: { [instanceId]: executionToken },
			},
		});
		const extra = await createInjectAuthenticated(app)("POST", path, {
			body: {
				templateId,
				instanceIds: [instanceId],
				executionTokens: {
					[instanceId]: executionToken,
					"unselected-instance": "b".repeat(64),
				},
			},
		});

		expect(missing.statusCode).toBe(400);
		expect(extra.statusCode).toBe(400);
	});

	it("does not let an API caller claim scheduled-sync authority", async () => {
		app = await createApp(registerSyncRoutes);
		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: { templateId, instanceId, syncType: "SCHEDULED", executionToken },
		});

		expect(response.statusCode).toBe(400);
	});

	it("rejects an unowned sync target before creating history", async () => {
		const historyCreate = vi.fn();
		app = await createApp(registerSyncRoutes, {
			trashTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(null) },
			trashSyncHistory: { create: historyCreate },
		});

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: { templateId, instanceId, executionToken },
		});

		expect(response.statusCode).toBe(404);
		expect(historyCreate).not.toHaveBeenCalled();
	});
});
