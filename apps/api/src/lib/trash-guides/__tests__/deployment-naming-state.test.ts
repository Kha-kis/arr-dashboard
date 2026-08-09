import { beforeEach, describe, expect, it, vi } from "vitest";

const getCachedNaming = vi.hoisted(() => vi.fn());
vi.mock("../cache-manager.js", () => ({
	createCacheManager: () => ({ get: getCachedNaming }),
}));

import { prepareNamingDeployment, restoreNamingDeployment } from "../deployment-naming-state.js";
import { createUpstreamResourceStateToken } from "../deployment-target.js";

describe("prepareNamingDeployment", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getCachedNaming.mockResolvedValue([
			{
				_service: "RADARR",
				file: { Recommended: "{Movie CleanTitle}" },
				folder: { Recommended: "{Movie Title}" },
			},
		]);
	});

	it("returns the exact current snapshot, merged payload, and changed fields", async () => {
		const currentConfig = {
			id: 1,
			renameMovies: false,
			standardMovieFormat: "Old format",
			movieFolderFormat: "{Movie Title}",
		};
		const rawRequest = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue(currentConfig),
		});

		const result = await prepareNamingDeployment(
			{} as never,
			{ rawRequest } as never,
			{ service: "RADARR" } as never,
			{ serviceType: "RADARR", filePreset: "Recommended", folderPreset: "Recommended" },
		);

		expect(result.currentConfig).toEqual(currentConfig);
		expect(result.changedFields).toEqual(["standardMovieFormat"]);
		expect(result.mergedConfig).toEqual({
			...currentConfig,
			standardMovieFormat: "{Movie CleanTitle}",
		});
	});
});

describe("restoreNamingDeployment", () => {
	it("restores the exact backed-up naming payload", async () => {
		const snapshot = { id: 1, standardMovieFormat: "Original" };
		const deployedConfig = { id: 1, standardMovieFormat: "Deployed" };
		const rawRequest = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(deployedConfig),
			})
			.mockResolvedValueOnce({ ok: true, status: 202 });

		await restoreNamingDeployment(
			{ rawRequest } as never,
			{ service: "RADARR" } as never,
			snapshot,
			createUpstreamResourceStateToken(deployedConfig),
		);

		expect(rawRequest).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ service: "RADARR" }),
			"/api/v3/config/naming",
			{ method: "PUT", body: snapshot },
		);
	});

	it("refuses to overwrite naming configuration changed after deployment", async () => {
		const rawRequest = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue({ id: 1, standardMovieFormat: "Changed by another action" }),
		});

		await expect(
			restoreNamingDeployment(
				{ rawRequest } as never,
				{ service: "RADARR" } as never,
				{ id: 1, standardMovieFormat: "Original" },
				createUpstreamResourceStateToken({ id: 1, standardMovieFormat: "Deployed" }),
			),
		).rejects.toThrow("Naming configuration changed after this deployment");
		expect(rawRequest).toHaveBeenCalledTimes(1);
	});
});
