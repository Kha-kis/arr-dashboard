/**
 * Quality Size Routes
 *
 * Endpoints for managing TRaSH Guides quality size presets (file size limits)
 * applied to Sonarr/Radarr instances.
 */

import { createHash } from "node:crypto";
import { TRASH_CONFIG_TYPES, type TrashQualitySize } from "@arr/shared";
import type { SonarrClient, RadarrClient } from "arr-sdk";
import type { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { requireInstance } from "../../lib/arr/instance-helpers.js";
import { createCacheManager } from "../../lib/trash-guides/cache-manager.js";
import { createTrashFetcher } from "../../lib/trash-guides/github-fetcher.js";
import {
	buildQualitySizeComparison,
	applyQualitySizeToDefinitions,
} from "../../lib/trash-guides/quality-size-matcher.js";
import { getRepoConfig } from "../../lib/trash-guides/repo-config.js";
import { getErrorMessage } from "../../lib/utils/error-message.js";
import { validateRequest } from "../../lib/utils/validate.js";

// ============================================================================
// Request Schemas
// ============================================================================

const presetsQuerySchema = z.object({
	serviceType: z.enum(["RADARR", "SONARR"]),
});

const previewBodySchema = z.object({
	instanceId: z.string().min(1),
	presetTrashId: z.string().min(1),
});

const applyBodySchema = z.object({
	instanceId: z.string().min(1),
	presetTrashId: z.string().min(1),
	syncStrategy: z.enum(["auto", "manual", "notify"]).default("manual"),
});

const mappingQuerySchema = z.object({
	instanceId: z.string().min(1),
});

const syncStrategyBodySchema = z.object({
	instanceId: z.string().min(1),
	syncStrategy: z.enum(["auto", "manual", "notify"]),
});

// ============================================================================
// Helpers
// ============================================================================

function computeQualitiesHash(qualities: TrashQualitySize["qualities"]): string {
	return createHash("sha256").update(JSON.stringify(qualities)).digest("hex");
}

/** The special preset ID for "restore factory defaults" */
const DEFAULT_PRESET_ID = "default";

// ============================================================================
// Route Handlers
// ============================================================================

export async function qualitySizeRoutes(app: FastifyInstance, _opts: FastifyPluginOptions) {
	const cacheManager = createCacheManager(app.prisma);

	async function getFetcher(userId: string) {
		const repoConfig = await getRepoConfig(app.prisma, userId);
		return createTrashFetcher({ repoConfig, logger: app.log });
	}

	/**
	 * Call PUT /api/v3/qualitydefinition/reset on the instance to restore factory defaults.
	 * The arr-sdk doesn't wrap this endpoint, so we use the factory's raw request method.
	 */
	async function resetQualityDefinitions(
		instance: Parameters<typeof app.arrClientFactory.rawRequest>[0],
	): Promise<void> {
		const response = await app.arrClientFactory.rawRequest(
			instance,
			"/api/v3/qualitydefinition/reset",
			{ method: "PUT" },
		);
		if (!response.ok) {
			const body = await response.text().catch((bodyErr) => {
				app.log.debug(
					{ err: bodyErr, status: response.status },
					"Failed to read error response body from quality definition reset",
				);
				return "";
			});
			throw new Error(
				`Failed to reset quality definitions: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
			);
		}
	}

	/**
	 * Fetch quality size presets from cache, auto-refreshing if stale.
	 */
	async function getPresets(userId: string, serviceType: "RADARR" | "SONARR"): Promise<TrashQualitySize[]> {
		const configType = TRASH_CONFIG_TYPES.QUALITY_SIZE;
		const isFresh = await cacheManager.isFresh(serviceType, configType);

		if (!isFresh) {
			app.log.info({ serviceType }, "Quality size cache stale, fetching from GitHub");
			const fetcher = await getFetcher(userId);
			const data = await fetcher.fetchConfigs(serviceType, configType);
			await cacheManager.set(serviceType, configType, data);
			return data as TrashQualitySize[];
		}

		const data = await cacheManager.get<TrashQualitySize[]>(serviceType, configType);
		return data ?? [];
	}

	/**
	 * GET /api/trash-guides/quality-size/presets?serviceType=RADARR|SONARR
	 * Returns available quality size presets from the TRaSH cache.
	 */
	app.get<{ Querystring: z.infer<typeof presetsQuerySchema> }>(
		"/presets",
		async (request, reply) => {
			const { serviceType } = validateRequest(presetsQuerySchema, request.query);
			const presets = await getPresets(request.currentUser!.id, serviceType);

			return reply.send({
				success: true,
				presets,
			});
		},
	);

	/**
	 * GET /api/trash-guides/quality-size/mapping?instanceId=xxx
	 * Returns the current quality size mapping for an instance (if any).
	 */
	app.get<{ Querystring: z.infer<typeof mappingQuerySchema> }>(
		"/mapping",
		async (request, reply) => {
			const { instanceId } = validateRequest(mappingQuerySchema, request.query);

			// Verify ownership
			await requireInstance(app, request.currentUser!.id, instanceId);

			const mapping = await app.prisma.qualitySizeMapping.findUnique({
				where: { instanceId },
			});

			return reply.send({
				success: true,
				mapping: mapping
					? {
							presetTrashId: mapping.presetTrashId,
							presetType: mapping.presetType,
							syncStrategy: mapping.syncStrategy as "auto" | "manual" | "notify",
							lastAppliedAt: mapping.lastAppliedAt.toISOString(),
						}
					: null,
			});
		},
	);

	/**
	 * POST /api/trash-guides/quality-size/preview
	 * Preview the diff between a TRaSH preset and the instance's current quality definitions.
	 */
	app.post<{ Body: z.infer<typeof previewBodySchema> }>(
		"/preview",
		async (request, reply) => {
			const { instanceId, presetTrashId } = validateRequest(previewBodySchema, request.body);
			const userId = request.currentUser!.id;

			// Verify ownership + get instance
			const instance = await requireInstance(app, userId, instanceId);

			if (instance.service !== "SONARR" && instance.service !== "RADARR") {
				return reply.status(400).send({
					success: false,
					error: `Quality size presets are not supported for ${instance.service} instances`,
				});
			}

			// Fetch presets from cache
			const serviceType = instance.service === "SONARR" ? "SONARR" : "RADARR";
			const presets = await getPresets(userId, serviceType);
			const preset = presets.find((p) => p.trash_id === presetTrashId);

			if (!preset) {
				return reply.status(404).send({
					success: false,
					error: `Preset "${presetTrashId}" not found for ${serviceType}`,
				});
			}

			// Get current quality definitions from instance
			const client = app.arrClientFactory.create(instance) as SonarrClient | RadarrClient;
			const instanceDefs = await client.qualityDefinition.getAll();

			// Build comparison
			const preview = buildQualitySizeComparison(preset.qualities, instanceDefs);

			// Fetch existing mapping if any
			const existingMapping = await app.prisma.qualitySizeMapping.findUnique({
				where: { instanceId },
			});

			return reply.send({
				success: true,
				preset: { trashId: preset.trash_id, type: preset.type },
				comparisons: preview.comparisons,
				summary: {
					matched: preview.matchedCount,
					changed: preview.changedCount,
					unmatched: preview.unmatchedCount,
					total: preset.qualities.length,
				},
				existingMapping: existingMapping
					? {
							presetTrashId: existingMapping.presetTrashId,
							presetType: existingMapping.presetType,
							syncStrategy: existingMapping.syncStrategy,
							lastAppliedAt: existingMapping.lastAppliedAt.toISOString(),
						}
					: null,
			});
		},
	);

	/**
	 * POST /api/trash-guides/quality-size/apply
	 * Apply a TRaSH quality size preset to an instance.
	 * Always resets to factory defaults first, then applies the preset on top.
	 * If presetTrashId is "default", only resets (no preset applied).
	 */
	app.post<{ Body: z.infer<typeof applyBodySchema> }>(
		"/apply",
		async (request, reply) => {
			const { instanceId, presetTrashId, syncStrategy } = validateRequest(applyBodySchema, request.body);
			const userId = request.currentUser!.id;

			const instance = await requireInstance(app, userId, instanceId);

			if (instance.service !== "SONARR" && instance.service !== "RADARR") {
				return reply.status(400).send({
					success: false,
					error: `Quality size presets are not supported for ${instance.service} instances`,
				});
			}

			// Handle "default" — just reset, remove mapping, done
			if (presetTrashId === DEFAULT_PRESET_ID) {
				await resetQualityDefinitions(instance);
				await app.prisma.qualitySizeMapping.deleteMany({
					where: { instanceId },
				});

				app.log.info(
					{ instanceId },
					"Reset quality size definitions to factory defaults",
				);

				return reply.send({
					success: true,
					appliedCount: 0,
					totalQualities: 0,
					message: `Reset quality sizes to factory defaults on ${instance.label}`,
				});
			}

			// Validate preset exists BEFORE the destructive reset
			const serviceType = instance.service === "SONARR" ? "SONARR" : "RADARR";
			const presets = await getPresets(userId, serviceType);
			const preset = presets.find((p) => p.trash_id === presetTrashId);

			if (!preset) {
				return reply.status(404).send({
					success: false,
					error: `Preset "${presetTrashId}" not found for ${serviceType}`,
				});
			}

			// Reset to factory defaults, then apply TRaSH preset on top
			await resetQualityDefinitions(instance);

			let appliedCount: number;
			try {
				const client = app.arrClientFactory.create(instance) as SonarrClient | RadarrClient;
				const instanceDefs = await client.qualityDefinition.getAll();
				const result = applyQualitySizeToDefinitions(preset.qualities, instanceDefs);
				appliedCount = result.appliedCount;

				// biome-ignore lint/suspicious/noExplicitAny: arr-sdk types are loosely typed from OpenAPI specs
				await client.qualityDefinition.updateAll(result.updated as any[]);
			} catch (error) {
				// Reset succeeded but apply failed — instance is at factory defaults.
				// Clear any stale mapping so the UI doesn't show an incorrect "Applied" state.
				await app.prisma.qualitySizeMapping.deleteMany({ where: { instanceId } }).catch((cleanupErr) => {
					request.log.warn(
						{ err: cleanupErr, instanceId },
						"Failed to clean up stale quality size mapping after apply failure",
					);
				});
				request.log.error(
					{ err: error, instanceId, presetTrashId },
					"Quality size apply failed after reset — instance is at factory defaults",
				);
				return reply.status(500).send({
					success: false,
					error: "APPLY_AFTER_RESET_FAILED",
					message: `Quality definitions were reset to factory defaults but applying the preset failed: ${getErrorMessage(error)}. The instance is currently running factory defaults.`,
				});
			}

			// Upsert the mapping record — this is metadata, not the destructive operation.
			// If it fails, the instance was still modified successfully.
			const dataHash = computeQualitiesHash(preset.qualities);
			let mappingSaved = true;
			try {
				await app.prisma.qualitySizeMapping.upsert({
					where: { instanceId },
					create: {
						instanceId,
						userId,
						presetTrashId: preset.trash_id,
						presetType: preset.type,
						serviceType,
						syncStrategy,
						appliedDataHash: dataHash,
						lastAppliedAt: new Date(),
					},
					update: {
						presetTrashId: preset.trash_id,
						presetType: preset.type,
						syncStrategy,
						appliedDataHash: dataHash,
						lastAppliedAt: new Date(),
					},
				});
			} catch (mappingError) {
				mappingSaved = false;
				request.log.error(
					{ err: mappingError, instanceId, presetTrashId },
					"Quality size preset applied successfully but mapping record save failed — sync tracking will not work",
				);
			}

			app.log.info(
				{ instanceId, presetTrashId, appliedCount, serviceType, mappingSaved },
				"Applied quality size preset to instance (reset + apply)",
			);

			return reply.send({
				success: true,
				appliedCount,
				totalQualities: preset.qualities.length,
				message: mappingSaved
					? `Applied ${appliedCount} quality size definitions to ${instance.label}`
					: `Applied ${appliedCount} quality size definitions to ${instance.label}, but sync tracking could not be saved. Re-apply to fix.`,
				...(mappingSaved ? {} : { warning: "MAPPING_SAVE_FAILED" }),
			});
		},
	);

	/**
	 * PATCH /api/trash-guides/quality-size/sync-strategy
	 * Update the sync strategy for an existing quality size mapping.
	 */
	app.patch<{ Body: z.infer<typeof syncStrategyBodySchema> }>(
		"/sync-strategy",
		async (request, reply) => {
			const { instanceId, syncStrategy } = validateRequest(syncStrategyBodySchema, request.body);
			const userId = request.currentUser!.id;

			// Verify ownership
			await requireInstance(app, userId, instanceId);

			const mapping = await app.prisma.qualitySizeMapping.findUnique({
				where: { instanceId },
			});

			if (!mapping) {
				return reply.status(404).send({
					success: false,
					error: "No quality size mapping exists for this instance. Apply a preset first.",
				});
			}

			await app.prisma.qualitySizeMapping.update({
				where: { instanceId },
				data: { syncStrategy },
			});

			return reply.send({
				success: true,
				syncStrategy,
			});
		},
	);
}
