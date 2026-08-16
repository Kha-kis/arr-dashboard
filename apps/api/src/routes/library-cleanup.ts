/**
 * Library Cleanup API Routes
 *
 * CRUD for cleanup config, rules, approval queue, preview, execution, and logs.
 */

import { randomUUID } from "node:crypto";
import {
	bulkApprovalSchema,
	cleanupExplainRequestSchema,
	createCleanupRuleSchema,
	getCleanupRuleScopeValidationError,
	isKindLegalForContext,
	reorderRulesSchema,
	ruleParamSchemaMap,
	updateCleanupConfigSchema,
	updateCleanupRuleSchema,
} from "@arr/shared";
import type { FastifyPluginCallback } from "fastify";
import { z } from "zod";
import { assertCompleteCacheRefresh } from "../lib/cache-refresh-status.js";
import {
	appendCleanupAuditEvent,
	createCleanupAuditEventKey,
	createCleanupTerminalAuditState,
} from "../lib/library-cleanup/cleanup-audit.js";
import {
	buildEvalContext,
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
	evaluateEpisodeWatchCountRule,
	isSupportedEpisodeCleanupRule,
} from "../lib/library-cleanup/episode-scope.js";
import { getFilterReason } from "../lib/library-cleanup/rule-evaluators.js";
import type { CacheItemForEval, CleanupExecutorDeps } from "../lib/library-cleanup/types.js";
import type { PrismaClient } from "../lib/prisma.js";
import {
	buildFreshCompleteFileIdIndex,
	getAllHashesForFileIdComplete,
} from "../lib/library-sync/infohash-backfill-by-inode.js";
import {
	createOwnedJellyfinPublicationSnapshot,
	refreshJellyfinCache,
} from "../lib/jellyfin/jellyfin-cache-refresher.js";
import {
	createOwnedPlexPublicationSnapshot,
	refreshPlexCache,
} from "../lib/plex/plex-cache-refresher.js";
import { createQuiClient } from "../lib/qui/client-factory.js";
import { explainItemAgainstRulesViaEngine } from "../lib/rules/cleanup-adapter.js";
import { getErrorMessage } from "../lib/utils/error-message.js";
import { safeJsonParse as utilSafeJsonParse } from "../lib/utils/json.js";
import { parsePaginationQuery } from "../lib/utils/pagination.js";
import { validateRequest } from "../lib/utils/validate.js";

// Rate limits
const PREVIEW_RATE_LIMIT = { max: 5, timeWindow: "1 minute" };
const EXECUTE_RATE_LIMIT = { max: 3, timeWindow: "1 minute" };

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
		targetScope: rule.targetScope === "episode" ? "episode" : "series",
		action: (rule.action as string) ?? "delete",
		operator: (rule.operator as string) ?? null,
		conditions: safeJsonParse(rule.conditions as string | null),
		retentionMode: rule.retentionMode ?? false,
		useGlobalRejectionMemory: rule.useGlobalRejectionMemory ?? true,
		rejectionMemoryDays: rule.rejectionMemoryDays ?? null,
		createdAt: (rule.createdAt as Date).toISOString(),
		updatedAt: (rule.updatedAt as Date).toISOString(),
	};
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

type CleanupAuditRouteRow = {
	eventOrder: number;
	actionId: string;
	correlationId: string;
	actionSequence: number;
	actorType: string;
	actorId: string | null;
	eventType: string;
	trigger: string;
	targetKind: string;
	targetId: string | null;
	targetInstanceId: string | null;
	targetItemType: string | null;
	targetArrItemId: number | null;
	targetArrEpisodeId: number | null;
	targetScope: string | null;
	title: string | null;
	ruleId: string | null;
	ruleName: string | null;
	action: string | null;
	reason: string | null;
	outcome: string;
	evidence: string;
	details: string | null;
	createdAt: Date;
};

function parseAuditMetadata(value: string | null): Record<string, unknown> | null {
	const parsed = safeJsonParse(value);
	return parsed && typeof parsed === "object" && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: null;
}

function serializeCleanupAuditEvent(event: CleanupAuditRouteRow) {
	return {
		id: String(event.eventOrder),
		actionId: event.actionId,
		correlationId: event.correlationId,
		sequence: event.actionSequence,
		eventType: event.eventType,
		outcome: event.outcome,
		trigger: event.trigger,
		actorType: event.actorType,
		actorId: event.actorId,
		approvalId: event.targetKind === "approval" ? event.targetId : null,
		runLogId: event.targetKind === "cleanup_run" ? event.targetId : null,
		reason: event.reason ?? event.eventType.replaceAll("_", " "),
		evidence: parseAuditMetadata(event.evidence),
		details: parseAuditMetadata(event.details),
		createdAt: event.createdAt.toISOString(),
	};
}

type ApprovalReviewDecision = "approved" | "rejected";

function cleanupApprovalAuditTitle(approval: {
	title: string;
	targetScope: string;
	seasonNumber: number | null;
	episodeNumber: number | null;
	episodeTitle: string | null;
}): string {
	if (
		approval.targetScope !== "episode" ||
		approval.seasonNumber === null ||
		approval.episodeNumber === null
	) {
		return approval.title;
	}
	const coordinates = `S${String(approval.seasonNumber).padStart(2, "0")}E${String(approval.episodeNumber).padStart(2, "0")}`;
	return `${approval.title} ${coordinates}${approval.episodeTitle ? ` · ${approval.episodeTitle}` : ""}`;
}

async function recordApprovalReview(
	prisma: Pick<
		PrismaClient,
		"libraryCleanupApproval" | "libraryCleanupAuditEvent" | "libraryCleanupConfig"
	>,
	input: {
		userId: string;
		approvalId: string;
		decision: ApprovalReviewDecision;
		correlationId: string;
		reviewedAt: Date;
		executionToken?: string;
	},
): Promise<void> {
	const approval = await prisma.libraryCleanupApproval.findFirst({
		where: {
			id: input.approvalId,
			config: { userId: input.userId },
			status: input.decision,
			reviewedAt: input.reviewedAt,
			...(input.executionToken === undefined ? {} : { executionToken: input.executionToken }),
		},
		select: {
			id: true,
			configId: true,
			instanceId: true,
			arrItemId: true,
			arrEpisodeId: true,
			itemType: true,
			targetScope: true,
			seasonNumber: true,
			episodeNumber: true,
			episodeTitle: true,
			title: true,
			matchedRuleId: true,
			matchedRuleName: true,
			action: true,
		},
	});
	if (!approval || (approval.itemType !== "movie" && approval.itemType !== "series")) {
		throw new Error("Cleanup approval review transition changed before its audit was recorded");
	}
	const action: "delete" | "delete_files" | "unmonitor" | undefined =
		approval.action === "delete" ||
		approval.action === "unmonitor" ||
		approval.action === "delete_files"
			? approval.action
			: undefined;

	const eventType = "approval_reviewed" as const;
	const event = {
		userId: input.userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({
			actionId: approval.id,
			correlationId: input.correlationId,
			eventType,
		}),
		actionId: approval.id,
		correlationId: input.correlationId,
		actorType: "operator",
		actorId: input.userId,
		eventType,
		trigger: "approval",
		target: {
			kind: "approval",
			id: approval.id,
			instanceId: approval.instanceId,
			itemType: approval.itemType,
			arrItemId: approval.arrItemId,
			targetScope: approval.targetScope === "episode" ? "episode" : "series",
			...(approval.targetScope === "episode" && approval.arrEpisodeId !== null
				? { arrEpisodeId: approval.arrEpisodeId }
				: {}),
		},
		summary: {
			title: cleanupApprovalAuditTitle(approval),
			ruleId: approval.matchedRuleId,
			ruleName: approval.matchedRuleName,
			...(action === undefined ? {} : { action }),
			reason:
				input.decision === "approved" ? "Approved by the operator" : "Rejected by the operator",
		},
		outcome: input.decision === "approved" ? "info" : "blocked",
		evidence: { decision: input.decision },
	} as const;
	await appendCleanupAuditEvent(prisma, event);
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
	actionId: z.string().min(1).max(256),
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
	const quiFileHashIndexFactory = async (instance: Parameters<typeof createQuiClient>[1]) => {
		const client = createQuiClient(app, instance);
		const index = await buildFreshCompleteFileIdIndex(client, instance, app.log);
		return {
			resolve: (path: string) => getAllHashesForFileIdComplete(path, index),
		};
	};
	const externalRuleCacheRefresher: CleanupExecutorDeps["externalRuleCacheRefresher"] = async (
		source,
		instance,
		context,
	) => {
		const result =
			source === "plex"
				? await refreshPlexCache({
						prisma: app.prisma,
						instance: createOwnedPlexPublicationSnapshot(app.encryptor, instance),
						log: app.log,
						cleanupRunClaimToken: context?.cleanupRunClaimToken,
					})
				: await refreshJellyfinCache({
						prisma: app.prisma,
						instance: createOwnedJellyfinPublicationSnapshot(app.encryptor, instance),
						log: app.log,
						cleanupRunClaimToken: context?.cleanupRunClaimToken,
					});
		assertCompleteCacheRefresh(source, result);
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
		// applied to prefetchPlexData / prefetchJellyfinData.
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
			plexUsers: sorted(plexUsers),
			plexLibraries: sorted(plexLibraries),
			plexCollections: sorted(plexCollections),
			plexLabels: sorted(plexLabels),
			jellyfinUsers: sorted(jellyfinUsers),
			jellyfinLibraries: sorted(jellyfinLibraries),
			arrTags,
			hasPlex: plexInstances.length > 0,
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

		// Write-time parameter validation: validate params against type-specific schema
		const paramValidationError = validateRuleParameters(
			data.ruleType,
			data.parameters,
			data.conditions ?? null,
		);
		if (paramValidationError) {
			return reply.status(400).send({ error: paramValidationError });
		}
		const scopeValidationError = getCleanupRuleScopeValidationError(data);
		if (scopeValidationError) {
			return reply.status(400).send({ error: scopeValidationError });
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
						parameters: JSON.stringify(data.parameters),
						serviceFilter: data.serviceFilter ? JSON.stringify(data.serviceFilter) : null,
						instanceFilter: data.instanceFilter ? JSON.stringify(data.instanceFilter) : null,
						excludeTags: data.excludeTags ? JSON.stringify(data.excludeTags) : null,
						excludeTitles: data.excludeTitles ? JSON.stringify(data.excludeTitles) : null,
						plexLibraryFilter: data.plexLibraryFilter?.length
							? JSON.stringify(data.plexLibraryFilter)
							: null,
						targetScope: data.targetScope ?? "series",
						action: data.action ?? "delete",
						operator: data.operator ?? null,
						conditions: data.conditions ? JSON.stringify(data.conditions) : null,
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
		const rawBody = request.body;
		const hasSuppliedField = (field: string) =>
			typeof rawBody === "object" && rawBody !== null && Object.hasOwn(rawBody, field);

		// Verify ownership
		const existing = await app.prisma.libraryCleanupRule.findFirst({
			where: { id, config: { userId } },
		});
		if (!existing) {
			return reply.status(404).send({ error: "Rule not found" });
		}

		// Write-time parameter validation (when ruleType or parameters are changed)
		const effectiveRuleType = hasSuppliedField("ruleType") ? data.ruleType! : existing.ruleType;
		const effectiveParams = hasSuppliedField("parameters")
			? data.parameters!
			: (utilSafeJsonParse(existing.parameters) as Record<string, unknown>);
		const effectiveConditions = hasSuppliedField("conditions")
			? (data.conditions ?? null)
			: (utilSafeJsonParse(existing.conditions ?? "") as Array<{
					ruleType: string;
					parameters: Record<string, unknown>;
				}> | null);
		const effectiveTargetScope = hasSuppliedField("targetScope")
			? data.targetScope
			: existing.targetScope === "episode"
				? "episode"
				: "series";
		const effectiveServiceFilter = hasSuppliedField("serviceFilter")
			? (data.serviceFilter ?? null)
			: (utilSafeJsonParse(existing.serviceFilter ?? "") as string[] | null);
		const effectivePlexLibraryFilter = hasSuppliedField("plexLibraryFilter")
			? (data.plexLibraryFilter ?? null)
			: (utilSafeJsonParse(existing.plexLibraryFilter ?? "") as string[] | null);
		const scopeValidationError = getCleanupRuleScopeValidationError({
			targetScope: effectiveTargetScope,
			serviceFilter: effectiveServiceFilter,
			plexLibraryFilter: effectivePlexLibraryFilter,
			retentionMode: hasSuppliedField("retentionMode")
				? data.retentionMode
				: existing.retentionMode,
			ruleType: effectiveRuleType,
			parameters: effectiveParams ?? {},
			operator: hasSuppliedField("operator") ? data.operator : existing.operator,
			conditions: effectiveConditions ?? null,
		});
		if (scopeValidationError) {
			return reply.status(400).send({ error: scopeValidationError });
		}
		if (
			hasSuppliedField("ruleType") ||
			hasSuppliedField("parameters") ||
			hasSuppliedField("conditions")
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
		if (hasSuppliedField("name")) updateData.name = data.name;
		if (hasSuppliedField("enabled")) updateData.enabled = data.enabled;
		if (hasSuppliedField("priority")) updateData.priority = data.priority;
		if (hasSuppliedField("ruleType")) updateData.ruleType = data.ruleType;
		if (hasSuppliedField("parameters")) updateData.parameters = JSON.stringify(data.parameters);
		if (hasSuppliedField("serviceFilter"))
			updateData.serviceFilter = data.serviceFilter ? JSON.stringify(data.serviceFilter) : null;
		if (hasSuppliedField("instanceFilter"))
			updateData.instanceFilter = data.instanceFilter ? JSON.stringify(data.instanceFilter) : null;
		if (hasSuppliedField("excludeTags"))
			updateData.excludeTags = data.excludeTags ? JSON.stringify(data.excludeTags) : null;
		if (hasSuppliedField("excludeTitles"))
			updateData.excludeTitles = data.excludeTitles ? JSON.stringify(data.excludeTitles) : null;
		if (hasSuppliedField("plexLibraryFilter"))
			updateData.plexLibraryFilter = data.plexLibraryFilter?.length
				? JSON.stringify(data.plexLibraryFilter)
				: null;
		if (hasSuppliedField("targetScope")) updateData.targetScope = data.targetScope;
		if (hasSuppliedField("action")) updateData.action = data.action;
		if (hasSuppliedField("operator")) updateData.operator = data.operator ?? null;
		if (hasSuppliedField("conditions"))
			updateData.conditions = data.conditions?.length ? JSON.stringify(data.conditions) : null;
		if (hasSuppliedField("retentionMode")) updateData.retentionMode = data.retentionMode;
		if (hasSuppliedField("useGlobalRejectionMemory"))
			updateData.useGlobalRejectionMemory = data.useGlobalRejectionMemory;
		if (hasSuppliedField("rejectionMemoryDays"))
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
						externalRuleCacheRefresher,
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

				// qui-derived safety hint (Phase 3.3). Single bulk query joins
				// LibraryCache for every previewed item so operators see
				// "qui says: safe to delete" / "still seeding" inline. Failure
				// of this enrichment is non-fatal — items fall back to
				// `no_signal` (renders no badge).
				const quiStatusByKey = new Map<string, "seeding" | "paused_or_error" | "not_in_qui">();
				try {
					if (previewDetails.length > 0) {
						const seriesDetails = previewDetails.filter(
							(detail) => detail.targetScope !== "episode",
						);
						if (seriesDetails.length > 0) {
							const rows = await app.prisma.libraryCache.findMany({
								where: {
									instance: { userId },
									instanceId: {
										in: [...new Set(seriesDetails.map((detail) => detail.instanceId))],
									},
									arrItemId: { in: [...new Set(seriesDetails.map((detail) => detail.arrItemId))] },
								},
								select: {
									instanceId: true,
									arrItemId: true,
									itemType: true,
									infoHash: true,
									torrentState: true,
								},
							});
							for (const row of rows) {
								if (!row.infoHash) continue;
								const key = `${row.instanceId}|${row.arrItemId}|${row.itemType.toLowerCase()}`;
								if (!row.torrentState) quiStatusByKey.set(key, "not_in_qui");
								else if (row.torrentState === "seeding") quiStatusByKey.set(key, "seeding");
								else if (row.torrentState === "paused" || row.torrentState === "error")
									quiStatusByKey.set(key, "paused_or_error");
							}
						}
						const episodeDetails = previewDetails.filter(
							(detail) =>
								detail.targetScope === "episode" && typeof detail.episodeFileId === "number",
						);
						if (episodeDetails.length > 0) {
							const episodeRows = await app.prisma.episodeFileCache.findMany({
								where: {
									instance: { userId },
									instanceId: {
										in: [...new Set(episodeDetails.map((detail) => detail.instanceId))],
									},
									arrEpisodeFileId: {
										in: episodeDetails
											.map((detail) => detail.episodeFileId)
											.filter((id): id is number => typeof id === "number"),
									},
								},
								select: {
									instanceId: true,
									arrEpisodeFileId: true,
									infoHash: true,
									torrentState: true,
								},
							});
							for (const row of episodeRows) {
								if (!row.infoHash) continue;
								const key = `${row.instanceId}|episode-file|${row.arrEpisodeFileId}`;
								if (!row.torrentState) quiStatusByKey.set(key, "not_in_qui");
								else if (row.torrentState === "seeding") quiStatusByKey.set(key, "seeding");
								else if (row.torrentState === "paused" || row.torrentState === "error")
									quiStatusByKey.set(key, "paused_or_error");
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
							quiStatus: quiStatusByKey.get(key) ?? "no_signal",
						};
					}),
					prefetchHealth: result.prefetchHealth,
					providerEvidence: result.providerEvidence,
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
						externalRuleCacheRefresher,
						log: request.log,
					},
					userId,
					{ actorId: userId, actorType: "operator", trigger: "manual" },
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
				: { status: statusFilter };
		const pendingFreshnessWhere =
			statusFilter === "pending" ? { expiresAt: { gt: new Date() } } : {};

		const [approvals, total] = await Promise.all([
			app.prisma.libraryCleanupApproval.findMany({
				where: {
					config: { userId },
					...statusWhere,
					...pendingFreshnessWhere,
				},
				orderBy: { createdAt: "desc" },
				skip: (page - 1) * pageSize,
				take: pageSize,
			}),
			app.prisma.libraryCleanupApproval.count({
				where: {
					config: { userId },
					...statusWhere,
					...pendingFreshnessWhere,
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
			const approvalRequestToken = randomUUID();
			const reviewedAt = new Date();

			try {
				return await withCleanupOperationGuard(async () => {
					const transitioned = await app.prisma.$transaction(async (tx) => {
						const transition = await tx.libraryCleanupApproval.updateMany({
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
						if (transition.count !== 1) return false;
						await recordApprovalReview(tx, {
							userId,
							approvalId: id,
							decision: "approved",
							correlationId: approvalRequestToken,
							reviewedAt,
							executionToken: approvalRequestToken,
						});
						return true;
					});
					if (!transitioned) {
						return reply.status(404).send({ error: "Approval not found or not pending" });
					}

					const result = await executeApprovedItems(
						{
							prisma: app.prisma,
							arrClientFactory: app.arrClientFactory,
							encryptor: app.encryptor,
							quiClientFactory: (instance) => createQuiClient(app, instance),
							quiFileHashIndexFactory,
							externalRuleCacheRefresher,
							log: request.log,
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
						externalRuleCacheRefresher,
						log: request.log,
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
			const reviewCorrelationId = randomUUID();
			const reviewedAt = new Date();
			const rejectedTerminalState = createCleanupTerminalAuditState({
				correlationId: reviewCorrelationId,
				actorType: "operator",
				actorId: userId,
				eventType: "approval_reviewed",
				trigger: "approval",
				outcome: "blocked",
				summary: { reason: "Rejected by the operator" },
			});

			try {
				return await withCleanupOperationGuard(async () => {
					const transitioned = await app.prisma.$transaction(async (tx) => {
						const transition = await tx.libraryCleanupApproval.updateMany({
							where: { id, config: { userId }, status: "pending" },
							data: {
								status: "rejected",
								executionToken: null,
								reviewedAt,
								...rejectedTerminalState,
								terminalAuditRecordedAt: reviewedAt,
							},
						});
						if (transition.count !== 1) return false;
						await recordApprovalReview(tx, {
							userId,
							approvalId: id,
							decision: "rejected",
							correlationId: reviewCorrelationId,
							reviewedAt,
						});
						return true;
					});
					if (!transitioned) {
						return reply.status(404).send({ error: "Approval not found or not pending" });
					}

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
					const reviewCorrelationId = randomUUID();
					const reviewedAt = new Date();
					const rejectedTerminalState = createCleanupTerminalAuditState({
						correlationId: reviewCorrelationId,
						actorType: "operator",
						actorId: userId,
						eventType: "approval_reviewed",
						trigger: "approval",
						outcome: "blocked",
						summary: { reason: "Rejected by the operator" },
					});
					const updated = await app.prisma.$transaction(async (tx) => {
						const candidates = await tx.libraryCleanupApproval.findMany({
							where: { id: { in: ids }, config: { userId }, status: "pending" },
							select: { id: true },
						});
						if (candidates.length === 0) return 0;
						const candidateIds = candidates.map((candidate) => candidate.id);
						const result = await tx.libraryCleanupApproval.updateMany({
							where: { id: { in: candidateIds }, config: { userId }, status: "pending" },
							data: {
								status: "rejected",
								executionToken: null,
								reviewedAt,
								...rejectedTerminalState,
								terminalAuditRecordedAt: reviewedAt,
							},
						});
						if (result.count !== candidateIds.length) {
							throw new Error("Cleanup bulk rejection ownership changed");
						}
						for (const approvalId of candidateIds) {
							await recordApprovalReview(tx, {
								userId,
								approvalId,
								decision: "rejected",
								correlationId: reviewCorrelationId,
								reviewedAt,
							});
						}
						return result.count;
					});
					return reply.send({ updated });
				}

				// Approve and execute under one guard so restore cannot observe
				// an intermediate approved state.
				const approvalRequestToken = randomUUID();
				const reviewedAt = new Date();
				const approvedIds = await app.prisma.$transaction(async (tx) => {
					const candidates = await tx.libraryCleanupApproval.findMany({
						where: {
							id: { in: ids },
							config: { userId },
							status: "pending",
							expiresAt: { gt: new Date() },
						},
						select: { id: true },
					});
					const candidateIds = candidates.map((candidate) => candidate.id);
					if (candidateIds.length === 0) return [];
					const result = await tx.libraryCleanupApproval.updateMany({
						where: { id: { in: candidateIds }, config: { userId }, status: "pending" },
						data: {
							status: "approved",
							executionToken: approvalRequestToken,
							reviewedAt,
						},
					});
					if (result.count !== candidateIds.length) {
						throw new Error("Cleanup bulk approval ownership changed");
					}
					for (const approvalId of candidateIds) {
						await recordApprovalReview(tx, {
							userId,
							approvalId,
							decision: "approved",
							correlationId: approvalRequestToken,
							reviewedAt,
							executionToken: approvalRequestToken,
						});
					}
					return candidateIds;
				});

				const result = await executeApprovedItems(
					{
						prisma: app.prisma,
						arrClientFactory: app.arrClientFactory,
						encryptor: app.encryptor,
						quiClientFactory: (instance) => createQuiClient(app, instance),
						quiFileHashIndexFactory,
						externalRuleCacheRefresher,
						log: request.log,
					},
					userId,
					approvedIds,
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
	 *  Bounded per-action append-only timelines. Aggregate run logs remain
	 *  available separately and are intentionally not folded into this feed.
	 */
	app.get("/library-cleanup/activity", async (request, reply) => {
		const userId = request.currentUser!.id;
		const { page, pageSize, skip } = parsePaginationQuery(request.query as Record<string, string>);
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
			_max: { eventOrder: true },
			_min: { createdAt: true },
			_count: { _all: true },
			orderBy: { _max: { eventOrder: "desc" } },
			skip,
			take: pageSize,
		});
		const actionIds = latestActions.map((row) => row.actionId);
		const eventPages = await Promise.all(
			latestActions.map(async (action) => ({
				actionId: action.actionId,
				events: await app.prisma.libraryCleanupAuditEvent.findMany({
					where: {
						config: { userId },
						actionId: action.actionId,
						...(action._max.eventOrder === null
							? {}
							: { eventOrder: { lte: action._max.eventOrder } }),
					},
					orderBy: { eventOrder: "desc" },
					take: CLEANUP_ACTIVITY_EVENTS_PER_TIMELINE,
				}),
			})),
		);
		const eventsByAction = new Map(
			eventPages.map(({ actionId, events }) => [actionId, [...events].reverse()] as const),
		);
		const actionMetadata = new Map(
			latestActions.map((row) => [
				row.actionId,
				{ count: row._count._all, startedAt: row._min.createdAt },
			]),
		);

		const timelines = actionIds.flatMap((actionId) => {
			const chronological = eventsByAction.get(actionId);
			if (!chronological || chronological.length === 0) return [];
			const first = chronological[0]!;
			const latest = chronological[chronological.length - 1]!;
			const metadata = actionMetadata.get(actionId);
			const eventCount = metadata?.count ?? chronological.length;
			return [
				{
					actionId,
					instanceId: first.targetInstanceId ?? "",
					arrItemId: first.targetArrItemId ?? 0,
					itemType: first.targetItemType ?? "series",
					targetScope: first.targetScope === "episode" ? "episode" : "series",
					arrEpisodeId: first.targetArrEpisodeId,
					title: first.title ?? "Cleanup action",
					ruleId: first.ruleId,
					ruleName: first.ruleName,
					action: first.action ?? "delete",
					trigger: latest.trigger,
					latestOutcome: latest.outcome,
					actionableReason:
						latest.reason ?? first.reason ?? "No additional cleanup details were recorded.",
					startedAt: (metadata?.startedAt ?? first.createdAt).toISOString(),
					updatedAt: latest.createdAt.toISOString(),
					eventCount,
					eventsTruncated: eventCount > chronological.length,
					olderEventsCursor:
						eventCount > chronological.length ? String(chronological[0]!.eventOrder) : null,
					events: chronological.map(serializeCleanupAuditEvent),
				},
			];
		});

		return reply.send({ items: timelines, total, page, pageSize });
	});

	/** GET /api/library-cleanup/activity/:actionId/events
	 *  Loads a bounded page immediately older than a durable database-order
	 *  cursor. Newer appends cannot shift or duplicate this page.
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
				eventOrder: { lt: cursor },
			},
			orderBy: { eventOrder: "desc" },
			take: pageSize + 1,
		});
		const hasMore = events.length > pageSize;
		const boundedPage = hasMore ? events.slice(0, pageSize) : events;
		const chronological = [...boundedPage].reverse();
		const oldestReturned = boundedPage.at(-1);

		return reply.send({
			items: chronological.map(serializeCleanupAuditEvent),
			olderEventsCursor: hasMore && oldestReturned ? String(oldestReturned.eventOrder) : null,
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
			select: {
				id: true,
				service: true,
				baseUrl: true,
				encryptedApiKey: true,
				encryptionIv: true,
				encryptedHttpAuthCredentials: true,
				httpAuthEncryptionIv: true,
			},
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

		let episodeItem:
			| {
					targetScope: "episode";
					arrEpisodeId: number;
					seasonNumber: number;
					episodeNumber: number;
					episodeFileId: number;
					episodeTitle: string | null;
			  }
			| undefined;
		let episodeWatchEvidence: Array<{ watchCount: number }> = [];
		if (arrEpisodeId !== undefined) {
			if (instance.service !== "SONARR") {
				return reply
					.status(400)
					.send({ error: "Episode explanations are supported for Sonarr only" });
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
				return reply.status(404).send({ error: "Episode not found for this series" });
			}
			const episodeFileId = episode.episodeFileId;
			if (
				typeof episodeFileId !== "number" ||
				!Number.isSafeInteger(episodeFileId) ||
				episodeFileId <= 0
			) {
				return reply.status(404).send({ error: "Episode file not found for this episode" });
			}

			const tmdbId = extractSeriesTmdbId(cacheItem.data);
			if (tmdbId !== null) {
				const instances = await app.prisma.serviceInstance.findMany({ where: { userId } });
				const warnings: string[] = [];
				const watchMap = await prefetchFreshPlexEpisodeWatchData(
					{
						prisma: app.prisma,
						arrClientFactory: app.arrClientFactory,
						quiClientFactory: (candidate) => createQuiClient(app, candidate),
						quiFileHashIndexFactory,
						log: request.log,
					},
					instances,
					new Date(),
					warnings,
				);
				episodeWatchEvidence =
					watchMap.get(episodeCoordinateKey(tmdbId, seasonNumber, episodeNumber)) ?? [];
			}
			episodeItem = {
				targetScope: "episode",
				arrEpisodeId,
				seasonNumber,
				episodeNumber,
				episodeFileId,
				episodeTitle:
					typeof episode.title === "string" && episode.title.trim().length > 0
						? episode.title
						: null,
			};
		}

		const responseItem = {
			title: cacheItem.title,
			year: cacheItem.year,
			instanceId,
			itemType: episodeItem ? "episode" : cacheItem.itemType,
			targetScope: "series" as const,
			...(episodeItem ?? {}),
		};

		// Load config + rules
		const config = await app.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
		});
		if (!config || config.rules.length === 0) {
			return reply.send({
				item: responseItem,
				results: [],
				retentionProtected: false,
			});
		}
		if (episodeItem) {
			const parentRetentionRules = config.rules.filter(
				(rule) => rule.targetScope !== "episode" && rule.retentionMode,
			);
			const parentRetentionResults = new Map<
				string,
				ReturnType<typeof explainItemAgainstRulesViaEngine>[number]
			>();
			if (parentRetentionRules.length > 0) {
				const ctx = await buildEvalContext(
					{
						prisma: app.prisma,
						arrClientFactory: app.arrClientFactory,
						quiClientFactory: (candidate) => createQuiClient(app, candidate),
						quiFileHashIndexFactory,
						log: request.log,
					},
					userId,
					parentRetentionRules,
				);
				for (const result of explainItemAgainstRulesViaEngine(
					cacheItem as unknown as CacheItemForEval,
					parentRetentionRules,
					instance.service,
					ctx,
				)) {
					parentRetentionResults.set(result.ruleId, result);
				}
			}
			const results = config.rules.map((rule) => {
				if (!rule.enabled) {
					return {
						ruleId: rule.id,
						ruleName: rule.name,
						matched: false,
						reason: null,
						filteredBy: "disabled" as const,
						retentionMode: rule.retentionMode,
					};
				}
				if (rule.targetScope !== "episode") {
					if (rule.retentionMode) {
						return parentRetentionResults.get(rule.id)!;
					}
					return {
						ruleId: rule.id,
						ruleName: rule.name,
						matched: false,
						reason: null,
						filteredBy: "scope_filter" as const,
						retentionMode: rule.retentionMode,
					};
				}
				if (!isSupportedEpisodeCleanupRule(rule)) {
					return {
						ruleId: rule.id,
						ruleName: rule.name,
						matched: false,
						reason: null,
						filteredBy: "unsupported_rule" as const,
						retentionMode: rule.retentionMode,
					};
				}
				const filteredBy = getFilterReason(
					cacheItem as unknown as CacheItemForEval,
					rule,
					instance.service,
				);
				if (filteredBy) {
					return {
						ruleId: rule.id,
						ruleName: rule.name,
						matched: false,
						reason: null,
						filteredBy,
						retentionMode: rule.retentionMode,
					};
				}
				if (episodeWatchEvidence.length === 0) {
					return {
						ruleId: rule.id,
						ruleName: rule.name,
						matched: false,
						reason: null,
						filteredBy: "evidence_unavailable" as const,
						retentionMode: rule.retentionMode,
					};
				}
				const match = episodeWatchEvidence
					.map((evidence) => evaluateEpisodeWatchCountRule(evidence, rule))
					.find((candidate) => candidate !== null);
				return {
					ruleId: rule.id,
					ruleName: rule.name,
					matched: match !== undefined,
					reason: match?.reason ?? null,
					filteredBy: null,
					retentionMode: rule.retentionMode,
				};
			});
			const retentionProtected = results.some((result) => result.retentionMode && result.matched);
			return reply.send({ item: responseItem, results, retentionProtected });
		}

		// Build a fully-populated eval context with prefetched external data
		const ctx = await buildEvalContext(
			{
				prisma: app.prisma,
				arrClientFactory: app.arrClientFactory,
				quiClientFactory: (candidate) => createQuiClient(app, candidate),
				quiFileHashIndexFactory,
				log: request.log,
			},
			userId,
			config.rules,
		);

		const results = explainItemAgainstRulesViaEngine(
			cacheItem as unknown as CacheItemForEval,
			config.rules,
			instance.service,
			ctx,
		);

		// Determine if any retention rule matched
		const retentionProtected = results.some((r) => r.retentionMode && r.matched);

		return reply.send({
			item: responseItem,
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
	// Reject mode-mismatch: a leaf ruleType carrying operator+conditions
	// (or ruleType "composite" without them). The evaluator treats any rule
	// with operator+conditions as composite regardless of ruleType, so a
	// mixed shape would validate one thing and evaluate another (the same
	// guard auto-tag.ts has carried; ported per review finding).
	const compositeByShape = conditions != null && conditions.length > 0;
	const compositeByRuleType = ruleType === "composite";
	if (compositeByShape !== compositeByRuleType) {
		return compositeByShape
			? 'Composite rules must use ruleType="composite" (got a leaf rule type plus conditions — pick one mode)'
			: 'Rule type "composite" requires operator + conditions';
	}

	// For composite rules, validate each condition's parameters
	if (ruleType === "composite" && conditions) {
		for (let i = 0; i < conditions.length; i++) {
			const cond = conditions[i]!;
			// Tier-1 strict kind legality (unified-rule-grammar §2.2): new
			// writes cannot author retired/unknown kinds. Stored legacy rows
			// are unaffected — this runs only when the payload carries
			// ruleType/parameters/conditions.
			if (!isKindLegalForContext("library-cleanup", cond.ruleType)) {
				return `Unknown rule type for condition[${i}]: "${cond.ruleType}"`;
			}
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

	// For single rules, validate top-level parameters (tier-1 strict
	// kind legality — see composite branch note)
	if (!isKindLegalForContext("library-cleanup", ruleType)) {
		return `Unknown rule type "${ruleType}"`;
	}
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
