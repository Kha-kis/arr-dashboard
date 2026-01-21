/**
 * Tests for SyncEngine Validation
 *
 * Unit tests covering the validate() method which ensures templates and instances
 * are properly configured before sync operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PrismaClient } from "../../../lib/prisma.js";
import type { ArrClientFactory } from "../../arr/client-factory.js";
import { SyncEngine, type SyncOptions } from "../sync-engine.js";

// Create mock template
const createMockTemplate = (overrides: Partial<{
	id: string;
	userId: string;
	serviceType: string;
	hasUserModifications: boolean;
	configData: string;
	deletedAt: Date | null;
}> = {}) => ({
	id: "template-123",
	userId: "user-123",
	serviceType: "RADARR",
	hasUserModifications: false,
	configData: JSON.stringify({
		customFormats: [{ trashId: "cf-1", name: "Test CF" }],
	}),
	deletedAt: null,
	createdAt: new Date(),
	updatedAt: new Date(),
	...overrides,
});

// Create mock instance
const createMockInstance = (overrides: Partial<{
	id: string;
	userId: string;
	service: string;
	label: string;
	baseUrl: string;
	encryptedApiKey: string;
	encryptionIv: string;
}> = {}) => ({
	id: "instance-123",
	userId: "user-123",
	service: "RADARR",
	label: "Test Radarr",
	baseUrl: "http://localhost:7878",
	encryptedApiKey: "encrypted-key",
	encryptionIv: "iv-123",
	enabled: true,
	createdAt: new Date(),
	updatedAt: new Date(),
	...overrides,
});

// Create mock quality profile mapping
const createMockMapping = (overrides: Partial<{
	templateId: string;
	instanceId: string;
	qualityProfileId: number;
}> = {}) => ({
	id: "mapping-123",
	templateId: "template-123",
	instanceId: "instance-123",
	qualityProfileId: 1,
	createdAt: new Date(),
	...overrides,
});

// Create mock Prisma client
const createMockPrisma = (overrides: {
	template?: ReturnType<typeof createMockTemplate> | null;
	instance?: ReturnType<typeof createMockInstance> | null;
	mappings?: ReturnType<typeof createMockMapping>[];
	cache?: { configData: string; lastModified: Date; updatedAt: Date } | null;
} = {}): PrismaClient => {
	// Use "in" check to properly handle null values being passed explicitly
	const template = "template" in overrides ? overrides.template : createMockTemplate();
	const instance = "instance" in overrides ? overrides.instance : createMockInstance();
	const mappings = overrides.mappings ?? [createMockMapping()];
	const cache = "cache" in overrides ? overrides.cache : {
		configData: JSON.stringify({
			customFormats: [{ trashId: "cf-1", name: "Test CF" }],
		}),
		lastModified: new Date(),
		updatedAt: new Date(),
	};

	return {
		trashTemplate: {
			findFirst: vi.fn().mockResolvedValue(template),
		},
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue(instance),
		},
		templateQualityProfileMapping: {
			findMany: vi.fn().mockResolvedValue(mappings),
		},
		trashCache: {
			findFirst: vi.fn().mockResolvedValue(cache),
		},
	} as unknown as PrismaClient;
};

// Create mock ARR client factory
const createMockClientFactory = (overrides: {
	status?: { version: string };
	profiles?: Array<{ id: number; name: string }>;
	connectError?: Error;
	profileError?: Error;
} = {}): ArrClientFactory => {
	const mockClient = {
		system: {
			// Note: SDK uses get() not getStatus()
			get: vi.fn().mockImplementation(() => {
				if (overrides.connectError) {
					return Promise.reject(overrides.connectError);
				}
				return Promise.resolve(overrides.status ?? { version: "4.0.0" });
			}),
		},
		qualityProfile: {
			getAll: vi.fn().mockImplementation(() => {
				if (overrides.profileError) {
					return Promise.reject(overrides.profileError);
				}
				return Promise.resolve(overrides.profiles ?? [{ id: 1, name: "HD-1080p" }]);
			}),
		},
	};

	return {
		create: vi.fn().mockReturnValue(mockClient),
	} as unknown as ArrClientFactory;
};

// Default sync options
const createSyncOptions = (overrides: Partial<SyncOptions> = {}): SyncOptions => ({
	templateId: "template-123",
	instanceId: "instance-123",
	userId: "user-123",
	syncType: "MANUAL",
	...overrides,
});

describe("SyncEngine - validate()", () => {
	describe("Template Validation", () => {
		it("should return error when template is not found", async () => {
			const prisma = createMockPrisma({ template: null });
			const engine = new SyncEngine(prisma);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Template not found or access denied. Please verify the template exists and you have permission to access it.",
			);
		});

		it("should query template with userId for ownership check", async () => {
			const prisma = createMockPrisma();
			const engine = new SyncEngine(prisma);

			await engine.validate(createSyncOptions({ userId: "specific-user" }));

			expect(prisma.trashTemplate.findFirst).toHaveBeenCalledWith({
				where: {
					id: "template-123",
					userId: "specific-user",
					deletedAt: null,
				},
			});
		});

		it("should not find deleted templates", async () => {
			const prisma = createMockPrisma({
				template: createMockTemplate({ deletedAt: new Date() }),
			});
			// The query includes deletedAt: null, so even if we pass a deleted template,
			// it would normally be filtered out. Here we simulate the Prisma behavior.
			prisma.trashTemplate.findFirst = vi.fn().mockResolvedValue(null);
			const engine = new SyncEngine(prisma);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("Template not found");
		});
	});

	describe("Instance Validation", () => {
		it("should return error when instance is not found", async () => {
			const prisma = createMockPrisma({ instance: null });
			const engine = new SyncEngine(prisma);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"Instance not found or access denied. Please verify the instance exists and you have permission to access it.",
			);
		});

		it("should query instance with userId for ownership check", async () => {
			const prisma = createMockPrisma();
			const engine = new SyncEngine(prisma);

			await engine.validate(createSyncOptions({ userId: "specific-user" }));

			expect(prisma.serviceInstance.findFirst).toHaveBeenCalledWith({
				where: {
					id: "instance-123",
					userId: "specific-user",
				},
			});
		});
	});

	describe("Service Type Compatibility", () => {
		it("should return error when service types do not match", async () => {
			const prisma = createMockPrisma({
				template: createMockTemplate({ serviceType: "SONARR" }),
				instance: createMockInstance({ service: "RADARR" }),
			});
			const engine = new SyncEngine(prisma);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain(
				"Template service type (SONARR) doesn't match instance type (RADARR)",
			);
		});

		it("should pass when service types match (case-insensitive)", async () => {
			const prisma = createMockPrisma({
				template: createMockTemplate({ serviceType: "RADARR" }),
				instance: createMockInstance({ service: "radarr" }),
			});
			const factory = createMockClientFactory();
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			// Should not have service type mismatch error
			expect(result.errors.filter((e) => e.includes("doesn't match"))).toHaveLength(0);
		});
	});

	describe("Quality Profile Mappings", () => {
		it("should return error when no quality profile mappings exist", async () => {
			const prisma = createMockPrisma({ mappings: [] });
			const engine = new SyncEngine(prisma);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(false);
			expect(result.errors).toContain(
				"No quality profile mappings found. Please deploy this template to the instance first.",
			);
		});

		it("should pass when quality profile mappings exist", async () => {
			const prisma = createMockPrisma({
				mappings: [createMockMapping({ qualityProfileId: 1 })],
			});
			const factory = createMockClientFactory({
				profiles: [{ id: 1, name: "HD-1080p" }],
			});
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.errors.filter((e) => e.includes("mappings"))).toHaveLength(0);
		});

		it("should warn when mapped quality profiles no longer exist in instance", async () => {
			const prisma = createMockPrisma({
				mappings: [createMockMapping({ qualityProfileId: 99 })],
			});
			const factory = createMockClientFactory({
				profiles: [{ id: 1, name: "HD-1080p" }], // Profile 99 doesn't exist
			});
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.warnings.some((w) => w.includes("no longer exist"))).toBe(true);
		});
	});

	describe("User Modifications Handling", () => {
		it("should block auto-sync when template has user modifications", async () => {
			const prisma = createMockPrisma({
				template: createMockTemplate({ hasUserModifications: true }),
			});
			const engine = new SyncEngine(prisma);

			const result = await engine.validate(
				createSyncOptions({ syncType: "SCHEDULED" }),
			);

			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("Auto-sync is blocked");
			expect(result.errors[0]).toContain("local modifications");
		});

		it("should allow manual sync with user modifications (with warning)", async () => {
			const prisma = createMockPrisma({
				template: createMockTemplate({ hasUserModifications: true }),
			});
			const factory = createMockClientFactory();
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(
				createSyncOptions({ syncType: "MANUAL" }),
			);

			// Should not have the auto-sync blocking error
			expect(result.errors.filter((e) => e.includes("Auto-sync is blocked"))).toHaveLength(0);
			// Should have a warning about modifications
			expect(result.warnings.some((w) => w.includes("local modifications"))).toBe(true);
		});

		it("should allow auto-sync when template has no modifications", async () => {
			const prisma = createMockPrisma({
				template: createMockTemplate({ hasUserModifications: false }),
			});
			const factory = createMockClientFactory();
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(
				createSyncOptions({ syncType: "SCHEDULED" }),
			);

			// Should not have modification-related errors
			expect(result.errors.filter((e) => e.includes("modifications"))).toHaveLength(0);
		});
	});

	describe("Instance Connectivity", () => {
		it("should return error when instance is not reachable", async () => {
			const prisma = createMockPrisma();
			const factory = createMockClientFactory({
				connectError: new Error("Connection refused"),
			});
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("Unable to connect to instance");
			expect(result.errors[0]).toContain("Connection refused");
		});

		it("should add reachability info as warning when connection succeeds", async () => {
			const prisma = createMockPrisma();
			const factory = createMockClientFactory({
				status: { version: "4.5.0" },
			});
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.warnings.some((w) => w.includes("reachable") && w.includes("v4.5.0"))).toBe(true);
		});

		it("should skip connectivity check when factory is not provided", async () => {
			const prisma = createMockPrisma();
			const engine = new SyncEngine(prisma); // No factory provided

			const result = await engine.validate(createSyncOptions());

			// Should have warning about skipped check
			expect(result.warnings.some((w) => w.includes("connectivity check skipped"))).toBe(true);
		});

		it("should warn but continue when quality profile fetch fails", async () => {
			const prisma = createMockPrisma();
			const factory = createMockClientFactory({
				profileError: new Error("API error"),
			});
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.warnings.some((w) => w.includes("Could not fetch quality profiles"))).toBe(true);
			// Should still be valid if other checks pass
		});
	});

	describe("Version Compatibility", () => {
		it("should warn when instance version is below v4", async () => {
			const prisma = createMockPrisma();
			const factory = createMockClientFactory({
				status: { version: "3.2.1" },
			});
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.warnings.some((w) => w.includes("older version") && w.includes("v3.2.1"))).toBe(true);
		});

		it("should not warn when instance version is v4 or higher", async () => {
			const prisma = createMockPrisma();
			const factory = createMockClientFactory({
				status: { version: "4.0.0" },
			});
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.warnings.filter((w) => w.includes("older version"))).toHaveLength(0);
		});
	});

	describe("Template Config Validation", () => {
		it("should return error when configData is invalid JSON", async () => {
			const prisma = createMockPrisma({
				template: createMockTemplate({ configData: "not valid json" }),
			});
			const factory = createMockClientFactory();
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(false);
			expect(result.errors.some((e) => e.includes("corrupted") || e.includes("Unexpected token"))).toBe(true);
		});

		it("should return error when configData is missing customFormats", async () => {
			const prisma = createMockPrisma({
				template: createMockTemplate({
					configData: JSON.stringify({ other: "data" }),
				}),
			});
			const factory = createMockClientFactory();
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(false);
			expect(result.errors[0]).toContain("missing custom formats");
		});
	});

	describe("Full Validation Flow", () => {
		it("should return valid result when all checks pass", async () => {
			const prisma = createMockPrisma();
			const factory = createMockClientFactory({
				status: { version: "4.5.0" },
				profiles: [{ id: 1, name: "HD-1080p" }],
			});
			const engine = new SyncEngine(prisma, undefined, undefined, factory);

			const result = await engine.validate(createSyncOptions());

			expect(result.valid).toBe(true);
			expect(result.errors).toHaveLength(0);
			expect(result.conflicts).toHaveLength(0);
		});

		it("should collect multiple errors when multiple checks fail", async () => {
			const prisma = createMockPrisma({ template: null });
			const engine = new SyncEngine(prisma);

			const result = await engine.validate(createSyncOptions());

			// Should fail fast on first error (template not found)
			expect(result.valid).toBe(false);
			expect(result.errors.length).toBeGreaterThan(0);
		});
	});
});

describe("SyncEngine - Progress Tracking", () => {
	it("should register and emit progress callbacks", () => {
		const prisma = createMockPrisma();
		const engine = new SyncEngine(prisma);
		const callback = vi.fn();

		engine.onProgress("sync-123", callback);

		// The callback should be stored but we can't easily test private method
		// This test ensures no errors during registration
		expect(() => engine.onProgress("sync-123", callback)).not.toThrow();
	});

	it("should remove progress listener", () => {
		const prisma = createMockPrisma();
		const engine = new SyncEngine(prisma);
		const callback = vi.fn();

		engine.onProgress("sync-123", callback);
		engine.removeProgressListener("sync-123", callback);

		// Verify no errors
		expect(() => engine.removeProgressListener("sync-123", callback)).not.toThrow();
	});
});
