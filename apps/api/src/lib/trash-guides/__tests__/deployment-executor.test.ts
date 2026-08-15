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
import {
	createDeploymentEndpointKey,
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
} from "../deployment-target.js";

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

	it("revalidates a kept format before retaining its managed identity", async () => {
		const existing = { id: 1, name: "Test CF", specifications: [] } as SdkCustomFormat;
		const client = {
			customFormat: {
				getById: vi.fn().mockResolvedValue({
					...existing,
					name: "Changed after review",
				}),
				update: vi.fn(),
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const run = (
			executor as unknown as {
				deployCustomFormats: (...args: unknown[]) => Promise<unknown>;
			}
		).deployCustomFormats.bind(executor);

		await expect(
			run(
				client,
				[{ trashId: "cf-1", name: "Test CF", originalConfig: { specifications: [] } }],
				new Map([["cf-1", existing]]),
				new Map([["Test CF", existing]]),
				{ "cf-1": "keep_existing" },
			),
		).rejects.toThrow("changed during deployment");
		expect(client.customFormat.getById).toHaveBeenCalledWith(1);
		expect(client.customFormat.update).not.toHaveBeenCalled();
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

	it("records the exact created Custom Format state before the follow-up read", async () => {
		const created = {
			id: 7,
			name: "Test CF",
			includeCustomFormatWhenRenaming: false,
			specifications: [],
		};
		const persistMutationState = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([]),
				create: vi.fn().mockResolvedValue(created),
				getById: vi.fn().mockRejectedValue(new Error("follow-up read failed")),
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const run = (
			executor as unknown as {
				deployCustomFormats: (...args: unknown[]) => Promise<unknown>;
			}
		).deployCustomFormats.bind(executor);

		await expect(
			run(
				client,
				[{ trashId: "cf-1", name: "Test CF", originalConfig: { specifications: [] } }],
				new Map(),
				new Map(),
				undefined,
				persistMutationState,
			),
		).rejects.toThrow("post-write state could not be verified");
		expect(persistMutationState).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				resourceId: null,
				status: "pending",
				intendedPostState: {
					name: "Test CF",
					includeCustomFormatWhenRenaming: false,
					specifications: [],
				},
			}),
			true,
		);
		expect(persistMutationState).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				resourceId: 7,
				status: "pending",
				postStateToken: createUpstreamResourceStateToken(created),
			}),
			false,
		);
	});

	it("preserves a verified creation when final ledger persistence fails", async () => {
		const created = {
			id: 7,
			name: "Test CF",
			includeCustomFormatWhenRenaming: false,
			specifications: [],
		};
		const persistMutationState = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("final ledger unavailable"));
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([]),
				create: vi.fn().mockResolvedValue(created),
				getById: vi.fn().mockResolvedValue(created),
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
				[{ trashId: "cf-1", name: "Test CF", originalConfig: { specifications: [] } }],
				new Map(),
				new Map(),
				undefined,
				persistMutationState,
			);
		} catch (error) {
			conflict = error;
		}

		expect(conflict).toMatchObject({
			partialDeployment: {
				created: 1,
				updated: 0,
				skipped: 0,
				details: { created: ["Test CF"], updated: [], failed: [] },
			},
		});
	});

	it("attaches earlier successful writes when a later format drifts", async () => {
		const create = vi.fn().mockResolvedValue({ id: 1 });
		const client = {
			customFormat: {
				getAll: vi
					.fn()
					.mockResolvedValueOnce([])
					.mockResolvedValueOnce([{ id: 9, name: "Second CF", specifications: [] }]),
				getById: vi.fn().mockResolvedValue({
					id: 1,
					name: "First CF",
					includeCustomFormatWhenRenaming: false,
					specifications: [],
				}),
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
	it("rolls back the backup transaction when the parent wrapper changed before linkage", async () => {
		const committedBackups: unknown[] = [];
		const committedHistories: unknown[] = [];
		const createHistory = vi.fn();
		const prisma = {
			trashSettings: { findUnique: vi.fn().mockResolvedValue({ backupRetentionDays: 30 }) },
			$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
				const stagedBackups: unknown[] = [];
				const stagedHistories: unknown[] = [];
				const result = await callback({
					trashBackup: {
						create: vi.fn(async ({ data }) => {
							const backup = { id: "backup-raced", ...data };
							stagedBackups.push(backup);
							return backup;
						}),
					},
					trashSyncHistory: {
						updateMany: vi.fn().mockResolvedValue({ count: 0 }),
						create: createHistory.mockImplementation(async ({ data }) => {
							const history = { id: "history-raced", ...data };
							stagedHistories.push(history);
							return history;
						}),
					},
				});
				committedBackups.push(...stagedBackups);
				committedHistories.push(...stagedHistories);
				return result;
			}),
		};
		const executor = new DeploymentExecutorService(
			prisma as never,
			{
				createConnectionCredentialIdentity: vi.fn().mockReturnValue("credential-1"),
			} as never,
		);
		const createBackupAndHistory = (
			executor as unknown as {
				createBackupAndHistory: (...args: unknown[]) => Promise<unknown>;
			}
		).createBackupAndHistory.bind(executor);

		await expect(
			createBackupAndHistory(
				{
					id: "instance-1",
					service: "RADARR",
					baseUrl: "http://radarr:7878",
					encryptedApiKey: "encrypted-key",
					encryptionIv: "iv",
				},
				"user-1",
				[],
				"template-1",
				null,
				undefined,
				"parent-sync-raced",
			),
		).rejects.toThrow("parent sync history changed");
		expect(committedBackups).toEqual([]);
		expect(committedHistories).toEqual([]);
		expect(createHistory).not.toHaveBeenCalled();
	});

	it("backs up naming state with Custom Formats and the quality profile", async () => {
		const createBackup = vi.fn().mockResolvedValue({ id: "backup-1" });
		const linkParentSync = vi.fn().mockResolvedValue({ count: 1 });
		const prisma = {
			trashSettings: { findUnique: vi.fn().mockResolvedValue({ backupRetentionDays: 30 }) },
			$transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
				callback({
					trashBackup: { create: createBackup },
					trashSyncHistory: {
						create: vi.fn().mockResolvedValue({ id: "history-1" }),
						updateMany: linkParentSync,
					},
				}),
			),
		};
		const executor = new DeploymentExecutorService(
			prisma as never,
			{
				createConnectionCredentialIdentity: vi.fn().mockReturnValue("credential-1"),
			} as never,
		);
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
					parentSyncHistoryId?: string,
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
			"parent-sync-1",
		);
		expect(linkParentSync).toHaveBeenCalledWith({
			where: {
				id: "parent-sync-1",
				userId: "user-1",
				instanceId: "instance-1",
				status: "RUNNING",
				backupId: null,
			},
			data: { backupId: "backup-1" },
		});

		const backupData = JSON.parse(createBackup.mock.calls[0]![0].data.backupData);
		expect(backupData).toMatchObject({
			endpointKey: createDeploymentEndpointKey("user-1", {
				service: "RADARR",
				baseUrl: "http://radarr:7878",
				credentialIdentity: "credential-1",
			}),
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
			specifications: [
				{ name: "Updated", implementation: "ReleaseTitleSpecification", fields: [] },
			],
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

	it("keeps a Custom Format pending when ARR returns a different writable state", async () => {
		const before = { id: 1, name: "Test CF", specifications: [] } as SdkCustomFormat;
		const intendedSpecifications = [
			{ name: "Updated", implementation: "ReleaseTitleSpecification", fields: [] },
		];
		const persist = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: {
				getById: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(before),
				update: vi.fn().mockResolvedValue(undefined),
			},
		};
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
					{
						trashId: "cf-1",
						name: "Test CF",
						originalConfig: { specifications: intendedSpecifications },
					},
				],
				new Map([["cf-1", before]]),
				new Map([["Test CF", before]]),
				undefined,
				persist,
			),
		).rejects.toMatchObject({
			message: expect.stringContaining("post-write state could not be verified"),
			deploymentResultUncertain: true,
		});
		expect(persist).toHaveBeenCalledOnce();
		expect(persist).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending", postStateToken: null }),
			true,
		);
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
			deploymentResultUncertain: true,
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

	it("rejects naming success when ARR ignores an intended writable field", async () => {
		const beforeConfig = { id: 1, standardMovieFormat: "Original" };
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
			),
		).rejects.toThrow("did not match the intended post-write state");
	});

	it("does not report naming fields as applied when post-write verification fails", async () => {
		const beforeConfig = { id: 1, standardMovieFormat: "Original" };
		const rawRequest = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(beforeConfig),
			})
			.mockResolvedValueOnce({ ok: true, status: 202 })
			.mockResolvedValueOnce({ ok: false, status: 503 });
		const executor = new DeploymentExecutorService({} as never, { rawRequest } as never);
		const deployNamingPresets = (
			executor as unknown as {
				deployNamingPresets: (...args: unknown[]) => Promise<unknown>;
			}
		).deployNamingPresets.bind(executor);

		let error: unknown;
		try {
			await deployNamingPresets(
				{
					currentConfig: beforeConfig,
					mergedConfig: { ...beforeConfig, standardMovieFormat: "Deployed" },
					changedFields: ["standardMovieFormat"],
				},
				{ id: "instance-1", service: "RADARR" },
			);
		} catch (caughtError) {
			error = caughtError;
		}
		expect(error).toBeInstanceOf(ConflictError);
		expect(error).toMatchObject({
			deploymentResultUncertain: true,
		});
		expect(rawRequest).toHaveBeenCalledTimes(3);
	});

	it("marks a non-success naming PUT response as uncertain", async () => {
		const beforeConfig = { id: 1, standardMovieFormat: "Original" };
		const rawRequest = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(beforeConfig),
			})
			.mockResolvedValueOnce({ ok: false, status: 500 });
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
		).rejects.toMatchObject({ deploymentResultUncertain: true });
		expect(rawRequest).toHaveBeenCalledTimes(2);
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

		const result = await syncQualityProfile(
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
			new Map([["managed-trash-id", 42]]),
		);
		expect(result).toMatchObject({ errors: [] });

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
				new Map([["managed-trash-id", 42]]),
			),
		).resolves.toMatchObject({ errors: [] });

		expect(update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ formatItems: [{ format: 42, score: 20 }] }),
		);
	});

	it("blocks profile creation when the reviewed name appears before POST", async () => {
		const client = {
			customFormat: { getAll: vi.fn().mockResolvedValue([]) },
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

	it.each(["RADARR", "SONARR"] as const)(
		"updates the cloned source profile instead of creating the renamed template for %s",
		async (serviceType) => {
			const profile = {
				id: 7,
				name: "Any",
				upgradeAllowed: true,
				cutoff: 1,
				minFormatScore: 0,
				formatItems: [],
				items: [],
			};
			const postWriteProfile = {
				...profile,
				formatItems: [{ format: 42, score: 20 }],
			};
			const create = vi.fn();
			const update = vi.fn().mockResolvedValue(postWriteProfile);
			const client = {
				serviceType,
				customFormat: { getAll: vi.fn().mockResolvedValue([]) },
				qualityProfile: {
					create,
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
			};
			const executor = new DeploymentExecutorService(prisma as never, {} as never);
			const syncQualityProfile = (
				executor as unknown as {
					syncQualityProfile: (...args: unknown[]) => Promise<{ errors: string[] }>;
				}
			).syncQualityProfile.bind(executor);

			const result = await syncQualityProfile(
				client,
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "managed-cf",
						name: "Managed CF",
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
				createQualityProfileStateToken(profile),
				[],
				new Map(),
				["instance-1"],
				undefined,
				undefined,
				undefined,
				undefined,
				[],
				new Map([["managed-cf", 42]]),
			);

			expect(result.errors).toEqual([]);
			expect(update).toHaveBeenCalledWith(
				7,
				expect.objectContaining({
					id: 7,
					name: "Any",
					formatItems: [{ format: 42, score: 20 }],
				}),
			);
			expect(create).not.toHaveBeenCalled();
		},
	);

	it("persists the exact created profile state before later preparation can fail", async () => {
		const createdProfile = {
			id: 9,
			name: "Any",
			formatItems: [],
			items: [],
			cutoff: 1,
		};
		const persistProfileState = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: { getAll: vi.fn().mockResolvedValue([]) },
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([]),
				getSchema: vi.fn().mockResolvedValue({ items: [], formatItems: [] }),
				create: vi.fn().mockResolvedValue(createdProfile),
				getById: vi.fn().mockRejectedValue(new Error("later profile read failed")),
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<{ errors: string[] }>;
			}
		).syncQualityProfile.bind(executor);

		let error: unknown;
		try {
			await syncQualityProfile(
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
				undefined,
				persistProfileState,
			);
		} catch (caughtError) {
			error = caughtError;
		}
		expect(error).toMatchObject({ deploymentResultUncertain: true });
		expect(persistProfileState).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				status: "pending",
				action: "created",
				profileId: 9,
				postStateToken: createQualityProfileStateToken(createdProfile),
			}),
		);
	});

	it("does not leave a pending profile ledger when preparation fails before create", async () => {
		const persistProfileState = vi.fn().mockResolvedValue(undefined);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([]),
				getSchema: vi.fn().mockRejectedValue(new Error("schema read failed")),
				create: vi.fn(),
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<{ errors: string[] }>;
			}
		).syncQualityProfile.bind(executor);

		const result = await syncQualityProfile(
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
			undefined,
			persistProfileState,
		);

		expect(result.errors).toEqual([expect.stringContaining("schema read failed")]);
		expect(persistProfileState).not.toHaveBeenCalled();
		expect(client.qualityProfile.create).not.toHaveBeenCalled();
	});

	it("retains the created-state token while a later profile update is pending", async () => {
		const createdProfile = {
			id: 9,
			name: "Any",
			formatItems: [],
			items: [],
			cutoff: 1,
		};
		const intendedProfile = {
			...createdProfile,
			formatItems: [{ format: 7, score: 100 }],
		};
		const persistProfileState = vi
			.fn()
			.mockResolvedValueOnce(undefined)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("ledger persistence stopped execution"));
		const update = vi.fn();
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([]),
				getSchema: vi.fn().mockResolvedValue({ items: [], formatItems: [] }),
				create: vi.fn().mockResolvedValue(createdProfile),
				getById: vi.fn().mockResolvedValue(createdProfile),
				update,
			},
			customFormat: { getAll: vi.fn().mockResolvedValue([{ id: 7, name: "Managed CF" }]) },
		};
		const prisma = {
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<{ errors: string[] }>;
			}
		).syncQualityProfile.bind(executor);

		let error: unknown;
		try {
			await syncQualityProfile(
				client,
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "managed-cf",
						name: "Managed CF",
						originalConfig: { trash_scores: { default: 100 } },
					},
				],
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
				undefined,
				persistProfileState,
				undefined,
				undefined,
				[],
				new Map([["managed-cf", 7]]),
			);
		} catch (caughtError) {
			error = caughtError;
		}
		expect(error).toMatchObject({ deploymentResultUncertain: true });
		expect(persistProfileState).toHaveBeenNthCalledWith(
			3,
			expect.objectContaining({
				status: "pending",
				action: "created",
				profileId: 9,
				postStateToken: createQualityProfileStateToken(createdProfile),
				intendedPostStateToken: createQualityProfileStateToken(intendedProfile),
			}),
		);
		expect(createQualityProfileStateToken(intendedProfile)).not.toBe(
			createQualityProfileStateToken(createdProfile),
		);
		expect(update).not.toHaveBeenCalled();
	});

	it("records the exact post-write quality-profile state", async () => {
		const profile = { id: 1, name: "Any", formatItems: [] };
		const postWriteProfile = { ...profile };
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

		const result = await syncQualityProfile(
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
			undefined,
			undefined,
			[],
			new Map([["managed-cf", 42]]),
		);
		expect(result).toMatchObject({
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
		expect(result).toMatchObject({
			mappingFinalization: {
				templateId: "template-1",
				instanceId: "instance-1",
				equivalentInstanceIds: ["instance-1"],
				qualityProfileId: 1,
			},
		});
		expect(prisma.templateQualityProfileMapping.deleteMany).not.toHaveBeenCalled();
	});

	it("does not report an existing profile update before its post-write state is verified", async () => {
		const profile = { id: 1, name: "Any", formatItems: [] };
		const getById = vi
			.fn()
			.mockResolvedValueOnce(profile)
			.mockResolvedValueOnce(profile)
			.mockRejectedValueOnce(new Error("post-write profile read failed"));
		const update = vi.fn().mockResolvedValue({
			...profile,
			formatItems: [{ format: 42, score: 100 }],
		});
		const persistProfileState = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: { getAll: vi.fn().mockResolvedValue([]) },
			qualityProfile: { getById, update },
		};
		const prisma = {
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<{
					errors: string[];
					mutation?: unknown;
				}>;
			}
		).syncQualityProfile.bind(executor);

		let error: unknown;
		try {
			await syncQualityProfile(
				client,
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "managed-cf",
						name: "Managed CF",
						originalConfig: { trash_scores: { default: 100 } },
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
				persistProfileState,
			);
		} catch (caughtError) {
			error = caughtError;
		}
		expect(error).toMatchObject({ deploymentResultUncertain: true });
		expect(update).toHaveBeenCalledOnce();
		expect(persistProfileState).toHaveBeenCalledOnce();
	});

	it("keeps a profile pending when ARR returns a different writable state", async () => {
		const profile = { id: 1, name: "Any", formatItems: [] };
		const persistProfileState = vi.fn().mockResolvedValue(undefined);
		const client = {
			customFormat: { getAll: vi.fn().mockResolvedValue([{ id: 42, name: "Managed CF" }]) },
			qualityProfile: {
				getById: vi
					.fn()
					.mockResolvedValueOnce(profile)
					.mockResolvedValueOnce(profile)
					.mockResolvedValueOnce(profile),
				update: vi.fn().mockResolvedValue(undefined),
			},
		};
		const prisma = {
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
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
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "managed-cf",
						name: "Managed CF",
						originalConfig: { trash_scores: { default: 100 } },
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
				persistProfileState,
				undefined,
				undefined,
				[],
				new Map([["managed-cf", 42]]),
			),
		).rejects.toThrow("did not match the intended post-write state");
		expect(persistProfileState).toHaveBeenCalledOnce();
		expect(persistProfileState).toHaveBeenCalledWith(
			expect.objectContaining({ status: "pending", postStateToken: null }),
		);
	});

	it("accepts read-only custom format names added by ARR after a profile update", async () => {
		const profile = {
			id: 1,
			name: "Any",
			formatItems: [{ format: 42, name: "Managed CF", score: 10 }],
		};
		const postWriteProfile = {
			...profile,
			formatItems: [{ format: 42, name: "Managed CF", score: 20 }],
		};
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

		await expect(
			syncQualityProfile(
				client,
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "managed-trash-id",
						name: "Managed CF",
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
				undefined,
				undefined,
				[],
				new Map([["managed-trash-id", 42]]),
			),
		).resolves.toMatchObject({ errors: [] });

		expect(update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ formatItems: [{ format: 42, score: 20 }] }),
		);
	});

	it("defers mapping finalization while retaining every equivalent alias", async () => {
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

		const result = await syncQualityProfile(
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
		);
		expect(result).toMatchObject({
			errors: [],
			mappingFinalization: {
				templateId: "template-1",
				instanceId: "instance-alias",
				equivalentInstanceIds: ["instance-primary", "instance-alias"],
				qualityProfileId: 2,
			},
		});

		expect(deleteMany).not.toHaveBeenCalled();
		expect(transaction).not.toHaveBeenCalled();
		expect(upsert).not.toHaveBeenCalled();
	});

	it("finalizes mapping and saved-score authority for every equivalent alias", async () => {
		const deleteMappings = vi.fn().mockResolvedValue({ count: 2 });
		const upsertMapping = vi.fn().mockResolvedValue({});
		const deleteOverrides = vi.fn().mockResolvedValue({ count: 0 });
		const createOverride = vi.fn().mockResolvedValue({});
		const database = {
			templateQualityProfileMapping: {
				deleteMany: deleteMappings,
				upsert: upsertMapping,
			},
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "instance-primary",
						qualityProfileId: 7,
						customFormatId: 42,
						score: 100,
						status: "APPLIED",
						connectionGeneration: 2,
						connectionStateToken: "primary-token",
					},
					{
						instanceId: "instance-alias",
						qualityProfileId: 7,
						customFormatId: 42,
						score: 100,
						status: "APPLIED",
						connectionGeneration: 3,
						connectionStateToken: "alias-token",
					},
				]),
				deleteMany: deleteOverrides,
				create: createOverride,
			},
		};
		const executor = new DeploymentExecutorService({} as never, {} as never) as unknown as {
			finalizeQualityProfileMappingState: (
				database: unknown,
				finalization: Record<string, unknown>,
			) => Promise<void>;
		};
		const connectionBindings = [
			{
				instanceId: "instance-primary",
				connectionGeneration: 2,
				connectionStateToken: "primary-token",
			},
			{
				instanceId: "instance-alias",
				connectionGeneration: 3,
				connectionStateToken: "alias-token",
			},
		];

		await executor.finalizeQualityProfileMappingState(database, {
			userId: "user-1",
			templateId: "template-1",
			instanceId: "instance-primary",
			equivalentInstanceIds: ["instance-primary", "instance-alias"],
			connectionBindings,
			connectionReadBindings: connectionBindings,
			savedScoreOverrides: [[42, 100]],
			qualityProfileId: 7,
			qualityProfileName: "HD-1080p",
			connectionGeneration: 2,
			connectionStateToken: "primary-token",
			syncStrategy: "auto",
		});

		expect(deleteMappings).toHaveBeenCalledWith({
			where: {
				templateId: "template-1",
				instanceId: { in: ["instance-primary", "instance-alias"] },
			},
		});
		expect(upsertMapping).toHaveBeenCalledTimes(2);
		expect(upsertMapping).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					instanceId_qualityProfileId: {
						instanceId: "instance-alias",
						qualityProfileId: 7,
					},
				},
				create: expect.objectContaining({
					instanceId: "instance-alias",
					connectionGeneration: 3,
					connectionStateToken: "alias-token",
				}),
			}),
		);
		expect(createOverride).toHaveBeenCalledTimes(2);
		expect(createOverride).toHaveBeenCalledWith({
			data: expect.objectContaining({
				instanceId: "instance-alias",
				customFormatId: 42,
				connectionGeneration: 3,
				connectionStateToken: "alias-token",
			}),
		});
	});

	it("resets an orphaned managed score and defers override cleanup until finalization", async () => {
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
				findMany: vi.fn().mockResolvedValue([
					{
						customFormatId: 42,
						score: -10_000,
						instanceId: "instance-1",
						connectionGeneration: 0,
						connectionStateToken: "",
					},
				]),
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
		).resolves.toMatchObject({
			errors: [],
			orphanedCFs: ["Removed CF"],
			orphanedOverrideCleanup: {
				userId: "user-1",
				qualityProfileId: 1,
				customFormatIds: [42],
			},
		});

		expect(update).toHaveBeenCalledWith(
			1,
			expect.objectContaining({ formatItems: [{ format: 42, score: 0 }] }),
		);
		expect(deleteManyOverrides).not.toHaveBeenCalled();
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
				findMany: vi.fn().mockResolvedValue([
					{
						customFormatId: 42,
						score: 0,
						instanceId: "instance-1",
						connectionGeneration: 0,
						connectionStateToken: "",
					},
				]),
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

	it("accepts identical saved overrides returned in a different database order", async () => {
		const profile = {
			id: 1,
			name: "Any",
			formatItems: [
				{ format: 7, score: 200 },
				{ format: 42, score: 100 },
			],
		};
		const update = vi.fn().mockResolvedValue(profile);
		const client = {
			customFormat: {
				getAll: vi.fn().mockResolvedValue([
					{ id: 7, name: "Second CF" },
					{ id: 42, name: "First CF" },
				]),
			},
			qualityProfile: {
				getById: vi.fn().mockResolvedValue(profile),
				update,
			},
		};
		const prisma = {
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([
					{
						customFormatId: 7,
						score: 200,
						instanceId: "instance-1",
						connectionGeneration: 0,
						connectionStateToken: "",
					},
					{
						customFormatId: 42,
						score: 100,
						instanceId: "instance-1",
						connectionGeneration: 0,
						connectionStateToken: "",
					},
				]),
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
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "first",
						name: "First CF",
						originalConfig: { trash_scores: { default: 0 } },
					},
					{
						trashId: "second",
						name: "Second CF",
						originalConfig: { trash_scores: { default: 0 } },
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
				new Map([
					[42, 100],
					[7, 200],
				]),
				["instance-1"],
				undefined,
				undefined,
				undefined,
				undefined,
				[],
				new Map([
					["first", 42],
					["second", 7],
				]),
			),
		).resolves.toMatchObject({ errors: [] });
		expect(update).toHaveBeenCalledOnce();
	});
});

describe("DeploymentExecutorService - legacy override finalization", () => {
	async function loadLegacyOverrideScore(recordedScore: number, liveScore: number) {
		const prisma = {
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([
					{
						instanceId: "instance-1",
						qualityProfileId: 1,
						customFormatId: 42,
						score: recordedScore,
						status: "APPLIED",
						connectionGeneration: 0,
						connectionStateToken: null,
					},
				]),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never) as unknown as {
			loadEquivalentInstanceOverrideScores: (...args: unknown[]) => Promise<Map<number, number>>;
		};
		return executor.loadEquivalentInstanceOverrideScores(
			"user-1",
			[
				{
					instanceId: "instance-1",
					connectionGeneration: 2,
					connectionStateToken: "current-connection",
				},
			],
			1,
			{ id: 1, name: "Any", formatItems: [{ format: 42, score: liveScore }] },
		);
	}

	it("loads legacy override intent when its exact score remains live", async () => {
		await expect(loadLegacyOverrideScore(100, 100)).resolves.toEqual(new Map([[42, 100]]));
	});

	it("rejects legacy override intent after its live score drifts", async () => {
		await expect(loadLegacyOverrideScore(100, 200)).rejects.toThrow(
			"unverified saved score override",
		);
	});

	async function prepareLegacyFinalization() {
		const profile = { id: 1, name: "Any", formatItems: [{ format: 42, score: 100 }] };
		const legacyOverride = {
			id: "override-legacy",
			userId: "user-1",
			instanceId: "instance-1",
			qualityProfileId: 1,
			customFormatId: 42,
			score: 100,
			status: "APPLIED",
			connectionGeneration: 0,
			connectionStateToken: null,
		};
		const prisma = {
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([legacyOverride]),
			},
		};
		const client = {
			qualityProfile: {
				getById: vi.fn().mockResolvedValue(profile),
				update: vi.fn().mockResolvedValue(profile),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const privateExecutor = executor as unknown as {
			syncQualityProfile: (...args: unknown[]) => Promise<{
				mappingFinalization?: Record<string, unknown>;
			}>;
			finalizeSavedScoreOverrideState: (
				database: unknown,
				finalization: Record<string, unknown>,
			) => Promise<void>;
		};
		const currentBinding = {
			instanceId: "instance-1",
			connectionGeneration: 2,
			connectionStateToken: "current-connection",
		};
		const result = await privateExecutor.syncQualityProfile(
			client,
			{},
			[],
			"template-1",
			"instance-1",
			"user-1",
			"notify",
			undefined,
			"Any",
			profile,
			undefined,
			[],
			new Map([[42, 100]]),
			["instance-1"],
			undefined,
			undefined,
			[currentBinding],
			[
				currentBinding,
				{
					instanceId: "instance-1",
					connectionGeneration: 0,
					connectionStateToken: null,
				},
			],
			[],
			new Map(),
		);
		if (!result.mappingFinalization) throw new Error("Expected mapping finalization state");
		return { executor: privateExecutor, finalization: result.mappingFinalization, legacyOverride };
	}

	it("carries reviewed legacy APPLIED intent into canonical finalization", async () => {
		const { executor, finalization, legacyOverride } = await prepareLegacyFinalization();
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const create = vi.fn().mockResolvedValue({});
		const database = {
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([legacyOverride]),
				deleteMany,
				create,
			},
		};

		await executor.finalizeSavedScoreOverrideState(database, finalization);

		expect(deleteMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				instanceId: { in: ["instance-1"] },
				qualityProfileId: 1,
			},
		});
		expect(create).toHaveBeenCalledWith({
			data: expect.objectContaining({
				instanceId: "instance-1",
				customFormatId: 42,
				score: 100,
				connectionGeneration: 2,
				connectionStateToken: "current-connection",
			}),
		});
	});

	it("preserves legacy intent when finalization authority changed", async () => {
		const { executor, finalization, legacyOverride } = await prepareLegacyFinalization();
		const deleteMany = vi.fn();
		const create = vi.fn();
		const database = {
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([{ ...legacyOverride, score: 200 }]),
				deleteMany,
				create,
			},
		};

		await expect(executor.finalizeSavedScoreOverrideState(database, finalization)).rejects.toThrow(
			"changed before deployment state could be finalized",
		);
		expect(deleteMany).not.toHaveBeenCalled();
		expect(create).not.toHaveBeenCalled();
	});

	it("projects credential evidence out of orphaned override finalization filters", async () => {
		const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
		const executor = new DeploymentExecutorService({} as never, {} as never) as unknown as {
			finalizeOrphanedOverrideCleanup: (database: unknown, cleanup: unknown) => Promise<void>;
		};

		await executor.finalizeOrphanedOverrideCleanup(
			{ instanceQualityProfileOverride: { deleteMany } },
			{
				userId: "user-1",
				qualityProfileId: 7,
				customFormatIds: [42],
				connectionReadBindings: [
					{
						instanceId: "instance-1",
						connectionGeneration: 2,
						connectionStateToken: "connection-token",
						credentialIdentity: "runtime-only-credential-evidence",
					},
				],
			},
		);

		expect(deleteMany).toHaveBeenCalledWith({
			where: {
				userId: "user-1",
				qualityProfileId: 7,
				customFormatId: { in: [42] },
				OR: [
					{
						instanceId: "instance-1",
						connectionGeneration: 2,
						connectionStateToken: "connection-token",
					},
				],
			},
		});
	});
});

describe("DeploymentExecutorService - created profile partial evidence", () => {
	it("attaches a durably proven created profile when a later score recheck conflicts", async () => {
		const createdProfile = {
			id: 9,
			name: "Any",
			formatItems: [],
			items: [],
			cutoff: 1,
		};
		const persistProfileState = vi.fn().mockResolvedValue(undefined);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([]),
				getSchema: vi.fn().mockResolvedValue({ items: [], formatItems: [] }),
				create: vi.fn().mockResolvedValue(createdProfile),
				getById: vi.fn().mockResolvedValue(createdProfile),
				update: vi.fn(),
			},
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 7, name: "Managed CF" }]),
			},
		};
		const prisma = {
			instanceQualityProfileOverride: {
				findMany: vi.fn().mockResolvedValue([{ customFormatId: 7, score: 50 }]),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const syncQualityProfile = (
			executor as unknown as {
				syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			}
		).syncQualityProfile.bind(executor);

		let conflict: unknown;
		try {
			await syncQualityProfile(
				client,
				{ qualityProfile: { trash_score_set: "default" } },
				[
					{
						trashId: "managed-cf",
						name: "Managed CF",
						originalConfig: { trash_scores: { default: 100 } },
					},
				],
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
				undefined,
				persistProfileState,
				[
					{
						instanceId: "instance-1",
						connectionGeneration: 1,
						connectionStateToken: "connection",
					},
				],
				[
					{
						instanceId: "instance-1",
						connectionGeneration: 1,
						connectionStateToken: "connection",
					},
				],
			);
		} catch (error) {
			conflict = error;
		}

		expect(conflict).toBeInstanceOf(ConflictError);
		expect(conflict).toMatchObject({
			partialDeployment: {
				created: 0,
				updated: 0,
				skipped: 0,
				details: { created: [], updated: [], failed: [], orphaned: [] },
				qualityProfile: {
					action: "created",
					profileId: 9,
					profileName: "Any",
					postStateToken: createQualityProfileStateToken(createdProfile),
				},
			},
		});
		expect(persistProfileState).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "pending",
				action: "created",
				profileId: 9,
				postStateToken: createQualityProfileStateToken(createdProfile),
			}),
		);
		expect(client.qualityProfile.update).not.toHaveBeenCalled();
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
