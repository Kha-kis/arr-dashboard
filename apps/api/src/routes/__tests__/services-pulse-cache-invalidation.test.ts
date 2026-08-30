import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const { collectorCalls, mockPulseCollector } = vi.hoisted(() => {
	const calls = new Map<string, number>();
	return {
		collectorCalls: calls,
		mockPulseCollector: vi.fn(async (_app: unknown, userId: string) => {
			const generation = (calls.get(userId) ?? 0) + 1;
			calls.set(userId, generation);
			return [
				{
					id: `pulse-${userId}-${generation}`,
					severity: "warning",
					category: "health",
					title: `Pulse for ${userId}`,
					detail: `Generation ${generation}`,
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
const USER_A = "pulse-cache-user-a";
const USER_B = "pulse-cache-user-b";

function createMockPrisma() {
	const prisma = {
		libraryCleanupConfig: {
			upsert: vi.fn().mockResolvedValue({ id: "cleanup-config-1" }),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
		},
		serviceInstance: {
			create: vi.fn().mockImplementation(({ data }: any) => ({
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
			})),
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

	it("evicts only the creating user's real Pulse cache entry", async () => {
		const initialA = await app.inject({
			method: "GET",
			url: "/pulse",
			headers: { [USER_HEADER]: USER_A },
		});
		const initialB = await app.inject({
			method: "GET",
			url: "/pulse",
			headers: { [USER_HEADER]: USER_B },
		});

		expect(initialA.statusCode).toBe(200);
		expect(initialB.statusCode).toBe(200);
		expect(firstPulseId(initialA)).toBe(`pulse-${USER_A}-1`);
		expect(firstPulseId(initialB)).toBe(`pulse-${USER_B}-1`);
		expect(collectorCalls).toEqual(
			new Map([
				[USER_A, 1],
				[USER_B, 1],
			]),
		);

		const createResponse = await app.inject({
			method: "POST",
			url: "/services",
			headers: { [USER_HEADER]: USER_A },
			payload: {
				label: "Tenant A Sonarr",
				baseUrl: "http://sonarr:8989",
				apiKey: "tenant-a-api-key",
				service: "sonarr",
			},
		});

		expect(createResponse.statusCode).toBe(201);
		expect(prisma.serviceInstance.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ userId: USER_A }),
			}),
		);

		const refreshedA = await app.inject({
			method: "GET",
			url: "/pulse",
			headers: { [USER_HEADER]: USER_A },
		});
		const cachedB = await app.inject({
			method: "GET",
			url: "/pulse",
			headers: { [USER_HEADER]: USER_B },
		});

		expect(firstPulseId(refreshedA)).toBe(`pulse-${USER_A}-2`);
		expect(firstPulseId(cachedB)).toBe(`pulse-${USER_B}-1`);
		expect(collectorCalls).toEqual(
			new Map([
				[USER_A, 2],
				[USER_B, 1],
			]),
		);
	});
});
