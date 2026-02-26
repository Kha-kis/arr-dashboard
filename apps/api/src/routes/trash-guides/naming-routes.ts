/**
 * Naming Routes
 *
 * Endpoints for managing TRaSH Guides naming scheme presets
 * deployed to Sonarr/Radarr instances.
 */

import {
	TRASH_CONFIG_TYPES,
	type NamingSelectedPresets,
	type TrashNamingData,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import {
	CacheCorruptionError,
	createCacheManager,
} from "../../lib/trash-guides/cache-manager.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import {
	buildPreview,
	computeNamingHash,
	extractPresets,
	resolvePayload,
	validateSelectedPresets,
} from "../../lib/trash-guides/naming-deployer.js";
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Request Schemas
// ============================================================================

const presetsQuerySchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
});

const radarrSelectedPresetsSchema = z.object({
	serviceType: z.literal("RADARR"),
	filePreset: z.string().nullable().default(null),
	folderPreset: z.string().nullable().default(null),
});

const sonarrSelectedPresetsSchema = z.object({
	serviceType: z.literal("SONARR"),
	standardEpisodePreset: z.string().nullable().default(null),
	dailyEpisodePreset: z.string().nullable().default(null),
	animeEpisodePreset: z.string().nullable().default(null),
	seriesFolderPreset: z.string().nullable().default(null),
	seasonFolderPreset: z.string().nullable().default(null),
});

const selectedPresetsSchema = z.discriminatedUnion("serviceType", [
	radarrSelectedPresetsSchema,
	sonarrSelectedPresetsSchema,
]);

const previewBodySchema = z.object({
	instanceId: z.string().min(1),
	selectedPresets: selectedPresetsSchema,
});

const applyBodySchema = z.object({
	instanceId: z.string().min(1),
	selectedPresets: selectedPresetsSchema,
});

const configQuerySchema = z.object({
	instanceId: z.string().min(1),
});

const syncStrategySchema = z.enum(["auto", "manual", "notify"]).default("manual");

const configBodySchema = z.object({
	instanceId: z.string().min(1),
	selectedPresets: selectedPresetsSchema,
	syncStrategy: syncStrategySchema.optional(),
});

const configPatchSchema = z.object({
	selectedPresets: selectedPresetsSchema.optional(),
	syncStrategy: syncStrategySchema.optional(),
});

// ============================================================================
// Helpers
// ============================================================================

interface PresetLogger {
	warn: (obj: object, msg: string) => void;
}

/**
 * Safely parse stored JSON selectedPresets, validating against schema.
 * Returns null if the stored data is corrupt or doesn't match the expected shape.
 * Logs validation details when a logger is provided.
 */
function parseStoredPresets(
	raw: string,
	log?: PresetLogger,
): NamingSelectedPresets | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		const result = selectedPresetsSchema.safeParse(parsed);
		if (result.success) return result.data;
		log?.warn(
			{ issues: result.error.issues },
			"Stored naming presets failed schema validation",
		);
		return null;
	} catch (error) {
		log?.warn(
			{ err: error },
			"Stored naming presets JSON is unparseable",
		);
		return null;
	}
}

/**
 * Parse a response body as JSON, returning a 502 error on parse failure.
 * Handles reverse-proxy HTML error pages that aren't valid JSON.
 */
async function parseJsonResponse(
	response: Response,
	instanceLabel: string,
	request: { log: PresetLogger },
	reply: { status: (code: number) => { send: (body: unknown) => unknown } },
	instanceId: string,
): Promise<Record<string, unknown> | null> {
	try {
		return (await response.json()) as Record<string, unknown>;
	} catch (error) {
		request.log.warn(
			{ err: error, instanceId, status: response.status },
			"Instance returned non-JSON response for naming config",
		);
		reply.status(502).send({
			success: false,
			error: `${instanceLabel} returned an invalid response. Check that the instance URL is correct and not behind a misconfigured reverse proxy.`,
		});
		return null;
	}
}

// ============================================================================
// Route Handlers
// ============================================================================

export async function namingRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	const cacheManager = createCacheManager(app.prisma);

	async function getFetcher(userId: string) {
		const repoConfig = await getRepoConfig(app.prisma, userId);
		return createTrashFetcher({ repoConfig, logger: app.log });
	}

	/**
	 * Fetch naming data from cache, auto-refreshing if stale or corrupted.
	 * Uses NAMING_PRESETS cache key (separate from NAMING used for TrashNamingScheme[]).
	 * Returns the first (and typically only) naming data object for the service.
	 */
	async function getNamingData(
		userId: string,
		serviceType: "RADARR" | "SONARR",
	): Promise<TrashNamingData | null> {
		const configType = TRASH_CONFIG_TYPES.NAMING_PRESETS;
		const isFresh = await cacheManager.isFresh(serviceType, configType);

		if (!isFresh) {
			app.log.info({ serviceType }, "Naming preset cache stale, fetching from GitHub");
			const fetcher = await getFetcher(userId);
			const data = await fetcher.fetchNamingData(serviceType);
			await cacheManager.set(serviceType, configType, data);
			return data[0] ?? null;
		}

		let data: TrashNamingData[] | null = null;
		try {
			data = await cacheManager.get<TrashNamingData[]>(serviceType, configType);
		} catch (error) {
			if (!(error instanceof CacheCorruptionError)) throw error;
			// Cache corrupted and auto-deleted — re-fetch from GitHub
			app.log.warn({ serviceType }, "Naming preset cache corrupted, re-fetching from GitHub");
		}

		if (!data) {
			const fetcher = await getFetcher(userId);
			const freshData = await fetcher.fetchNamingData(serviceType);
			await cacheManager.set(serviceType, configType, freshData);
			return freshData[0] ?? null;
		}

		return data[0] ?? null;
	}

	/**
	 * GET /api/trash-guides/naming/presets?serviceType=RADARR|SONARR
	 * Returns available naming presets from the TRaSH cache.
	 */
	app.get<{ Querystring: z.infer<typeof presetsQuerySchema> }>(
		"/presets",
		async (request, reply) => {
			const { serviceType } = validateRequest(presetsQuerySchema, request.query);
			const naming = await getNamingData(request.currentUser!.id, serviceType);

			if (!naming) {
				return reply.send({
					success: true,
					presets: null,
					message: "No naming data available for this service type",
				});
			}

			return reply.send({
				success: true,
				presets: extractPresets(naming),
			});
		},
	);

	/**
	 * POST /api/trash-guides/naming/preview
	 * Preview the diff between selected presets and the instance's current naming config.
	 */
	app.post<{ Body: z.infer<typeof previewBodySchema> }>("/preview", async (request, reply) => {
		const { instanceId, selectedPresets } = validateRequest(previewBodySchema, request.body);
		const userId = request.currentUser!.id;

		const instance = await requireInstance(app, userId, instanceId);

		if (instance.service !== "SONARR" && instance.service !== "RADARR") {
			return reply.status(400).send({
				success: false,
				error: `Naming presets are not supported for ${instance.service} instances`,
			});
		}

		const serviceType = instance.service === "SONARR" ? "SONARR" : "RADARR";

		// Fail fast if preset service type doesn't match instance
		if (selectedPresets.serviceType !== serviceType) {
			return reply.status(400).send({
				success: false,
				error: `Selected presets are for ${selectedPresets.serviceType} but instance is ${serviceType}`,
			});
		}

		const naming = await getNamingData(userId, serviceType);

		if (!naming) {
			return reply.status(404).send({
				success: false,
				error: `No naming data available for ${serviceType}`,
			});
		}

		// Validate selected presets exist in naming data
		const validationErrors = validateSelectedPresets(naming, selectedPresets);
		if (validationErrors.length > 0) {
			return reply.status(400).send({
				success: false,
				error: "Invalid preset selection",
				details: validationErrors,
			});
		}

		// Fetch current naming config from instance
		let response: Response;
		try {
			response = await app.arrClientFactory.rawRequest(instance, "/api/v3/config/naming");
		} catch (error) {
			request.log.error(
				{ err: error, instanceId },
				"Network error fetching naming config from instance",
			);
			return reply.status(502).send({
				success: false,
				error: `Failed to connect to ${instance.label}: ${getErrorMessage(error, "Network error")}`,
			});
		}

		if (!response.ok) {
			return reply.status(502).send({
				success: false,
				error: `Failed to fetch naming config from ${instance.label}: HTTP ${response.status}`,
			});
		}

		const currentConfig = await parseJsonResponse(response, instance.label, request, reply, instanceId);
		if (!currentConfig) return; // parseJsonResponse already sent 502

		// Build preview using discriminated union dispatch
		const preview = buildPreview(naming, selectedPresets, currentConfig);

		return reply.send({
			success: true,
			preview,
		});
	});

	/**
	 * POST /api/trash-guides/naming/apply
	 * Apply selected naming presets to an instance.
	 * Fetches current config, merges the patch, and PUTs it back.
	 */
	app.post<{ Body: z.infer<typeof applyBodySchema> }>("/apply", async (request, reply) => {
		const { instanceId, selectedPresets } = validateRequest(applyBodySchema, request.body);
		const userId = request.currentUser!.id;

		const instance = await requireInstance(app, userId, instanceId);

		if (instance.service !== "SONARR" && instance.service !== "RADARR") {
			return reply.status(400).send({
				success: false,
				error: `Naming presets are not supported for ${instance.service} instances`,
			});
		}

		const serviceType = instance.service === "SONARR" ? "SONARR" : "RADARR";

		// Fail fast if preset service type doesn't match instance
		if (selectedPresets.serviceType !== serviceType) {
			return reply.status(400).send({
				success: false,
				error: `Selected presets are for ${selectedPresets.serviceType} but instance is ${serviceType}`,
			});
		}

		const naming = await getNamingData(userId, serviceType);

		if (!naming) {
			return reply.status(404).send({
				success: false,
				error: `No naming data available for ${serviceType}`,
			});
		}

		// Validate selected presets exist in naming data
		const validationErrors = validateSelectedPresets(naming, selectedPresets);
		if (validationErrors.length > 0) {
			return reply.status(400).send({
				success: false,
				error: "Invalid preset selection",
				details: validationErrors,
			});
		}

		// Resolve the payload patch using double-narrowing dispatch
		const patch = resolvePayload(naming, selectedPresets);

		if (Object.keys(patch).length === 0) {
			return reply.status(400).send({
				success: false,
				error: "No presets selected — nothing to apply",
			});
		}

		// GET current config
		let getResponse: Response;
		try {
			getResponse = await app.arrClientFactory.rawRequest(
				instance,
				"/api/v3/config/naming",
			);
		} catch (error) {
			request.log.error(
				{ err: error, instanceId },
				"Network error fetching naming config from instance",
			);
			return reply.status(502).send({
				success: false,
				error: `Failed to connect to ${instance.label}: ${getErrorMessage(error, "Network error")}`,
			});
		}

		if (!getResponse.ok) {
			return reply.status(502).send({
				success: false,
				error: `Failed to fetch naming config from ${instance.label}: HTTP ${getResponse.status}`,
			});
		}

		const currentConfig = await parseJsonResponse(getResponse, instance.label, request, reply, instanceId);
		if (!currentConfig) return; // parseJsonResponse already sent 502

		// Merge patch onto current config
		const merged = { ...currentConfig, ...patch };

		// PUT merged config back
		let putResponse: Response;
		try {
			putResponse = await app.arrClientFactory.rawRequest(
				instance,
				"/api/v3/config/naming",
				{ method: "PUT", body: merged },
			);
		} catch (error) {
			request.log.error(
				{ err: error, instanceId },
				"Network error applying naming config to instance",
			);
			return reply.status(502).send({
				success: false,
				error: `Failed to connect to ${instance.label}: ${getErrorMessage(error, "Network error")}`,
			});
		}

		if (!putResponse.ok) {
			const errorText = await putResponse.text().catch(() => "Unknown error");
			request.log.error(
				{ instanceId, status: putResponse.status, errorText },
				"Failed to apply naming config to instance",
			);
			return reply.status(502).send({
				success: false,
				error: `Failed to apply naming config to ${instance.label}: HTTP ${putResponse.status}`,
			});
		}

		// Compute hash of applied payload for change detection
		const deployedHash = computeNamingHash(patch);

		// Upsert NamingConfig record
		let configSaved = true;
		try {
			await app.prisma.namingConfig.upsert({
				where: { instanceId },
				create: {
					instanceId,
					userId,
					serviceType,
					selectedPresets: JSON.stringify(selectedPresets),
					lastDeployedAt: new Date(),
					lastDeployedHash: deployedHash,
				},
				update: {
					selectedPresets: JSON.stringify(selectedPresets),
					lastDeployedAt: new Date(),
					lastDeployedHash: deployedHash,
				},
			});
		} catch (configError) {
			// P2002 = unique constraint race (concurrent upserts) — safe to swallow.
			// All other errors (connection, timeout, auth) must propagate.
			if ((configError as { code?: string }).code === "P2002") {
				configSaved = false;
				request.log.warn(
					{ err: configError, instanceId },
					"Naming config upsert hit unique constraint race — config not saved",
				);
			} else {
				throw configError;
			}
		}

		// Count fields that were actually set (exclude renameMovies/renameEpisodes toggle)
		const fieldCount = Object.keys(patch).filter(
			(k) => k !== "renameMovies" && k !== "renameEpisodes",
		).length;

		app.log.info(
			{ instanceId, serviceType, fieldCount, configSaved },
			"Applied naming presets to instance",
		);

		return reply.send({
			success: true,
			fieldCount,
			message: configSaved
				? `Applied ${fieldCount} naming format(s) to ${instance.label}`
				: `Applied ${fieldCount} naming format(s) to ${instance.label}, but config tracking could not be saved. Re-apply to fix.`,
			...(configSaved ? {} : { warning: "CONFIG_SAVE_FAILED" }),
		});
	});

	/**
	 * GET /api/trash-guides/naming/configs?instanceId=xxx
	 * Get the saved NamingConfig for an instance.
	 */
	app.get<{ Querystring: z.infer<typeof configQuerySchema> }>(
		"/configs",
		async (request, reply) => {
			const { instanceId } = validateRequest(configQuerySchema, request.query);
			const userId = request.currentUser!.id;

			await requireInstance(app, userId, instanceId);

			const config = await app.prisma.namingConfig.findUnique({
				where: { instanceId },
			});

			if (!config) {
				return reply.send({ success: true, config: null });
			}

			const selectedPresets = parseStoredPresets(config.selectedPresets, request.log);
			if (!selectedPresets) {
				request.log.warn(
					{ instanceId },
					"Stored naming config has corrupt selectedPresets JSON",
				);
				return reply.send({ success: true, config: null });
			}

			return reply.send({
				success: true,
				config: {
					instanceId: config.instanceId,
					serviceType: config.serviceType as "RADARR" | "SONARR",
					selectedPresets,
					syncStrategy: config.syncStrategy as "auto" | "manual" | "notify",
					lastDeployedAt: config.lastDeployedAt?.toISOString() ?? null,
					lastDeployedHash: config.lastDeployedHash,
					createdAt: config.createdAt.toISOString(),
					updatedAt: config.updatedAt.toISOString(),
				},
			});
		},
	);

	/**
	 * POST /api/trash-guides/naming/configs
	 * Create or update a NamingConfig (upsert by instanceId).
	 */
	app.post<{ Body: z.infer<typeof configBodySchema> }>("/configs", async (request, reply) => {
		const { instanceId, selectedPresets, syncStrategy } = validateRequest(configBodySchema, request.body);
		const userId = request.currentUser!.id;

		const instance = await requireInstance(app, userId, instanceId);

		if (instance.service !== "SONARR" && instance.service !== "RADARR") {
			return reply.status(400).send({
				success: false,
				error: `Naming configs are not supported for ${instance.service} instances`,
			});
		}

		const serviceType = instance.service === "SONARR" ? "SONARR" : "RADARR";
		const strategy = syncStrategy ?? "manual";

		const config = await app.prisma.namingConfig.upsert({
			where: { instanceId },
			create: {
				instanceId,
				userId,
				serviceType,
				selectedPresets: JSON.stringify(selectedPresets),
				syncStrategy: strategy,
			},
			update: {
				selectedPresets: JSON.stringify(selectedPresets),
				syncStrategy: strategy,
			},
		});

		// Re-parse the just-stored presets (guaranteed valid since we just serialized them)
		const storedPresets = parseStoredPresets(config.selectedPresets, request.log);
		if (!storedPresets) {
			request.log.warn(
				{ instanceId },
				"Just-stored naming config failed re-parse, returning input presets as fallback",
			);
		}

		return reply.send({
			success: true,
			config: {
				instanceId: config.instanceId,
				serviceType: config.serviceType as "RADARR" | "SONARR",
				selectedPresets: storedPresets ?? selectedPresets,
				syncStrategy: config.syncStrategy as "auto" | "manual" | "notify",
				lastDeployedAt: config.lastDeployedAt?.toISOString() ?? null,
				lastDeployedHash: config.lastDeployedHash,
				createdAt: config.createdAt.toISOString(),
				updatedAt: config.updatedAt.toISOString(),
			},
		});
	});

	/**
	 * PATCH /api/trash-guides/naming/configs/:instanceId
	 * Partial update of a NamingConfig.
	 */
	app.patch<{
		Params: { instanceId: string };
		Body: z.infer<typeof configPatchSchema>;
	}>("/configs/:instanceId", async (request, reply) => {
		const instanceId = request.params.instanceId;
		const body = validateRequest(configPatchSchema, request.body);
		const userId = request.currentUser!.id;

		await requireInstance(app, userId, instanceId);

		const existing = await app.prisma.namingConfig.findUnique({
			where: { instanceId },
		});

		if (!existing) {
			return reply.status(404).send({
				success: false,
				error: "No naming config exists for this instance. Save a config first.",
			});
		}

		const updateData: Record<string, unknown> = {};
		if (body.selectedPresets) {
			updateData.selectedPresets = JSON.stringify(body.selectedPresets);
		}
		if (body.syncStrategy) {
			updateData.syncStrategy = body.syncStrategy;
		}

		const config = await app.prisma.namingConfig.update({
			where: { instanceId },
			data: updateData,
		});

		const storedPresets = parseStoredPresets(config.selectedPresets, request.log);
		if (!storedPresets) {
			request.log.warn(
				{ instanceId },
				"Stored naming config has corrupt selectedPresets JSON after update",
			);
			return reply.status(500).send({
				success: false,
				error: "Config saved but stored data is corrupt",
			});
		}

		return reply.send({
			success: true,
			config: {
				instanceId: config.instanceId,
				serviceType: config.serviceType as "RADARR" | "SONARR",
				selectedPresets: storedPresets,
				syncStrategy: config.syncStrategy as "auto" | "manual" | "notify",
				lastDeployedAt: config.lastDeployedAt?.toISOString() ?? null,
				lastDeployedHash: config.lastDeployedHash,
				createdAt: config.createdAt.toISOString(),
				updatedAt: config.updatedAt.toISOString(),
			},
		});
	});

	/**
	 * DELETE /api/trash-guides/naming/configs/:instanceId
	 * Delete a NamingConfig.
	 */
	app.delete<{ Params: { instanceId: string } }>(
		"/configs/:instanceId",
		async (request, reply) => {
			const instanceId = request.params.instanceId;
			const userId = request.currentUser!.id;

			await requireInstance(app, userId, instanceId);

			try {
				await app.prisma.namingConfig.delete({
					where: { instanceId },
				});
			} catch (error) {
				// P2025 = record not found — expected when config doesn't exist
				if ((error as { code?: string }).code === "P2025") {
					return reply.status(404).send({
						success: false,
						error: "No naming config exists for this instance",
					});
				}
				throw error;
			}

			return reply.send({
				success: true,
				message: "Naming config deleted",
			});
		},
	);
}
