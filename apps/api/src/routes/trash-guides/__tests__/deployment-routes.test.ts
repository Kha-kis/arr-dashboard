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

	it("returns partial deployment details with a conflict response", async () => {
		const partialDeployment = {
			created: 1,
			updated: 0,
			skipped: 0,
			details: {
				created: ["Created CF"],
				updated: [],
				failed: ["Failed CF"],
				orphaned: [],
			},
		};
		deploySingleInstance.mockRejectedValue(
			new ConflictError("The reviewed profile changed", { partialDeployment }),
		);

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: {
				templateId: "template-1",
				instanceId: "instance-1",
				executionToken: "a".repeat(64),
			},
		});

		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ details: { partialDeployment } });
		expect(notify).not.toHaveBeenCalled();
	});

	it("rejects tokenless direct execution before starting deployment", async () => {
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

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({
			message: "Invalid payload",
		});
		expect(deploySingleInstance).not.toHaveBeenCalled();
	});

	it("rejects an unsupported conflict resolution before starting deployment", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: {
				templateId: "template-1",
				instanceId: "instance-1",
				executionToken: "a".repeat(64),
				conflictResolutions: { "cf-1": "delete_existing" },
			},
		});

		expect(response.statusCode).toBe(400);
		expect(deploySingleInstance).not.toHaveBeenCalled();
	});

	it("returns a non-conflict partial failure as a domain result", async () => {
		notify.mockResolvedValue(undefined);
		const result = {
			instanceId: "instance-1",
			instanceLabel: "Radarr",
			success: false,
			customFormatsCreated: 1,
			customFormatsUpdated: 0,
			customFormatsSkipped: 0,
			errors: ["Naming deployment failed"],
			details: {
				created: ["Created CF"],
				updated: [],
				failed: ["Naming deployment failed"],
			},
		};
		deploySingleInstance.mockResolvedValue(result);

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: {
				templateId: "template-1",
				instanceId: "instance-1",
				executionToken: "a".repeat(64),
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			success: false,
			error: "Deployment failed",
			result,
		});
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({ eventType: "TRASH_DEPLOY_FAILED" }),
		);
	});
});

describe("deployment unlink route", () => {
	it("removes only the template mapping and preserves saved score intent", async () => {
		const app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		const deleteMapping = vi.fn().mockResolvedValue({});
		const deleteOverrides = vi.fn();
		app.decorate("prisma", {
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue({
					id: "mapping-1",
					qualityProfileId: 4,
					instance: { label: "Radarr" },
					template: { name: "Template", userId: "user-1" },
				}),
				delete: deleteMapping,
			},
			instanceQualityProfileOverride: { deleteMany: deleteOverrides },
		} as never);
		app.decorate("arrClientFactory", {} as never);
		app.decorate("deploymentExecutor", {} as never);
		await app.register(deploymentRoutes);
		await app.ready();

		try {
			const response = await createInjectAuthenticated(app)("DELETE", "/unlink", {
				body: { templateId: "template-1", instanceId: "instance-1" },
			});

			expect(response.statusCode).toBe(200);
			expect(deleteMapping).toHaveBeenCalledWith({ where: { id: "mapping-1" } });
			expect(deleteOverrides).not.toHaveBeenCalled();
		} finally {
			await app.close();
		}
	});
});
