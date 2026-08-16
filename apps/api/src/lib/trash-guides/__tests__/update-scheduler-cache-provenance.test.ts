import type { TrashQualitySize } from "@arr/shared";
import { describe, expect, it, vi } from "vitest";
import { UpdateScheduler } from "../update-scheduler.js";

describe("TRaSH scheduler cache provenance", () => {
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
