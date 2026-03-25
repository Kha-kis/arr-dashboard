import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const { mockRequireInstance, mockTestConnection, mockBuildUpdateData, mockUpsertTags, mockUpdateInstanceTags, mockFormatServiceInstance } = vi.hoisted(() => ({
	mockRequireInstance: vi.fn(),
	mockTestConnection: vi.fn().mockResolvedValue({ success: true, version: "4.0.0" }),
	mockBuildUpdateData: vi.fn().mockReturnValue({}),
	mockUpsertTags: vi.fn().mockResolvedValue([]),
	mockUpdateInstanceTags: vi.fn().mockResolvedValue(undefined),
	mockFormatServiceInstance: vi.fn().mockImplementation((instance: any) => ({
		id: instance.id,
		service: instance.service?.toLowerCase?.() ?? "sonarr",
		label: instance.label ?? "Test Instance",
		baseUrl: instance.baseUrl ?? "http://localhost:8989",
		externalUrl: instance.externalUrl ?? null,
		enabled: instance.enabled ?? true,
		isDefault: instance.isDefault ?? false,
		tags: [],
		storageGroupId: instance.storageGroupId ?? null,
	})),
}));

vi.mock("../../lib/arr/instance-helpers.js", () => ({
	requireInstance: (...args: unknown[]) => mockRequireInstance(...args),
}));

vi.mock("../../lib/services/connection-tester.js", () => ({
	testServiceConnection: (...args: unknown[]) => mockTestConnection(...args),
}));

vi.mock("../../lib/services/update-builder.js", () => ({
	buildUpdateData: (...args: unknown[]) => mockBuildUpdateData(...args),
}));

vi.mock("../../lib/services/tag-manager.js", () => ({
	upsertTags: (...args: unknown[]) => mockUpsertTags(...args),
	updateInstanceTags: (...args: unknown[]) => mockUpdateInstanceTags(...args),
}));

vi.mock("../../lib/services/service-formatter.js", () => ({
	formatServiceInstance: (instance: unknown) => mockFormatServiceInstance(instance),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import { registerServiceRoutes } from "../services.js";
import { InstanceNotFoundError } from "../../lib/errors.js";
import { setupAuthInjection, createInjectAuthenticated, createMockEncryptor, registerTestErrorHandler } from "./test-helpers.js";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function makeInstance(overrides: Record<string, unknown> = {}) {
	return {
		id: "inst-1",
		userId: "user-1",
		service: "SONARR",
		label: "Sonarr 1",
		baseUrl: "http://localhost:8989",
		externalUrl: null,
		encryptedApiKey: "encrypted-key",
		encryptionIv: "mock-iv",
		enabled: true,
		isDefault: false,
		createdAt: new Date("2024-01-01T00:00:00Z"),
		updatedAt: new Date("2024-01-01T00:00:00Z"),
		storageGroupId: null,
		tags: [],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Mock Prisma client
// ---------------------------------------------------------------------------

function createMockPrisma() {
	return {
		serviceInstance: {
			findMany: vi.fn().mockResolvedValue([]),
			findFirst: vi.fn().mockResolvedValue(null),
			create: vi.fn().mockImplementation(({ data }: any) => ({
				id: "inst-new",
				...data,
				createdAt: new Date(),
				updatedAt: new Date(),
				tags: [],
			})),
			updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		serviceTag: {
			findMany: vi.fn().mockResolvedValue([]),
			upsert: vi.fn().mockImplementation(({ create }: any) => ({
				id: "tag-1",
				name: create.name,
			})),
			delete: vi.fn().mockResolvedValue(undefined),
		},
		serviceInstanceTag: {
			findFirst: vi.fn().mockResolvedValue(null),
		},
	};
}

// ---------------------------------------------------------------------------
// Fastify app setup
// ---------------------------------------------------------------------------

let app: ReturnType<typeof Fastify>;
let mockPrisma: ReturnType<typeof createMockPrisma>;
let injectAuthenticated: ReturnType<typeof createInjectAuthenticated>;

beforeEach(async () => {
	vi.clearAllMocks();

	mockPrisma = createMockPrisma();

	// Default: requireInstance returns a valid instance
	mockRequireInstance.mockResolvedValue(makeInstance());
	mockBuildUpdateData.mockReturnValue({});

	app = Fastify();

	// Decorations
	app.decorate("prisma", mockPrisma);
	app.decorate("encryptor", createMockEncryptor("decrypted-api-key"));
	app.decorate("notificationService", {
		notify: vi.fn().mockResolvedValue(undefined),
	});

	setupAuthInjection(app);
	registerTestErrorHandler(app);

	await app.register(registerServiceRoutes);
	await app.ready();

	injectAuthenticated = createInjectAuthenticated(app);
});

afterAll(async () => {
	await app?.close();
});

// ===========================================================================
// POST /services — create instance
// ===========================================================================

describe("POST /services", () => {
	it("creates instance with encrypted API key and returns 201", async () => {
		const res = await injectAuthenticated("POST", "/services", {
			body: {
				label: "My Sonarr",
				baseUrl: "http://sonarr:8989",
				apiKey: "my-secret-api-key",
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);
		expect(body.service).toBeDefined();
		expect(body.service.id).toBeDefined();

		// Encryption should have been called with the raw API key
		expect((app as any).encryptor.encrypt).toHaveBeenCalledWith("my-secret-api-key");

		// Prisma create should receive encrypted values, not plaintext
		expect(mockPrisma.serviceInstance.create).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					encryptedApiKey: "encrypted",
					encryptionIv: "mock-iv",
					userId: "user-1",
					service: "SONARR",
				}),
			}),
		);
	});

	it("demotes other instances when isDefault is true", async () => {
		const res = await injectAuthenticated("POST", "/services", {
			body: {
				label: "Default Sonarr",
				baseUrl: "http://sonarr:8989",
				apiKey: "my-secret-api-key",
				service: "sonarr",
				isDefault: true,
			},
		});

		expect(res.statusCode).toBe(201);

		// Should have called updateMany to demote other SONARR instances
		expect(mockPrisma.serviceInstance.updateMany).toHaveBeenCalledWith({
			where: { service: "SONARR", userId: "user-1" },
			data: { isDefault: false },
		});
	});

	it("does not demote when isDefault is false", async () => {
		await injectAuthenticated("POST", "/services", {
			body: {
				label: "Secondary Sonarr",
				baseUrl: "http://sonarr2:8989",
				apiKey: "my-secret-api-key",
				service: "sonarr",
				isDefault: false,
			},
		});

		expect(mockPrisma.serviceInstance.updateMany).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// PUT /services/:id — update instance
// ===========================================================================

describe("PUT /services/:id", () => {
	it("calls buildUpdateData and updates the instance", async () => {
		mockBuildUpdateData.mockReturnValue({ label: "Updated Label" });
		mockPrisma.serviceInstance.findFirst.mockResolvedValue(makeInstance({ label: "Updated Label" }));

		const res = await injectAuthenticated("PUT", "/services/inst-1", {
			body: { label: "Updated Label" },
		});

		expect(res.statusCode).toBe(200);

		// requireInstance should verify ownership
		expect(mockRequireInstance).toHaveBeenCalledWith(
			expect.anything(), // app
			"user-1",
			"inst-1",
		);

		// buildUpdateData receives the payload and encryptor
		expect(mockBuildUpdateData).toHaveBeenCalledWith(
			expect.objectContaining({ label: "Updated Label" }),
			expect.objectContaining({ encrypt: expect.any(Function) }),
		);
	});

	it("returns 404 for non-owned instance via requireInstance", async () => {
		mockRequireInstance.mockRejectedValue(new InstanceNotFoundError("inst-999"));

		const res = await injectAuthenticated("PUT", "/services/inst-999", {
			body: { label: "Hacker Update" },
		});

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).message).toContain("not found");
	});
});

// ===========================================================================
// DELETE /services/:id
// ===========================================================================

describe("DELETE /services/:id", () => {
	it("deletes owned instance and returns 204", async () => {
		const res = await injectAuthenticated("DELETE", "/services/inst-1");

		expect(res.statusCode).toBe(204);
		expect(mockRequireInstance).toHaveBeenCalledWith(
			expect.anything(),
			"user-1",
			"inst-1",
		);
		expect(mockPrisma.serviceInstance.delete).toHaveBeenCalledWith({
			where: { id: "inst-1", userId: "user-1" },
		});
	});

	it("returns 404 for non-owned instance", async () => {
		mockRequireInstance.mockRejectedValue(new InstanceNotFoundError("inst-999"));

		const res = await injectAuthenticated("DELETE", "/services/inst-999");

		expect(res.statusCode).toBe(404);
		expect(mockPrisma.serviceInstance.delete).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// POST /services/test-connection — SSRF guard
// ===========================================================================

describe("POST /services/test-connection", () => {
	it("calls connection tester with valid http URL", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "http://sonarr:8989",
				apiKey: "test-key",
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(200);
		expect(mockTestConnection).toHaveBeenCalledWith(
			"http://sonarr:8989",
			"test-key",
			"sonarr",
		);
	});

	it("rejects non-http scheme (SSRF prevention)", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "file:///etc/passwd",
				apiKey: "test-key",
				service: "sonarr",
			},
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toBe("Invalid URL scheme");

		// Connection tester should NOT have been called
		expect(mockTestConnection).not.toHaveBeenCalled();
	});

	it("rejects invalid service type", async () => {
		const res = await injectAuthenticated("POST", "/services/test-connection", {
			body: {
				baseUrl: "http://sonarr:8989",
				apiKey: "test-key",
				service: "not-a-real-service",
			},
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.payload).error).toBe("Invalid service type");
		expect(mockTestConnection).not.toHaveBeenCalled();
	});
});

// ===========================================================================
// POST /tags — upsert
// ===========================================================================

describe("POST /tags", () => {
	it("creates a new tag and returns 201", async () => {
		const res = await injectAuthenticated("POST", "/tags", {
			body: { name: "anime" },
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.payload);
		expect(body.tag.name).toBe("anime");

		expect(mockPrisma.serviceTag.upsert).toHaveBeenCalledWith({
			where: { name: "anime" },
			update: {},
			create: { name: "anime" },
		});
	});
});

// ===========================================================================
// DELETE /tags/:id — ownership check
// ===========================================================================

describe("DELETE /tags/:id", () => {
	it("returns 404 when user has no instance using the tag", async () => {
		mockPrisma.serviceInstanceTag.findFirst.mockResolvedValue(null);

		const res = await injectAuthenticated("DELETE", "/tags/tag-1");

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.payload).error).toBe("Tag not found");
		expect(mockPrisma.serviceTag.delete).not.toHaveBeenCalled();
	});

	it("deletes tag when user has an instance using it", async () => {
		mockPrisma.serviceInstanceTag.findFirst.mockResolvedValue({
			tagId: "tag-1",
			instanceId: "inst-1",
		});

		const res = await injectAuthenticated("DELETE", "/tags/tag-1");

		expect(res.statusCode).toBe(204);
		expect(mockPrisma.serviceTag.delete).toHaveBeenCalledWith({
			where: { id: "tag-1" },
		});
	});
});
