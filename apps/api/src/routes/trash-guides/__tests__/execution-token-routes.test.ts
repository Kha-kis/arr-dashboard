import Fastify, { type FastifyInstance, type FastifyPluginAsync } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { registerSyncRoutes } from "../sync-routes.js";
import { registerTemplateRoutes } from "../template-routes.js";
import { deploymentRoutes } from "../deployment-routes.js";

const templateId = "cdef0123456789abcdef01234";
const instanceId = "cdef0123456789abcdef01235";

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

	it("rejects a tokenless template deployment before any mutation service runs", async () => {
		app = await createApp(registerTemplateRoutes);

		const response = await createInjectAuthenticated(app)("POST", "/deployment/execute", {
			body: { templateId, instanceId },
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().message).toBe("Invalid payload");
	});

	it("rejects bulk deployment when any selected instance lacks a preview token", async () => {
		app = await createApp(registerTemplateRoutes);

		const response = await createInjectAuthenticated(app)("POST", "/deployment/bulk", {
			body: {
				templateId,
				instanceIds: [instanceId, "cdef0123456789abcdef01236"],
				executionTokens: { [instanceId]: "a".repeat(64) },
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().message).toBe("Invalid payload");
	});

	it("rejects template bulk tokens for unselected instances", async () => {
		app = await createApp(registerTemplateRoutes);

		const response = await createInjectAuthenticated(app)("POST", "/deployment/bulk", {
			body: {
				templateId,
				instanceIds: [instanceId],
				executionTokens: {
					[instanceId]: "a".repeat(64),
					"unselected-instance": "b".repeat(64),
				},
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().message).toBe("Invalid payload");
	});

	it("reports legacy template bulk deployment as unsuccessful when any target fails", async () => {
		const secondInstanceId = "cdef0123456789abcdef01236";
		app = await createApp(
			registerTemplateRoutes,
			{
				trashTemplate: { findFirst: vi.fn().mockResolvedValue({ id: templateId }) },
				serviceInstance: {
					findMany: vi.fn().mockResolvedValue([{ id: instanceId }, { id: secondInstanceId }]),
				},
			},
			{
				deployBulkInstances: vi.fn().mockResolvedValue({
					totalInstances: 2,
					successfulInstances: 1,
					failedInstances: 1,
					results: [
						{ instanceId, success: true },
						{ instanceId: secondInstanceId, success: false, error: "write failed" },
					],
				}),
			},
		);

		const response = await createInjectAuthenticated(app)("POST", "/deployment/bulk", {
			body: {
				templateId,
				instanceIds: [instanceId, secondInstanceId],
				executionTokens: {
					[instanceId]: "a".repeat(64),
					[secondInstanceId]: "b".repeat(64),
				},
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: false,
			result: { successfulInstances: 1, failedInstances: 1 },
		});
	});

	it("rejects tokenless bulk deployment on the deployment route", async () => {
		app = await createApp(deploymentRoutes);

		const response = await createInjectAuthenticated(app)("POST", "/execute-bulk", {
			body: { templateId, instanceIds: [instanceId] },
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().message).toBe("Invalid payload");
	});

	it.each([63, 65])(
		"rejects a deployment bulk token with a non-64-character length (%i)",
		async (tokenLength) => {
			app = await createApp(deploymentRoutes);

			const response = await createInjectAuthenticated(app)("POST", "/execute-bulk", {
				body: {
					templateId,
					instanceIds: [instanceId],
					executionTokens: { [instanceId]: "a".repeat(tokenLength) },
				},
			});

			expect(response.statusCode).toBe(400);
			expect(response.json().message).toBe("Invalid payload");
		},
	);

	it("rejects deployment bulk tokens missing any selected instance", async () => {
		app = await createApp(deploymentRoutes);
		const secondInstanceId = "cdef0123456789abcdef01236";

		const response = await createInjectAuthenticated(app)("POST", "/execute-bulk", {
			body: {
				templateId,
				instanceIds: [instanceId, secondInstanceId],
				executionTokens: { [instanceId]: "a".repeat(64) },
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().message).toBe("Invalid payload");
	});

	it("rejects deployment bulk tokens for unselected instances", async () => {
		app = await createApp(deploymentRoutes);

		const response = await createInjectAuthenticated(app)("POST", "/execute-bulk", {
			body: {
				templateId,
				instanceIds: [instanceId],
				executionTokens: {
					[instanceId]: "a".repeat(64),
					"unselected-instance": "b".repeat(64),
				},
			},
		});

		expect(response.statusCode).toBe(400);
		expect(response.json().message).toBe("Invalid payload");
	});

	it("rejects tokenless sync execution", async () => {
		app = await createApp(registerSyncRoutes);

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: { templateId, instanceId },
		});

		expect(response.statusCode).toBe(400);
	});

	it("does not allow an API caller to spoof a scheduled sync", async () => {
		app = await createApp(registerSyncRoutes);

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: {
				templateId,
				instanceId,
				syncType: "SCHEDULED",
				executionToken: "a".repeat(64),
			},
		});

		expect(response.statusCode).toBe(400);
	});

	it("rejects an unowned sync target before creating history or refreshing a template", async () => {
		const historyCreate = vi.fn();
		app = await createApp(registerSyncRoutes, {
			trashTemplate: { findFirst: vi.fn().mockResolvedValue(null) },
			serviceInstance: { findFirst: vi.fn().mockResolvedValue(null) },
			trashSyncHistory: { create: historyCreate },
		});

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: { templateId, instanceId, executionToken: "a".repeat(64) },
		});

		expect(response.statusCode).toBe(404);
		expect(historyCreate).not.toHaveBeenCalled();
	});
});
