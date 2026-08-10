import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { deploymentRoutes } from "../deployment-routes.js";

describe("deployment route uncertain outcomes", () => {
	let app: FastifyInstance;
	const notify = vi.fn();
	const deploySingleInstance = vi.fn();
	const deployBulkInstances = vi.fn();

	beforeEach(async () => {
		vi.clearAllMocks();
		notify.mockResolvedValue(undefined);
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			templateQualityProfileMapping: { findFirst: vi.fn() },
		} as never);
		app.decorate("arrClientFactory", {} as never);
		app.decorate("deploymentExecutor", {
			deploySingleInstance,
			deployBulkInstances,
		} as never);
		app.decorate("notificationService", { notify } as never);
		await app.register(deploymentRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("returns and notifies a direct uncertain result without remapping it to failure", async () => {
		deploySingleInstance.mockResolvedValue({
			instanceId: "instance-1",
			instanceLabel: "Radarr",
			success: false,
			status: "UNCERTAIN",
			errors: ["ARR write could not be verified"],
		});

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: { templateId: "template-1", instanceId: "instance-1" },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: false,
			error: "Deployment result is uncertain",
			result: { status: "UNCERTAIN" },
		});
		await vi.waitFor(() =>
			expect(notify).toHaveBeenCalledWith(
				expect.objectContaining({ eventType: "TRASH_DEPLOY_UNCERTAIN" }),
				{ userId: "user-1", fallbackEventTypes: ["TRASH_DEPLOY_FAILED"] },
			),
		);
	});

	it("returns a partial direct result successfully so clients can refresh applied state", async () => {
		deploySingleInstance.mockResolvedValue({
			instanceId: "instance-1",
			instanceLabel: "Radarr",
			success: false,
			status: "FAILED",
			customFormatsCreated: 1,
			customFormatsUpdated: 0,
			customFormatsSkipped: 0,
			errors: ["A later deployment phase was blocked"],
			details: { created: ["Created CF"], updated: [], failed: [], orphaned: [] },
		});

		const response = await createInjectAuthenticated(app)("POST", "/execute", {
			body: { templateId: "template-1", instanceId: "instance-1" },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: false,
			error: "Deployment partially applied",
			result: {
				status: "FAILED",
				customFormatsCreated: 1,
				details: { created: ["Created CF"] },
			},
		});
	});

	it("sends one logical review notification for mixed bulk failure and uncertainty", async () => {
		deployBulkInstances.mockResolvedValue({
			templateId: "template-1",
			templateName: "Any",
			totalInstances: 2,
			successfulInstances: 0,
			failedInstances: 1,
			uncertainInstances: 1,
			results: [
				{ instanceLabel: "Failed Radarr", status: "FAILED", success: false },
				{ instanceLabel: "Uncertain Radarr", status: "UNCERTAIN", success: false },
			],
		});

		const response = await createInjectAuthenticated(app)("POST", "/execute-bulk", {
			body: {
				templateId: "template-1",
				instanceIds: ["failed", "uncertain"],
			},
		});

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false });
		await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
		expect(notify).toHaveBeenCalledWith(
			expect.objectContaining({
				eventType: "TRASH_DEPLOY_UNCERTAIN",
				body: expect.stringContaining("Failed Radarr"),
			}),
			{ userId: "user-1", fallbackEventTypes: ["TRASH_DEPLOY_FAILED"] },
		);
	});
});
