/**
 * Naming Routes
 *
 * Endpoints for managing TRaSH Guides naming scheme presets
 * deployed to Sonarr/Radarr instances.
 */

import {
	TRASH_CONFIG_TYPES,
	type NamingDeployStatus,
	type NamingSelectedPresets,
	type TrashNamingData,
} from "@arr/shared";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { CacheCorruptionError, createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import { arrNamingConfigSchema } from "../../lib/trash-guides/github-schemas.js";
import {
	buildPreview,
	computeNamingHash,
	extractPresets,
	resolvePayload,
	validateSelectedPresets,
} from "../../lib/trash-guides/naming-deployer.js";
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";
import { delay } from "../../lib/utils/delay.js";
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
	enableRename: z.boolean().optional(),
});

const applyBodySchema = z.object({
	instanceId: z.string().min(1),
	selectedPresets: selectedPresetsSchema,
	enableRename: z.boolean().optional(),
});

const rollbackBodySchema = z.object({
	historyId: z.string().min(1),
});

const historyQuerySchema = z.object({
	instanceId: z.string().min(1),
	limit: z.coerce.number().min(1).max(100).default(20),
	offset: z.coerce.number().min(0).default(0),
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
function parseStoredPresets(raw: string, log?: PresetLogger): NamingSelectedPresets | null {
	try {
		const parsed: unknown = JSON.parse(raw);
		const result = selectedPresetsSchema.safeParse(parsed);
		if (result.success) return result.data;
		log?.warn({ issues: result.error.issues }, "Stored naming presets failed schema validation");
		return null;
	} catch (error) {
		log?.warn({ err: error }, "Stored naming presets JSON is unparseable");
		return null;
	}
}

/**
 * Parse a response body as JSON and validate against the ARR naming config schema.
 * Returns null and sends 502 on parse failure or schema validation failure.
 */
async function parseAndValidateArrNamingConfig(
	response: Response,
	instanceLabel: string,
	request: { log: { warn: (obj: object, msg: string) => void } },
	reply: { status: (code: number) => { send: (body: unknown) => unknown } },
	instanceId: string,
): Promise<Record<string, unknown> | null> {
	let rawJson: unknown;
	try {
		rawJson = await response.json();
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

	const validated = arrNamingConfigSchema.safeParse(rawJson);
	if (!validated.success) {
		request.log.warn(
			{ issues: validated.error.issues, instanceId },
			"Invalid naming config response from instance",
		);
		reply.status(502).send({
			success: false,
			error: `Invalid naming config response from ${instanceLabel}. The instance may be running an incompatible version.`,
		});
		return null;
	}

	return validated.data as Record<string, unknown>;
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
		const { instanceId, selectedPresets, enableRename } = validateRequest(
			previewBodySchema,
			request.body,
		);
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

		const currentConfig = await parseAndValidateArrNamingConfig(
			response,
			instance.label,
			request,
			reply,
			instanceId,
		);
		if (!currentConfig) return;

		// Build preview using discriminated union dispatch
		const preview = buildPreview(naming, selectedPresets, currentConfig, enableRename);

		return reply.send({
			success: true,
			preview,
		});
	});

	/**
	 * POST /api/trash-guides/naming/apply
	 * Apply selected naming presets to an instance.
	 * Snapshots current config before applying for rollback support.
	 * Retries once on network failure during PUT.
	 */
	app.post<{ Body: z.infer<typeof applyBodySchema> }>("/apply", async (request, reply) => {
		const { instanceId, selectedPresets, enableRename } = validateRequest(
			applyBodySchema,
			request.body,
		);
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
		const patch = resolvePayload(naming, selectedPresets, enableRename);

		if (Object.keys(patch).length === 0) {
			return reply.status(400).send({
				success: false,
				error: "No presets selected — nothing to apply",
			});
		}

		// GET current config (pre-deploy snapshot)
		let getResponse: Response;
		try {
			getResponse = await app.arrClientFactory.rawRequest(instance, "/api/v3/config/naming");
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

		const currentConfig = await parseAndValidateArrNamingConfig(
			getResponse,
			instance.label,
			request,
			reply,
			instanceId,
		);
		if (!currentConfig) return;

		// Merge patch onto current config
		const merged = { ...currentConfig, ...patch };

		// Compute hash and field counts before PUT
		const deployedHash = computeNamingHash(patch);
		const fieldCount = Object.keys(patch).filter(
			(k) => k !== "renameMovies" && k !== "renameEpisodes",
		).length;
		const totalFields = Object.keys(patch).length;

		// Create deploy history record as PENDING — updated to SUCCESS or FAILED after PUT
		const historyRecord = await app.prisma.namingDeployHistory.create({
			data: {
				instanceId,
				userId,
				status: "PENDING",
				selectedPresets: JSON.stringify(selectedPresets),
				resolvedPayload: JSON.stringify(patch),
				deployedHash,
				previousConfig: JSON.stringify(currentConfig),
				changedFields: fieldCount,
				totalFields,
			},
		});

		// PUT merged config back — retry once on network failure
		let putResponse: Response;
		try {
			putResponse = await app.arrClientFactory.rawRequest(instance, "/api/v3/config/naming", {
				method: "PUT",
				body: merged,
			});
		} catch (firstError) {
			// Only retry on network errors (fetch failures, connection resets)
			const isNetwork =
				firstError instanceof Error &&
				/fetch failed|econnrefused|econnreset|etimedout|enetunreach|abort/i.test(
					firstError.message,
				);
			if (!isNetwork) throw firstError;

			request.log.warn(
				{ err: firstError, instanceId },
				"First PUT attempt failed with network error, retrying in 1s",
			);
			try {
				await delay(1000);
				putResponse = await app.arrClientFactory.rawRequest(instance, "/api/v3/config/naming", {
					method: "PUT",
					body: merged,
				});
			} catch (retryError) {
				request.log.error(
					{ err: retryError, instanceId },
					"Retry PUT also failed — marking deploy as FAILED",
				);
				const errorMsg = getErrorMessage(retryError, "Network error");
				await app.prisma.namingDeployHistory.update({
					where: { id: historyRecord.id },
					data: { status: "FAILED", errorMessage: errorMsg },
				});
				await app.prisma.namingConfig.upsert({
					where: { instanceId },
					create: {
						instanceId,
						userId,
						serviceType,
						selectedPresets: JSON.stringify(selectedPresets),
						lastDeployStatus: "FAILED",
						lastDeployError: errorMsg,
					},
					update: { lastDeployStatus: "FAILED", lastDeployError: errorMsg },
				});
				return reply.status(502).send({
					success: false,
					error: `Failed to connect to ${instance.label}: ${errorMsg}`,
				});
			}
		}

		if (!putResponse.ok) {
			const errorText = await putResponse.text().catch(() => "Unknown error");
			request.log.error(
				{ instanceId, status: putResponse.status, errorText },
				"Failed to apply naming config to instance",
			);
			const errorMsg = `HTTP ${putResponse.status}: ${errorText}`;
			await app.prisma.namingDeployHistory.update({
				where: { id: historyRecord.id },
				data: { status: "FAILED", errorMessage: errorMsg },
			});
			await app.prisma.namingConfig.upsert({
				where: { instanceId },
				create: {
					instanceId,
					userId,
					serviceType,
					selectedPresets: JSON.stringify(selectedPresets),
					lastDeployStatus: "FAILED",
					lastDeployError: errorMsg,
				},
				update: { lastDeployStatus: "FAILED", lastDeployError: errorMsg },
			});
			return reply.status(502).send({
				success: false,
				error: `Failed to apply naming config to ${instance.label}: HTTP ${putResponse.status}`,
			});
		}

		// Mark deploy as SUCCESS now that the PUT confirmed
		let historySaved = true;
		try {
			await app.prisma.namingDeployHistory.update({
				where: { id: historyRecord.id },
				data: { status: "SUCCESS" },
			});
		} catch (historyError) {
			historySaved = false;
			request.log.error(
				{ err: historyError, historyId: historyRecord.id },
				"Failed to mark deploy history as SUCCESS — record stuck at PENDING",
			);
		}

		// Upsert NamingConfig record with success status
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
					lastDeployStatus: "SUCCESS",
					lastDeployError: null,
				},
				update: {
					selectedPresets: JSON.stringify(selectedPresets),
					lastDeployedAt: new Date(),
					lastDeployedHash: deployedHash,
					lastDeployStatus: "SUCCESS",
					lastDeployError: null,
				},
			});
		} catch (configError) {
			// P2002 = unique constraint race (concurrent upserts) — safe to swallow.
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

		const bookkeepingOk = historySaved && configSaved;

		app.log.info(
			{
				instanceId,
				serviceType,
				fieldCount,
				configSaved,
				historySaved,
				historyId: historyRecord.id,
			},
			"Applied naming presets to instance",
		);

		return reply.send({
			success: true,
			fieldCount,
			historyId: historyRecord.id,
			message: bookkeepingOk
				? `Applied ${fieldCount} naming format(s) to ${instance.label}`
				: `Applied ${fieldCount} naming format(s) to ${instance.label}, but some tracking records could not be saved.`,
			...(!bookkeepingOk ? { warning: "BOOKKEEPING_INCOMPLETE" } : {}),
		});
	});

	/**
	 * POST /api/trash-guides/naming/rollback
	 * Restore the previous naming config from a deploy history snapshot.
	 */
	app.post<{ Body: z.infer<typeof rollbackBodySchema> }>("/rollback", async (request, reply) => {
		const { historyId } = validateRequest(rollbackBodySchema, request.body);
		const userId = request.currentUser!.id;

		// Load history record with ownership check
		const history = await app.prisma.namingDeployHistory.findFirst({
			where: { id: historyId, userId },
		});

		if (!history) {
			return reply.status(404).send({
				success: false,
				error: "Deploy history record not found",
			});
		}

		if (!history.previousConfig) {
			return reply.status(400).send({
				success: false,
				error: "No previous config snapshot available for this deploy — rollback is not possible",
			});
		}

		if (history.rolledBack) {
			return reply.status(400).send({
				success: false,
				error: "This deploy has already been rolled back",
			});
		}

		// Load the instance
		const instance = await requireInstance(app, userId, history.instanceId);

		// Parse the previous config snapshot
		let previousConfig: Record<string, unknown>;
		try {
			previousConfig = JSON.parse(history.previousConfig) as Record<string, unknown>;
		} catch (parseErr) {
			request.log.error(
				{ err: parseErr, historyId },
				"Failed to parse stored naming config snapshot for rollback",
			);
			return reply.status(500).send({
				success: false,
				error: "Stored previous config snapshot is corrupt",
			});
		}

		// PUT the previous config back to the instance
		let putResponse: Response;
		try {
			putResponse = await app.arrClientFactory.rawRequest(instance, "/api/v3/config/naming", {
				method: "PUT",
				body: previousConfig,
			});
		} catch (error) {
			request.log.error(
				{ err: error, historyId, instanceId: instance.id },
				"Network error during rollback PUT",
			);
			return reply.status(502).send({
				success: false,
				error: `Failed to connect to ${instance.label}: ${getErrorMessage(error, "Network error")}`,
			});
		}

		if (!putResponse.ok) {
			const errorText = await putResponse.text().catch(() => "Unknown error");
			request.log.error(
				{ historyId, instanceId: instance.id, status: putResponse.status, errorText },
				"Rollback PUT failed",
			);
			return reply.status(502).send({
				success: false,
				error: `Failed to restore naming config on ${instance.label}: HTTP ${putResponse.status}`,
			});
		}

		// Record rollback in database — all three writes are bookkeeping;
		// the actual rollback (PUT) already succeeded above.
		let bookkeepingOk = true;
		try {
			await app.prisma.$transaction([
				app.prisma.namingDeployHistory.update({
					where: { id: historyId },
					data: { rolledBack: true, rolledBackAt: new Date() },
				}),
				app.prisma.namingDeployHistory.create({
					data: {
						instanceId: history.instanceId,
						userId,
						status: "ROLLED_BACK",
						selectedPresets: history.selectedPresets,
						resolvedPayload: JSON.stringify(previousConfig),
						changedFields: history.changedFields,
						totalFields: history.totalFields,
					},
				}),
				app.prisma.namingConfig.updateMany({
					where: { instanceId: history.instanceId },
					data: { lastDeployStatus: "ROLLED_BACK" },
				}),
			]);
		} catch (dbError) {
			bookkeepingOk = false;
			request.log.error(
				{ err: dbError, historyId },
				"Rollback PUT succeeded but database bookkeeping failed",
			);
		}

		app.log.info(
			{ historyId, instanceId: history.instanceId, bookkeepingOk },
			"Rolled back naming config to previous snapshot",
		);

		return reply.send({
			success: true,
			message: bookkeepingOk
				? `Rolled back naming config on ${instance.label} to previous state`
				: `Rolled back naming config on ${instance.label}, but history tracking could not be saved.`,
			fieldCount: history.changedFields,
			...(!bookkeepingOk ? { warning: "BOOKKEEPING_INCOMPLETE" } : {}),
		});
	});

	/**
	 * GET /api/trash-guides/naming/history?instanceId=xxx&limit=20&offset=0
	 * Fetch paginated deploy history for an instance.
	 */
	app.get<{ Querystring: z.infer<typeof historyQuerySchema> }>(
		"/history",
		async (request, reply) => {
			const { instanceId, limit, offset } = validateRequest(historyQuerySchema, request.query);
			const userId = request.currentUser!.id;

			await requireInstance(app, userId, instanceId);

			const [history, total] = await Promise.all([
				app.prisma.namingDeployHistory.findMany({
					where: { instanceId, userId },
					orderBy: { deployedAt: "desc" },
					take: limit,
					skip: offset,
				}),
				app.prisma.namingDeployHistory.count({
					where: { instanceId, userId },
				}),
			]);

			return reply.send({
				success: true,
				data: {
					history: history.map((h) => ({
						id: h.id,
						instanceId: h.instanceId,
						deployedAt: h.deployedAt.toISOString(),
						status: h.status as NamingDeployStatus,
						selectedPresets: parseStoredPresets(h.selectedPresets, request.log),
						changedFields: h.changedFields,
						totalFields: h.totalFields,
						errorMessage: h.errorMessage,
						rolledBack: h.rolledBack,
						rolledBackAt: h.rolledBackAt?.toISOString() ?? null,
					})),
					pagination: {
						total,
						limit,
						offset,
						hasMore: offset + limit < total,
					},
				},
			});
		},
	);

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
				request.log.warn({ instanceId }, "Stored naming config has corrupt selectedPresets JSON");
				return reply.send({
					success: true,
					config: null,
					warning: "CORRUPT_CONFIG",
				});
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
					lastDeployStatus: config.lastDeployStatus as NamingDeployStatus | null,
					lastDeployError: config.lastDeployError,
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
		const { instanceId, selectedPresets, syncStrategy } = validateRequest(
			configBodySchema,
			request.body,
		);
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
				lastDeployStatus: config.lastDeployStatus as NamingDeployStatus | null,
				lastDeployError: config.lastDeployError,
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
				lastDeployStatus: config.lastDeployStatus as NamingDeployStatus | null,
				lastDeployError: config.lastDeployError,
				createdAt: config.createdAt.toISOString(),
				updatedAt: config.updatedAt.toISOString(),
			},
		});
	});

	/**
	 * DELETE /api/trash-guides/naming/configs/:instanceId
	 * Delete a NamingConfig.
	 */
	app.delete<{ Params: { instanceId: string } }>("/configs/:instanceId", async (request, reply) => {
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
	});
}
