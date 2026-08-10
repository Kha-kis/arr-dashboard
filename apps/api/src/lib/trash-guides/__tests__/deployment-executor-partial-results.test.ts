import { describe, expect, it, vi } from "vitest";
import { ConflictError } from "../../errors.js";
import { DeploymentExecutorService } from "../deployment-executor.js";
import { createQualityProfileStateToken } from "../deployment-target.js";

describe("DeploymentExecutorService Task 4A result propagation", () => {
	it("blocks production deployment before upstream writes when recovery is pending", async () => {
		const instance = {
			id: "instance-1",
			userId: "user-1",
			label: "Radarr",
			service: "RADARR",
			baseUrl: "http://radarr:7878",
			encryptedApiKey: "encrypted-key",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			connectionGeneration: 1,
		};
		const pendingBackup = {
			backupData: JSON.stringify({
				schemaVersion: 2,
				endpointKey: "user-1:RADARR:http://radarr:7878/",
				connectionStateToken: "connection",
				customFormats: [],
				customFormatDeployments: [
					{
						beforeFormat: null,
						action: "created",
						resourceId: 7,
						name: "Uncertain CF",
						status: "pending",
						postStateToken: "exact-token",
						intendedPostStateToken: "intended-token",
					},
				],
				managedCustomFormats: [],
				managedCustomFormatsCaptured: false,
				qualityProfileDeployment: {
					beforeProfile: null,
					status: "not_started",
					action: "created",
					profileId: null,
					profileName: null,
					postStateToken: null,
					intendedPostStateToken: null,
				},
				namingDeployment: null,
			}),
		};
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: vi.fn().mockResolvedValue([instance]),
			},
			trashSyncHistory: {
				findMany: vi.fn().mockResolvedValue([{ status: "PARTIAL_SUCCESS", backup: pendingBackup }]),
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
		};
		const upstreamRead = vi.fn();
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
			customFormat: { getAll: upstreamRead },
			qualityProfile: { getAll: vi.fn() },
		};
		const executor = new DeploymentExecutorService(
			prisma as never,
			{
				create: vi.fn().mockReturnValue(client),
			} as never,
		);
		const privateExecutor = executor as unknown as {
			validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
			createBackupAndHistory: (...args: unknown[]) => Promise<unknown>;
		};
		vi.spyOn(privateExecutor, "validateAndPrepareDeployment").mockResolvedValue({
			template: { id: "template-1", name: "Any" },
			instance,
			templateConfig: {},
			templateCFs: [],
			effectiveQualityConfig: undefined,
		} as never);
		const createBackup = vi.spyOn(privateExecutor, "createBackupAndHistory");

		await expect(
			executor.deploySingleInstance("template-1", "instance-1", "user-1"),
		).resolves.toMatchObject({
			success: false,
			errors: [expect.stringContaining("uncertain upstream result")],
		});
		expect(upstreamRead).not.toHaveBeenCalled();
		expect(createBackup).not.toHaveBeenCalled();
	});

	it("keeps a created profile durable in both histories when a later live recheck conflicts", async () => {
		const createdProfile = {
			id: 9,
			name: "Any",
			formatItems: [],
			items: [],
			cutoff: 1,
		};
		const storedBackupPayloads: string[] = [];
		const syncHistoryUpdate = vi.fn().mockResolvedValue({});
		const deploymentHistoryUpdate = vi.fn().mockResolvedValue({});
		const transactionClient = {
			trashSyncHistory: { update: syncHistoryUpdate },
			templateDeploymentHistory: { update: deploymentHistoryUpdate },
		};
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					id: "instance-1",
					service: "RADARR",
					baseUrl: "http://radarr:7878",
					encryptedApiKey: "encrypted-key",
					encryptionIv: "iv",
					encryptedHttpAuthCredentials: null,
					httpAuthEncryptionIv: null,
					connectionGeneration: 1,
				}),
				findMany: vi.fn().mockResolvedValue([
					{
						id: "instance-1",
						service: "RADARR",
						baseUrl: "http://radarr:7878",
						encryptedApiKey: "encrypted-key",
						encryptionIv: "iv",
						encryptedHttpAuthCredentials: null,
						httpAuthEncryptionIv: null,
						connectionGeneration: 1,
					},
				]),
			},
			templateQualityProfileMapping: { findMany: vi.fn().mockResolvedValue([]) },
			instanceQualityProfileOverride: {
				findMany: vi
					.fn()
					.mockResolvedValueOnce([])
					.mockResolvedValue([{ customFormatId: 42, score: 50, instanceId: "instance-1" }]),
			},
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([]),
				create: vi.fn().mockResolvedValue({ id: "deployment-history-1" }),
			},
			trashBackup: {
				update: vi.fn(async ({ data }: { data: { backupData: string } }) => {
					storedBackupPayloads.push(data.backupData);
					return {};
				}),
			},
			$transaction: vi.fn(async (work: (database: typeof transactionClient) => Promise<void>) =>
				work(transactionClient),
			),
		};
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 42, name: "Managed CF" }]),
			},
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([]),
				getSchema: vi.fn().mockResolvedValue({ items: [], formatItems: [] }),
				create: vi.fn().mockResolvedValue(createdProfile),
				getById: vi.fn().mockResolvedValue(createdProfile),
				update: vi.fn(),
			},
		};
		const clientFactory = {
			create: vi.fn().mockReturnValue(client),
			createConnectionCredentialIdentity: vi.fn().mockReturnValue("credential-1"),
		};
		const executor = new DeploymentExecutorService(prisma as never, clientFactory as never);
		const privateExecutor = executor as unknown as {
			validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
			createBackupAndHistory: (...args: unknown[]) => Promise<unknown>;
			deployCustomFormats: (...args: unknown[]) => Promise<unknown>;
		};
		vi.spyOn(privateExecutor, "validateAndPrepareDeployment").mockResolvedValue({
			template: {
				id: "template-1",
				name: "Any",
				serviceType: "RADARR",
				configData: "{}",
				instanceOverrides: null,
				sourceQualityProfileName: null,
			},
			instance: {
				id: "instance-1",
				label: "Radarr",
				service: "RADARR",
				baseUrl: "http://radarr:7878",
				encryptedApiKey: "encrypted-key",
				encryptionIv: "iv",
				encryptedHttpAuthCredentials: null,
				httpAuthEncryptionIv: null,
				connectionGeneration: 1,
			},
			templateConfig: { qualityProfile: { trash_score_set: "default" } },
			templateCFs: [
				{
					trashId: "managed-cf",
					name: "Managed CF",
					originalConfig: { trash_scores: { default: 100 } },
				},
			],
			overridesForInstance: {},
			effectiveQualityConfig: undefined,
			usingQualityOverride: false,
		} as never);
		const backup = {
			id: "backup-1",
			retentionExpiresAt: null,
			data: {
				schemaVersion: 2,
				endpointKey: "user-1:RADARR:http://radarr:7878",
				connectionStateToken: "connection",
				customFormats: [],
				customFormatDeployments: [],
				managedCustomFormats: [],
				managedCustomFormatsCaptured: false,
				qualityProfileDeployment: {
					beforeProfile: null,
					status: "not_started",
					action: "created",
					profileId: null,
					profileName: "Any",
					postStateToken: null,
					intendedPostStateToken: null,
				},
				namingDeployment: null,
			},
		};
		vi.spyOn(privateExecutor, "createBackupAndHistory").mockResolvedValue({
			backup,
			historyId: "sync-history-1",
		} as never);
		vi.spyOn(privateExecutor, "deployCustomFormats").mockResolvedValue({
			created: 0,
			updated: 0,
			skipped: 0,
			details: { created: [], updated: [], failed: [], orphaned: [] },
			errors: [],
		} as never);

		let conflict: unknown;
		try {
			await executor.deploySingleInstance("template-1", "instance-1", "user-1");
		} catch (error) {
			conflict = error;
		}

		const appliedProfile = {
			name: "Any",
			action: "created",
			type: "quality_profile",
			id: 9,
		};
		expect(conflict).toBeInstanceOf(ConflictError);
		expect(conflict).toMatchObject({
			details: {
				partialDeployment: {
					qualityProfile: { action: "created", profileId: 9, profileName: "Any" },
				},
			},
		});
		expect(storedBackupPayloads).toContainEqual(expect.any(String));
		expect(
			storedBackupPayloads.some((payload) => {
				const state = JSON.parse(payload).qualityProfileDeployment;
				return (
					state.profileId === 9 &&
					state.postStateToken === createQualityProfileStateToken(createdProfile)
				);
			}),
		).toBe(true);
		expect(syncHistoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "sync-history-1" },
				data: expect.objectContaining({
					status: "UNCERTAIN",
					configsApplied: 1,
					configsFailed: 0,
					appliedConfigs: JSON.stringify([appliedProfile]),
					failedConfigs: JSON.stringify([]),
				}),
			}),
		);
		expect(deploymentHistoryUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "deployment-history-1" },
				data: expect.objectContaining({
					status: "UNCERTAIN",
					appliedConfigs: JSON.stringify([appliedProfile]),
					failedConfigs: JSON.stringify([]),
				}),
			}),
		);
		expect(client.qualityProfile.update).not.toHaveBeenCalled();
	});

	it("preserves applied details and profile evidence when a bulk target conflicts", async () => {
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({ id: "template-1", name: "Radarr - Any" }),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const details = {
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
				details,
				qualityProfile: {
					action: "created",
					profileId: 9,
					profileName: "Any",
					postStateToken: "exact-created-token",
				},
			},
		});
		vi.spyOn(executor, "deploySingleInstance").mockRejectedValue(conflict);

		const result = await executor.deployBulkInstances("template-1", ["instance-1"], "user-1");

		expect(result.results[0]).toMatchObject({
			instanceId: "instance-1",
			success: false,
			customFormatsCreated: 1,
			customFormatsUpdated: 1,
			customFormatsSkipped: 2,
			qualityProfileApplied: {
				action: "created",
				profileId: 9,
				profileName: "Any",
			},
			errors: ["The reviewed profile changed"],
			details,
		});
		expect(result.results[0]?.qualityProfileApplied).not.toHaveProperty("postStateToken");
	});

	it("counts an unverified bulk write as uncertain instead of failed", async () => {
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({ id: "template-1", name: "Any" }),
			},
		};
		const executor = new DeploymentExecutorService(prisma as never, {} as never);
		const uncertain = Object.assign(new ConflictError("ARR write result is uncertain"), {
			deploymentResultUncertain: true,
		});
		vi.spyOn(executor, "deploySingleInstance").mockRejectedValue(uncertain);

		const result = await executor.deployBulkInstances("template-1", ["instance-1"], "user-1");

		expect(result).toMatchObject({
			successfulInstances: 0,
			failedInstances: 0,
			uncertainInstances: 1,
			results: [{ status: "UNCERTAIN", success: false }],
		});
	});

	it("serializes deployment and rollback work across equivalent endpoint records", async () => {
		const executor = new DeploymentExecutorService({} as never, {} as never);
		let releaseFirst!: () => void;
		const firstAction = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const first = executor.runWithEndpointMutation(
			"user-1",
			{ service: "RADARR", credentialIdentity: "credential-1" },
			"Deployment",
			async () => firstAction,
		);

		await expect(
			executor.runWithEndpointMutation(
				"user-1",
				{ service: "radarr", credentialIdentity: "credential-1" },
				"Rollback",
				async () => undefined,
			),
		).rejects.toThrow("another deployment or rollback is active");

		releaseFirst();
		await first;
		await expect(
			executor.runWithEndpointMutation(
				"user-1",
				{ service: "RADARR", credentialIdentity: "credential-1" },
				"Rollback",
				async () => "completed",
			),
		).resolves.toBe("completed");
	});
});
