import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { getHuntingScheduler } from "../lib/hunting/scheduler.js";

const huntConfigUpdateSchema = z.object({
	huntMissingEnabled: z.boolean().optional(),
	huntUpgradesEnabled: z.boolean().optional(),
	missingBatchSize: z.number().int().min(1).max(50).optional(),
	missingIntervalMins: z.number().int().min(15).max(1440).optional(),
	upgradeBatchSize: z.number().int().min(1).max(50).optional(),
	upgradeIntervalMins: z.number().int().min(15).max(1440).optional(),
	hourlyApiCap: z.number().int().min(10).max(500).optional(),
	queueThreshold: z.number().int().min(0).max(100).optional(),
});

const huntConfigCreateSchema = z.object({
	instanceId: z.string().min(1),
});

const exclusionCreateSchema = z.object({
	instanceId: z.string().min(1),
	mediaType: z.enum(["series", "movie"]),
	mediaId: z.number().int(),
	title: z.string().min(1),
	reason: z.string().optional(),
});

const huntingRoute: FastifyPluginCallback = (app, _opts, done) => {
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

		// Get total exclusions
		const totalExclusions = await app.prisma.huntExclusion.count({
			where: {
				config: {
					instance: { userId },
				},
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
			totalExclusions,
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
			return reply.status(404).send({ error: "Instance not found" });
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
			return reply.status(404).send({ error: "Instance not found" });
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

		const page = Number.parseInt(query.page ?? "1", 10);
		const pageSize = Math.min(Number.parseInt(query.pageSize ?? "20", 10), 100);
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
			itemsFound: log.itemsFound,
			searchedItems: log.searchedItems ? JSON.parse(log.searchedItems) : null,
			foundItems: log.foundItems ? JSON.parse(log.foundItems) : null,
			status: log.status as "completed" | "partial" | "skipped" | "error",
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

	// Get hunt exclusions
	app.get("/hunting/exclusions", async (request, reply) => {
		const userId = request.currentUser!.id;
		const query = request.query as {
			mediaType?: string;
			instanceId?: string;
			page?: string;
			pageSize?: string;
		};

		const page = Number.parseInt(query.page ?? "1", 10);
		const pageSize = Math.min(Number.parseInt(query.pageSize ?? "20", 10), 100);
		const skip = (page - 1) * pageSize;

		const where: Record<string, unknown> = {
			config: {
				instance: { userId },
			},
		};

		if (query.mediaType && query.mediaType !== "all") {
			where.mediaType = query.mediaType;
		}
		if (query.instanceId && query.instanceId !== "all") {
			where.config = {
				instance: { userId, id: query.instanceId },
			};
		}

		const [exclusions, totalCount, instances] = await Promise.all([
			app.prisma.huntExclusion.findMany({
				where,
				include: {
					config: {
						include: { instance: true },
					},
				},
				orderBy: { createdAt: "desc" },
				skip,
				take: pageSize,
			}),
			app.prisma.huntExclusion.count({ where }),
			app.prisma.serviceInstance.findMany({
				where: {
					userId,
					service: { in: ["SONARR", "RADARR"] },
				},
				select: { id: true, label: true, service: true },
			}),
		]);

		const formattedExclusions = exclusions.map((ex) => ({
			id: ex.id,
			configId: ex.configId,
			instanceName: ex.config.instance.label,
			service: ex.config.instance.service.toLowerCase() as "sonarr" | "radarr",
			mediaType: ex.mediaType as "series" | "movie",
			mediaId: ex.mediaId,
			title: ex.title,
			reason: ex.reason,
			createdAt: ex.createdAt.toISOString(),
		}));

		const instanceSummaries = instances.map((inst) => ({
			id: inst.id,
			label: inst.label,
			service: inst.service.toLowerCase() as "sonarr" | "radarr",
		}));

		return reply.send({
			exclusions: formattedExclusions,
			instances: instanceSummaries,
			totalCount,
		});
	});

	// Add exclusion
	app.post("/hunting/exclusions", async (request, reply) => {
		const parsed = exclusionCreateSchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "Invalid payload", details: parsed.error.flatten() });
		}

		const userId = request.currentUser!.id;
		const { instanceId, mediaType, mediaId, title, reason } = parsed.data;

		// Verify instance ownership and get config
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
			include: { huntConfig: true },
		});

		if (!instance) {
			return reply.status(404).send({ error: "Instance not found" });
		}

		if (!instance.huntConfig) {
			return reply.status(400).send({ error: "Hunt config not found for this instance" });
		}

		const exclusion = await app.prisma.huntExclusion.create({
			data: {
				configId: instance.huntConfig.id,
				mediaType,
				mediaId,
				title,
				reason,
			},
			include: {
				config: {
					include: { instance: true },
				},
			},
		});

		return reply.status(201).send({
			id: exclusion.id,
			configId: exclusion.configId,
			instanceName: exclusion.config.instance.label,
			service: exclusion.config.instance.service.toLowerCase() as "sonarr" | "radarr",
			mediaType: exclusion.mediaType as "series" | "movie",
			mediaId: exclusion.mediaId,
			title: exclusion.title,
			reason: exclusion.reason,
			createdAt: exclusion.createdAt.toISOString(),
		});
	});

	// Remove exclusion
	app.delete("/hunting/exclusions/:id", async (request, reply) => {
		const { id } = request.params as { id: string };
		const userId = request.currentUser!.id;

		// Verify ownership through the config's instance
		const exclusion = await app.prisma.huntExclusion.findFirst({
			where: {
				id,
				config: {
					instance: { userId },
				},
			},
		});

		if (!exclusion) {
			return reply.status(404).send({ error: "Exclusion not found" });
		}

		await app.prisma.huntExclusion.delete({ where: { id } });
		return reply.status(204).send();
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

	// Manual hunt trigger (for testing)
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
			return reply.status(404).send({ error: "Instance not found" });
		}

		if (!instance.huntConfig) {
			return reply.status(400).send({ error: "Hunt config not found for this instance" });
		}

		const huntType = body.type === "upgrade" ? "upgrade" : "missing";

		// Queue hunt job (will be implemented with scheduler)
		const scheduler = getHuntingScheduler();
		scheduler.queueManualHunt(instanceId, huntType);

		return reply.send({
			message: `${huntType} hunt queued for ${instance.label}`,
			queued: true,
		});
	});

	done();
};

export const registerHuntingRoutes = huntingRoute;
