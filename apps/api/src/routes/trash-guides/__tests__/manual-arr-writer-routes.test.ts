import Fastify, { type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	requireInstance: vi.fn(),
	runWithManualArrWriterGuard: vi.fn(),
	deployCompleteProfile: vi.fn(),
	cacheIsFresh: vi.fn(),
	cacheGet: vi.fn(),
}));

vi.mock("../../../lib/arr/instance-helpers.js", () => ({
	requireInstance: mocks.requireInstance,
}));

vi.mock("../manual-arr-writer-guard.js", () => ({
	runWithManualArrWriterGuard: mocks.runWithManualArrWriterGuard,
}));

vi.mock("../../../lib/trash-guides/profile-cloner.js", () => ({
	createProfileCloner: () => ({ deployCompleteProfile: mocks.deployCompleteProfile }),
}));

vi.mock("../../../lib/trash-guides/cache-manager.js", () => ({
	createCacheManager: () => ({
		isFresh: mocks.cacheIsFresh,
		get: mocks.cacheGet,
	}),
}));

import { registerCustomFormatRoutes } from "../custom-format-routes.js";
import profileCloneRoutes from "../profile-clone-routes.js";
import { qualitySizeRoutes } from "../quality-size-routes.js";
import { registerUserCustomFormatRoutes } from "../user-custom-format-routes.js";

const instance = {
	id: "instance-1",
	userId: "user-1",
	service: "RADARR",
	label: "Radarr",
	baseUrl: "http://radarr:7878",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 1,
};

describe("manual ARR writer route coordination", () => {
	let app: ReturnType<typeof Fastify>;
	const rawRequest = vi.fn();
	const createCustomFormat = vi.fn();

	beforeEach(async () => {
		vi.clearAllMocks();
		mocks.requireInstance.mockResolvedValue(instance);
		mocks.runWithManualArrWriterGuard.mockImplementation(
			async (
				_app: unknown,
				_userId: string,
				_instanceId: string,
				_operation: string,
				action: (verifiedInstance: typeof instance) => Promise<unknown>,
			) => action(instance),
		);
		mocks.deployCompleteProfile.mockResolvedValue({ success: true, profileId: 42 });
		mocks.cacheIsFresh.mockResolvedValue(true);
		mocks.cacheGet.mockResolvedValue([
			{
				trash_id: "trash-cf-1",
				name: "Release Group",
				includeCustomFormatWhenRenaming: false,
				specifications: [],
			},
		]);
		rawRequest.mockResolvedValue(new Response(null, { status: 200 }));
		createCustomFormat.mockResolvedValue({ id: 100 });

		app = Fastify({ logger: false });
		app.decorateRequest("currentUser", null);
		app.addHook("preHandler", async (request: FastifyRequest) => {
			request.currentUser = { id: "user-1", username: "owner" } as never;
		});
		(app as never as { prisma: unknown }).prisma = {
			qualitySizeMapping: { deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
			trashCache: { findFirst: vi.fn().mockResolvedValue({ commitHash: "abc123" }) },
			standaloneCFDeployment: { upsert: vi.fn().mockResolvedValue({}) },
			userCustomFormat: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "cf-1",
						name: "Release Group",
						includeCustomFormatWhenRenaming: false,
						specifications: "[]",
					},
				]),
			},
		};
		(app as never as { arrClientFactory: unknown }).arrClientFactory = {
			rawRequest,
			create: vi.fn(() => ({
				customFormat: {
					getAll: vi.fn().mockResolvedValue([]),
					create: createCustomFormat,
					update: vi.fn(),
				},
			})),
		};

		await app.register(qualitySizeRoutes, { prefix: "/quality-size" });
		await app.register(registerCustomFormatRoutes, { prefix: "/custom-formats" });
		await app.register(registerUserCustomFormatRoutes, { prefix: "/user-custom-formats" });
		await app.register(profileCloneRoutes, { prefix: "/profile-clone" });
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
	});

	it("guards the quality-size reset before its upstream command", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/quality-size/apply",
			payload: { instanceId: "instance-1", presetTrashId: "default" },
		});

		expect(response.statusCode).toBe(200);
		expect(mocks.runWithManualArrWriterGuard).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			"instance-1",
			"Manual quality-size reset",
			expect.any(Function),
		);
		expect(rawRequest).toHaveBeenCalledOnce();
	});

	it("guards user Custom Format deployment before creating upstream resources", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/user-custom-formats/deploy",
			payload: { instanceId: "instance-1", userCFIds: ["cf-1"] },
		});

		expect(response.statusCode).toBe(200);
		expect(mocks.runWithManualArrWriterGuard).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			"instance-1",
			"Manual user Custom Format deployment",
			expect.any(Function),
		);
		expect(createCustomFormat).toHaveBeenCalledOnce();
	});

	it("guards standalone Custom Format deployment before creating upstream resources", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/custom-formats/deploy-multiple",
			payload: {
				instanceId: "instance-1",
				serviceType: "RADARR",
				trashIds: ["trash-cf-1"],
			},
		});

		expect(response.statusCode).toBe(200);
		expect(mocks.runWithManualArrWriterGuard).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			"instance-1",
			"Manual standalone Custom Format deployment",
			expect.any(Function),
		);
		expect(createCustomFormat).toHaveBeenCalledOnce();
	});

	it("stops standalone Custom Format deployment if the service changed before the lock", async () => {
		mocks.runWithManualArrWriterGuard.mockImplementationOnce(
			async (
				_app: unknown,
				_userId: string,
				_instanceId: string,
				_operation: string,
				action: (verifiedInstance: typeof instance) => Promise<unknown>,
			) => action({ ...instance, service: "SONARR" }),
		);

		const response = await app.inject({
			method: "POST",
			url: "/custom-formats/deploy-multiple",
			payload: {
				instanceId: "instance-1",
				serviceType: "RADARR",
				trashIds: ["trash-cf-1"],
			},
		});

		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ error: "SERVICE_CHANGED" });
		expect(createCustomFormat).not.toHaveBeenCalled();
	});

	it("guards profile-clone deployment before invoking the upstream cloner", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/profile-clone/deploy",
			payload: {
				instanceId: "instance-1",
				profile: {},
				customFormats: [],
				profileName: "HD-1080p",
			},
		});

		expect(response.statusCode).toBe(200);
		expect(mocks.runWithManualArrWriterGuard).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			"instance-1",
			"Manual profile-clone deployment",
			expect.any(Function),
		);
		expect(mocks.deployCompleteProfile).toHaveBeenCalledOnce();
	});
});
