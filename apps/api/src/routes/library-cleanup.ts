/**
 * Library Cleanup API Routes
 *
 * CRUD for cleanup config, rules, approval queue, preview, execution, and logs.
 */

import { randomUUID } from "node:crypto";
import {
	bulkApprovalSchema,
	type CleanupRuleExpression,
	cleanupExplainRequestSchema,
	cleanupRuleRequiresRadarrRatings,
	createCleanupRuleSchema,
	getCleanupRuleScopeValidationError,
	isVersionedCleanupRuleExpression,
	reorderRulesSchema,
	ruleParamSchemaMap,
	type UpdateCleanupRule,
	updateCleanupConfigSchema,
	updateCleanupRuleSchema,
	type VersionedCleanupRuleExpression,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import {
	approvalRecordToAuditSnapshot,
	cleanupAuditEnabled,
	recordApprovalExpired,
	recordApprovalTransition,
	runCleanupAuditBestEffort,
} from "../lib/library-cleanup/cleanup-audit.js";
import {
	buildEvalContextWithHealth,
	CleanupPolicyMutationConflictError,
	CleanupRunAlreadyInProgressError,
	episodeCoordinateKey,
	executeApprovedItems,
	executeCleanupPreview,
	executeCleanupRun,
	executeRetryItems,
	extractSeriesTmdbId,
	prefetchFreshPlexEpisodeWatchData,
	withCleanupPolicyMutationLease,
} from "../lib/library-cleanup/cleanup-executor.js";
import {
	CleanupMaintenanceConflictError,
	withCleanupOperationGuard,
} from "../lib/library-cleanup/cleanup-maintenance-gate.js";
import {
	type EpisodeExplainEvidence,
	explainItemAgainstRules,
	normalizeStoredCleanupRuleExpression,
} from "../lib/library-cleanup/rule-evaluators.js";
import type { CacheItemForEval } from "../lib/library-cleanup/types.js";
import {
	buildFreshCompleteFileIdIndex,
	getAllHashesForFileIdComplete,
} from "../lib/library-sync/infohash-backfill-by-inode.js";
import { createQuiClient } from "../lib/qui/client-factory.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { safeJsonParse as utilSafeJsonParse } from "../lib/utils/json.js";
import { parsePaginationQuery } from "../lib/utils/pagination.js";
import { validateRequest } from "../lib/utils/validate.js";

// Rate limits
const PREVIEW_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
const EXECUTE_RATE_LIMIT = { max: 3, timeWindow: "1 minute" };
const QUI_PREVIEW_CACHE_FRESHNESS_MS = 30 * 60_000;

// In-memory guard against concurrent execute/preview overlap (single-admin app)
let cleanupRunInProgress = false;

function isCleanupConflict(
	error: unknown,
): error is
	| CleanupRunAlreadyInProgressError
	| CleanupMaintenanceConflictError
	| CleanupPolicyMutationConflictError {
	return (
		error instanceof CleanupRunAlreadyInProgressError ||
		error instanceof CleanupMaintenanceConflictError ||
		error instanceof CleanupPolicyMutationConflictError
	);
}

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
		respectQuiSeeding: config.respectQuiSeeding,
		rejectionMemoryDays: config.rejectionMemoryDays ?? null,
		rules: rules.map(serializeRule),
	};
}

export function serializeRule(rule: Record<string, unknown>) {
	const storedConditions = safeJsonParse(rule.conditions as string | null);
	const storedExpression = isVersionedCleanupRuleExpression(storedConditions)
		? storedConditions
		: null;
	const normalizedStoredRule = normalizeStoredCleanupRuleExpression({
		ruleType: typeof rule.ruleType === "string" ? rule.ruleType : "",
		parameters: typeof rule.parameters === "string" ? rule.parameters : "{}",
		operator: typeof rule.operator === "string" ? rule.operator : null,
		conditions: typeof rule.conditions === "string" ? rule.conditions : null,
	});
	const expression = storedExpression && normalizedStoredRule ? storedExpression : null;
	const legacyConditions = Array.isArray(storedConditions) ? storedConditions : null;
	const executableLegacyConditions =
		!storedExpression && legacyConditions && normalizedStoredRule ? legacyConditions : null;
	const requiresRadarrRatings = cleanupRuleRequiresRadarrRatings({
		ruleType: typeof rule.ruleType === "string" ? rule.ruleType : null,
		parameters:
			typeof safeJsonParse(rule.parameters as string) === "object"
				? (safeJsonParse(rule.parameters as string) as Record<string, unknown>)
				: {},
		operator: typeof rule.operator === "string" ? rule.operator : null,
		conditions: executableLegacyConditions,
		expression,
	});
	return {
		id: rule.id,
		name: rule.name,
		enabled: rule.enabled,
		priority: rule.priority,
		ruleType: rule.ruleType,
		parameters: safeJsonParse(rule.parameters as string) ?? {},
		serviceFilter: requiresRadarrRatings
			? ["RADARR"]
			: safeJsonParse(rule.serviceFilter as string | null),
		instanceFilter: safeJsonParse(rule.instanceFilter as string | null),
		excludeTags: safeJsonParse(rule.excludeTags as string | null),
		excludeTitles: safeJsonParse(rule.excludeTitles as string | null),
		plexLibraryFilter: safeJsonParse(rule.plexLibraryFilter as string | null),
		targetScope: rule.targetScope === "episode" ? "episode" : "series",
		action: (rule.action as string) ?? "delete",
		scanMediaServerAfterDelete: rule.scanMediaServerAfterDelete ?? false,
		operator: executableLegacyConditions ? ((rule.operator as string) ?? null) : null,
		conditions: executableLegacyConditions,
		expression,
		retentionMode: rule.retentionMode ?? false,
		useGlobalRejectionMemory: rule.useGlobalRejectionMemory ?? true,
		rejectionMemoryDays: rule.rejectionMemoryDays ?? null,
		createdAt: (rule.createdAt as Date).toISOString(),
		updatedAt: (rule.updatedAt as Date).toISOString(),
	};
}

export function getRecursiveRuleUpdateError(
	data: UpdateCleanupRule,
	effectiveRuleType: string,
	effectiveOperator: string | null,
	effectiveConditions: readonly unknown[] | null,
	effectiveExpression: VersionedCleanupRuleExpression | null,
	storedExpression: VersionedCleanupRuleExpression | null,
): string | null {
	if (effectiveExpression && effectiveRuleType !== "composite") {
		return "Recursive expressions require the composite rule type";
	}
	if (
		storedExpression &&
		data.expression === undefined &&
		(data.operator !== undefined || data.conditions !== undefined) &&
		(data.operator == null || !data.conditions?.length)
	) {
		return "Replacing a recursive expression with legacy conditions requires both an operator and conditions";
	}
	if (
		effectiveRuleType === "composite" &&
		!effectiveExpression &&
		(effectiveOperator == null || !effectiveConditions?.length)
	) {
		return "Composite rules require an expression or an operator with conditions";
	}
	if (
		effectiveRuleType !== "composite" &&
		(effectiveExpression || effectiveOperator != null || effectiveConditions != null)
	) {
		return "Only composite rules can contain conditions or expressions";
	}
	return null;
}

export function serializeApproval(a: Record<string, unknown>) {
	return {
		id: a.id,
		instanceId: a.instanceId,
		arrItemId: a.arrItemId,
		itemType: a.itemType,
		targetScope: a.targetScope === "episode" ? "episode" : "series",
		arrEpisodeId: (a.arrEpisodeId as number | null) ?? null,
		seasonNumber: (a.seasonNumber as number | null) ?? null,
		episodeNumber: (a.episodeNumber as number | null) ?? null,
		seriesTitle: (a.title as string | null) ?? null,
		episodeTitle: (a.episodeTitle as string | null) ?? null,
		title: a.title,
		matchedRuleId: a.matchedRuleId,
		matchedRuleName: a.matchedRuleName,
		reason: a.reason,
		action: (a.action as string) ?? "delete",
		scanMediaServerAfterDelete: a.scanMediaServerAfterDelete ?? false,
		sizeOnDisk: String(a.sizeOnDisk),
		year: a.year,
		rating: a.rating,
		status: a.status,
		lastExecutionError: (a.lastExecutionError as string | null) ?? null,
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
const CLEANUP_ACTIVITY_EVENTS_PER_TIMELINE = 200;
const cleanupActivityEventParamsSchema = z.object({
	actionId: z.string().min(1),
});
const cleanupActivityEventQuerySchema = z.object({
	cursor: z.coerce.number().int().positive().max(2_147_483_647),
	pageSize: z.coerce
		.number()
		.int()
		.min(1)
		.max(CLEANUP_ACTIVITY_EVENTS_PER_TIMELINE)
		.default(CLEANUP_ACTIVITY_EVENTS_PER_TIMELINE),
});

export const registerLibraryCleanupRoutes: FastifyPluginCallback = (app, _opts, done) => {
	const appendApprovalTransition = async (
		id: string,
		userId: string,
		eventType: "approval_approved" | "approval_rejected",
		correlationId: string,
		reviewedAt?: Date,
	): Promise<void> => {
		await runCleanupAuditBestEffort(
			async () => {
				if (!cleanupAuditEnabled(app.prisma)) return;
				const approval = await app.prisma.libraryCleanupApproval.findFirst({
					where: {
						id,
						config: { userId },
						status: eventType === "approval_approved" ? "approved" : "rejected",
						...(eventType === "approval_approved" ? { executionToken: correlationId } : {}),
						...(reviewedAt ? { reviewedAt } : {}),
					},
				});
				if (!approval) return;
				await recordApprovalTransition(
					app.prisma,
					{
						approval: approvalRecordToAuditSnapshot(approval),
						eventType,
						actorId: userId,
						correlationId,
					},
					app.log,
				);
			},
			app.log,
			"approval transition",
		);
	};
	const expirePendingApprovals = async (userId: string): Promise<void> => {
		if (!cleanupAuditEnabled(app.prisma)) return;
		const now = new Date();
		const expired = await app.prisma.libraryCleanupApproval.updateMany({
			where: {
				config: { userId },
				status: "pending",
				expiresAt: { lte: now },
			},
			data: {
				status: "expired",
				reviewedAt: now,
				lastExecutionError: "Approval expired before operator action.",
			},
		});
		if (expired.count === 0) return;
		await runCleanupAuditBestEffort(
			async () => {
				if (!cleanupAuditEnabled(app.prisma)) return;
				const expiring = await app.prisma.libraryCleanupApproval.findMany({
					where: {
						config: { userId },
						status: "expired",
						expiresAt: { lte: now },
						reviewedAt: now,
					},
				});
				for (const approval of expiring) {
					await recordApprovalExpired(app.prisma, approvalRecordToAuditSnapshot(approval), app.log);
				}
			},
			app.log,
			"approval expiry",
		);
	};

	const quiFileHashIndexFactory = async (instance: Parameters<typeof createQuiClient>[1]) => {
		const client = createQuiClient(app, instance);
		const index = await buildFreshCompleteFileIdIndex(client, instance, app.log);
		return {
			resolve: (path: string) => getAllHashesForFileIdComplete(path, index),
		};
	};
	const canonicalizeImdbInstanceFilter = async (
		userId: string,
		instanceFilter: string[] | null | undefined,
	): Promise<{ value: string[] | null; error: string | null }> => {
		const value = instanceFilter?.length ? [...new Set(instanceFilter)] : null;
		if (!value) return { value: null, error: null };
		const compatible = await app.prisma.serviceInstance.findMany({
			where: {
				id: { in: value },
				userId,
				enabled: true,
				service: "RADARR",
			},
			select: { id: true },
		});
		const compatibleIds = new Set(compatible.map((instance) => instance.id));
		if (value.some((id) => !compatibleIds.has(id))) {
			return {
				value,
				error:
					"IMDb rating cleanup rules can target only enabled Radarr instances owned by this user.",
			};
		}
		return { value, error: null };
	};
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
				encryptedHttpAuthCredentials: true,
				httpAuthEncryptionIv: true,
				service: true,
				label: true,
			},
		});
		const instanceIds = instances.map((i) => i.id);

		// Extract distinct file metadata from library cache.
		//
		// Cursor-paginate the LibraryCache.data scan to bound peak heap.
		// A naive `findMany({ select: { data: true } })` over the full table
		// loads every JSON blob into memory at once — for a Sonarr-heavy
		// library with full series payloads, that easily peaks past the
		// 768 MB container cap (issue #427 follow-up). Same pattern PR #435
		// applied to prefetchPlexData / prefetchJellyfinData / prefetchTautulliData.
		const FIELD_OPTIONS_BATCH_SIZE = 500;
		const videoCodecs = new Set<string>();
		const audioCodecs = new Set<string>();
		const resolutions = new Set<string>();
		const hdrTypes = new Set<string>();
		const releaseGroups = new Set<string>();

		if (instanceIds.length > 0) {
			let cursor: string | undefined;
			while (true) {
				const batch = await app.prisma.libraryCache.findMany({
					where: { instanceId: { in: instanceIds } },
					select: { id: true, data: true },
					take: FIELD_OPTIONS_BATCH_SIZE,
					...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
					orderBy: { id: "asc" },
				});

				if (batch.length === 0) break;

				for (const item of batch) {
					const parsed = safeJsonParse(item.data);
					if (!parsed) continue;
					const data = parsed as Record<string, unknown>;

					// Try movieFile (Radarr) then episodeFile (Sonarr)
					const fileObj = (data.movieFile ?? data.episodeFile) as
						| Record<string, unknown>
						| undefined;
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

				cursor = batch[batch.length - 1]!.id;
				if (batch.length < FIELD_OPTIONS_BATCH_SIZE) break;
			}
		}

		// All cache-table scans below cursor-paginate (issue #427 follow-up).
		// Watch-cache rows are small per-row but a 50k+ Plex/Jellyfin library
		// loaded in one shot still allocates tens of MB before GC, and the
		// previous shape ran 3 separate full-table scans of plexCache. Single
		// merged cursor walk per cache type instead.
		const collectStrings = (raw: string | null | undefined, sink: Set<string>): void => {
			const parsed = safeJsonParse(raw);
			if (!Array.isArray(parsed)) return;
			for (const v of parsed) {
				if (typeof v === "string" && v) sink.add(v);
			}
		};

		// Extract distinct Tautulli users (cursor-paginated)
		const tautulliUsers = new Set<string>();
		const tautulliInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "TAUTULLI" },
			select: { id: true },
		});
		if (tautulliInstances.length > 0) {
			const tautulliInstanceIds = tautulliInstances.map((i) => i.id);
			let cursor: string | undefined;
			while (true) {
				const batch = await app.prisma.tautulliCache.findMany({
					where: { instanceId: { in: tautulliInstanceIds } },
					select: { id: true, watchedByUsers: true },
					take: FIELD_OPTIONS_BATCH_SIZE,
					...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
					orderBy: { id: "asc" },
				});
				if (batch.length === 0) break;
				for (const row of batch) collectStrings(row.watchedByUsers, tautulliUsers);
				cursor = batch[batch.length - 1]!.id;
				if (batch.length < FIELD_OPTIONS_BATCH_SIZE) break;
			}
		}

		// Extract distinct Plex users / libraries / collections / labels in
		// ONE cursor-paginated scan. The previous shape did three separate
		// full-table scans of plexCache for the same instance set.
		const plexUsers = new Set<string>();
		const plexLibraries = new Set<string>();
		const plexCollections = new Set<string>();
		const plexLabels = new Set<string>();
		const plexInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX" },
			select: { id: true },
		});
		if (plexInstances.length > 0) {
			const plexInstanceIds = plexInstances.map((i) => i.id);
			let cursor: string | undefined;
			while (true) {
				const batch = await app.prisma.plexCache.findMany({
					where: { instanceId: { in: plexInstanceIds } },
					select: {
						id: true,
						sectionTitle: true,
						watchedByUsers: true,
						collections: true,
						labels: true,
					},
					take: FIELD_OPTIONS_BATCH_SIZE,
					...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
					orderBy: { id: "asc" },
				});
				if (batch.length === 0) break;
				for (const row of batch) {
					if (row.sectionTitle) plexLibraries.add(row.sectionTitle);
					collectStrings(row.watchedByUsers, plexUsers);
					collectStrings(row.collections, plexCollections);
					collectStrings(row.labels, plexLabels);
				}
				cursor = batch[batch.length - 1]!.id;
				if (batch.length < FIELD_OPTIONS_BATCH_SIZE) break;
			}
		}

		// Extract distinct Jellyfin users + libraries (cursor-paginated)
		const jellyfinUsers = new Set<string>();
		const jellyfinLibraries = new Set<string>();
		const jellyfinInstances = await app.prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] } },
			select: { id: true },
		});
		if (jellyfinInstances.length > 0) {
			const jellyfinInstanceIds = jellyfinInstances.map((i) => i.id);
			let cursor: string | undefined;
			while (true) {
				const batch = await app.prisma.jellyfinCache.findMany({
					where: { instanceId: { in: jellyfinInstanceIds } },
					select: { id: true, watchedByUsers: true, libraryName: true },
					take: FIELD_OPTIONS_BATCH_SIZE,
					...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
					orderBy: { id: "asc" },
				});
				if (batch.length === 0) break;
				for (const row of batch) {
					if (row.libraryName) jellyfinLibraries.add(row.libraryName);
					collectStrings(row.watchedByUsers, jellyfinUsers);
				}
				cursor = batch[batch.length - 1]!.id;
				if (batch.length < FIELD_OPTIONS_BATCH_SIZE) break;
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
			jellyfinUsers: sorted(jellyfinUsers),
			jellyfinLibraries: sorted(jellyfinLibraries),
			arrTags,
			hasPlex: plexInstances.length > 0,
			hasTautulli: tautulliInstances.length > 0,
			hasJellyfin: jellyfinInstances.length > 0,
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
			include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
		});

		if (!config) {
			// Auto-create the coordination row while restore and cleanup-sensitive
			// writes are excluded.
			config = await withCleanupPolicyMutationLease(
				{ prisma: app.prisma, log: request.log },
				userId,
				async () => {
					const initialized = await app.prisma.libraryCleanupConfig.findUnique({
						where: { userId },
						include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
					});
					if (!initialized) throw new Error("Cleanup configuration could not be initialized");
					return initialized;
				},
			);
		}

		return reply.send(serializeConfig(config as unknown as Record<string, unknown>));
	});

	/** PUT /api/library-cleanup/config */
	app.put("/library-cleanup/config", async (request, reply) => {
		const userId = request.currentUser!.id;
		const data = validateRequest(updateCleanupConfigSchema, request.body);

		return await withCleanupPolicyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const config = await app.prisma.libraryCleanupConfig.upsert({
					where: { userId },
					update: data,
					create: { userId, ...data },
					include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
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
			},
		);
	});

	// ─── Rules CRUD ───────────────────────────────────────────────────

	/** POST /api/library-cleanup/rules */
	app.post("/library-cleanup/rules", async (request, reply) => {
		const userId = request.currentUser!.id;
		const data = validateRequest(createCleanupRuleSchema, request.body);
		const normalizedParameters = applyRuleParameterDefaults(data.ruleType, data.parameters);
		const normalizedConditions = data.conditions?.map((condition) => ({
			...condition,
			parameters: applyRuleParameterDefaults(condition.ruleType, condition.parameters),
		}));
		const normalizedExpression = data.expression
			? applyExpressionParameterDefaults(data.expression)
			: null;
		const requiresRadarrRatings = cleanupRuleRequiresRadarrRatings({
			...data,
			expression: normalizedExpression,
		});
		const imdbInstanceFilter = requiresRadarrRatings
			? await canonicalizeImdbInstanceFilter(userId, data.instanceFilter)
			: {
					value: data.instanceFilter?.length ? [...new Set(data.instanceFilter)] : null,
					error: null,
				};
		if (imdbInstanceFilter.error) {
			return reply.status(400).send({ error: imdbInstanceFilter.error });
		}

		// Write-time parameter validation: validate params against type-specific schema
		const paramValidationError = validateRuleParameters(
			data.ruleType,
			normalizedParameters,
			normalizedConditions ?? null,
			normalizedExpression,
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

		return await withCleanupPolicyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const rule = await app.prisma.libraryCleanupRule.create({
					data: {
						configId: config.id,
						name: data.name,
						enabled: data.enabled,
						priority: data.priority,
						ruleType: data.ruleType,
						parameters: JSON.stringify(normalizedParameters),
						serviceFilter: requiresRadarrRatings
							? JSON.stringify(["RADARR"])
							: data.serviceFilter
								? JSON.stringify(data.serviceFilter)
								: null,
						instanceFilter: imdbInstanceFilter.value
							? JSON.stringify(imdbInstanceFilter.value)
							: null,
						excludeTags: data.excludeTags ? JSON.stringify(data.excludeTags) : null,
						excludeTitles: data.excludeTitles ? JSON.stringify(data.excludeTitles) : null,
						plexLibraryFilter: data.plexLibraryFilter?.length
							? JSON.stringify(data.plexLibraryFilter)
							: null,
						targetScope: data.targetScope ?? "series",
						action: data.action ?? "delete",
						scanMediaServerAfterDelete: data.scanMediaServerAfterDelete ?? false,
						operator: normalizedExpression ? null : (data.operator ?? null),
						conditions: normalizedExpression
							? JSON.stringify(normalizedExpression)
							: normalizedConditions?.length
								? JSON.stringify(normalizedConditions)
								: null,
						retentionMode: data.retentionMode ?? false,
						useGlobalRejectionMemory: data.useGlobalRejectionMemory ?? true,
						// `?? 0` would collapse a deliberate `null` (forever) to `0` (off),
						// silently downgrading "Forever" → "Off" on rule creation. The
						// encoding contract is null=forever, 0=off, N>0=days — so only
						// substitute the default for `undefined`. PUT path on rule update
						// uses the same `!== undefined` discipline; keep them symmetric.
						rejectionMemoryDays:
							data.rejectionMemoryDays === undefined ? 0 : data.rejectionMemoryDays,
					},
				});

				return reply.status(201).send(serializeRule(rule as unknown as Record<string, unknown>));
			},
			{ configId: config.id },
		);
	});

	/** PUT /api/library-cleanup/rules/reorder */
	app.put("/library-cleanup/rules/reorder", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { ruleIds } = validateRequest(reorderRulesSchema, request.body);

		const configRef = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			select: { id: true },
		});
		if (!configRef) {
			return reply.status(404).send({ error: "Config not found" });
		}

		return await withCleanupPolicyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
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
					include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
				});
				return reply.send(serializeConfig(updated as unknown as Record<string, unknown>));
			},
			{ configId: configRef.id },
		);
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
		const storedConditions = utilSafeJsonParse(existing.conditions ?? "") as unknown;
		const storedExpression = isVersionedCleanupRuleExpression(storedConditions)
			? storedConditions
			: null;
		const effectiveConditions =
			data.expression != null
				? null
				: data.conditions !== undefined
					? data.conditions
					: data.expression === null || storedExpression
						? null
						: (storedConditions as Array<{
								ruleType: string;
								parameters: Record<string, unknown>;
							}> | null);
		const effectiveExpression =
			data.expression != null
				? data.expression
				: data.expression === null || data.operator !== undefined || data.conditions !== undefined
					? null
					: storedExpression;
		const effectiveOperator =
			data.expression != null
				? null
				: data.operator !== undefined
					? data.operator
					: effectiveExpression
						? null
						: existing.operator;
		const representationError = getRecursiveRuleUpdateError(
			data,
			effectiveRuleType,
			effectiveOperator,
			effectiveConditions,
			effectiveExpression,
			storedExpression,
		);
		if (representationError) return reply.status(400).send({ error: representationError });
		const effectiveTargetScope =
			data.targetScope ?? (existing.targetScope === "episode" ? "episode" : "series");
		const effectiveServiceFilter =
			data.serviceFilter !== undefined
				? data.serviceFilter
				: (utilSafeJsonParse(existing.serviceFilter ?? "") as string[] | null);
		const effectivePlexLibraryFilter =
			data.plexLibraryFilter !== undefined
				? data.plexLibraryFilter
				: (utilSafeJsonParse(existing.plexLibraryFilter ?? "") as string[] | null);
		const scopeValidationError = getCleanupRuleScopeValidationError({
			targetScope: effectiveTargetScope,
			serviceFilter: effectiveServiceFilter,
			plexLibraryFilter: effectivePlexLibraryFilter,
			retentionMode: data.retentionMode ?? existing.retentionMode,
			action: data.action ?? existing.action,
			scanMediaServerAfterDelete:
				data.scanMediaServerAfterDelete ?? existing.scanMediaServerAfterDelete,
			ruleType: effectiveRuleType,
			parameters: effectiveParams ?? {},
			operator: effectiveOperator,
			conditions: effectiveConditions ?? null,
			expression: effectiveExpression,
		});
		if (scopeValidationError) {
			return reply.status(400).send({ error: scopeValidationError });
		}
		const requiresRadarrRatings = cleanupRuleRequiresRadarrRatings({
			ruleType: effectiveRuleType,
			parameters: effectiveParams ?? {},
			operator: effectiveOperator,
			conditions: effectiveConditions ?? null,
			expression: effectiveExpression,
		});
		const effectiveInstanceFilter =
			data.instanceFilter !== undefined
				? data.instanceFilter
				: (utilSafeJsonParse(existing.instanceFilter ?? "") as string[] | null);
		const imdbInstanceFilter = requiresRadarrRatings
			? await canonicalizeImdbInstanceFilter(userId, effectiveInstanceFilter)
			: {
					value: data.instanceFilter?.length ? [...new Set(data.instanceFilter)] : null,
					error: null,
				};
		if (imdbInstanceFilter.error) {
			return reply.status(400).send({ error: imdbInstanceFilter.error });
		}
		if (
			data.ruleType !== undefined ||
			data.parameters !== undefined ||
			data.conditions !== undefined ||
			data.expression !== undefined
		) {
			const paramValidationError = validateRuleParameters(
				effectiveRuleType,
				effectiveParams ?? {},
				effectiveConditions ?? null,
				effectiveExpression,
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
		if (data.parameters !== undefined)
			updateData.parameters = JSON.stringify(
				applyRuleParameterDefaults(effectiveRuleType, data.parameters),
			);
		if (requiresRadarrRatings) {
			updateData.serviceFilter = JSON.stringify(["RADARR"]);
		} else if (data.serviceFilter !== undefined) {
			updateData.serviceFilter = data.serviceFilter ? JSON.stringify(data.serviceFilter) : null;
		}
		if (requiresRadarrRatings) {
			updateData.instanceFilter = imdbInstanceFilter.value
				? JSON.stringify(imdbInstanceFilter.value)
				: null;
		} else if (data.instanceFilter !== undefined) {
			updateData.instanceFilter = imdbInstanceFilter.value
				? JSON.stringify(imdbInstanceFilter.value)
				: null;
		}
		if (data.excludeTags !== undefined)
			updateData.excludeTags = data.excludeTags ? JSON.stringify(data.excludeTags) : null;
		if (data.excludeTitles !== undefined)
			updateData.excludeTitles = data.excludeTitles ? JSON.stringify(data.excludeTitles) : null;
		if (data.plexLibraryFilter !== undefined)
			updateData.plexLibraryFilter = data.plexLibraryFilter?.length
				? JSON.stringify(data.plexLibraryFilter)
				: null;
		if (data.targetScope !== undefined) updateData.targetScope = data.targetScope;
		if (data.action !== undefined) updateData.action = data.action;
		if (data.scanMediaServerAfterDelete !== undefined)
			updateData.scanMediaServerAfterDelete = data.scanMediaServerAfterDelete;
		if (data.expression != null) {
			updateData.operator = null;
			updateData.conditions = JSON.stringify(applyExpressionParameterDefaults(data.expression));
		} else if (data.operator !== undefined) {
			updateData.operator = data.operator ?? null;
		}
		if (data.expression == null && data.conditions !== undefined)
			updateData.conditions = data.conditions?.length
				? JSON.stringify(
						data.conditions.map((condition) => ({
							...condition,
							parameters: applyRuleParameterDefaults(condition.ruleType, condition.parameters),
						})),
					)
				: null;
		else if (
			data.expression === null &&
			data.conditions === undefined &&
			data.operator === undefined
		) {
			updateData.conditions = null;
			updateData.operator = null;
		}
		if (data.retentionMode !== undefined) updateData.retentionMode = data.retentionMode;
		if (data.useGlobalRejectionMemory !== undefined)
			updateData.useGlobalRejectionMemory = data.useGlobalRejectionMemory;
		if (data.rejectionMemoryDays !== undefined)
			updateData.rejectionMemoryDays = data.rejectionMemoryDays;

		return await withCleanupPolicyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				const rule = await app.prisma.libraryCleanupRule.update({
					where: { id },
					data: updateData,
				});

				return reply.send(serializeRule(rule as unknown as Record<string, unknown>));
			},
			{ configId: existing.configId },
		);
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

		return await withCleanupPolicyMutationLease(
			{ prisma: app.prisma, log: request.log },
			userId,
			async () => {
				await app.prisma.libraryCleanupRule.delete({ where: { id } });
				return reply.status(204).send();
			},
			{ configId: existing.configId },
		);
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
					{
						prisma: app.prisma,
						arrClientFactory: app.arrClientFactory,
						encryptor: app.encryptor,
						quiClientFactory: (instance) => createQuiClient(app, instance),
						quiFileHashIndexFactory,
						log: request.log,
					},
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
				const selectionCountsComplete =
					result.selectionCountsComplete ?? result.previewSelection?.retryState !== "unavailable";
				const totalPreviewItems =
					result.previewItemCount ??
					Math.max(
						result.itemsFlagged +
							(typeof result.pendingRetryCount === "number" ? result.pendingRetryCount : 0),
						result.details.length,
					);
				const previewDetails = result.details.slice(0, MAX_PREVIEW_ITEMS);
				const hiddenPreviewItems = Math.max(0, totalPreviewItems - previewDetails.length);

				// Cached qUI observation (Phase 3.3). This enrichment is
				// informational only: it must not be presented or consumed as
				// execution authority. Destructive cleanup obtains a complete,
				// fresh qUI view again at the physical-file mutation boundary.
				// Failure is non-fatal and falls back to `no_signal`.
				type CachedQuiObservation = {
					status: "seeding" | "paused_or_error" | "not_in_qui";
					observedAt: Date;
				};
				const quiStatusByKey = new Map<string, CachedQuiObservation>();
				try {
					if (previewDetails.length > 0) {
						const enabledQuiInstance = await app.prisma.serviceInstance.findFirst({
							where: { userId, service: "QUI", enabled: true },
							select: { id: true },
						});
						if (enabledQuiInstance) {
							const quiObservationCutoff = Date.now() - QUI_PREVIEW_CACHE_FRESHNESS_MS;
							const seriesDetails = previewDetails.filter(
								(detail) => detail.targetScope !== "episode",
							);
							const instanceIds = [...new Set(seriesDetails.map((d) => d.instanceId))];
							const itemIds = [...new Set(seriesDetails.map((d) => d.arrItemId))];
							const rows = await app.prisma.libraryCache.findMany({
								where: {
									instance: { userId },
									instanceId: { in: instanceIds },
									arrItemId: { in: itemIds },
								},
								select: {
									instanceId: true,
									arrItemId: true,
									itemType: true,
									infoHash: true,
									torrentState: true,
									torrentSyncedAt: true,
								},
							});
							for (const row of rows) {
								// A fresh timestamp with null state is a durable complete-
								// absence observation. Failed/incomplete scans and qUI
								// topology mutations clear the timestamp as well, so they
								// remain `no_signal`.
								if (
									!row.infoHash ||
									!row.torrentSyncedAt ||
									row.torrentSyncedAt.getTime() < quiObservationCutoff
								) {
									continue;
								}
								const key = `${row.instanceId}|${row.arrItemId}|${row.itemType.toLowerCase()}`;
								let status: "seeding" | "paused_or_error" | "not_in_qui";
								if (row.torrentState === null) {
									status = "not_in_qui";
								} else if (row.torrentState === "seeding") {
									status = "seeding";
								} else if (row.torrentState === "paused" || row.torrentState === "error") {
									status = "paused_or_error";
								} else {
									// downloading/stalled_dl/queued/checking/moving/unknown —
									// no strong cleanup signal either way.
									continue;
								}
								quiStatusByKey.set(key, { status, observedAt: row.torrentSyncedAt });
							}
							const episodeDetails = previewDetails.filter(
								(detail) =>
									detail.targetScope === "episode" && typeof detail.episodeFileId === "number",
							);
							if (episodeDetails.length > 0) {
								const episodeInstanceIds = [
									...new Set(episodeDetails.map((detail) => detail.instanceId)),
								];
								const episodeFileIds = [
									...new Set(
										episodeDetails
											.map((detail) => detail.episodeFileId)
											.filter((id): id is number => typeof id === "number"),
									),
								];
								const episodeRows = await app.prisma.episodeFileCache.findMany({
									where: {
										instance: { userId },
										instanceId: { in: episodeInstanceIds },
										arrEpisodeFileId: { in: episodeFileIds },
									},
									select: {
										instanceId: true,
										arrEpisodeFileId: true,
										infoHash: true,
										torrentState: true,
										torrentSyncedAt: true,
									},
								});
								for (const row of episodeRows) {
									if (
										!row.infoHash ||
										!row.torrentSyncedAt ||
										row.torrentSyncedAt.getTime() < quiObservationCutoff
									) {
										continue;
									}
									const key = `${row.instanceId}|episode-file|${row.arrEpisodeFileId}`;
									if (row.torrentState === null)
										quiStatusByKey.set(key, {
											status: "not_in_qui",
											observedAt: row.torrentSyncedAt,
										});
									else if (row.torrentState === "seeding")
										quiStatusByKey.set(key, {
											status: "seeding",
											observedAt: row.torrentSyncedAt,
										});
									else if (row.torrentState === "paused" || row.torrentState === "error")
										quiStatusByKey.set(key, {
											status: "paused_or_error",
											observedAt: row.torrentSyncedAt,
										});
								}
							}
						}
					}
				} catch (err) {
					// Non-fatal. Surface in logs only; items render with no qui badge.
					request.log.warn(
						{ err },
						"library-cleanup preview: qui-status enrichment failed (continuing without badge)",
					);
				}

				return reply.send({
					totalEvaluated: result.itemsEvaluated,
					totalFlagged: result.itemsFlagged,
					pendingRetryCount: result.pendingRetryCount === undefined ? 0 : result.pendingRetryCount,
					selectionCountsComplete,
					selection: result.previewSelection,
					display: {
						shown: previewDetails.length,
						hidden: hiddenPreviewItems,
						limit: MAX_PREVIEW_ITEMS,
						complete: hiddenPreviewItems === 0,
					},
					items: previewDetails.map((d) => {
						const itemType = d.itemType ?? "movie";
						const key =
							d.targetScope === "episode" && typeof d.episodeFileId === "number"
								? `${d.instanceId}|episode-file|${d.episodeFileId}`
								: `${d.instanceId}|${d.arrItemId}|${itemType.toLowerCase()}`;
						const cachedQuiObservation = quiStatusByKey.get(key);
						return {
							instanceId: d.instanceId,
							instanceLabel: instanceLabelMap.get(d.instanceId) ?? null,
							arrItemId: d.arrItemId,
							itemType,
							targetScope: d.targetScope ?? "series",
							arrEpisodeId: d.arrEpisodeId ?? null,
							seasonNumber: d.seasonNumber ?? null,
							episodeNumber: d.episodeNumber ?? null,
							seriesTitle: d.seriesTitle ?? d.title,
							episodeTitle: d.episodeTitle ?? null,
							title: d.title,
							matchedRuleName: d.rule,
							reason: d.reason,
							action: d.action ?? "delete",
							sizeOnDisk: d.sizeOnDisk ?? "0",
							year: d.year ?? null,
							rating: d.rating ?? null,
							quiStatus: cachedQuiObservation?.status ?? "no_signal",
							quiStatusSource: cachedQuiObservation ? "cached" : null,
							quiStatusObservedAt: cachedQuiObservation?.observedAt.toISOString() ?? null,
							selectionStatus: d.previewDisposition,
							plannedAction: d.plannedAction,
							isRetryAttempt: d.isRetryAttempt,
						};
					}),
					prefetchHealth: result.prefetchHealth,
					warnings: [
						...(result.warnings ?? []),
						...(hiddenPreviewItems > 0
							? [
									selectionCountsComplete
										? `Display capped at ${previewDetails.length} of ${totalPreviewItems} preview items; selection counts remain complete.`
										: `Display capped at ${previewDetails.length} of ${totalPreviewItems} known preview items; retry-backed selection counts are incomplete because durable retry state could not be loaded.`,
								]
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
					{
						prisma: app.prisma,
						arrClientFactory: app.arrClientFactory,
						encryptor: app.encryptor,
						quiClientFactory: (instance) => createQuiClient(app, instance),
						quiFileHashIndexFactory,
						log: request.log,
						auditTrigger: "manual",
						auditActorId: userId,
					},
					userId,
				);

				return reply.send(result);
			} catch (error) {
				if (isCleanupConflict(error)) {
					return reply.status(409).send({ error: error.message });
				}
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
		const presentationNow = new Date();

		const validStatuses = [
			"pending",
			"approved",
			"retry_pending",
			"rejected",
			"expired",
			"executing",
			"retry_executing",
			"executed",
		];
		const rawStatus = (request.query as Record<string, string>).status || "pending";
		const statusFilter = validStatuses.includes(rawStatus) ? rawStatus : "pending";
		const statusWhere =
			statusFilter === "approved"
				? {
						OR: [
							{ status: "approved" },
							{ status: "executed", id: { not: { startsWith: "mutation-intent:" } } },
						],
					}
				: statusFilter === "pending"
					? { status: "pending", expiresAt: { gt: presentationNow } }
					: statusFilter === "expired"
						? {
								OR: [
									{ status: "expired" },
									{ status: "pending", expiresAt: { lte: presentationNow } },
								],
							}
						: { status: statusFilter };

		const [approvals, total] = await Promise.all([
			app.prisma.libraryCleanupApproval.findMany({
				where: {
					config: { userId },
					...statusWhere,
				},
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			app.prisma.libraryCleanupApproval.count({
				where: {
					config: { userId },
					...statusWhere,
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
			items: approvals.map((a) => {
				const presentationExpired =
					a.status === "pending" && a.expiresAt.getTime() <= presentationNow.getTime();
				return {
					...serializeApproval(a as unknown as Record<string, unknown>),
					...(presentationExpired ? { status: "expired" } : {}),
					instanceLabel: instanceLabelMap.get(a.instanceId) ?? null,
				};
			}),
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
			const approvalRequestToken = randomUUID();

			try {
				return await withCleanupOperationGuard(async () => {
					await expirePendingApprovals(userId);
					const reviewedAt = new Date();
					const transition = await app.prisma.libraryCleanupApproval.updateMany({
						where: {
							id,
							config: { userId },
							status: "pending",
							expiresAt: { gt: new Date() },
						},
						data: {
							status: "approved",
							executionToken: approvalRequestToken,
							reviewedAt,
						},
					});
					if (transition.count !== 1) {
						return reply.status(404).send({ error: "Approval not found or not pending" });
					}
					await appendApprovalTransition(
						id,
						userId,
						"approval_approved",
						approvalRequestToken,
						reviewedAt,
					);

					const result = await executeApprovedItems(
						{
							prisma: app.prisma,
							arrClientFactory: app.arrClientFactory,
							encryptor: app.encryptor,
							quiClientFactory: (instance) => createQuiClient(app, instance),
							quiFileHashIndexFactory,
							log: request.log,
							auditTrigger: "approval",
							auditActorId: userId,
						},
						userId,
						[id],
						approvalRequestToken,
					);

					// nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- Fastify JSON response
					return reply.send(result);
				});
			} catch (error) {
				if (isCleanupConflict(error)) {
					return reply.status(409).send({ error: error.message });
				}
				throw error;
			}
		},
	);

	/** POST /api/library-cleanup/approval-queue/:id/retry */
	app.post<{ Params: { id: string } }>(
		"/library-cleanup/approval-queue/:id/retry",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = request.params;

			try {
				const result = await executeRetryItems(
					{
						prisma: app.prisma,
						arrClientFactory: app.arrClientFactory,
						encryptor: app.encryptor,
						quiClientFactory: (instance) => createQuiClient(app, instance),
						quiFileHashIndexFactory,
						log: request.log,
						auditTrigger: "retry",
						auditActorId: userId,
					},
					userId,
					[id],
				);
				return reply.send(result);
			} catch (error) {
				if (isCleanupConflict(error)) {
					return reply.status(409).send({ error: error.message });
				}
				throw error;
			}
		},
	);

	/** POST /api/library-cleanup/approval-queue/:id/reject */
	app.post<{ Params: { id: string } }>(
		"/library-cleanup/approval-queue/:id/reject",
		async (request, reply) => {
			const userId = request.currentUser!.id;
			const { id } = request.params;

			try {
				return await withCleanupOperationGuard(async () => {
					const reviewedAt = new Date();
					const transition = await app.prisma.libraryCleanupApproval.updateMany({
						where: {
							id,
							config: { userId },
							status: "pending",
							expiresAt: { gt: reviewedAt },
						},
						data: { status: "rejected", executionToken: null, reviewedAt },
					});
					if (transition.count !== 1) {
						return reply.status(404).send({ error: "Approval not found or not pending" });
					}
					await appendApprovalTransition(id, userId, "approval_rejected", randomUUID(), reviewedAt);

					return reply.status(204).send();
				});
			} catch (error) {
				if (isCleanupConflict(error)) {
					return reply.status(409).send({ error: error.message });
				}
				throw error;
			}
		},
	);

	/** POST /api/library-cleanup/approval-queue/bulk */
	app.post("/library-cleanup/approval-queue/bulk", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { ids, action } = validateRequest(bulkApprovalSchema, request.body);

		try {
			return await withCleanupOperationGuard(async () => {
				if (action === "rejected") {
					const correlationId = randomUUID();
					const reviewedAt = new Date();
					const result = await app.prisma.libraryCleanupApproval.updateMany({
						where: {
							id: { in: ids },
							config: { userId },
							status: "pending",
							expiresAt: { gt: reviewedAt },
						},
						data: { status: "rejected", executionToken: null, reviewedAt },
					});
					for (const id of ids) {
						await appendApprovalTransition(
							id,
							userId,
							"approval_rejected",
							correlationId,
							reviewedAt,
						);
					}
					return reply.send({ updated: result.count });
				}

				// Approve and execute under one guard so restore cannot observe
				// an intermediate approved state.
				const approvalRequestToken = randomUUID();
				await expirePendingApprovals(userId);
				const reviewedAt = new Date();
				await app.prisma.libraryCleanupApproval.updateMany({
					where: {
						id: { in: ids },
						config: { userId },
						status: "pending",
						expiresAt: { gt: new Date() },
					},
					data: {
						status: "approved",
						executionToken: approvalRequestToken,
						reviewedAt,
					},
				});
				for (const id of ids) {
					await appendApprovalTransition(
						id,
						userId,
						"approval_approved",
						approvalRequestToken,
						reviewedAt,
					);
				}

				const result = await executeApprovedItems(
					{
						prisma: app.prisma,
						arrClientFactory: app.arrClientFactory,
						encryptor: app.encryptor,
						quiClientFactory: (instance) => createQuiClient(app, instance),
						quiFileHashIndexFactory,
						log: request.log,
						auditTrigger: "approval",
						auditActorId: userId,
					},
					userId,
					ids,
					approvalRequestToken,
				);

				return reply.send(result);
			});
		} catch (error) {
			if (isCleanupConflict(error)) {
				return reply.status(409).send({ error: error.message });
			}
			throw error;
		}
	});

	// ─── Logs ─────────────────────────────────────────────────────────

	/** GET /api/library-cleanup/activity
	 *  Per-action append-only timelines. Aggregate run logs remain available
	 *  separately and are intentionally not folded into these timelines.
	 */
	app.get("/library-cleanup/activity", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { page, pageSize } = parsePaginationQuery(request.query as Record<string, string>);
		const offset = (page - 1) * pageSize;
		const [countRow] = await app.prisma.$queryRaw<Array<{ total: bigint | number }>>`
			SELECT COUNT(DISTINCT audit."actionId") AS "total"
			FROM "library_cleanup_audit_events" AS audit
			INNER JOIN "library_cleanup_configs" AS config
				ON config."id" = audit."configId"
			WHERE config."userId" = ${userId}
		`;
		const total = Number(countRow?.total ?? 0);
		const latestActions = await app.prisma.libraryCleanupAuditEvent.groupBy({
			by: ["actionId"],
			where: { config: { userId } },
			_max: { id: true },
			_min: { createdAt: true },
			_count: { _all: true },
			orderBy: { _max: { id: "desc" } },
			skip: offset,
			take: pageSize,
		});
		const actionIds = latestActions.map((row) => row.actionId);
		const eventPages = await Promise.all(
			actionIds.map(async (actionId) => ({
				actionId,
				events: await app.prisma.libraryCleanupAuditEvent.findMany({
					where: { config: { userId }, actionId },
					orderBy: { id: "desc" },
					take: CLEANUP_ACTIVITY_EVENTS_PER_TIMELINE,
				}),
			})),
		);
		const grouped = new Map(
			eventPages.map(({ actionId, events }) => [actionId, [...events].reverse()] as const),
		);
		const eventCounts = new Map(
			latestActions.map((row) => [row.actionId, row._count._all] as const),
		);
		const actionStartedAt = new Map(
			latestActions.map((row) => [row.actionId, row._min.createdAt] as const),
		);

		const timelines = actionIds.flatMap((actionId) => {
			const chronological = grouped.get(actionId);
			if (!chronological || chronological.length === 0) return [];
			const first = chronological[0]!;
			const latest = chronological[chronological.length - 1]!;
			const eventCount = eventCounts.get(actionId) ?? chronological.length;
			return [
				{
					actionId,
					instanceId: first.instanceId,
					arrItemId: first.arrItemId,
					itemType: first.itemType,
					targetScope: first.targetScope === "episode" ? "episode" : "series",
					arrEpisodeId: first.arrEpisodeId,
					title: first.title,
					ruleId: first.ruleId,
					ruleName: first.ruleName,
					action: first.action,
					trigger: latest.trigger,
					latestOutcome: latest.outcome,
					actionableReason: latest.reason,
					startedAt: (actionStartedAt.get(actionId) ?? first.createdAt).toISOString(),
					updatedAt: latest.createdAt.toISOString(),
					eventCount,
					eventsTruncated: eventCount > chronological.length,
					olderEventsCursor:
						eventCount > chronological.length ? chronological[0]!.id.toString() : null,
					events: chronological.map((event) => ({
						id: event.id.toString(),
						actionId: event.actionId,
						correlationId: event.correlationId,
						sequence: event.sequence,
						eventType: event.eventType,
						outcome: event.outcome,
						trigger: event.trigger,
						actorType: event.actorType,
						actorId: event.actorId,
						approvalId: event.approvalId,
						runLogId: event.runLogId,
						reason: event.reason,
						evidence: utilSafeJsonParse(event.evidence) ?? null,
						details: utilSafeJsonParse(event.details) ?? null,
						createdAt: event.createdAt.toISOString(),
					})),
				},
			];
		});
		return reply.send({
			items: timelines,
			total,
			page,
			pageSize,
		});
	});

	/** GET /api/library-cleanup/activity/:actionId/events
	 *  Loads one bounded page immediately older than the supplied durable event
	 *  id. Event ids are unique and monotonically increasing, so the exclusive
	 *  cursor remains stable even when newer audit events are appended.
	 */
	app.get<{
		Params: { actionId: string };
		Querystring: { cursor: string; pageSize?: string };
	}>("/library-cleanup/activity/:actionId/events", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { actionId } = validateRequest(cleanupActivityEventParamsSchema, request.params);
		const { cursor, pageSize } = validateRequest(cleanupActivityEventQuerySchema, request.query);
		const events = await app.prisma.libraryCleanupAuditEvent.findMany({
			where: {
				config: { userId },
				actionId,
				id: { lt: cursor },
			},
			orderBy: { id: "desc" },
			take: pageSize + 1,
		});
		const hasMore = events.length > pageSize;
		const page = hasMore ? events.slice(0, pageSize) : events;
		const chronological = [...page].reverse();

		return reply.send({
			items: chronological.map((event) => ({
				id: event.id.toString(),
				actionId: event.actionId,
				correlationId: event.correlationId,
				sequence: event.sequence,
				eventType: event.eventType,
				outcome: event.outcome,
				trigger: event.trigger,
				actorType: event.actorType,
				actorId: event.actorId,
				approvalId: event.approvalId,
				runLogId: event.runLogId,
				reason: event.reason,
				evidence: utilSafeJsonParse(event.evidence) ?? null,
				details: utilSafeJsonParse(event.details) ?? null,
				createdAt: event.createdAt.toISOString(),
			})),
			olderEventsCursor: hasMore ? (page[page.length - 1]?.id.toString() ?? null) : null,
		});
	});

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
		const { instanceId, arrItemId, arrEpisodeId } = validateRequest(
			cleanupExplainRequestSchema,
			request.body,
		);

		// Verify instance ownership
		const instance = await app.prisma.serviceInstance.findFirst({
			where: { id: instanceId, userId },
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

		let episodeEvidence: EpisodeExplainEvidence | undefined;
		let episodeDisplay:
			| {
					arrEpisodeId: number;
					seasonNumber: number;
					episodeNumber: number;
					episodeTitle: string | null;
			  }
			| undefined;
		if (arrEpisodeId !== undefined) {
			if (instance.service !== "SONARR") {
				return reply
					.status(400)
					.send({ error: "Episode explanations are only available for Sonarr instances" });
			}

			const sonarr = app.arrClientFactory.createSonarrClient(instance);
			const episodes = (await sonarr.episode.getAll({
				seriesId: arrItemId,
				includeEpisodeFile: true,
			})) as Array<Record<string, unknown>>;
			const episode = episodes.find((candidate) => candidate.id === arrEpisodeId);
			const seasonNumber = episode?.seasonNumber;
			const episodeNumber = episode?.episodeNumber;
			if (
				!episode ||
				typeof seasonNumber !== "number" ||
				!Number.isSafeInteger(seasonNumber) ||
				seasonNumber < 0 ||
				typeof episodeNumber !== "number" ||
				!Number.isSafeInteger(episodeNumber) ||
				episodeNumber <= 0
			) {
				return reply
					.status(404)
					.send({ error: "Episode not found in the requested Sonarr series" });
			}

			const tmdbId = extractSeriesTmdbId(cacheItem.data);
			let watchCount: number | null = null;
			if (tmdbId !== null) {
				const instances = await app.prisma.serviceInstance.findMany({
					where: { userId, enabled: true },
				});
				const watchMap = await prefetchFreshPlexEpisodeWatchData(
					{ prisma: app.prisma, arrClientFactory: app.arrClientFactory, log: request.log },
					instances,
					new Date(),
					[],
					{
						includeUnwatched: true,
						coordinate: { showTmdbId: tmdbId, seasonNumber, episodeNumber },
					},
				);
				const watchEvidence = watchMap.get(
					episodeCoordinateKey(tmdbId, seasonNumber, episodeNumber),
				)?.[0];
				watchCount = watchEvidence?.watchCount ?? null;
				episodeEvidence = {
					arrEpisodeId,
					watchCount,
					available: watchEvidence !== undefined,
				};
			}
			episodeEvidence ??= { arrEpisodeId, watchCount, available: false };
			episodeDisplay = {
				arrEpisodeId,
				seasonNumber,
				episodeNumber,
				episodeTitle:
					typeof episode.title === "string" && episode.title.trim().length > 0
						? episode.title
						: null,
			};
		}

		const explainedItem = {
			title: cacheItem.title,
			year: cacheItem.year,
			instanceId,
			itemType: episodeDisplay ? "episode" : cacheItem.itemType,
			targetScope: episodeDisplay ? ("episode" as const) : ("series" as const),
			...episodeDisplay,
		};

		// Load config + rules
		const config = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
		});
		if (!config || config.rules.length === 0) {
			return reply.send({
				item: explainedItem,
				results: [],
				retentionProtected: false,
			});
		}

		// Build a fully-populated eval context with prefetched external data
		const { ctx, failedSources } = await buildEvalContextWithHealth(
			{
				prisma: app.prisma,
				arrClientFactory: app.arrClientFactory,
				encryptor: app.encryptor,
				traktClientId: process.env.TRAKT_CLIENT_ID ?? null,
				log: request.log,
			},
			userId,
			config.rules.filter((rule) => rule.targetScope !== "episode"),
		);

		const results = explainItemAgainstRules(
			cacheItem as unknown as CacheItemForEval,
			config.rules,
			instance.service,
			ctx,
			episodeEvidence,
			failedSources,
		);

		// Determine if any retention rule matched
		const retentionProtected = results.some(
			(result) =>
				result.retentionMode && (result.matched || result.filteredBy === "evidence_unavailable"),
		);

		return reply.send({
			item: explainedItem,
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

function applyRuleParameterDefaults(
	ruleType: string,
	parameters: Record<string, unknown>,
): Record<string, unknown> {
	const schema = ruleParamSchemaMap[ruleType];
	if (!schema) return parameters;
	const parsed = schema.safeParse(parameters);
	return parsed.success ? (parsed.data as Record<string, unknown>) : parameters;
}

function applyExpressionParameterDefaults(
	expression: VersionedCleanupRuleExpression,
): VersionedCleanupRuleExpression {
	const cloneNode = (node: CleanupRuleExpression): CleanupRuleExpression => {
		if (node.type === "condition") {
			return {
				...node,
				parameters: applyRuleParameterDefaults(node.ruleType, node.parameters),
			};
		}
		if (node.type === "group") {
			return { ...node, children: node.children.map(cloneNode) };
		}
		return { ...node, child: cloneNode(node.child) };
	};
	return { ...expression, root: cloneNode(expression.root) };
}

/**
 * Validate rule parameters against the type-specific Zod schema.
 * Also validates parameters within composite rule conditions.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateRuleParameters(
	ruleType: string,
	parameters: Record<string, unknown>,
	conditions: Array<{ ruleType: string; parameters: Record<string, unknown> }> | null,
	expression: VersionedCleanupRuleExpression | null,
): string | null {
	if (expression) {
		const stack: Array<{ node: CleanupRuleExpression; path: string }> = [
			{ node: expression.root, path: "root" },
		];
		while (stack.length > 0) {
			const { node, path } = stack.pop()!;
			if (node.type === "condition") {
				const schema = ruleParamSchemaMap[node.ruleType];
				if (!schema) continue;
				const result = schema.safeParse(node.parameters);
				if (!result.success) {
					const flat = result.error.flatten();
					const msgs =
						Object.values(flat.fieldErrors).flat().join(", ") || flat.formErrors.join(", ");
					return `Invalid parameters for expression.${path} (${node.ruleType}): ${msgs}`;
				}
			} else if (node.type === "group") {
				for (let i = node.children.length - 1; i >= 0; i--) {
					stack.push({ node: node.children[i]!, path: `${path}.children[${i}]` });
				}
			} else {
				stack.push({ node: node.child, path: `${path}.child` });
			}
		}
		return null;
	}

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
