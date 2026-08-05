import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	cacheGet: vi.fn(),
	getCommitHash: vi.fn(),
	createTemplate: vi.fn(),
}));

const clients = vi.hoisted(() => {
	class MockRadarrClient {}
	class MockSonarrClient {}
	return { MockRadarrClient, MockSonarrClient };
});

vi.mock("arr-sdk", () => ({
	RadarrClient: clients.MockRadarrClient,
	SonarrClient: clients.MockSonarrClient,
}));

vi.mock("../../../lib/trash-guides/cache-manager.js", () => ({
	createCacheManager: () => ({
		get: mocks.cacheGet,
		getCommitHash: mocks.getCommitHash,
	}),
}));

vi.mock("../../../lib/trash-guides/template-service.js", () => ({
	createTemplateService: () => ({ createTemplate: mocks.createTemplate }),
}));

import profileCloneRoutes from "../profile-clone-routes.js";

function createClient(
	serviceType: "RADARR" | "SONARR",
	formatItems: unknown[],
	customFormats: unknown[] = [{ id: 42, name: "Language: Not English", specifications: [] }],
) {
	const Client = serviceType === "RADARR" ? clients.MockRadarrClient : clients.MockSonarrClient;
	return Object.assign(new Client(), {
		qualityProfile: {
			getById: vi.fn().mockResolvedValue({
				id: 7,
				name: "Any",
				upgradeAllowed: true,
				cutoff: 1,
				minFormatScore: 0,
				cutoffFormatScore: 0,
				formatItems,
				items: [],
			}),
		},
		customFormat: {
			getAll: vi.fn().mockResolvedValue(customFormats),
		},
	});
}

function requestBody(serviceType: "RADARR" | "SONARR") {
	return {
		serviceType,
		trashId: "cloned-instance-1-7",
		templateName: `${serviceType} Any Clone`,
		customFormatSelections: {
			"instance-42": { selected: true, conditionsEnabled: {} },
		},
		sourceInstanceId: "instance-1",
		sourceProfileId: 7,
		sourceProfileName: "Any",
		sourceInstanceLabel: serviceType,
		profileConfig: {
			upgradeAllowed: true,
			cutoff: 1,
			minFormatScore: 0,
			cutoffFormatScore: 0,
			items: [],
		},
	};
}

describe("profile clone template scores", () => {
	let app: FastifyInstance;

	beforeEach(() => {
		mocks.cacheGet.mockResolvedValue([]);
		mocks.getCommitHash.mockResolvedValue("commit-1");
		mocks.createTemplate.mockResolvedValue({ id: "template-1" });
	});

	afterEach(async () => {
		await app?.close();
		vi.clearAllMocks();
	});

	async function setup(
		serviceType: "RADARR" | "SONARR",
		formatItems: unknown[],
		customFormats?: unknown[],
		instanceService: "RADARR" | "SONARR" = serviceType,
	) {
		const client = createClient(serviceType, formatItems, customFormats);
		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					id: "instance-1",
					userId: "user-1",
					service: instanceService,
				}),
			},
		} as never);
		app.decorate("arrClientFactory", { create: vi.fn(() => client) } as never);
		app.decorate("dbProvider", "sqlite");
		await app.register(profileCloneRoutes);
		await app.ready();
	}

	it.each(["RADARR", "SONARR"] as const)(
		"stores the authoritative %s source score for Keep Instance",
		async (serviceType) => {
			await setup(serviceType, [{ format: 42, score: -10_000 }]);

			const response = await createInjectAuthenticated(app)("POST", "/create-template", {
				body: requestBody(serviceType),
			});

			expect(response.statusCode).toBe(201);
			expect(mocks.createTemplate).toHaveBeenCalledWith(
				"user-1",
				expect.objectContaining({
					config: expect.objectContaining({
						customFormats: [
							expect.objectContaining({
								trashId: "instance-42",
								scoreOverride: -10_000,
							}),
						],
					}),
				}),
			);
		},
	);

	it("returns a conflict instead of storing zero when the source score disappeared", async () => {
		await setup("RADARR", []);

		const response = await createInjectAuthenticated(app)("POST", "/create-template", {
			body: requestBody("RADARR"),
		});

		expect(response.statusCode).toBe(409);
		expect(response.payload).toContain("no longer has a score");
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});

	it("returns a conflict when the selected instance format disappeared", async () => {
		await setup("RADARR", [{ format: 42, score: -10_000 }], []);

		const response = await createInjectAuthenticated(app)("POST", "/create-template", {
			body: requestBody("RADARR"),
		});

		expect(response.statusCode).toBe(409);
		expect(response.payload).toContain("no longer exists");
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});

	it("returns a conflict when a selected TRaSH-linked format disappeared", async () => {
		await setup("RADARR", [{ format: 42, score: -10_000 }]);
		const body = {
			...requestBody("RADARR"),
			customFormatSelections: {
				"trash-missing": { selected: true, conditionsEnabled: {} },
			},
		};

		const response = await createInjectAuthenticated(app)("POST", "/create-template", { body });

		expect(response.statusCode).toBe(409);
		expect(response.payload).toContain("no longer exists in the current cache");
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});

	it.each([
		["RADARR", "SONARR"],
		["SONARR", "RADARR"],
	] as const)(
		"rejects a %s request for a %s instance before reading upstream data",
		async (requestService, instanceService) => {
			await setup(requestService, [{ format: 42, score: -10_000 }], undefined, instanceService);

			const response = await createInjectAuthenticated(app)("POST", "/create-template", {
				body: requestBody(requestService),
			});

			expect(response.statusCode).toBe(400);
			expect(response.payload).toContain("Service type mismatch");
			expect(mocks.createTemplate).not.toHaveBeenCalled();
		},
	);

	it("persists the re-fetched source profile name instead of stale wizard text", async () => {
		await setup("RADARR", [{ format: 42, score: -10_000 }]);
		const body = {
			...requestBody("RADARR"),
			sourceProfileId: 99,
			sourceProfileName: "Stale profile name",
		};

		const response = await createInjectAuthenticated(app)("POST", "/create-template", { body });

		expect(response.statusCode).toBe(201);
		expect(mocks.createTemplate).toHaveBeenCalledWith(
			"user-1",
			expect.objectContaining({
				sourceQualityProfileName: "Any",
				config: expect.objectContaining({
					completeQualityProfile: expect.objectContaining({
						sourceProfileId: 7,
						sourceProfileName: "Any",
					}),
				}),
			}),
		);
	});
});
