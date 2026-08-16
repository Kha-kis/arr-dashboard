import type { TrashQualitySize } from "@arr/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cacheGet: vi.fn() }));

vi.mock("../cache-manager.js", () => ({
	createCacheManager: vi.fn(() => ({ get: mocks.cacheGet })),
}));

import { UpdateScheduler } from "../update-scheduler.js";
import { createDeploymentEndpointKey } from "../deployment-target.js";

const instance = {
	id: "instance-1",
	userId: "user-1",
	service: "RADARR",
	label: "Radarr",
	baseUrl: "http://radarr:7878",
	encryptedApiKey: "encrypted",
	encryptionIv: "iv",
	encryptedHttpAuthCredentials: null,
	httpAuthEncryptionIv: null,
	connectionGeneration: 0,
	enabled: true,
};

function createHarness() {
	const rawRequest = vi.fn();
	const create = vi.fn();
	const runWithEndpointMutation = vi.fn(
		async (
			userId: string,
			target: typeof instance,
			_operation: string,
			action: (endpointKey: string) => Promise<unknown>,
		) =>
			action(
				createDeploymentEndpointKey(userId, {
					...target,
					credentialIdentity: "credential-1",
				}),
			),
	);
	const prisma = {
		qualitySizeMapping: {
			count: vi.fn().mockResolvedValue(1),
			findMany: vi.fn().mockResolvedValue([]),
			update: vi.fn(),
		},
		namingConfig: {
			count: vi.fn().mockResolvedValue(1),
			findMany: vi.fn().mockResolvedValue([]),
			update: vi.fn(),
		},
		serviceInstance: { findMany: vi.fn().mockResolvedValue([instance]) },
		trashSyncHistory: {
			findMany: vi.fn().mockResolvedValue([
				{
					status: "UNCERTAIN",
					rollbackStatus: null,
					backupId: null,
					backup: null,
				},
			]),
		},
		templateDeploymentHistory: { findMany: vi.fn().mockResolvedValue([]) },
		instanceQualityProfileOverride: { findMany: vi.fn().mockResolvedValue([]) },
	};
	const scheduler = new UpdateScheduler(
		{ enabled: true, intervalHours: 12 },
		{} as never,
		{} as never,
		prisma as never,
		{ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		{
			rawRequest,
			create,
			createConnectionCredentialIdentity: vi.fn().mockReturnValue("credential-1"),
		} as never,
		{ deploymentExecutor: { runWithEndpointMutation } as never },
	);

	return {
		scheduler: scheduler as unknown as {
			processQualitySizeSync: (
				verifiedData: ReadonlyMap<"RADARR" | "SONARR", readonly TrashQualitySize[]>,
			) => Promise<{ autoSynced: number; errors: string[] }>;
			processNamingSync: () => Promise<{ autoSynced: number; errors: string[] }>;
		},
		prisma,
		rawRequest,
		create,
		runWithEndpointMutation,
	};
}

function verifiedQualitySizeData(): ReadonlyMap<"RADARR" | "SONARR", TrashQualitySize[]> {
	return new Map([["RADARR", [{ trash_id: "preset-1", type: "movie", qualities: [] }]]]);
}

describe("TRaSH scheduler ARR writer safety", () => {
	beforeEach(() => vi.clearAllMocks());

	it("blocks quality-size auto-sync behind endpoint recovery authority", async () => {
		const harness = createHarness();
		harness.prisma.qualitySizeMapping.findMany.mockResolvedValueOnce([
			{
				id: "quality-size-1",
				instanceId: instance.id,
				serviceType: "RADARR",
				presetTrashId: "preset-1",
				appliedDataHash: "stale",
				syncStrategy: "auto",
				instance,
			},
		]);

		const result = await harness.scheduler.processQualitySizeSync(verifiedQualitySizeData());

		expect(harness.runWithEndpointMutation).toHaveBeenCalledWith(
			"user-1",
			instance,
			"Scheduled quality-size sync",
			expect.any(Function),
		);
		expect(result.autoSynced).toBe(0);
		expect(result.errors[0]).toContain("uncertain upstream result");
		expect(harness.rawRequest).not.toHaveBeenCalled();
		expect(harness.create).not.toHaveBeenCalled();
	});

	it("blocks naming auto-sync behind endpoint recovery authority", async () => {
		const harness = createHarness();
		harness.prisma.namingConfig.findMany.mockResolvedValueOnce([
			{
				id: "naming-1",
				instanceId: instance.id,
				serviceType: "RADARR",
				selectedPresets: JSON.stringify({
					serviceType: "RADARR",
					filePreset: "TRaSH Recommended",
					folderPreset: null,
				}),
				lastDeployedHash: "stale",
				syncStrategy: "auto",
				instance,
			},
		]);
		mocks.cacheGet.mockResolvedValueOnce([
			{
				_service: "RADARR",
				file: { "TRaSH Recommended": "{Movie CleanTitle}" },
				folder: {},
			},
		]);

		const result = await harness.scheduler.processNamingSync();

		expect(harness.runWithEndpointMutation).toHaveBeenCalledWith(
			"user-1",
			instance,
			"Scheduled naming sync",
			expect.any(Function),
		);
		expect(result.autoSynced).toBe(0);
		expect(result.errors[0]).toContain("uncertain upstream result");
		expect(harness.rawRequest).not.toHaveBeenCalled();
	});

	it("fails closed when the scheduled target connection changes before the lock is authorized", async () => {
		const harness = createHarness();
		harness.prisma.qualitySizeMapping.findMany.mockResolvedValueOnce([
			{
				id: "quality-size-1",
				instanceId: instance.id,
				serviceType: "RADARR",
				presetTrashId: "preset-1",
				appliedDataHash: "stale",
				syncStrategy: "auto",
				instance,
			},
		]);
		harness.prisma.serviceInstance.findMany.mockResolvedValueOnce([
			{ ...instance, connectionGeneration: 1 },
		]);
		harness.prisma.trashSyncHistory.findMany.mockResolvedValueOnce([]);

		const result = await harness.scheduler.processQualitySizeSync(verifiedQualitySizeData());

		expect(result.autoSynced).toBe(0);
		expect(result.errors[0]).toContain("connection changed");
		expect(harness.rawRequest).not.toHaveBeenCalled();
		expect(harness.create).not.toHaveBeenCalled();
	});

	it("does not read retained quality-size data when the tick did not verify it", async () => {
		const harness = createHarness();
		harness.prisma.qualitySizeMapping.findMany.mockResolvedValueOnce([
			{
				id: "quality-size-1",
				instanceId: instance.id,
				serviceType: "RADARR",
				presetTrashId: "preset-1",
				appliedDataHash: "stale",
				syncStrategy: "auto",
				instance,
			},
		]);
		mocks.cacheGet.mockResolvedValueOnce([{ trash_id: "replacement", qualities: [] }]);

		const result = await harness.scheduler.processQualitySizeSync(new Map());

		expect(result.autoSynced).toBe(0);
		expect(mocks.cacheGet).not.toHaveBeenCalled();
		expect(harness.runWithEndpointMutation).not.toHaveBeenCalled();
		expect(harness.rawRequest).not.toHaveBeenCalled();
	});

	it("executes with the verified payload even if the shared cache is replaced", async () => {
		const harness = createHarness();
		harness.prisma.qualitySizeMapping.findMany.mockResolvedValueOnce([
			{
				id: "quality-size-1",
				instanceId: instance.id,
				serviceType: "RADARR",
				presetTrashId: "preset-1",
				appliedDataHash: "stale",
				syncStrategy: "auto",
				instance,
			},
		]);
		harness.prisma.trashSyncHistory.findMany.mockResolvedValueOnce([]);
		mocks.cacheGet.mockResolvedValueOnce([{ trash_id: "replacement", qualities: [] }]);
		harness.rawRequest.mockResolvedValueOnce({ ok: true });
		const updateAll = vi.fn().mockResolvedValue(undefined);
		harness.create.mockReturnValueOnce({
			qualityDefinition: {
				getAll: vi.fn().mockResolvedValue([]),
				updateAll,
			},
		});

		const result = await harness.scheduler.processQualitySizeSync(verifiedQualitySizeData());

		expect(result.autoSynced).toBe(1);
		expect(mocks.cacheGet).not.toHaveBeenCalled();
		expect(harness.rawRequest).toHaveBeenCalledTimes(1);
		expect(updateAll).toHaveBeenCalledTimes(1);
	});

	it("rejects a stale mapping whose service type differs from its selected instance", async () => {
		const harness = createHarness();
		harness.prisma.qualitySizeMapping.findMany.mockResolvedValueOnce([
			{
				id: "quality-size-1",
				instanceId: instance.id,
				serviceType: "RADARR",
				presetTrashId: "preset-1",
				appliedDataHash: "stale",
				syncStrategy: "auto",
				instance: { ...instance, service: "SONARR" },
			},
		]);

		const result = await harness.scheduler.processQualitySizeSync(verifiedQualitySizeData());

		expect(result.autoSynced).toBe(0);
		expect(result.errors[0]).toContain("service type changed");
		expect(harness.runWithEndpointMutation).not.toHaveBeenCalled();
		expect(harness.rawRequest).not.toHaveBeenCalled();
	});
});
