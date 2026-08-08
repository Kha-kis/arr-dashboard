import { describe, expect, it, vi } from "vitest";
import { DeploymentPreviewService } from "../deployment-preview.js";
import {
	createDeploymentConnectionStateToken,
	createUpstreamResourceStateToken,
} from "../deployment-target.js";

describe("DeploymentPreviewService", () => {
	it("returns a non-deployable preview without resolving mappings when the instance is unreachable", async () => {
		const findAliases = vi.fn();
		const findMappings = vi.fn();
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({
					id: "template-1",
					userId: "user-1",
					name: "Radarr - Any",
					serviceType: "RADARR",
					sourceQualityProfileName: "Any",
					instanceOverrides: null,
					configData: JSON.stringify({
						customFormats: [
							{
								trashId: "cf-1",
								name: "Test CF",
								originalConfig: { trash_scores: { default: 100 } },
							},
						],
					}),
				}),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					id: "instance-1",
					userId: "user-1",
					label: "Radarr",
					service: "radarr",
					baseUrl: "http://radarr.invalid",
				}),
				findMany: findAliases,
			},
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: { findMany: findMappings },
		};
		const client = {
			system: { get: vi.fn().mockRejectedValue(new Error("connection refused")) },
			customFormat: { getAll: vi.fn() },
			qualityProfile: { getAll: vi.fn() },
		};
		const service = new DeploymentPreviewService(
			prisma as never,
			{ create: vi.fn().mockReturnValue(client) } as never,
			{ warn: vi.fn(), error: vi.fn() } as never,
		);

		const preview = await service.generatePreview("template-1", "instance-1", "user-1");

		expect(preview).toMatchObject({
			canDeploy: false,
			instanceReachable: false,
			executionToken: "",
			warnings: ["Instance is unreachable. Verify the service connection before deploying."],
			summary: {
				newCustomFormats: 0,
				updatedCustomFormats: 0,
				skippedCustomFormats: 1,
			},
		});
		expect(preview.customFormats).toEqual([
			expect.objectContaining({ name: "Test CF", action: "skip", scoreOverride: 100 }),
		]);
		expect(findAliases).not.toHaveBeenCalled();
		expect(findMappings).not.toHaveBeenCalled();
	});

	it("uses the equivalent endpoint mapping's sync strategy for an alias", async () => {
		const findMappings = vi.fn().mockResolvedValue([
			{
				templateId: "template-1",
				instanceId: "instance-primary",
				qualityProfileId: 1,
				qualityProfileName: "Any",
				syncStrategy: "auto",
				connectionGeneration: 0,
				connectionStateToken: null,
				managedCustomFormatsCaptured: true,
				managedCustomFormats: JSON.stringify([
					{
						trashId: "cf-1",
						name: "Test CF",
						resourceId: 42,
						stateToken: createUpstreamResourceStateToken({
							id: 42,
							name: "Test CF",
							specifications: [],
						}),
						profileId: 1,
						appliedScore: -10_000,
					},
				]),
			},
		]);
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({
					id: "template-1",
					userId: "user-1",
					name: "Radarr - Any",
					serviceType: "RADARR",
					sourceQualityProfileName: "Any",
					instanceOverrides: null,
					configData: JSON.stringify({
						customFormats: [
							{
								trashId: "cf-1",
								name: "Test CF",
								originalConfig: { specifications: [], trash_scores: { default: 100 } },
							},
						],
					}),
				}),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue({
					id: "instance-alias",
					userId: "user-1",
					label: "Radarr Alias",
					service: "radarr",
					baseUrl: "http://radarr/",
				}),
				findMany: vi.fn().mockResolvedValue([
					{ id: "instance-primary", service: "radarr", baseUrl: "http://radarr" },
					{ id: "instance-alias", service: "radarr", baseUrl: "http://radarr/" },
				]),
			},
			instanceQualityProfileOverride: {
				findMany: vi
					.fn()
					.mockResolvedValue([
						{ instanceId: "instance-primary", customFormatId: 42, score: -10_000 },
					]),
			},
			templateQualityProfileMapping: {
				findMany: findMappings,
			},
			templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		};
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
			customFormat: {
				getAll: vi.fn().mockResolvedValue([{ id: 42, name: "Test CF", specifications: [] }]),
			},
			qualityProfile: {
				getAll: vi
					.fn()
					.mockResolvedValue([
						{ id: 1, name: "Any", formatItems: [{ format: 42, score: -10_000 }] },
					]),
				getById: vi.fn().mockResolvedValue({
					id: 1,
					name: "Any",
					formatItems: [{ format: 42, score: -10_000 }],
				}),
			},
		};
		const service = new DeploymentPreviewService(
			prisma as never,
			{ create: vi.fn().mockReturnValue(client) } as never,
			{ warn: vi.fn(), error: vi.fn() } as never,
		);

		const preview = await service.generatePreview("template-1", "instance-alias", "user-1");

		expect(preview.existingSyncStrategy).toBe("auto");
		expect(preview.warnings).toContainEqual(expect.stringContaining("2.x deployment mapping"));
		expect(preview.customFormats[0]).toMatchObject({
			name: "Test CF",
			instanceOverrideScore: -10_000,
			scoreOverride: -10_000,
		});
		expect(findMappings).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					OR: expect.arrayContaining([
						{
							instanceId: "instance-primary",
							connectionGeneration: 0,
							connectionStateToken: expect.any(String),
						},
					]),
				},
			}),
		);
	});

	it("counts and describes an exact previously managed score reset as deployable work", async () => {
		const instance = {
			id: "instance-1",
			userId: "user-1",
			label: "Radarr",
			service: "RADARR",
			baseUrl: "http://radarr",
			encryptedApiKey: "encrypted",
			encryptionIv: "iv",
			encryptedHttpAuthCredentials: null,
			httpAuthEncryptionIv: null,
			connectionGeneration: 3,
		};
		const format = { id: 42, name: "Removed from template", specifications: [] };
		const profile = {
			id: 1,
			name: "Any",
			formatItems: [{ format: 42, score: 75 }],
		};
		const previousBackup = JSON.stringify({
			schemaVersion: 2,
			endpointKey: "endpoint",
			connectionStateToken: "connection",
			customFormats: [],
			customFormatDeployments: [],
			managedCustomFormats: [
				{
					trashId: "removed-trash-id",
					name: format.name,
					resourceId: 42,
					stateToken: createUpstreamResourceStateToken(format),
					profileId: 1,
					appliedScore: 75,
				},
			],
			managedCustomFormatsCaptured: true,
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "not_started",
				action: "created",
				profileId: null,
				postStateToken: null,
			},
			namingDeployment: null,
		});
		const prisma = {
			trashTemplate: {
				findUnique: vi.fn().mockResolvedValue({
					id: "template-1",
					userId: "user-1",
					name: "Any",
					serviceType: "RADARR",
					sourceQualityProfileName: "Any",
					instanceOverrides: null,
					configData: JSON.stringify({ customFormats: [] }),
				}),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: vi.fn().mockResolvedValue([instance]),
			},
			instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
			templateQualityProfileMapping: {
				findMany: vi.fn().mockResolvedValue([
					{
						templateId: "template-1",
						instanceId: instance.id,
						qualityProfileId: 1,
						qualityProfileName: "Any",
						syncStrategy: "manual",
						connectionGeneration: instance.connectionGeneration,
						connectionStateToken: createDeploymentConnectionStateToken(instance),
						managedCustomFormatsCaptured: true,
						managedCustomFormats: JSON.stringify(JSON.parse(previousBackup).managedCustomFormats),
					},
				]),
			},
			templateDeploymentHistory: {
				findMany: vi.fn().mockResolvedValue([
					{
						status: "SUCCESS",
						appliedConfigs: "[]",
						backup: { backupData: previousBackup },
					},
				]),
			},
		};
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
			customFormat: {
				getAll: vi.fn().mockResolvedValue([format]),
				getById: vi.fn().mockResolvedValue(format),
			},
			qualityProfile: {
				getAll: vi.fn().mockResolvedValue([profile]),
				getById: vi.fn().mockResolvedValue(profile),
			},
		};
		const service = new DeploymentPreviewService(
			prisma as never,
			{
				create: vi.fn().mockReturnValue(client),
				createConnectionCredentialIdentity: vi.fn().mockReturnValue("credential"),
			} as never,
			{ warn: vi.fn(), error: vi.fn() } as never,
		);

		const preview = await service.generatePreview("template-1", instance.id, "user-1");

		expect(preview.summary).toMatchObject({ totalItems: 1, orphanedCustomFormats: 1 });
		expect(preview.orphanedCustomFormats).toEqual([
			{ instanceId: 42, name: "Removed from template", score: 75 },
		]);
		expect(preview.canDeploy).toBe(true);
	});
});
