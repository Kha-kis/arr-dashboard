import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { getQueueCleanerScheduler, SchedulerNotInitializedError } from "../lib/queue-cleaner/scheduler.js";
import { loggers } from "../lib/logger.js";
import {
	MIN_INTERVAL_MINS,
	MAX_INTERVAL_MINS,
	MIN_STALLED_THRESHOLD_MINS,
	MAX_STALLED_THRESHOLD_MINS,
	MIN_SLOW_SPEED_THRESHOLD,
	MAX_SLOW_SPEED_THRESHOLD,
	MIN_SLOW_GRACE_PERIOD_MINS,
	MAX_SLOW_GRACE_PERIOD_MINS,
	MIN_MAX_REMOVALS,
	MAX_MAX_REMOVALS,
	MIN_QUEUE_AGE_MINS,
	MAX_QUEUE_AGE_MINS,
	MIN_MAX_STRIKES,
	MAX_MAX_STRIKES,
	MIN_STRIKE_DECAY_HOURS,
	MAX_STRIKE_DECAY_HOURS,
	MIN_SEEDING_TIMEOUT_HOURS,
	MAX_SEEDING_TIMEOUT_HOURS,
	MIN_ESTIMATED_MULTIPLIER,
	MAX_ESTIMATED_MULTIPLIER,
	MIN_IMPORT_PENDING_MINS,
	MAX_IMPORT_PENDING_MINS,
	MIN_AUTO_IMPORT_ATTEMPTS,
	MAX_AUTO_IMPORT_ATTEMPTS,
	MIN_AUTO_IMPORT_COOLDOWN_MINS,
	MAX_AUTO_IMPORT_COOLDOWN_MINS,
} from "../lib/queue-cleaner/constants.js";

const log = loggers.queueCleaner;

// Rate limiting for resource-intensive operations
const PREVIEW_RATE_LIMIT = { max: 10, timeWindow: "1 minute" };
const MANUAL_CLEAN_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
// Statistics is expensive (aggregates all logs), stricter limit
const STATISTICS_RATE_LIMIT = { max: 20, timeWindow: "1 minute" };
// Read endpoints for logs and strikes - more lenient but still protected
const READ_RATE_LIMIT = { max: 60, timeWindow: "1 minute" };
// Write operations (config updates, clearing strikes) - moderate limit
const WRITE_RATE_LIMIT = { max: 30, timeWindow: "1 minute" };

// Pattern validation constants
const MAX_PATTERN_JSON_LENGTH = 10000;
const MAX_PATTERN_COUNT = 50;
const MAX_PATTERN_ITEM_LENGTH = 200;

/**
 * Validate JSON pattern string for safe limits.
 * Returns error message on failure, undefined on success.
 */
function validatePatternJson(json: string | null | undefined): string | undefined {
	if (!json) return undefined;
	if (json.length > MAX_PATTERN_JSON_LENGTH) {
		return `Pattern JSON exceeds ${MAX_PATTERN_JSON_LENGTH} characters`;
	}
	try {
		const arr = JSON.parse(json);
		if (!Array.isArray(arr)) {
			return "Patterns must be a JSON array";
		}
		if (arr.length > MAX_PATTERN_COUNT) {
			return `Too many patterns (max ${MAX_PATTERN_COUNT})`;
		}
		for (const item of arr) {
			if (typeof item === "string" && item.length > MAX_PATTERN_ITEM_LENGTH) {
				return `Pattern exceeds ${MAX_PATTERN_ITEM_LENGTH} characters`;
			}
			// For whitelist patterns (objects with type/pattern)
			if (typeof item === "object" && item !== null) {
				if (typeof item.pattern === "string" && item.pattern.length > MAX_PATTERN_ITEM_LENGTH) {
					return `Pattern exceeds ${MAX_PATTERN_ITEM_LENGTH} characters`;
				}
			}
		}
		return undefined;
	} catch {
		return "Invalid JSON format";
	}
}

/** Zod schema for pattern validation with specific error messages */
const patternJsonSchema = z.string().nullable().optional().superRefine((val, ctx) => {
	const error = validatePatternJson(val);
	if (error) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			message: error,
		});
	}
});

/**
 * Result of parseJsonSafe - includes data and optional parse error.
 */
interface ParseResult {
	data: unknown[] | null;
	parseError?: string;
}

/**
 * Parse a JSON string, returning data and any parse error for user visibility.
 */
function parseJsonSafe(
	json: string | null,
	context: { recordId: string; field: string },
): ParseResult {
	if (!json) return { data: null };
	try {
		return { data: JSON.parse(json) as unknown[] };
	} catch (error) {
		const message = error instanceof Error ? error.message : "Unknown parse error";
		log.warn({ recordId: context.recordId, field: context.field, err: error }, "Failed to parse JSON field in log record");
		return { data: null, parseError: message };
	}
}

const configUpdateSchema = z.object({
	// Master toggle
	enabled: z.boolean().optional(),

	// Check frequency
	intervalMins: z.number().int().min(MIN_INTERVAL_MINS).max(MAX_INTERVAL_MINS).optional(),

	// Stalled rule
	stalledEnabled: z.boolean().optional(),
	stalledThresholdMins: z
		.number()
		.int()
		.min(MIN_STALLED_THRESHOLD_MINS)
		.max(MAX_STALLED_THRESHOLD_MINS)
		.optional(),

	// Failed rule
	failedEnabled: z.boolean().optional(),

	// Slow rule
	slowEnabled: z.boolean().optional(),
	slowSpeedThreshold: z
		.number()
		.int()
		.min(MIN_SLOW_SPEED_THRESHOLD)
		.max(MAX_SLOW_SPEED_THRESHOLD)
		.optional(),
	slowGracePeriodMins: z
		.number()
		.int()
		.min(MIN_SLOW_GRACE_PERIOD_MINS)
		.max(MAX_SLOW_GRACE_PERIOD_MINS)
		.optional(),

	// Error patterns rule
	errorPatternsEnabled: z.boolean().optional(),
	errorPatterns: patternJsonSchema,

	// Removal options
	removeFromClient: z.boolean().optional(),
	addToBlocklist: z.boolean().optional(),
	searchAfterRemoval: z.boolean().optional(),

	// Safety settings
	dryRunMode: z.boolean().optional(),
	maxRemovalsPerRun: z.number().int().min(MIN_MAX_REMOVALS).max(MAX_MAX_REMOVALS).optional(),
	minQueueAgeMins: z.number().int().min(MIN_QUEUE_AGE_MINS).max(MAX_QUEUE_AGE_MINS).optional(),

	// Strike system
	strikeSystemEnabled: z.boolean().optional(),
	maxStrikes: z.number().int().min(MIN_MAX_STRIKES).max(MAX_MAX_STRIKES).optional(),
	strikeDecayHours: z.number().int().min(MIN_STRIKE_DECAY_HOURS).max(MAX_STRIKE_DECAY_HOURS).optional(),

	// Seeding timeout
	seedingTimeoutEnabled: z.boolean().optional(),
	seedingTimeoutHours: z.number().int().min(MIN_SEEDING_TIMEOUT_HOURS).max(MAX_SEEDING_TIMEOUT_HOURS).optional(),

	// Estimated completion
	estimatedCompletionEnabled: z.boolean().optional(),
	estimatedCompletionMultiplier: z.number().min(MIN_ESTIMATED_MULTIPLIER).max(MAX_ESTIMATED_MULTIPLIER).optional(),

	// Import pending/blocked rule
	importPendingEnabled: z.boolean().optional(),
	importPendingThresholdMins: z.number().int().min(MIN_IMPORT_PENDING_MINS).max(MAX_IMPORT_PENDING_MINS).optional(),

	// Import block cleanup level
	importBlockCleanupLevel: z.enum(["safe", "moderate", "aggressive"]).optional(),

	// Import block pattern mode
	importBlockPatternMode: z.enum(["defaults", "include", "exclude"]).optional(),

	// Custom import block patterns (JSON array of strings)
	importBlockPatterns: patternJsonSchema,

	// Auto-import settings (try importing before removing)
	autoImportEnabled: z.boolean().optional(),
	autoImportMaxAttempts: z.number().int().min(MIN_AUTO_IMPORT_ATTEMPTS).max(MAX_AUTO_IMPORT_ATTEMPTS).optional(),
	autoImportCooldownMins: z.number().int().min(MIN_AUTO_IMPORT_COOLDOWN_MINS).max(MAX_AUTO_IMPORT_COOLDOWN_MINS).optional(),
	autoImportSafeOnly: z.boolean().optional(),
	autoImportCustomPatterns: patternJsonSchema,
	autoImportNeverPatterns: patternJsonSchema,

	// Whitelist
	whitelistEnabled: z.boolean().optional(),
	whitelistPatterns: patternJsonSchema,

	// Change category (torrent-only option)
	// Instead of deleting, move torrent to a different category in the client
	// The actual category name is configured in Sonarr/Radarr's download client settings
	changeCategoryEnabled: z.boolean().optional(),
});

const configCreateSchema = z.object({
	instanceId: z.string().min(1),
});

const queueCleanerRoute: FastifyPluginCallback = (app, _opts, done) => {
	// Note: Scheduler is initialized by queue-cleaner-scheduler plugin
	// We access it via getQueueCleanerScheduler() singleton

	// Authentication preHandler for all routes
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser!.id) {
			return reply.status(401).send({ error: "Authentication required" });
		}

		// Check if queue cleaner feature is available
		if (!app.queueCleanerEnabled) {
			return reply.status(503).send({
				error: "Queue cleaner feature is unavailable due to initialization error",
				details: app.queueCleanerInitError ?? "Check server logs for details",
			});
		}
	});

	// Get queue cleaner status overview
	app.get("/queue-cleaner/status", async (request, reply) => {
		try {
			const userId = request.currentUser!.id;

			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					userId,
					service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
				},
				include: {
					queueCleanerConfig: true,
				},
			});

			// Get today's stats
			const today = new Date();
			today.setHours(0, 0, 0, 0);

			const logsToday = await app.prisma.queueCleanerLog.groupBy({
				by: ["instanceId"],
				where: {
					instance: { userId },
					startedAt: { gte: today },
				},
				_sum: {
					itemsCleaned: true,
					itemsSkipped: true,
				},
			});

			const logsMap = new Map(logsToday.map((l) => [l.instanceId, l._sum]));

			const scheduler = getQueueCleanerScheduler();
			const health = scheduler.getHealth();

			const instanceStatuses = instances.map((inst) => {
				const config = inst.queueCleanerConfig;
				const todayStats = logsMap.get(inst.id);

				return {
					instanceId: inst.id,
					instanceName: inst.label,
					service: inst.service.toLowerCase() as "sonarr" | "radarr",
					enabled: config?.enabled ?? false,
					dryRunMode: config?.dryRunMode ?? true,
					lastRunAt: config?.lastRunAt?.toISOString() ?? null,
					lastRunItemsCleaned: config?.lastRunItemsCleaned ?? 0,
					lastRunItemsSkipped: config?.lastRunItemsSkipped ?? 0,
					cleanedToday: todayStats?.itemsCleaned ?? 0,
					skippedToday: todayStats?.itemsSkipped ?? 0,
					hasConfig: !!config,
				};
			});

			return reply.send({
				schedulerRunning: health.running,
				schedulerHealthy: health.healthy,
				schedulerLastError: health.lastError,
				schedulerWarnings: health.warnings,
				instances: instanceStatuses,
			});
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to fetch queue cleaner status");
			return reply.status(500).send({ error: "Failed to fetch queue cleaner status" });
		}
	});

	// Get all configs
	app.get("/queue-cleaner/configs", async (request, reply) => {
		try {
			const userId = request.currentUser!.id;

			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					userId,
					service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
				},
				include: {
					queueCleanerConfig: true,
				},
				orderBy: { label: "asc" },
			});

			const configs = instances.map((inst) => {
				if (!inst.queueCleanerConfig) return null;

				return {
					...inst.queueCleanerConfig,
					instanceName: inst.label,
					service: inst.service.toLowerCase() as "sonarr" | "radarr",
					lastRunAt: inst.queueCleanerConfig.lastRunAt?.toISOString() ?? null,
					createdAt: inst.queueCleanerConfig.createdAt.toISOString(),
					updatedAt: inst.queueCleanerConfig.updatedAt.toISOString(),
				};
			});

			const instanceSummaries = instances.map((inst) => ({
				id: inst.id,
				label: inst.label,
				service: inst.service.toLowerCase() as "sonarr" | "radarr",
			}));

			return reply.send({ configs, instances: instanceSummaries });
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to fetch queue cleaner configs");
			return reply.status(500).send({ error: "Failed to fetch queue cleaner configs" });
		}
	});

	// Create config for an instance
	app.post("/queue-cleaner/configs", async (request, reply) => {
		const parsed = configCreateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply
				.status(400)
				.send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		try {
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
			const existing = await app.prisma.queueCleanerConfig.findUnique({
				where: { instanceId },
			});

			if (existing) {
				return reply
					.status(409)
					.send({ error: "Queue cleaner config already exists for this instance" });
			}

			const config = await app.prisma.queueCleanerConfig.create({
				data: { instanceId },
				include: { instance: true },
			});

			return reply.status(201).send({
				...config,
				instanceName: config.instance.label,
				service: config.instance.service.toLowerCase() as "sonarr" | "radarr",
				lastRunAt: config.lastRunAt?.toISOString() ?? null,
				createdAt: config.createdAt.toISOString(),
				updatedAt: config.updatedAt.toISOString(),
			});
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to create queue cleaner config");
			return reply.status(500).send({ error: "Failed to create queue cleaner config" });
		}
	});

	// Update config
	app.patch("/queue-cleaner/configs/:instanceId", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const parsed = configUpdateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply
				.status(400)
				.send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		try {
			const userId = request.currentUser!.id;

			// Verify instance ownership
			const instance = await app.prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId },
				include: { queueCleanerConfig: true },
			});

			if (!instance?.queueCleanerConfig) {
				return reply.status(404).send({ error: "Not found or access denied" });
			}

			const config = await app.prisma.queueCleanerConfig.update({
				where: { instanceId },
				data: parsed.data,
				include: { instance: true },
			});

			return reply.send({
				...config,
				instanceName: config.instance.label,
				service: config.instance.service.toLowerCase() as "sonarr" | "radarr",
				lastRunAt: config.lastRunAt?.toISOString() ?? null,
				createdAt: config.createdAt.toISOString(),
				updatedAt: config.updatedAt.toISOString(),
			});
		} catch (error) {
			const prismaError = error as { code?: string };
			if (prismaError.code === "P2025") {
				return reply.status(404).send({ error: "Queue cleaner config not found" });
			}
			if (prismaError.code === "P2003") {
				// Foreign key constraint - instance was deleted between auth check and update
				return reply.status(400).send({ error: "Instance no longer exists" });
			}
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to update queue cleaner config");
			return reply.status(500).send({ error: "Failed to update queue cleaner config" });
		}
	});

	// Delete config
	app.delete("/queue-cleaner/configs/:instanceId", async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };

		try {
			const userId = request.currentUser!.id;

			const instance = await app.prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId },
				include: { queueCleanerConfig: true },
			});

			if (!instance?.queueCleanerConfig) {
				return reply.status(404).send({ error: "Not found or access denied" });
			}

			await app.prisma.queueCleanerConfig.delete({
				where: { instanceId },
			});

			return reply.send({ message: "Queue cleaner config deleted" });
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to delete queue cleaner config");
			return reply.status(500).send({ error: "Failed to delete queue cleaner config" });
		}
	});

	// Get logs (paginated)
	app.get("/queue-cleaner/logs", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
		try {
			const userId = request.currentUser!.id;
			const query = request.query as {
				status?: string;
				instanceId?: string;
				page?: string;
				pageSize?: string;
			};

			let page = Number.parseInt(query.page ?? "1", 10);
			let pageSize = Number.parseInt(query.pageSize ?? "20", 10);
			if (Number.isNaN(page) || page < 1) page = 1;
			if (Number.isNaN(pageSize) || pageSize < 1) pageSize = 20;
			pageSize = Math.min(pageSize, 100);
			const skip = (page - 1) * pageSize;

			const where: Record<string, unknown> = {
				instance: { userId },
			};

			if (query.status && query.status !== "all") {
				where.status = query.status;
			}
			if (query.instanceId && query.instanceId !== "all") {
				where.instanceId = query.instanceId;
			}

			const [logs, totalCount] = await Promise.all([
				app.prisma.queueCleanerLog.findMany({
					where,
					include: { instance: true },
					orderBy: { startedAt: "desc" },
					skip,
					take: pageSize,
				}),
				app.prisma.queueCleanerLog.count({ where }),
			]);

			let logsWithParseErrors = 0;
			const formattedLogs = logs.map((logEntry) => {
				const cleanedResult = parseJsonSafe(logEntry.cleanedItems, {
					recordId: logEntry.id,
					field: "cleanedItems",
				});
				const skippedResult = parseJsonSafe(logEntry.skippedItems, {
					recordId: logEntry.id,
					field: "skippedItems",
				});
				const warnedResult = parseJsonSafe(logEntry.warnedItems, {
					recordId: logEntry.id,
					field: "warnedItems",
				});

				// Track logs with parse errors for data quality indicator
				if (cleanedResult.parseError || skippedResult.parseError || warnedResult.parseError) {
					logsWithParseErrors++;
				}

				return {
					id: logEntry.id,
					instanceId: logEntry.instanceId,
					instanceName: logEntry.instance.label,
					service: logEntry.instance.service.toLowerCase() as "sonarr" | "radarr",
					itemsCleaned: logEntry.itemsCleaned,
					itemsSkipped: logEntry.itemsSkipped,
					itemsWarned: logEntry.itemsWarned,
					isDryRun: logEntry.isDryRun,
					cleanedItems: cleanedResult.data,
					skippedItems: skippedResult.data,
					warnedItems: warnedResult.data,
					// Include parse error flag so UI can indicate data may be incomplete
					hasDataError: !!(cleanedResult.parseError || skippedResult.parseError || warnedResult.parseError),
					status: logEntry.status as
						| "running"
						| "completed"
						| "partial"
						| "skipped"
						| "error",
					message: logEntry.message,
					durationMs: logEntry.durationMs,
					startedAt: logEntry.startedAt.toISOString(),
					completedAt: logEntry.completedAt?.toISOString() ?? null,
				};
			});

			return reply.send({
				logs: formattedLogs,
				totalCount,
				// Data quality indicator for Issue 5
				dataQuality: logsWithParseErrors > 0
					? { warning: `${logsWithParseErrors} log(s) have corrupted data - item details may be incomplete` }
					: undefined,
			});
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to fetch queue cleaner logs");
			return reply.status(500).send({ error: "Failed to fetch queue cleaner logs" });
		}
	});

	// Manual clean trigger
	app.post("/queue-cleaner/trigger/:instanceId", { config: { rateLimit: MANUAL_CLEAN_RATE_LIMIT } }, async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const userId = request.currentUser!.id;

		try {
			const instance = await app.prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId },
				include: { queueCleanerConfig: true },
			});

			if (!instance?.queueCleanerConfig) {
				return reply.status(404).send({ error: "Not found or access denied" });
			}

			const scheduler = getQueueCleanerScheduler();
			const result = await scheduler.triggerManualClean(instanceId);

			if (!result.triggered) {
				// Use standard error format per CLAUDE.md
				return reply.status(429).send({
					error: result.message,
				});
			}

			return reply.send({
				message: `Queue clean started for ${instance.label}`,
				triggered: true,
			});
		} catch (error) {
			if (error instanceof SchedulerNotInitializedError) {
				return reply.status(503).send({ error: "Queue cleaner scheduler not ready" });
			}
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to trigger manual queue clean");
			return reply.status(500).send({ error: "Failed to trigger manual queue clean" });
		}
	});

	// Dry-run preview (legacy endpoint - returns basic CleanerResult)
	app.post("/queue-cleaner/dry-run/:instanceId", { config: { rateLimit: PREVIEW_RATE_LIMIT } }, async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const userId = request.currentUser!.id;

		try {
			const instance = await app.prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId },
				include: { queueCleanerConfig: true },
			});

			if (!instance?.queueCleanerConfig) {
				return reply.status(404).send({ error: "Not found or access denied" });
			}

			const scheduler = getQueueCleanerScheduler();
			const result = await scheduler.triggerDryRun(instanceId);

			return reply.send(result);
		} catch (error) {
			if (error instanceof SchedulerNotInitializedError) {
				return reply.status(503).send({ error: "Queue cleaner scheduler not ready" });
			}
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to run dry-run preview");
			return reply.status(500).send({ error: "Failed to run dry-run preview" });
		}
	});

	// Enhanced preview (returns rich data for preview modal)
	app.post("/queue-cleaner/preview/:instanceId", { config: { rateLimit: PREVIEW_RATE_LIMIT } }, async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const userId = request.currentUser!.id;

		try {
			const instance = await app.prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId },
				include: { queueCleanerConfig: true },
			});

			if (!instance?.queueCleanerConfig) {
				return reply.status(404).send({ error: "Not found or access denied" });
			}

			const scheduler = getQueueCleanerScheduler();
			const result = await scheduler.triggerEnhancedPreview(instanceId);

			return reply.send(result);
		} catch (error) {
			if (error instanceof SchedulerNotInitializedError) {
				return reply.status(503).send({ error: "Queue cleaner scheduler not ready" });
			}
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to run enhanced preview");
			return reply.status(500).send({ error: "Failed to run enhanced preview" });
		}
	});

	// Get strikes for an instance
	app.get("/queue-cleaner/strikes/:instanceId", { config: { rateLimit: READ_RATE_LIMIT } }, async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const userId = request.currentUser!.id;

		try {
			// Verify instance ownership
			const instance = await app.prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId },
			});

			if (!instance) {
				return reply.status(404).send({ error: "Not found or access denied" });
			}

			const strikes = await app.prisma.queueCleanerStrike.findMany({
				where: { instanceId },
				orderBy: { lastStrikeAt: "desc" },
			});

			const formattedStrikes = strikes.map((s) => ({
				id: s.id,
				instanceId: s.instanceId,
				downloadId: s.downloadId,
				downloadTitle: s.downloadTitle,
				strikeCount: s.strikeCount,
				lastRule: s.lastRule,
				lastReason: s.lastReason,
				firstStrikeAt: s.firstStrikeAt.toISOString(),
				lastStrikeAt: s.lastStrikeAt.toISOString(),
			}));

			return reply.send({ strikes: formattedStrikes });
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to fetch strikes");
			return reply.status(500).send({ error: "Failed to fetch strikes" });
		}
	});

	// Clear all strikes for an instance
	app.delete("/queue-cleaner/strikes/:instanceId", { config: { rateLimit: WRITE_RATE_LIMIT } }, async (request, reply) => {
		const { instanceId } = request.params as { instanceId: string };
		const userId = request.currentUser!.id;

		try {
			// Verify instance ownership
			const instance = await app.prisma.serviceInstance.findFirst({
				where: { id: instanceId, userId },
			});

			if (!instance) {
				return reply.status(404).send({ error: "Not found or access denied" });
			}

			const result = await app.prisma.queueCleanerStrike.deleteMany({
				where: { instanceId },
			});

			return reply.send({
				success: true,
				deletedCount: result.count,
				message: `Cleared ${result.count} strike(s) for ${instance.label}`,
			});
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to clear strikes");
			return reply.status(500).send({ error: "Failed to clear strikes" });
		}
	});

	// Statistics endpoint
	app.get("/queue-cleaner/statistics", { config: { rateLimit: STATISTICS_RATE_LIMIT } }, async (request, reply) => {
		const userId = request.currentUser!.id;

		try {
			// Get all logs for user instances
			const allLogs = await app.prisma.queueCleanerLog.findMany({
				where: {
					instance: { userId },
				},
				include: { instance: true },
				orderBy: { startedAt: "desc" },
			});

			// Get user's instances for the breakdown
			const instances = await app.prisma.serviceInstance.findMany({
				where: {
					userId,
					service: { in: ["SONARR", "RADARR", "LIDARR", "READARR"] },
				},
				include: { queueCleanerConfig: true },
			});

			// Calculate date boundaries
			const now = new Date();
			const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
			const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
			const fourWeeksAgo = new Date(today.getTime() - 28 * 24 * 60 * 60 * 1000);

			// Filter logs for different time periods
			const logsLast7Days = allLogs.filter((l) => l.startedAt >= sevenDaysAgo);
			const logsLast4Weeks = allLogs.filter((l) => l.startedAt >= fourWeeksAgo);

			// Calculate daily stats (last 7 days)
			const dailyMap = new Map<string, { itemsCleaned: number; itemsWarned: number; runsCompleted: number }>();
			for (let i = 0; i < 7; i++) {
				const date = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
				const dateKey = date.toISOString().split("T")[0]!;
				dailyMap.set(dateKey, { itemsCleaned: 0, itemsWarned: 0, runsCompleted: 0 });
			}

			for (const logEntry of logsLast7Days) {
				const dateKey = logEntry.startedAt.toISOString().split("T")[0]!;
				const existing = dailyMap.get(dateKey);
				if (existing) {
					existing.itemsCleaned += logEntry.itemsCleaned;
					existing.itemsWarned += logEntry.itemsWarned;
					if (logEntry.status === "completed" || logEntry.status === "partial") {
						existing.runsCompleted += 1;
					}
				}
			}

			const daily = Array.from(dailyMap.entries())
				.map(([period, stats]) => ({ period, ...stats }))
				.sort((a, b) => a.period.localeCompare(b.period));

			// Calculate weekly stats (last 4 weeks)
			const weeklyMap = new Map<string, { itemsCleaned: number; itemsWarned: number; runsCompleted: number }>();
			for (let i = 0; i < 4; i++) {
				const weekKey = `Week ${4 - i}`;
				weeklyMap.set(weekKey, { itemsCleaned: 0, itemsWarned: 0, runsCompleted: 0 });
			}

			for (const logEntry of logsLast4Weeks) {
				const daysDiff = Math.floor((today.getTime() - logEntry.startedAt.getTime()) / (24 * 60 * 60 * 1000));
				const weekIndex = Math.floor(daysDiff / 7);
				if (weekIndex < 4) {
					const weekKey = `Week ${4 - weekIndex}`;
					const existing = weeklyMap.get(weekKey);
					if (existing) {
						existing.itemsCleaned += logEntry.itemsCleaned;
						existing.itemsWarned += logEntry.itemsWarned;
						if (logEntry.status === "completed" || logEntry.status === "partial") {
							existing.runsCompleted += 1;
						}
					}
				}
			}

			const weekly = Array.from(weeklyMap.entries())
				.map(([period, stats]) => ({ period, ...stats }))
				.sort((a, b) => a.period.localeCompare(b.period));

			// Calculate totals
			const completedLogs = allLogs.filter((l) => l.status === "completed" || l.status === "partial");
			const errorLogs = allLogs.filter((l) => l.status === "error");
			const logsWithDuration = allLogs.filter((l) => l.durationMs !== null);

			const totals = {
				itemsCleaned: allLogs.reduce((sum, l) => sum + l.itemsCleaned, 0),
				itemsSkipped: allLogs.reduce((sum, l) => sum + l.itemsSkipped, 0),
				itemsWarned: allLogs.reduce((sum, l) => sum + l.itemsWarned, 0),
				totalRuns: allLogs.length,
				completedRuns: completedLogs.length,
				errorRuns: errorLogs.length,
				averageDurationMs:
					logsWithDuration.length > 0
						? Math.round(logsWithDuration.reduce((sum, l) => sum + (l.durationMs ?? 0), 0) / logsWithDuration.length)
						: 0,
				successRate: allLogs.length > 0 ? Math.round((completedLogs.length / allLogs.length) * 100) : 100,
			};

			// Calculate rule breakdown from cleanedItems JSON
			// Track skipped entries for data quality indicator (Issue 4)
			const ruleBreakdown: Record<string, number> = {};
			let skippedLogEntries = 0;
			for (const logEntry of allLogs) {
				if (logEntry.cleanedItems) {
					try {
						const items = JSON.parse(logEntry.cleanedItems) as Array<{ rule?: string }>;
						for (const item of items) {
							if (item.rule) {
								ruleBreakdown[item.rule] = (ruleBreakdown[item.rule] ?? 0) + 1;
							}
						}
					} catch (error) {
						skippedLogEntries++;
						log.warn(
							{ logId: logEntry.id, instanceId: logEntry.instanceId, err: error },
							"Malformed cleanedItems JSON in log entry - statistics may be incomplete",
						);
					}
				}
			}

			// Calculate per-instance breakdown
			const instanceBreakdown = instances.map((inst) => {
				const instanceLogs = allLogs.filter((l) => l.instanceId === inst.id);
				return {
					instanceId: inst.id,
					instanceName: inst.label,
					service: inst.service.toLowerCase() as "sonarr" | "radarr",
					itemsCleaned: instanceLogs.reduce((sum, l) => sum + l.itemsCleaned, 0),
					totalRuns: instanceLogs.length,
					lastRunAt: inst.queueCleanerConfig?.lastRunAt?.toISOString() ?? null,
				};
			});

			// Recent activity (last 10 runs)
			const recentActivity = allLogs.slice(0, 10).map((logEntry) => ({
				id: logEntry.id,
				instanceName: logEntry.instance.label,
				service: logEntry.instance.service.toLowerCase() as "sonarr" | "radarr",
				itemsCleaned: logEntry.itemsCleaned,
				itemsSkipped: logEntry.itemsSkipped,
				status: logEntry.status,
				isDryRun: logEntry.isDryRun,
				startedAt: logEntry.startedAt.toISOString(),
			}));

			return reply.send({
				daily,
				weekly,
				totals,
				ruleBreakdown,
				instanceBreakdown,
				recentActivity,
				// Data quality indicator for Issue 4
				dataQuality: skippedLogEntries > 0
					? { warning: `${skippedLogEntries} log entries had corrupted data and were excluded from rule breakdown statistics` }
					: undefined,
			});
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to fetch queue cleaner statistics");
			return reply.status(500).send({ error: "Failed to fetch queue cleaner statistics" });
		}
	});

	// Toggle scheduler
	// Note: Auth is handled by preHandler hook - no need to check here
	app.post("/queue-cleaner/scheduler/toggle", async (request, reply) => {
		try {
			const scheduler = getQueueCleanerScheduler();
			const wasRunning = scheduler.isRunning();

			if (wasRunning) {
				scheduler.stop();
			} else {
				scheduler.start(app);
			}

			return reply.send({ running: !wasRunning });
		} catch (error) {
			request.log.error({ err: error, userId: request.currentUser!.id }, "Failed to toggle queue cleaner scheduler");
			return reply.status(500).send({ error: "Failed to toggle queue cleaner scheduler" });
		}
	});

	done();
};

export const registerQueueCleanerRoutes = queueCleanerRoute;
