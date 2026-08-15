import { describe, expect, it, vi } from "vitest";

vi.mock("../deployment-naming-state.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../deployment-naming-state.js")>();
	return {
		...original,
		prepareNamingDeployment: vi.fn().mockResolvedValue({
			currentConfig: { id: 1, standardMovieFormat: "Original" },
			mergedConfig: { id: 1, standardMovieFormat: "Deployed" },
			changedFields: ["standardMovieFormat"],
		}),
	};
});

import { DeploymentExecutorService } from "../deployment-executor.js";
import { createDeploymentConnectionStateToken } from "../deployment-target.js";

describe("DeploymentExecutorService naming finalization", () => {
	it("returns UNCERTAIN when the applied naming ledger cannot be finalized", async () => {
		const instance = {
			id: "instance-1",
			userId: "user-1",
			label: "Radarr",
			service: "RADARR",
			enabled: true,
			baseUrl: "http://radarr:7878",
			encryptedApiKey: "encrypted-key",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			connectionGeneration: 1,
		};
		const profile = { id: 4, name: "Any", items: [], formatItems: [] };
		const backup = {
			id: "backup-1",
			retentionExpiresAt: null,
			data: {
				schemaVersion: 2,
				endpointKey: "user-1:RADARR:credential",
				connectionStateToken: "connection",
				customFormats: [],
				customFormatDeployments: [],
				managedCustomFormats: [],
				managedCustomFormatsCaptured: false,
				qualityProfileDeployment: {
					beforeProfile: profile,
					status: "not_started",
					action: "updated",
					profileId: 4,
					profileName: "Any",
					postStateToken: null,
					intendedPostStateToken: null,
				},
				namingDeployment: {
					beforeConfig: { id: 1, standardMovieFormat: "Original" },
					status: "not_started",
					postStateToken: null,
					intendedPostStateToken: "intended",
				},
			},
		};
		const backupUpdate = vi
			.fn()
			.mockResolvedValueOnce({})
			.mockResolvedValueOnce({})
			.mockRejectedValueOnce(new Error("database unavailable"));
		const prisma = {
			serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
			templateQualityProfileMapping: {
				findMany: vi.fn().mockResolvedValue([
					{
						id: "mapping-1",
						templateId: "template-1",
						instanceId: "instance-1",
						qualityProfileId: 4,
						qualityProfileName: "Any",
						connectionGeneration: 1,
						connectionStateToken: createDeploymentConnectionStateToken(instance),
						syncStrategy: "auto",
						managedCustomFormats: "[]",
						managedCustomFormatsCaptured: true,
					},
				]),
			},
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
			trashSyncHistory: { findMany: vi.fn().mockResolvedValue([]) },
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([]),
				create: vi.fn().mockResolvedValue({ id: "deployment-history-1" }),
			},
			trashBackup: { update: backupUpdate },
			trashCache: { findFirst: vi.fn().mockResolvedValue(null) },
			$transaction: vi.fn().mockRejectedValue(new Error("history unavailable")),
		};
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
			customFormat: { getAll: vi.fn().mockResolvedValue([]) },
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([profile]),
				getById: vi.fn().mockResolvedValue(profile),
			},
		};
		const executor = new DeploymentExecutorService(
			prisma as never,
			{ create: vi.fn().mockReturnValue(client) } as never,
		);
		const privateExecutor = executor as unknown as {
			validateAndPrepareDeployment: (...args: unknown[]) => Promise<unknown>;
			createBackupAndHistory: (...args: unknown[]) => Promise<unknown>;
			deployCustomFormats: (...args: unknown[]) => Promise<unknown>;
			syncQualityProfile: (...args: unknown[]) => Promise<unknown>;
			deployNamingPresets: (...args: unknown[]) => Promise<unknown>;
			executeSingleDeployment: (...args: unknown[]) => Promise<unknown>;
		};
		vi.spyOn(privateExecutor, "validateAndPrepareDeployment").mockResolvedValue({
			template: {
				id: "template-1",
				name: "Any",
				configData: "{}",
				instanceOverrides: null,
				sourceQualityProfileName: "Any",
			},
			instance,
			templateConfig: { namingSelection: { serviceType: "RADARR" } },
			templateCFs: [],
			overridesForInstance: {},
			effectiveQualityConfig: undefined,
			usingQualityOverride: false,
		} as never);
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
		vi.spyOn(privateExecutor, "syncQualityProfile").mockResolvedValue({
			errors: [],
			orphanedCFs: [],
			mutation: { action: "updated", profileId: 4, profileName: "Any" },
		} as never);
		vi.spyOn(privateExecutor, "deployNamingPresets").mockImplementation(
			async (_state, _instance, beforeWrite) => {
				await (beforeWrite as () => Promise<void>)();
				return { fieldsApplied: 1, postStateToken: "post-write-token" };
			},
		);

		const result = await privateExecutor.executeSingleDeployment(
			"template-1",
			"instance-1",
			"user-1",
		);

		expect(result).toMatchObject({
			success: false,
			status: "UNCERTAIN",
			namingFieldsApplied: 1,
			errors: [expect.stringContaining("rollback metadata could not be finalized")],
		});
		expect(backupUpdate).toHaveBeenCalledTimes(3);
		const finalPayload = backupUpdate.mock.calls[2]?.[0]?.data?.backupData;
		expect(JSON.parse(finalPayload).namingDeployment).toMatchObject({
			status: "applied",
			postStateToken: "post-write-token",
		});
	});
});
