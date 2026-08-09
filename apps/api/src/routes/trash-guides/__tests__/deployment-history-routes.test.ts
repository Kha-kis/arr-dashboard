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
};

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

describe("deployment history undeploy", () => {
	let app: FastifyInstance;
	const historyFindFirst = vi.fn();
	const historyFindMany = vi.fn();
	const historyUpdate = vi.fn();
	const syncUpdateMany = vi.fn();
	const syncFindMany = vi.fn();
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

	beforeEach(async () => {
		vi.resetAllMocks();
		app = Fastify({ logger: false });
		setupAuthInjection(app, { id: userId, username: "admin" });
		registerTestErrorHandler(app);
		const prisma = {
			libraryCleanupConfig: {
				upsert: vi.fn().mockResolvedValue({ id: "cleanup-config" }),
				updateMany: vi.fn().mockResolvedValue({ count: 1 }),
			},
			templateDeploymentHistory: {
				findFirst: historyFindFirst,
				findMany: historyFindMany,
				update: historyUpdate,
			},
			trashSyncHistory: { findMany: syncFindMany, updateMany: syncUpdateMany },
			serviceInstance: {
				findFirst: instanceFindFirst,
				findMany: instanceFindMany,
			},
			$transaction: vi.fn(async (callback) =>
				callback({
					templateDeploymentHistory: { update: historyUpdate },
					trashSyncHistory: { updateMany: syncUpdateMany },
				}),
			),
		};
		const client = {
			system: { get: vi.fn().mockResolvedValue({ version: "5.0.0" }) },
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
				callback(createDeploymentEndpointKey(userId, target)),
			),
		} as never);
		instanceFindFirst.mockResolvedValue(instance);
		instanceFindMany.mockResolvedValue([instance]);
		syncFindMany.mockResolvedValue([]);
		historyUpdate.mockResolvedValue({});
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
			undeployProgress: null,
			backupId: "backup-1",
			deployedAt: new Date("2026-01-01"),
			instance,
			backup: { id: "backup-1", backupData: data },
			template: { id: "template-1", name: "Template", userId, configData: "{}" },
		};
	}

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
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "history-1" },
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining('"outcome":"failed"'),
				}),
			}),
		);
	});

	it("unwinds the latest shared Custom Format write before preserving the survivor state", async () => {
		const olderSurvivorFormat = {
			id: 7,
			name: "Shared CF",
			specifications: [{ name: "V0" }],
		};
		const survivorFormat = {
			id: 7,
			name: "Shared CF",
			specifications: [{ name: "V1" }],
		};
		const targetFormat = {
			id: 7,
			name: "Shared CF",
			specifications: [{ name: "V2" }],
		};
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
		getFormatById
			.mockResolvedValueOnce(targetFormat)
			.mockResolvedValueOnce(targetFormat)
			.mockResolvedValueOnce(survivorFormat);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			success: true,
			data: { restoredCFs: ["Shared CF"], skippedShared: [] },
		});
		expect(updateFormat).toHaveBeenCalledWith(7, survivorFormat);
	});

	it("unwinds the latest shared quality-profile write before preserving the survivor state", async () => {
		const survivorProfile = { id: 4, name: "Profile", formatItems: [{ format: 7, score: 100 }] };
		const targetProfile = { id: 4, name: "Profile", formatItems: [{ format: 7, score: 500 }] };
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
		getProfileById
			.mockResolvedValueOnce(targetProfile)
			.mockResolvedValueOnce(targetProfile)
			.mockResolvedValueOnce(survivorProfile);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(true);
		expect(updateProfile).toHaveBeenCalledWith(4, survivorProfile);
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					undeployProgress: expect.stringContaining(
						'"kind":"quality_profile","name":"Profile","outcome":"restored"',
					),
				}),
			}),
		);
	});

	it("unwinds the latest shared naming write before preserving the survivor state", async () => {
		const survivorNaming = { id: 1, standardMovieFormat: "V1" };
		const targetNaming = { id: 1, standardMovieFormat: "V2" };
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
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => targetNaming })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => survivorNaming });

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.json().success).toBe(true);
		expect(rawRequest).toHaveBeenCalledWith(instance, "/api/v3/config/naming", {
			method: "PUT",
			body: survivorNaming,
		});
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					undeployProgress: expect.stringContaining(
						'"kind":"naming","name":"Naming configuration","outcome":"restored"',
					),
				}),
			}),
		);
	});

	it("restores a pending naming write when ARR matches its persisted intent", async () => {
		const beforeNaming = { id: 1, standardMovieFormat: "Before" };
		const intendedNaming = { id: 1, standardMovieFormat: "Intended" };
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
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		rawRequest
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => intendedNaming })
			.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode, response.body).toBe(200);
		expect(response.json().success).toBe(true);
		expect(rawRequest).toHaveBeenCalledWith(instance, "/api/v3/config/naming", {
			method: "PUT",
			body: beforeNaming,
		});
	});

	it("fails closed without a naming PUT when a pending write matches neither known state", async () => {
		const beforeNaming = { id: 1, standardMovieFormat: "Before" };
		const intendedNaming = { id: 1, standardMovieFormat: "Intended" };
		const unknownNaming = { id: 1, standardMovieFormat: "Unknown" };
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
	});

	it("restores a profile before deleting a created Custom Format it referenced", async () => {
		const callOrder: string[] = [];
		const beforeProfile = { id: 4, name: "Profile", formatItems: [] };
		const deployedProfile = {
			id: 4,
			name: "Profile",
			formatItems: [{ format: 7, score: 100 }],
		};
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
				postStateToken: createUpstreamResourceStateToken(deployedProfile),
				intendedPostStateToken: createUpstreamResourceStateToken(deployedProfile),
			},
		});
		const history = currentHistory(data);
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		getAllProfiles.mockResolvedValueOnce([deployedProfile]).mockResolvedValue([beforeProfile]);
		getProfileById.mockResolvedValue(deployedProfile);
		updateProfile.mockImplementation(async () => {
			callOrder.push("profile-restored");
		});
		getAllFormats.mockResolvedValue([deployedFormat]);
		getFormatById.mockResolvedValue(deployedFormat);
		deleteFormat.mockImplementation(async () => {
			callOrder.push("format-deleted");
		});

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: true, data: { deleted: 1 } });
		expect(callOrder).toEqual(["profile-restored", "format-deleted"]);
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "history-1" },
				data: expect.objectContaining({ undeployStatus: "IN_PROGRESS" }),
			}),
		);
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "history-1" },
				data: expect.objectContaining({
					rolledBack: true,
					undeployStatus: "COMPLETED",
					undeployProgress: expect.stringContaining('"outcome":"deleted"'),
				}),
			}),
		);
	});

	it("stops before Custom Format deletion and records retryable progress when profile restore fails", async () => {
		const beforeProfile = { id: 4, name: "Profile", formatItems: [] };
		const deployedProfile = {
			id: 4,
			name: "Profile",
			formatItems: [{ format: 7, score: 100 }],
		};
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
					postStateToken: createUpstreamResourceStateToken(deployedProfile),
					intendedPostStateToken: createUpstreamResourceStateToken(deployedProfile),
				},
			}),
		);
		historyFindFirst.mockResolvedValue(history);
		historyFindMany.mockResolvedValue([history]);
		getAllProfiles.mockResolvedValue([deployedProfile]);
		getProfileById.mockResolvedValue(deployedProfile);
		updateProfile.mockRejectedValue(new Error("profile write failed"));
		getAllFormats.mockResolvedValue([deployedFormat]);
		getFormatById.mockResolvedValue(deployedFormat);

		const response = await createInjectAuthenticated(app)("POST", "/history/history-1/undeploy");

		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({ success: false, data: { deleted: 0 } });
		expect(deleteFormat).not.toHaveBeenCalled();
		expect(historyUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "history-1" },
				data: expect.objectContaining({
					undeployStatus: "PARTIAL",
					undeployProgress: expect.stringContaining("profile write failed"),
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
});
