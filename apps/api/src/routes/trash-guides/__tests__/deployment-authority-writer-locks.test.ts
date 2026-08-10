import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { deploymentRoutes } from "../deployment-routes.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createSerializedExecutor() {
	let tail: Promise<void> = Promise.resolve();
	const runWithEndpointMutation = vi.fn(
		async <T>(
			_userId: string,
			_instance: unknown,
			_operation: string,
			action: () => Promise<T>,
		) => {
			const previous = tail;
			const turn = deferred();
			tail = previous.then(() => turn.promise);
			await previous;
			try {
				return await action();
			} finally {
				turn.resolve();
			}
		},
	);
	return {
		createEndpointMutationKey: vi.fn().mockReturnValue("user-1:RADARR:credential-1"),
		runWithEndpointMutation,
		deploySingleInstance: vi.fn(),
		deployBulkInstances: vi.fn(),
	};
}

const instance = {
	id: "instance-1",
	userId: "user-1",
	label: "Radarr",
	service: "RADARR",
	baseUrl: "http://radarr:7878",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv",
	connectionGeneration: 2,
};
const mapping = {
	id: "mapping-1",
	templateId: "template-1",
	instanceId: instance.id,
	qualityProfileId: 4,
	qualityProfileName: "Any",
	syncStrategy: "auto",
	managedCustomFormatsCaptured: true,
	managedCustomFormats: "[]",
	updatedAt: new Date("2026-08-09T10:00:00.000Z"),
	instance,
	template: { name: "Any", userId: "user-1" },
};

async function createApp(prisma: unknown, deploymentExecutor: unknown) {
	const database = prisma as Record<string, unknown>;
	database.libraryCleanupConfig ??= {
		upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
		updateMany: vi.fn().mockResolvedValue({ count: 1 }),
	};
	const app = Fastify({ logger: false });
	setupAuthInjection(app);
	registerTestErrorHandler(app);
	app.decorate("prisma", prisma as never);
	app.decorate("arrClientFactory", {} as never);
	app.decorate("deploymentExecutor", deploymentExecutor as never);
	await app.register(deploymentRoutes);
	await app.ready();
	return app;
}

describe("deployment authority writer locking", () => {
	let app: FastifyInstance | undefined;

	afterEach(async () => {
		await app?.close();
		app = undefined;
	});

	it("changes sync strategy under the endpoint lock before automation can write", async () => {
		const mutationStarted = deferred();
		const releaseMutation = deferred();
		let syncStrategy = "auto";
		let upstreamWrites = 0;
		const updateMany = vi.fn().mockImplementation(async () => {
			syncStrategy = "notify";
			mutationStarted.resolve();
			await releaseMutation.promise;
			return { count: 1 };
		});
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue(mapping),
				findMany: vi.fn().mockResolvedValue([mapping]),
				updateMany,
			},
		};
		const executor = createSerializedExecutor();
		app = await createApp(prisma, executor);

		const responsePromise = createInjectAuthenticated(app)("PATCH", "/sync-strategy", {
			body: {
				templateId: mapping.templateId,
				instanceId: mapping.instanceId,
				syncStrategy: "notify",
			},
		});
		await mutationStarted.promise;
		const automationPromise = executor.runWithEndpointMutation(
			"user-1",
			instance,
			"Automatic deployment",
			async () => {
				if (syncStrategy === "auto") upstreamWrites += 1;
			},
		);

		await vi.waitFor(() => expect(updateMany).toHaveBeenCalledOnce());
		expect(upstreamWrites).toBe(0);
		releaseMutation.resolve();

		const response = await responsePromise;
		await automationPromise;
		expect(response.statusCode).toBe(200);
		expect(upstreamWrites).toBe(0);
	});

	it("unlinks under the endpoint lock before automation can write", async () => {
		const mutationStarted = deferred();
		const releaseMutation = deferred();
		let linked = true;
		let upstreamWrites = 0;
		const transaction = {
			templateQualityProfileMapping: {
				deleteMany: vi.fn().mockImplementation(async () => {
					linked = false;
					mutationStarted.resolve();
					await releaseMutation.promise;
					return { count: 1 };
				}),
			},
			instanceQualityProfileOverride: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue(mapping),
				findMany: vi.fn().mockResolvedValue([mapping]),
			},
			$transaction: vi.fn().mockImplementation((action) => action(transaction)),
		};
		const executor = createSerializedExecutor();
		app = await createApp(prisma, executor);

		const responsePromise = createInjectAuthenticated(app)("DELETE", "/unlink", {
			body: { templateId: mapping.templateId, instanceId: mapping.instanceId },
		});
		await mutationStarted.promise;
		const automationPromise = executor.runWithEndpointMutation(
			"user-1",
			instance,
			"Automatic deployment",
			async () => {
				if (linked) upstreamWrites += 1;
			},
		);

		expect(upstreamWrites).toBe(0);
		releaseMutation.resolve();

		const response = await responsePromise;
		await automationPromise;
		expect(response.statusCode).toBe(200);
		expect(upstreamWrites).toBe(0);
	});

	it("changes sync strategy for every equivalent alias", async () => {
		const aliasInstance = { ...instance, id: "instance-alias", label: "Radarr alias" };
		const aliasMapping = {
			...mapping,
			id: "mapping-alias",
			instanceId: aliasInstance.id,
			instance: aliasInstance,
		};
		const updateMany = vi.fn().mockResolvedValue({ count: 2 });
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance, aliasInstance]) },
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue(mapping),
				findMany: vi.fn().mockResolvedValue([mapping, aliasMapping]),
				updateMany,
			},
		};
		const executor = createSerializedExecutor();
		app = await createApp(prisma, executor);

		const response = await createInjectAuthenticated(app)("PATCH", "/sync-strategy", {
			body: {
				templateId: mapping.templateId,
				instanceId: mapping.instanceId,
				syncStrategy: "notify",
			},
		});

		expect(response.statusCode).toBe(200);
		expect(updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({ id: mapping.id }),
						expect.objectContaining({ id: aliasMapping.id }),
					]),
				}),
				data: expect.objectContaining({ syncStrategy: "notify" }),
			}),
		);
	});

	it("unlinks every equivalent alias and its matching score overrides", async () => {
		const aliasInstance = { ...instance, id: "instance-alias", label: "Radarr alias" };
		const aliasMapping = {
			...mapping,
			id: "mapping-alias",
			instanceId: aliasInstance.id,
			instance: aliasInstance,
		};
		const deleteMappings = vi.fn().mockResolvedValue({ count: 2 });
		const deleteOverrides = vi.fn().mockResolvedValue({ count: 2 });
		const transaction = {
			templateQualityProfileMapping: { deleteMany: deleteMappings },
			instanceQualityProfileOverride: { deleteMany: deleteOverrides },
		};
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance, aliasInstance]) },
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue(mapping),
				findMany: vi.fn().mockResolvedValue([mapping, aliasMapping]),
			},
			$transaction: vi.fn().mockImplementation((action) => action(transaction)),
		};
		const executor = createSerializedExecutor();
		app = await createApp(prisma, executor);

		const response = await createInjectAuthenticated(app)("DELETE", "/unlink", {
			body: { templateId: mapping.templateId, instanceId: mapping.instanceId },
		});

		expect(response.statusCode).toBe(200);
		expect(deleteMappings).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({ id: mapping.id }),
						expect.objectContaining({ id: aliasMapping.id }),
					]),
				}),
			}),
		);
		expect(deleteOverrides).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: expect.arrayContaining([
						expect.objectContaining({ instanceId: instance.id, qualityProfileId: 4 }),
						expect.objectContaining({ instanceId: aliasInstance.id, qualityProfileId: 4 }),
					]),
				}),
			}),
		);
	});

	it.each([
		["sync strategy", "PATCH", "/sync-strategy"],
		["unlink", "DELETE", "/unlink"],
	] as const)(
		"blocks a cross-process %s change while another mutation owns the database lease",
		async (_case, method, path) => {
			const updateMappings = vi.fn();
			const deleteMappings = vi.fn();
			const prisma = {
				libraryCleanupConfig: {
					upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
					updateMany: vi.fn().mockResolvedValue({ count: 0 }),
				},
				serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
				templateQualityProfileMapping: {
					findFirst: vi.fn().mockResolvedValue(mapping),
					findMany: vi.fn().mockResolvedValue([mapping]),
					updateMany: updateMappings,
				},
				$transaction: vi.fn().mockImplementation(async (action) =>
					action({
						templateQualityProfileMapping: { deleteMany: deleteMappings },
						instanceQualityProfileOverride: { deleteMany: vi.fn() },
					}),
				),
			};
			const executor = createSerializedExecutor();
			app = await createApp(prisma, executor);

			const response = await createInjectAuthenticated(app)(method, path, {
				body: {
					templateId: mapping.templateId,
					instanceId: mapping.instanceId,
					...(method === "PATCH" ? { syncStrategy: "notify" } : {}),
				},
			});

			expect(response.statusCode).toBe(409);
			expect(updateMappings).not.toHaveBeenCalled();
			expect(deleteMappings).not.toHaveBeenCalled();
		},
	);
});
