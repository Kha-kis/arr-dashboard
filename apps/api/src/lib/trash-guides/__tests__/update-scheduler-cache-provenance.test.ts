import type { TrashQualitySize } from "@arr/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cacheGet: vi.fn() }));

vi.mock("../cache-manager.js", () => ({
	createCacheManager: vi.fn(() => ({ get: mocks.cacheGet })),
}));

import { UpdateScheduler } from "../update-scheduler.js";

const radarrInstance = {
	id: "instance-1",
	userId: "user-1",
	service: "RADARR",
	label: "Radarr",
	enabled: true,
};

function createHarness(instance = radarrInstance, liveInstance = instance) {
	const prisma = {
		qualitySizeMapping: {
			count: vi.fn().mockResolvedValue(1),
			findMany: vi.fn().mockResolvedValue([
				{
					id: "quality-size-1",
					instanceId: instance.id,
					serviceType: "RADARR",
					presetTrashId: "preset-1",
					appliedDataHash: "stale",
					syncStrategy: "auto",
					instance,
				},
			]),
			update: vi.fn(),
		},
		serviceInstance: {
			findFirst: vi.fn().mockResolvedValue(liveInstance),
		},
	};
	const rawRequest = vi.fn().mockResolvedValue({ ok: true });
	const updateAll = vi.fn().mockResolvedValue(undefined);
	const create = vi.fn().mockReturnValue({
		qualityDefinition: {
			getAll: vi.fn().mockResolvedValue([]),
			updateAll,
		},
	});
	const scheduler = new UpdateScheduler(
		{ enabled: true, intervalHours: 12 },
		{} as never,
		{} as never,
		prisma as never,
		{ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		{ rawRequest, create } as never,
	) as unknown as {
		processQualitySizeSync: (
			verifiedData: ReadonlyMap<"RADARR" | "SONARR", readonly TrashQualitySize[]>,
		) => Promise<{ autoSynced: number; errors: string[] }>;
	};

	return { scheduler, prisma, rawRequest, create, updateAll };
}

describe("TRaSH scheduler cache provenance", () => {
	beforeEach(() => vi.clearAllMocks());

	it("does not read retained quality-size data when the tick did not verify its provenance", async () => {
		const harness = createHarness();
		mocks.cacheGet.mockResolvedValue([{ trash_id: "preset-1", qualities: [] }]);

		const result = await harness.scheduler.processQualitySizeSync(new Map());

		expect(result.autoSynced).toBe(0);
		expect(mocks.cacheGet).not.toHaveBeenCalled();
		expect(harness.rawRequest).not.toHaveBeenCalled();
		expect(harness.create).not.toHaveBeenCalled();
	});

	it("executes with the verified payload even if the shared cache is replaced", async () => {
		const harness = createHarness();
		const verifiedData: TrashQualitySize[] = [
			{ trash_id: "preset-1", type: "movie", qualities: [] },
		];
		mocks.cacheGet.mockResolvedValue([
			{ trash_id: "replacement", qualities: [{ quality: "wrong", min: 1, max: 2 }] },
		]);

		const result = await harness.scheduler.processQualitySizeSync(
			new Map([["RADARR", verifiedData]]),
		);

		expect(result.autoSynced).toBe(1);
		expect(mocks.cacheGet).not.toHaveBeenCalled();
		expect(harness.rawRequest).toHaveBeenCalledTimes(1);
		expect(harness.updateAll).toHaveBeenCalledTimes(1);
	});

	it("rejects a stale mapping whose service type no longer matches the live instance", async () => {
		const harness = createHarness(radarrInstance, { ...radarrInstance, service: "SONARR" });
		const verifiedData: TrashQualitySize[] = [
			{ trash_id: "preset-1", type: "movie", qualities: [] },
		];

		const result = await harness.scheduler.processQualitySizeSync(
			new Map([["RADARR", verifiedData]]),
		);

		expect(result.autoSynced).toBe(0);
		expect(result.errors[0]).toContain("service type changed");
		expect(harness.rawRequest).not.toHaveBeenCalled();
		expect(harness.create).not.toHaveBeenCalled();
	});

	it("authorizes only the service whose quality-size payload was verified", async () => {
		const sonarrData: TrashQualitySize[] = [
			{ trash_id: "sonarr-preset", type: "series", qualities: [] },
		];
		const templateUpdater = {
			refreshAllCaches: vi.fn(async (serviceType: "RADARR" | "SONARR") => ({
				refreshed: serviceType === "SONARR" ? 1 : 0,
				failed: serviceType === "RADARR" ? 1 : 0,
				errors: serviceType === "RADARR" ? ["QUALITY_SIZE: unavailable"] : [],
				verifiedConfigTypes: serviceType === "SONARR" ? ["QUALITY_SIZE"] : [],
				verifiedQualitySizeData: serviceType === "SONARR" ? sonarrData : null,
			})),
			checkForUpdates: vi.fn().mockResolvedValue({
				totalTemplates: 0,
				outdatedTemplates: 0,
				templatesWithUpdates: [],
			}),
		};
		const scheduler = new UpdateScheduler(
			{ enabled: true, intervalHours: 12 },
			templateUpdater as never,
			{
				getLatestCommit: vi.fn().mockResolvedValue({ commitHash: "latest", commitDate: "today" }),
			} as never,
			{
				trashTemplate: {
					count: vi.fn().mockResolvedValue(0),
					findMany: vi.fn().mockResolvedValue([]),
				},
			} as never,
			{ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		);
		const privateScheduler = scheduler as unknown as {
			processQualitySizeSync: (
				verifiedData: ReadonlyMap<"RADARR" | "SONARR", readonly TrashQualitySize[]>,
			) => Promise<unknown>;
			processNamingSync: () => Promise<unknown>;
		};
		const qualitySizeSpy = vi
			.spyOn(privateScheduler, "processQualitySizeSync")
			.mockResolvedValue({ autoSynced: 0, updatesPending: 0, errors: [] });
		vi.spyOn(privateScheduler, "processNamingSync").mockResolvedValue({
			autoSynced: 0,
			updatesPending: 0,
			errors: [],
		});

		await scheduler.triggerCheck();

		expect(qualitySizeSpy).toHaveBeenCalledTimes(1);
		const verifiedData = qualitySizeSpy.mock.calls[0]?.[0];
		expect(verifiedData?.has("RADARR")).toBe(false);
		expect(verifiedData?.get("SONARR")).toBe(sonarrData);
	});
});
