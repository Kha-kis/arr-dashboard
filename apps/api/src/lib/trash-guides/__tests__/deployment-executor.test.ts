/**
 * Unit tests for DeploymentExecutorService
 *
 * Tests extractTrashId function and ID-based vs name-based matching behavior
 */

import type { SonarrClient } from "arr-sdk";
import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "../../errors.js";
import { extractTrashId } from "../cf-field-utils.js";
import { DeploymentExecutorService } from "../deployment-executor.js";

// SDK CustomFormat type alias
type SdkCustomFormat = Awaited<ReturnType<SonarrClient["customFormat"]["getAll"]>>[number];

// SDK Specification type - extract from SdkCustomFormat
type SdkSpecification = NonNullable<SdkCustomFormat["specifications"]>[number];

// Helper to create a specification with array-format fields (SDK format)
const createSpecWithArrayFields = (
	name: string,
	fields: Array<{ name: string; value: unknown }>,
): SdkSpecification => ({
	name,
	implementation: "test",
	negate: false,
	required: false,
	fields: fields as SdkSpecification["fields"],
});

// Helper to create a specification with object-format fields (TRaSH format, cast for testing)
const createSpecWithObjectFields = (
	name: string,
	fields: Record<string, unknown>,
): SdkSpecification => ({
	name,
	implementation: "test",
	negate: false,
	required: false,
	// Cast object format to array format type - runtime code handles both
	fields: fields as unknown as SdkSpecification["fields"],
});

describe("extractTrashId", () => {
	it("should extract trash_id from array format fields", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				createSpecWithArrayFields("test", [
					{ name: "trash_id", value: "test-uuid-123" },
					{ name: "other_field", value: "other_value" },
				]),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBe("test-uuid-123");
	});

	it("should extract trash_id from object format fields", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				createSpecWithObjectFields("test", {
					trash_id: "test-uuid-456",
					other_field: "other_value",
				}),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBe("test-uuid-456");
	});

	it("should return null when no trash_id is found", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF Without Trash ID",
			specifications: [
				createSpecWithArrayFields("test", [{ name: "other_field", value: "other_value" }]),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should return null when specifications are empty", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should return null when specifications are undefined", () => {
		// Create object with undefined specifications via type assertion
		const cf = {
			id: 1,
			name: "Test CF",
			specifications: undefined,
		} as unknown as SdkCustomFormat;

		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should return null when no specifications have fields", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				{
					name: "test1",
					implementation: "test",
					negate: false,
					required: false,
					fields: undefined,
				} as SdkSpecification,
				{
					name: "test2",
					implementation: "test",
					negate: false,
					required: false,
					fields: null as unknown as SdkSpecification["fields"],
				} as SdkSpecification,
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBeNull();
	});

	it("should handle multiple specifications and return first found trash_id", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [
				createSpecWithArrayFields("test1", [{ name: "other_field", value: "value" }]),
				createSpecWithArrayFields("test2", [{ name: "trash_id", value: "first-uuid" }]),
				createSpecWithArrayFields("test3", [{ name: "trash_id", value: "second-uuid" }]),
			],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBe("first-uuid");
	});

	it("should convert trash_id value to string", () => {
		const cf: SdkCustomFormat = {
			id: 1,
			name: "Test CF",
			specifications: [createSpecWithArrayFields("test", [{ name: "trash_id", value: 12345 }])],
		};

		const trashId = extractTrashId(cf);
		expect(trashId).toBe("12345");
		expect(typeof trashId).toBe("string");
	});

	it("should distinguish between ID-based and name-based matching by returning null", () => {
		// CF without trash_id should return null, allowing explicit name-based matching
		const cfWithoutId: SdkCustomFormat = {
			id: 1,
			name: "My Custom Format",
			specifications: [createSpecWithArrayFields("test", [{ name: "some_field", value: "value" }])],
		};

		const trashId = extractTrashId(cfWithoutId);
		expect(trashId).toBeNull();

		// This null return allows callers to:
		// 1. Skip ID-based matching (existingCFMap.get(null) returns undefined)
		// 2. Explicitly use name-based matching (existingCFByName.get(cf.name))
		// This keeps ID-based and name-based matching distinct
	});
});

describe("DeploymentExecutorService - Custom Format drift", () => {
	const deployCustomFormats = (
		executor: DeploymentExecutorService,
		client: unknown,
		existing: SdkCustomFormat,
	) =>
		(
			executor as unknown as {
				deployCustomFormats: (
					client: unknown,
					templateCFs: unknown[],
					byTrashId: Map<string, SdkCustomFormat>,
					byName: Map<string, SdkCustomFormat>,
					resolutions: undefined,
				) => Promise<unknown>;
			}
		).deployCustomFormats(
			client,
			[
				{
					trashId: "cf-1",
					name: "Test CF",
					originalConfig: { specifications: [] },
				},
			],
			new Map([["cf-1", existing]]),
			new Map([["Test CF", existing]]),
			undefined,
		);

	it("aborts instead of overwriting an existing format changed after preview", async () => {
		const existing = { id: 1, name: "Test CF", specifications: [] } as SdkCustomFormat;
		const update = vi.fn();
		const client = {
			customFormat: {
				getById: vi.fn().mockResolvedValue({
					...existing,
					includeCustomFormatWhenRenaming: true,
				}),
				update,
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);

		await expect(deployCustomFormats(executor, client, existing)).rejects.toThrow(
			"changed during deployment",
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("aborts instead of creating a duplicate format that appeared after preview", async () => {
		const create = vi.fn();
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 9, name: "Test CF", specifications: [] }]),
				create,
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const missing = { name: "Other CF", specifications: [] } as SdkCustomFormat;

		await expect(deployCustomFormats(executor, client, missing)).rejects.toThrow(
			"appeared during deployment",
		);
		expect(create).not.toHaveBeenCalled();
	});

	it("attaches earlier successful writes when a later format drifts", async () => {
		const create = vi.fn().mockResolvedValue({ id: 1 });
		const client = {
			customFormat: {
				getAll: vi
					.fn()
					.mockResolvedValueOnce([])
					.mockResolvedValueOnce([{ id: 9, name: "Second CF", specifications: [] }]),
				getById: vi.fn().mockResolvedValue({ id: 1, name: "First CF", specifications: [] }),
				create,
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const run = (
			executor as unknown as {
				deployCustomFormats: (...args: unknown[]) => Promise<unknown>;
			}
		).deployCustomFormats.bind(executor);

		let conflict: unknown;
		try {
			await run(
				client,
				[
					{ trashId: "cf-1", name: "First CF", originalConfig: { specifications: [] } },
					{ trashId: "cf-2", name: "Second CF", originalConfig: { specifications: [] } },
				],
				new Map(),
				new Map(),
				undefined,
			);
		} catch (error) {
			conflict = error;
		}

		expect(conflict).toBeInstanceOf(ConflictError);
		expect(conflict).toMatchObject({
			partialDeployment: {
				created: 1,
				updated: 0,
				skipped: 0,
				details: { created: ["First CF"], updated: [], failed: [] },
			},
		});
		expect(create).toHaveBeenCalledTimes(1);
	});
});

describe("DeploymentExecutorService - backup parity", () => {
	it("backs up naming state with Custom Formats and the quality profile", async () => {
		const createBackup = vi.fn().mockResolvedValue({ id: "backup-1" });
		const prisma = {
			trashSettings: { findUnique: vi.fn().mockResolvedValue({ backupRetentionDays: 30 }) },
			$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					trashBackup: { create: createBackup },
					trashSyncHistory: { create: vi.fn().mockResolvedValue({ id: "history-1" }) },
				}),
			),
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const createBackupAndHistory = (
			executor as unknown as {
				createBackupAndHistory: (
					instance: {
						id: string;
						service: string;
						baseUrl: string;
						encryptedApiKey: string;
						encryptionIv: string;
					},
					userId: string,
					customFormats: unknown[],
					templateId: string,
					qualityProfile: unknown,
					namingConfig: {
						currentConfig: Record<string, unknown>;
						mergedConfig: Record<string, unknown>;
						changedFields: string[];
					},
				) => Promise<unknown>;
			}
		).createBackupAndHistory.bind(executor);
		const namingConfig = { id: 1, standardMovieFormat: "Original" };

		await createBackupAndHistory(
			{
				id: "instance-1",
				service: "RADARR",
				baseUrl: "http://radarr:7878",
				encryptedApiKey: "encrypted-key",
				encryptionIv: "iv",
			},
			"user-1",
			[{ id: 5, name: "CF" }],
			"template-1",
			{ id: 3, name: "Any" },
			{
				currentConfig: namingConfig,
				mergedConfig: { ...namingConfig, standardMovieFormat: "Deployed" },
				changedFields: ["standardMovieFormat"],
			},
		);

		const backupData = JSON.parse(createBackup.mock.calls[0]![0].data.backupData);
		expect(backupData).toMatchObject({
			endpointKey: "user-1:RADARR:http://radarr:7878/",
			connectionStateToken: expect.any(String),
			customFormats: [{ id: 5, name: "CF" }],
			customFormatDeployments: [],
			qualityProfileDeployment: {
				beforeProfile: { id: 3, name: "Any" },
				status: "not_started",
				action: "updated",
				profileId: 3,
				postStateToken: null,
			},
			namingDeployment: {
				beforeConfig: namingConfig,
				status: "not_started",
				postStateToken: null,
			},
		});
	});

	it("persists pending and exact post-write Custom Format state around PUT", async () => {
		const before = { id: 1, name: "Test CF", specifications: [] } as SdkCustomFormat;
		const after = {
			...before,
			specifications: [{ name: "Updated", implementation: "ReleaseTitleSpecification" }],
		};
		const update = vi.fn().mockResolvedValue(after);
		const persisted: Array<{ state: Record<string, unknown>; append: boolean }> = [];
		const persist = vi.fn(async (state: Record<string, unknown>, append: boolean) => {
			persisted.push({ state: structuredClone(state), append });
		});
		const client = {
			customFormat: {
				getById: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
				update,
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const run = (
			executor as unknown as {
				deployCustomFormats: (...args: unknown[]) => Promise<unknown>;
			}
		).deployCustomFormats.bind(executor);

		await run(
			client,
			[
				{
					trashId: "cf-1",
					name: "Test CF",
					originalConfig: { specifications: after.specifications },
				},
			],
			new Map([["cf-1", before]]),
			new Map([["Test CF", before]]),
			undefined,
			persist,
		);

		expect(persisted[0]).toMatchObject({
			append: true,
			state: { status: "pending", resourceId: 1, action: "updated" },
		});
		expect(persisted[1]).toMatchObject({
			append: false,
			state: {
				status: "applied",
				resourceId: 1,
				postStateToken: expect.any(String),
			},
		});
		expect(persist.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
	});

	it("stops later writes when a Custom Format mutation cannot be verified", async () => {
		const first = { id: 1, name: "First CF", specifications: [] } as SdkCustomFormat;
		const second = { id: 2, name: "Second CF", specifications: [] } as SdkCustomFormat;
		const update = vi.fn().mockResolvedValue(undefined);
		const getById = vi
			.fn()
			.mockResolvedValueOnce(first)
			.mockRejectedValueOnce(new Error("post-write read timed out"));
		const client = { customFormat: { getById, update } };
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const run = (
			executor as unknown as {
				deployCustomFormats: (...args: unknown[]) => Promise<unknown>;
			}
		).deployCustomFormats.bind(executor);

		await expect(
			run(
				client,
				[
					{ trashId: "cf-1", name: "First CF", originalConfig: { specifications: [] } },
					{ trashId: "cf-2", name: "Second CF", originalConfig: { specifications: [] } },
				],
				new Map([
					["cf-1", first],
					["cf-2", second],
				]),
				new Map([
					["First CF", first],
					["Second CF", second],
				]),
				undefined,
				vi.fn().mockResolvedValue(undefined),
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("post-write state could not be verified"),
			partialDeployment: {
				created: 0,
				updated: 0,
				skipped: 0,
			},
		});
		expect(update).toHaveBeenCalledTimes(1);
		expect(getById).toHaveBeenCalledTimes(2);
	});
});

describe("DeploymentExecutorService - naming deployment state", () => {
	it("does not PUT naming until pending rollback metadata is durable", async () => {
		const beforeConfig = { id: 1, standardMovieFormat: "Original" };
		const rawRequest = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue(beforeConfig),
		});
		const executor = new DeploymentExecutorService({} as never, { rawRequest } as never);
		const deployNamingPresets = (
			executor as unknown as {
				deployNamingPresets: (...args: unknown[]) => Promise<unknown>;
			}
		).deployNamingPresets.bind(executor);

		await expect(
			deployNamingPresets(
				{
					currentConfig: beforeConfig,
					mergedConfig: { ...beforeConfig, standardMovieFormat: "Deployed" },
					changedFields: ["standardMovieFormat"],
				},
				{ id: "instance-1", service: "RADARR" },
				vi.fn().mockRejectedValue(new Error("database unavailable")),
			),
		).resolves.toMatchObject({
			fieldsApplied: 0,
			error: expect.stringContaining("database unavailable"),
		});
		expect(rawRequest).toHaveBeenCalledTimes(1);
	});

	it("captures the actual post-write state used to authorize rollback", async () => {
		const beforeConfig = { id: 1, standardMovieFormat: "Original" };
		const deployedConfig = { id: 1, standardMovieFormat: "Deployed", extra: "normalized" };
		const rawRequest = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(beforeConfig),
			})
			.mockResolvedValueOnce({ ok: true, status: 202 })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(deployedConfig),
			});
		const executor = new DeploymentExecutorService({} as never, { rawRequest } as never);
		const deployNamingPresets = (
			executor as unknown as {
				deployNamingPresets: (...args: unknown[]) => Promise<unknown>;
			}
		).deployNamingPresets.bind(executor);

		await expect(
			deployNamingPresets(
				{
					currentConfig: beforeConfig,
					mergedConfig: { ...beforeConfig, standardMovieFormat: "Deployed" },
					changedFields: ["standardMovieFormat"],
				},
				{ id: "instance-1", service: "RADARR" },
			),
		).resolves.toMatchObject({
			fieldsApplied: 1,
			postStateToken: expect.any(String),
		});
		expect(rawRequest).toHaveBeenCalledTimes(3);
	});
});

describe("DeploymentExecutorService - saved override concurrency", () => {
	it("applies a changed template score when the current score is the previously managed value", async () => {
		const profile = { id: 1, name: "Any", formatItems: [{ format: 42, score: 10 }] };
		const postWriteProfile = { ...profile, formatItems: [{ format: 42, score: 20 }] };
		const update = vi.fn().mockResolvedValue(postWriteProfile);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 42, name: "Managed CF" }]),
			},
			qualityProfile: {
				getById: vi
					.fn()
					.mockResolvedValueOnce(profile)
					.mockResolvedValueOnce(profile)
					.mockResolvedValueOnce(postWriteProfile),
				update,
			},
		};
		const prisma = {
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: {
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
				upsert: vi.fn().mockResolvedValue({}),
			},
			$transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			}
		).syncQualityProfile.bind(executor);
		const binding = {
			instanceId: "instance-1",
			connectionGeneration: 1,
			connectionStateToken: "connection-token",
		};

		await expect(
			syncQualityProfile(
				client,
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "managed-trash-id",
						name: "Managed CF",
						scoreOverride: undefined,
						originalConfig: { trash_scores: { default: 20 } },
					},
				],
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				"Any",
				profile,
				undefined,
				[],
				new Map(),
				["instance-1"],
				undefined,
				undefined,
				[binding],
				[binding],
				[
					{
						trashId: "managed-trash-id",
						name: "Managed CF",
						resourceId: 42,
						stateToken: "format-token",
						profileId: 1,
						appliedScore: 10,
					},
				],
			),
		).resolves.toMatchObject({ errors: [] });

		expect(update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ formatItems: [{ format: 42, score: 20 }] }),
		);
	});

	it("honors use_template when the current score drifted after deployment", async () => {
		const profile = { id: 1, name: "Any", formatItems: [{ format: 42, score: 10 }] };
		const postWriteProfile = { ...profile, formatItems: [{ format: 42, score: 20 }] };
		const update = vi.fn().mockResolvedValue(postWriteProfile);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 42, name: "Managed CF" }]),
			},
			qualityProfile: {
				getById: vi
					.fn()
					.mockResolvedValueOnce(profile)
					.mockResolvedValueOnce(profile)
					.mockResolvedValueOnce(postWriteProfile),
				update,
			},
		};
		const prisma = {
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: {
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
				upsert: vi.fn().mockResolvedValue({}),
			},
			$transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			}
		).syncQualityProfile.bind(executor);
		const binding = {
			instanceId: "instance-1",
			connectionGeneration: 1,
			connectionStateToken: "connection-token",
		};

		await expect(
			syncQualityProfile(
				client,
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "managed-trash-id",
						name: "Managed CF",
						scoreOverride: undefined,
						originalConfig: { trash_scores: { default: 20 } },
					},
				],
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				{ "managed-trash-id": "use_template" },
				"Any",
				profile,
				undefined,
				[],
				new Map(),
				["instance-1"],
				undefined,
				undefined,
				[binding],
				[binding],
				[
					{
						trashId: "managed-trash-id",
						name: "Managed CF",
						resourceId: 42,
						stateToken: "format-token",
						profileId: 1,
						appliedScore: 5,
					},
				],
			),
		).resolves.toMatchObject({ errors: [] });

		expect(update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ formatItems: [{ format: 42, score: 20 }] }),
		);
	});

	it("blocks profile creation when the reviewed name appears before POST", async () => {
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([{ id: 9, name: "Any", formatItems: [] }]),
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			}
		).syncQualityProfile.bind(executor);

		await expect(
			syncQualityProfile(
				client,
				{},
				[],
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				"Any",
				undefined,
				undefined,
				[],
				new Map(),
				["instance-1"],
			),
		).rejects.toThrow("appeared during deployment");
	});

	it("records the exact post-write quality-profile state", async () => {
		const profile = { id: 1, name: "Any", formatItems: [] };
		const postWriteProfile = { ...profile, formatItems: [{ format: 42, score: 100 }] };
		const getById = vi
			.fn()
			.mockResolvedValueOnce(profile)
			.mockResolvedValueOnce(profile)
			.mockResolvedValueOnce(postWriteProfile);
		const update = vi.fn().mockResolvedValue(postWriteProfile);
		const persistProfileState = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: { getAll: vi.fn().mockResolvedValue([]) },
			qualityProfile: {
				getById,
				update,
			},
		};
		const prisma = {
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: {
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
				upsert: vi.fn().mockResolvedValue({}),
			},
			$transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			}
		).syncQualityProfile.bind(executor);

		await expect(
			syncQualityProfile(
				client,
				{},
				[],
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				"Any",
				profile,
				undefined,
				[],
				new Map(),
				["instance-1"],
				undefined,
				persistProfileState,
			),
		).resolves.toMatchObject({
			errors: [],
			mutation: {
				action: "updated",
				profileId: 1,
				profileName: "Any",
				postStateToken: expect.any(String),
			},
		});
		expect(getById).toHaveBeenCalledTimes(3);
		expect(persistProfileState).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ status: "pending", action: "updated", profileId: 1 }),
		);
		expect(persistProfileState).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				status: "pending",
				action: "updated",
				profileId: 1,
				postStateToken: expect.any(String),
			}),
		);
		expect(persistProfileState.mock.invocationCallOrder[0]).toBeLessThan(
			update.mock.invocationCallOrder[0]!,
		);
		expect(prisma.templateQualityProfileMapping.deleteMany).toHaveBeenCalledWith({
			where: {
				templateId: "template-1",
				instanceId: { in: ["instance-1"] },
				qualityProfileId: { not: 1 },
			},
		});
	});

	it("removes a stale recovered mapping from an equivalent service record", async () => {
		const profile = { id: 2, name: "Any", formatItems: [] };
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const upsert = vi.fn().mockResolvedValue({});
		const transaction = vi.fn(async (operations: Array<Promise<unknown>>) =>
			Promise.all(operations),
		);
		const client = {
			customFormat: { getAll: vi.fn().mockResolvedValue([]) },
			qualityProfile: {
				getById: vi.fn().mockResolvedValue(profile),
				update: vi.fn().mockResolvedValue(profile),
			},
		};
		const prisma = {
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: {
				deleteMany,
				upsert,
			},
			$transaction: transaction,
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			}
		).syncQualityProfile.bind(executor);

		await expect(
			syncQualityProfile(
				client,
				{},
				[],
				"template-1",
				"instance-alias",
				"user-1",
				undefined,
				undefined,
				"Any",
				profile,
				undefined,
				[],
				new Map(),
				["instance-primary", "instance-alias"],
			),
		).resolves.toMatchObject({ errors: [] });

		expect(deleteMany).toHaveBeenCalledWith({
			where: {
				templateId: "template-1",
				instanceId: { in: ["instance-primary", "instance-alias"] },
				qualityProfileId: { not: 2 },
			},
		});
		expect(transaction).toHaveBeenCalledOnce();
		expect(upsert).toHaveBeenCalledOnce();
	});

	it("resets an orphaned managed score to zero and retires its saved override", async () => {
		const profile = { id: 1, name: "Any", formatItems: [{ format: 42, score: -10_000 }] };
		const postWriteProfile = { ...profile, formatItems: [{ format: 42, score: 0 }] };
		const update = vi.fn().mockResolvedValue(postWriteProfile);
		const deleteManyOverrides = vi.fn().mockResolvedValue({ count: 1 });
		const client = {
			customFormat: { getAll: vi.fn().mockResolvedValue([]) },
			qualityProfile: {
				getById: vi
					.fn()
					.mockResolvedValueOnce(profile)
					.mockResolvedValueOnce(profile)
					.mockResolvedValueOnce(postWriteProfile),
				update,
			},
		};
		const prisma = {
			instanceQualityProfileOverride: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ customFormatId: 42, score: -10_000, instanceId: "instance-1" }]),
				deleteMany: deleteManyOverrides,
			},
			templateQualityProfileMapping: {
				deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
				upsert: vi.fn().mockResolvedValue({}),
			},
			$transaction: vi.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			}
		).syncQualityProfile.bind(executor);

		await expect(
			syncQualityProfile(
				client,
				{},
				[],
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				"Any",
				profile,
				undefined,
				[{ trashId: "removed", name: "Removed CF", resourceId: 42 }],
				new Map([[42, -10_000]]),
				["instance-1"],
			),
		).resolves.toMatchObject({ errors: [], orphanedCFs: ["Removed CF"] });

		expect(update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ formatItems: [{ format: 42, score: 0 }] }),
		);
		expect(deleteManyOverrides).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				qualityProfileId: 1,
				customFormatId: { in: [42] },
				OR: [{ instanceId: "instance-1", connectionGeneration: 0, connectionStateToken: "" }],
			},
		});
	});

	it("blocks a scheduled profile PUT when saved overrides change during execution", async () => {
		const profile = { id: 1, name: "Any", formatItems: [{ format: 42, score: -10_000 }] };
		const update = vi.fn();
		const client = {
			customFormat: { getAll: vi.fn().mockResolvedValue([]) },
			qualityProfile: {
				getById: vi.fn().mockResolvedValue(profile),
				update,
			},
		};
		const prisma = {
			instanceQualityProfileOverride: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ customFormatId: 42, score: 0, instanceId: "instance-1" }]),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			}
		).syncQualityProfile.bind(executor);

		await expect(
			syncQualityProfile(
				client,
				{},
				[],
				"template-1",
				"instance-1",
				"user-1",
				undefined,
				undefined,
				"Any",
				profile,
				undefined,
				[],
				new Map([[42, -10_000]]),
				["instance-1"],
			),
		).rejects.toThrow("saved score overrides changed during deployment");
		expect(update).not.toHaveBeenCalled();
	});
});

// ============================================================================
// TRaSH Guides PR #2590 - Quality Format Reversal Tests
// ============================================================================

/**
 * Feature flag for TRaSH Guides quality format change.
 * This mirrors the production flag in deployment-executor.ts.
 *
 * Current state: false (TRaSH Guides uses OLD format - high quality first)
 * After PR #2590 merges: Change to true (TRaSH will use NEW format - low quality first)
 *
 * See: https://github.com/TRaSH-Guides/Guides/pull/2590
 * See: https://github.com/Kha-kis/arr-dashboard/issues/85
 */
const TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED = true;

/**
 * Test implementation of reverseQualityItemsIfNeeded.
 * Mirrors the production logic for verification.
 */
const reverseQualityItemsIfNeeded = <T>(items: T[]): T[] => {
	if (!items || items.length === 0) return items;
	if (TRASH_GUIDES_NEW_QUALITY_FORMAT_MERGED) {
		return [...items].reverse();
	}
	return items;
};

describe("Quality Format Reversal (TRaSH Guides PR #2590)", () => {
	describe("reverseQualityItemsIfNeeded", () => {
		// TRaSH Guides PR #2590 has been merged.
		// Quality items are now in human-readable order (low→high) in TRaSH JSON.
		// We reverse them before sending to Sonarr/Radarr API (which expects high→low).

		it("should reverse items for API compatibility (PR #2590 merged)", () => {
			// TRaSH NEW format: low→high (Unknown → Remux)
			const items = [{ name: "Unknown" }, { name: "DVD" }, { name: "Remux" }];
			const result = reverseQualityItemsIfNeeded(items);

			// Reversed for API: high→low (Remux → Unknown)
			expect(result).not.toBe(items);
			expect(result).toEqual([{ name: "Remux" }, { name: "DVD" }, { name: "Unknown" }]);
		});

		it("should reverse items and create a new array", () => {
			const newFormatItems = [{ name: "Unknown" }, { name: "DVD" }, { name: "Remux" }];
			const result = reverseQualityItemsIfNeeded(newFormatItems);

			expect(result).toEqual([{ name: "Remux" }, { name: "DVD" }, { name: "Unknown" }]);
			// New array created, original untouched
			expect(result).not.toBe(newFormatItems);
		});

		it("should handle empty arrays", () => {
			const result = reverseQualityItemsIfNeeded([]);
			expect(result).toEqual([]);
		});

		it("should handle undefined/null gracefully", () => {
			expect(reverseQualityItemsIfNeeded(null as unknown as any[])).toBe(null);
			expect(reverseQualityItemsIfNeeded(undefined as unknown as any[])).toBe(undefined);
		});

		it("should preserve item properties after reversing", () => {
			const items = [
				{ name: "Unknown", allowed: false, id: 1 },
				{ name: "DVD", allowed: true, id: 2 },
				{ name: "Remux", allowed: true, id: 3 },
			];
			const result = reverseQualityItemsIfNeeded(items);

			// New array, reversed
			expect(result).not.toBe(items);
			// All properties intact, order reversed
			expect(result[0]).toEqual({ name: "Remux", allowed: true, id: 3 });
			expect(result[2]).toEqual({ name: "Unknown", allowed: false, id: 1 });
		});
	});
});

describe("DeploymentExecutorService - ID-based vs name-based matching", () => {
	it("should demonstrate that null return enables explicit name-based matching", () => {
		// This test documents the expected behavior:
		// When extractTrashId returns null, callers should:
		// 1. NOT add the CF to existingCFMap (ID-based map)
		// 2. Still add the CF to existingCFByName (name-based map)
		// 3. Use name-based lookup when ID lookup fails

		const existingCFMap = new Map<string, SdkCustomFormat>();
		const existingCFByName = new Map<string, SdkCustomFormat>();

		// CF with trash_id - should be in both maps
		const cfWithId: SdkCustomFormat = {
			id: 1,
			name: "CF With ID",
			specifications: [
				createSpecWithArrayFields("test", [{ name: "trash_id", value: "uuid-123" }]),
			],
		};

		// CF without trash_id - should only be in name map
		const cfWithoutId: SdkCustomFormat = {
			id: 2,
			name: "CF Without ID",
			specifications: [
				createSpecWithArrayFields("test", [{ name: "other_field", value: "value" }]),
			],
		};

		// Simulate the mapping logic from deploySingleInstance
		const mockExtractTrashId = (cf: SdkCustomFormat): string | null => {
			for (const spec of cf.specifications || []) {
				if (spec.fields && Array.isArray(spec.fields)) {
					const trashIdField = spec.fields.find((f) => f.name === "trash_id");
					if (trashIdField) {
						return String(trashIdField.value);
					}
				}
			}
			return null;
		};

		// Process CF with ID
		const trashId1 = mockExtractTrashId(cfWithId);
		if (trashId1) {
			existingCFMap.set(trashId1, cfWithId);
		}
		existingCFByName.set(cfWithId.name!, cfWithId);

		// Process CF without ID
		const trashId2 = mockExtractTrashId(cfWithoutId);
		if (trashId2) {
			existingCFMap.set(trashId2, cfWithoutId);
		}
		existingCFByName.set(cfWithoutId.name!, cfWithoutId);

		// Verify ID-based matching works for CF with ID
		expect(existingCFMap.get("uuid-123")).toBe(cfWithId);
		expect(existingCFMap.has("uuid-123")).toBe(true);

		// Verify ID-based matching does NOT work for CF without ID
		expect(existingCFMap.get("CF Without ID")).toBeUndefined();
		expect(existingCFMap.has("CF Without ID")).toBe(false);

		// Verify name-based matching works for both
		expect(existingCFByName.get("CF With ID")).toBe(cfWithId);
		expect(existingCFByName.get("CF Without ID")).toBe(cfWithoutId);

		// Simulate the lookup logic from deployCustomFormats
		const templateCFWithId = { trashId: "uuid-123", name: "CF With ID" };
		const templateCFWithoutId = { trashId: null, name: "CF Without ID" };

		// ID-based lookup for CF with ID
		let existingCF = existingCFMap.get(templateCFWithId.trashId);
		expect(existingCF).toBe(cfWithId);

		// ID-based lookup for CF without ID should fail, then fall back to name
		existingCF = existingCFMap.get(templateCFWithoutId.trashId || "");
		expect(existingCF).toBeUndefined();
		existingCF = existingCFByName.get(templateCFWithoutId.name);
		expect(existingCF).toBe(cfWithoutId);
	});
});

describe("DeploymentExecutorService - preview state authorization", () => {
	it("fails before backup or upstream mutation when the preview token is stale", async () => {
		const customFormatUpdate = vi.fn();
		const customFormatCreate = vi.fn();
		const qualityProfileUpdate = vi.fn();
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({
					id: "template-1",
					name: "Radarr - Any",
					serviceType: "RADARR",
					configData: '{"customFormats":[]}',
					instanceOverrides: null,
					sourceQualityProfileName: "Any",
				}),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					id: "instance-1",
					label: "Radarr",
					service: "RADARR",
					baseUrl: "http://radarr",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
				}),
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "instance-1", service: "RADARR", baseUrl: "http://radarr" }]),
			},
			templateQualityProfileMapping: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
			trashSettings: { findUnique: vi.fn() },
			$transaction: vi.fn(),
		};
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
			customFormat: {
				getAll: vi.fn().mockResolvedValue([]),
				update: customFormatUpdate,
				create: customFormatCreate,
			},
			qualityProfile: {
				getAll: vi
					.fn()
					.mockResolvedValue([{ id: 1, name: "Any", formatItems: [{ format: 42, score: 0 }] }]),
				getById: vi
					.fn()
					.mockResolvedValue({ id: 1, name: "Any", formatItems: [{ format: 42, score: 0 }] }),
				update: qualityProfileUpdate,
			},
		};
		const executor = new DeploymentExecutorService(
			prisma as never,
			{
				create: vi.fn(() => client),
			} as never,
		);

		await expect(
			executor.deploySingleInstance(
				"template-1",
				"instance-1",
				"user-1",
				"notify",
				undefined,
				"stale-preview-token",
			),
		).rejects.toThrow(
			"The template or instance changed after this preview. Refresh the preview and review the deployment again.",
		);
		expect(prisma.trashSettings.findUnique).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(customFormatUpdate).not.toHaveBeenCalled();
		expect(customFormatCreate).not.toHaveBeenCalled();
		expect(qualityProfileUpdate).not.toHaveBeenCalled();
	});

	it("rejects ownership held through a duplicate record of the same ARR endpoint", async () => {
		const customFormatUpdate = vi.fn();
		const qualityProfileUpdate = vi.fn();
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({
					id: "template-1",
					name: "Radarr - Any",
					serviceType: "RADARR",
					configData: '{"customFormats":[]}',
					instanceOverrides: null,
					sourceQualityProfileName: "Any",
				}),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					id: "instance-1",
					label: "Radarr",
					service: "RADARR",
					baseUrl: "http://radarr/",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
				}),
				findMany: vi.fn().mockResolvedValue([
					{
						id: "instance-1",
						service: "RADARR",
						baseUrl: "http://radarr/",
						encryptedApiKey: "encrypted",
						encryptionIv: "iv",
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
						connectionGeneration: 0,
					},
					{
						id: "instance-alias",
						service: "RADARR",
						baseUrl: "http://radarr",
						encryptedApiKey: "encrypted",
						encryptionIv: "iv",
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
						connectionGeneration: 0,
					},
				]),
			},
			templateQualityProfileMapping: {
				findMany: vi.fn().mockResolvedValue([
					{
						templateId: "template-2",
						instanceId: "instance-alias",
						qualityProfileId: 1,
						qualityProfileName: "Any",
					},
				]),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSettings: { findUnique: vi.fn() },
			$transaction: vi.fn(),
		};
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
			customFormat: {
				getAll: vi.fn().mockResolvedValue([]),
				update: customFormatUpdate,
			},
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([{ id: 1, name: "Any", formatItems: [] }]),
				getById: vi.fn().mockResolvedValue({ id: 1, name: "Any", formatItems: [] }),
				update: qualityProfileUpdate,
			},
		};
		const executor = new DeploymentExecutorService(
			prisma as never,
			{ create: vi.fn(() => client) } as never,
		);

		await expect(
			executor.deploySingleInstanceFromAutomation("template-1", "instance-1", "user-1"),
		).rejects.toThrow("already managed by another template");
		expect(prisma.templateQualityProfileMapping.findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: expect.arrayContaining([
						expect.objectContaining({ instanceId: "instance-1" }),
						expect.objectContaining({ instanceId: "instance-alias" }),
					]),
				},
			}),
		);
		expect(prisma.trashSettings.findUnique).not.toHaveBeenCalled();
		expect(prisma.$transaction).not.toHaveBeenCalled();
		expect(customFormatUpdate).not.toHaveBeenCalled();
		expect(qualityProfileUpdate).not.toHaveBeenCalled();
	});

	it("fails before mutation when equivalent instance records have conflicting saved scores", async () => {
		const customFormatUpdate = vi.fn();
		const qualityProfileUpdate = vi.fn();
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({
					id: "template-1",
					name: "Radarr - Any",
					serviceType: "RADARR",
					configData: '{"customFormats":[]}',
					instanceOverrides: null,
					sourceQualityProfileName: "Any",
				}),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					id: "instance-1",
					label: "Radarr",
					service: "RADARR",
					baseUrl: "http://radarr/",
					encryptedApiKey: "encrypted",
					encryptionIv: "iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
				}),
				findMany: vi.fn().mockResolvedValue([
					{
						id: "instance-1",
						service: "RADARR",
						baseUrl: "http://radarr/",
						encryptedApiKey: "encrypted",
						encryptionIv: "iv",
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
						connectionGeneration: 0,
					},
					{
						id: "instance-alias",
						service: "radarr",
						baseUrl: "HTTP://RADARR:80",
						encryptedApiKey: "encrypted",
						encryptionIv: "iv",
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
						connectionGeneration: 0,
					},
				]),
			},
			templateQualityProfileMapping: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockImplementation(({ where }) =>
					where.status?.in
						? Promise.resolve([])
						: Promise.resolve([
								{ instanceId: "instance-1", customFormatId: 42, score: -10_000 },
								{ instanceId: "instance-alias", customFormatId: 42, score: 0 },
							]),
				),
			},
			trashSettings: { findUnique: vi.fn() },
		};
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
			customFormat: {
				getAll: vi.fn().mockResolvedValue([]),
				update: customFormatUpdate,
			},
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([{ id: 1, name: "Any", formatItems: [] }]),
				getById: vi.fn().mockResolvedValue({ id: 1, name: "Any", formatItems: [] }),
				update: qualityProfileUpdate,
			},
		};
		const executor = new DeploymentExecutorService(
			prisma as never,
			{ create: vi.fn(() => client) } as never,
		);

		await expect(
			executor.deploySingleInstanceFromAutomation("template-1", "instance-1", "user-1"),
		).rejects.toThrow("conflicting saved Custom Format score overrides");
		expect(prisma.instanceQualityProfileOverride.findMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				status: "APPLIED",
				qualityProfileId: 1,
				OR: expect.arrayContaining([
					expect.objectContaining({ instanceId: "instance-1" }),
					expect.objectContaining({ instanceId: "instance-alias" }),
				]),
			},
		});
		expect(prisma.trashSettings.findUnique).not.toHaveBeenCalled();
		expect(customFormatUpdate).not.toHaveBeenCalled();
		expect(qualityProfileUpdate).not.toHaveBeenCalled();
	});

	it("fails before upstream access when the service connection drifts after lock acquisition", async () => {
		const lockSnapshot = {
			id: "instance-1",
			label: "Radarr",
			service: "RADARR",
			baseUrl: "http://radarr-old",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
		};
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({
					id: "template-1",
					name: "Radarr - Any",
					serviceType: "RADARR",
					configData: '{"customFormats":[]}',
					instanceOverrides: null,
					sourceQualityProfileName: "Any",
				}),
			},
			serviceInstance: {
				findFirst: vi
					.fn()
					.mockResolvedValueOnce(lockSnapshot)
					.mockResolvedValueOnce({ ...lockSnapshot, baseUrl: "http://radarr-new" }),
			},
		};
		const createClient = vi.fn();
		const executor = new DeploymentExecutorService(
			prisma as never,
			{ create: createClient } as never,
		);

		await expect(
			executor.deploySingleInstanceFromAutomation("template-1", "instance-1", "user-1"),
		).rejects.toThrow("service connection changed while deployment was starting");
		expect(createClient).not.toHaveBeenCalled();
	});
});

describe("DeploymentExecutorService - bulk partial failures", () => {
	it("rejects tokenless user-triggered execution before reading deployment state", async () => {
		const findFirst = vi.fn();
		const executor = new DeploymentExecutorService(
			{ serviceInstance: { findFirst } } as never,
			{} as never,
		);

		await expect(
			executor.deploySingleInstance("template-1", "instance-1", "user-1"),
		).rejects.toThrow("fresh deployment preview token");
		expect(findFirst).not.toHaveBeenCalled();
	});

	it("rejects a repeated instance ID before starting deployment", async () => {
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const deploySingle = vi.spyOn(executor, "deploySingleInstance");

		await expect(
			executor.deployBulkInstances(
				"template-1",
				["instance-1", "instance-1"],
				"user-1",
				undefined,
				undefined,
				{},
			),
		).rejects.toThrow("same service instance more than once");
		expect(deploySingle).not.toHaveBeenCalled();
	});

	it("preserves applied custom-format counts and details when a deployment conflicts", async () => {
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({ id: "template-1", name: "Radarr - Any" }),
			},
			serviceInstance: {
				findMany: vi
					.fn()
					.mockResolvedValue([{ id: "instance-1", service: "RADARR", baseUrl: "http://radarr" }]),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const partialDetails = {
			created: ["Created CF"],
			updated: ["Updated CF"],
			failed: ["Failed CF"],
			orphaned: [],
		};
		const conflict = Object.assign(new ConflictError("The reviewed profile changed"), {
			partialDeployment: {
				created: 1,
				updated: 1,
				skipped: 2,
				details: partialDetails,
				qualityProfile: {
					action: "updated",
					profileId: 7,
					profileName: "Any",
					postStateToken: "token",
				},
			},
		});
		vi.spyOn(executor, "deploySingleInstance").mockRejectedValue(conflict);

		const result = await executor.deployBulkInstances(
			"template-1",
			["instance-1"],
			"user-1",
			undefined,
			undefined,
			{ "instance-1": "token" },
		);

		expect(result.failedInstances).toBe(1);
		expect(result.results[0]).toMatchObject({
			instanceId: "instance-1",
			success: false,
			customFormatsCreated: 1,
			customFormatsUpdated: 1,
			customFormatsSkipped: 2,
			qualityProfileApplied: {
				action: "updated",
				profileId: 7,
				profileName: "Any",
			},
			errors: ["The reviewed profile changed"],
			details: partialDetails,
		});
		expect(result.results[0]?.qualityProfileApplied).not.toHaveProperty("postStateToken");
	});

	it("rejects duplicate records for one endpoint before starting a bulk deployment", async () => {
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({ id: "template-1", name: "Radarr - Any" }),
			},
			serviceInstance: {
				findMany: vi.fn().mockResolvedValue([
					{ id: "instance-1", service: "RADARR", baseUrl: "http://radarr/" },
					{ id: "instance-alias", service: "radarr", baseUrl: "HTTP://RADARR:80" },
				]),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const singleDeployment = vi.spyOn(executor, "deploySingleInstance");

		await expect(
			executor.deployBulkInstances(
				"template-1",
				["instance-1", "instance-alias"],
				"user-1",
				undefined,
				undefined,
				{ "instance-1": "token-1", "instance-alias": "token-2" },
			),
		).rejects.toThrow("multiple service records for the same ARR endpoint");
		expect(singleDeployment).not.toHaveBeenCalled();
	});

	it("runs bulk targets sequentially under the per-user topology lease", async () => {
		const instanceIds = ["instance-1", "instance-2", "instance-3"];
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({ id: "template-1", name: "Radarr - Any" }),
			},
			serviceInstance: {
				findMany: vi
					.fn()
					.mockResolvedValue(
						instanceIds.map((id) => ({ id, service: "RADARR", baseUrl: `http://${id}` })),
					),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		let active = 0;
		let maximumActive = 0;
		vi.spyOn(executor, "deploySingleInstance").mockImplementation(async (_templateId, id) => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await Promise.resolve();
			active--;
			return {
				instanceId: id,
				instanceLabel: id,
				success: true,
				customFormatsCreated: 0,
				customFormatsUpdated: 0,
				customFormatsSkipped: 0,
				errors: [],
			};
		});

		await executor.deployBulkInstances(
			"template-1",
			instanceIds,
			"user-1",
			undefined,
			undefined,
			Object.fromEntries(instanceIds.map((id) => [id, "token"])),
		);

		expect(maximumActive).toBe(1);
	});
});

describe("DeploymentExecutorService - endpoint mutation coordination", () => {
	it("serializes deployments and rollbacks across alias records for one ARR endpoint", async () => {
		const executor = new DeploymentExecutorService({} as never, {} as never);
		let releaseFirst!: () => void;
		const firstAction = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = executor.runWithEndpointMutation(
			"user-1",
			{ service: "RADARR", baseUrl: "http://radarr:7878/" },
			"Deployment",
			async () => firstAction,
		);

		await expect(
			executor.runWithEndpointMutation(
				"user-1",
				{ service: "radarr", baseUrl: "HTTP://RADARR:7878" },
				"Rollback",
				async () => undefined,
			),
		).rejects.toThrow("another deployment or rollback is active");

		releaseFirst();
		await first;
		await expect(
			executor.runWithEndpointMutation(
				"user-1",
				{ service: "RADARR", baseUrl: "http://radarr:7878" },
				"Rollback",
				async () => "completed",
			),
		).resolves.toBe("completed");
	});
});
