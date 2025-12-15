import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { getHuntingScheduler } from "../lib/hunting/scheduler.js";
import { createInstanceFetcher } from "../lib/arr/arr-fetcher.js";
import {
	MIN_MISSING_INTERVAL_MINS,
	MIN_UPGRADE_INTERVAL_MINS,
	MAX_INTERVAL_MINS,
	MIN_BATCH_SIZE,
	MAX_BATCH_SIZE,
	MIN_HOURLY_API_CAP,
	MAX_HOURLY_API_CAP,
	MAX_QUEUE_THRESHOLD,
	MIN_RESEARCH_AFTER_DAYS,
	MAX_RESEARCH_AFTER_DAYS,
} from "../lib/hunting/constants.js";
import { cleanupOldSearchHistory } from "../lib/hunting/search-history.js";

const huntConfigUpdateSchema = z.object({
	// Feature toggles
	huntMissingEnabled: z.boolean().optional(),
	huntUpgradesEnabled: z.boolean().optional(),
	// Batch settings (using constants for validation)
	missingBatchSize: z.number().int().min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE).optional(),
	missingIntervalMins: z.number().int().min(MIN_MISSING_INTERVAL_MINS).max(MAX_INTERVAL_MINS).optional(),
	upgradeBatchSize: z.number().int().min(MIN_BATCH_SIZE).max(MAX_BATCH_SIZE).optional(),
	upgradeIntervalMins: z.number().int().min(MIN_UPGRADE_INTERVAL_MINS).max(MAX_INTERVAL_MINS).optional(),
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
	// Re-search settings (0 = never re-search already searched items)
	researchAfterDays: z.number().int().min(0).max(MAX_RESEARCH_AFTER_DAYS).optional(),
});

const huntConfigCreateSchema = z.object({
	instanceId: z.string().min(1),
});

const huntingRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Initialize scheduler with app reference (enables manual hunts even when scheduler is stopped)
	getHuntingScheduler().initialize(app);

	// Add authentication preHandler for all routes in this plugin
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({
				success: false,
				error: "Authentication required",
			});
		}
	});

	// Get hunting status overview
	app.get("/hunting/status", async (request, reply) => {
		const userId = request.currentUser!.id;

		// Get all instances with their hunt configs
		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId,
				service: { in: ["SONARR", "RADARR"] },
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
				service: inst.service.toLowerCase() as "sonarr" | "radarr",
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
	});

	// Get hunting configs for all instances
	app.get("/hunting/configs", async (request, reply) => {
		const userId = request.currentUser!.id;

		const instances = await app.prisma.serviceInstance.findMany({
			where: {
				userId,
				service: { in: ["SONARR", "RADARR"] },
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
				service: inst.service.toLowerCase() as "sonarr" | "radarr",
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
			service: inst.service.toLowerCase() as "sonarr" | "radarr",
		}));

		return reply.send({
			configs,
			instances: instanceSummaries,
		});
	});

	// Create hunt config for an instance
	app.post("/hunting/configs", async (request, reply) => {
		const parsed = huntConfigCreateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const userId = request.currentUser!.id;
		const { instanceId } = parsed.data;

		// Verify instance ownership
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Not found or access denied" });
		}

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
			service: config.instance.service.toLowerCase() as "sonarr" | "radarr",
			lastMissingHunt: config.lastMissingHunt?.toISOString() ?? null,
			lastUpgradeHunt: config.lastUpgradeHunt?.toISOString() ?? null,
			apiCallsResetAt: config.apiCallsResetAt?.toISOString() ?? null,
			createdAt: config.createdAt.toISOString(),
			updatedAt: config.updatedAt.toISOString(),
		});
	});

	// Update hunt config
	app.patch("/hunting/configs/:instanceId", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const parsed = huntConfigUpdateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const userId = request.currentUser!.id;

		// Verify instance ownership
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
			include: { huntConfig: true },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Not found or access denied" });
		}

		if (!instance.huntConfig) {
			return reply.status(404).send({ error: "Hunt config not found for this instance" });
		}

		const config = await app.prisma.huntConfig.update({
			where: { instanceId },
			data: parsed.data,
			include: { instance: true },
		});

		return reply.send({
			...config,
			instanceName: config.instance.label,
			service: config.instance.service.toLowerCase() as "sonarr" | "radarr",
			lastMissingHunt: config.lastMissingHunt?.toISOString() ?? null,
			lastUpgradeHunt: config.lastUpgradeHunt?.toISOString() ?? null,
			apiCallsResetAt: config.apiCallsResetAt?.toISOString() ?? null,
			createdAt: config.createdAt.toISOString(),
			updatedAt: config.updatedAt.toISOString(),
		});
	});

	// Get hunt logs
	app.get("/hunting/logs", async (request, reply) => {
		const userId = request.currentUser!.id;
		const query = request.query as {
			type?: string;
			status?: string;
			instanceId?: string;
			page?: string;
			pageSize?: string;
		};

		let page = Number.parseInt(query.page ?? "1", 10);
		let pageSize = Number.parseInt(query.pageSize ?? "20", 10);
		// Validate pagination inputs
		if (Number.isNaN(page) || page < 1) page = 1;
		if (Number.isNaN(pageSize) || pageSize < 1) pageSize = 20;
		pageSize = Math.min(pageSize, 100);
		const skip = (page - 1) * pageSize;

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
			service: log.instance.service.toLowerCase() as "sonarr" | "radarr",
			huntType: log.huntType as "missing" | "upgrade",
			itemsSearched: log.itemsSearched,
			itemsGrabbed: log.itemsFound, // DB field is itemsFound, API returns as itemsGrabbed
			searchedItems: log.searchedItems ? JSON.parse(log.searchedItems) : null,
			grabbedItems: log.foundItems ? JSON.parse(log.foundItems) : null, // DB field is foundItems
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
	});

	// Toggle scheduler
	app.post("/hunting/scheduler/toggle", async (request, reply) => {
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
	});

	// Manual hunt trigger (with cooldown enforcement)
	app.post("/hunting/trigger/:instanceId", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const body = request.body as { type?: string };
		const userId = request.currentUser!.id;

		// Verify instance ownership
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
			include: { huntConfig: true },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Not found or access denied" });
		}

		if (!instance.huntConfig) {
			return reply.status(400).send({ error: "Hunt config not found for this instance" });
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
	});

	// Get filter options (tags, quality profiles) from an instance
	app.get("/hunting/filter-options/:instanceId", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const userId = request.currentUser!.id;

		// Verify instance ownership
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Not found or access denied" });
		}

		const service = instance.service.toLowerCase();

		try {
			const fetcher = createInstanceFetcher(app, instance);

			interface ArrTag {
				id: number;
				label: string;
			}

			interface ArrQualityProfile {
				id: number;
				name: string;
			}

			// Fetch tags and quality profiles in parallel
			const [tagsRes, profilesRes] = await Promise.all([
				fetcher("/api/v3/tag"),
				fetcher("/api/v3/qualityprofile"),
			]);

			const tagsData = (await tagsRes.json()) as ArrTag[];
			const profilesData = (await profilesRes.json()) as ArrQualityProfile[];

			const tags = tagsData.map((tag) => ({
				id: tag.id,
				label: tag.label,
			}));

			const qualityProfiles = profilesData.map((profile) => ({
				id: profile.id,
				name: profile.name,
			}));

			// Define available statuses based on service type
			const statuses =
				service === "sonarr"
					? [
							{ value: "continuing", label: "Continuing" },
							{ value: "ended", label: "Ended" },
							{ value: "upcoming", label: "Upcoming" },
						]
					: [
							{ value: "tba", label: "TBA" },
							{ value: "announced", label: "Announced" },
							{ value: "inCinemas", label: "In Cinemas" },
							{ value: "released", label: "Released" },
						];

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
		const userId = request.currentUser!.id;
		const { instanceId } = request.params;

		// Verify instance belongs to user
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
			include: { huntConfig: true },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Not found or access denied" });
		}

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
	});

	// Clear search history for an instance
	app.delete<{
		Params: { instanceId: string };
		Querystring: { huntType?: "missing" | "upgrade" };
	}>("/hunting/history/:instanceId", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId } = request.params;
		const { huntType } = request.query;

		// Verify instance belongs to user
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
			include: { huntConfig: true },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Not found or access denied" });
		}

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
	});

	// Cleanup old search history (scoped to current user's configs)
	app.post("/hunting/history/cleanup", async (request, reply) => {
		// Clean up entries older than 90 days for this user's configs only
		const deleted = await cleanupOldSearchHistory(app.prisma, request.currentUser!.id, 90);

		return reply.send({
			message: `Cleaned up ${deleted} old search history entries`,
			deleted,
		});
	});

	done();
};

export const registerHuntingRoutes = huntingRoute;
