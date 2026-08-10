import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";

const mocks = vi.hoisted(() => ({
	cacheGet: vi.fn(),
	createTemplate: vi.fn(),
	getCommitHash: vi.fn(),
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

let upstreamProfileId = 7;
let upstreamProfileName: string | null | undefined = "Any";
let instanceService: "RADARR" | "SONARR" = "RADARR";
let instanceEncryptedApiKey = "encrypted-key-a";
let upstreamCustomFormatName = "Reviewed CF";
let upstreamCustomFormatSpecifications: unknown[] = [{ name: "Source", value: "WEB-DL" }];

function createClient() {
	const Client = instanceService === "RADARR" ? clients.MockRadarrClient : clients.MockSonarrClient;
	return Object.assign(new Client(), {
		qualityProfile: {
			getById: vi.fn().mockResolvedValue({
				id: upstreamProfileId,
				name: upstreamProfileName,
				upgradeAllowed: true,
				cutoff: 1,
				minFormatScore: 0,
				cutoffFormatScore: 0,
				formatItems: [{ format: 42, score: 100 }],
				items: [],
			}),
		},
		customFormat: {
			getAll: vi.fn().mockImplementation(async () => [
				{
					id: 42,
					name: upstreamCustomFormatName,
					specifications: upstreamCustomFormatSpecifications,
					includeCustomFormatWhenRenaming: false,
				},
			]),
		},
	});
}

function requestBody(serviceType = instanceService, sourceStateToken?: string) {
	return {
		serviceType,
		trashId: "cloned-instance-1-7",
		templateName: "Radarr - Any",
		customFormatSelections: {},
		sourceInstanceId: "instance-1",
		sourceProfileId: 7,
		sourceProfileName: "Stale browser profile name",
		sourceInstanceLabel: "Stale browser instance label",
		...(sourceStateToken ? { sourceStateToken } : {}),
		profileConfig: {
			upgradeAllowed: true,
			cutoff: 1,
			minFormatScore: 0,
			cutoffFormatScore: 0,
			items: [],
		},
	};
}

describe("profile clone source authority", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		upstreamProfileId = 7;
		upstreamProfileName = "Any";
		instanceService = "RADARR";
		instanceEncryptedApiKey = "encrypted-key-a";
		upstreamCustomFormatName = "Reviewed CF";
		upstreamCustomFormatSpecifications = [{ name: "Source", value: "WEB-DL" }];
		mocks.cacheGet.mockResolvedValue([]);
		mocks.getCommitHash.mockResolvedValue("commit-1");
		mocks.createTemplate.mockResolvedValue({ id: "template-1" });

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", {
			serviceInstance: {
				findFirst: vi.fn().mockImplementation(async () => ({
					id: "instance-1",
					userId: "user-1",
					service: instanceService,
					label: "Production Radarr",
					baseUrl: "http://radarr:7878",
					encryptedApiKey: instanceEncryptedApiKey,
					encryptionIv: "iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					connectionGeneration: 2,
				})),
			},
		} as never);
		app.decorate("arrClientFactory", { create: vi.fn(() => createClient()) } as never);
		app.decorate("dbProvider", "sqlite");
		await app.register(profileCloneRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	async function getSourceStateToken(): Promise<string> {
		const response = await createInjectAuthenticated(app)("GET", "/profile-details/instance-1/7");
		expect(response.statusCode).toBe(200);
		const token = response.json().data?.sourceStateToken;
		expect(token).toMatch(/^[a-f0-9]{64}$/);
		return token;
	}

	it.each(["RADARR", "SONARR"] as const)(
		"persists the re-fetched %s source identity when the template is renamed",
		async (serviceType) => {
			instanceService = serviceType;
			const sourceStateToken = await getSourceStateToken();
			const response = await createInjectAuthenticated(app)("POST", "/create-template", {
				body: requestBody(serviceType, sourceStateToken),
			});

			expect(response.statusCode).toBe(201);
			expect(mocks.createTemplate).toHaveBeenCalledWith(
				"user-1",
				expect.objectContaining({
					name: "Radarr - Any",
					sourceQualityProfileName: "Any",
					description: "Cloned from Production Radarr: Any",
					config: expect.objectContaining({
						completeQualityProfile: expect.objectContaining({
							sourceInstanceId: "instance-1",
							sourceInstanceLabel: "Production Radarr",
							sourceConnectionStateToken: expect.stringMatching(/^[a-f0-9]{64}$/),
							sourceProfileId: 7,
							sourceProfileName: "Any",
						}),
					}),
				}),
			);
		},
	);

	it("rejects a client service type that does not match the stored source instance", async () => {
		const sourceStateToken = await getSourceStateToken();
		const response = await createInjectAuthenticated(app)("POST", "/create-template", {
			body: requestBody("SONARR", sourceStateToken),
		});

		expect(response.statusCode).toBe(400);
		expect(response.json()).toEqual(
			expect.objectContaining({
				error: expect.stringContaining("Service type mismatch"),
			}),
		);
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});

	it("fails closed when ARR returns a different profile identity than requested", async () => {
		const sourceStateToken = await getSourceStateToken();
		upstreamProfileId = 8;

		const response = await createInjectAuthenticated(app)("POST", "/create-template", {
			body: requestBody("RADARR", sourceStateToken),
		});

		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual(
			expect.objectContaining({
				message: expect.stringContaining("identity changed"),
			}),
		);
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});

	it.each([null, undefined, "", "   "])(
		"fails closed when ARR returns a missing source profile name (%s)",
		async (profileName) => {
			upstreamProfileName = profileName;

			const response = await createInjectAuthenticated(app)("GET", "/profile-details/instance-1/7");

			expect(response.statusCode).toBe(409);
			expect(response.json()).toEqual(
				expect.objectContaining({ message: expect.stringContaining("name is missing") }),
			);
		},
	);

	it("rejects creation when the reviewed source connection changed", async () => {
		const sourceStateToken = await getSourceStateToken();
		instanceEncryptedApiKey = "encrypted-key-b";

		const response = await createInjectAuthenticated(app)("POST", "/create-template", {
			body: requestBody("RADARR", sourceStateToken),
		});

		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual(
			expect.objectContaining({ message: expect.stringContaining("reviewed source") }),
		);
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});

	it.each([
		[
			"name",
			() => {
				upstreamCustomFormatName = "Changed CF";
			},
		],
		[
			"specifications",
			() => {
				upstreamCustomFormatSpecifications = [{ name: "Source", value: "Bluray" }];
			},
		],
	] as const)("rejects creation when reviewed Custom Format %s changed", async (_field, mutate) => {
		const sourceStateToken = await getSourceStateToken();
		mutate();

		const response = await createInjectAuthenticated(app)("POST", "/create-template", {
			body: requestBody("RADARR", sourceStateToken),
		});

		expect(response.statusCode).toBe(409);
		expect(response.json()).toEqual(
			expect.objectContaining({ message: expect.stringContaining("reviewed source") }),
		);
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});

	it("rejects an invalid source review token", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/create-template", {
			body: requestBody("RADARR", "0".repeat(64)),
		});

		expect(response.statusCode).toBe(409);
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});

	it("requires a source review token", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/create-template", {
			body: requestBody(),
		});

		expect(response.statusCode).toBe(400);
		expect(mocks.createTemplate).not.toHaveBeenCalled();
	});
});
