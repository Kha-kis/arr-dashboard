import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createDeploymentConnectionStateToken,
	createDeploymentEndpointKey,
	createQualityProfileStateToken,
	createUpstreamResourceStateToken,
} from "../../../lib/trash-guides/deployment-target.js";
import {
	createInjectAuthenticated,
	registerTestErrorHandler,
	setupAuthInjection,
} from "../../__tests__/test-helpers.js";
import { registerSyncRoutes } from "../sync-routes.js";

const userId = "user-1";
const instance = {
	id: "instance-1",
	userId,
	label: "Radarr",
	service: "RADARR",
	baseUrl: "http://radarr:7878",
	encryptedApiKey: "encrypted-api-key",
	encryptionIv: "api-iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 2,
};

describe("sync rollback route", () => {
	let app: FastifyInstance;
	const callOrder: string[] = [];
	const profileUpdate = vi.fn();
	const formatDelete = vi.fn();
	const syncUpdate = vi.fn().mockResolvedValue({});
	const syncFindFirst = vi.fn();
	const deploymentFindMany = vi.fn();
	const formatGetAll = vi.fn();
	const formatGetById = vi.fn();
	const formatUpdate = vi.fn();
	let syncRecord: Record<string, unknown>;

	beforeEach(async () => {
		vi.resetAllMocks();
		const beforeProfile = { id: 4, name: "Profile", formatItems: [] };
		const deployedProfile = {
			id: 4,
			name: "Profile",
			formatItems: [{ format: 7, score: 100 }],
		};
		const deployedFormat = { id: 7, name: "Created CF", specifications: [] };
		const backupData = JSON.stringify({
			schemaVersion: 2,
			endpointKey: createDeploymentEndpointKey(userId, instance),
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			customFormats: [],
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 7,
					name: "Created CF",
					status: "applied",
					postStateToken: createUpstreamResourceStateToken(deployedFormat),
					intendedPostStateToken: null,
				},
			],
			managedCustomFormats: [],
			managedCustomFormatsCaptured: true,
			qualityProfileDeployment: {
				beforeProfile,
				status: "applied",
				action: "updated",
				profileId: 4,
				postStateToken: createQualityProfileStateToken(deployedProfile),
				intendedPostStateToken: createQualityProfileStateToken(deployedProfile),
			},
			namingDeployment: null,
		});
		const sync = {
			id: "sync-1",
			instanceId: instance.id,
			templateId: "template-1",
			userId,
			backupId: "backup-1",
			rolledBack: false,
			appliedConfigs: "[]",
			instance,
			template: { id: "template-1", userId },
			backup: { id: "backup-1", backupData },
			rollbackProgress: null,
		};
		syncRecord = sync;
		syncFindFirst.mockResolvedValue(syncRecord);
		const client = {
			qualityProfile: {
				getAll: vi.fn().mockResolvedValueOnce([deployedProfile]).mockResolvedValue([beforeProfile]),
				getById: vi.fn().mockResolvedValue(deployedProfile),
				update: profileUpdate.mockImplementation(async () => {
					callOrder.push("profile-restored");
				}),
			},
			customFormat: {
				getAll: formatGetAll.mockResolvedValue([deployedFormat]),
				getById: formatGetById.mockResolvedValue(deployedFormat),
				update: formatUpdate,
				delete: formatDelete.mockImplementation(async () => {
					callOrder.push("format-deleted");
				}),
			},
		};
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			trashSyncHistory: {
				findFirst: syncFindFirst,
				findMany: vi.fn().mockResolvedValue([]),
				update: syncUpdate,
			},
			templateDeploymentHistory: {
				findMany: deploymentFindMany.mockResolvedValue([
					{
						templateId: sync.templateId,
						backupId: sync.backupId,
						status: "SUCCESS",
						deployedAt: new Date("2026-01-01"),
						backup: sync.backup,
					},
				]),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: vi.fn().mockResolvedValue([instance]),
			},
			$transaction: vi.fn(async (callback) =>
				callback({
					trashSyncHistory: { update: syncUpdate },
					templateDeploymentHistory: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
				}),
			),
		};

		app = Fastify({ logger: false });
		setupAuthInjection(app);
		registerTestErrorHandler(app);
		app.decorate("prisma", prisma as never);
		app.decorate("arrClientFactory", {
			create: vi.fn().mockReturnValue(client),
			createConnectionCredentialIdentity: vi.fn().mockReturnValue("credential-1"),
		} as never);
		app.decorate("deploymentExecutor", {
			runWithEndpointMutation: vi.fn(async (_userId, target, _operation, callback) =>
				callback(createDeploymentEndpointKey(userId, target)),
			),
		} as never);
		await app.register(registerSyncRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		callOrder.length = 0;
		vi.clearAllMocks();
	});

	it("restores the quality profile before deleting referenced Custom Formats", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: true, restoredCount: 1, deletedCount: 1 });
		expect(callOrder).toEqual(["profile-restored", "format-deleted"]);
	});

	it("does not delete Custom Formats after quality profile restoration fails", async () => {
		profileUpdate.mockRejectedValueOnce(new Error("profile PUT failed"));

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, failedCount: 1 });
		expect(response.json().errors[0]).toContain("profile PUT failed");
		expect(formatDelete).not.toHaveBeenCalled();
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { id: "sync-1" },
			data: expect.objectContaining({
				rollbackStatus: "PARTIAL",
				rollbackProgress: expect.stringContaining("profile PUT failed"),
			}),
		});
	});

	it("resumes saved rollback progress without repeating completed mutations", async () => {
		syncRecord.rollbackProgress = JSON.stringify([
			{
				key: "custom_format:7",
				kind: "custom_format",
				name: "Created CF",
				outcome: "deleted",
			},
		]);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			restoredCount: 1,
			deletedCount: 1,
		});
		expect(profileUpdate).toHaveBeenCalledOnce();
		expect(formatDelete).not.toHaveBeenCalled();
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { id: "sync-1" },
			data: expect.objectContaining({
				rollbackStatus: "COMPLETED",
				rollbackProgress: expect.stringContaining('"key":"custom_format:7"'),
			}),
		});
	});

	it("unwinds the latest shared Custom Format write before preserving the survivor state", async () => {
		const olderSurvivorFormat = {
			id: 7,
			name: "Created CF",
			specifications: [{ name: "V0" }],
		};
		const survivorFormat = {
			id: 7,
			name: "Created CF",
			specifications: [{ name: "V1" }],
		};
		const targetFormat = {
			id: 7,
			name: "Created CF",
			specifications: [{ name: "V2" }],
		};
		const targetBackup = JSON.parse(
			(syncRecord.backup as { backupData: string }).backupData,
		) as Record<string, unknown> & { customFormatDeployments: Array<Record<string, unknown>> };
		targetBackup.customFormatDeployments = [
			{
				beforeFormat: survivorFormat,
				action: "updated",
				resourceId: 7,
				name: "Created CF",
				status: "applied",
				postStateToken: createUpstreamResourceStateToken(targetFormat),
				intendedPostStateToken: createUpstreamResourceStateToken(targetFormat),
			},
		];
		const targetBackupRecord = {
			id: "backup-1",
			backupData: JSON.stringify(targetBackup),
		};
		syncRecord.backup = targetBackupRecord;
		const survivorBackup = {
			...targetBackup,
			customFormatDeployments: [],
			managedCustomFormats: [
				{
					trashId: "shared-trash-id",
					name: "Created CF",
					resourceId: 7,
					stateToken: createUpstreamResourceStateToken(survivorFormat),
					profileId: 4,
					appliedScore: 100,
				},
			],
			qualityProfileDeployment: {
				beforeProfile: null,
				status: "not_started",
				action: "created",
				profileId: null,
				postStateToken: null,
				intendedPostStateToken: null,
			},
		};
		deploymentFindMany.mockResolvedValue([
			{
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-02"),
				backup: targetBackupRecord,
			},
			{
				templateId: "template-survivor",
				backupId: "backup-survivor",
				status: "SUCCESS",
				deployedAt: new Date("2026-01-01"),
				backup: { id: "backup-survivor", backupData: JSON.stringify(survivorBackup) },
			},
			{
				templateId: "template-older-survivor",
				backupId: "backup-older-survivor",
				status: "SUCCESS",
				deployedAt: new Date("2025-12-31"),
				backup: {
					id: "backup-older-survivor",
					backupData: JSON.stringify({
						...survivorBackup,
						managedCustomFormats: [
							{
								...survivorBackup.managedCustomFormats[0],
								stateToken: createUpstreamResourceStateToken(olderSurvivorFormat),
							},
						],
					}),
				},
			},
		]);
		formatGetAll.mockResolvedValue([targetFormat]);
		formatGetById
			.mockResolvedValueOnce(targetFormat)
			.mockResolvedValueOnce(targetFormat)
			.mockResolvedValueOnce(survivorFormat);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(true);
		expect(formatUpdate).toHaveBeenCalledWith(7, survivorFormat);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { id: "sync-1" },
			data: expect.objectContaining({
				rollbackProgress: expect.stringContaining(
					'"kind":"custom_format","name":"Created CF","outcome":"restored"',
				),
			}),
		});
	});
});
