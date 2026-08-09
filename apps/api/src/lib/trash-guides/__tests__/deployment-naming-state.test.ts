import { beforeEach, describe, expect, it, vi } from "vitest";

const getCachedNaming = vi.hoisted(() => vi.fn());
vi.mock("../cache-manager.js", () => ({
	createCacheManager: () => ({ get: getCachedNaming }),
}));

import { prepareNamingDeployment, restoreNamingDeployment } from "../deployment-naming-state.js";
import { createUpstreamResourceStateToken } from "../deployment-target.js";

function radarrConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		renameMovies: false,
		replaceIllegalCharacters: true,
		colonReplacementFormat: "smart",
		standardMovieFormat: "Original movie format",
		movieFolderFormat: "Original movie folder",
		...overrides,
	};
}

function sonarrConfig(overrides: Record<string, unknown> = {}) {
	return {
		id: 1,
		renameEpisodes: false,
		replaceIllegalCharacters: true,
		colonReplacementFormat: 4,
		customColonReplacementFormat: null,
		multiEpisodeStyle: 5,
		standardEpisodeFormat: "Original standard format",
		dailyEpisodeFormat: "Original daily format",
		animeEpisodeFormat: "Original anime format",
		seriesFolderFormat: "Original series folder",
		seasonFolderFormat: "Original season folder",
		specialsFolderFormat: "Original specials folder",
		...overrides,
	};
}

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
		const currentConfig = radarrConfig({
			standardMovieFormat: "Old format",
			movieFolderFormat: "{Movie Title}",
		});
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

	it("rejects an unknown upstream naming response shape", async () => {
		const rawRequest = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue({ error: "reverse proxy response" }),
		});

		await expect(
			prepareNamingDeployment(
				{} as never,
				{ rawRequest } as never,
				{ service: "RADARR" } as never,
				{ serviceType: "RADARR", filePreset: "Recommended", folderPreset: "Recommended" },
			),
		).rejects.toThrow("invalid RADARR naming configuration");
	});

	it("rejects an incomplete service-specific naming response", async () => {
		const { replaceIllegalCharacters: _missing, ...incomplete } = radarrConfig();
		const rawRequest = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: vi.fn().mockResolvedValue(incomplete),
		});

		await expect(
			prepareNamingDeployment(
				{} as never,
				{ rawRequest } as never,
				{ service: "RADARR" } as never,
				{ serviceType: "RADARR", filePreset: "Recommended", folderPreset: "Recommended" },
			),
		).rejects.toThrow("invalid RADARR naming configuration");
	});
});

describe("restoreNamingDeployment", () => {
	it("retains exact deployed naming when restoration has no conditional boundary", async () => {
		const snapshot = radarrConfig();
		const deployedConfig = radarrConfig({ standardMovieFormat: "Deployed" });
		const rawRequest = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(deployedConfig),
			})
			.mockResolvedValueOnce({ ok: true, status: 202 })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(snapshot),
			});

		await expect(
			restoreNamingDeployment(
				{ rawRequest } as never,
				{ service: "RADARR" } as never,
				snapshot,
				createUpstreamResourceStateToken(deployedConfig),
			),
		).rejects.toThrow("cannot be restored safely");

		expect(rawRequest).toHaveBeenCalledTimes(1);
		expect(rawRequest).not.toHaveBeenCalledWith(
			expect.anything(),
			"/api/v3/config/naming",
			expect.objectContaining({ method: "PUT" }),
		);
	});

	it("does not report restore success when naming follow-up state still differs", async () => {
		const snapshot = radarrConfig();
		const deployedConfig = radarrConfig({ standardMovieFormat: "Deployed" });
		const rawRequest = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(deployedConfig),
			})
			.mockResolvedValueOnce({ ok: true, status: 202 })
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(deployedConfig),
			});

		await expect(
			restoreNamingDeployment(
				{ rawRequest } as never,
				{ service: "RADARR" } as never,
				snapshot,
				createUpstreamResourceStateToken(deployedConfig),
			),
		).rejects.toThrow("did not match its pre-deployment state after restore");
	});

	it("refuses to overwrite naming configuration changed after deployment", async () => {
		const rawRequest = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			json: vi
				.fn()
				.mockResolvedValue(radarrConfig({ standardMovieFormat: "Changed by another action" })),
		});

		await expect(
			restoreNamingDeployment(
				{ rawRequest } as never,
				{ service: "RADARR" } as never,
				radarrConfig(),
				createUpstreamResourceStateToken(radarrConfig({ standardMovieFormat: "Deployed" })),
			),
		).rejects.toThrow("Naming configuration changed after this deployment");
		expect(rawRequest).toHaveBeenCalledTimes(1);
	});

	it("rejects an incomplete persisted naming snapshot before issuing a PUT", async () => {
		const deployedConfig = radarrConfig({ standardMovieFormat: "Deployed" });
		const rawRequest = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(deployedConfig),
			})
			.mockResolvedValueOnce({ ok: true, status: 202 });

		await expect(
			restoreNamingDeployment(
				{ rawRequest } as never,
				{ service: "RADARR" } as never,
				{ id: 1, standardMovieFormat: "Original" },
				createUpstreamResourceStateToken(deployedConfig),
			),
		).rejects.toThrow("snapshot is incomplete");
		expect(rawRequest).not.toHaveBeenCalled();
	});

	it("rejects a Sonarr snapshot missing a complete restore field", async () => {
		const { specialsFolderFormat: _missing, ...incomplete } = sonarrConfig();
		const rawRequest = vi.fn();

		await expect(
			restoreNamingDeployment(
				{ rawRequest } as never,
				{ service: "SONARR" } as never,
				incomplete,
				createUpstreamResourceStateToken(sonarrConfig({ standardEpisodeFormat: "Deployed" })),
			),
		).rejects.toThrow("snapshot is incomplete");
		expect(rawRequest).not.toHaveBeenCalled();
	});

	it("rejects a naming snapshot for a different service", async () => {
		const deployedConfig = sonarrConfig({ standardEpisodeFormat: "Deployed" });
		const rawRequest = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: vi.fn().mockResolvedValue(deployedConfig),
			})
			.mockResolvedValueOnce({ ok: true, status: 202 });

		await expect(
			restoreNamingDeployment(
				{ rawRequest } as never,
				{ service: "SONARR" } as never,
				radarrConfig(),
				createUpstreamResourceStateToken(deployedConfig),
			),
		).rejects.toThrow("does not match SONARR");
		expect(rawRequest).not.toHaveBeenCalled();
	});
});
