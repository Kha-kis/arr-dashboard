/**
 * Library Cleanup API Routes
 *
 * CRUD for cleanup config, rules, approval queue, preview, execution, and logs.
 */

import {
	bulkApprovalSchema,
	cleanupExplainRequestSchema,
	createCleanupRuleSchema,
	reorderRulesSchema,
	ruleParamSchemaMap,
	updateCleanupConfigSchema,
	updateCleanupRuleSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import {
	buildEvalContext,
	executeApprovedItems,
	executeCleanupPreview,
	executeCleanupRun,
} from "../lib/library-cleanup/cleanup-executor.js";
import { explainItemAgainstRules } from "../lib/library-cleanup/rule-evaluators.js";
import type { CacheItemForEval } from "../lib/library-cleanup/types.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { safeJsonParse as utilSafeJsonParse } from "../lib/utils/json.js";
import { parsePaginationQuery } from "../lib/utils/pagination.js";
import { validateRequest } from "../lib/utils/validate.js";

// Rate limits
const PREVIEW_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
const EXECUTE_RATE_LIMIT = { max: 3, timeWindow: "1 minute" };

// In-memory guard against concurrent execute/preview overlap (single-admin app)
let cleanupRunInProgress = false;

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
		retentionMode: rule.retentionMode ?? false,
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
		prefetchHealth: safeJsonParse(l.prefetchHealth as string | null),
		warnings: safeJsonParse(l.warnings as string | null),
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

// Field options cache: userId → { data, expiresAt }
const fieldOptionsCache = new Map<string, { data: unknown; expiresAt: number }>();
const FIELD_OPTIONS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export const registerLibraryCleanupRoutes: FastifyPluginCallback = (app, _opts, done) => {
	app.addHook("preHandler", async (request, reply) => {
		if (!request.currentUser?.id) {
			return reply.status(401).send({ error: "Authentication required" });
		}
	});

	// ─── Field Options ───────────────────────────────────────────────

	/** GET /api/library-cleanup/field-options
	 *  Extracts distinct values from the user's library cache for multi-select dropdowns.
	 *  Cached for 5 minutes to avoid expensive JSON blob parsing on each dialog open.
	 */
	app.get("/library-cleanup/field-options", async (request, reply) => {
		const userId = request.currentUser!.id;

		// Check cache
		const cached = fieldOptionsCache.get(userId);
		if (cached && cached.expiresAt > Date.now()) {
			return reply.send(cached.data);
		}

		// Get user's Sonarr + Radarr instances (full fields for client creation)
		const instances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["SONARR", "RADARR"] } },
			select: {
				id: true,
				baseUrl: true,
				encryptedApiKey: true,
				encryptionIv: true,
				service: true,
				label: true,
			},
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
			} catch (err) {
				request.log.debug(
					{ err, instanceId: inst.id },
					"Failed to fetch tags from instance, skipping",
				);
			}
		}
		arrTags.sort((a, b) => a.label.localeCompare(b.label));

		const sorted = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));

		const result = {
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
		};

		// Store in cache
		fieldOptionsCache.set(userId, {
			data: result,
			expiresAt: Date.now() + FIELD_OPTIONS_CACHE_TTL,
		});

		return reply.send(result);
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

		// Recalculate nextRunAt when enabled or intervalHours changes
		if (config.enabled && (!config.nextRunAt || data.intervalHours != null)) {
			const newNextRun = new Date(Date.now() + config.intervalHours * 60 * 60 * 1000);
			await app.prisma.libraryCleanupConfig.update({
				where: { id: config.id },
				data: { nextRunAt: newNextRun },
			});
			(config as Record<string, unknown>).nextRunAt = newNextRun;
		}

		return reply.send(serializeConfig(config as unknown as Record<string, unknown>));
	});

	// ─── Rules CRUD ───────────────────────────────────────────────────

	/** POST /api/library-cleanup/rules */
	app.post("/library-cleanup/rules", async (request, reply) => {
		const userId = request.currentUser!.id;
		const data = validateRequest(createCleanupRuleSchema, request.body);

		// Write-time parameter validation: validate params against type-specific schema
		const paramValidationError = validateRuleParameters(
			data.ruleType,
			data.parameters,
			data.conditions ?? null,
		);
		if (paramValidationError) {
			return reply.status(400).send({ error: paramValidationError });
		}

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
				plexLibraryFilter: data.plexLibraryFilter ? JSON.stringify(data.plexLibraryFilter) : null,
				action: data.action ?? "delete",
				operator: data.operator ?? null,
				conditions: data.conditions ? JSON.stringify(data.conditions) : null,
				retentionMode: data.retentionMode ?? false,
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

		// Verify all IDs belong to this config and all rules are included
		const existingIds = new Set(config.rules.map((r) => r.id));
		if (ruleIds.length !== existingIds.size) {
			return reply.status(400).send({
				error: `Expected ${existingIds.size} rule IDs but received ${ruleIds.length}`,
			});
		}
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

		// Write-time parameter validation (when ruleType or parameters are changed)
		const effectiveRuleType = data.ruleType ?? existing.ruleType;
		const effectiveParams =
			data.parameters ?? (utilSafeJsonParse(existing.parameters) as Record<string, unknown>);
		const effectiveConditions =
			data.conditions !== undefined
				? data.conditions
				: (utilSafeJsonParse(existing.conditions ?? "") as Array<{
						ruleType: string;
						parameters: Record<string, unknown>;
					}> | null);
		if (
			data.ruleType !== undefined ||
			data.parameters !== undefined ||
			data.conditions !== undefined
		) {
			const paramValidationError = validateRuleParameters(
				effectiveRuleType,
				effectiveParams ?? {},
				effectiveConditions ?? null,
			);
			if (paramValidationError) {
				return reply.status(400).send({ error: paramValidationError });
			}
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
		if (data.retentionMode !== undefined) updateData.retentionMode = data.retentionMode;

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

			if (cleanupRunInProgress || app.cleanupScheduler?.isRunning) {
				return reply.status(409).send({ error: "A cleanup operation is already in progress" });
			}

			cleanupRunInProgress = true;
			try {
				const result = await executeCleanupPreview(
					{ prisma: app.prisma, arrClientFactory: app.arrClientFactory, log: request.log },
					userId,
				);

				// Enrich with instance labels (same pattern as approval queue)
				const distinctInstanceIds = [...new Set(result.details.map((d) => d.instanceId))];
				const instanceLabelMap = new Map<string, string>();
				if (distinctInstanceIds.length > 0) {
					const instances = await app.prisma.serviceInstance.findMany({
						where: { id: { in: distinctInstanceIds }, userId },
						select: { id: true, label: true },
					});
					for (const inst of instances) {
						if (inst.label) instanceLabelMap.set(inst.id, inst.label);
					}
				}

				const MAX_PREVIEW_ITEMS = 200;
				const truncated = result.details.length > MAX_PREVIEW_ITEMS;
				const previewDetails = truncated
					? result.details.slice(0, MAX_PREVIEW_ITEMS)
					: result.details;

				return reply.send({
					totalEvaluated: result.itemsEvaluated,
					totalFlagged: result.itemsFlagged,
					items: previewDetails.map((d) => ({
						instanceId: d.instanceId,
						instanceLabel: instanceLabelMap.get(d.instanceId) ?? null,
						arrItemId: d.arrItemId,
						itemType: d.itemType ?? "movie",
						title: d.title,
						matchedRuleName: d.rule,
						reason: d.reason,
						action: d.action ?? "delete",
						sizeOnDisk: d.sizeOnDisk ?? "0",
						year: d.year ?? null,
						rating: d.rating ?? null,
					})),
					prefetchHealth: result.prefetchHealth,
					warnings: [
						...(result.warnings ?? []),
						...(truncated
							? [`Showing ${MAX_PREVIEW_ITEMS} of ${result.details.length} flagged items`]
							: []),
					],
				});
			} catch (error) {
				request.log.error({ err: error }, "Cleanup preview failed");
				return reply.status(500).send({ error: getErrorMessage(error) });
			} finally {
				cleanupRunInProgress = false;
			}
		},
	);

	/** POST /api/library-cleanup/execute */
	app.post(
		"/library-cleanup/execute",
		{ config: { rateLimit: EXECUTE_RATE_LIMIT } },
		async (request, reply) => {
			const userId = request.currentUser!.id;

			// Prevent overlapping with a scheduled run or another manual run
			if (cleanupRunInProgress || app.cleanupScheduler?.isRunning) {
				return reply.status(409).send({ error: "A cleanup operation is already in progress" });
			}

			cleanupRunInProgress = true;
			try {
				const result = await executeCleanupRun(
					{ prisma: app.prisma, arrClientFactory: app.arrClientFactory, log: request.log },
					userId,
				);

				return reply.send(result);
			} catch (error) {
				request.log.error({ err: error }, "Cleanup execution failed");
				return reply.status(500).send({ error: getErrorMessage(error) });
			} finally {
				cleanupRunInProgress = false;
			}
		},
	);

	// ─── Approval Queue ───────────────────────────────────────────────

	/** GET /api/library-cleanup/approval-queue */
	app.get("/library-cleanup/approval-queue", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { page, pageSize } = parsePaginationQuery(request.query as Record<string, string>);

		const validStatuses = ["pending", "approved", "rejected", "expired", "executing", "executed"];
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

		// Enrich with instance labels
		const distinctInstanceIds = [...new Set(approvals.map((a) => a.instanceId))];
		const instanceLabelMap = new Map<string, string>();
		if (distinctInstanceIds.length > 0) {
			const instances = await app.prisma.serviceInstance.findMany({
				where: { id: { in: distinctInstanceIds }, userId },
				select: { id: true, label: true },
			});
			for (const inst of instances) {
				if (inst.label) instanceLabelMap.set(inst.id, inst.label);
			}
		}

		return reply.send({
			items: approvals.map((a) => ({
				...serializeApproval(a as unknown as Record<string, unknown>),
				instanceLabel: instanceLabelMap.get(a.instanceId) ?? null,
			})),
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

			// nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- Fastify JSON response
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
		const query = request.query as Record<string, string>;

		// Optional filters
		const statusFilter = query.status; // "completed" | "partial" | "error"
		const sinceDate = query.since ? new Date(query.since) : undefined;
		const untilDate = query.until ? new Date(query.until) : undefined;

		// Validate date params
		if (sinceDate && Number.isNaN(sinceDate.getTime())) {
			return reply.status(400).send({ error: "Invalid 'since' date format" });
		}
		if (untilDate && Number.isNaN(untilDate.getTime())) {
			return reply.status(400).send({ error: "Invalid 'until' date format" });
		}
		if (sinceDate && untilDate && sinceDate > untilDate) {
			return reply.status(400).send({ error: "'since' must be before 'until'" });
		}

		const where: Record<string, unknown> = { config: { userId } };
		if (statusFilter) where.status = statusFilter;
		if (sinceDate || untilDate) {
			const dateFilter: Record<string, Date> = {};
			if (sinceDate) dateFilter.gte = sinceDate;
			if (untilDate) dateFilter.lte = untilDate;
			where.startedAt = dateFilter;
		}

		const [logs, total] = await Promise.all([
			app.prisma.libraryCleanupLog.findMany({
				where,
				orderBy: { startedAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			app.prisma.libraryCleanupLog.count({ where }),
		]);

		return reply.send({
			items: logs.map((l) => serializeLog(l as unknown as Record<string, unknown>)),
			total,
			page,
			pageSize,
		});
	});

	// ─── Health Status ────────────────────────────────────────────────

	/** GET /api/library-cleanup/status
	 *  Returns cleanup engine health: last run result, prefetch health, next run, pending approvals.
	 */
	app.get("/library-cleanup/status", async (request, reply) => {
		const userId = request.currentUser!.id;

		const config = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
		});

		if (!config) {
			return reply.send({
				lastRunAt: null,
				lastResult: null,
				lastErrorMessage: null,
				prefetchHealth: null,
				nextRunAt: null,
				enabled: false,
				pendingApprovals: 0,
			});
		}

		// Get the most recent log entry for last run info
		const lastLog = await app.prisma.libraryCleanupLog.findFirst({
			where: { configId: config.id },
			orderBy: { startedAt: "desc" },
			select: { status: true, error: true, prefetchHealth: true, startedAt: true },
		});

		// Count pending approvals
		const pendingApprovals = await app.prisma.libraryCleanupApproval.count({
			where: { configId: config.id, status: "pending", expiresAt: { gt: new Date() } },
		});

		return reply.send({
			lastRunAt: lastLog?.startedAt
				? lastLog.startedAt.toISOString()
				: (config.lastRunAt?.toISOString() ?? null),
			lastResult: lastLog?.status ?? null,
			lastErrorMessage: lastLog?.error ?? null,
			prefetchHealth: lastLog?.prefetchHealth ? safeJsonParse(lastLog.prefetchHealth) : null,
			nextRunAt: config.nextRunAt?.toISOString() ?? null,
			enabled: config.enabled,
			pendingApprovals,
		});
	});

	// ─── Explain ──────────────────────────────────────────────────────

	/** POST /api/library-cleanup/explain
	 *  Evaluates a single library item against all rules and returns per-rule breakdown.
	 */
	app.post("/library-cleanup/explain", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { instanceId, arrItemId } = validateRequest(cleanupExplainRequestSchema, request.body);

		// Verify instance ownership
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
			select: { id: true, service: true },
		});
		if (!instance) {
			return reply.status(404).send({ error: "Instance not found" });
		}

		// Find the cached item
		const cacheItem = await app.prisma.libraryCache.findFirst({
			where: { instanceId, arrItemId },
			select: {
				id: true,
				instanceId: true,
				arrItemId: true,
				itemType: true,
				title: true,
				year: true,
				monitored: true,
				hasFile: true,
				status: true,
				qualityProfileId: true,
				qualityProfileName: true,
				sizeOnDisk: true,
				arrAddedAt: true,
				data: true,
			},
		});
		if (!cacheItem) {
			return reply.status(404).send({ error: "Item not found in library cache" });
		}

		// Load config + rules
		const config = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			include: { rules: { orderBy: { priority: "asc" } } },
		});
		if (!config || config.rules.length === 0) {
			return reply.send({
				item: {
					title: cacheItem.title,
					year: cacheItem.year,
					instanceId,
					itemType: cacheItem.itemType,
				},
				results: [],
				retentionProtected: false,
			});
		}

		// Build a fully-populated eval context with prefetched external data
		const ctx = await buildEvalContext(
			{ prisma: app.prisma, arrClientFactory: app.arrClientFactory, log: request.log },
			userId,
			config.rules,
		);

		const results = explainItemAgainstRules(
			cacheItem as unknown as CacheItemForEval,
			config.rules,
			instance.service,
			ctx,
		);

		// Determine if any retention rule matched
		const retentionProtected = results.some((r) => r.retentionMode && r.matched);

		return reply.send({
			item: {
				title: cacheItem.title,
				year: cacheItem.year,
				instanceId,
				itemType: cacheItem.itemType,
			},
			results,
			retentionProtected,
		});
	});

	// ─── Statistics ──────────────────────────────────────────────────

	/** GET /api/library-cleanup/statistics?days=30
	 *  Returns aggregated cleanup statistics for the given period.
	 */
	app.get("/library-cleanup/statistics", async (request, reply) => {
		const userId = request.currentUser!.id;
		const query = request.query as Record<string, string>;
		const days = Math.min(365, Math.max(1, Number(query.days) || 30));

		const since = new Date();
		since.setDate(since.getDate() - days);

		const config = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			select: { id: true },
		});

		if (!config) {
			return reply.send({
				period: { since: since.toISOString(), until: new Date().toISOString() },
				totalRuns: 0,
				successfulRuns: 0,
				partialRuns: 0,
				failedRuns: 0,
				totalItemsEvaluated: 0,
				totalItemsFlagged: 0,
				totalItemsRemoved: 0,
				totalItemsUnmonitored: 0,
				totalFilesDeleted: 0,
				ruleEffectiveness: [],
				approvalFunnel: { pending: 0, approved: 0, rejected: 0, expired: 0 },
			});
		}

		// Aggregate logs in the period
		const logs = await app.prisma.libraryCleanupLog.findMany({
			where: { configId: config.id, startedAt: { gte: since } },
			select: {
				status: true,
				itemsEvaluated: true,
				itemsFlagged: true,
				itemsRemoved: true,
				itemsUnmonitored: true,
				itemsFilesDeleted: true,
				details: true,
			},
		});

		let successfulRuns = 0;
		let partialRuns = 0;
		let failedRuns = 0;
		let totalItemsEvaluated = 0;
		let totalItemsFlagged = 0;
		let totalItemsRemoved = 0;
		let totalItemsUnmonitored = 0;
		let totalFilesDeleted = 0;
		const ruleMatchCounts = new Map<string, { ruleName: string; count: number }>();

		for (const log of logs) {
			if (log.status === "completed") successfulRuns++;
			else if (log.status === "partial") partialRuns++;
			else failedRuns++;

			totalItemsEvaluated += log.itemsEvaluated;
			totalItemsFlagged += log.itemsFlagged;
			totalItemsRemoved += log.itemsRemoved;
			totalItemsUnmonitored += log.itemsUnmonitored;
			totalFilesDeleted += log.itemsFilesDeleted;

			// Parse details for rule effectiveness
			const details = safeJsonParse(log.details as string) as Array<{
				ruleId?: string;
				rule?: string;
			}> | null;
			if (Array.isArray(details)) {
				for (const d of details) {
					if (d.ruleId) {
						const existing = ruleMatchCounts.get(d.ruleId);
						if (existing) {
							existing.count++;
						} else {
							ruleMatchCounts.set(d.ruleId, { ruleName: d.rule ?? d.ruleId, count: 1 });
						}
					}
				}
			}
		}

		// Approval funnel
		const approvalCounts = await app.prisma.libraryCleanupApproval.groupBy({
			by: ["status"],
			where: { configId: config.id, createdAt: { gte: since } },
			_count: { id: true },
		});

		const approvalFunnel = { pending: 0, approved: 0, rejected: 0, expired: 0 };
		for (const a of approvalCounts) {
			if (a.status in approvalFunnel) {
				(approvalFunnel as Record<string, number>)[a.status] = a._count.id;
			}
		}

		return reply.send({
			period: { since: since.toISOString(), until: new Date().toISOString() },
			totalRuns: logs.length,
			successfulRuns,
			partialRuns,
			failedRuns,
			totalItemsEvaluated,
			totalItemsFlagged,
			totalItemsRemoved,
			totalItemsUnmonitored,
			totalFilesDeleted,
			ruleEffectiveness: Array.from(ruleMatchCounts.entries())
				.map(([ruleId, { ruleName, count }]) => ({ ruleId, ruleName, matchCount: count }))
				.sort((a, b) => b.matchCount - a.matchCount),
			approvalFunnel,
		});
	});

	done();
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Validate rule parameters against the type-specific Zod schema.
 * Also validates parameters within composite rule conditions.
 * Returns an error message string if invalid, or null if valid.
 */
function validateRuleParameters(
	ruleType: string,
	parameters: Record<string, unknown>,
	conditions: Array<{ ruleType: string; parameters: Record<string, unknown> }> | null,
): string | null {
	// For composite rules, validate each condition's parameters
	if (ruleType === "composite" && conditions) {
		for (let i = 0; i < conditions.length; i++) {
			const cond = conditions[i]!;
			const schema = ruleParamSchemaMap[cond.ruleType];
			if (schema) {
				const result = schema.safeParse(cond.parameters);
				if (!result.success) {
					const flat = result.error.flatten();
					const msgs =
						Object.values(flat.fieldErrors).flat().join(", ") || flat.formErrors.join(", ");
					return `Invalid parameters for condition[${i}] (${cond.ruleType}): ${msgs}`;
				}
			}
		}
		return null;
	}

	// For single rules, validate top-level parameters
	const schema = ruleParamSchemaMap[ruleType];
	if (schema) {
		const result = schema.safeParse(parameters);
		if (!result.success) {
			const flat = result.error.flatten();
			const msgs = Object.values(flat.fieldErrors).flat().join(", ") || flat.formErrors.join(", ");
			return `Invalid parameters for rule type "${ruleType}": ${msgs}`;
		}
	}
	return null;
}
