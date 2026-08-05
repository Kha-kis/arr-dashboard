import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../../../lib/errors.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { deploymentRoutes } from "../deployment-routes.js";

describe("deployment execution routes", () => {
	let app: FastifyInstance;
	const deploySingleInstance = vi.fn();
	const notify = vi.fn();

	beforeEach(async () => {
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {} as never);
		app.decorate("arrClientFactory", {} as never);
		app.decorate("deploymentExecutor", {
			deploySingleInstance,
			deployBulkInstances: vi.fn(),
		} as never);
		app.decorate("notificationService", { notify } as never);
		await app.register(deploymentRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	it("returns 409 and suppresses failure notification for a stale preview", async () => {
		deploySingleInstance.mockRejectedValue(
			new ConflictError("The template or instance changed after this preview"),
		);

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: {
				templateId: "template-1",
				instanceId: "instance-1",
				executionToken: "a".repeat(64),
			},
		});

		expect(response.statusCode).toBe(409);
		expect(response.payload).toContain("changed after this preview");
		expect(notify).not.toHaveBeenCalled();
	});

	it("keeps tokenless direct execution backward compatible", async () => {
		deploySingleInstance.mockResolvedValue({
			instanceId: "instance-1",
			instanceLabel: "Radarr",
			success: true,
			customFormatsCreated: 0,
			customFormatsUpdated: 0,
			customFormatsSkipped: 0,
			errors: [],
		});

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: { templateId: "template-1", instanceId: "instance-1" },
		});

		expect(response.statusCode).toBe(200);
		expect(deploySingleInstance).toHaveBeenCalledWith(
			"template-1",
			"instance-1",
			"user-1",
			undefined,
			undefined,
			undefined,
		);
	});
});
