import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { SonarrClient, RadarrClient, LidarrClient, ReadarrClient } from "arr-sdk";
import { toServiceLabel } from "../lib/arr/client-helpers.js";
import { requireInstance } from "../lib/arr/instance-helpers.js";
import { getHuntingScheduler } from "../lib/hunting/scheduler.js";
import {
	MIN_MISSING_INTERVAL_MINS,
	MIN_UPGRADE_INTERVAL_MINS,
	MAX_INTERVAL_MINS,
	MIN_BATCH_SIZE,
	MAX_BATCH_SIZE,
	MIN_HOURLY_API_CAP,
	MAX_HOURLY_API_CAP,
	MAX_QUEUE_THRESHOLD,
	MAX_RESEARCH_AFTER_DAYS,
} from "../lib/hunting/constants.js";
import { cleanupOldSearchHistory } from "../lib/hunting/search-history.js";
import { InstanceNotFoundError } from "../lib/errors.js";
import { safeJsonParse } from "../lib/utils/json.js";
import { parsePaginationQuery } from "../lib/utils/pagination.js";
import { validateRequest } from "../lib/utils/validate.js";

const huntConfigUpdateSchema = z.object({
	// Feature toggles
	huntMissingEnabled: z.boolean().optional(),
	huntUpgradesEnabled: z.boolean().optional(),
	// Batch settings (using constants for validation)
	missingBatchSize: z.number().int().min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE).optional(),
	missingIntervalMins: z
		.number()
		.int()
		.min(MIN_MISSING_INTERVAL_MINS)
		.max(MAX_INTERVAL_MINS)
		.optional(),
	upgradeBatchSize: z.number().int().min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE).optional(),
	upgradeIntervalMins: z
		.number()
		.int()
		.min(MIN_UPGRADE_INTERVAL_MINS)
		.max(MAX_INTERVAL_MINS)
		.optional(),
	// Rate limiting
	hourlyApiCap: z.number().int().min(MIN_HOURLY_API_CAP).max(MAX_HOURLY_API_CAP).optional(),
	queueThreshold: z.number().int().min(0).max(MAX_QUEUE_THRESHOLD).optional(),
	// Filter settings
	filterLogic: z.enum(["AND", "OR"]).optional(),
	monitoredOnly: z.boolean().optional(),
	includeTags: z.string().nullable().optional(), // JSON array string
	excludeTags: z.string().nullable().optional(),
	includeQualityProfiles: z.string().nullable().optional(),
	excludeQualityProfiles: z.string().nullable().optional(),
	includeStatuses: z.string().nullable().optional(),
	yearMin: z.number().int().min(1900).max(2100).nullable().optional(),
	yearMax: z.number().int().min(1900).max(2100).nullable().optional(),
	ageThresholdDays: z.number().int().min(0).max(365).nullable().optional(),
	// Season pack preference (Sonarr only)
	preferSeasonPacks: z.boolean().optional(),
	// Re-search settings (0 = never re-search already searched items)
	researchAfterDays: z.number().int().min(0).max(MAX_RESEARCH_AFTER_DAYS).optional(),
});

const huntConfigCreateSchema = z.object({
	instanceId: z.string().min(1),
});

const huntingRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Initialize scheduler with app reference (enables manual hunts even when scheduler is stopped)
	getHuntingScheduler().initialize(app);

	// Get hunting status overview
	app.get("/hunting/status", async (request, reply) => {
		try {
			const userId = request.currentUser!.id;

			// Get all instances with their hunt configs
			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					userId,
					service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
				},
				include: {
					huntConfig: true,
				},
			});

			// Get today's log counts per instance
			const today = new Date();
			today.setHours(0, 0, 0, 0);

			const logsToday = await app.prisma.huntLog.groupBy({
				by: ["instanceId"],
				where: {
					instance: { userId },
					startedAt: { gte: today },
				},
				_sum: {
					itemsSearched: true,
					itemsFound: true,
				},
			});

			const logsMap = new Map(logsToday.map((l) => [l.instanceId, l._sum]));

			// Get recent activity count (last 24h)
			const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
			const recentActivityCount = await app.prisma.huntLog.count({
				where: {
					instance: { userId },
					startedAt: { gte: yesterday },
				},
			});

			const scheduler = getHuntingScheduler();

			const instanceStatuses = instances.map((inst) => {
				const config = inst.huntConfig;
				const todayStats = logsMap.get(inst.id);

				return {
					instanceId: inst.id,
					instanceName: inst.label,
					service: toServiceLabel(inst.service),
					huntMissingEnabled: config?.huntMissingEnabled ?? false,
					huntUpgradesEnabled: config?.huntUpgradesEnabled ?? false,
					lastMissingHunt: config?.lastMissingHunt?.toISOString() ?? null,
					lastUpgradeHunt: config?.lastUpgradeHunt?.toISOString() ?? null,
					searchesToday: todayStats?.itemsSearched ?? 0,
					itemsFoundToday: todayStats?.itemsFound ?? 0,
					apiCallsThisHour: config?.apiCallsThisHour ?? 0,
					hourlyApiCap: config?.hourlyApiCap ?? 100,
				};
			});

			return reply.send({
				schedulerRunning: scheduler.isRunning(),
				instances: instanceStatuses,
				recentActivityCount,
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch hunting status");
			return reply.status(500).send({ error: "Failed to fetch hunting status" });
		}
	});

	// Get hunting configs for all instances
	app.get("/hunting/configs", async (request, reply) => {
		try {
			const userId = request.currentUser!.id;

			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					userId,
					service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
				},
				include: {
					huntConfig: true,
				},
				orderBy: { label: "asc" },
			});

			const configs = instances.map((inst) => {
				if (!inst.huntConfig) return null;

				return {
					...inst.huntConfig,
					instanceName: inst.label,
					service: toServiceLabel(inst.service),
					lastMissingHunt: inst.huntConfig.lastMissingHunt?.toISOString() ?? null,
					lastUpgradeHunt: inst.huntConfig.lastUpgradeHunt?.toISOString() ?? null,
					apiCallsResetAt: inst.huntConfig.apiCallsResetAt?.toISOString() ?? null,
					createdAt: inst.huntConfig.createdAt.toISOString(),
					updatedAt: inst.huntConfig.updatedAt.toISOString(),
				};
			});

			const instanceSummaries = instances.map((inst) => ({
				id: inst.id,
				label: inst.label,
				service: toServiceLabel(inst.service),
			}));

			return reply.send({
				configs,
				instances: instanceSummaries,
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch hunting configs");
			return reply.status(500).send({ error: "Failed to fetch hunting configs" });
		}
	});

	// Create hunt config for an instance
	app.post("/hunting/configs", async (request, reply) => {
		const { instanceId } = validateRequest(huntConfigCreateSchema, request.body);

		try {
			const userId = request.currentUser!.id;

			const instance = await requireInstance(app, userId, instanceId);

			// Check if config already exists
			const existing = await app.prisma.huntConfig.findUnique({
				where: { instanceId },
			});

			if (existing) {
				return reply.status(409).send({ error: "Hunt config already exists for this instance" });
			}

			const config = await app.prisma.huntConfig.create({
				data: { instanceId },
				include: { instance: true },
			});

			return reply.status(201).send({
				...config,
				instanceName: config.instance.label,
				service: toServiceLabel(config.instance.service),
				lastMissingHunt: config.lastMissingHunt?.toISOString() ?? null,
				lastUpgradeHunt: config.lastUpgradeHunt?.toISOString() ?? null,
				apiCallsResetAt: config.apiCallsResetAt?.toISOString() ?? null,
				createdAt: config.createdAt.toISOString(),
				updatedAt: config.updatedAt.toISOString(),
			});
		} catch (error) {
			if (error instanceof InstanceNotFoundError) throw error;
			request.log.error({ err: error }, "Failed to create hunt config");
			return reply.status(500).send({ error: "Failed to create hunt config" });
		}
	});

	// Update hunt config
	app.patch("/hunting/configs/:instanceId", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const data = validateRequest(huntConfigUpdateSchema, request.body);

		try {
			const userId = request.currentUser!.id;

			const instance = await requireInstance(app, userId, instanceId, { huntConfig: true });

			if (!instance.huntConfig) {
				return reply.status(404).send({ error: "Hunt config not found for this instance" });
			}

			const config = await app.prisma.huntConfig.update({
				where: { instanceId },
				data,
				include: { instance: true },
			});

			return reply.send({
				...config,
				instanceName: config.instance.label,
				service: toServiceLabel(config.instance.service),
				lastMissingHunt: config.lastMissingHunt?.toISOString() ?? null,
				lastUpgradeHunt: config.lastUpgradeHunt?.toISOString() ?? null,
				apiCallsResetAt: config.apiCallsResetAt?.toISOString() ?? null,
				createdAt: config.createdAt.toISOString(),
				updatedAt: config.updatedAt.toISOString(),
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to update hunt config");
			throw error;
		}
	});

	// Get hunt logs
	app.get("/hunting/logs", async (request, reply) => {
		try {
			const userId = request.currentUser!.id;
			const query = request.query as {
				type?: string;
				status?: string;
				instanceId?: string;
				page?: string;
				pageSize?: string;
			};

			const { pageSize, skip } = parsePaginationQuery(query);

			const where: Record<string, unknown> = {
				instance: { userId },
			};

			if (query.type && query.type !== "all") {
				where.huntType = query.type;
			}
			if (query.status && query.status !== "all") {
				where.status = query.status;
			}
			if (query.instanceId && query.instanceId !== "all") {
				where.instanceId = query.instanceId;
			}

			const [logs, totalCount] = await Promise.all([
				app.prisma.huntLog.findMany({
					where,
					include: { instance: true },
					orderBy: { startedAt: "desc" },
					skip,
					take: pageSize,
				}),
				app.prisma.huntLog.count({ where }),
			]);

			const formattedLogs = logs.map((log) => ({
				id: log.id,
				instanceId: log.instanceId,
				instanceName: log.instance.label,
				service: toServiceLabel(log.instance.service),
				huntType: log.huntType as "missing" | "upgrade",
				itemsSearched: log.itemsSearched,
				itemsGrabbed: log.itemsFound, // DB field is itemsFound, API returns as itemsGrabbed
				searchedItems: safeJsonParse<unknown[]>(log.searchedItems),
				grabbedItems: safeJsonParse<unknown[]>(log.foundItems), // DB field is foundItems
				status: log.status as "running" | "completed" | "partial" | "skipped" | "error",
				message: log.message,
				durationMs: log.durationMs,
				startedAt: log.startedAt.toISOString(),
				completedAt: log.completedAt?.toISOString() ?? null,
			}));

			return reply.send({
				logs: formattedLogs,
				totalCount,
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to fetch hunt logs");
			return reply.status(500).send({ error: "Failed to fetch hunt logs" });
		}
	});

	// Toggle scheduler (admin-only operation)
	// Security: Authentication enforced by plugin-level preHandler.
	// This is a global operation affecting all users' scheduled hunts.
	// Current architecture: Single-admin (authenticated user IS the admin).
	// Future multi-user: Add role check here (e.g., request.currentUser.role === 'admin').
	app.post("/hunting/scheduler/toggle", async (request, reply) => {
		try {
			// In single-admin architecture, any authenticated user can control the scheduler.
			// For multi-user support, add role-based check here:
			// if (request.currentUser.role !== 'admin') {
			//   return reply.status(403).send({ error: "Admin access required" });
			// }

			const scheduler = getHuntingScheduler();
			const wasRunning = scheduler.isRunning();

			if (wasRunning) {
				scheduler.stop();
			} else {
				scheduler.start(app);
			}

			return reply.send({
				running: !wasRunning,
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to toggle hunting scheduler");
			return reply.status(500).send({ error: "Failed to toggle hunting scheduler" });
		}
	});

	// Manual hunt trigger (with cooldown enforcement)
	app.post("/hunting/trigger/:instanceId", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const body = request.body as { type?: string };
		const userId = request.currentUser!.id;

		try {
			const instance = await requireInstance(app, userId, instanceId, { huntConfig: true });

			if (!instance.huntConfig) {
				return reply.status(404).send({ error: "Hunt config not found for this instance" });
			}

			const huntType = body.type === "upgrade" ? "upgrade" : "missing";

			// Queue hunt job with cooldown check
			const scheduler = getHuntingScheduler();
			const result = scheduler.queueManualHunt(instanceId, huntType);

			if (!result.queued) {
				// Return 429 Too Many Requests with cooldown message
				return reply.status(429).send({
					message: result.message,
					queued: false,
				});
			}

			return reply.send({
				message: `${huntType} hunt queued for ${instance.label}`,
				queued: true,
			});
		} catch (error) {
			if (error instanceof InstanceNotFoundError) throw error;
			request.log.error({ err: error }, "Failed to trigger manual hunt");
			return reply.status(500).send({ error: "Failed to trigger manual hunt" });
		}
	});

	// Get filter options (tags, quality profiles) from an instance
	app.get("/hunting/filter-options/:instanceId", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const userId = request.currentUser!.id;

		const instance = await requireInstance(app, userId, instanceId);
		const service = instance.service.toLowerCase();

		try {
			const client = app.arrClientFactory.create(instance) as
				SonarrClient | RadarrClient | LidarrClient | ReadarrClient;

			// Validate client type matches service
			if (service === "sonarr" && !(client instanceof SonarrClient)) {
				return reply.status(400).send({ error: "Invalid client type for Sonarr instance" });
			}
			if (service === "radarr" && !(client instanceof RadarrClient)) {
				return reply.status(400).send({ error: "Invalid client type for Radarr instance" });
			}
			if (service === "lidarr" && !(client instanceof LidarrClient)) {
				return reply.status(400).send({ error: "Invalid client type for Lidarr instance" });
			}
			if (service === "readarr" && !(client instanceof ReadarrClient)) {
				return reply.status(400).send({ error: "Invalid client type for Readarr instance" });
			}

			// Fetch tags and quality profiles in parallel
			const [tagsData, profilesData] = await Promise.all([
				client.tag.getAll(),
				client.qualityProfile.getAll(),
			]);

			const tags = (tagsData as Array<{ id?: number; label?: string | null }>)
				.filter(
					(tag): tag is { id: number; label: string } =>
						tag.id !== undefined &&
						tag.id > 0 &&
						tag.label !== undefined &&
						tag.label !== null &&
						tag.label.length > 0,
				)
				.map((tag) => ({ id: tag.id, label: tag.label }));

			const qualityProfiles = (profilesData as Array<{ id?: number; name?: string | null }>)
				.filter(
					(profile): profile is { id: number; name: string } =>
						profile.id !== undefined &&
						profile.id > 0 &&
						profile.name !== undefined &&
						profile.name !== null &&
						profile.name.length > 0,
				)
				.map((profile) => ({ id: profile.id, name: profile.name }));

			// Define available statuses based on service type
			const statusMap: Record<string, Array<{ value: string; label: string }>> = {
				sonarr: [
					{ value: "continuing", label: "Continuing" },
					{ value: "ended", label: "Ended" },
					{ value: "upcoming", label: "Upcoming" },
				],
				radarr: [
					{ value: "tba", label: "TBA" },
					{ value: "announced", label: "Announced" },
					{ value: "inCinemas", label: "In Cinemas" },
					{ value: "released", label: "Released" },
				],
				lidarr: [
					{ value: "continuing", label: "Continuing" },
					{ value: "ended", label: "Ended" },
				],
				readarr: [
					{ value: "continuing", label: "Continuing" },
					{ value: "ended", label: "Ended" },
				],
			};
			const statuses = statusMap[service] ?? [];

			return reply.send({
				service,
				tags,
				qualityProfiles,
				statuses,
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "Unknown error";
			return reply.status(500).send({
				error: "Failed to fetch filter options from instance",
				details: errorMessage,
			});
		}
	});

	// ==================== SEARCH HISTORY MANAGEMENT ====================

	// Get search history stats for an instance
	app.get<{
		Params: { instanceId: string };
	}>("/hunting/history/:instanceId", async (request, reply) => {
		try {
			const userId = request.currentUser!.id;
			const { instanceId } = request.params;

			const instance = await requireInstance(app, userId, instanceId, { huntConfig: true });

			if (!instance.huntConfig) {
				return reply.status(404).send({ error: "Hunt config not found for this instance" });
			}

			const configId = instance.huntConfig.id;

			// Get search history counts
			const [totalSearched, missingSearched, upgradeSearched, recentSearched] = await Promise.all([
				app.prisma.huntSearchHistory.count({
					where: { configId },
				}),
				app.prisma.huntSearchHistory.count({
					where: { configId, huntType: "missing" },
				}),
				app.prisma.huntSearchHistory.count({
					where: { configId, huntType: "upgrade" },
				}),
				// Items searched in the last researchAfterDays period (still "protected")
				app.prisma.huntSearchHistory.count({
					where: {
						configId,
						searchedAt: {
							gte: new Date(Date.now() - instance.huntConfig.researchAfterDays * 24 * 60 * 60 * 1000),
						},
					},
				}),
			]);

			// Get recent search samples
			const recentSearches = await app.prisma.huntSearchHistory.findMany({
				where: { configId },
				orderBy: { searchedAt: "desc" },
				take: 10,
				select: {
					mediaType: true,
					title: true,
					huntType: true,
					searchedAt: true,
					searchCount: true,
				},
			});

			return reply.send({
				instanceId,
				researchAfterDays: instance.huntConfig.researchAfterDays,
				stats: {
					totalSearched,
					missingSearched,
					upgradeSearched,
					recentlySearched: recentSearched,
					eligibleForResearch: totalSearched - recentSearched,
				},
				recentSearches,
			});
		} catch (error) {
			if (error instanceof InstanceNotFoundError) throw error;
			request.log.error({ err: error }, "Failed to fetch search history stats");
			return reply.status(500).send({ error: "Failed to fetch search history stats" });
		}
	});

	// Clear search history for an instance
	app.delete<{
		Params: { instanceId: string };
		Querystring: { huntType?: "missing" | "upgrade" };
	}>("/hunting/history/:instanceId", async (request, reply) => {
		try {
			const userId = request.currentUser!.id;
			const { instanceId } = request.params;
			const { huntType } = request.query;

			const instance = await requireInstance(app, userId, instanceId, { huntConfig: true });

			if (!instance.huntConfig) {
				return reply.status(404).send({ error: "Hunt config not found for this instance" });
			}

			const configId = instance.huntConfig.id;

			// Delete history (optionally filtered by hunt type)
			const result = await app.prisma.huntSearchHistory.deleteMany({
				where: {
					configId,
					...(huntType && { huntType }),
				},
			});

			return reply.send({
				message: `Cleared ${result.count} search history entries`,
				deleted: result.count,
				huntType: huntType ?? "all",
			});
		} catch (error) {
			if (error instanceof InstanceNotFoundError) throw error;
			request.log.error({ err: error }, "Failed to clear search history");
			return reply.status(500).send({ error: "Failed to clear search history" });
		}
	});

	// Cleanup old search history (scoped to current user's configs)
	app.post("/hunting/history/cleanup", async (request, reply) => {
		try {
			// Clean up entries older than 90 days for this user's configs only
			const deleted = await cleanupOldSearchHistory(app.prisma, request.currentUser!.id, 90);

			return reply.send({
				message: `Cleaned up ${deleted} old search history entries`,
				deleted,
			});
		} catch (error) {
			request.log.error({ err: error }, "Failed to cleanup search history");
			return reply.status(500).send({ error: "Failed to cleanup search history" });
		}
	});

	done();
};

export const registerHuntingRoutes = huntingRoute;
