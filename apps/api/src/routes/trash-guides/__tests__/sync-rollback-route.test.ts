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

function pairedSyncState(overrides: Record<string, unknown> = {}) {
	return {
		id: "sync-paired",
		userId,
		instanceId: instance.id,
		templateId: "template-1",
		backupId: "backup-1",
		status: "SUCCESS",
		rolledBack: false,
		rollbackStatus: null,
		rollbackAttemptedAt: null,
		rollbackProgress: null,
		...overrides,
	};
}

function pairedDeploymentState(overrides: Record<string, unknown> = {}) {
	return {
		id: "deployment-paired",
		userId,
		instanceId: instance.id,
		templateId: "template-1",
		backupId: "backup-1",
		status: "SUCCESS",
		rolledBack: false,
		undeployStatus: null,
		undeployAttemptedAt: null,
		undeployProgress: null,
		...overrides,
	};
}

describe("sync rollback route", () => {
	let app: FastifyInstance;
	const callOrder: string[] = [];
	const profileUpdate = vi.fn();
	const formatDelete = vi.fn();
	const syncUpdate = vi.fn().mockResolvedValue({});
	const syncFindFirst = vi.fn();
	const syncFindMany = vi.fn();
	const deploymentFindMany = vi.fn();
	const deploymentUpdateMany = vi.fn();
	const formatGetAll = vi.fn();
	const formatGetById = vi.fn();
	const formatUpdate = vi.fn();
	const profileGetById = vi.fn();
	const profileGetAll = vi.fn();
	const rawRequest = vi.fn();
	const cleanupUpdateMany = vi.fn();
	const transaction = vi.fn();
	let syncRecord: Record<string, unknown>;
	const mockDeploymentOwnershipRows = (rows: Record<string, unknown>[]) => {
		deploymentFindMany.mockImplementation(async (args) =>
			args.select?.id && !args.select?.undeployStatus
				? [{ id: "deployment-paired" }]
				: args.select?.undeployProgress
					? [pairedDeploymentState()]
					: rows,
		);
	};

	beforeEach(async () => {
		vi.resetAllMocks();
		syncUpdate.mockResolvedValue({ count: 1 });
		deploymentUpdateMany.mockResolvedValue({ count: 1 });
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
			status: "SUCCESS",
			rolledBack: false,
			appliedConfigs: "[]",
			instance,
			template: { id: "template-1", userId },
			backup: { id: "backup-1", backupData },
			rollbackStatus: null,
			rollbackAttemptedAt: null,
			rollbackProgress: null,
		};
		syncRecord = sync;
		syncFindFirst.mockResolvedValue(syncRecord);
		const client = {
			qualityProfile: {
				getAll: profileGetAll
					.mockResolvedValueOnce([deployedProfile])
					.mockResolvedValue([beforeProfile]),
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
				updateMany: cleanupUpdateMany.mockResolvedValue({ count: 1 }),
			},
			trashSyncHistory: {
				findFirst: syncFindFirst,
				findMany: syncFindMany.mockResolvedValue([]),
				update: syncUpdate,
				updateMany: syncUpdate,
			},
			templateDeploymentHistory: {
				findMany: deploymentFindMany.mockResolvedValue([
					{
						id: "deployment-paired",
						userId,
						instanceId: instance.id,
						templateId: sync.templateId,
						backupId: sync.backupId,
						status: "SUCCESS",
						rolledBack: false,
						undeployStatus: null,
						undeployAttemptedAt: null,
						undeployProgress: null,
						deployedAt: new Date("2026-01-01"),
						backup: sync.backup,
					},
				]),
			},
			serviceInstance: {
				findFirst: vi.fn().mockResolvedValue(instance),
				findMany: vi.fn().mockResolvedValue([instance]),
			},
			$transaction: transaction.mockImplementation(async (callback) =>
				callback({
					trashSyncHistory: { update: syncUpdate, updateMany: syncUpdate },
					templateDeploymentHistory: {
						updateMany: deploymentUpdateMany,
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

	it("acquires the topology lease before claiming a rollback", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode, response.body).toBe(200);
		const acquireIndexes = cleanupUpdateMany.mock.calls.flatMap(([args], index) =>
			args.data.runClaimToken ? [index] : [],
		);
		const releaseIndexes = cleanupUpdateMany.mock.calls.flatMap(([args], index) =>
			args.data.runClaimToken === null ? [index] : [],
		);
		expect(acquireIndexes).toHaveLength(1);
		expect(releaseIndexes).toHaveLength(1);
		const finalWriteIndex = syncUpdate.mock.calls.findIndex(
			([args]) => args.data.rollbackStatus === "PARTIAL",
		);
		expect(finalWriteIndex).toBeGreaterThanOrEqual(0);
		expect(cleanupUpdateMany.mock.invocationCallOrder[acquireIndexes[0]!]).toBeLessThan(
			syncUpdate.mock.invocationCallOrder[0]!,
		);
		expect(syncUpdate.mock.invocationCallOrder[finalWriteIndex]).toBeLessThan(
			cleanupUpdateMany.mock.invocationCallOrder[releaseIndexes[0]!]!,
		);
	});

	it("uses the exact claim timestamp for paired rollback progress", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode, response.body).toBe(200);
		const claimTimestamp = syncUpdate.mock.calls.find(
			([call]) => call.data?.rollbackStatus === "IN_PROGRESS" && !call.data.rollbackProgress,
		)?.[0].data.rollbackAttemptedAt;
		const pairedTimestamp = deploymentUpdateMany.mock.calls.find(
			([call]) => call.data?.undeployStatus === "IN_PROGRESS",
		)?.[0].data.undeployAttemptedAt;
		expect(pairedTimestamp).toBe(claimTimestamp);
	});

	it("refuses a rollback claim when paired deployment history disappears before the lease", async () => {
		deploymentFindMany
			.mockReset()
			.mockResolvedValueOnce([{ id: "deployment-paired" }])
			.mockResolvedValueOnce([]);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ error: "ROLLBACK_HISTORY_CHANGED" });
		expect(syncUpdate).not.toHaveBeenCalled();
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
	});

	it.each([
		["already active", false, "IN_PROGRESS"],
		["already completed", true, "COMPLETED"],
	])(
		"rejects paired deployment history that is %s before claiming the group",
		async (_case, rolledBack, undeployStatus) => {
			deploymentFindMany.mockImplementation(async (args) =>
				args.select?.id && !args.select?.undeployStatus
					? [{ id: "deployment-paired" }]
					: [
							{
								id: "deployment-paired",
								status: "SUCCESS",
								rolledBack,
								undeployStatus,
								undeployAttemptedAt: new Date("2026-08-08T12:00:00.000Z"),
								undeployProgress: "[]",
							},
						],
			);

			const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

			expect(response.statusCode).toBe(409);
			expect(response.json()).toMatchObject({ error: "ROLLBACK_HISTORY_CONFLICT" });
			expect(transaction).not.toHaveBeenCalled();
			expect(profileUpdate).not.toHaveBeenCalled();
		},
	);

	it("rejects a terminal paired sync before claiming the group", async () => {
		syncFindMany.mockImplementation(async (args) =>
			args.select?.rollbackProgress
				? [
						{
							id: "sync-terminal",
							rolledBack: true,
							rollbackStatus: "COMPLETED",
							rollbackAttemptedAt: new Date("2026-08-08T12:00:00.000Z"),
							rollbackProgress: "[]",
						},
					]
				: [],
		);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ error: "ROLLBACK_HISTORY_CONFLICT" });
		expect(transaction).not.toHaveBeenCalled();
		expect(profileUpdate).not.toHaveBeenCalled();
	});

	it("rolls back the whole claim when a paired deployment CAS misses", async () => {
		deploymentUpdateMany.mockResolvedValueOnce({ count: 0 });

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(409);
		expect(response.json()).toMatchObject({ error: "ROLLBACK_HISTORY_CONFLICT" });
		expect(transaction).toHaveBeenCalledOnce();
		expect(profileUpdate).not.toHaveBeenCalled();
	});

	it("restores every paired recovery row after a late pre-write persistence failure", async () => {
		const priorSyncAttemptedAt = new Date("2026-08-08T12:00:00.000Z");
		const priorSyncProgress = JSON.stringify([{ key: "sync-prior", outcome: "restored" }]);
		const priorUndeployAttemptedAt = new Date("2026-08-08T12:05:00.000Z");
		const priorUndeployProgress = JSON.stringify([
			{ key: "deployment-prior", outcome: "restored" },
		]);
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
		rawRequest.mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue(survivorNaming),
		});
		syncFindMany.mockImplementation(async (args) =>
			args.select?.rollbackProgress
				? [
						pairedSyncState({
							rollbackStatus: "PARTIAL",
							rollbackAttemptedAt: priorSyncAttemptedAt,
							rollbackProgress: priorSyncProgress,
						}),
					]
				: [],
		);
		deploymentFindMany.mockImplementation(async (args) =>
			args.select?.id && !args.select?.undeployStatus
				? [{ id: "deployment-paired" }]
				: args.select?.undeployProgress
					? [
							pairedDeploymentState({
								undeployStatus: "PARTIAL",
								undeployAttemptedAt: priorUndeployAttemptedAt,
								undeployProgress: priorUndeployProgress,
							}),
						]
					: [
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
						],
		);
		transaction
			.mockReset()
			.mockImplementationOnce(async (callback) =>
				callback({
					trashSyncHistory: { update: syncUpdate, updateMany: syncUpdate },
					templateDeploymentHistory: { updateMany: deploymentUpdateMany },
				}),
			)
			.mockRejectedValueOnce(new Error("late rollback progress write failed"))
			.mockImplementationOnce(async (callback) =>
				callback({
					trashSyncHistory: { update: syncUpdate, updateMany: syncUpdate },
					templateDeploymentHistory: { updateMany: deploymentUpdateMany },
				}),
			);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(500);
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
		expect(transaction).toHaveBeenCalledTimes(3);
		const claimTimestamp = syncUpdate.mock.calls[0]?.[0].data.rollbackAttemptedAt;
		expect(syncUpdate).toHaveBeenCalledWith({
			where: {
				id: "sync-paired",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: claimTimestamp,
			},
			data: {
				rollbackStatus: "PARTIAL",
				rollbackAttemptedAt: priorSyncAttemptedAt,
				rollbackProgress: priorSyncProgress,
			},
		});
		expect(deploymentUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "deployment-paired",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: claimTimestamp,
			},
			data: {
				status: "SUCCESS",
				undeployStatus: "PARTIAL",
				undeployAttemptedAt: priorUndeployAttemptedAt,
				undeployProgress: priorUndeployProgress,
			},
		});
	});

	it("marks every paired recovery row partial after a mutation-attempt persistence failure", async () => {
		syncFindMany.mockImplementation(async (args) =>
			args.select?.rollbackProgress ? [pairedSyncState()] : [],
		);
		const ownershipHistory = {
			templateId: "template-1",
			backupId: "backup-1",
			status: "SUCCESS",
			deployedAt: new Date("2026-01-01"),
			backup: (syncRecord as { backup: unknown }).backup,
		};
		deploymentFindMany.mockImplementation(async (args) =>
			args.select?.id && !args.select?.undeployStatus
				? [{ id: "deployment-paired" }]
				: args.select?.undeployProgress
					? [pairedDeploymentState()]
					: [ownershipHistory],
		);
		transaction
			.mockReset()
			.mockImplementationOnce(async (callback) =>
				callback({
					trashSyncHistory: { update: syncUpdate, updateMany: syncUpdate },
					templateDeploymentHistory: { updateMany: deploymentUpdateMany },
				}),
			)
			.mockImplementationOnce(async (callback) =>
				callback({
					trashSyncHistory: { update: syncUpdate, updateMany: syncUpdate },
					templateDeploymentHistory: { updateMany: deploymentUpdateMany },
				}),
			)
			.mockRejectedValueOnce(new Error("post-write rollback progress failed"))
			.mockImplementationOnce(async (callback) =>
				callback({
					trashSyncHistory: { update: syncUpdate, updateMany: syncUpdate },
					templateDeploymentHistory: { updateMany: deploymentUpdateMany },
				}),
			);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(207);
		const claimTimestamp = syncUpdate.mock.calls[0]?.[0].data.rollbackAttemptedAt;
		expect(syncUpdate).toHaveBeenCalledWith({
			where: {
				id: "sync-paired",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: claimTimestamp,
			},
			data: { rollbackStatus: "PARTIAL" },
		});
		expect(deploymentUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "deployment-paired",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: claimTimestamp,
			},
			data: { status: "PARTIAL_UNDEPLOY", undeployStatus: "PARTIAL" },
		});
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

	it.each([
		"not-json",
		JSON.stringify(["Created CF"]),
		JSON.stringify([{ name: 42, action: "created" }]),
		JSON.stringify([{ name: "Created CF", action: "removed" }]),
	])("rejects invalid rollback ownership evidence before upstream work: %s", async (evidence) => {
		syncRecord.appliedConfigs = evidence;

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(500);
		expect(response.json()).toMatchObject({
			error: "ROLLBACK_FAILED",
			message: expect.stringContaining("ownership evidence is invalid"),
		});
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
		expect(syncUpdate).toHaveBeenLastCalledWith({
			where: {
				id: "sync-1",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: expect.any(Date),
			},
			data: {
				rollbackStatus: null,
				rollbackAttemptedAt: null,
				rollbackProgress: null,
			},
		});
	});

	it("restores prior PARTIAL rollback state when a retry fails before mutation", async () => {
		const priorAttemptedAt = new Date("2026-08-08T12:05:00.000Z");
		const priorProgress = JSON.stringify([
			{
				key: "custom_format:7",
				kind: "custom_format",
				name: "Updated CF",
				outcome: "restored",
			},
		]);
		syncRecord = {
			...syncRecord,
			rollbackStatus: "PARTIAL",
			rollbackAttemptedAt: priorAttemptedAt,
			rollbackProgress: priorProgress,
			appliedConfigs: "not-json",
		};
		syncFindFirst.mockResolvedValue(syncRecord);

		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(500);
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
		expect(syncUpdate).toHaveBeenLastCalledWith({
			where: {
				id: "sync-1",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
				rollbackAttemptedAt: expect.any(Date),
			},
			data: {
				rollbackStatus: "PARTIAL",
				rollbackAttemptedAt: priorAttemptedAt,
				rollbackProgress: priorProgress,
			},
		});
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

	it("records an already-restored profile before refusing an unconditional Custom Format restore", async () => {
		profileGetById.mockReset().mockResolvedValue(qualityProfile([]));
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
		expect(response.json()).toMatchObject({
			success: false,
			restoredCount: 1,
			deletedCount: 0,
			failedCount: 1,
		});
		expect(response.json().errors[0]).toContain("no conditional update");
		expect(callOrder).toEqual([]);
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ undeployStatus: "PARTIAL" }) }),
		);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: "sync-1",
				userId,
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
			}),
			data: expect.objectContaining({
				rollbackStatus: "PARTIAL",
				rollbackProgress: expect.stringContaining(
					'"kind":"custom_format","name":"Updated CF","outcome":"failed"',
				),
			}),
		});
	});

	it.each([
		["wrapper-sync", "child-sync"],
		["child-sync", "wrapper-sync"],
	])(
		"records partial progress through %s, resumes through %s, and makes completion idempotent",
		async (entryId, siblingId) => {
			profileGetById.mockReset().mockResolvedValue(qualityProfile([]));
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
			syncFindMany.mockImplementation(async (args) =>
				args.select?.rollbackProgress
					? [...rows.values()].map((row) => ({
							id: row.id,
							userId: row.userId,
							instanceId: row.instanceId,
							templateId: row.templateId,
							backupId: row.backupId,
							status: row.status,
							rolledBack: row.rolledBack,
							rollbackStatus: row.rollbackStatus,
							rollbackAttemptedAt: row.rollbackAttemptedAt ?? null,
							rollbackProgress: row.rollbackProgress,
						}))
					: [],
			);
			syncUpdate.mockImplementation(async ({ where, data }) => {
				let count = 0;
				for (const row of rows.values()) {
					const matchesIdentity = where.id ? row.id === where.id : row.backupId === where.backupId;
					const matchesRollbackStatus =
						where.rollbackStatus === undefined || row.rollbackStatus === where.rollbackStatus;
					const matchesClaimStatus =
						where.OR === undefined ||
						where.OR.some(
							(clause: { rollbackStatus: string | null }) =>
								row.rollbackStatus === clause.rollbackStatus,
						);
					if (
						matchesIdentity &&
						row.userId === where.userId &&
						(where.rolledBack === undefined || row.rolledBack === where.rolledBack) &&
						matchesRollbackStatus &&
						matchesClaimStatus
					) {
						Object.assign(row, data);
						count++;
					}
				}
				return { count };
			});

			const response = await createInjectAuthenticated(app)("POST", `/${entryId}/rollback`);

			expect(response.statusCode, response.body).toBe(200);
			expect(response.json(), response.body).toMatchObject({ success: false, failedCount: 1 });
			expect(response.json().errors[0]).toContain("no conditional update");
			expect(rows.get("wrapper-sync")).toMatchObject({
				rolledBack: false,
				rollbackStatus: "PARTIAL",
			});
			expect(rows.get("child-sync")).toMatchObject({
				rolledBack: false,
				rollbackStatus: "PARTIAL",
			});
			expect(profileGetById).toHaveBeenCalledOnce();
			expect(profileUpdate).not.toHaveBeenCalled();
			expect(formatUpdate).not.toHaveBeenCalled();
			expect(formatDelete).not.toHaveBeenCalled();

			const retry = await createInjectAuthenticated(app)("POST", `/${siblingId}/rollback`);
			expect(retry.statusCode, retry.body).toBe(200);
			expect(retry.json(), retry.body).toMatchObject({
				success: true,
				restoredCount: 1,
				failedCount: 0,
			});
			expect(rows.get("wrapper-sync")).toMatchObject({
				rolledBack: true,
				rollbackStatus: "COMPLETED",
			});
			expect(rows.get("child-sync")).toMatchObject({
				rolledBack: true,
				rollbackStatus: "COMPLETED",
			});
			expect(profileGetById).toHaveBeenCalledOnce();
			expect(formatGetById).toHaveBeenCalledTimes(2);
			expect(profileUpdate).not.toHaveBeenCalled();
			expect(formatUpdate).not.toHaveBeenCalled();
			expect(formatDelete).not.toHaveBeenCalled();

			const completedRetry = await createInjectAuthenticated(app)("POST", `/${entryId}/rollback`);
			expect(completedRetry.statusCode).toBe(400);
			expect(completedRetry.json()).toMatchObject({ error: "ALREADY_ROLLED_BACK" });
			expect(profileGetById).toHaveBeenCalledOnce();
			expect(formatGetById).toHaveBeenCalledTimes(2);
		},
	);

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

	it("stops before Custom Format work when profile restoration requires an unconditional PUT", async () => {
		const response = await createInjectAuthenticated(app)("POST", "/sync-1/rollback");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, failedCount: 1 });
		expect(response.json().errors[0]).toContain("no conditional update");
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
		expect(deploymentUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({ data: expect.objectContaining({ undeployStatus: "PARTIAL" }) }),
		);
		expect(syncUpdate).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: "sync-1",
				userId,
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
			}),
			data: expect.objectContaining({
				rollbackStatus: "PARTIAL",
				rollbackProgress: expect.stringContaining("no conditional update"),
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
			success: false,
			restoredCount: 1,
			deletedCount: 0,
			failedCount: 1,
		});
		expect(response.json().errors[0]).toContain("no conditional update");
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
		expect(syncUpdate).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: "sync-1",
				userId,
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
			}),
			data: expect.objectContaining({
				rollbackStatus: "PARTIAL",
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
		mockDeploymentOwnershipRows([
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
			where: expect.objectContaining({
				id: "sync-1",
				userId,
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
			}),
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
		mockDeploymentOwnershipRows([
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
			where: expect.objectContaining({
				id: "sync-1",
				userId,
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
			}),
			data: expect.objectContaining({ rollbackStatus: "COMPLETED" }),
		});
	});

	it("refuses an unconditional shared Custom Format restore and records retryable progress", async () => {
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
		targetBackup.qualityProfileDeployment = {
			beforeProfile: null,
			status: "not_started",
			action: "created",
			profileId: null,
			postStateToken: null,
			intendedPostStateToken: null,
		};
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
		mockDeploymentOwnershipRows([
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
		expect(response.json()).toMatchObject({ success: false, failedCount: 1 });
		expect(response.json().errors[0]).toContain("no conditional update");
		expect(profileUpdate).not.toHaveBeenCalled();
		expect(formatUpdate).not.toHaveBeenCalled();
		expect(formatDelete).not.toHaveBeenCalled();
		expect(syncUpdate).toHaveBeenCalledWith({
			where: expect.objectContaining({
				id: "sync-1",
				userId,
				rolledBack: false,
				rollbackStatus: "IN_PROGRESS",
			}),
			data: expect.objectContaining({
				rollbackStatus: "PARTIAL",
				rollbackProgress: expect.stringContaining(
					'"kind":"custom_format","name":"Created CF","outcome":"failed"',
				),
			}),
		});
	});
});
