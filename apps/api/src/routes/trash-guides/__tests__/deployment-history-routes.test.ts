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
import { deploymentHistoryRoutes } from "../deployment-history-routes.js";

const userId = "test-user-id";
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
	connectionGeneration: 1,
	credentialIdentity: "credential-1",
};

function qualityProfile(score: number | null) {
	return {
		id: 4,
		name: "Profile",
		upgradeAllowed: true,
		cutoff: 1,
		items: [],
		minFormatScore: 0,
		cutoffFormatScore: 0,
		minUpgradeFormatScore: 0,
		formatItems: score === null ? [] : [{ format: 7, score }],
	};
}

function customFormatVersion(includeCustomFormatWhenRenaming: boolean | null, name = "Shared CF") {
	return {
		id: 7,
		name,
		specifications: [],
		includeCustomFormatWhenRenaming,
	};
}

function radarrNaming(standardMovieFormat: string) {
	return {
		id: 1,
		renameMovies: true,
		replaceIllegalCharacters: true,
		colonReplacementFormat: "smart",
		standardMovieFormat,
		movieFolderFormat: "{Movie Title}",
	};
}

function backupData(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		schemaVersion: 2,
		endpointKey: createDeploymentEndpointKey(userId, instance),
		connectionStateToken: createDeploymentConnectionStateToken(instance),
		customFormats: [],
		customFormatDeployments: [],
		managedCustomFormats: [],
		managedCustomFormatsCaptured: true,
		qualityProfileDeployment: {
			beforeProfile: null,
			status: "not_started",
			action: "created",
			profileId: null,
			postStateToken: null,
			intendedPostStateToken: null,
		},
		namingDeployment: null,
		...overrides,
	});
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

describe("deployment history undeploy", () => {
	let app: FastifyInstance;
	const historyFindFirst = vi.fn();
	const historyFindMany = vi.fn();
	const historyUpdate = vi.fn();
	const historyUpdateMany = vi.fn();
	const historyDeleteMany = vi.fn();
	const syncUpdateMany = vi.fn();
	const syncFindMany = vi.fn();
	const syncFindFirst = vi.fn();
	const backupFindFirst = vi.fn();
	const instanceFindFirst = vi.fn();
	const instanceFindMany = vi.fn();
	const deleteFormat = vi.fn();
	const getAllFormats = vi.fn();
	const getFormatById = vi.fn();
	const updateFormat = vi.fn();
	const getAllProfiles = vi.fn();
	const getProfileById = vi.fn();
	const updateProfile = vi.fn();
	const rawRequest = vi.fn();
	const systemGet = vi.fn();
	const transaction = vi.fn();
	const cleanupUpdateMany = vi.fn();
	let transactionClient: Record<string, unknown>;

	beforeEach(async () => {
		vi.resetAllMocks();
		app = Fastify({ logger: false });
		setupAuthInjection(app, { id: userId, username: "admin" });
		registerTestErrorHandler(app);
		transactionClient = {
			templateDeploymentHistory: { update: historyUpdate, updateMany: historyUpdateMany },
			trashSyncHistory: { updateMany: syncUpdateMany },
		};
		transaction.mockImplementation(async (callback) => callback(transactionClient));
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: cleanupUpdateMany.mockResolvedValue({ count: 1 }),
			},
			templateDeploymentHistory: {
				findFirst: historyFindFirst,
				findMany: historyFindMany,
				update: historyUpdate,
				updateMany: historyUpdateMany,
				deleteMany: historyDeleteMany,
			},
			trashSyncHistory: {
				findMany: syncFindMany,
				findFirst: syncFindFirst,
				updateMany: syncUpdateMany,
			},
			trashBackup: { findFirst: backupFindFirst },
			serviceInstance: {
				findFirst: instanceFindFirst,
				findMany: instanceFindMany,
			},
			$transaction: transaction,
		};
		const client = {
			system: { get: systemGet.mockResolvedValue({ version: "5.0.0" }) },
			customFormat: {
				getAll: getAllFormats,
				getById: getFormatById,
				delete: deleteFormat,
				update: updateFormat,
			},
			qualityProfile: {
				getAll: getAllProfiles,
				getById: getProfileById,
				update: updateProfile,
				delete: vi.fn(),
			},
		};
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
		instanceFindFirst.mockResolvedValue(instance);
		instanceFindMany.mockResolvedValue([instance]);
		syncFindMany.mockResolvedValue([]);
		syncFindFirst.mockResolvedValue(null);
		backupFindFirst.mockResolvedValue(null);
		historyUpdate.mockResolvedValue({});
		historyUpdateMany.mockResolvedValue({ count: 1 });
		historyDeleteMany.mockResolvedValue({ count: 1 });
		syncUpdateMany.mockResolvedValue({ count: 1 });
		await app.register(deploymentHistoryRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	function currentHistory(data: string) {
		return {
			id: "history-1",
			templateId: "template-1",
			instanceId: instance.id,
			userId,
			status: "SUCCESS",
			rolledBack: false,
			undeployStatus: null,
			undeployAttemptedAt: null,
			undeployProgress: null,
			backupId: "backup-1",
			deployedAt: new Date("2026-01-01"),
			instance,
			backup: { id: "backup-1", backupData: data },
			template: { id: "template-1", name: "Template", userId, configData: "{}" },
		};
	}

	it("uses the fresh leased history row instead of a stale pre-lock snapshot", async () => {
		const history = currentHistory(backupData());
		historyFindFirst
			.mockResolvedValueOnce(history)
			.mockResolvedValueOnce({ ...history, rolledBack: true });

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(400);
		expect(response.json()).toMatchObject({
			message: "This deployment has already been undeployed",
		});
		expect(historyUpdateMany).not.toHaveBeenCalled();
		expect(deleteFormat).not.toHaveBeenCalled();
	});

	it("claims undeploy without overwriting resumable progress before reading ARR", async () => {
		const history = {
			...currentHistory(backupData()),
			undeployStatus: "PARTIAL",
			undeployProgress: JSON.stringify([
				{
					key: "custom_format:7",
					kind: "custom_format",
					name: "Managed CF",
					outcome: "restored",
				},
			]),
		};
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(historyUpdateMany).toHaveBeenNthCalledWith(1, {
			where: {
				id: "history-1",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				undeployStatus: "PARTIAL",
				undeployAttemptedAt: null,
				undeployProgress: history.undeployProgress,
			},
			data: {
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: expect.any(Date),
			},
		});
		expect(historyUpdateMany.mock.invocationCallOrder[0]).toBeLessThan(
			systemGet.mock.invocationCallOrder[0]!,
		);
	});

	it("acquires the topology lease before claiming an undeploy", async () => {
		const history = currentHistory(backupData());
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		const acquireIndexes = cleanupUpdateMany.mock.calls.flatMap(([args], index) =>
			args.data.runClaimToken ? [index] : [],
		);
		const releaseIndexes = cleanupUpdateMany.mock.calls.flatMap(([args], index) =>
			args.data.runClaimToken === null ? [index] : [],
		);
		expect(acquireIndexes).toHaveLength(1);
		expect(releaseIndexes).toHaveLength(1);
		const finalWriteIndex = historyUpdateMany.mock.calls.findIndex(
			([args]) => args.data.rolledBack === true,
		);
		expect(finalWriteIndex).toBeGreaterThanOrEqual(0);
		expect(cleanupUpdateMany.mock.invocationCallOrder[acquireIndexes[0]!]).toBeLessThan(
			historyUpdateMany.mock.invocationCallOrder[0]!,
		);
		expect(historyUpdateMany.mock.invocationCallOrder[finalWriteIndex]).toBeLessThan(
			cleanupUpdateMany.mock.invocationCallOrder[releaseIndexes[0]!]!,
		);
	});

	it("restores the full claim when topology ownership is lost before an ARR mutation", async () => {
		const targetFormat = { id: 7, name: "Created CF", specifications: [] };
		const history = currentHistory(
			backupData({
				customFormatDeployments: [
					{
						beforeFormat: null,
						action: "created",
						resourceId: 7,
						name: "Created CF",
						status: "applied",
						postStateToken: createUpstreamResourceStateToken(targetFormat),
						intendedPostStateToken: null,
					},
				],
			}),
		);
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		getFormatById.mockResolvedValue(targetFormat);
		let renewals = 0;
		cleanupUpdateMany.mockImplementation(async ({ data }) => {
			if (!("runClaimToken" in data) && ++renewals === 3) return { count: 0 };
			return { count: 1 };
		});

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(500);
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(historyUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "SUCCESS", undeployStatus: null }),
			}),
		);
	});

	it("marks the full claim partial when ownership is lost after entering an ARR mutation boundary", async () => {
		const targetFormat = { id: 7, name: "Created CF", specifications: [] };
		const history = currentHistory(
			backupData({
				customFormatDeployments: [
					{
						beforeFormat: null,
						action: "created",
						resourceId: 7,
						name: "Created CF",
						status: "applied",
						postStateToken: createUpstreamResourceStateToken(targetFormat),
						intendedPostStateToken: null,
					},
				],
			}),
		);
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		getAllFormats.mockResolvedValue([targetFormat]);
		getAllProfiles.mockResolvedValue([]);
		getFormatById.mockResolvedValue(targetFormat);
		let renewals = 0;
		cleanupUpdateMany.mockImplementation(async ({ data }) => {
			if (!("runClaimToken" in data) && ++renewals === 4) return { count: 0 };
			return { count: 1 };
		});

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(207);
		expect(getFormatById).toHaveBeenCalled();
		expect(historyUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "PARTIAL_UNDEPLOY",
					undeployStatus: "PARTIAL",
				}),
			}),
		);
	});

	it("stops before ARR access when another undeploy owns the claim", async () => {
		const history = currentHistory(backupData());
		historyFindFirst.mockResolvedValue(history);
		historyUpdateMany.mockResolvedValueOnce({ count: 0 });

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(409);
		expect(systemGet).not.toHaveBeenCalled();
		expect(historyFindFirst).toHaveBeenCalledTimes(2);
	});

	it.each([
		["already active", false, "IN_PROGRESS"],
		["already completed", true, "COMPLETED"],
	])(
		"rejects a paired sync that is %s before claiming the group",
		async (_case, rolledBack, status) => {
			const history = currentHistory(backupData());
			historyFindFirst.mockResolvedValue(history);
			syncFindMany.mockImplementation(async (args) =>
				args.select?.rollbackProgress
					? [
							pairedSyncState({
								rolledBack,
								rollbackStatus: status,
								rollbackAttemptedAt: new Date("2026-08-08T12:00:00.000Z"),
								rollbackProgress: "[]",
							}),
						]
					: [],
			);

			const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

			expect(response.statusCode).toBe(409);
			expect(transaction).not.toHaveBeenCalled();
			expect(systemGet).not.toHaveBeenCalled();
			expect(historyUpdateMany).not.toHaveBeenCalled();
		},
	);

	it("rolls back the whole claim when a paired sync CAS misses", async () => {
		const history = currentHistory(backupData());
		historyFindFirst.mockResolvedValue(history);
		syncFindMany.mockImplementation(async (args) =>
			args.select?.rollbackProgress ? [pairedSyncState()] : [],
		);
		syncUpdateMany.mockResolvedValueOnce({ count: 0 });

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(409);
		expect(transaction).toHaveBeenCalledOnce();
		expect(systemGet).not.toHaveBeenCalled();
	});

	it("releases the undeploy claim back to null when ARR is unreachable", async () => {
		const history = {
			...currentHistory(backupData()),
			undeployStatus: null,
			undeployAttemptedAt: null,
		};
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		systemGet.mockRejectedValueOnce(new Error("ARR read failed"));

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(500);
		expect(historyUpdateMany).toHaveBeenLastCalledWith({
			where: {
				id: "history-1",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: expect.any(Date),
			},
			data: {
				status: "SUCCESS",
				undeployStatus: null,
				undeployAttemptedAt: null,
				undeployProgress: null,
			},
		});
		expect(deleteFormat).not.toHaveBeenCalled();
	});

	it("restores prior PARTIAL recovery state when a retry fails before mutation", async () => {
		const priorAttemptedAt = new Date("2026-08-08T12:05:00.000Z");
		const priorProgress = JSON.stringify([
			{
				key: "custom_format:7",
				kind: "custom_format",
				name: "Managed CF",
				outcome: "restored",
			},
		]);
		const history = {
			...currentHistory(backupData()),
			status: "PARTIAL_UNDEPLOY",
			undeployStatus: "PARTIAL",
			undeployAttemptedAt: priorAttemptedAt,
			undeployProgress: priorProgress,
		};
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		systemGet.mockRejectedValueOnce(new Error("ARR read failed"));

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(500);
		expect(historyUpdateMany).toHaveBeenLastCalledWith({
			where: {
				id: "history-1",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "PARTIAL_UNDEPLOY",
				rolledBack: false,
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: expect.any(Date),
			},
			data: {
				status: "PARTIAL_UNDEPLOY",
				undeployStatus: "PARTIAL",
				undeployAttemptedAt: priorAttemptedAt,
				undeployProgress: priorProgress,
			},
		});
		expect(deleteFormat).not.toHaveBeenCalled();
	});

	it("restores paired rollback state when final persistence fails before an ARR mutation", async () => {
		const priorRollbackAttemptedAt = new Date("2026-08-08T12:00:00.000Z");
		const priorRollbackProgress = JSON.stringify([{ key: "prior", outcome: "restored" }]);
		const history = currentHistory(backupData());
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		syncFindMany.mockImplementation(async (args) =>
			args.select?.rollbackProgress
				? [
						pairedSyncState({
							rollbackStatus: "PARTIAL",
							rollbackAttemptedAt: priorRollbackAttemptedAt,
							rollbackProgress: priorRollbackProgress,
						}),
					]
				: [],
		);
		transaction
			.mockReset()
			.mockImplementationOnce(async (callback) => callback(transactionClient))
			.mockRejectedValueOnce(new Error("final deployment history write failed"))
			.mockImplementationOnce(async (callback) => callback(transactionClient));

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(500);
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(updateFormat).not.toHaveBeenCalled();
		expect(updateProfile).not.toHaveBeenCalled();
		const claimTimestamp = historyUpdateMany.mock.calls[0]?.[0].data.undeployAttemptedAt;
		expect(syncUpdateMany).toHaveBeenCalledWith({
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
				rollbackAttemptedAt: priorRollbackAttemptedAt,
				rollbackProgress: priorRollbackProgress,
			},
		});
	});

	it("releases the undeploy claim when a legacy backup cannot be undeployed", async () => {
		const history = {
			...currentHistory(JSON.stringify({ customFormats: [], qualityProfile: null })),
			undeployStatus: null,
			undeployAttemptedAt: null,
		};
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(409);
		expect(historyUpdateMany).toHaveBeenLastCalledWith({
			where: {
				id: "history-1",
				userId,
				instanceId: instance.id,
				templateId: "template-1",
				backupId: "backup-1",
				status: "SUCCESS",
				rolledBack: false,
				undeployStatus: "IN_PROGRESS",
				undeployAttemptedAt: expect.any(Date),
			},
			data: {
				status: "SUCCESS",
				undeployStatus: null,
				undeployAttemptedAt: null,
				undeployProgress: null,
			},
		});
		expect(deleteFormat).not.toHaveBeenCalled();
	});

	it("returns durable undeploy progress as structured detail data", async () => {
		const history = {
			...currentHistory(backupData()),
			appliedConfigs: "[]",
			failedConfigs: "[]",
			undeployStatus: "PARTIAL",
			undeployAttemptedAt: new Date("2026-08-08T12:05:00.000Z"),
			undeployProgress: JSON.stringify([
				{
					key: "custom_format:7",
					kind: "custom_format",
					name: "Shared CF",
					outcome: "failed",
					error: "Verification failed",
				},
			]),
		};
		historyFindFirst.mockResolvedValue(history);

		const response = await createInjectAuthenticated(app)("GET", "/history/history-1");

		expect(response.statusCode).toBe(200);
		expect(response.json().data).toMatchObject({
			undeployStatus: "PARTIAL",
			undeployProgress: [
				{
					key: "custom_format:7",
					kind: "custom_format",
					name: "Shared CF",
					outcome: "failed",
					error: "Verification failed",
				},
			],
		});
	});

	it("does not delete a same-name replacement with a different resource ID", async () => {
		const deployed = { id: 7, name: "Managed CF", specifications: [] };
		const data = backupData({
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 7,
					name: "Managed CF",
					status: "applied",
					postStateToken: createUpstreamResourceStateToken(deployed),
					intendedPostStateToken: null,
				},
			],
		});
		const history = currentHistory(data);
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		getAllFormats.mockResolvedValue([{ id: 9, name: "Managed CF", specifications: [] }]);
		getAllProfiles.mockResolvedValue([]);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(response.json().data.deletedCFs).toEqual([]);
	});

	it("keeps shared Custom Formats but records a partial result when survivor state drifted", async () => {
		const targetFormat = { id: 7, name: "Managed CF", specifications: [] };
		const survivorFormat = {
			id: 7,
			name: "Managed CF",
			specifications: [{ name: "Survivor specification" }],
		};
		const driftedFormat = {
			id: 7,
			name: "Managed CF",
			specifications: [{ name: "Unexpected manual change" }],
		};
		const target = currentHistory(
			backupData({
				customFormatDeployments: [
					{
						beforeFormat: {
							id: 7,
							name: "Managed CF",
							specifications: [{ name: "Original specification" }],
						},
						action: "updated",
						resourceId: 7,
						name: "Managed CF",
						status: "applied",
						postStateToken: createUpstreamResourceStateToken(targetFormat),
						intendedPostStateToken: null,
					},
				],
			}),
		);
		const survivor = {
			...target,
			id: "history-2",
			templateId: "template-2",
			backupId: "backup-2",
			deployedAt: new Date("2026-01-02"),
			backup: {
				id: "backup-2",
				backupData: backupData({
					managedCustomFormats: [
						{
							trashId: "shared-trash-id",
							name: "Managed CF",
							resourceId: 7,
							stateToken: createUpstreamResourceStateToken(survivorFormat),
							profileId: 4,
							appliedScore: 100,
						},
					],
				}),
			},
		};
		historyFindFirst.mockResolvedValue(target);
		historyFindMany.mockResolvedValue([target, survivor]);
		getFormatById.mockResolvedValue(driftedFormat);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, data: { deleted: 0 } });
		expect(response.json().data.errors[0]).toContain("older target cannot restore it safely");
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(updateFormat).not.toHaveBeenCalled();
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "history-1", userId, rolledBack: false }),
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining('"outcome":"failed"'),
				}),
			}),
		);
	});

	it("requires manual shared Custom Format restore while preserving the survivor state", async () => {
		const olderSurvivorFormat = customFormatVersion(null);
		const survivorFormat = customFormatVersion(false);
		const targetFormat = customFormatVersion(true);
		const target = currentHistory(
			backupData({
				customFormatDeployments: [
					{
						beforeFormat: survivorFormat,
						action: "updated",
						resourceId: 7,
						name: "Shared CF",
						status: "applied",
						postStateToken: createUpstreamResourceStateToken(targetFormat),
						intendedPostStateToken: createUpstreamResourceStateToken(targetFormat),
					},
				],
			}),
		);
		const survivor = {
			...target,
			id: "history-survivor",
			templateId: "template-survivor",
			backupId: "backup-survivor",
			deployedAt: new Date("2025-12-31"),
			backup: {
				id: "backup-survivor",
				backupData: backupData({
					managedCustomFormats: [
						{
							trashId: "shared-trash-id",
							name: "Shared CF",
							resourceId: 7,
							stateToken: createUpstreamResourceStateToken(survivorFormat),
							profileId: 4,
							appliedScore: 100,
						},
					],
				}),
			},
		};
		const olderSurvivor = {
			...survivor,
			id: "history-older-survivor",
			templateId: "template-older-survivor",
			backupId: "backup-older-survivor",
			deployedAt: new Date("2025-12-30"),
			backup: {
				id: "backup-older-survivor",
				backupData: backupData({
					managedCustomFormats: [
						{
							trashId: "shared-trash-id",
							name: "Shared CF",
							resourceId: 7,
							stateToken: createUpstreamResourceStateToken(olderSurvivorFormat),
							profileId: 4,
							appliedScore: 100,
						},
					],
				}),
			},
		};
		historyFindFirst.mockResolvedValue(target);
		historyFindMany.mockResolvedValue([target, survivor, olderSurvivor]);
		getAllFormats.mockResolvedValue([targetFormat]);
		getFormatById.mockResolvedValue(targetFormat);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: false,
			data: { restoredCFs: [], skippedShared: [] },
		});
		expect(response.json().data.errors[0]).toContain("upstream API has no conditional update");
		expect(updateFormat).not.toHaveBeenCalled();
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "history-1", userId, rolledBack: false }),
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining(
						'"kind":"custom_format","name":"Shared CF","outcome":"failed"',
					),
				}),
			}),
		);
	});

	it("does not write a shared Custom Format when its rollback snapshot is not the survivor state", async () => {
		const staleBeforeFormat = customFormatVersion(null);
		const survivorFormat = customFormatVersion(false);
		const targetFormat = customFormatVersion(true);
		const target = currentHistory(
			backupData({
				customFormatDeployments: [
					{
						beforeFormat: staleBeforeFormat,
						action: "updated",
						resourceId: 7,
						name: "Shared CF",
						status: "applied",
						postStateToken: createUpstreamResourceStateToken(targetFormat),
						intendedPostStateToken: createUpstreamResourceStateToken(targetFormat),
					},
				],
			}),
		);
		const survivor = {
			...target,
			id: "history-survivor",
			templateId: "template-survivor",
			backupId: "backup-survivor",
			deployedAt: new Date("2025-12-31"),
			backup: {
				id: "backup-survivor",
				backupData: backupData({
					managedCustomFormats: [
						{
							trashId: "shared-trash-id",
							name: "Shared CF",
							resourceId: 7,
							stateToken: createUpstreamResourceStateToken(survivorFormat),
							profileId: 4,
							appliedScore: 100,
						},
					],
				}),
			},
		};
		historyFindFirst.mockResolvedValue(target);
		historyFindMany.mockResolvedValue([target, survivor]);
		getAllFormats.mockResolvedValue([targetFormat]);
		getFormatById.mockResolvedValue(targetFormat);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(false);
		expect(response.json().data.errors[0]).toContain("older target cannot restore it safely");
		expect(updateFormat).not.toHaveBeenCalled();
	});

	it("requires manual shared quality-profile restore while preserving the survivor state", async () => {
		const survivorProfile = qualityProfile(100);
		const targetProfile = qualityProfile(500);
		const target = currentHistory(
			backupData({
				qualityProfileDeployment: {
					beforeProfile: survivorProfile,
					status: "applied",
					action: "updated",
					profileId: 4,
					profileName: "Profile",
					postStateToken: createQualityProfileStateToken(targetProfile),
					intendedPostStateToken: createQualityProfileStateToken(targetProfile),
				},
			}),
		);
		const survivor = {
			...target,
			id: "history-survivor",
			templateId: "template-survivor",
			backupId: "backup-survivor",
			deployedAt: new Date("2025-12-31"),
			backup: {
				id: "backup-survivor",
				backupData: backupData({
					qualityProfileDeployment: {
						beforeProfile: survivorProfile,
						status: "applied",
						action: "updated",
						profileId: 4,
						profileName: "Profile",
						postStateToken: createQualityProfileStateToken(survivorProfile),
						intendedPostStateToken: createQualityProfileStateToken(survivorProfile),
					},
				}),
			},
		};
		historyFindFirst.mockResolvedValue(target);
		historyFindMany.mockResolvedValue([target, survivor]);
		getAllProfiles.mockResolvedValue([targetProfile]);
		getProfileById.mockResolvedValue(targetProfile);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(false);
		expect(response.json().data.errors[0]).toContain("upstream API has no conditional update");
		expect(updateProfile).not.toHaveBeenCalled();
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining(
						'"kind":"quality_profile","name":"Profile","outcome":"failed"',
					),
				}),
			}),
		);
	});

	it("does not write a shared quality profile from a stale rollback snapshot", async () => {
		const staleBeforeProfile = qualityProfile(0);
		const survivorProfile = qualityProfile(100);
		const targetProfile = qualityProfile(500);
		const target = currentHistory(
			backupData({
				qualityProfileDeployment: {
					beforeProfile: staleBeforeProfile,
					status: "applied",
					action: "updated",
					profileId: 4,
					profileName: "Profile",
					postStateToken: createQualityProfileStateToken(targetProfile),
					intendedPostStateToken: createQualityProfileStateToken(targetProfile),
				},
			}),
		);
		const survivor = {
			...target,
			id: "history-survivor",
			templateId: "template-survivor",
			backupId: "backup-survivor",
			deployedAt: new Date("2025-12-31"),
			backup: {
				id: "backup-survivor",
				backupData: backupData({
					qualityProfileDeployment: {
						beforeProfile: survivorProfile,
						status: "applied",
						action: "updated",
						profileId: 4,
						profileName: "Profile",
						postStateToken: createQualityProfileStateToken(survivorProfile),
						intendedPostStateToken: createQualityProfileStateToken(survivorProfile),
					},
				}),
			},
		};
		historyFindFirst.mockResolvedValue(target);
		historyFindMany.mockResolvedValue([target, survivor]);
		getAllProfiles.mockResolvedValue([targetProfile]);
		getProfileById.mockResolvedValue(targetProfile);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(false);
		expect(response.json().data.errors[0]).toContain("older target cannot restore it safely");
		expect(updateProfile).not.toHaveBeenCalled();
	});

	it("requires manual shared naming restore while preserving the survivor state", async () => {
		const survivorNaming = radarrNaming("V1");
		const targetNaming = radarrNaming("V2");
		const target = currentHistory(
			backupData({
				namingDeployment: {
					beforeConfig: survivorNaming,
					status: "applied",
					postStateToken: createUpstreamResourceStateToken(targetNaming),
					intendedPostStateToken: createUpstreamResourceStateToken(targetNaming),
				},
			}),
		);
		const survivor = {
			...target,
			id: "history-survivor",
			templateId: "template-survivor",
			backupId: "backup-survivor",
			deployedAt: new Date("2025-12-31"),
			backup: {
				id: "backup-survivor",
				backupData: backupData({
					namingDeployment: {
						beforeConfig: {},
						status: "applied",
						postStateToken: createUpstreamResourceStateToken(survivorNaming),
						intendedPostStateToken: createUpstreamResourceStateToken(survivorNaming),
					},
				}),
			},
		};
		historyFindFirst.mockResolvedValue(target);
		historyFindMany.mockResolvedValue([target, survivor]);
		rawRequest
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => targetNaming })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => targetNaming });

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.json().success).toBe(false);
		expect(response.json().data.errors[0]).toContain("upstream API has no conditional update");
		expect(rawRequest).not.toHaveBeenCalledWith(
			instance,
			"/api/v3/config/naming",
			expect.objectContaining({ method: "PUT" }),
		);
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining(
						'"kind":"naming","name":"Naming configuration","outcome":"failed"',
					),
				}),
			}),
		);
	});

	it("does not write shared naming configuration from a stale rollback snapshot", async () => {
		const staleBeforeNaming = radarrNaming("V0");
		const survivorNaming = radarrNaming("V1");
		const targetNaming = radarrNaming("V2");
		const target = currentHistory(
			backupData({
				namingDeployment: {
					beforeConfig: staleBeforeNaming,
					status: "applied",
					postStateToken: createUpstreamResourceStateToken(targetNaming),
					intendedPostStateToken: createUpstreamResourceStateToken(targetNaming),
				},
			}),
		);
		const survivor = {
			...target,
			id: "history-survivor",
			templateId: "template-survivor",
			backupId: "backup-survivor",
			deployedAt: new Date("2025-12-31"),
			backup: {
				id: "backup-survivor",
				backupData: backupData({
					namingDeployment: {
						beforeConfig: {},
						status: "applied",
						postStateToken: createUpstreamResourceStateToken(survivorNaming),
						intendedPostStateToken: createUpstreamResourceStateToken(survivorNaming),
					},
				}),
			},
		};
		historyFindFirst.mockResolvedValue(target);
		historyFindMany.mockResolvedValue([target, survivor]);
		rawRequest.mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => targetNaming,
		});

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(false);
		expect(response.json().data.errors[0]).toContain("older target cannot restore it safely");
		expect(rawRequest).not.toHaveBeenCalledWith(
			instance,
			"/api/v3/config/naming",
			expect.objectContaining({ method: "PUT" }),
		);
		for (const [args] of historyUpdateMany.mock.calls) {
			expect(args.data).not.toHaveProperty("errors");
		}
	});

	it("requires manual restore for a pending naming write that matches persisted intent", async () => {
		const beforeNaming = radarrNaming("Before");
		const intendedNaming = radarrNaming("Intended");
		const history = currentHistory(
			backupData({
				namingDeployment: {
					beforeConfig: beforeNaming,
					status: "pending",
					postStateToken: null,
					intendedPostStateToken: createUpstreamResourceStateToken(intendedNaming),
				},
			}),
		);
		Object.assign(history, { errors: JSON.stringify(["Original deployment failure"]) });
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		rawRequest.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => intendedNaming,
		});

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(false);
		expect(response.json().data.errors[0]).toContain("upstream API has no conditional update");
		expect(rawRequest).not.toHaveBeenCalledWith(
			instance,
			"/api/v3/config/naming",
			expect.objectContaining({ method: "PUT" }),
		);
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "history-1", userId, rolledBack: false }),
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining(
						'"kind":"naming","name":"Naming configuration","outcome":"failed"',
					),
				}),
			}),
		);
		for (const [args] of historyUpdateMany.mock.calls) {
			expect(args.data).not.toHaveProperty("errors");
		}
	});

	it("fails closed without a naming PUT when a pending write matches neither known state", async () => {
		const beforeNaming = radarrNaming("Before");
		const intendedNaming = radarrNaming("Intended");
		const unknownNaming = radarrNaming("Unknown");
		const history = currentHistory(
			backupData({
				namingDeployment: {
					beforeConfig: beforeNaming,
					status: "pending",
					postStateToken: null,
					intendedPostStateToken: createUpstreamResourceStateToken(intendedNaming),
				},
			}),
		);
		Object.assign(history, { errors: JSON.stringify(["Original deployment failure"]) });
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		rawRequest.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => unknownNaming,
		});

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json()).toMatchObject({ success: false });
		expect(rawRequest).not.toHaveBeenCalledWith(
			instance,
			"/api/v3/config/naming",
			expect.objectContaining({ method: "PUT" }),
		);
		for (const [args] of historyUpdateMany.mock.calls) {
			expect(args.data).not.toHaveProperty("errors");
		}
	});

	it("records an already-restored profile before refusing an unconditional created-format delete", async () => {
		const beforeProfile = qualityProfile(null);
		const deployedProfile = qualityProfile(100);
		const deployedFormat = { id: 7, name: "Managed CF", specifications: [] };
		const data = backupData({
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 7,
					name: "Managed CF",
					status: "applied",
					postStateToken: createUpstreamResourceStateToken(deployedFormat),
					intendedPostStateToken: null,
				},
			],
			qualityProfileDeployment: {
				beforeProfile,
				status: "applied",
				action: "updated",
				profileId: 4,
				profileName: "Profile",
				postStateToken: createQualityProfileStateToken(deployedProfile),
				intendedPostStateToken: createQualityProfileStateToken(deployedProfile),
			},
		});
		const history = currentHistory(data);
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		getAllProfiles.mockResolvedValue([beforeProfile]);
		getProfileById.mockResolvedValue(beforeProfile);
		getAllFormats.mockResolvedValue([deployedFormat]);
		getFormatById.mockResolvedValue(deployedFormat);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, data: { deleted: 0 } });
		expect(response.json().data.errors[0]).toContain("cannot be deleted safely");
		expect(updateProfile).not.toHaveBeenCalled();
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "history-1", userId, rolledBack: false }),
				data: expect.objectContaining({ undeployStatus: "IN_PROGRESS" }),
			}),
		);
		for (const [args] of historyUpdateMany.mock.calls) {
			expect(args.data).not.toHaveProperty("errors");
		}
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "history-1", userId, rolledBack: false }),
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining(
						'"kind":"quality_profile","name":"Profile","outcome":"restored"',
					),
				}),
			}),
		);
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "history-1", userId, rolledBack: false }),
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining('"outcome":"failed"'),
				}),
			}),
		);
	});

	it("stops before Custom Format deletion and records retryable manual profile progress", async () => {
		const beforeProfile = qualityProfile(null);
		const deployedProfile = qualityProfile(100);
		const deployedFormat = { id: 7, name: "Managed CF", specifications: [] };
		const history = currentHistory(
			backupData({
				customFormatDeployments: [
					{
						beforeFormat: null,
						action: "created",
						resourceId: 7,
						name: "Managed CF",
						status: "applied",
						postStateToken: createUpstreamResourceStateToken(deployedFormat),
						intendedPostStateToken: null,
					},
				],
				qualityProfileDeployment: {
					beforeProfile,
					status: "applied",
					action: "updated",
					profileId: 4,
					profileName: "Profile",
					postStateToken: createQualityProfileStateToken(deployedProfile),
					intendedPostStateToken: createQualityProfileStateToken(deployedProfile),
				},
			}),
		);
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		getAllProfiles.mockResolvedValue([deployedProfile]);
		getProfileById.mockResolvedValue(deployedProfile);
		getAllFormats.mockResolvedValue([deployedFormat]);
		getFormatById.mockResolvedValue(deployedFormat);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, data: { deleted: 0 } });
		expect(response.json().data.errors[0]).toContain("upstream API has no conditional update");
		expect(updateProfile).not.toHaveBeenCalled();
		expect(getAllFormats).not.toHaveBeenCalled();
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "history-1", userId, rolledBack: false }),
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining(
						'"kind":"quality_profile","name":"Profile","outcome":"failed"',
					),
				}),
			}),
		);
	});

	it("skips an exact resource still managed by a newer deployment of another template", async () => {
		const deployed = { id: 7, name: "Shared CF", specifications: [] };
		const data = backupData({
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 7,
					name: "Shared CF",
					status: "applied",
					postStateToken: createUpstreamResourceStateToken(deployed),
					intendedPostStateToken: null,
				},
			],
		});
		const history = currentHistory(data);
		const other = {
			...history,
			id: "history-2",
			templateId: "template-2",
			backupId: "backup-2",
			deployedAt: new Date("2026-01-02"),
			backup: {
				id: "backup-2",
				backupData: backupData({
					managedCustomFormats: [
						{
							trashId: "trash-1",
							name: "Shared CF",
							resourceId: 7,
							stateToken: createUpstreamResourceStateToken(deployed),
							profileId: 3,
							appliedScore: 100,
						},
					],
				}),
			},
		};
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history, other]);
		getFormatById.mockResolvedValue(deployed);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(response.json().data.skippedShared).toEqual(["Shared CF"]);
	});

	it("rejects undeploying a history superseded by a newer deployment", async () => {
		const history = currentHistory(backupData());
		const newer = {
			...history,
			id: "history-newer",
			backupId: "backup-newer",
			backup: { id: "backup-newer", backupData: backupData() },
			deployedAt: new Date("2026-02-01"),
		};
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([newer, history]);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("newer deployment");
		expect(deleteFormat).not.toHaveBeenCalled();
	});

	it("fails closed when a created CF still exists and a legacy competitor is unresolved", async () => {
		const createdFormat = { id: 123, name: "Anime Dual Audio", specifications: [] };
		const data = backupData({
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 123,
					name: "Anime Dual Audio",
					status: "applied",
					postStateToken: createUpstreamResourceStateToken(createdFormat),
					intendedPostStateToken: null,
				},
			],
		});
		const history = currentHistory(data);
		const legacy = {
			...history,
			id: "history-legacy",
			templateId: "template-legacy",
			backupId: "backup-legacy",
			deployedAt: new Date("2025-12-31"),
			backup: {
				id: "backup-legacy",
				backupData: JSON.stringify({ customFormats: [], qualityProfile: null }),
			},
		};
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history, legacy]);
		getAllFormats.mockResolvedValue([createdFormat]);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(409);
		expect(response.json().message).toContain("legacy or invalid ownership metadata");
		expect(deleteFormat).not.toHaveBeenCalled();
	});

	it("finalizes recovery when a created CF was already manually deleted", async () => {
		const createdFormat = { id: 123, name: "Anime Dual Audio", specifications: [] };
		const data = backupData({
			customFormatDeployments: [
				{
					beforeFormat: null,
					action: "created",
					resourceId: 123,
					name: "Anime Dual Audio",
					status: "applied",
					postStateToken: createUpstreamResourceStateToken(createdFormat),
					intendedPostStateToken: null,
				},
			],
		});
		const history = currentHistory(data);
		const legacy = {
			...history,
			id: "history-legacy",
			templateId: "template-legacy",
			backupId: "backup-legacy",
			deployedAt: new Date("2025-12-31"),
			backup: {
				id: "backup-legacy",
				backupData: JSON.stringify({ customFormats: [], qualityProfile: null }),
			},
		};
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history, legacy]);
		syncFindMany.mockImplementation(async (args) =>
			args.select?.rollbackProgress ? [pairedSyncState()] : [],
		);
		getAllFormats.mockResolvedValue([]);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(true);
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(historyUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ id: "history-1", userId, rolledBack: false }),
				data: expect.objectContaining({
					rolledBack: true,
					undeployStatus: "COMPLETED",
				}),
			}),
		);
		expect(syncUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "sync-paired",
					userId,
					rolledBack: false,
					rollbackStatus: "IN_PROGRESS",
					rollbackAttemptedAt: expect.any(Date),
				}),
				data: expect.objectContaining({
					rolledBack: true,
					rollbackStatus: "COMPLETED",
				}),
			}),
		);
	});
});

describe("deployment history delete", () => {
	let app: FastifyInstance;
	const historyFindFirst = vi.fn();
	const historyDeleteMany = vi.fn();
	const syncFindMany = vi.fn();
	const backupFindFirst = vi.fn();
	const cleanupUpdateMany = vi.fn();

	beforeEach(async () => {
		vi.resetAllMocks();
		app = Fastify({ logger: false });
		setupAuthInjection(app, { id: userId, username: "admin" });
		registerTestErrorHandler(app);
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: cleanupUpdateMany.mockResolvedValue({ count: 1 }),
			},
			templateDeploymentHistory: {
				findFirst: historyFindFirst,
				deleteMany: historyDeleteMany,
			},
			trashSyncHistory: { findMany: syncFindMany },
			trashBackup: { findFirst: backupFindFirst },
		};
		app.decorate("prisma", prisma as never);
		historyDeleteMany.mockResolvedValue({ count: 1 });
		syncFindMany.mockResolvedValue([]);
		backupFindFirst.mockResolvedValue(null);
		await app.register(deploymentHistoryRoutes);
		await app.ready();
	});

	afterEach(async () => {
		await app.close();
		vi.clearAllMocks();
	});

	function historyRow(overrides: Record<string, unknown> = {}) {
		return {
			id: "history-1",
			templateId: "template-1",
			instanceId: "instance-1",
			userId,
			status: "SUCCESS",
			rolledBack: false,
			undeployStatus: null,
			backupId: "backup-1",
			template: { userId },
			...overrides,
		};
	}

	function syncRow(overrides: Record<string, unknown> = {}) {
		return {
			id: "sync-1",
			status: "SUCCESS",
			rollbackStatus: null,
			...overrides,
		};
	}

	it("rejects deleting an UNCERTAIN deployment with an unresolved paired sync", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "UNCERTAIN" }));
		syncFindMany.mockResolvedValue([syncRow({ status: "UNCERTAIN" })]);

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(409);
		expect(historyDeleteMany).not.toHaveBeenCalled();
	});

	it("rejects deleting when a benign SUCCESS paired sync precedes an unresolved UNCERTAIN one", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "UNCERTAIN" }));
		syncFindMany.mockResolvedValue([
			syncRow({ id: "sync-a", status: "SUCCESS" }),
			syncRow({ id: "sync-b", status: "UNCERTAIN" }),
		]);

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(409);
		expect(historyDeleteMany).not.toHaveBeenCalled();
	});

	it("rejects deleting when a paired sync has rollbackStatus PARTIAL", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "SUCCESS" }));
		syncFindMany.mockResolvedValue([
			syncRow({ id: "sync-a", status: "SUCCESS" }),
			syncRow({ id: "sync-b", status: "SUCCESS", rollbackStatus: "PARTIAL" }),
		]);

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(409);
		expect(historyDeleteMany).not.toHaveBeenCalled();
	});

	it("rejects deleting a deployment whose schema-v2 backup has a pending mutation", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "FAILED" }));
		syncFindMany.mockResolvedValue([syncRow({ status: "SUCCESS" })]);
		backupFindFirst.mockResolvedValue({
			backupData: JSON.stringify({
				schemaVersion: 2,
				endpointKey: "endpoint",
				connectionStateToken: "connection",
				customFormats: [],
				customFormatDeployments: [
					{
						beforeFormat: null,
						action: "created",
						resourceId: null,
						name: "CF",
						status: "pending",
						postStateToken: null,
					},
				],
				managedCustomFormats: [],
				managedCustomFormatsCaptured: false,
				qualityProfileDeployment: {
					beforeProfile: null,
					status: "not_started",
					action: "created",
					profileId: null,
					postStateToken: null,
				},
				namingDeployment: null,
			}),
		});

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(409);
		expect(historyDeleteMany).not.toHaveBeenCalled();
	});

	it("rejects deleting when a paired sync references a malformed schema-v2 ledger", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "FAILED" }));
		syncFindMany.mockResolvedValue([syncRow({ status: "SUCCESS" })]);
		backupFindFirst.mockResolvedValue({
			backupData: JSON.stringify({ schemaVersion: 2, customFormatDeployments: [] }),
		});

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(409);
		expect(historyDeleteMany).not.toHaveBeenCalled();
	});

	it("rejects deleting when a paired sync references invalid JSON backup", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "FAILED" }));
		syncFindMany.mockResolvedValue([syncRow({ status: "SUCCESS" })]);
		backupFindFirst.mockResolvedValue({ backupData: "{invalid" });

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(409);
		expect(historyDeleteMany).not.toHaveBeenCalled();
	});

	it("allows deleting when a paired sync references a genuine legacy non-v2 backup", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "SUCCESS" }));
		syncFindMany.mockResolvedValue([syncRow({ status: "SUCCESS" })]);
		backupFindFirst.mockResolvedValue({
			backupData: JSON.stringify({ customFormats: [], qualityProfile: null }),
		});

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(200);
		expect(historyDeleteMany).toHaveBeenCalled();
	});

	it("rejects deleting a deployment with undeployStatus PARTIAL", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ undeployStatus: "PARTIAL" }));

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(409);
		expect(historyDeleteMany).not.toHaveBeenCalled();
	});

	it("rejects deleting a deployment with status PARTIAL_UNDEPLOY", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "PARTIAL_UNDEPLOY" }));

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(409);
		expect(historyDeleteMany).not.toHaveBeenCalled();
	});

	it("allows deleting a rolled-back deployment with a resolved paired sync", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ rolledBack: true }));
		syncFindMany.mockResolvedValue([]);

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(200);
		expect(historyDeleteMany).toHaveBeenCalled();
	});

	it("allows deleting a deployment with undeployStatus COMPLETED", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ undeployStatus: "COMPLETED" }));

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(200);
		expect(historyDeleteMany).toHaveBeenCalled();
	});

	it("holds the topology lease while checking paired recovery state and deleting", async () => {
		let leaseHeld = false;
		cleanupUpdateMany.mockImplementation(async ({ data }) => {
			leaseHeld = data.runClaimToken !== null;
			return { count: 1 };
		});
		historyFindFirst.mockResolvedValue(historyRow({ undeployStatus: "COMPLETED" }));
		syncFindMany.mockImplementation(async () => {
			expect(leaseHeld).toBe(true);
			return [];
		});
		historyDeleteMany.mockImplementation(async () => {
			expect(leaseHeld).toBe(true);
			return { count: 1 };
		});

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode, response.body).toBe(200);
		expect(leaseHeld).toBe(false);
	});

	it("allows deleting an ordinary terminal audit row that cannot block new work", async () => {
		historyFindFirst.mockResolvedValue(historyRow({ status: "SUCCESS", backupId: null }));

		const response = await createInjectAuthenticated(app)("DELETE", "/history/history-1");

		expect(response.statusCode).toBe(200);
		expect(historyDeleteMany).toHaveBeenCalled();
	});
});
