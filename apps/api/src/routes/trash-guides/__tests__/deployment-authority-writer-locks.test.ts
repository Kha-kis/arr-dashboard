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
	updatedAt: new Date("2026-08-09T10:00:00.000Z"),
	instance,
	template: { name: "Any", userId: "user-1" },
};

async function createApp(prisma: unknown, deploymentExecutor: unknown) {
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
			templateQualityProfileMapping: {
				findFirst: vi.fn().mockResolvedValue(mapping),
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
			templateQualityProfileMapping: { findFirst: vi.fn().mockResolvedValue(mapping) },
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
});
