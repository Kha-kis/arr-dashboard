/**
 * Tests for ARR Client Helper Utilities
 *
 * Unit tests for executeOnInstances and related helper functions.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ServiceInstance, ServiceType } from "@prisma/client";
import type { FastifyInstance } from "fastify";
import {
	executeOnInstances,
	getClientForInstance,
	isSonarrClient,
	isRadarrClient,
	isProwlarrClient,
	type MultiInstanceResponse,
} from "../client-helpers.js";
import type { FastifyRequest } from "fastify";
import { SonarrClient, RadarrClient, ProwlarrClient } from "arr-sdk";

// Mock the arr-sdk module
vi.mock("arr-sdk", () => {
	// Define MockArrError inside the factory
	class MockArrError extends Error {
		constructor(
			message: string,
			public readonly statusCode?: number,
		) {
			super(message);
			this.name = "ArrError";
		}
	}

	return {
		SonarrClient: class MockSonarrClient {
			constructor() {}
		},
		RadarrClient: class MockRadarrClient {
			constructor() {}
		},
		ProwlarrClient: class MockProwlarrClient {
			constructor() {}
		},
		ArrError: MockArrError,
	};
});

// Create mock instances
const createMockInstance = (
	id: string,
	service: ServiceType,
	label: string,
	enabled = true,
): ServiceInstance => ({
	id,
	service,
	label,
	baseUrl: `http://${label.toLowerCase()}.local`,
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv-123",
	enabled,
	userId: "user-123",
	createdAt: new Date(),
	updatedAt: new Date(),
});

// Create mock logger
const createMockLogger = () => ({
	error: vi.fn(),
	warn: vi.fn(),
	info: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
	fatal: vi.fn(),
});

// Create mock Fastify app
const createMockApp = (
	instances: ServiceInstance[],
	clientFactory?: any,
): FastifyInstance => {
	const mockFindMany = vi.fn().mockResolvedValue(instances);

	return {
		prisma: {
			serviceInstance: {
				findMany: mockFindMany,
			},
		},
		log: createMockLogger(),
		arrClientFactory: clientFactory ?? {
			create: vi.fn((instance: ServiceInstance) => {
				switch (instance.service) {
					case "SONARR":
						return new SonarrClient("http://test", "key");
					case "RADARR":
						return new RadarrClient("http://test", "key");
					case "PROWLARR":
						return new ProwlarrClient("http://test", "key");
					default:
						throw new Error(`Unknown service: ${instance.service}`);
				}
			}),
		},
	} as unknown as FastifyInstance;
};

describe("executeOnInstances - Basic Functionality", () => {
	it("should execute operation on all matching instances", async () => {
		const instances = [
			createMockInstance("1", "SONARR", "Sonarr 1"),
			createMockInstance("2", "RADARR", "Radarr 1"),
		];

		const app = createMockApp(instances);
		const operation = vi.fn().mockResolvedValue({ data: "test" });

		const result = await executeOnInstances(app, "user-123", {}, operation);

		// totalCount is the count of aggregated data items, not instances
		// With 2 instances each returning { data: "test" }, aggregated = [{ data: "test" }, { data: "test" }]
		expect(result.totalCount).toBe(2);
		expect(result.errorCount).toBe(0);
		expect(result.aggregated).toHaveLength(2);
		expect(result.instances).toHaveLength(2);
		expect(operation).toHaveBeenCalledTimes(2);
	});

	it("should filter by service type", async () => {
		const instances = [
			createMockInstance("1", "SONARR", "Sonarr 1"),
		];

		const app = createMockApp(instances);
		const operation = vi.fn().mockResolvedValue({ data: "test" });

		await executeOnInstances(
			app,
			"user-123",
			{ serviceTypes: ["SONARR"] },
			operation,
		);

		expect(app.prisma.serviceInstance.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					service: { in: ["SONARR"] },
				}),
			}),
		);
	});

	it("should filter by instance IDs", async () => {
		const instances = [createMockInstance("1", "SONARR", "Sonarr 1")];

		const app = createMockApp(instances);
		const operation = vi.fn().mockResolvedValue({ data: "test" });

		await executeOnInstances(
			app,
			"user-123",
			{ instanceIds: ["1", "2"] },
			operation,
		);

		expect(app.prisma.serviceInstance.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: { in: ["1", "2"] },
				}),
			}),
		);
	});

	it("should include disabled instances when enabledOnly is false", async () => {
		const instances = [
			createMockInstance("1", "SONARR", "Sonarr 1", true),
			createMockInstance("2", "SONARR", "Sonarr 2", false),
		];

		const app = createMockApp(instances);
		const operation = vi.fn().mockResolvedValue({ data: "test" });

		await executeOnInstances(
			app,
			"user-123",
			{ enabledOnly: false },
			operation,
		);

		// Should NOT include enabled filter in query
		expect(app.prisma.serviceInstance.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.not.objectContaining({
					enabled: true,
				}),
			}),
		);
	});
});

describe("executeOnInstances - Error Handling", () => {
	it("should continue on error by default", async () => {
		// Create fresh instances with unique IDs
		const instance1 = createMockInstance("error-test-1", "SONARR", "Sonarr Error 1");
		const instance2 = createMockInstance("error-test-2", "SONARR", "Sonarr Error 2");
		const instances = [instance1, instance2];

		// Create a fresh mock for findMany that returns our instances
		const mockFindMany = vi.fn().mockResolvedValue(instances);

		// Create mock app inline for this test
		const app = {
			prisma: {
				serviceInstance: {
					findMany: mockFindMany,
				},
			},
			log: createMockLogger(),
			arrClientFactory: {
				create: vi.fn((instance: ServiceInstance) => {
					return new SonarrClient("http://test", "key");
				}),
			},
		} as unknown as FastifyInstance;

		// Track call order
		let callCount = 0;
		const operation = vi.fn().mockImplementation(() => {
			callCount++;
			if (callCount === 1) {
				return Promise.resolve({ data: "success" });
			}
			return Promise.reject(new Error("API error"));
		});

		const result = await executeOnInstances(app, "user-123", {}, operation);

		// Verify findMany was called and returned our instances
		expect(mockFindMany).toHaveBeenCalled();
		// totalCount is the count of aggregated data (successful results only)
		// 1 success + 1 error = 1 in aggregated
		expect(result.totalCount).toBe(1);
		expect(result.errorCount).toBe(1);
		expect(result.instances).toHaveLength(2);
		expect(result.aggregated).toHaveLength(1);
	});

	it("should capture error details in result", async () => {
		const instances = [createMockInstance("1", "SONARR", "Sonarr 1")];

		const app = createMockApp(instances);
		const operation = vi.fn().mockRejectedValue(new Error("Connection failed"));

		const result = await executeOnInstances(app, "user-123", {}, operation);

		expect(result.errorCount).toBe(1);
		const errorResult = result.instances[0];
		expect(errorResult.success).toBe(false);
		if (!errorResult.success) {
			expect(errorResult.error).toBe("Connection failed");
		}
	});

	it("should return empty results when no instances match", async () => {
		const app = createMockApp([]);
		const operation = vi.fn();

		const result = await executeOnInstances(app, "user-123", {}, operation);

		expect(result.totalCount).toBe(0);
		expect(result.errorCount).toBe(0);
		expect(result.aggregated).toHaveLength(0);
		expect(operation).not.toHaveBeenCalled();
	});
});

describe("executeOnInstances - Result Aggregation", () => {
	it("should aggregate data from all successful instances", async () => {
		const instances = [
			createMockInstance("1", "SONARR", "Sonarr 1"),
			createMockInstance("2", "SONARR", "Sonarr 2"),
			createMockInstance("3", "SONARR", "Sonarr 3"),
		];

		const app = createMockApp(instances);
		const operation = vi
			.fn()
			.mockResolvedValueOnce({ count: 10 })
			.mockResolvedValueOnce({ count: 20 })
			.mockResolvedValueOnce({ count: 30 });

		const result = await executeOnInstances(app, "user-123", {}, operation);

		expect(result.aggregated).toEqual([
			{ count: 10 },
			{ count: 20 },
			{ count: 30 },
		]);
	});

	it("should include instance metadata in results", async () => {
		const instances = [createMockInstance("1", "SONARR", "Sonarr 1")];

		const app = createMockApp(instances);
		const operation = vi.fn().mockResolvedValue({ data: "test" });

		const result = await executeOnInstances(app, "user-123", {}, operation);

		expect(result.instances[0]).toEqual(
			expect.objectContaining({
				instanceId: "1",
				instanceName: "Sonarr 1",
				service: "sonarr",
				success: true,
			}),
		);
	});
});

describe("Type Guards", () => {
	it("isSonarrClient should correctly identify Sonarr clients", () => {
		const sonarr = new SonarrClient("http://test", "key");
		const radarr = new RadarrClient("http://test", "key");
		const prowlarr = new ProwlarrClient("http://test", "key");

		expect(isSonarrClient(sonarr)).toBe(true);
		expect(isSonarrClient(radarr)).toBe(false);
		expect(isSonarrClient(prowlarr)).toBe(false);
	});

	it("isRadarrClient should correctly identify Radarr clients", () => {
		const sonarr = new SonarrClient("http://test", "key");
		const radarr = new RadarrClient("http://test", "key");
		const prowlarr = new ProwlarrClient("http://test", "key");

		expect(isRadarrClient(sonarr)).toBe(false);
		expect(isRadarrClient(radarr)).toBe(true);
		expect(isRadarrClient(prowlarr)).toBe(false);
	});

	it("isProwlarrClient should correctly identify Prowlarr clients", () => {
		const sonarr = new SonarrClient("http://test", "key");
		const radarr = new RadarrClient("http://test", "key");
		const prowlarr = new ProwlarrClient("http://test", "key");

		expect(isProwlarrClient(sonarr)).toBe(false);
		expect(isProwlarrClient(radarr)).toBe(false);
		expect(isProwlarrClient(prowlarr)).toBe(true);
	});
});

describe("executeOnInstances - User Isolation", () => {
	it("should always include userId in query", async () => {
		const instances: ServiceInstance[] = [];
		const app = createMockApp(instances);
		const operation = vi.fn();

		await executeOnInstances(app, "user-456", {}, operation);

		expect(app.prisma.serviceInstance.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "user-456",
				}),
			}),
		);
	});
});

// ============================================================================
// getClientForInstance - Authentication Tests
// ============================================================================

describe("getClientForInstance - Authentication", () => {
	// Helper to create mock request
	const createMockRequest = (
		currentUser?: { id: string },
	): FastifyRequest => ({
		currentUser,
	} as unknown as FastifyRequest);

	// Helper to create mock app for getClientForInstance tests
	const createMockAppWithFindFirst = (
		instance: ServiceInstance | null,
	): FastifyInstance => ({
		prisma: {
			serviceInstance: {
				findMany: vi.fn(),
				findFirst: vi.fn().mockResolvedValue(instance),
			},
		},
		log: createMockLogger(),
		arrClientFactory: {
			create: vi.fn(() => new SonarrClient("http://test", "key")),
		},
	} as unknown as FastifyInstance);

	it("should return 401 when request.currentUser is undefined", async () => {
		const app = createMockAppWithFindFirst(null);
		const request = createMockRequest(undefined);

		const result = await getClientForInstance(app, request, "instance-123");

		expect(result).toEqual({
			success: false,
			error: "Authentication required",
			statusCode: 401,
		});
		// Should not query database if not authenticated
		expect(app.prisma.serviceInstance.findFirst).not.toHaveBeenCalled();
	});

	it("should return 401 when request.currentUser.id is undefined", async () => {
		const app = createMockAppWithFindFirst(null);
		const request = createMockRequest(undefined);

		const result = await getClientForInstance(app, request, "instance-123");

		expect(result).toEqual({
			success: false,
			error: "Authentication required",
			statusCode: 401,
		});
	});

	it("should return 404 when instance is not found", async () => {
		const app = createMockAppWithFindFirst(null);
		const request = createMockRequest({ id: "user-123" });

		const result = await getClientForInstance(app, request, "nonexistent-instance");

		expect(result).toEqual({
			success: false,
			error: "Instance not found, disabled, or access denied",
			statusCode: 404,
		});
	});

	it("should query with correct userId and enabled filter", async () => {
		const instance = createMockInstance("instance-123", "SONARR", "Test Sonarr");
		const app = createMockAppWithFindFirst(instance);
		const request = createMockRequest({ id: "user-123" });

		await getClientForInstance(app, request, "instance-123");

		expect(app.prisma.serviceInstance.findFirst).toHaveBeenCalledWith({
			where: {
				id: "instance-123",
				userId: "user-123",
				enabled: true,
			},
		});
	});

	it("should return success with client and instance when found", async () => {
		const instance = createMockInstance("instance-123", "SONARR", "Test Sonarr");
		const app = createMockAppWithFindFirst(instance);
		const request = createMockRequest({ id: "user-123" });

		const result = await getClientForInstance(app, request, "instance-123");

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.instance).toEqual(instance);
			expect(result.client).toBeInstanceOf(SonarrClient);
		}
	});

	it("should call arrClientFactory.create with instance", async () => {
		const instance = createMockInstance("instance-123", "SONARR", "Test Sonarr");
		const app = createMockAppWithFindFirst(instance);
		const request = createMockRequest({ id: "user-123" });

		await getClientForInstance(app, request, "instance-123");

		expect(app.arrClientFactory.create).toHaveBeenCalledWith(instance);
	});

	it("should enforce user isolation (return 404 for other user's instance)", async () => {
		// Even if the database returns null for the query (because userId doesn't match),
		// it should return 404, not a different error
		const app = createMockAppWithFindFirst(null);
		const request = createMockRequest({ id: "different-user" });

		const result = await getClientForInstance(app, request, "instance-123");

		expect(result).toEqual({
			success: false,
			error: "Instance not found, disabled, or access denied",
			statusCode: 404,
		});
		// Verify the query includes the user's ID
		expect(app.prisma.serviceInstance.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					userId: "different-user",
				}),
			}),
		);
	});
});
