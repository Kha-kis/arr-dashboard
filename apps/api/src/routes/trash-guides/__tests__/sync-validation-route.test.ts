import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	validate: vi.fn(),
	syncTemplate: vi.fn(),
	generatePreview: vi.fn(),
}));

vi.mock("../../../lib/trash-guides/cache-manager.js", () => ({
	createCacheManager: vi.fn(() => ({})),
}));
vi.mock("../../../lib/trash-guides/github-fetcher.js", () => ({
	createTrashFetcher: vi.fn(() => ({})),
}));
vi.mock("../../../lib/trash-guides/repo-config.js", () => ({
	getRepoConfig: vi.fn(async () => ({})),
}));
vi.mock("../../../lib/trash-guides/version-tracker.js", () => ({
	createVersionTracker: vi.fn(() => ({})),
}));
vi.mock("../../../lib/trash-guides/template-updater.js", () => ({
	createTemplateUpdater: vi.fn(() => ({ syncTemplate: mocks.syncTemplate })),
}));
vi.mock("../../../lib/trash-guides/sync-engine.js", () => ({
	createSyncEngine: vi.fn(() => ({ validate: mocks.validate })),
}));
vi.mock("../../../lib/trash-guides/deployment-preview.js", () => ({
	createDeploymentPreviewService: vi.fn(() => ({ generatePreview: mocks.generatePreview })),
}));

import { registerSyncRoutes } from "../sync-routes.js";

const templateId = "cdef0123456789abcdef01234";
const instanceId = "cdef0123456789abcdef01235";

async function createApp(): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	app.decorate("prisma", {
		trashTemplate: { findFirst: vi.fn().mockResolvedValue({ id: templateId }) },
		serviceInstance: { findFirst: vi.fn().mockResolvedValue({ id: instanceId }) },
	} as never);
	app.decorate("arrClientFactory", {} as never);
	app.decorate("deploymentExecutor", {} as never);
	await app.register(registerSyncRoutes);
	await app.ready();
	return app;
}

describe("manual sync validation", () => {
	let app: FastifyInstance | undefined;

	beforeEach(() => {
		vi.clearAllMocks();
		mocks.validate.mockResolvedValue({
			valid: true,
			conflicts: [],
			errors: [],
			warnings: ["Instance is reachable"],
		});
		mocks.syncTemplate.mockResolvedValue({ success: true });
		mocks.generatePreview.mockResolvedValue({
			templateId,
			templateName: "Movie profile",
			instanceId,
			instanceLabel: "Radarr",
			instanceServiceType: "RADARR",
			summary: {
				totalItems: 1,
				newCustomFormats: 0,
				updatedCustomFormats: 1,
				deletedCustomFormats: 0,
				skippedCustomFormats: 0,
				totalConflicts: 0,
				unresolvedConflicts: 0,
				unmatchedCustomFormats: 0,
				orphanedCustomFormats: 1,
			},
			customFormats: [
				{
					trashId: "format-1",
					name: "HDR",
					action: "update",
					defaultScore: 500,
					scoreOverride: 500,
					templateData: {},
					instanceData: {},
					conflicts: [],
					hasConflicts: false,
				},
			],
			unmatchedCustomFormats: [],
			orphanedCustomFormats: [{ instanceId: 7, name: "Old format", score: 100 }],
			canDeploy: true,
			requiresConflictResolution: false,
			instanceReachable: true,
			executionToken: "a".repeat(64),
			namingChanges: ["movieFolderFormat"],
			warnings: ["A legacy mapping will be rebound during execution."],
		});
	});

	afterEach(async () => {
		await app?.close();
		app = undefined;
	});

	it("returns the exact deployment plan without refreshing or mutating the template", async () => {
		app = await createApp();

		const response = await createInjectAuthenticated(app)("POST", "/validate", {
			body: { templateId, instanceId },
		});

		expect(response.statusCode).toBe(200);
		expect(mocks.syncTemplate).not.toHaveBeenCalled();
		expect(response.json()).toMatchObject({
			valid: true,
			executionToken: "a".repeat(64),
			preview: {
				summary: { updatedCustomFormats: 1, orphanedCustomFormats: 1 },
				customFormats: [{ name: "HDR", action: "update", scoreOverride: 500 }],
				orphanedCustomFormats: [{ name: "Old format", score: 100 }],
				namingChanges: ["movieFolderFormat"],
				warnings: ["A legacy mapping will be rebound during execution."],
			},
		});
	});
});
