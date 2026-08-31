import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { collectorCalls, persistedServiceRevisions, queueDeferredCollection, mockPulseCollector } =
	vi.hoisted(() => {
		type CollectionPlan = {
			started: Promise<void>;
			markStarted: () => void;
			releasePromise: Promise<void>;
			release: () => void;
		};

		const calls = new Map<string, number>();
		const serviceRevisions = new Map<string, number>();
		const plans = new Map<string, CollectionPlan[]>();

		function deferred(): { promise: Promise<void>; resolve: () => void } {
			let resolve!: () => void;
			const promise = new Promise<void>((resolvePromise) => {
				resolve = resolvePromise;
			});
			return { promise, resolve };
		}

		return {
			collectorCalls: calls,
			persistedServiceRevisions: serviceRevisions,
			queueDeferredCollection(userId: string) {
				const started = deferred();
				const release = deferred();
				const plan: CollectionPlan = {
					started: started.promise,
					markStarted: started.resolve,
					releasePromise: release.promise,
					release: release.resolve,
				};
				plans.set(userId, [...(plans.get(userId) ?? []), plan]);
				return { started: plan.started, release: plan.release };
			},
			mockPulseCollector: vi.fn(async (_app: unknown, userId: string) => {
				const call = (calls.get(userId) ?? 0) + 1;
				calls.set(userId, call);
				const capturedServiceRevision = serviceRevisions.get(userId) ?? 0;
				const plan = plans.get(userId)?.shift();
				plan?.markStarted();
				if (plan) await plan.releasePromise;
				return [
					{
						id: `pulse-${userId}-service-${capturedServiceRevision}-call-${call}`,
						severity: "warning",
						category: "health",
						title: `Pulse for ${userId}`,
						detail: `Service revision ${capturedServiceRevision}`,
						source: "test",
						timestamp: "2026-08-29T00:00:00.000Z",
						actionUrl: "/settings/services",
					},
				];
			}),
		};
	});

vi.mock("../../lib/pulse/collectors.js", () => ({
	pulseCollectors: [mockPulseCollector],
}));

vi.mock("../../lib/services/tag-manager.js", () => ({
	upsertTags: vi.fn().mockResolvedValue([]),
	updateInstanceTags: vi.fn().mockResolvedValue(undefined),
}));

import Fastify, { type FastifyInstance } from "fastify";
import { registerPulseRoutes } from "../pulse.js";
import { registerServiceRoutes } from "../services.js";
import { createMockEncryptor, registerTestErrorHandler } from "./test-helpers.js";

const USER_HEADER = "x-test-user";

function createMockPrisma() {
	const prisma = {
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		serviceInstance: {
			create: vi.fn().mockImplementation(({ data }: any) => {
				persistedServiceRevisions.set(
					data.userId,
					(persistedServiceRevisions.get(data.userId) ?? 0) + 1,
				);
				return {
					id: "service-new",
					...data,
					externalUrl: data.externalUrl ?? null,
					enabled: data.enabled ?? true,
					isDefault: data.isDefault ?? false,
					createdAt: new Date("2026-08-29T00:00:00.000Z"),
					updatedAt: new Date("2026-08-29T00:00:00.000Z"),
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					storageGroupId: data.storageGroupId ?? null,
					hasLocalFilesystemAccess: false,
					pathPrefix: null,
					identityStatus: "UNVERIFIED",
					tags: [],
				};
			}),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
	};
	return Object.assign(prisma, {
		$transaction: vi.fn(async (callback: (tx: typeof prisma) => Promise<unknown>) =>
			callback(prisma),
		),
	});
}

function setupUserAuth(app: FastifyInstance) {
	app.decorateRequest("currentUser", null);
	app.decorateRequest("sessionToken", null);
	app.addHook("preHandler", async (request: any) => {
		const userId = request.headers[USER_HEADER];
		if (typeof userId === "string") {
			request.currentUser = { id: userId, username: userId };
			request.sessionToken = "test-session-token";
		}
	});
}

function firstPulseId(response: { payload: string }): string {
	return JSON.parse(response.payload).items[0].id;
}

describe("service creation Pulse cache invalidation", () => {
	let app: FastifyInstance;
	let prisma: ReturnType<typeof createMockPrisma>;

	beforeAll(async () => {
		collectorCalls.clear();
		persistedServiceRevisions.clear();
		prisma = createMockPrisma();
		app = Fastify();
		app.decorate("prisma", prisma as any);
		app.decorate("encryptor", createMockEncryptor() as any);
		setupUserAuth(app);
		registerTestErrorHandler(app);
		await app.register(registerPulseRoutes);
		await app.register(registerServiceRoutes);
		await app.ready();
	});

	afterAll(async () => {
		await app?.close();
	});

	async function getPulse(userId: string) {
		return app.inject({
			method: "GET",
			url: "/pulse",
			headers: { [USER_HEADER]: userId },
		});
	}

	async function createService(userId: string) {
		const response = await app.inject({
			method: "POST",
			url: "/services",
			headers: { [USER_HEADER]: userId },
			payload: {
				label: `Sonarr for ${userId}`,
				baseUrl: "http://sonarr:8989",
				apiKey: "tenant-api-key",
				service: "sonarr",
			},
		});
		expect(response.statusCode).toBe(201);
		expect(prisma.serviceInstance.create).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ userId }),
			}),
		);
		return response;
	}

	it("does not let a pre-create no-entry GET overwrite a newer published response", async () => {
		const userId = "pulse-overlap-newer-publication";
		const oldCollection = queueDeferredCollection(userId);
		const oldResponsePromise = getPulse(userId);
		await oldCollection.started;

		await createService(userId);
		const newResponse = await getPulse(userId);
		expect(firstPulseId(newResponse)).toBe(`pulse-${userId}-service-1-call-2`);

		oldCollection.release();
		const oldResponse = await oldResponsePromise;
		expect(firstPulseId(oldResponse)).toBe(`pulse-${userId}-service-0-call-1`);

		const cachedResponse = await getPulse(userId);
		expect(firstPulseId(cachedResponse)).toBe(`pulse-${userId}-service-1-call-2`);
		expect(collectorCalls.get(userId)).toBe(2);
	});

	it("rotates the generation when invalidation finds no cache entry", async () => {
		const userId = "pulse-overlap-false-delete";
		const oldCollection = queueDeferredCollection(userId);
		const oldResponsePromise = getPulse(userId);
		await oldCollection.started;

		await createService(userId);
		oldCollection.release();
		const oldResponse = await oldResponsePromise;
		expect(firstPulseId(oldResponse)).toBe(`pulse-${userId}-service-0-call-1`);

		const postInvalidationResponse = await getPulse(userId);
		expect(firstPulseId(postInvalidationResponse)).toBe(`pulse-${userId}-service-1-call-2`);
		expect(collectorCalls.get(userId)).toBe(2);
	});

	it("keeps user B cached while user A overlaps service invalidation", async () => {
		const userA = "pulse-overlap-tenant-a";
		const userB = "pulse-overlap-tenant-b";
		const primedB = await getPulse(userB);
		expect(firstPulseId(primedB)).toBe(`pulse-${userB}-service-0-call-1`);

		const oldCollectionA = queueDeferredCollection(userA);
		const oldResponseAPromise = getPulse(userA);
		await oldCollectionA.started;
		await createService(userA);

		const newResponseA = await getPulse(userA);
		expect(firstPulseId(newResponseA)).toBe(`pulse-${userA}-service-1-call-2`);
		oldCollectionA.release();
		await oldResponseAPromise;

		const cachedB = await getPulse(userB);
		expect(firstPulseId(cachedB)).toBe(`pulse-${userB}-service-0-call-1`);
		expect(collectorCalls.get(userB)).toBe(1);
	});

	it("rejects every old producer after a new generation publishes", async () => {
		const userId = "pulse-overlap-multiple-old-producers";
		const firstOldCollection = queueDeferredCollection(userId);
		const secondOldCollection = queueDeferredCollection(userId);
		const firstOldResponsePromise = getPulse(userId);
		const secondOldResponsePromise = getPulse(userId);
		await Promise.all([firstOldCollection.started, secondOldCollection.started]);

		await createService(userId);
		const newResponse = await getPulse(userId);
		expect(firstPulseId(newResponse)).toBe(`pulse-${userId}-service-1-call-3`);

		firstOldCollection.release();
		secondOldCollection.release();
		const [firstOldResponse, secondOldResponse] = await Promise.all([
			firstOldResponsePromise,
			secondOldResponsePromise,
		]);
		expect(firstPulseId(firstOldResponse)).toBe(`pulse-${userId}-service-0-call-1`);
		expect(firstPulseId(secondOldResponse)).toBe(`pulse-${userId}-service-0-call-2`);

		const cachedResponse = await getPulse(userId);
		expect(firstPulseId(cachedResponse)).toBe(`pulse-${userId}-service-1-call-3`);
		expect(collectorCalls.get(userId)).toBe(3);
	});
});
