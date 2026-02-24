/**
 * Library Cleanup API Routes
 *
 * CRUD for cleanup config, rules, approval queue, preview, execution, and logs.
 */

import {
	bulkApprovalSchema,
	createCleanupRuleSchema,
	reorderRulesSchema,
	updateCleanupConfigSchema,
	updateCleanupRuleSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	executeApprovedItems,
	executeCleanupPreview,
	executeCleanupRun,
} from "../lib/library-cleanup/cleanup-executor.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { parsePaginationQuery } from "../lib/utils/pagination.js";
import { validateRequest } from "../lib/utils/validate.js";

// Rate limits
const PREVIEW_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
const EXECUTE_RATE_LIMIT = { max: 3, timeWindow: "1 minute" };

// ============================================================================
// Serialization helpers
// ============================================================================

function serializeConfig(config: Record<string, unknown>) {
	const rules = Array.isArray(config.rules) ? config.rules : [];
	return {
		id: config.id,
		enabled: config.enabled,
		intervalHours: config.intervalHours,
		lastRunAt: config.lastRunAt ? (config.lastRunAt as Date).toISOString() : null,
		nextRunAt: config.nextRunAt ? (config.nextRunAt as Date).toISOString() : null,
		dryRunMode: config.dryRunMode,
		maxRemovalsPerRun: config.maxRemovalsPerRun,
		requireApproval: config.requireApproval,
		rules: rules.map(serializeRule),
	};
}

function serializeRule(rule: Record<string, unknown>) {
	return {
		id: rule.id,
		name: rule.name,
		enabled: rule.enabled,
		priority: rule.priority,
		ruleType: rule.ruleType,
		parameters: safeJsonParse(rule.parameters as string) ?? {},
		serviceFilter: safeJsonParse(rule.serviceFilter as string | null),
		instanceFilter: safeJsonParse(rule.instanceFilter as string | null),
		excludeTags: safeJsonParse(rule.excludeTags as string | null),
		excludeTitles: safeJsonParse(rule.excludeTitles as string | null),
		plexLibraryFilter: safeJsonParse(rule.plexLibraryFilter as string | null),
		action: (rule.action as string) ?? "delete",
		operator: (rule.operator as string) ?? null,
		conditions: safeJsonParse(rule.conditions as string | null),
		createdAt: (rule.createdAt as Date).toISOString(),
		updatedAt: (rule.updatedAt as Date).toISOString(),
	};
}

function serializeApproval(a: Record<string, unknown>) {
	return {
		id: a.id,
		instanceId: a.instanceId,
		arrItemId: a.arrItemId,
		itemType: a.itemType,
		title: a.title,
		matchedRuleId: a.matchedRuleId,
		matchedRuleName: a.matchedRuleName,
		reason: a.reason,
		action: (a.action as string) ?? "delete",
		sizeOnDisk: String(a.sizeOnDisk),
		year: a.year,
		rating: a.rating,
		status: a.status,
		reviewedAt: a.reviewedAt ? (a.reviewedAt as Date).toISOString() : null,
		executedAt: a.executedAt ? (a.executedAt as Date).toISOString() : null,
		createdAt: (a.createdAt as Date).toISOString(),
		expiresAt: (a.expiresAt as Date).toISOString(),
	};
}

function serializeLog(l: Record<string, unknown>) {
	return {
		id: l.id,
		isDryRun: l.isDryRun,
		status: l.status,
		itemsEvaluated: l.itemsEvaluated,
		itemsFlagged: l.itemsFlagged,
		itemsRemoved: l.itemsRemoved,
		itemsUnmonitored: l.itemsUnmonitored ?? 0,
		itemsFilesDeleted: l.itemsFilesDeleted ?? 0,
		itemsSkipped: l.itemsSkipped,
		details: safeJsonParse(l.details as string | null),
		error: l.error,
		durationMs: l.durationMs,
		startedAt: (l.startedAt as Date).toISOString(),
		completedAt: l.completedAt ? (l.completedAt as Date).toISOString() : null,
	};
}

function safeJsonParse(val: string | null | undefined): unknown {
	if (!val) return null;
	try {
		return JSON.parse(val);
	} catch {
		return null;
	}
}

// ============================================================================
// Routes
// ============================================================================

export const registerLibraryCleanupRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({ error: "Authentication required" });
		}
	});

	// ─── Field Options ───────────────────────────────────────────────

	/** GET /api/library-cleanup/field-options
	 *  Extracts distinct values from the user's library cache for multi-select dropdowns.
	 */
	app.get("/library-cleanup/field-options", async (request, reply) => {
		const userId = request.currentUser!.id;

		// Get user's Sonarr + Radarr instances (full fields for client creation)
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["SONARR", "RADARR"] } },
			select: { id: true, baseUrl: true, encryptedApiKey: true, encryptionIv: true, service: true, label: true },
		});
		const instanceIds = instances.map((i) => i.id);

		// Extract distinct file metadata from library cache
		const videoCodecs = new Set<string>();
		const audioCodecs = new Set<string>();
		const resolutions = new Set<string>();
		const hdrTypes = new Set<string>();
		const releaseGroups = new Set<string>();

		if (instanceIds.length > 0) {
			const cacheItems = await app.prisma.libraryCache.findMany({
				where: { instanceId: { in: instanceIds } },
				select: { data: true },
			});

			for (const item of cacheItems) {
				const parsed = safeJsonParse(item.data);
				if (!parsed) continue;
				const data = parsed as Record<string, unknown>;

				// Try movieFile (Radarr) then episodeFile (Sonarr)
				const fileObj = (data.movieFile ?? data.episodeFile) as Record<string, unknown> | undefined;
				if (!fileObj || typeof fileObj !== "object") continue;

				if (typeof fileObj.videoCodec === "string" && fileObj.videoCodec)
					videoCodecs.add(fileObj.videoCodec);
				if (typeof fileObj.audioCodec === "string" && fileObj.audioCodec)
					audioCodecs.add(fileObj.audioCodec);
				if (typeof fileObj.resolution === "string" && fileObj.resolution)
					resolutions.add(fileObj.resolution);
				if (typeof fileObj.videoDynamicRange === "string" && fileObj.videoDynamicRange)
					hdrTypes.add(fileObj.videoDynamicRange);
				if (typeof fileObj.releaseGroup === "string" && fileObj.releaseGroup)
					releaseGroups.add(fileObj.releaseGroup);
			}
		}

		// Extract distinct Tautulli users (from Tautulli instances owned by the user)
		const tautulliUsers = new Set<string>();
		const tautulliInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "TAUTULLI" },
			select: { id: true },
		});
		if (tautulliInstances.length > 0) {
			const tautulliRows = await app.prisma.tautulliCache.findMany({
				where: { instanceId: { in: tautulliInstances.map((i) => i.id) } },
				select: { watchedByUsers: true },
			});
			for (const row of tautulliRows) {
				const users = safeJsonParse(row.watchedByUsers);
				if (Array.isArray(users)) {
					for (const u of users) {
						if (typeof u === "string" && u) tautulliUsers.add(u);
					}
				}
			}
		}

		// Extract distinct Plex users (from Plex instances owned by the user)
		const plexUsers = new Set<string>();
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
			select: { id: true },
		});
		if (plexInstances.length > 0) {
			const plexRows = await app.prisma.plexCache.findMany({
				where: { instanceId: { in: plexInstances.map((i) => i.id) } },
				select: { watchedByUsers: true },
			});
			for (const row of plexRows) {
				const users = safeJsonParse(row.watchedByUsers);
				if (Array.isArray(users)) {
					for (const u of users) {
						if (typeof u === "string" && u) plexUsers.add(u);
					}
				}
			}
		}

		// Extract distinct Plex library names
		const plexLibraries = new Set<string>();
		if (plexInstances.length > 0) {
			const sections = await app.prisma.plexCache.findMany({
				where: { instanceId: { in: plexInstances.map((i) => i.id) } },
				select: { sectionTitle: true },
				distinct: ["sectionTitle"],
			});
			for (const s of sections) {
				if (s.sectionTitle) plexLibraries.add(s.sectionTitle);
			}
		}

		// Extract distinct Plex collections and labels
		const plexCollections = new Set<string>();
		const plexLabels = new Set<string>();
		if (plexInstances.length > 0) {
			const plexMetaRows = await app.prisma.plexCache.findMany({
				where: { instanceId: { in: plexInstances.map((i) => i.id) } },
				select: { collections: true, labels: true },
			});
			for (const row of plexMetaRows) {
				const cols = safeJsonParse(row.collections);
				if (Array.isArray(cols)) {
					for (const c of cols) {
						if (typeof c === "string" && c) plexCollections.add(c);
					}
				}
				const lbls = safeJsonParse(row.labels);
				if (Array.isArray(lbls)) {
					for (const l of lbls) {
						if (typeof l === "string" && l) plexLabels.add(l);
					}
				}
			}
		}

		// Fetch ARR tags from all Sonarr/Radarr instances
		const arrTags: Array<{ id: number; label: string }> = [];
		const seenTagIds = new Set<number>();
		for (const inst of instances) {
			try {
				const client = app.arrClientFactory.createAnyClient(inst);
				const tagsData = await client.tag.getAll();
				for (const tag of tagsData as Array<{ id?: number; label?: string | null }>) {
					if (tag.id && tag.id > 0 && tag.label && !seenTagIds.has(tag.id)) {
						arrTags.push({ id: tag.id, label: tag.label });
						seenTagIds.add(tag.id);
					}
				}
			} catch { /* skip failed instances */ }
		}
		arrTags.sort((a, b) => a.label.localeCompare(b.label));

		const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));

		return reply.send({
			videoCodecs: sorted(videoCodecs),
			audioCodecs: sorted(audioCodecs),
			resolutions: sorted(resolutions),
			hdrTypes: sorted(hdrTypes),
			releaseGroups: sorted(releaseGroups),
			tautulliUsers: sorted(tautulliUsers),
			plexUsers: sorted(plexUsers),
			plexLibraries: sorted(plexLibraries),
			plexCollections: sorted(plexCollections),
			plexLabels: sorted(plexLabels),
			arrTags,
			hasPlex: plexInstances.length > 0,
			hasTautulli: tautulliInstances.length > 0,
		});
	});

	// ─── Config ───────────────────────────────────────────────────────

	/** GET /api/library-cleanup/config */
	app.get("/library-cleanup/config", async (request, reply) => {
		const userId = request.currentUser!.id;

		let config = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			include: { rules: { orderBy: { priority: "asc" } } },
		});

		if (!config) {
			// Auto-create default config
			config = await app.prisma.libraryCleanupConfig.create({
				data: { userId },
				include: { rules: { orderBy: { priority: "asc" } } },
			});
		}

		return reply.send(serializeConfig(config as unknown as Record<string, unknown>));
	});

	/** PUT /api/library-cleanup/config */
	app.put("/library-cleanup/config", async (request, reply) => {
		const userId = request.currentUser!.id;
		const data = validateRequest(updateCleanupConfigSchema, request.body);

		const config = await app.prisma.libraryCleanupConfig.upsert({
			where: { userId },
			update: data,
			create: { userId, ...data },
			include: { rules: { orderBy: { priority: "asc" } } },
		});

		// If enabled and no nextRunAt set, schedule first run
		if (config.enabled && !config.nextRunAt) {
			await app.prisma.libraryCleanupConfig.update({
				where: { id: config.id },
				data: {
					nextRunAt: new Date(Date.now() + config.intervalHours * 60 * 60 * 1000),
				},
			});
		}

		return reply.send(serializeConfig(config as unknown as Record<string, unknown>));
	});

	// ─── Rules CRUD ───────────────────────────────────────────────────

	/** POST /api/library-cleanup/rules */
	app.post("/library-cleanup/rules", async (request, reply) => {
		const userId = request.currentUser!.id;
		const data = validateRequest(createCleanupRuleSchema, request.body);

		const config = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
		});
		if (!config) {
			return reply.status(404).send({ error: "Config not found. Initialize config first." });
		}

		const rule = await app.prisma.libraryCleanupRule.create({
			data: {
				configId: config.id,
				name: data.name,
				enabled: data.enabled,
				priority: data.priority,
				ruleType: data.ruleType,
				parameters: JSON.stringify(data.parameters),
				serviceFilter: data.serviceFilter ? JSON.stringify(data.serviceFilter) : null,
				instanceFilter: data.instanceFilter ? JSON.stringify(data.instanceFilter) : null,
				excludeTags: data.excludeTags ? JSON.stringify(data.excludeTags) : null,
				excludeTitles: data.excludeTitles ? JSON.stringify(data.excludeTitles) : null,
				plexLibraryFilter: data.plexLibraryFilter
					? JSON.stringify(data.plexLibraryFilter)
					: null,
				action: data.action ?? "delete",
				operator: data.operator ?? null,
				conditions: data.conditions ? JSON.stringify(data.conditions) : null,
			},
		});

		return reply.status(201).send(serializeRule(rule as unknown as Record<string, unknown>));
	});

	/** PUT /api/library-cleanup/rules/reorder */
	app.put("/library-cleanup/rules/reorder", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { ruleIds } = validateRequest(reorderRulesSchema, request.body);

		const config = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			include: { rules: { select: { id: true } } },
		});
		if (!config) {
			return reply.status(404).send({ error: "Config not found" });
		}

		// Verify all IDs belong to this config
		const existingIds = new Set(config.rules.map((r) => r.id));
		for (const id of ruleIds) {
			if (!existingIds.has(id)) {
				return reply.status(400).send({ error: `Rule ${id} not found in config` });
			}
		}

		// Assign sequential priorities in a transaction
		await app.prisma.$transaction(
			ruleIds.map((id, index) =>
				app.prisma.libraryCleanupRule.update({
					where: { id },
					data: { priority: index },
				}),
			),
		);

		const updated = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			include: { rules: { orderBy: { priority: "asc" } } },
		});
		return reply.send(serializeConfig(updated as unknown as Record<string, unknown>));
	});

	/** PUT /api/library-cleanup/rules/:id */
	app.put<{ Params: { id: string } }>("/library-cleanup/rules/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = request.params;
		const data = validateRequest(updateCleanupRuleSchema, request.body);

		// Verify ownership
		const existing = await app.prisma.libraryCleanupRule.findFirst({
			where: { id, config: { userId } },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		const updateData: Record<string, unknown> = {};
		if (data.name !== undefined) updateData.name = data.name;
		if (data.enabled !== undefined) updateData.enabled = data.enabled;
		if (data.priority !== undefined) updateData.priority = data.priority;
		if (data.ruleType !== undefined) updateData.ruleType = data.ruleType;
		if (data.parameters !== undefined) updateData.parameters = JSON.stringify(data.parameters);
		if (data.serviceFilter !== undefined)
			updateData.serviceFilter = data.serviceFilter ? JSON.stringify(data.serviceFilter) : null;
		if (data.instanceFilter !== undefined)
			updateData.instanceFilter = data.instanceFilter ? JSON.stringify(data.instanceFilter) : null;
		if (data.excludeTags !== undefined)
			updateData.excludeTags = data.excludeTags ? JSON.stringify(data.excludeTags) : null;
		if (data.excludeTitles !== undefined)
			updateData.excludeTitles = data.excludeTitles ? JSON.stringify(data.excludeTitles) : null;
		if (data.plexLibraryFilter !== undefined)
			updateData.plexLibraryFilter = data.plexLibraryFilter
				? JSON.stringify(data.plexLibraryFilter)
				: null;
		if (data.action !== undefined) updateData.action = data.action;
		if (data.operator !== undefined) updateData.operator = data.operator ?? null;
		if (data.conditions !== undefined)
			updateData.conditions = data.conditions ? JSON.stringify(data.conditions) : null;

		const rule = await app.prisma.libraryCleanupRule.update({
			where: { id },
			data: updateData,
		});

		return reply.send(serializeRule(rule as unknown as Record<string, unknown>));
	});

	/** DELETE /api/library-cleanup/rules/:id */
	app.delete<{ Params: { id: string } }>("/library-cleanup/rules/:id", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { id } = request.params;

		const existing = await app.prisma.libraryCleanupRule.findFirst({
			where: { id, config: { userId } },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		await app.prisma.libraryCleanupRule.delete({ where: { id } });
		return reply.status(204).send();
	});

	// ─── Preview & Execute ────────────────────────────────────────────

	/** POST /api/library-cleanup/preview */
	app.post(
		"/library-cleanup/preview",
		{ config: { rateLimit: PREVIEW_RATE_LIMIT } },
		async (request, reply) => {
			const userId = request.currentUser!.id;

			try {
				const result = await executeCleanupPreview(
					{ prisma: app.prisma, arrClientFactory: app.arrClientFactory, log: request.log },
					userId,
				);

				return reply.send({
					totalEvaluated: result.itemsEvaluated,
					totalFlagged: result.itemsFlagged,
					items: result.details.map((d) => ({
						instanceId: d.instanceId,
						arrItemId: d.arrItemId,
						title: d.title,
						matchedRuleName: d.rule,
						reason: d.reason,
						action: d.action ?? "delete",
						sizeOnDisk: d.sizeOnDisk ?? "0",
						year: d.year ?? null,
						rating: d.rating ?? null,
					})),
				});
			} catch (error) {
				request.log.error({ err: error }, "Cleanup preview failed");
				return reply.status(500).send({ error: getErrorMessage(error) });
			}
		},
	);

	/** POST /api/library-cleanup/execute */
	app.post(
		"/library-cleanup/execute",
		{ config: { rateLimit: EXECUTE_RATE_LIMIT } },
		async (request, reply) => {
			const userId = request.currentUser!.id;

			try {
				const result = await executeCleanupRun(
					{ prisma: app.prisma, arrClientFactory: app.arrClientFactory, log: request.log },
					userId,
				);

				return reply.send(result);
			} catch (error) {
				request.log.error({ err: error }, "Cleanup execution failed");
				return reply.status(500).send({ error: getErrorMessage(error) });
			}
		},
	);

	// ─── Approval Queue ───────────────────────────────────────────────

	/** GET /api/library-cleanup/approval-queue */
	app.get("/library-cleanup/approval-queue", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { page, pageSize } = parsePaginationQuery(request.query as Record<string, string>);

		const validStatuses = ["pending", "approved", "rejected", "expired"];
		const rawStatus = (request.query as Record<string, string>).status || "pending";
		const statusFilter = validStatuses.includes(rawStatus) ? rawStatus : "pending";

		const [approvals, total] = await Promise.all([
			app.prisma.libraryCleanupApproval.findMany({
				where: {
					config: { userId },
					status: statusFilter,
				},
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			app.prisma.libraryCleanupApproval.count({
				where: {
					config: { userId },
					status: statusFilter,
				},
			}),
		]);

		return reply.send({
			items: approvals.map((a) => serializeApproval(a as unknown as Record<string, unknown>)),
			total,
			page,
			pageSize,
		});
	});

	/** POST /api/library-cleanup/approval-queue/:id/approve */
	app.post<{ Params: { id: string } }>(
		"/library-cleanup/approval-queue/:id/approve",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = request.params;

			const approval = await app.prisma.libraryCleanupApproval.findFirst({
				where: { id, config: { userId }, status: "pending" },
			});
			if (!approval) {
				return reply.status(404).send({ error: "Approval not found or not pending" });
			}

			await app.prisma.libraryCleanupApproval.update({
				where: { id },
				data: { status: "approved", reviewedAt: new Date() },
			});

			// Execute immediately
			const result = await executeApprovedItems(
				{ prisma: app.prisma, arrClientFactory: app.arrClientFactory, log: request.log },
				userId,
				[id],
			);

			return reply.send(result);
		},
	);

	/** POST /api/library-cleanup/approval-queue/:id/reject */
	app.post<{ Params: { id: string } }>(
		"/library-cleanup/approval-queue/:id/reject",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = request.params;

			const approval = await app.prisma.libraryCleanupApproval.findFirst({
				where: { id, config: { userId }, status: "pending" },
			});
			if (!approval) {
				return reply.status(404).send({ error: "Approval not found or not pending" });
			}

			await app.prisma.libraryCleanupApproval.update({
				where: { id },
				data: { status: "rejected", reviewedAt: new Date() },
			});

			return reply.status(204).send();
		},
	);

	/** POST /api/library-cleanup/approval-queue/bulk */
	app.post("/library-cleanup/approval-queue/bulk", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { ids, action } = validateRequest(bulkApprovalSchema, request.body);

		if (action === "rejected") {
			const result = await app.prisma.libraryCleanupApproval.updateMany({
				where: { id: { in: ids }, config: { userId }, status: "pending" },
				data: { status: "rejected", reviewedAt: new Date() },
			});
			return reply.send({ updated: result.count });
		}

		// Approve and execute
		await app.prisma.libraryCleanupApproval.updateMany({
			where: { id: { in: ids }, config: { userId }, status: "pending" },
			data: { status: "approved", reviewedAt: new Date() },
		});

		const result = await executeApprovedItems(
			{ prisma: app.prisma, arrClientFactory: app.arrClientFactory, log: request.log },
			userId,
			ids,
		);

		return reply.send(result);
	});

	// ─── Logs ─────────────────────────────────────────────────────────

	/** GET /api/library-cleanup/logs */
	app.get("/library-cleanup/logs", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { page, pageSize } = parsePaginationQuery(request.query as Record<string, string>);

		const [logs, total] = await Promise.all([
			app.prisma.libraryCleanupLog.findMany({
				where: { config: { userId } },
				orderBy: { startedAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			app.prisma.libraryCleanupLog.count({
				where: { config: { userId } },
			}),
		]);

		return reply.send({
			items: logs.map((l) => serializeLog(l as unknown as Record<string, unknown>)),
			total,
			page,
			pageSize,
		});
	});

	done();
};
