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
	credentialIdentity: "credential-1",
};

function qualityProfile(formatItems: Array<{ format: number; score: number }>) {
	return {
		id: 4,
		name: "Profile",
		upgradeAllowed: true,
		cutoff: 1,
		items: [],
		minFormatScore: 0,
		cutoffFormatScore: 0,
		minUpgradeFormatScore: 0,
		formatItems,
	};
}

describe("sync rollback route", () => {
	let app: FastifyInstance;
	const callOrder: string[] = [];
	const profileUpdate = vi.fn();
	const formatDelete = vi.fn();
	const syncUpdate = vi.fn().mockResolvedValue({});
	const syncFindFirst = vi.fn();
	const deploymentFindMany = vi.fn();
	const deploymentUpdateMany = vi.fn();
	const formatGetAll = vi.fn();
	const formatGetById = vi.fn();
	const formatUpdate = vi.fn();
	const profileGetById = vi.fn();
	const rawRequest = vi.fn();
	let syncRecord: Record<string, unknown>;

	beforeEach(async () => {
		vi.resetAllMocks();
		const beforeProfile = qualityProfile([]);
		const deployedProfile = qualityProfile([{ format: 7, score: 100 }]);
		const beforeFormat = {
			id: 7,
			name: "Updated CF",
			specifications: [],
			includeCustomFormatWhenRenaming: false,
		};
		const deployedFormat = {
			...beforeFormat,
			includeCustomFormatWhenRenaming: true,
		};
		const backupData = JSON.stringify({
			schemaVersion: 2,
			endpointKey: createDeploymentEndpointKey(userId, instance),
			connectionStateToken: createDeploymentConnectionStateToken(instance),
			customFormats: [],
			customFormatDeployments: [
				{
					beforeFormat,
					action: "updated",
					resourceId: 7,
					name: "Updated CF",
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
				getById: profileGetById
					.mockResolvedValueOnce(deployedProfile)
					.mockResolvedValue(beforeProfile),
				update: profileUpdate.mockImplementation(async () => {
					callOrder.push("profile-restored");
				}),
			},
			customFormat: {
				getAll: formatGetAll.mockResolvedValue([deployedFormat]),
				getById: formatGetById.mockResolvedValue(deployedFormat),
				update: formatUpdate.mockImplementation(async () => {
					callOrder.push("format-restored");
				}),
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
				updateMany: syncUpdate,
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
					trashSyncHistory: { update: syncUpdate, updateMany: syncUpdate },
					templateDeploymentHistory: {
						updateMany: deploymentUpdateMany.mockResolvedValue({ count: 1 }),
					},
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
			rawRequest,
		} as never);
		app.decorate("deploymentExecutor", {
			runWithEndpointMutation: vi.fn(async (_userId, target, _operation, callback) =>
				callback(
					createDeploymentEndpointKey(userId, {
						service: target.service,
						baseUrl: target.baseUrl,
						credentialIdentity: "credential-1",
					}),
				),
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

	it("acknowledges a backup-less uncertain sync only after explicit review", async () => {
		syncRecord = {
			...syncRecord,
			status: "UNCERTAIN",
			backupId: null,
			backup: null,
			errorLog: "The application restarted before a deployment ledger was linked.",
		};
		syncFindFirst.mockResolvedValue(syncRecord);
		syncUpdate.mockResolvedValue({ count: 1 });

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/acknowledge-review");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			status: "FAILED",
			message: expect.stringContaining("acknowledged"),
		});
		expect(syncUpdate).toHaveBeenCalledWith({
			where: {
				id: "sync-1",
				userId,
				status: "UNCERTAIN",
				backupId: null,
			},
			data: expect.objectContaining({
				status: "FAILED",
				errorLog: expect.stringContaining("Manual review acknowledged"),
			}),
		});
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
	});

	it("refuses to acknowledge a sync that has rollback evidence", async () => {
		syncRecord = { ...syncRecord, status: "UNCERTAIN" };
		syncFindFirst.mockResolvedValue(syncRecord);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/acknowledge-review");

		expect(response.statusCode, response.body).toBe(409);
		expect(response.json()).toMatchObject({ error: "REVIEW_NOT_ACKNOWLEDGEABLE" });
		expect(syncUpdate).not.toHaveBeenCalled();
	});

	it("fails closed if the uncertain sync changes during acknowledgement", async () => {
		syncRecord = {
			...syncRecord,
			status: "UNCERTAIN",
			backupId: null,
			backup: null,
		};
		syncFindFirst.mockResolvedValue(syncRecord);
		syncUpdate.mockResolvedValue({ count: 0 });

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/acknowledge-review");

		expect(response.statusCode, response.body).toBe(409);
		expect(response.json()).toMatchObject({ error: "REVIEW_STATE_CHANGED" });
	});

	it("refuses a legacy raw-array backup without durable endpoint and resource identity", async () => {
		const restoredFormat = {
			id: 7,
			name: "Updated CF",
			specifications: [],
			includeCustomFormatWhenRenaming: false,
		};
		(syncRecord.backup as { backupData: string }).backupData = JSON.stringify([restoredFormat]);
		formatGetAll.mockResolvedValue([{ ...restoredFormat, includeCustomFormatWhenRenaming: true }]);
		formatGetById.mockResolvedValue(restoredFormat);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode, response.body).toBe(409);
		expect(response.json()).toMatchObject({ error: "LEGACY_BACKUP_UNVERIFIED" });
		expect(formatUpdate).not.toHaveBeenCalled();
	});

	it("refuses a legacy object backup without durable endpoint and resource identity", async () => {
		const restoredProfile = qualityProfile([]);
		(syncRecord.backup as { backupData: string }).backupData = JSON.stringify({
			customFormats: [],
			qualityProfile: restoredProfile,
		});
		formatGetAll.mockResolvedValue([]);
		profileGetById.mockReset().mockResolvedValue(restoredProfile);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode, response.body).toBe(409);
		expect(response.json()).toMatchObject({ error: "LEGACY_BACKUP_UNVERIFIED" });
		expect(profileUpdate).not.toHaveBeenCalled();
	});

	it("restores the quality profile before restoring referenced Custom Formats", async () => {
		formatGetById
			.mockResolvedValueOnce({
				id: 7,
				name: "Updated CF",
				specifications: [],
				includeCustomFormatWhenRenaming: true,
			})
			.mockResolvedValue({
				id: 7,
				name: "Updated CF",
				specifications: [],
				includeCustomFormatWhenRenaming: false,
			});
		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: true, restoredCount: 2, deletedCount: 0 });
		expect(callOrder).toEqual(["profile-restored", "format-restored"]);
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ undeployStatus: "COMPLETED" }) }),
		);
	});

	it.each([
		["wrapper-sync", "child-sync"],
		["child-sync", "wrapper-sync"],
	])("rolls back both histories through %s and makes %s idempotent", async (entryId, siblingId) => {
		formatGetById
			.mockReset()
			.mockResolvedValueOnce({
				id: 7,
				name: "Updated CF",
				specifications: [],
				includeCustomFormatWhenRenaming: true,
			})
			.mockResolvedValue({
				id: 7,
				name: "Updated CF",
				specifications: [],
				includeCustomFormatWhenRenaming: false,
			});
		const rows = new Map<string, Record<string, unknown>>(
			["wrapper-sync", "child-sync"].map((id) => [
				id,
				{
					...syncRecord,
					id,
					rolledBack: false,
					rolledBackAt: null,
					rollbackStatus: null,
					rollbackProgress: null,
				},
			]),
		);
		syncFindFirst.mockImplementation(async ({ where }) => rows.get(where.id) ?? null);
		syncUpdate.mockImplementation(async ({ where, data }) => {
			let count = 0;
			for (const row of rows.values()) {
				if (
					row.backupId === where.backupId &&
					row.userId === where.userId &&
					row.rolledBack === where.rolledBack
				) {
					Object.assign(row, data);
					count++;
				}
			}
			return { count };
		});

		const response = await createInjectAuthenticated(app)("POST", `/${entryId}/rollback`);

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json(), response.body).toMatchObject({ success: true });
		expect(rows.get("wrapper-sync")).toMatchObject({
			rolledBack: true,
			rollbackStatus: "COMPLETED",
		});
		expect(rows.get("child-sync")).toMatchObject({
			rolledBack: true,
			rollbackStatus: "COMPLETED",
		});

		profileUpdate.mockClear();
		formatUpdate.mockClear();
		const retry = await createInjectAuthenticated(app)("POST", `/${siblingId}/rollback`);
		expect(retry.statusCode).toBe(400);
		expect(retry.json()).toMatchObject({ error: "ALREADY_ROLLED_BACK" });
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
	});

	it("uses the fresh leased sync row instead of a stale pre-lock snapshot", async () => {
		syncFindFirst
			.mockResolvedValueOnce(syncRecord)
			.mockResolvedValueOnce({ ...syncRecord, rolledBack: true });

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({ error: "ALREADY_ROLLED_BACK" });
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
	});

	it("does not delete Custom Formats after quality profile restoration fails", async () => {
		profileUpdate.mockRejectedValueOnce(new Error("profile PUT failed"));

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, failedCount: 1 });
		expect(response.json().errors[0]).toContain("profile PUT failed");
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ undeployStatus: "PARTIAL" }) }),
		);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { backupId: "backup-1", userId, rolledBack: false },
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
				name: "Updated CF",
				outcome: "restored",
			},
		]);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			restoredCount: 2,
			deletedCount: 0,
		});
		expect(profileUpdate).toHaveBeenCalledOnce();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { backupId: "backup-1", userId, rolledBack: false },
			data: expect.objectContaining({
				rollbackStatus: "COMPLETED",
				rollbackProgress: expect.stringContaining('"key":"custom_format:7"'),
			}),
		});
	});

	it("fails closed when an unknown naming write may have overwritten a surviving deployment", async () => {
		const targetNaming = { id: 1, standardMovieFormat: "Possibly overwritten" };
		const survivorNaming = { id: 1, standardMovieFormat: "Survivor" };
		const targetBackup = JSON.parse(
			(syncRecord.backup as { backupData: string }).backupData,
		) as Record<string, unknown>;
		targetBackup.customFormatDeployments = [];
		targetBackup.managedCustomFormats = [];
		targetBackup.qualityProfileDeployment = {
			beforeProfile: null,
			status: "not_started",
			action: "created",
			profileId: null,
			profileName: null,
			postStateToken: null,
			intendedPostStateToken: null,
		};
		targetBackup.namingDeployment = {
			beforeConfig: { id: 1, standardMovieFormat: "Before" },
			status: "pending",
			postStateToken: null,
			intendedPostStateToken: null,
		};
		const targetBackupRecord = { id: "backup-1", backupData: JSON.stringify(targetBackup) };
		syncRecord.backup = targetBackupRecord;
		const survivorBackup = {
			...targetBackup,
			namingDeployment: {
				beforeConfig: { id: 1, standardMovieFormat: "Older" },
				status: "applied",
				postStateToken: createUpstreamResourceStateToken(survivorNaming),
				intendedPostStateToken: createUpstreamResourceStateToken(survivorNaming),
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
		]);
		rawRequest.mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue(targetNaming),
		});

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, failedCount: 1 });
		expect(response.json().errors[0]).toContain("post-deployment state was not verified");
		expect(rawRequest).toHaveBeenCalledWith(instance, "/api/v3/config/naming");
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { backupId: "backup-1", userId, rolledBack: false },
			data: expect.objectContaining({ rollbackStatus: "PARTIAL" }),
		});
	});

	it("accepts an unknown naming write only when current ARR state matches the survivor", async () => {
		const survivorNaming = { id: 1, standardMovieFormat: "Survivor" };
		const targetBackup = JSON.parse(
			(syncRecord.backup as { backupData: string }).backupData,
		) as Record<string, unknown>;
		targetBackup.customFormatDeployments = [];
		targetBackup.managedCustomFormats = [];
		targetBackup.qualityProfileDeployment = {
			beforeProfile: null,
			status: "not_started",
			action: "created",
			profileId: null,
			profileName: null,
			postStateToken: null,
			intendedPostStateToken: null,
		};
		targetBackup.namingDeployment = {
			beforeConfig: { id: 1, standardMovieFormat: "Before" },
			status: "pending",
			postStateToken: null,
			intendedPostStateToken: null,
		};
		const targetBackupRecord = { id: "backup-1", backupData: JSON.stringify(targetBackup) };
		syncRecord.backup = targetBackupRecord;
		const survivorBackup = {
			...targetBackup,
			namingDeployment: {
				beforeConfig: { id: 1, standardMovieFormat: "Older" },
				status: "applied",
				postStateToken: createUpstreamResourceStateToken(survivorNaming),
				intendedPostStateToken: createUpstreamResourceStateToken(survivorNaming),
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
		]);
		rawRequest.mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue(survivorNaming),
		});

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			failedCount: 0,
			skippedSharedCount: 1,
		});
		expect(rawRequest).not.toHaveBeenCalledWith(
			instance,
			"/api/v3/config/naming",
			expect.objectContaining({ method: "PUT" }),
		);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { backupId: "backup-1", userId, rolledBack: false },
			data: expect.objectContaining({ rollbackStatus: "COMPLETED" }),
		});
	});

	it("unwinds the latest shared Custom Format write before preserving the survivor state", async () => {
		const olderSurvivorFormat = {
			id: 7,
			name: "Created CF",
			specifications: [],
			includeCustomFormatWhenRenaming: null,
		};
		const survivorFormat = {
			id: 7,
			name: "Created CF",
			specifications: [],
			includeCustomFormatWhenRenaming: false,
		};
		const targetFormat = {
			id: 7,
			name: "Created CF",
			specifications: [],
			includeCustomFormatWhenRenaming: true,
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
			.mockResolvedValueOnce(survivorFormat)
			.mockResolvedValueOnce(survivorFormat);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(true);
		expect(formatUpdate).toHaveBeenCalledWith(7, survivorFormat);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: { backupId: "backup-1", userId, rolledBack: false },
			data: expect.objectContaining({
				rollbackProgress: expect.stringContaining(
					'"kind":"custom_format","name":"Created CF","outcome":"restored"',
				),
			}),
		});
	});
});
