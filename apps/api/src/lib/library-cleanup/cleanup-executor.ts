/**
 * Library Cleanup Executor
 *
 * Orchestrates cleanup evaluation and execution:
 * 1. Loads config + rules for the user
 * 2. Queries LibraryCache items (operating on cached data, not live API)
 * 3. Evaluates each item against rules (first match wins)
 * 4. Either flags items for approval or removes them directly
 *
 * Supports three actions per rule: delete, unmonitor, delete_files.
 */

import { createHash, randomUUID } from "node:crypto";
import {
	type CrossDomainRuleScope,
	crossDomainActionsSchema,
	crossDomainRuleScopeSchema,
	type DataSourceDependency,
	groupChildren,
	isKindLegalForContext,
	isRulePredicate,
	type RuleDocument,
	type RuleNode,
	ruleDataSourceMap,
	ruleDocumentSchema,
	ruleParamSchemaMap,
	validateV1Depth,
	walkPredicates,
} from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { Prisma } from "../../generated/prisma/client.js";
import { isNotFoundError } from "../arr/client-factory.js";
import { buildMovieFile } from "../library/movie-normalizer.js";
import { plexConnectionFingerprint } from "../plex/service-instance-fingerprint.js";
import type { LibraryCleanupConfig, LibraryCleanupRule, ServiceInstance } from "../prisma.js";
import {
	evaluateItemAgainstRulesViaEngine,
	evaluateRuleViaEngine,
} from "../rules/cleanup-adapter.js";
import { SeerrClient } from "../seerr/seerr-client.js";
import { getErrorMessage } from "../utils/error-message.js";
import { safeJsonParse } from "../utils/json.js";
import { withCleanupOperationGuard } from "./cleanup-maintenance-gate.js";
import {
	type EpisodeCleanupCandidate,
	type EpisodePlexWatchEvidence,
	evaluateEpisodeWatchCountRule,
	isSupportedEpisodeCleanupRule,
	toEpisodeTargetMetadata,
} from "./episode-scope.js";
import { applyQuiSeedingFilter, isQuiSeedingState } from "./qui-filter.js";
import {
	evaluateSingleCondition,
	extractRating,
	parseAudioChannels,
	passesCleanupRuleFilters,
	passesInstanceFilter,
	passesServiceFilter,
	passesTagExclusion,
	passesTitleExclusion,
	ruleUsesUnavailableData,
} from "./rule-evaluators.js";
import {
	ArrCrossInstanceOwnershipChangedDuringSafetyCheckError,
	ArrFileChangedDuringSafetyCheckError,
	ArrMutationAuthorityChangedDuringSafetyCheckError,
	ArrTargetChangedDuringSafetyCheckError,
	assertVerifiedArrTargetUnchanged,
	assertVerifiedRadarrEmptyUnchanged,
	assertVerifiedRadarrFileUnchanged,
	assertVerifiedRadarrPeerOwnershipRetained,
	assertVerifiedSonarrFilesUnchanged,
	assertVerifiedSonarrPeerOwnershipRetained,
	buildCacheTargetSafetyPlan,
	buildRadarrCacheSafetyPlan,
	buildSonarrCacheSafetyPlan,
	type CleanupDeleteTarget,
	cleanupDeleteTargetKey,
	createArrServiceFingerprint,
	createSharedPlexSafetyContext,
	type ExecutableSharedMediaSafetyPlan,
	executableSafetyPlansEqual,
	findSharedPlexDeleteBlocks,
	parseExecutableSafetyPlan,
	radarrCachedFileIdentityMatches,
	RadarrFileChangedDuringSafetyCheckError,
	type SharedMediaSafetyPlan,
	SonarrFilesChangedDuringSafetyCheckError,
	serializeExecutableSafetyPlan,
	type VerifiedRadarrFileIdentity,
	type VerifiedSonarrFileIdentity,
} from "./shared-plex-safety.js";
import type {
	CacheItemForEval,
	CleanupExecutorDeps,
	CleanupRunResult,
	DetailAction,
	EvalContext,
	FlaggedItem,
	JellyfinWatchMap,
	PlexEpisodeMap,
	PlexSectionWatchInfo,
	PlexWatchMap,
	PrefetchResults,
	RuleAction,
	SeerrRequestInfo,
	SeerrRequestMap,
} from "./types.js";

// Default approval expiry: 7 days
const APPROVAL_EXPIRY_DAYS = 7;

// Batch size for LibraryCache queries
const CACHE_QUERY_BATCH_SIZE = 500;

// The route returns at most 200 preview rows; avoid live safety I/O for rows
// the caller cannot inspect.
const PREVIEW_SAFETY_INSPECTION_LIMIT = 200;

// Circuit breaker: abort after N consecutive ARR API failures
const CIRCUIT_BREAKER_THRESHOLD = 3;

export const CLEANUP_RUN_LEASE_MS = 2 * 60 * 60 * 1000;
const CLEANUP_RUN_HEARTBEAT_MS = 60 * 1000;

export const INTERRUPTED_CLEANUP_RECOVERY_MESSAGE =
	"Recovered after an interrupted cleanup. Review and approve again to reconcile the verified ARR state.";

export class CleanupRunAlreadyInProgressError extends Error {
	constructor() {
		super("A cleanup operation is already in progress");
		this.name = "CleanupRunAlreadyInProgressError";
	}
}

export class CleanupRunLeaseLostError extends Error {
	constructor() {
		super("The cleanup run lost its database execution lease");
		this.name = "CleanupRunLeaseLostError";
	}
}

export class CleanupTopologyMutationConflictError extends Error {
	readonly statusCode = 409;

	constructor() {
		super("Service instances cannot be changed while a library cleanup operation is in progress");
		this.name = "CleanupTopologyMutationConflictError";
	}
}

export class CleanupPolicyMutationConflictError extends Error {
	readonly statusCode = 409;

	constructor() {
		super("Library cleanup settings cannot be changed while a cleanup operation is in progress");
		this.name = "CleanupPolicyMutationConflictError";
	}
}

class CleanupExemptionAuthorityError extends Error {
	constructor() {
		super("Skipped for safety: current deployed cleanup exemption policy covers this ARR target.");
		this.name = "CleanupExemptionAuthorityError";
	}
}

export async function acquireCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	now: Date = new Date(),
	runClaimToken: string = randomUUID(),
): Promise<string | null> {
	const claim = await prisma.libraryCleanupConfig.updateMany({
		where: {
			id: configId,
			userId,
			OR: [
				{ runClaimToken: null },
				{ runClaimedAt: null },
				{ runClaimedAt: { lt: new Date(now.getTime() - CLEANUP_RUN_LEASE_MS) } },
			],
		},
		data: { runClaimToken, runClaimedAt: now },
	});
	return claim.count === 1 ? runClaimToken : null;
}

export async function releaseCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	runClaimToken: string,
): Promise<boolean> {
	const release = await prisma.libraryCleanupConfig.updateMany({
		where: { id: configId, userId, runClaimToken },
		data: { runClaimToken: null, runClaimedAt: null },
	});
	return release.count === 1;
}

export async function renewCleanupRunLease(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	configId: string,
	runClaimToken: string,
	now: Date = new Date(),
): Promise<boolean> {
	const renewal = await prisma.libraryCleanupConfig.updateMany({
		where: { id: configId, userId, runClaimToken },
		data: { runClaimedAt: now },
	});
	return renewal.count === 1;
}

async function withCleanupMutationLease<T>(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	mutate: () => Promise<T>,
	conflictError: () => Error,
	options: { configId?: string; leaseRowMayBeDeleted?: boolean } = {},
): Promise<T> {
	return await withCleanupOperationGuard(async () => {
		const { prisma, log } = deps;
		// Ensure the per-user coordination row exists when the caller does not
		// already have its ID. This closes the initialization race between a
		// cleanup-sensitive write and the first cleanup run.
		const config = options.configId
			? { id: options.configId }
			: await prisma.libraryCleanupConfig.upsert({
					where: { userId },
					update: {},
					create: { userId },
					select: { id: true },
				});
		const runClaimToken = await acquireCleanupRunLease(prisma, userId, config.id);
		if (!runClaimToken) throw conflictError();

		try {
			return await mutate();
		} finally {
			await releaseCleanupRunLease(prisma, userId, config.id, runClaimToken)
				.then((released) => {
					if (!released && !options.leaseRowMayBeDeleted) {
						log.warn(
							{ configId: config.id },
							"Service topology mutation finished after its cleanup lease ownership changed",
						);
					}
				})
				.catch((error) => {
					log.error(
						{ err: error, configId: config.id },
						"Service topology mutation finished but its cleanup lease could not be released",
					);
				});
		}
	});
}

export async function withCleanupTopologyMutationLease<T>(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	mutate: () => Promise<T>,
	options: { leaseRowMayBeDeleted?: boolean } = {},
): Promise<T> {
	return await withCleanupMutationLease(
		deps,
		userId,
		mutate,
		() => new CleanupTopologyMutationConflictError(),
		options,
	);
}

export async function withCleanupPolicyMutationLease<T>(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	mutate: () => Promise<T>,
	options: { configId?: string } = {},
): Promise<T> {
	return await withCleanupMutationLease(
		deps,
		userId,
		mutate,
		() => new CleanupPolicyMutationConflictError(),
		options,
	);
}

async function startCleanupRunLease(
	deps: CleanupExecutorDeps,
	userId: string,
	configId: string,
): Promise<{
	assertOwnership: () => Promise<void>;
	release: () => Promise<void>;
}> {
	const { prisma, log } = deps;
	const runClaimToken = await acquireCleanupRunLease(prisma, userId, configId);
	if (!runClaimToken) throw new CleanupRunAlreadyInProgressError();

	let runLeaseLost = false;
	const assertOwnership = async () => {
		if (runLeaseLost) throw new CleanupRunLeaseLostError();
		try {
			if (!(await renewCleanupRunLease(prisma, userId, configId, runClaimToken))) {
				runLeaseLost = true;
				throw new CleanupRunLeaseLostError();
			}
		} catch (error) {
			runLeaseLost = true;
			if (error instanceof CleanupRunLeaseLostError) throw error;
			log.error({ err: error, configId }, "Library cleanup could not renew its database run lease");
			throw new CleanupRunLeaseLostError();
		}
	};
	const heartbeat = setInterval(() => {
		assertOwnership().catch((error) => {
			log.error(
				{ err: error, configId },
				"Library cleanup database run lease heartbeat failed; mutations will stop",
			);
		});
	}, CLEANUP_RUN_HEARTBEAT_MS);
	heartbeat.unref();

	return {
		assertOwnership,
		release: async () => {
			clearInterval(heartbeat);
			await releaseCleanupRunLease(prisma, userId, configId, runClaimToken)
				.then((released) => {
					if (!released) {
						log.warn(
							{ configId },
							"Library cleanup finished after its database run lease ownership changed",
						);
					}
				})
				.catch((error) => {
					log.error(
						{ err: error, configId },
						"Library cleanup finished but its database run lease could not be released",
					);
				});
		},
	};
}

class ArrDeletePartialError extends Error {
	readonly service: "RADARR" | "SONARR";
	readonly deletedFileIds: number[];
	readonly hasRemainingFiles: boolean;
	readonly remainingSize: number;

	constructor(options: {
		cause: unknown;
		service: "RADARR" | "SONARR";
		deletedFileIds: number[];
		hasRemainingFiles?: boolean;
		remainingSize?: number;
		message?: string;
	}) {
		super(
			options.message ??
				`Partial cleanup: the verified ${options.service === "RADARR" ? "Radarr movie file" : "Sonarr episode files"} were deleted, but the ${options.service === "RADARR" ? "movie" : "series"} record could not be removed safely. No different file was deleted; review the ARR instance before retrying.`,
			options,
		);
		this.service = options.service;
		this.deletedFileIds = options.deletedFileIds;
		this.remainingSize = options.remainingSize ?? 0;
		this.hasRemainingFiles = options.hasRemainingFiles ?? this.remainingSize > 0;
	}
}

class CleanupApprovalOwnershipLostError extends Error {
	constructor() {
		super("Cleanup approval mutation ownership changed");
		this.name = "CleanupApprovalOwnershipLostError";
	}
}

async function updateClaimedCleanupApproval(
	prisma: CleanupExecutorDeps["prisma"],
	userId: string,
	approvalId: string,
	executeStatus: "executing" | "retry_executing",
	executionToken: string,
	data: Prisma.LibraryCleanupApprovalUpdateManyMutationInput,
): Promise<void> {
	const update = await prisma.libraryCleanupApproval.updateMany({
		where: {
			id: approvalId,
			config: { userId },
			status: executeStatus,
			executionToken,
		},
		data,
	});
	if (update.count !== 1) throw new CleanupApprovalOwnershipLostError();
}

function buildPostPartialRetrySnapshot(
	safetyPlan: SharedMediaSafetyPlan | undefined,
	error: ArrDeletePartialError,
): string | undefined {
	if (error.hasRemainingFiles || error.deletedFileIds.length === 0) return undefined;

	if (error.service === "RADARR") {
		if (
			safetyPlan?.kind !== "verified_radarr" ||
			error.deletedFileIds.length !== 1 ||
			error.deletedFileIds[0] !== safetyPlan.file.movieFileId
		) {
			return undefined;
		}
		return serializeExecutableSafetyPlan(safetyPlan);
	}

	if (safetyPlan?.kind !== "verified_sonarr") return undefined;
	const expectedFileIds = new Set(safetyPlan.files.episodeFiles.map((file) => file.episodeFileId));
	const deletedFileIds = new Set(error.deletedFileIds);
	if (
		expectedFileIds.size !== deletedFileIds.size ||
		deletedFileIds.size !== error.deletedFileIds.length ||
		[...deletedFileIds].some((fileId) => !expectedFileIds.has(fileId))
	) {
		return undefined;
	}
	return serializeExecutableSafetyPlan({
		...safetyPlan,
		files: {
			seriesPath: safetyPlan.files.seriesPath,
			episodeFiles: [],
		},
	});
}

function verifiedTargetsEqual(
	left: ExecutableSharedMediaSafetyPlan["target"],
	right: ExecutableSharedMediaSafetyPlan["target"],
): boolean {
	return executableSafetyPlansEqual(
		{ kind: "verified_arr_target", target: left },
		{ kind: "verified_arr_target", target: right },
	);
}

/**
 * A persisted mutation may have removed some or all of its verified files
 * before the process exited. Recovery may continue only when the live plan is
 * the same ARR target and every remaining file is an unchanged member of the
 * originally authorized set. New or replaced files always fail closed.
 */
function isVerifiedFileRemainder(
	approvedPlan: ExecutableSharedMediaSafetyPlan,
	livePlan: ExecutableSharedMediaSafetyPlan,
): boolean {
	if (!verifiedTargetsEqual(approvedPlan.target, livePlan.target)) return false;

	if (approvedPlan.kind === "verified_radarr") {
		return (
			livePlan.kind === "verified_radarr_empty" ||
			(livePlan.kind === "verified_radarr" && executableSafetyPlansEqual(approvedPlan, livePlan))
		);
	}

	if (approvedPlan.kind !== "verified_sonarr" || livePlan.kind !== "verified_sonarr") {
		return false;
	}
	if (approvedPlan.files.seriesPath.value !== livePlan.files.seriesPath.value) return false;

	const approvedFiles = new Map(
		approvedPlan.files.episodeFiles.map((file) => [file.episodeFileId, JSON.stringify(file)]),
	);
	return livePlan.files.episodeFiles.every(
		(file) => approvedFiles.get(file.episodeFileId) === JSON.stringify(file),
	);
}

function isRecordedRadarrFilelessRetry(
	action: RuleAction,
	approvedPlan: ExecutableSharedMediaSafetyPlan,
	livePlan: ExecutableSharedMediaSafetyPlan,
	lastExecutionError: string | null,
): boolean {
	return (
		action === "delete" &&
		approvedPlan.kind === "verified_radarr" &&
		livePlan.kind === "verified_radarr_empty" &&
		lastExecutionError?.startsWith("Partial cleanup: the verified Radarr movie file") === true
	);
}

function hasVerifiedSonarrOwnershipProof(
	action: string,
	plan: ExecutableSharedMediaSafetyPlan | null,
): plan is Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }> {
	return (
		action === "delete" &&
		plan?.kind === "verified_sonarr" &&
		plan.peerInventoryComplete === true &&
		plan.ownership.length > 0
	);
}

const SHARED_PLEX_WARNING =
	"Some deletions were safety-blocked because a connected media server could mutate a shared library and its live state was unsafe or could not be verified. Review each skipped-item reason before changing the ARR or media-server setup.";

// ============================================================================
// Detail Builder Helper
// ============================================================================

/** Build a detail entry for the cleanup run log. Ensures ruleId + itemType are always present. */
/**
 * Resolved rejection-memory window for a single rule (issue #474).
 * - `off`     → no memory, current pre-#474 behavior (rejected items re-proposed next run)
 * - `days`    → remember rejection for N days, then re-propose
 * - `forever` → remember indefinitely (never re-propose until manually cleared)
 */
export type RejectionMemoryWindow =
	| { mode: "off" }
	| { mode: "days"; days: number }
	| { mode: "forever" };

/**
 * Resolve the effective rejection-memory window for a rule, honoring per-rule
 * override when present. Semantics for the underlying days field:
 *   0    = off
 *   N>0  = remember for N days
 *   null = remember forever
 *
 * Per-rule override takes precedence over the config-level default when
 * `useGlobalRejectionMemory` is false.
 */
export function resolveRejectionMemoryWindow(
	rule: Pick<LibraryCleanupRule, "useGlobalRejectionMemory" | "rejectionMemoryDays">,
	config: Pick<LibraryCleanupConfig, "rejectionMemoryDays">,
): RejectionMemoryWindow {
	const effectiveDays = rule.useGlobalRejectionMemory
		? config.rejectionMemoryDays
		: rule.rejectionMemoryDays;
	if (effectiveDays === null) return { mode: "forever" };
	if (effectiveDays === 0) return { mode: "off" };
	return { mode: "days", days: effectiveDays };
}

/**
 * Build the Prisma `OR` clauses for the cleanup-approval dedup query
 * (issue #474). Always returns the `pending` skip; additionally appends a
 * `rejected`-skip clause when the memory window is non-off. Exported and
 * `now`-parameterised so unit tests can pin the cutoff math without
 * monkey-patching Date.now.
 */
export function buildDedupOrClauses(
	memWindow: RejectionMemoryWindow,
	now: Date = new Date(),
): Prisma.LibraryCleanupApprovalWhereInput[] {
	const clauses: Prisma.LibraryCleanupApprovalWhereInput[] = [{ status: "pending" }];
	if (memWindow.mode === "forever") {
		clauses.push({ status: "rejected" });
	} else if (memWindow.mode === "days") {
		const cutoff = new Date(now.getTime() - memWindow.days * 24 * 60 * 60 * 1000);
		clauses.push({ status: "rejected", reviewedAt: { gt: cutoff } });
	}
	return clauses;
}

function buildDetail(
	item: FlaggedItem,
	action: DetailAction,
	reasonOverride?: string,
): CleanupRunResult["details"][number] {
	return {
		instanceId: item.cacheItem.instanceId,
		arrItemId: item.cacheItem.arrItemId,
		title: item.cacheItem.title,
		seriesTitle: item.episodeTarget?.seriesTitle,
		episodeTitle: item.episodeTarget?.episodeTitle,
		ruleId: item.match.ruleId,
		rule: item.match.ruleName,
		reason: reasonOverride ?? item.match.reason,
		action,
		itemType: item.cacheItem.itemType,
		targetScope: item.episodeTarget ? "episode" : "series",
		arrEpisodeId: item.episodeTarget?.arrEpisodeId,
		seasonNumber: item.episodeTarget?.seasonNumber,
		episodeNumber: item.episodeTarget?.episodeNumber,
		episodeFileId: item.episodeTarget?.episodeFileId,
		sizeOnDisk: item.cacheItem.sizeOnDisk.toString(),
		year: item.cacheItem.year,
		rating: null,
	};
}

function buildRetryDetail(
	approval: {
		instanceId: string;
		arrItemId: number;
		itemType: string;
		title: string;
		matchedRuleId: string;
		matchedRuleName: string;
		reason: string;
		sizeOnDisk: bigint;
		year: number | null;
	},
	action: DetailAction,
	reasonOverride?: string,
): CleanupRunResult["details"][number] {
	return {
		instanceId: approval.instanceId,
		arrItemId: approval.arrItemId,
		title: approval.title,
		ruleId: approval.matchedRuleId,
		rule: approval.matchedRuleName,
		reason: reasonOverride ?? approval.reason,
		action,
		itemType: approval.itemType,
		sizeOnDisk: approval.sizeOnDisk.toString(),
		year: approval.year,
		rating: null,
	};
}

function toDeleteTargets(items: FlaggedItem[]): CleanupDeleteTarget[] {
	// Task 5 owns destructive episode authority. Until then, episode candidates
	// remain preview-only and cannot enter the legacy series safety/mutation path.
	return items
		.filter((item) => !item.episodeTarget)
		.map((item) => ({
			instanceId: item.cacheItem.instanceId,
			arrItemId: item.cacheItem.arrItemId,
			itemType: item.cacheItem.itemType,
			action: item.match.action,
		}));
}

export function selectInspectableCleanupPreviewItems(
	flagged: FlaggedItem[],
	limit = PREVIEW_SAFETY_INSPECTION_LIMIT,
): FlaggedItem[] {
	return flagged.slice(0, Math.max(0, Math.min(PREVIEW_SAFETY_INSPECTION_LIMIT, limit)));
}

function asExecutableSafetyPlan(
	plan: SharedMediaSafetyPlan | undefined,
): ExecutableSharedMediaSafetyPlan | null {
	if (
		plan?.kind === "verified_arr_target" ||
		plan?.kind === "verified_radarr" ||
		plan?.kind === "verified_radarr_empty" ||
		plan?.kind === "verified_sonarr"
	) {
		return plan;
	}
	return null;
}

async function loadCurrentMutationInstance(
	deps: CleanupExecutorDeps,
	userId: string,
	instanceId: string,
	safetyPlan: SharedMediaSafetyPlan,
): Promise<ServiceInstance> {
	const executablePlan = asExecutableSafetyPlan(safetyPlan);
	const instances = await deps.prisma.serviceInstance.findMany({
		where: {
			userId,
			service: { in: ["RADARR", "SONARR"] },
		},
	});
	const instance = instances.find((candidate) => candidate.id === instanceId);
	if (
		instance?.enabled !== true ||
		(instance.service !== "RADARR" && instance.service !== "SONARR") ||
		!executablePlan ||
		createArrServiceFingerprint(instance) !== executablePlan.target.serviceFingerprint
	) {
		throw new ArrTargetChangedDuringSafetyCheckError();
	}
	const verifiedFileCount =
		executablePlan.kind === "verified_radarr"
			? 1
			: executablePlan.kind === "verified_sonarr"
				? executablePlan.files.episodeFiles.length
				: 0;
	if (executablePlan.kind === "verified_radarr") {
		const currentPeers = instances.filter(
			(candidate) => candidate.id !== instance.id && candidate.service === "RADARR",
		);
		const verifiedPeers = new Map(
			executablePlan.peers.map((peer) => [peer.instanceId, peer.serviceFingerprint]),
		);
		if (
			executablePlan.peerInventoryComplete !== true ||
			currentPeers.length !== verifiedPeers.size ||
			currentPeers.some((peer) => verifiedPeers.get(peer.id) !== createArrServiceFingerprint(peer))
		) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
		}
	}
	if (
		verifiedFileCount > 0 &&
		executablePlan.kind !== "verified_radarr" &&
		!(executablePlan.kind === "verified_sonarr" && executablePlan.peers.length > 0) &&
		instances.some(
			(candidate) => candidate.id !== instance.id && candidate.service === instance.service,
		)
	) {
		throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError(instance.service);
	}
	return instance;
}

async function persistAndClaimDirectMutationIntent(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig,
	userId: string,
	item: FlaggedItem,
	safetyPlan: SharedMediaSafetyPlan,
): Promise<{ id: string; claimed: boolean; executionToken: string }> {
	const executablePlan = asExecutableSafetyPlan(safetyPlan);
	if (!executablePlan) {
		throw new Error("No executable cleanup safety plan was available for the mutation intent");
	}
	const retryEventFingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				serializeExecutableSafetyPlan(executablePlan),
				item.cacheItem.cachedAt?.toISOString() ?? null,
				item.match.action,
			]),
		)
		.digest("hex")
		.slice(0, 32);
	const intentId = [
		"mutation-intent",
		config.id,
		item.cacheItem.instanceId,
		item.cacheItem.arrItemId,
		item.cacheItem.itemType,
		retryEventFingerprint,
	].join(":");
	const now = new Date();
	const executionToken = randomUUID();

	try {
		await deps.prisma.libraryCleanupApproval.create({
			data: {
				id: intentId,
				configId: config.id,
				instanceId: item.cacheItem.instanceId,
				arrItemId: item.cacheItem.arrItemId,
				itemType: item.cacheItem.itemType,
				title: item.cacheItem.title,
				matchedRuleId: item.match.ruleId,
				matchedRuleName: item.match.ruleName,
				reason: item.match.reason,
				action: item.match.action,
				sizeOnDisk: item.cacheItem.sizeOnDisk,
				year: item.cacheItem.year,
				rating: item.rating,
				status: "retry_pending",
				safetySnapshot: serializeExecutableSafetyPlan(executablePlan),
				lastExecutionError: null,
				expiresAt: new Date(now.getTime() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
			},
		});
	} catch (error) {
		if ((error as { code?: string }).code !== "P2002") throw error;
	}

	const claim = await deps.prisma.libraryCleanupApproval.updateMany({
		where: {
			id: intentId,
			config: { userId },
			status: "retry_pending",
		},
		data: { status: "retry_executing", reviewedAt: now, executionToken },
	});
	return { id: intentId, claimed: claim.count === 1, executionToken };
}

async function buildEvaluatedCacheSafetyPlan(
	prisma: CleanupExecutorDeps["prisma"],
	item: CacheItemForEval,
	livePlan: ExecutableSharedMediaSafetyPlan,
): Promise<ExecutableSharedMediaSafetyPlan | null> {
	const data = safeJsonParse(item.data);
	if (!data || typeof data !== "object") return null;
	const source =
		"_arrDashboardSource" in data &&
		(data as Record<string, unknown>)._arrDashboardSource &&
		typeof (data as Record<string, unknown>)._arrDashboardSource === "object"
			? ((data as Record<string, unknown>)._arrDashboardSource as Record<string, unknown>)
			: undefined;
	if (source?.serviceFingerprint !== livePlan.target.serviceFingerprint) return null;
	if (livePlan.kind === "verified_arr_target") {
		if (item.itemType !== "movie" && item.itemType !== "series") return null;
		return buildCacheTargetSafetyPlan(data, item.itemType, livePlan.target);
	}
	if (livePlan.kind === "verified_radarr" || livePlan.kind === "verified_radarr_empty") {
		return buildRadarrCacheSafetyPlan(data, item.hasFile, livePlan.target);
	}
	const seriesPath =
		data && typeof data === "object" && "path" in data
			? (data as Record<string, unknown>).path
			: undefined;
	const remoteIds =
		data &&
		typeof data === "object" &&
		"remoteIds" in data &&
		(data as Record<string, unknown>).remoteIds &&
		typeof (data as Record<string, unknown>).remoteIds === "object"
			? ((data as Record<string, unknown>).remoteIds as Record<string, unknown>)
			: undefined;
	const tvdbId = remoteIds?.tvdbId;
	const episodeFiles = await prisma.episodeFileCache.findMany({
		where: { instanceId: item.instanceId, arrSeriesId: item.arrItemId },
		select: { arrEpisodeFileId: true, path: true, size: true },
	});
	const cachePlan = buildSonarrCacheSafetyPlan(
		seriesPath,
		tvdbId,
		item.hasFile,
		episodeFiles,
		livePlan.target,
	);
	return cachePlan?.kind === "verified_sonarr"
		? {
				...cachePlan,
				peers: livePlan.peers,
				peerInventoryComplete: livePlan.peerInventoryComplete,
				ownership: livePlan.ownership,
				targetDeleteNotifications: livePlan.targetDeleteNotifications,
			}
		: cachePlan;
}

async function blockPlansThatDifferFromEvaluatedCache(
	deps: CleanupExecutorDeps,
	userId: string,
	items: FlaggedItem[],
	context: ReturnType<typeof createSharedPlexSafetyContext>,
	blocks: Map<string, string>,
): Promise<void> {
	const instanceIds = [...new Set(items.map((item) => item.cacheItem.instanceId))];
	const instances =
		instanceIds.length === 0
			? []
			: await deps.prisma.serviceInstance.findMany({
					where: { id: { in: instanceIds }, userId },
					select: { id: true, updatedAt: true },
				});
	const instanceUpdatedAt = new Map(instances.map((instance) => [instance.id, instance.updatedAt]));

	for (const item of items) {
		const targetKey = cleanupDeleteTargetKey(item.cacheItem);
		if (blocks.has(targetKey)) continue;
		const livePlan = asExecutableSafetyPlan(context.plans.get(targetKey));
		if (!livePlan) continue;
		let cachePlan: ExecutableSharedMediaSafetyPlan | null = null;
		let cacheEvaluationLoaded = false;
		try {
			const serviceUpdatedAt = instanceUpdatedAt.get(item.cacheItem.instanceId);
			if (
				!item.cacheItem.cachedAt ||
				!serviceUpdatedAt ||
				item.cacheItem.cachedAt < serviceUpdatedAt
			) {
				throw new Error("Cached ARR item predates the current service configuration");
			}
			cachePlan = await buildEvaluatedCacheSafetyPlan(deps.prisma, item.cacheItem, livePlan);
			cacheEvaluationLoaded = true;
		} catch (error) {
			deps.log.warn(
				{
					err: getErrorMessage(error),
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
				},
				"Cleanup could not load the cached file identity used for rule evaluation",
			);
		}
		const cacheData = safeJsonParse(item.cacheItem.data);
		if (
			livePlan.kind === "verified_radarr" &&
			cacheEvaluationLoaded &&
			cachePlan === null &&
			cacheData !== null &&
			typeof cacheData === "object" &&
			cacheRadarrEvaluationMatchesLiveProof(
				cacheData as Record<string, unknown>,
				item.cacheItem.hasFile,
				livePlan,
			)
		) {
			continue;
		}
		if (cachePlan && executableSafetyPlansEqual(cachePlan, livePlan)) continue;

		const reason =
			"Skipped for safety: the live ARR file identity differs from the cached item evaluated by this cleanup rule. Sync the library and run cleanup again.";
		blocks.set(targetKey, reason);
		context.plans.set(targetKey, { kind: "blocked", reason });
	}
}

function cacheRadarrEvaluationMatchesLiveProof(
	data: Record<string, unknown>,
	hasFile: boolean,
	livePlan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_radarr" }>,
): boolean {
	if (!hasFile) return false;
	const remoteIds =
		data.remoteIds && typeof data.remoteIds === "object"
			? (data.remoteIds as Record<string, unknown>)
			: undefined;
	const source =
		"_arrDashboardSource" in data &&
		data._arrDashboardSource &&
		typeof data._arrDashboardSource === "object"
			? (data._arrDashboardSource as Record<string, unknown>)
			: undefined;
	const movieFile =
		data.movieFile && typeof data.movieFile === "object"
			? (data.movieFile as Record<string, unknown>)
			: undefined;
	return (
		source?.serviceFingerprint === livePlan.target.serviceFingerprint &&
		remoteIds?.tmdbId === livePlan.target.externalId &&
		data.path === livePlan.target.mediaPath.value &&
		radarrCachedFileIdentityMatches(data.path, movieFile, livePlan.file)
	);
}

function createRadarrDestructiveMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	target: CleanupDeleteTarget,
	safetyPlan: SharedMediaSafetyPlan,
	assertExecutionAllowed?: () => Promise<void>,
	postFileOwnershipPlan?: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_radarr" }>,
): () => Promise<void> {
	let fileDeleteAuthorityConsumed = false;
	const ownershipPlan = safetyPlan.kind === "verified_radarr" ? safetyPlan : postFileOwnershipPlan;

	return async () => {
		await assertExecutionAllowed?.();
		if (safetyPlan.kind === "verified_radarr_empty") {
			if (postFileOwnershipPlan && postFileOwnershipPlan.ownership.length > 0) {
				await assertVerifiedRadarrPeerOwnershipRetained(
					deps,
					userId,
					target.arrItemId,
					postFileOwnershipPlan,
				);
				return;
			}
			const context = createSharedPlexSafetyContext();
			const blocks = await findSharedPlexDeleteBlocks(deps, userId, [target], context);
			const livePlan = asExecutableSafetyPlan(context.plans.get(cleanupDeleteTargetKey(target)));
			if (
				blocks.has(cleanupDeleteTargetKey(target)) ||
				!livePlan ||
				!executableSafetyPlansEqual(safetyPlan, livePlan)
			) {
				throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
					"Skipped for safety: verified Radarr ownership changed at the mutation boundary. Run cleanup again before deleting the record.",
				);
			}
			return;
		}
		if (!ownershipPlan) return;
		if (ownershipPlan.ownership.length === 0) return;
		if (!fileDeleteAuthorityConsumed && safetyPlan.kind === "verified_radarr") {
			const context = createSharedPlexSafetyContext();
			const blocks = await findSharedPlexDeleteBlocks(deps, userId, [target], context);
			const livePlan = asExecutableSafetyPlan(context.plans.get(cleanupDeleteTargetKey(target)));
			if (
				blocks.has(cleanupDeleteTargetKey(target)) ||
				!livePlan ||
				!executableSafetyPlansEqual(ownershipPlan, livePlan)
			) {
				throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
					"Skipped for safety: verified Radarr ownership changed at the mutation boundary. Run cleanup again before deleting the file.",
				);
			}
			fileDeleteAuthorityConsumed = true;
			return;
		}
		await assertVerifiedRadarrPeerOwnershipRetained(deps, userId, target.arrItemId, ownershipPlan);
	};
}

function createSonarrDestructiveMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	target: CleanupDeleteTarget,
	safetyPlan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }>,
	assertExecutionAllowed?: () => Promise<void>,
): () => Promise<void> {
	let fileDeleteAuthorityConsumed = false;
	return async () => {
		await assertExecutionAllowed?.();
		if (fileDeleteAuthorityConsumed || safetyPlan.files.episodeFiles.length === 0) {
			if (safetyPlan.ownership.length === 0) {
				const context = createSharedPlexSafetyContext();
				const blocks = await findSharedPlexDeleteBlocks(deps, userId, [target], context);
				const livePlan = asExecutableSafetyPlan(context.plans.get(cleanupDeleteTargetKey(target)));
				const emptyFileRemainder = {
					...safetyPlan,
					files: { ...safetyPlan.files, episodeFiles: [] },
				};
				if (
					blocks.has(cleanupDeleteTargetKey(target)) ||
					!livePlan ||
					!executableSafetyPlansEqual(emptyFileRemainder, livePlan)
				) {
					throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
						"Skipped for safety: verified Sonarr ownership changed at the mutation boundary. Run cleanup again before deleting the file.",
					);
				}
				return;
			}
			await assertVerifiedSonarrPeerOwnershipRetained(deps, userId, target.arrItemId, safetyPlan);
			return;
		}
		const context = createSharedPlexSafetyContext();
		const blocks = await findSharedPlexDeleteBlocks(deps, userId, [target], context);
		const livePlan = asExecutableSafetyPlan(context.plans.get(cleanupDeleteTargetKey(target)));
		if (
			blocks.has(cleanupDeleteTargetKey(target)) ||
			!livePlan ||
			!executableSafetyPlansEqual(safetyPlan, livePlan)
		) {
			throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
				"Skipped for safety: verified Sonarr ownership changed at the mutation boundary. Run cleanup again before deleting the file.",
			);
		}
		fileDeleteAuthorityConsumed = true;
	};
}

function withSharedPlexWarning(warnings: string[], blockCount: number): string[] {
	return blockCount > 0 && !warnings.includes(SHARED_PLEX_WARNING)
		? [...warnings, SHARED_PLEX_WARNING]
		: warnings;
}

export function buildCleanupPreviewDetails(
	flagged: FlaggedItem[],
	sharedPlexBlocks: Map<string, string>,
): CleanupRunResult["details"] {
	return flagged.map((item) => {
		const safetyReason = sharedPlexBlocks.get(cleanupDeleteTargetKey(item.cacheItem));
		return buildDetail(item, safetyReason ? "skipped" : item.match.action, safetyReason);
	});
}

// ============================================================================
// Preview (Dry Run)
// ============================================================================

async function loadDurableRetryPreview(
	deps: CleanupExecutorDeps,
	userId: string,
	configId: string,
	take: number = PREVIEW_SAFETY_INSPECTION_LIMIT,
) {
	try {
		const pendingWhere = {
			configId,
			config: { userId },
			status: "retry_pending",
		} as const;
		const executingWhere = {
			configId,
			config: { userId },
			status: "retry_executing",
		} as const;
		const [retries, pendingRetryTargets, inFlightRetries] = await Promise.all([
			deps.prisma.libraryCleanupApproval.findMany({
				where: pendingWhere,
				orderBy: { createdAt: "asc" },
				take,
			}),
			deps.prisma.libraryCleanupApproval.findMany({
				where: pendingWhere,
				select: { instanceId: true, arrItemId: true, itemType: true },
			}),
			deps.prisma.libraryCleanupApproval.findMany({
				where: executingWhere,
				orderBy: { createdAt: "asc" },
			}),
		]);
		const retryDetails = retries.map((retry) => {
			const action: DetailAction =
				retry.action === "delete" || retry.action === "delete_files" || retry.action === "unmonitor"
					? retry.action
					: "skipped";
			return buildRetryDetail(
				retry,
				action,
				`Durable retry pending resume from the Approval Queue or the next live direct cleanup run${
					retry.lastExecutionError ? `: ${retry.lastExecutionError}` : "."
				}`,
			);
		});
		const inFlightDetails = inFlightRetries.map((retry) =>
			buildRetryDetail(
				retry,
				"skipped",
				"Deferred: another cleanup run is already executing this durable retry.",
			),
		);
		const total = Math.max(pendingRetryTargets.length, retryDetails.length);
		const targetKeys = new Set(
			[...pendingRetryTargets, ...inFlightRetries].map((retry) => cleanupDeleteTargetKey(retry)),
		);
		const warningParts = [];
		if (total > 0) {
			warningParts.push(
				`${total} durable cleanup ${total === 1 ? "retry is" : "retries are"} pending resume from the Approval Queue or the next live direct cleanup run.`,
			);
		}
		if (inFlightRetries.length > 0) {
			warningParts.push(
				`${inFlightRetries.length} durable cleanup ${
					inFlightRetries.length === 1 ? "retry is" : "retries are"
				} already executing and ${inFlightRetries.length === 1 ? "is" : "are"} deferred from this preview.`,
			);
		}
		return {
			retries,
			inFlightRetries,
			targetKeys,
			details: [...inFlightDetails, ...retryDetails],
			total,
			loaded: true,
			warning: warningParts.length > 0 ? warningParts.join(" ") : undefined,
		};
	} catch (error) {
		deps.log.warn(
			{ err: error, configId },
			"Library cleanup preview could not load durable mutation retries",
		);
		return {
			retries: [],
			inFlightRetries: [],
			targetKeys: new Set<string>(),
			details: [],
			total: 0,
			loaded: false,
			warning: "Durable cleanup retries could not be loaded for this preview.",
		};
	}
}

/**
 * Run a preview evaluation without making any changes.
 * Returns all items that would be flagged by the current rule set.
 */
export async function executeCleanupPreview(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupRunResult> {
	const startTime = Date.now();
	const { prisma, log } = deps;

	const config = await prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: { priority: "asc" } } },
	});

	if (!config) {
		return {
			isDryRun: true,
			status: "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			previewItemCount: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: Date.now() - startTime,
		};
	}

	const retryPreview = await loadDurableRetryPreview(deps, userId, config.id);
	if (config.rules.length === 0) {
		return {
			isDryRun: true,
			status: retryPreview.warning ? "partial" : "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			pendingRetryCount: retryPreview.total,
			previewItemCount: retryPreview.targetKeys.size,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: retryPreview.details,
			durationMs: Date.now() - startTime,
			warnings: retryPreview.warning ? [retryPreview.warning] : undefined,
		};
	}

	const { flagged, totalEvaluated, prefetchHealth, warnings } = await evaluateAllItems(
		deps,
		config,
		config.rules,
	);
	const freshCandidates = flagged.filter(
		(item) => !retryPreview.targetKeys.has(cleanupDeleteTargetKey(item.cacheItem)),
	);
	const retryDetails = retryPreview.details.slice(0, PREVIEW_SAFETY_INSPECTION_LIMIT);
	const inspected = selectInspectableCleanupPreviewItems(
		freshCandidates,
		PREVIEW_SAFETY_INSPECTION_LIMIT - retryDetails.length,
	);
	const safetyContext = createSharedPlexSafetyContext();
	const sharedPlexBlocks = await findSharedPlexDeleteBlocks(
		deps,
		userId,
		toDeleteTargets(inspected),
		safetyContext,
	);
	await blockPlansThatDifferFromEvaluatedCache(
		deps,
		userId,
		inspected,
		safetyContext,
		sharedPlexBlocks,
	);
	const allWarnings = withSharedPlexWarning(
		retryPreview.warning ? [...warnings, retryPreview.warning] : warnings,
		sharedPlexBlocks.size,
	);

	const details = [...retryDetails, ...buildCleanupPreviewDetails(inspected, sharedPlexBlocks)];

	const hasWarnings = allWarnings.length > 0;
	log.info(
		{
			totalEvaluated,
			totalRuleMatches: flagged.length,
			totalFlagged: freshCandidates.length,
			pendingRetryCount: retryPreview.total,
			sharedPlexBlocks: sharedPlexBlocks.size,
			hasWarnings,
		},
		"Library cleanup preview completed",
	);

	return {
		isDryRun: true,
		status: hasWarnings ? ("partial" as const) : ("completed" as const),
		itemsEvaluated: totalEvaluated,
		itemsFlagged: freshCandidates.length,
		pendingRetryCount: retryPreview.total,
		previewItemCount: retryPreview.targetKeys.size + freshCandidates.length,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped: sharedPlexBlocks.size,
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings: allWarnings,
	};
}

// ============================================================================
// Full Execution
// ============================================================================

/**
 * Execute a full cleanup run. Depending on config:
 * - dryRunMode=true: Only log what would happen
 * - requireApproval=true: Create approval queue entries
 * - Otherwise: Execute actions directly on ARR instances
 */
export async function executeCleanupRun(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupRunResult> {
	return await withCleanupOperationGuard(() => executeCleanupRunGuarded(deps, userId));
}

async function executeCleanupRunGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupRunResult> {
	const startTime = Date.now();
	const { prisma, log } = deps;

	const config = await prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: { priority: "asc" } } },
	});

	if (!config?.enabled || config.rules.length === 0) {
		return {
			isDryRun: config?.dryRunMode ?? true,
			status: "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: Date.now() - startTime,
		};
	}

	if (config.dryRunMode) {
		const { flagged, totalEvaluated, prefetchHealth, warnings } = await evaluateAllItems(
			deps,
			config,
			config.rules,
		);
		const configuredRunLimit =
			Number.isSafeInteger(config.maxRemovalsPerRun) && config.maxRemovalsPerRun > 0
				? config.maxRemovalsPerRun
				: Number.MAX_SAFE_INTEGER;
		const retryPreview = await loadDurableRetryPreview(deps, userId, config.id, configuredRunLimit);
		const freshCandidates = flagged.filter(
			(item) => !retryPreview.targetKeys.has(cleanupDeleteTargetKey(item.cacheItem)),
		);
		const freshBudget = retryPreview.loaded
			? Math.max(0, configuredRunLimit - retryPreview.retries.length)
			: 0;
		const limited = freshCandidates.slice(0, freshBudget);
		const safetyContext = createSharedPlexSafetyContext();
		const sharedPlexBlocks = await findSharedPlexDeleteBlocks(
			deps,
			userId,
			toDeleteTargets(limited),
			safetyContext,
		);
		await blockPlansThatDifferFromEvaluatedCache(
			deps,
			userId,
			limited,
			safetyContext,
			sharedPlexBlocks,
		);
		const allWarnings = withSharedPlexWarning(
			retryPreview.warning ? [...warnings, retryPreview.warning] : warnings,
			sharedPlexBlocks.size,
		);
		const details = [
			...retryPreview.details,
			...buildCleanupPreviewDetails(limited, sharedPlexBlocks),
		];

		const result: CleanupRunResult = {
			isDryRun: true,
			status: allWarnings.length > 0 ? "partial" : "completed",
			itemsEvaluated: totalEvaluated,
			itemsFlagged: retryPreview.retries.length + limited.length,
			pendingRetryCount: retryPreview.total,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped:
				freshCandidates.length -
				limited.length +
				sharedPlexBlocks.size +
				retryPreview.inFlightRetries.length,
			details,
			durationMs: Date.now() - startTime,
			prefetchHealth,
			warnings: allWarnings,
		};

		await createRunLog(prisma, config.id, result, log);
		return result;
	}

	const runLease = await startCleanupRunLease(deps, userId, config.id);
	try {
		const { flagged, totalEvaluated, prefetchHealth, warnings } = await evaluateAllItems(
			deps,
			config,
			config.rules,
		);
		// Real execution
		if (config.requireApproval) {
			const nonterminalRetryTargets = await prisma.libraryCleanupApproval.findMany({
				where: {
					configId: config.id,
					config: { userId },
					status: { in: ["retry_pending", "retry_executing"] },
				},
				select: {
					instanceId: true,
					arrItemId: true,
					itemType: true,
				},
			});
			const retryTargetKeys = new Set(
				nonterminalRetryTargets.map((retry) => cleanupDeleteTargetKey(retry)),
			);
			const freshCandidates = flagged.filter(
				(item) => !retryTargetKeys.has(cleanupDeleteTargetKey(item.cacheItem)),
			);
			const approvalSelection = await selectApprovalCandidatesBeforeLimit(
				deps,
				config,
				userId,
				freshCandidates,
				config.maxRemovalsPerRun,
			);
			const limited = approvalSelection.selected;
			const safetyContext = createSharedPlexSafetyContext();
			const sharedPlexBlocks = await findSharedPlexDeleteBlocks(
				deps,
				userId,
				toDeleteTargets(limited),
				safetyContext,
			);
			await blockPlansThatDifferFromEvaluatedCache(
				deps,
				userId,
				limited,
				safetyContext,
				sharedPlexBlocks,
			);
			const allWarnings = withSharedPlexWarning(warnings, sharedPlexBlocks.size);
			return await executeWithApproval(
				deps,
				config,
				limited,
				totalEvaluated,
				flagged.length,
				startTime,
				prefetchHealth,
				allWarnings,
				sharedPlexBlocks,
				safetyContext.plans,
				approvalSelection.skippedDetails,
			);
		}

		return await executeDirectRemoval(
			deps,
			config,
			userId,
			flagged,
			totalEvaluated,
			flagged.length,
			startTime,
			prefetchHealth,
			warnings,
			new Map(),
			runLease.assertOwnership,
		);
	} finally {
		await runLease.release();
	}
}

/**
 * Execute approved items from the approval queue.
 * Dispatches on the stored action (delete, unmonitor, delete_files).
 */
export async function executeApprovedItems(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalIds: string[],
	approvalRequestToken?: string,
): Promise<{ removed: number; failed: number; errors: string[] }> {
	return await withCleanupOperationGuard(() =>
		executeApprovedItemsGuarded(deps, userId, approvalIds, approvalRequestToken),
	);
}

async function executeApprovedItemsGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalIds: string[],
	approvalRequestToken?: string,
): Promise<{ removed: number; failed: number; errors: string[] }> {
	const config = await deps.prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		select: { id: true },
	});
	if (!config) {
		return {
			removed: 0,
			failed: approvalIds.length,
			errors: ["Cleanup items could not be executed because their configuration was not found."],
		};
	}
	const releaseUnclaimedApprovals = () =>
		deps.prisma.libraryCleanupApproval.updateMany({
			where: {
				id: { in: approvalIds },
				config: { userId },
				status: "approved",
				...(approvalRequestToken ? { executionToken: approvalRequestToken } : {}),
			},
			data: {
				status: "pending",
				executionToken: null,
				lastExecutionError: "Cleanup execution did not claim this approved item; retry approval.",
			},
		});

	let runLease: Awaited<ReturnType<typeof startCleanupRunLease>>;
	try {
		runLease = await startCleanupRunLease(deps, userId, config.id);
	} catch (error) {
		await releaseUnclaimedApprovals();
		throw error;
	}

	try {
		const result = await executeQueuedCleanupItems(deps, userId, approvalIds, {
			claimStatus: "approved",
			executeStatus: "executing",
			retryStatus: "pending",
			enforceExpiry: true,
			assertExecutionAllowed: runLease.assertOwnership,
			claimExecutionToken: approvalRequestToken,
		});
		const unclaimedErrors = result.unclaimedIds.map(
			() => "Cleanup approval was not found, expired, no longer approved, or changed ownership.",
		);
		return {
			removed: result.removed,
			failed: result.failed + unclaimedErrors.length,
			errors: [...result.errors, ...unclaimedErrors],
		};
	} finally {
		await releaseUnclaimedApprovals().catch((error) => {
			deps.log.error(
				{ err: error, approvalIds },
				"Cleanup could not return unclaimed approved items to pending",
			);
		});
		await runLease.release();
	}
}

/**
 * Explicitly resume durable mutation intents. This path is intentionally
 * independent of dry-run and approval configuration: the operator authorizes
 * only the selected, already-persisted intent, which is revalidated at the
 * mutation boundary before execution.
 */
export async function executeRetryItems(
	deps: CleanupExecutorDeps,
	userId: string,
	retryIds: string[],
): Promise<{ removed: number; reconciled: number; failed: number; errors: string[] }> {
	return await withCleanupOperationGuard(() => executeRetryItemsGuarded(deps, userId, retryIds));
}

async function executeRetryItemsGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
	retryIds: string[],
): Promise<{ removed: number; reconciled: number; failed: number; errors: string[] }> {
	const config = await deps.prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		select: { id: true },
	});
	if (!config) {
		return {
			removed: 0,
			reconciled: 0,
			failed: retryIds.length,
			errors: ["Cleanup retries could not be executed because their configuration was not found."],
		};
	}

	const runLease = await startCleanupRunLease(deps, userId, config.id);
	try {
		const result = await executeQueuedCleanupItems(deps, userId, retryIds, {
			claimStatus: "retry_pending",
			executeStatus: "retry_executing",
			retryStatus: "retry_pending",
			enforceExpiry: false,
			assertExecutionAllowed: runLease.assertOwnership,
		});
		const unclaimedErrors = result.unclaimedIds.map(
			() => "Cleanup retry was not found, was no longer pending, or changed ownership.",
		);
		return {
			removed: result.removed,
			reconciled: result.reconciledIds.length,
			failed: result.failed + unclaimedErrors.length,
			errors: [...result.errors, ...unclaimedErrors],
		};
	} finally {
		await runLease.release();
	}
}

interface QueuedCleanupExecutionResult {
	removed: number;
	failed: number;
	errors: string[];
	expiredIds: string[];
	recordingFailureIds: string[];
	reconciledIds: string[];
	unclaimedIds: string[];
	mutationBudgetConsumedIds: string[];
	confirmedPartialFileDeletionIds: string[];
}

async function retryTargetRecordIsAbsent(
	deps: CleanupExecutorDeps,
	instance: ServiceInstance,
	arrItemId: number,
	safetySnapshot: unknown,
): Promise<boolean> {
	const plan = parseExecutableSafetyPlan(safetySnapshot);
	if (!plan || plan.target.serviceFingerprint !== createArrServiceFingerprint(instance)) {
		return false;
	}
	const client = deps.arrClientFactory.create(instance);
	try {
		if (
			instance.service === "RADARR" &&
			(plan.kind === "verified_arr_target" ||
				plan.kind === "verified_radarr" ||
				plan.kind === "verified_radarr_empty")
		) {
			await (client as InstanceType<typeof RadarrClient>).movie.getById(arrItemId);
			return false;
		}
		if (
			instance.service === "SONARR" &&
			(plan.kind === "verified_arr_target" || plan.kind === "verified_sonarr")
		) {
			await (client as InstanceType<typeof SonarrClient>).series.getById(arrItemId);
			return false;
		}
		return false;
	} catch (error) {
		if (isNotFoundError(error)) return true;
		throw error;
	}
}

async function executeQueuedCleanupItems(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalIds: string[],
	options: {
		claimStatus: "approved" | "retry_pending";
		executeStatus: "executing" | "retry_executing";
		retryStatus: "pending" | "retry_pending";
		enforceExpiry: boolean;
		assertExecutionAllowed?: () => Promise<void>;
		claimExecutionToken?: string;
	},
): Promise<QueuedCleanupExecutionResult> {
	const { prisma, arrClientFactory, log } = deps;

	// Atomically transition approved → executing to prevent double-execution
	// Also enforce expiry — don't execute items past their expiration
	const now = new Date();
	const claimedApprovalIds: string[] = [];
	const claimedApprovalTokens = new Map<string, string>();
	const mutationAttemptedApprovalIds = new Set<string>();
	const mutationBudgetConsumedIds = new Set<string>();
	const confirmedPartialFileDeletionIds = new Set<string>();
	const unclaimedIds: string[] = [];
	const claimErrors: string[] = [];
	for (const approvalId of [...new Set(approvalIds)]) {
		try {
			const executionToken = randomUUID();
			const claim = await prisma.libraryCleanupApproval.updateMany({
				where: {
					id: approvalId,
					config: { userId },
					status: options.claimStatus,
					...(options.claimExecutionToken ? { executionToken: options.claimExecutionToken } : {}),
					...(options.enforceExpiry ? { expiresAt: { gt: now } } : {}),
				},
				data: { status: options.executeStatus, reviewedAt: now, executionToken },
			});
			if (claim.count === 1) {
				claimedApprovalIds.push(approvalId);
				claimedApprovalTokens.set(approvalId, executionToken);
			} else unclaimedIds.push(approvalId);
		} catch (error) {
			claimErrors.push("A cleanup approval could not be claimed and was not executed.");
			log.error({ err: error, approvalId }, "Failed to claim cleanup approval for execution");
		}
	}
	if (claimedApprovalIds.length === 0) {
		return {
			removed: 0,
			failed: claimErrors.length,
			errors: claimErrors,
			expiredIds: [],
			recordingFailureIds: [],
			reconciledIds: [],
			unclaimedIds,
			mutationBudgetConsumedIds: [],
			confirmedPartialFileDeletionIds: [],
		};
	}

	try {
		const approvals = await prisma.libraryCleanupApproval.findMany({
			where: {
				id: { in: claimedApprovalIds },
				config: { userId },
				status: options.executeStatus,
			},
		});

		let removed = 0;
		let failed = claimErrors.length;
		const errors: string[] = [...claimErrors];
		const expiredIds: string[] = [];
		const recordingFailureIds: string[] = [];
		const reconciledIds: string[] = [];
		const sharedPlexSafetyContext = createSharedPlexSafetyContext();

		for (const approval of approvals) {
			const claimedExecutionToken = claimedApprovalTokens.get(approval.id);
			if (!claimedExecutionToken) {
				unclaimedIds.push(approval.id);
				continue;
			}
			let instance: ServiceInstance | null = null;
			try {
				instance = await prisma.serviceInstance.findFirst({
					where: { id: approval.instanceId, userId },
				});
			} catch (error) {
				log.error(
					{ err: error, approvalId: approval.id },
					"Failed to load approval ARR instance; item was not executed",
				);
			}
			if (!instance) {
				errors.push("Cleanup item was not executed because its ARR instance could not be loaded.");
				failed++;
				await updateClaimedCleanupApproval(
					prisma,
					userId,
					approval.id,
					options.executeStatus,
					claimedExecutionToken,
					{
						status: options.retryStatus,
						executionToken: null,
						lastExecutionError:
							"Cleanup item was not executed because its ARR instance could not be loaded.",
					},
				).catch((revertErr) => {
					log.warn(
						{ err: revertErr, approvalId: approval.id },
						"Failed to return approval with missing instance to pending",
					);
				});
				continue;
			}

			let action: RuleAction;
			try {
				action = validateCleanupMutationShape(instance, approval.itemType, approval.action);
			} catch (error) {
				const executionError =
					"Cleanup item was not executed because its stored action or media type is invalid.";
				errors.push(executionError);
				failed++;
				log.error(
					{ err: error, approvalId: approval.id, instanceId: approval.instanceId },
					"Approved cleanup item has an invalid mutation shape",
				);
				await updateClaimedCleanupApproval(
					prisma,
					userId,
					approval.id,
					options.executeStatus,
					claimedExecutionToken,
					{
						status: options.retryStatus,
						executionToken: null,
						lastExecutionError: executionError,
					},
				).catch((revertErr) => {
					log.warn(
						{ err: revertErr, approvalId: approval.id },
						"Failed to return invalid approval to pending",
					);
				});
				continue;
			}

			let sharedPlexBlock: string | undefined;
			let approvalIdentityChanged = false;
			let approvedPlan = parseExecutableSafetyPlan(approval.safetySnapshot);
			let safetyPlan: SharedMediaSafetyPlan | undefined = approvedPlan ?? undefined;
			let postFileOwnershipPlan:
				| Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_radarr" }>
				| undefined;
			const recoveringInterruptedMutation =
				options.claimStatus === "retry_pending" ||
				approval.lastExecutionError === INTERRUPTED_CLEANUP_RECOVERY_MESSAGE;
			if (
				!approvedPlan ||
				approvedPlan.target.serviceFingerprint !== createArrServiceFingerprint(instance)
			) {
				approvalIdentityChanged = true;
				sharedPlexBlock =
					"Skipped for safety: the ARR target identity changed after this cleanup item was queued. Run cleanup again and review a new approval.";
			}
			let retryTargetAlreadyAbsent = false;
			if (!sharedPlexBlock && recoveringInterruptedMutation) {
				try {
					retryTargetAlreadyAbsent = await retryTargetRecordIsAbsent(
						deps,
						instance,
						approval.arrItemId,
						approval.safetySnapshot,
					);
				} catch (error) {
					log.warn(
						{ err: error, approvalId: approval.id },
						"Cleanup retry could not verify whether the ARR record was already absent",
					);
				}
			}
			if (
				!sharedPlexBlock &&
				!retryTargetAlreadyAbsent &&
				recoveringInterruptedMutation &&
				hasVerifiedSonarrOwnershipProof(action, approvedPlan) &&
				approvedPlan.files.episodeFiles.length > 0
			) {
				try {
					await assertVerifiedSonarrPeerOwnershipRetained(
						deps,
						userId,
						approval.arrItemId,
						approvedPlan,
					);
					const reconciledPlan: Extract<
						ExecutableSharedMediaSafetyPlan,
						{ kind: "verified_sonarr" }
					> = {
						...approvedPlan,
						files: { seriesPath: approvedPlan.files.seriesPath, episodeFiles: [] },
					};
					await updateClaimedCleanupApproval(
						prisma,
						userId,
						approval.id,
						options.executeStatus,
						claimedExecutionToken,
						{
							safetySnapshot: serializeExecutableSafetyPlan(reconciledPlan),
							lastExecutionError:
								"Recovered a persisted Sonarr mutation after verifying that its target files were already removed.",
						},
					);
					approvedPlan = reconciledPlan;
					safetyPlan = reconciledPlan;
				} catch (error) {
					log.info(
						{ err: error, approvalId: approval.id },
						"Interrupted Sonarr cleanup was not a verified record-only recovery",
					);
				}
			}
			if (!sharedPlexBlock && !retryTargetAlreadyAbsent) {
				const sonarrRecordOnlyRetryPlan =
					hasVerifiedSonarrOwnershipProof(action, approvedPlan) &&
					approvedPlan.files.episodeFiles.length === 0
						? approvedPlan
						: null;
				if (sonarrRecordOnlyRetryPlan) {
					try {
						await assertVerifiedSonarrPeerOwnershipRetained(
							deps,
							userId,
							approval.arrItemId,
							sonarrRecordOnlyRetryPlan,
						);
						safetyPlan = sonarrRecordOnlyRetryPlan;
					} catch (error) {
						log.error(
							{ err: error, approvalId: approval.id },
							"Approved Sonarr record-only retry ownership revalidation failed closed",
						);
						sharedPlexBlock =
							"Skipped for safety: the retained Sonarr-to-Plex ownership changed before the series record could be retried.";
					}
				} else {
					try {
						const targetKey = cleanupDeleteTargetKey(approval);
						const blocks = await findSharedPlexDeleteBlocks(
							deps,
							userId,
							[
								{
									instanceId: approval.instanceId,
									arrItemId: approval.arrItemId,
									itemType: approval.itemType,
									action,
								},
							],
							sharedPlexSafetyContext,
						);
						sharedPlexBlock = blocks.get(targetKey);
						safetyPlan = sharedPlexSafetyContext.plans.get(targetKey);
					} catch (error) {
						log.error(
							{ err: error, approvalId: approval.id },
							"Approved cleanup item safety preflight failed closed",
						);
						sharedPlexBlock =
							"Skipped for safety: arr-dashboard could not complete the live ARR and media-server preflight.";
					}
					if (!sharedPlexBlock && !safetyPlan) {
						sharedPlexBlock =
							"Skipped for safety: arr-dashboard did not produce an explicit ARR mutation safety plan.";
					}
					if (!sharedPlexBlock) {
						const livePlan = asExecutableSafetyPlan(safetyPlan);
						const exactPlanMatch =
							approvedPlan && livePlan && executableSafetyPlansEqual(approvedPlan, livePlan);
						const recordedRadarrFilelessRetry =
							approvedPlan && livePlan
								? isRecordedRadarrFilelessRetry(
										action,
										approvedPlan,
										livePlan,
										approval.lastExecutionError,
									)
								: false;
						const recoverableFileRemainder =
							(recoveringInterruptedMutation || recordedRadarrFilelessRetry) &&
							(action === "delete" || action === "delete_files") &&
							approvedPlan &&
							livePlan &&
							isVerifiedFileRemainder(approvedPlan, livePlan);
						if (!exactPlanMatch && !recoverableFileRemainder) {
							approvalIdentityChanged = true;
							sharedPlexBlock =
								"Skipped for safety: the ARR target or file identity changed after this cleanup item was queued. Run cleanup again and review a new approval.";
						} else if (recoverableFileRemainder && !exactPlanMatch) {
							if (
								approvedPlan?.kind === "verified_radarr" &&
								livePlan?.kind === "verified_radarr_empty"
							) {
								postFileOwnershipPlan = approvedPlan;
							}
							try {
								await updateClaimedCleanupApproval(
									prisma,
									userId,
									approval.id,
									options.executeStatus,
									claimedExecutionToken,
									{
										safetySnapshot: serializeExecutableSafetyPlan(
											postFileOwnershipPlan ?? livePlan,
										),
										lastExecutionError:
											"Recovered a persisted cleanup mutation after verifying the remaining ARR file set.",
									},
								);
							} catch (error) {
								log.error(
									{ err: error, approvalId: approval.id },
									"Cleanup could not persist its reconciled crash-recovery snapshot",
								);
								sharedPlexBlock =
									"Skipped for safety: arr-dashboard could not persist the verified crash-recovery state before continuing.";
							}
						}
					}
				}
			}
			if (sharedPlexBlock) {
				errors.push(`Cleanup item was not executed: ${sharedPlexBlock}`);
				failed++;
				log.warn(
					{ title: approval.title, instanceId: approval.instanceId },
					"Approved cleanup item blocked by shared-media safety check",
				);
				try {
					await updateClaimedCleanupApproval(
						prisma,
						userId,
						approval.id,
						options.executeStatus,
						claimedExecutionToken,
						{
							status: approvalIdentityChanged ? "expired" : options.retryStatus,
							executionToken: null,
							...(approvalIdentityChanged ? { reviewedAt: new Date() } : {}),
							lastExecutionError: sharedPlexBlock,
						},
					);
					if (approvalIdentityChanged) expiredIds.push(approval.id);
				} catch (revertErr) {
					log.warn(
						{ err: revertErr, approvalId: approval.id, title: approval.title },
						"Failed to revert safety-blocked approval status",
					);
				}
				continue;
			}

			let executionCompleted = false;
			let reconciledWithoutMutation = false;
			try {
				await options.assertExecutionAllowed?.();
				const ownership = await prisma.libraryCleanupApproval.updateMany({
					where: {
						id: approval.id,
						config: { userId },
						status: options.executeStatus,
						executionToken: claimedExecutionToken,
					},
					data: { reviewedAt: new Date() },
				});
				if (ownership.count !== 1) {
					unclaimedIds.push(approval.id);
					log.warn(
						{ approvalId: approval.id },
						"Cleanup approval mutation ownership changed before execution; item was deferred",
					);
					continue;
				}
				mutationAttemptedApprovalIds.add(approval.id);
				const mutationInstance = await loadCurrentMutationInstance(
					deps,
					userId,
					approval.instanceId,
					safetyPlan!,
				);
				if (!retryTargetAlreadyAbsent) {
					await assertCurrentCleanupExemptionAllowsMutation(
						deps,
						userId,
						mutationInstance,
						approval.arrItemId,
						approval.itemType,
					);
				}
				const assertMutationAuthority = async () => {
					await options.assertExecutionAllowed?.();
					mutationBudgetConsumedIds.add(approval.id);
				};
				const assertDestructiveMutationAuthority =
					mutationInstance.service === "RADARR"
						? createRadarrDestructiveMutationAuthority(
								deps,
								userId,
								{
									instanceId: approval.instanceId,
									arrItemId: approval.arrItemId,
									itemType: approval.itemType,
									action,
								},
								safetyPlan!,
								assertMutationAuthority,
								postFileOwnershipPlan,
							)
						: mutationInstance.service === "SONARR" && safetyPlan?.kind === "verified_sonarr"
							? createSonarrDestructiveMutationAuthority(
									deps,
									userId,
									{
										instanceId: approval.instanceId,
										arrItemId: approval.arrItemId,
										itemType: approval.itemType,
										action,
									},
									safetyPlan,
									assertMutationAuthority,
								)
							: assertMutationAuthority;

				if (retryTargetAlreadyAbsent) {
					executionCompleted = true;
					reconciledWithoutMutation = true;
					await reconcileSonarrEpisodeFileCache(prisma, mutationInstance, approval.arrItemId, log);
					await prisma.libraryCache
						.deleteMany({
							where: {
								instanceId: approval.instanceId,
								arrItemId: approval.arrItemId,
								itemType: approval.itemType,
							},
						})
						.catch((cacheErr) => {
							log.error(
								{ err: cacheErr, approvalId: approval.id },
								"Completed record-only retry but its cache cleanup failed",
							);
						});
				} else if (action === "unmonitor") {
					await unmonitorInArr(
						arrClientFactory,
						mutationInstance,
						approval.arrItemId,
						safetyPlan!,
						assertMutationAuthority,
					);
					executionCompleted = true;
					await prisma.libraryCache
						.updateMany({
							where: {
								instanceId: approval.instanceId,
								arrItemId: approval.arrItemId,
								itemType: approval.itemType,
							},
							data: { monitored: false },
						})
						.catch((cacheErr) => {
							log.error(
								{ err: cacheErr, approvalId: approval.id },
								"Approved cleanup action succeeded but its cache update failed",
							);
						});
				} else if (action === "delete_files") {
					const deletedFiles = await deleteFilesFromArr(
						arrClientFactory,
						mutationInstance,
						approval.arrItemId,
						safetyPlan!,
						assertDestructiveMutationAuthority,
					);
					executionCompleted = true;
					reconciledWithoutMutation = !deletedFiles;
					await reconcileSonarrEpisodeFileCache(prisma, mutationInstance, approval.arrItemId, log);
					await prisma.libraryCache
						.updateMany({
							where: {
								instanceId: approval.instanceId,
								arrItemId: approval.arrItemId,
								itemType: approval.itemType,
							},
							data: { hasFile: false, sizeOnDisk: 0 },
						})
						.catch((cacheErr) => {
							log.error(
								{ err: cacheErr, approvalId: approval.id },
								"Approved cleanup action succeeded but its cache update failed",
							);
						});
				} else {
					await deleteFromArr(
						arrClientFactory,
						mutationInstance,
						approval.arrItemId,
						safetyPlan!,
						assertDestructiveMutationAuthority,
					);
					executionCompleted = true;
					await reconcileSonarrEpisodeFileCache(prisma, mutationInstance, approval.arrItemId, log);
					await prisma.libraryCache
						.deleteMany({
							where: {
								instanceId: approval.instanceId,
								arrItemId: approval.arrItemId,
								itemType: approval.itemType,
							},
						})
						.catch((cacheErr) => {
							log.error(
								{ err: cacheErr, approvalId: approval.id },
								"Approved cleanup action succeeded but its cache update failed",
							);
						});
				}

				await updateClaimedCleanupApproval(
					prisma,
					userId,
					approval.id,
					options.executeStatus,
					claimedExecutionToken,
					{
						status: "executed",
						executionToken: null,
						executedAt: new Date(),
						lastExecutionError: null,
					},
				);

				if (reconciledWithoutMutation) {
					reconciledIds.push(approval.id);
					log.info(
						{ title: approval.title, instanceId: approval.instanceId, action },
						"Cleanup durable intent reconciled without another ARR mutation",
					);
				} else {
					removed++;
					log.info(
						{ title: approval.title, instanceId: approval.instanceId, action },
						"Approved cleanup item executed",
					);
				}
			} catch (error) {
				if (error instanceof CleanupRunLeaseLostError) {
					await prisma.libraryCleanupApproval
						.updateMany({
							where: {
								id: approval.id,
								config: { userId },
								status: options.executeStatus,
								executionToken: claimedExecutionToken,
							},
							data: {
								status: options.retryStatus,
								executionToken: null,
								lastExecutionError:
									"Cleanup execution paused because its database run lease was lost.",
							},
						})
						.catch((revertErr) => {
							log.error(
								{ err: revertErr, approvalId: approval.id },
								"Cleanup lost its run lease and could not return the item to retryable state",
							);
						});
					throw error;
				}
				if (executionCompleted) {
					const recordingError =
						"Cleanup action completed, but arr-dashboard could not record the executed approval state.";
					try {
						await updateClaimedCleanupApproval(
							prisma,
							userId,
							approval.id,
							options.executeStatus,
							claimedExecutionToken,
							{
								status: "executed",
								executionToken: null,
								executedAt: new Date(),
								lastExecutionError: null,
							},
						);
						if (reconciledWithoutMutation) reconciledIds.push(approval.id);
						else removed++;
					} catch (retryError) {
						if (reconciledWithoutMutation) reconciledIds.push(approval.id);
						else removed++;
						failed++;
						errors.push(recordingError);
						recordingFailureIds.push(approval.id);
						log.error(
							{ err: retryError, approvalId: approval.id, instanceId: approval.instanceId },
							"Approved cleanup action completed but its executed status could not be recorded",
						);
					}
					continue;
				}
				const executionError =
					error instanceof CleanupExemptionAuthorityError ||
					error instanceof ArrFileChangedDuringSafetyCheckError ||
					error instanceof ArrDeletePartialError
						? error.message
						: "Cleanup item could not be executed. Review the API logs for details.";
				const mutationAuthorityChanged =
					error instanceof ArrMutationAuthorityChangedDuringSafetyCheckError ||
					(error instanceof CleanupExemptionAuthorityError &&
						options.claimStatus === "retry_pending");
				errors.push(executionError);
				failed++;
				const postPartialRetrySnapshot =
					error instanceof ArrDeletePartialError
						? buildPostPartialRetrySnapshot(safetyPlan, error)
						: undefined;
				if (error instanceof ArrDeletePartialError && error.deletedFileIds.length > 0) {
					confirmedPartialFileDeletionIds.add(approval.id);
				}
				log.error(
					{ err: error, title: approval.title, instanceId: approval.instanceId },
					"Failed to execute approved cleanup item",
				);
				let retryStatePersisted = false;
				try {
					await updateClaimedCleanupApproval(
						prisma,
						userId,
						approval.id,
						options.executeStatus,
						claimedExecutionToken,
						{
							status: mutationAuthorityChanged ? "expired" : options.retryStatus,
							executionToken: null,
							lastExecutionError: executionError,
							...(mutationAuthorityChanged ? { reviewedAt: new Date() } : {}),
							...(postPartialRetrySnapshot ? { safetySnapshot: postPartialRetrySnapshot } : {}),
						},
					);
					retryStatePersisted = true;
					if (mutationAuthorityChanged) expiredIds.push(approval.id);
				} catch (revertErr) {
					errors.push(
						"Cleanup files changed, but arr-dashboard could not record retry state. Cached file state was left unchanged.",
					);
					log.warn(
						{ err: revertErr, approvalId: approval.id, title: approval.title },
						"Failed to persist retryable approval state — cache state was left unchanged",
					);
				}
				if (error instanceof ArrDeletePartialError && retryStatePersisted) {
					await reconcilePartialFileDeletion(
						prisma,
						instance,
						approval.arrItemId,
						approval.itemType,
						error,
						log,
					);
					await prisma.libraryCache
						.updateMany({
							where: {
								instanceId: approval.instanceId,
								arrItemId: approval.arrItemId,
								itemType: approval.itemType,
							},
							data: {
								hasFile: error.hasRemainingFiles,
								sizeOnDisk: error.remainingSize,
							},
						})
						.catch((cacheErr) => {
							log.error(
								{ err: cacheErr, approvalId: approval.id },
								"Cleanup partial ARR delete could not update the cache",
							);
						});
				}
			}
		}

		return {
			removed,
			failed,
			errors,
			expiredIds,
			recordingFailureIds,
			reconciledIds,
			unclaimedIds,
			mutationBudgetConsumedIds: [...mutationBudgetConsumedIds],
			confirmedPartialFileDeletionIds: [...confirmedPartialFileDeletionIds],
		};
	} finally {
		for (const [approvalId, executionToken] of claimedApprovalTokens) {
			if (mutationAttemptedApprovalIds.has(approvalId)) continue;
			await prisma.libraryCleanupApproval
				.updateMany({
					where: {
						id: approvalId,
						config: { userId },
						status: options.executeStatus,
						executionToken,
					},
					data: {
						status: options.retryStatus,
						executionToken: null,
						lastExecutionError:
							"Cleanup execution was interrupted before this item reached a terminal state.",
					},
				})
				.catch((error) => {
					log.error(
						{ err: error, approvalId },
						"Cleanup could not release an unprocessed claimed approval",
					);
				});
		}
	}
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Collect all rule types from enabled rules, including conditions inside composite rules.
 * Used to decide which external data to prefetch (Seerr, Plex, Jellyfin).
 */
function collectActiveRuleTypes(
	rules: Pick<LibraryCleanupRule, "enabled" | "ruleType" | "conditions">[],
): Set<string> {
	const types = new Set<string>();
	for (const r of rules) {
		if (!r.enabled) continue;
		types.add(r.ruleType);
		if (r.conditions) {
			const conds = safeJsonParse(r.conditions) as Array<{ ruleType?: string }> | null;
			if (Array.isArray(conds)) for (const c of conds) if (c.ruleType) types.add(c.ruleType);
		}
	}
	return types;
}

/**
 * Prefetch all Seerr requests and build a lookup map keyed by "movie:tmdbId" or "tv:tmdbId".
 * Returns undefined if no Seerr instance is configured (Seerr rules silently skip).
 */
async function prefetchSeerrRequests(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<SeerrRequestMap | undefined> {
	const { prisma, arrClientFactory, log } = deps;

	// Find user's Seerr instance
	const seerrInstance = await prisma.serviceInstance.findFirst({
		where: { userId, service: "SEERR" },
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

	if (!seerrInstance) return undefined;

	try {
		const client = new SeerrClient(arrClientFactory, seerrInstance, log);
		const map: SeerrRequestMap = new Map();
		const take = 50;
		let skip = 0;
		const maxPages = 100; // Up to 5,000 requests

		for (let page = 0; page < maxPages; page++) {
			const result = await client.getRequests({ take, skip });

			for (const req of result.results) {
				const key = `${req.type}:${req.media.tmdbId}`;
				const info: SeerrRequestInfo = {
					requestId: req.id,
					status: req.status,
					requestedBy: req.requestedBy.displayName,
					requestedByUserId: req.requestedBy.id,
					createdAt: req.createdAt,
					updatedAt: req.updatedAt,
					modifiedBy: req.modifiedBy?.displayName ?? null,
					is4k: req.is4k ?? false,
				};

				const existing = map.get(key);
				if (existing) {
					existing.push(info);
				} else {
					map.set(key, [info]);
				}
			}

			if (result.results.length < take) break;
			skip += take;
		}

		log.info(
			{ totalRequests: [...map.values()].reduce((sum, arr) => sum + arr.length, 0) },
			"Seerr request prefetch complete for cleanup",
		);
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Seerr requests for cleanup — Seerr rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Prefetch Plex watch data from the PlexCache table and build a lookup map.
 * Now section-aware: each row carries sectionId/sectionTitle, and PlexWatchInfo
 * contains both pre-computed cross-section aggregates and a per-section breakdown.
 * Also includes collections and labels from the PlexCache table.
 * Returns undefined if no Plex instance is configured.
 */
export async function prefetchPlexData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexWatchMap | undefined> {
	const { prisma, log } = deps;

	const plexInstances = await prisma.serviceInstance.findMany({
		where: { userId, service: "PLEX" },
		select: { id: true },
	});

	if (plexInstances.length === 0) return undefined;

	try {
		const map: PlexWatchMap = new Map();
		const instanceIds = plexInstances.map((i) => i.id);
		let cursor: string | undefined;
		let totalRows = 0;

		// Cursor-paginate to bound peak heap. Project only columns the watch-map
		// builder reads — skipping ratingKey/thumb/title and the per-row instanceId.
		while (true) {
			const batch = await prisma.plexCache.findMany({
				where: { instanceId: { in: instanceIds } },
				select: {
					id: true,
					tmdbId: true,
					mediaType: true,
					sectionId: true,
					sectionTitle: true,
					lastWatchedAt: true,
					watchCount: true,
					watchedByUsers: true,
					onDeck: true,
					userRating: true,
					collections: true,
					labels: true,
					addedAt: true,
				},
				take: CACHE_QUERY_BATCH_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: { id: "asc" },
			});

			if (batch.length === 0) break;
			totalRows += batch.length;

			for (const row of batch) {
				try {
					// Key is mediaType:tmdbId (aggregating across sections)
					const key = `${row.mediaType}:${row.tmdbId}`;
					const watchedByUsers = (safeJsonParse(row.watchedByUsers) as string[]) ?? [];
					const collections = (safeJsonParse(row.collections) as string[]) ?? [];
					const labels = (safeJsonParse(row.labels) as string[]) ?? [];

					const sectionInfo: PlexSectionWatchInfo = {
						sectionId: row.sectionId,
						sectionTitle: row.sectionTitle,
						lastWatchedAt: row.lastWatchedAt,
						watchCount: row.watchCount,
						watchedByUsers,
						onDeck: row.onDeck,
						userRating: row.userRating,
						collections,
						labels,
						addedAt: row.addedAt,
					};

					const existing = map.get(key);
					if (existing) {
						existing.sections.push(sectionInfo);
						// Update aggregates: merge across sections
						if (
							row.lastWatchedAt &&
							(!existing.lastWatchedAt || row.lastWatchedAt > existing.lastWatchedAt)
						) {
							existing.lastWatchedAt = row.lastWatchedAt;
						}
						existing.watchCount += row.watchCount;
						for (const user of watchedByUsers) {
							if (!existing.watchedByUsers.includes(user)) {
								existing.watchedByUsers.push(user);
							}
						}
						existing.onDeck = existing.onDeck || row.onDeck;
						if (row.userRating != null) {
							existing.userRating =
								existing.userRating != null
									? Math.max(existing.userRating, row.userRating)
									: row.userRating;
						}
						// Merge collections and labels
						for (const c of collections) {
							if (!existing.collections.includes(c)) existing.collections.push(c);
						}
						for (const l of labels) {
							if (!existing.labels.includes(l)) existing.labels.push(l);
						}
						// Merge addedAt: take earliest (first appearance in any library)
						if (row.addedAt && (!existing.addedAt || row.addedAt < existing.addedAt)) {
							existing.addedAt = row.addedAt;
						}
					} else {
						map.set(key, {
							lastWatchedAt: row.lastWatchedAt,
							watchCount: row.watchCount,
							watchedByUsers: [...watchedByUsers],
							onDeck: row.onDeck,
							userRating: row.userRating,
							collections: [...collections],
							labels: [...labels],
							addedAt: row.addedAt,
							sections: [sectionInfo],
						});
					}
				} catch (rowErr) {
					log.warn({ err: rowErr, tmdbId: row.tmdbId }, "Skipping Plex cache row with bad data");
				}
			}

			cursor = batch[batch.length - 1]!.id;
			if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
		}

		log.info(
			{ totalRows, totalEntries: map.size },
			"Plex watch data prefetch complete for cleanup",
		);
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Plex data for cleanup — Plex rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Prefetch Jellyfin watch data from JellyfinCache.
 * Mirrors prefetchPlexData but simpler — no sections/labels.
 */
async function prefetchJellyfinData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<JellyfinWatchMap | undefined> {
	const { prisma, log } = deps;

	const jellyfinInstances = await prisma.serviceInstance.findMany({
		where: { userId, service: { in: ["JELLYFIN", "EMBY"] } },
		select: { id: true },
	});

	if (jellyfinInstances.length === 0) return undefined;

	try {
		const map: JellyfinWatchMap = new Map();
		const instanceIds = jellyfinInstances.map((i) => i.id);
		let cursor: string | undefined;
		let totalRows = 0;

		// Cursor-paginate. Project only columns the watch-map reader uses.
		while (true) {
			const batch = await prisma.jellyfinCache.findMany({
				where: { instanceId: { in: instanceIds } },
				select: {
					id: true,
					tmdbId: true,
					mediaType: true,
					lastWatchedAt: true,
					watchCount: true,
					watchedByUsers: true,
					onDeck: true,
					userRating: true,
					addedAt: true,
				},
				take: CACHE_QUERY_BATCH_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: { id: "asc" },
			});

			if (batch.length === 0) break;
			totalRows += batch.length;

			for (const row of batch) {
				try {
					const key = `${row.mediaType}:${row.tmdbId}`;
					const watchedByUsers = (safeJsonParse(row.watchedByUsers) as string[]) ?? [];

					const existing = map.get(key);
					if (existing) {
						if (
							row.lastWatchedAt &&
							(!existing.lastWatchedAt || row.lastWatchedAt > existing.lastWatchedAt)
						) {
							existing.lastWatchedAt = row.lastWatchedAt;
						}
						existing.watchCount += row.watchCount;
						for (const user of watchedByUsers) {
							if (!existing.watchedByUsers.includes(user)) {
								existing.watchedByUsers.push(user);
							}
						}
						existing.onDeck = existing.onDeck || row.onDeck;
						if (row.userRating != null) {
							existing.userRating =
								existing.userRating != null
									? Math.max(existing.userRating, row.userRating)
									: row.userRating;
						}
						if (row.addedAt && (!existing.addedAt || row.addedAt < existing.addedAt)) {
							existing.addedAt = row.addedAt;
						}
					} else {
						map.set(key, {
							lastWatchedAt: row.lastWatchedAt,
							watchCount: row.watchCount,
							watchedByUsers: [...watchedByUsers],
							onDeck: row.onDeck,
							userRating: row.userRating,
							addedAt: row.addedAt,
						});
					}
				} catch (rowErr) {
					log.warn(
						{ err: rowErr, tmdbId: row.tmdbId },
						"Skipping Jellyfin cache row with bad data",
					);
				}
			}

			cursor = batch[batch.length - 1]!.id;
			if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
		}

		log.info(
			{ totalRows, totalEntries: map.size },
			"Jellyfin watch data prefetch complete for cleanup",
		);
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Jellyfin data for cleanup — Jellyfin rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Prefetch Jellyfin episode completion data.
 * Mirrors Plex pattern using JellyfinEpisodeCache with GROUP BY.
 */
async function prefetchJellyfinEpisodeData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexEpisodeMap | undefined> {
	const { prisma, log } = deps;

	try {
		const instances = await prisma.serviceInstance.findMany({
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] } },
			select: { id: true },
		});
		const instanceIds = instances.map((i) => i.id);
		if (instanceIds.length === 0) return new Map();

		const totalCounts = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { instanceId: { in: instanceIds } },
			_count: { id: true },
		});

		const watchedCounts = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { instanceId: { in: instanceIds }, watched: true },
			_count: { id: true },
		});

		const seasonTotals = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { instanceId: { in: instanceIds } },
			_count: { id: true },
		});

		const seasonWatched = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { instanceId: { in: instanceIds }, watched: true },
			_count: { id: true },
		});

		const seasonWatchedMap = new Map(
			seasonWatched.map((g) => [`${g.showTmdbId}:${g.seasonNumber}`, g._count.id]),
		);

		const showSeasonsMap = new Map<number, Map<number, { total: number; watched: number }>>();
		for (const g of seasonTotals) {
			let seasons = showSeasonsMap.get(g.showTmdbId);
			if (!seasons) {
				seasons = new Map();
				showSeasonsMap.set(g.showTmdbId, seasons);
			}
			seasons.set(g.seasonNumber, {
				total: g._count.id,
				watched: seasonWatchedMap.get(`${g.showTmdbId}:${g.seasonNumber}`) ?? 0,
			});
		}

		const watchedMap = new Map(watchedCounts.map((g) => [g.showTmdbId, g._count.id]));
		const map: PlexEpisodeMap = new Map();

		for (const group of totalCounts) {
			map.set(group.showTmdbId, {
				total: group._count.id,
				watched: watchedMap.get(group.showTmdbId) ?? 0,
				seasons: showSeasonsMap.get(group.showTmdbId) ?? new Map(),
			});
		}

		log.info({ totalShows: map.size }, "Jellyfin episode data prefetch complete for cleanup");
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Jellyfin episode data for cleanup — episode completion rules will be skipped",
		);
		return undefined;
	}
}

/**
 * Prefetch Plex episode completion data for series.
 * Uses SQL GROUP BY on PlexEpisodeCache to avoid loading all episodes into memory.
 * Returns a Map of showTmdbId → { total, watched }.
 */
async function prefetchPlexEpisodeData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexEpisodeMap | undefined> {
	const { prisma, log } = deps;

	try {
		const instances = await prisma.serviceInstance.findMany({
			where: { userId },
			select: { id: true },
		});
		const instanceIds = instances.map((i) => i.id);
		if (instanceIds.length === 0) return new Map();

		// Three groupBy queries: show-level totals, show-level watched, and per-season counts
		const totalCounts = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { instanceId: { in: instanceIds } },
			_count: { id: true },
		});

		const watchedCounts = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { instanceId: { in: instanceIds }, watched: true },
			_count: { id: true },
		});

		// Per-season counts for minSeason filtering
		const seasonTotals = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { instanceId: { in: instanceIds } },
			_count: { id: true },
		});

		const seasonWatched = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { instanceId: { in: instanceIds }, watched: true },
			_count: { id: true },
		});

		// Build per-season watched lookup: "showTmdbId:seasonNumber" → count
		const seasonWatchedMap = new Map(
			seasonWatched.map((g) => [`${g.showTmdbId}:${g.seasonNumber}`, g._count.id]),
		);

		// Build per-show season maps
		const showSeasonsMap = new Map<number, Map<number, { total: number; watched: number }>>();
		for (const g of seasonTotals) {
			let seasons = showSeasonsMap.get(g.showTmdbId);
			if (!seasons) {
				seasons = new Map();
				showSeasonsMap.set(g.showTmdbId, seasons);
			}
			seasons.set(g.seasonNumber, {
				total: g._count.id,
				watched: seasonWatchedMap.get(`${g.showTmdbId}:${g.seasonNumber}`) ?? 0,
			});
		}

		const watchedMap = new Map(watchedCounts.map((g) => [g.showTmdbId, g._count.id]));
		const map: PlexEpisodeMap = new Map();

		for (const group of totalCounts) {
			map.set(group.showTmdbId, {
				total: group._count.id,
				watched: watchedMap.get(group.showTmdbId) ?? 0,
				seasons: showSeasonsMap.get(group.showTmdbId) ?? new Map(),
			});
		}

		log.info({ totalShows: map.size }, "Plex episode data prefetch complete for cleanup");
		return map;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Plex episode data for cleanup — episode completion rules will be skipped",
		);
		return undefined;
	}
}

interface CleanupExemptionRule {
	id: string;
	document: RuleDocument;
	scope: CrossDomainRuleScope;
}

interface CleanupExemptionPolicy {
	globalBlock: boolean;
	rules: CleanupExemptionRule[];
	unusableScopes: CrossDomainRuleScope[];
}

function cleanupExemptionScopeApplies(
	scope: CrossDomainRuleScope,
	instanceId: string,
	instanceService: string,
): boolean {
	if (instanceService !== "SONARR" && instanceService !== "RADARR") return false;
	if (scope.instanceIds.length > 0 && !scope.instanceIds.includes(instanceId)) return false;
	if (
		scope.serviceTypes.length > 0 &&
		!scope.serviceTypes.includes(instanceService as "SONARR" | "RADARR")
	) {
		return false;
	}
	return true;
}

async function loadCleanupExemptionPolicy(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupExemptionPolicy> {
	const rows = await deps.prisma.crossDomainRule.findMany({
		where: {
			userId,
			deployedAt: { not: null },
		},
		select: { id: true, deployedDocument: true, deployedScope: true, deployedActions: true },
	});

	const policy: CleanupExemptionPolicy = {
		globalBlock: false,
		rules: [],
		unusableScopes: [],
	};

	for (const row of rows) {
		const parsedActions = crossDomainActionsSchema.safeParse(
			safeJsonParse(row.deployedActions ?? ""),
		);
		if (
			parsedActions.success &&
			!parsedActions.data.some((action) => action.type === "exempt_cleanup")
		) {
			continue;
		}

		const parsedScope = crossDomainRuleScopeSchema.safeParse(
			safeJsonParse(row.deployedScope ?? ""),
		);
		if (!parsedScope.success) {
			policy.globalBlock = true;
			deps.log.error(
				{ ruleId: row.id },
				"Blocking cleanup because a deployed cross-domain rule has unreadable exemption scope",
			);
			continue;
		}

		if (!parsedActions.success) {
			policy.unusableScopes.push(parsedScope.data);
			deps.log.error(
				{ ruleId: row.id },
				"Deployed cross-domain actions are invalid; their scope will fail closed",
			);
			continue;
		}

		const parsedDocument = ruleDocumentSchema.safeParse(safeJsonParse(row.deployedDocument ?? ""));
		if (!parsedDocument.success) {
			policy.unusableScopes.push(parsedScope.data);
			deps.log.error(
				{ ruleId: row.id },
				"Deployed cleanup exemption document is invalid; its scope will fail closed",
			);
			continue;
		}

		const predicates = [...walkPredicates(parsedDocument.data.root)];
		const invalidPredicate = predicates.some((predicate) => {
			if (!isKindLegalForContext("library-cleanup", predicate.kind)) return true;
			return !ruleParamSchemaMap[predicate.kind]?.safeParse(predicate.params).success;
		});
		if (predicates.length === 0 || invalidPredicate || validateV1Depth(parsedDocument.data)) {
			policy.unusableScopes.push(parsedScope.data);
			deps.log.error(
				{ ruleId: row.id },
				"Deployed cleanup exemption criteria are unavailable; their scope will fail closed",
			);
			continue;
		}

		policy.rules.push({
			id: row.id,
			document: parsedDocument.data,
			scope: parsedScope.data,
		});
	}

	return policy;
}

type ExemptionPredicateResult =
	| { state: "match"; reason: string }
	| { state: "no_match" }
	| { state: "unknown" };

const NON_AUTHORITATIVE_EXEMPTION_RULE_TYPES = new Set([
	"seerr_requested_by",
	"seerr_request_age",
	"seerr_request_status",
	"seerr_is_4k",
	"seerr_request_modified_age",
	"seerr_modified_by",
	"seerr_is_requested",
	"seerr_request_count",
	"seerr_requester_watched",
	"seerr_requester_not_watched",
	"plex_last_watched",
	"plex_watch_count",
	"plex_on_deck",
	"plex_user_rating",
	"plex_watched_by",
	"plex_collection",
	"plex_label",
	"plex_added_at",
	"plex_episode_completion",
	"user_retention",
	"staleness_score",
	"jellyfin_last_watched",
	"jellyfin_watch_count",
	"jellyfin_on_deck",
	"jellyfin_user_rating",
	"jellyfin_watched_by",
	"jellyfin_added_at",
	"jellyfin_episode_completion",
	"tmdb_list_member",
	"trakt_list_member",
]);

function cleanupPredicateHasAuthoritativeEvidence(
	item: CacheItemForEval,
	kind: string,
	params: Record<string, unknown>,
	authoritativeKinds?: ReadonlySet<string>,
): boolean {
	if (authoritativeKinds && !authoritativeKinds.has(kind)) return false;
	if (NON_AUTHORITATIVE_EXEMPTION_RULE_TYPES.has(kind)) return false;
	if (kind === "age" || kind === "recently_active") {
		return (
			item.arrAddedAt !== null && (kind !== "recently_active" || params.requireActivity !== true)
		);
	}
	if (kind === "year_range") return item.year !== null;
	if (kind === "status") return typeof item.status === "string" && item.status.length > 0;
	if (kind === "quality_profile") {
		return typeof item.qualityProfileName === "string" && item.qualityProfileName.length > 0;
	}
	if (kind === "size" || kind === "unmonitored" || kind === "no_file") return true;

	const data = safeJsonParse(item.data);
	if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
	const record = data as Record<string, unknown>;
	if (kind === "rating" || kind === "imdb_rating") return true;
	if (kind === "genre") return Array.isArray(record.genres);
	if (kind === "language") {
		return record.originalLanguage !== undefined || Array.isArray(record.languages);
	}
	if (kind === "runtime") {
		return (
			typeof record.runtime === "number" ||
			(typeof record.statistics === "object" &&
				record.statistics !== null &&
				typeof (record.statistics as Record<string, unknown>).runtime === "number")
		);
	}
	if (kind === "file_path") {
		if (params.field === "rootFolderPath") return typeof record.rootFolderPath === "string";
		const movieFile = record.movieFile as Record<string, unknown> | undefined;
		return (
			typeof record.path === "string" ||
			typeof movieFile?.path === "string" ||
			typeof record.folderName === "string"
		);
	}
	if (kind === "tag_match") return Array.isArray(record.tags);

	const file =
		typeof record.movieFile === "object" && record.movieFile !== null
			? (record.movieFile as Record<string, unknown>)
			: typeof record.episodeFile === "object" && record.episodeFile !== null
				? (record.episodeFile as Record<string, unknown>)
				: null;
	if (!file) return false;
	if (kind === "video_codec") return typeof file.videoCodec === "string";
	if (kind === "audio_codec") return typeof file.audioCodec === "string";
	if (kind === "audio_channels") {
		return typeof file.audioCodec === "string" && parseAudioChannels(file.audioCodec) !== null;
	}
	if (kind === "resolution") return typeof file.resolution === "string";
	if (kind === "hdr_type") {
		return (
			Object.hasOwn(file, "videoDynamicRange") &&
			(typeof file.videoDynamicRange === "string" || file.videoDynamicRange === null)
		);
	}
	if (kind === "custom_format_score") return typeof file.customFormatScore === "number";
	if (kind === "release_group") return typeof file.releaseGroup === "string";
	return false;
}

function evaluateCleanupExemptionNode(
	node: RuleNode,
	item: CacheItemForEval,
	ctx: EvalContext,
	authoritativeKinds?: ReadonlySet<string>,
): ExemptionPredicateResult {
	if (isRulePredicate(node)) {
		if (
			!cleanupPredicateHasAuthoritativeEvidence(item, node.kind, node.params, authoritativeKinds)
		) {
			return { state: "unknown" };
		}
		try {
			const reason = evaluateSingleCondition(item, node.kind, node.params, ctx, null);
			return reason === null ? { state: "no_match" } : { state: "match", reason };
		} catch {
			return { state: "unknown" };
		}
	}

	const children = groupChildren(node);
	if ("all" in node) {
		const reasons: string[] = [];
		let hasUnknown = false;
		for (const child of children) {
			const result = evaluateCleanupExemptionNode(child, item, ctx, authoritativeKinds);
			if (result.state === "no_match") return result;
			if (result.state === "unknown") hasUnknown = true;
			else reasons.push(result.reason);
		}
		return hasUnknown ? { state: "unknown" } : { state: "match", reason: reasons.join(" AND ") };
	}

	let hasUnknown = false;
	for (const child of children) {
		const result = evaluateCleanupExemptionNode(child, item, ctx, authoritativeKinds);
		if (result.state === "match") return result;
		if (result.state === "unknown") hasUnknown = true;
	}
	return hasUnknown ? { state: "unknown" } : { state: "no_match" };
}

function evaluateCleanupExemptionPolicy(
	policy: CleanupExemptionPolicy,
	item: CacheItemForEval,
	instanceService: string,
	ctx: EvalContext,
	authoritativeKinds?: ReadonlySet<string>,
): "allow" | "match" | "unknown" {
	if (policy.globalBlock) return "unknown";
	if (
		policy.unusableScopes.some((scope) =>
			cleanupExemptionScopeApplies(scope, item.instanceId, instanceService),
		)
	) {
		return "unknown";
	}
	for (const rule of policy.rules) {
		if (!cleanupExemptionScopeApplies(rule.scope, item.instanceId, instanceService)) continue;
		const result = evaluateCleanupExemptionNode(rule.document.root, item, ctx, authoritativeKinds);
		if (result.state === "match") return "match";
		if (result.state === "unknown") return "unknown";
	}
	return "allow";
}

const LIVE_DOCUMENT_EXEMPTION_KINDS = [
	"rating",
	"imdb_rating",
	"genre",
	"language",
	"runtime",
	"file_path",
	"tag_match",
	"video_codec",
	"audio_codec",
	"audio_channels",
	"resolution",
	"hdr_type",
	"custom_format_score",
	"release_group",
] as const;

function parseLiveDate(value: unknown): Date | null {
	if (!(value instanceof Date) && typeof value !== "string") return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function liveSizeValue(record: Record<string, unknown>): number | null {
	if (typeof record.sizeOnDisk === "number") return record.sizeOnDisk;
	const movieFile = record.movieFile as Record<string, unknown> | undefined;
	if (typeof movieFile?.size === "number") return movieFile.size;
	const statistics = record.statistics as Record<string, unknown> | undefined;
	return typeof statistics?.sizeOnDisk === "number" ? statistics.sizeOnDisk : null;
}

function normalizeLiveRadarrRecord(record: Record<string, unknown>): Record<string, unknown> {
	if (typeof record.movieFile !== "object" || record.movieFile === null) return record;

	const rawMovieFile = record.movieFile as Record<string, unknown>;
	const normalizedMovieFile = buildMovieFile(rawMovieFile);
	if (!normalizedMovieFile) return record;

	const mediaInfo =
		typeof rawMovieFile.mediaInfo === "object" && rawMovieFile.mediaInfo !== null
			? (rawMovieFile.mediaInfo as Record<string, unknown>)
			: null;
	const hasDynamicRangeEvidence =
		mediaInfo !== null && Object.hasOwn(mediaInfo, "videoDynamicRange");

	return {
		...record,
		movieFile: {
			...rawMovieFile,
			...normalizedMovieFile,
			videoDynamicRange: hasDynamicRangeEvidence
				? typeof mediaInfo.videoDynamicRange === "string"
					? mediaInfo.videoDynamicRange
					: null
				: undefined,
		},
	};
}

async function loadLiveCleanupExemptionItem(
	deps: CleanupExecutorDeps,
	instance: ServiceInstance,
	arrItemId: number,
	cachedItem: CacheItemForEval,
): Promise<{ item: CacheItemForEval; authoritativeKinds: Set<string> }> {
	const client = deps.arrClientFactory.create(instance);
	const live =
		instance.service === "RADARR"
			? await (client as InstanceType<typeof RadarrClient>).movie.getById(arrItemId)
			: instance.service === "SONARR"
				? await (client as InstanceType<typeof SonarrClient>).series.getById(arrItemId)
				: null;
	if (!live) throw new Error("Cleanup exemption authority requires a live ARR resource");

	const rawRecord = live as unknown as Record<string, unknown>;
	const record = instance.service === "RADARR" ? normalizeLiveRadarrRecord(rawRecord) : rawRecord;
	const statistics =
		typeof record.statistics === "object" && record.statistics !== null
			? (record.statistics as Record<string, unknown>)
			: null;
	const authoritativeKinds = new Set<string>(LIVE_DOCUMENT_EXEMPTION_KINDS);
	if (typeof record.year === "number") authoritativeKinds.add("year_range");
	if (typeof record.monitored === "boolean") authoritativeKinds.add("unmonitored");
	if (typeof record.hasFile === "boolean" || typeof statistics?.episodeFileCount === "number") {
		authoritativeKinds.add("no_file");
	}
	if (typeof record.status === "string" && record.status.length > 0) {
		authoritativeKinds.add("status");
	}
	const addedAt = parseLiveDate(record.added);
	if (addedAt) {
		authoritativeKinds.add("age");
		authoritativeKinds.add("recently_active");
	}
	const size = liveSizeValue(record);
	if (size !== null && Number.isFinite(size) && size >= 0) authoritativeKinds.add("size");

	let qualityProfileName: string | null = null;
	const qualityProfileId =
		typeof record.qualityProfileId === "number" ? record.qualityProfileId : null;
	if (qualityProfileId !== null) {
		try {
			const profile =
				instance.service === "RADARR"
					? await (client as InstanceType<typeof RadarrClient>).qualityProfile.getById(
							qualityProfileId,
						)
					: await (client as InstanceType<typeof SonarrClient>).qualityProfile.getById(
							qualityProfileId,
						);
			if (typeof profile.name === "string" && profile.name.length > 0) {
				qualityProfileName = profile.name;
				authoritativeKinds.add("quality_profile");
			}
		} catch (error) {
			deps.log.warn(
				{ err: error, instanceId: instance.id, qualityProfileId },
				"Cleanup could not load the live ARR quality profile for exemption evaluation",
			);
		}
	}

	const hasFile =
		typeof record.hasFile === "boolean"
			? record.hasFile
			: typeof statistics?.episodeFileCount === "number"
				? statistics.episodeFileCount > 0
				: false;
	return {
		item: {
			...cachedItem,
			title: typeof record.title === "string" ? record.title : cachedItem.title,
			year: typeof record.year === "number" ? record.year : null,
			monitored: typeof record.monitored === "boolean" ? record.monitored : false,
			hasFile,
			status: typeof record.status === "string" ? record.status : null,
			qualityProfileId,
			qualityProfileName,
			sizeOnDisk: BigInt(Math.trunc(size ?? 0)),
			arrAddedAt: addedAt,
			cachedAt: new Date(),
			data: JSON.stringify(record),
		},
		authoritativeKinds,
	};
}

async function assertCurrentCleanupExemptionAllowsMutation(
	deps: CleanupExecutorDeps,
	userId: string,
	instance: ServiceInstance,
	arrItemId: number,
	itemType: CacheItemForEval["itemType"],
): Promise<void> {
	let policy: CleanupExemptionPolicy;
	try {
		policy = await loadCleanupExemptionPolicy(deps, userId);
	} catch (error) {
		deps.log.error(
			{ err: error, instanceId: instance.id },
			"Cleanup could not reload deployed exemption policy before mutation",
		);
		throw new CleanupExemptionAuthorityError();
	}
	if (!policy.globalBlock && policy.unusableScopes.length === 0 && policy.rules.length === 0)
		return;

	let liveEvidence: Awaited<ReturnType<typeof loadLiveCleanupExemptionItem>>;
	try {
		const item = await deps.prisma.libraryCache.findFirst({
			where: { instanceId: instance.id, arrItemId, itemType },
		});
		if (!item) throw new Error("Cleanup exemption authority requires a current cache row");
		liveEvidence = await loadLiveCleanupExemptionItem(deps, instance, arrItemId, item);
	} catch (error) {
		deps.log.error(
			{ err: error, instanceId: instance.id },
			"Cleanup could not load live ARR evidence for deployed exemption policy",
		);
		throw new CleanupExemptionAuthorityError();
	}
	if (
		evaluateCleanupExemptionPolicy(
			policy,
			liveEvidence.item,
			instance.service,
			{ now: new Date() },
			liveEvidence.authoritativeKinds,
		) !== "allow"
	) {
		throw new CleanupExemptionAuthorityError();
	}
}

/**
 * Evaluate all LibraryCache items against the rule set.
 * Queries in batches to avoid memory issues with large libraries.
 * Uses collectActiveRuleTypes() to detect rule types inside composite conditions.
 *
 * Now tracks prefetch results for observability and aborts with "partial" status
 * when a failed data source has dependent rules that could produce false matches.
 */
async function evaluateAllItems(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig,
	rules: LibraryCleanupRule[],
): Promise<{
	flagged: FlaggedItem[];
	totalEvaluated: number;
	prefetchHealth: PrefetchResults;
	warnings: string[];
}> {
	const { prisma, log } = deps;
	const now = new Date();
	const warnings: string[] = [];

	// Load all user instances to map instanceId → service type
	const instances = await prisma.serviceInstance.findMany({
		where: { userId: config.userId },
	});
	const instanceServiceMap = new Map(instances.map((i) => [i.id, i.service]));
	const respectQuiSeeding = Boolean(config.respectQuiSeeding);
	const useCachedQuiSeedingGate =
		respectQuiSeeding &&
		instances.some((instance) => instance.service === "QUI" && instance.enabled);
	const persistedEpisodeRules = rules.filter((rule) => rule.targetScope === "episode");
	const seriesRules = rules.filter((rule) => rule.targetScope !== "episode");
	const episodeRules = rules.filter(isSupportedEpisodeCleanupRule);
	const unsupportedEpisodeRules = persistedEpisodeRules.filter(
		(rule) => rule.enabled && !isSupportedEpisodeCleanupRule(rule),
	);
	if (unsupportedEpisodeRules.length > 0) {
		warnings.push(
			`${unsupportedEpisodeRules.length} enabled episode-scoped cleanup ${unsupportedEpisodeRules.length === 1 ? "rule was" : "rules were"} skipped because ${unsupportedEpisodeRules.length === 1 ? "its" : "their"} persisted shape is unsupported.`,
		);
	}
	const exemptionPolicy = await loadCleanupExemptionPolicy(deps, config.userId);
	if (exemptionPolicy.globalBlock) {
		warnings.push(
			"Cleanup blocked because a deployed cross-domain rule could not be checked for cleanup exemptions.",
		);
	}
	if (exemptionPolicy.unusableScopes.length > 0) {
		warnings.push(
			"Cleanup candidates covered by an invalid or unavailable deployed exemption were blocked.",
		);
	}

	// Collect all active rule types (including inside composite conditions)
	const activeTypes = collectActiveRuleTypes(seriesRules);

	// Prefetch Seerr requests if any Seerr rule types are active
	const SEERR_RULE_TYPES = [
		"seerr_requested_by",
		"seerr_request_age",
		"seerr_request_status",
		"seerr_is_4k",
		"seerr_request_modified_age",
		"seerr_modified_by",
		"seerr_is_requested",
		"seerr_request_count",
		"seerr_requester_watched",
		"seerr_requester_not_watched",
	];
	const hasSeerrRules = SEERR_RULE_TYPES.some((t) => activeTypes.has(t));
	const seerrResult = hasSeerrRules ? await prefetchSeerrRequests(deps, config.userId) : undefined;
	const seerrMap = hasSeerrRules ? seerrResult : undefined;

	// Prefetch Plex watch data if any Plex rule types are active
	const PLEX_RULE_TYPES = [
		"plex_last_watched",
		"plex_watch_count",
		"plex_on_deck",
		"plex_user_rating",
		"plex_watched_by",
		"plex_collection",
		"plex_label",
		"plex_added_at",
		"plex_episode_completion",
		"user_retention",
		"staleness_score",
		"recently_active",
		"seerr_requester_watched",
		"seerr_requester_not_watched",
	];
	const hasPlexRules = PLEX_RULE_TYPES.some((t) => activeTypes.has(t));
	const plexResult = hasPlexRules ? await prefetchPlexData(deps, config.userId) : undefined;
	const plexMap = hasPlexRules ? plexResult : undefined;

	// Prefetch Jellyfin watch data if any Jellyfin rule types are active
	const JELLYFIN_RULE_TYPES = [
		"jellyfin_last_watched",
		"jellyfin_watch_count",
		"jellyfin_on_deck",
		"jellyfin_user_rating",
		"jellyfin_watched_by",
		"jellyfin_added_at",
	];
	const hasJellyfinRules = JELLYFIN_RULE_TYPES.some((t) => activeTypes.has(t));
	const jellyfinResult = hasJellyfinRules
		? await prefetchJellyfinData(deps, config.userId)
		: undefined;
	const jellyfinMap = hasJellyfinRules ? jellyfinResult : undefined;

	// Prefetch Plex episode data if episode completion rule is active
	const hasEpisodeRules = activeTypes.has("plex_episode_completion");
	const plexEpisodeMap = hasEpisodeRules
		? await prefetchPlexEpisodeData(deps, config.userId)
		: undefined;

	const hasJellyfinEpisodeRules = activeTypes.has("jellyfin_episode_completion");
	const jellyfinEpisodeMap = hasJellyfinEpisodeRules
		? await prefetchJellyfinEpisodeData(deps, config.userId)
		: undefined;

	// Prefetch TMDb/Trakt list memberships when list-membership kinds are
	// active (C3 closeout). Without this, the evaluator's permissive-null
	// would make list rules silently never match in cleanup runs — the
	// same maps auto-tag's executor builds for its own runs.
	const tmdbListMemberships = activeTypes.has("tmdb_list_member")
		? await prefetchCleanupListMemberships(deps, config.userId, rules, "tmdb")
		: undefined;
	const traktListMemberships = activeTypes.has("trakt_list_member")
		? await prefetchCleanupListMemberships(deps, config.userId, rules, "trakt")
		: undefined;

	// Build prefetch health status
	const prefetchHealth: PrefetchResults = {
		seerr: hasSeerrRules ? (seerrMap ? "ok" : "failed") : "skipped",
		plex: hasPlexRules ? (plexMap ? "ok" : "failed") : "skipped",
		jellyfin: hasJellyfinRules ? (jellyfinMap ? "ok" : "failed") : "skipped",
	};

	// Check for failed prefetches that have dependent rules — generate warnings
	const failedSources = new Set<DataSourceDependency>();
	if (prefetchHealth.seerr === "failed") failedSources.add("seerr");
	if (prefetchHealth.plex === "failed") failedSources.add("plex");
	if (prefetchHealth.jellyfin === "failed") failedSources.add("jellyfin");

	if (failedSources.size > 0) {
		for (const source of failedSources) {
			const affectedRules = rules
				.filter((r) => r.enabled && getRuleDataSources(r).has(source!))
				.map((r) => r.name);
			if (affectedRules.length > 0) {
				warnings.push(
					`${source} data unavailable — rules affected: ${affectedRules.join(", ")}. ` +
						`These rules were skipped for safety to prevent false matches.`,
				);
			}
		}
		log.warn(
			{ prefetchHealth, warnings },
			"Cleanup run has failed prefetches with dependent rules",
		);
	}

	// Build evaluation context
	const ctx: EvalContext = {
		now,
		seerrMap,
		plexMap,
		plexEpisodeMap,
		jellyfinMap,
		jellyfinEpisodeMap,
		tmdbListMemberships,
		traktListMemberships,
	};

	const flagged: FlaggedItem[] = [];
	let totalEvaluated = 0;
	let cursor: string | undefined;
	const freshEpisodeWatchMap =
		episodeRules.length > 0
			? await prefetchFreshPlexEpisodeWatchData(deps, instances, now, warnings)
			: new Map<string, EpisodePlexWatchEvidence[]>();
	const watchedEpisodeSeriesTmdbIds = new Set(
		[...freshEpisodeWatchMap.keys()].map((key) => Number.parseInt(key.split(":", 1)[0]!, 10)),
	);

	// Phase 2.2: optionally exclude items qui has confirmed are seeding,
	// to honor seeding obligations (private trackers, ratio targets). The
	// actual filter lives in `qui-filter.ts` — sibling pattern to
	// `lib/queue-cleaner/qui-gate.ts`. Keeping the filter in its own file
	// gives it a testable seam (see `__tests__/qui-filter.test.ts`) and
	// keeps cross-feature qui deps next to their consumer rather than
	// pulled into `lib/qui/` (which stays focused on the qui client).
	const baseWhere =
		episodeRules.length > 0
			? { instanceId: { in: instances.map((i) => i.id) } }
			: applyQuiSeedingFilter(
					{ instanceId: { in: instances.map((i) => i.id) } },
					useCachedQuiSeedingGate,
				);

	// Paginate through LibraryCache with cursor-based pagination
	while (true) {
		const batch: CacheItemForEval[] = await prisma.libraryCache.findMany({
			where: baseWhere,
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
				cachedAt: true,
				data: true,
				torrentState: true,
				infoHash: true,
			},
			take: CACHE_QUERY_BATCH_SIZE,
			...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
			orderBy: { id: "asc" },
		});

		if (batch.length === 0) break;

		for (const item of batch) {
			totalEvaluated++;
			const instanceService = instanceServiceMap.get(item.instanceId);
			if (!instanceService) continue; // Skip orphaned cache items with no matching instance

			const exemptionDecision = evaluateCleanupExemptionPolicy(
				exemptionPolicy,
				item,
				instanceService,
				ctx,
			);
			if (exemptionDecision !== "allow") {
				if (exemptionDecision === "unknown") {
					const warning =
						"Cleanup candidates covered by an exemption with unavailable evidence were blocked.";
					if (!warnings.includes(warning)) warnings.push(warning);
				}
				continue;
			}

			const match =
				useCachedQuiSeedingGate && isQuiSeedingState(item.torrentState)
					? null
					: evaluateItemAgainstRulesViaEngine(
							item,
							seriesRules,
							instanceService,
							ctx,
							failedSources,
						);
			if (match) {
				flagged.push({
					cacheItem: item,
					match,
					rating: extractRating(item),
				});
			}
			if (
				instanceService === "SONARR" &&
				item.itemType === "series" &&
				!match &&
				episodeRules.length > 0 &&
				!seriesRetentionProtectsEpisode(item, seriesRules, ctx, failedSources)
			) {
				const episodeMatches = await evaluateSeriesEpisodes(
					deps,
					item,
					instances.find((instance) => instance.id === item.instanceId),
					episodeRules,
					freshEpisodeWatchMap,
					watchedEpisodeSeriesTmdbIds,
					respectQuiSeeding,
					useCachedQuiSeedingGate,
					warnings,
				);
				totalEvaluated += episodeMatches.evaluated;
				flagged.push(...episodeMatches.flagged);
			}
		}

		cursor = batch[batch.length - 1]!.id;
		if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
	}

	return { flagged, totalEvaluated, prefetchHealth, warnings };
}

const PLEX_EPISODE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export function episodeCoordinateKey(
	showTmdbId: number,
	seasonNumber: number,
	episodeNumber: number,
): string {
	return `${showTmdbId}:${seasonNumber}:${episodeNumber}`;
}

export function extractSeriesTmdbId(data: string): number | null {
	const parsed = safeJsonParse(data) as {
		remoteIds?: { tmdbId?: unknown };
		tmdbId?: unknown;
	} | null;
	const value = parsed?.remoteIds?.tmdbId ?? parsed?.tmdbId;
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * Loads only complete, connection-bound episode evidence. Every Plex source
 * remains a separate witness: counts are never summed across servers or copies.
 */
export async function prefetchFreshPlexEpisodeWatchData(
	deps: CleanupExecutorDeps,
	instances: ServiceInstance[],
	now: Date,
	warnings: string[],
): Promise<Map<string, EpisodePlexWatchEvidence[]>> {
	const plexInstances = instances.filter(
		(instance) => instance.service === "PLEX" && instance.enabled,
	);
	if (plexInstances.length === 0) {
		warnings.push(
			"No enabled Plex instance was available; episode-scoped cleanup targets were skipped.",
		);
		return new Map();
	}
	const plexInstanceIds = plexInstances.map((instance) => instance.id);
	const plexUpdatedAtById = new Map(
		plexInstances.map((instance) => [instance.id, instance.updatedAt.getTime()]),
	);
	const plexFingerprintById = new Map(
		plexInstances.map((instance) => [instance.id, plexConnectionFingerprint(instance)]),
	);

	try {
		const rows = await deps.prisma.plexEpisodeCache.findMany({
			where: { instanceId: { in: plexInstanceIds }, watchCount: { gt: 0 } },
			select: {
				instanceId: true,
				showTmdbId: true,
				seasonNumber: true,
				episodeNumber: true,
				watchCount: true,
				lastWatchedAt: true,
				watchedByUsers: true,
				ratingKey: true,
				refreshedAt: true,
				sourceFingerprint: true,
			},
		});
		const result = new Map<string, EpisodePlexWatchEvidence[]>();
		let staleEvidenceCount = 0;
		let incompleteEvidenceCount = 0;
		const freshnessThreshold = now.getTime() - PLEX_EPISODE_FRESHNESS_MS;
		for (const row of rows) {
			if (
				row.watchCount === null ||
				row.refreshedAt === null ||
				typeof row.ratingKey !== "string" ||
				row.ratingKey.trim().length === 0
			) {
				incompleteEvidenceCount++;
				continue;
			}
			const sourceUpdatedAt = plexUpdatedAtById.get(row.instanceId);
			const sourceFingerprint = plexFingerprintById.get(row.instanceId);
			if (
				sourceUpdatedAt === undefined ||
				!Number.isFinite(sourceUpdatedAt) ||
				!sourceFingerprint ||
				row.sourceFingerprint !== sourceFingerprint ||
				row.refreshedAt.getTime() < freshnessThreshold ||
				row.refreshedAt.getTime() < sourceUpdatedAt
			) {
				staleEvidenceCount++;
				continue;
			}
			const parsedUsers = safeJsonParse(row.watchedByUsers);
			const watchedByUsers = Array.isArray(parsedUsers)
				? parsedUsers.filter((user): user is string => typeof user === "string")
				: [];
			const key = episodeCoordinateKey(row.showTmdbId, row.seasonNumber, row.episodeNumber);
			const evidence: EpisodePlexWatchEvidence = {
				plexInstanceId: row.instanceId,
				sourceFingerprint,
				ratingKey: row.ratingKey,
				watchCount: row.watchCount,
				lastWatchedAt: row.lastWatchedAt,
				watchedByUsers,
				refreshedAt: row.refreshedAt,
			};
			const current = result.get(key) ?? [];
			current.push(evidence);
			current.sort(
				(left, right) =>
					right.watchCount - left.watchCount ||
					left.plexInstanceId.localeCompare(right.plexInstanceId),
			);
			result.set(key, current);
		}
		if (staleEvidenceCount > 0) {
			warnings.push(
				`${staleEvidenceCount} stale Plex episode watch entr${staleEvidenceCount === 1 ? "y was" : "ies were"} ignored; only evidence refreshed within 24 hours can authorize episode cleanup.`,
			);
		}
		if (incompleteEvidenceCount > 0) {
			warnings.push(
				`${incompleteEvidenceCount} incomplete Plex episode watch entr${incompleteEvidenceCount === 1 ? "y was" : "ies were"} ignored because its source, rating key, watch count, or refresh timestamp could not be proven.`,
			);
		}
		if (result.size === 0) {
			warnings.push(
				"No fresh, complete Plex episode watch evidence was available; episode-scoped cleanup targets were skipped.",
			);
		}
		return result;
	} catch (error) {
		deps.log.error({ err: error }, "Failed to load fresh Plex episode watch data");
		warnings.push(
			"Plex episode watch data was unavailable or stale; episode-scoped rules were skipped for safety.",
		);
		return new Map();
	}
}

async function evaluateSeriesEpisodes(
	deps: CleanupExecutorDeps,
	item: CacheItemForEval,
	instance: ServiceInstance | undefined,
	episodeRules: LibraryCleanupRule[],
	watchMap: Map<string, EpisodePlexWatchEvidence[]>,
	watchedSeriesTmdbIds: Set<number>,
	respectQuiSeeding: boolean,
	useCachedQuiSeedingGate: boolean,
	warnings: string[],
): Promise<{ evaluated: number; flagged: FlaggedItem[] }> {
	if (!instance) return { evaluated: 0, flagged: [] };
	const tmdbId = extractSeriesTmdbId(item.data);
	if (tmdbId === null || !watchedSeriesTmdbIds.has(tmdbId)) return { evaluated: 0, flagged: [] };
	const applicableRules = episodeRules.filter(
		(rule) =>
			passesServiceFilter("SONARR", rule.serviceFilter) &&
			passesInstanceFilter(item.instanceId, rule.instanceFilter) &&
			passesTagExclusion(item, rule.excludeTags) &&
			passesTitleExclusion(item.title, rule.excludeTitles),
	);
	if (applicableRules.length === 0) return { evaluated: 0, flagged: [] };

	let rawEpisodes: Array<Record<string, unknown>>;
	try {
		const sonarr = deps.arrClientFactory.create(instance) as InstanceType<typeof SonarrClient>;
		rawEpisodes = (await sonarr.episode.getAll({
			seriesId: item.arrItemId,
			includeEpisodeFile: true,
		})) as Array<Record<string, unknown>>;
	} catch (error) {
		deps.log.error(
			{ err: error, instanceId: item.instanceId, arrItemId: item.arrItemId },
			"Failed to load live Sonarr episode inventory for episode cleanup",
		);
		warnings.push(
			"Live Sonarr episode inventory was unavailable for one cleanup candidate; its episodes were skipped.",
		);
		return { evaluated: 0, flagged: [] };
	}

	const fileRows = await deps.prisma.episodeFileCache.findMany({
		where: { instanceId: item.instanceId, arrSeriesId: item.arrItemId },
		select: { arrEpisodeFileId: true, path: true, size: true, infoHash: true, torrentState: true },
	});
	const filesById = new Map(fileRows.map((file) => [file.arrEpisodeFileId, file]));
	const consumerIdsByFile = new Map<number, number[]>();
	for (const raw of rawEpisodes) {
		if (
			typeof raw.id === "number" &&
			Number.isSafeInteger(raw.id) &&
			raw.id > 0 &&
			typeof raw.episodeFileId === "number" &&
			Number.isSafeInteger(raw.episodeFileId) &&
			raw.episodeFileId > 0
		) {
			const consumers = consumerIdsByFile.get(raw.episodeFileId) ?? [];
			consumers.push(raw.id);
			consumerIdsByFile.set(raw.episodeFileId, consumers);
		}
	}

	const flagged: FlaggedItem[] = [];
	let evaluated = 0;
	for (const raw of rawEpisodes) {
		const { id: arrEpisodeId, seasonNumber, episodeNumber, episodeFileId } = raw;
		if (
			typeof arrEpisodeId !== "number" ||
			!Number.isSafeInteger(arrEpisodeId) ||
			arrEpisodeId <= 0 ||
			typeof seasonNumber !== "number" ||
			!Number.isSafeInteger(seasonNumber) ||
			seasonNumber < 0 ||
			typeof episodeNumber !== "number" ||
			!Number.isSafeInteger(episodeNumber) ||
			episodeNumber <= 0 ||
			typeof episodeFileId !== "number" ||
			!Number.isSafeInteger(episodeFileId) ||
			episodeFileId <= 0 ||
			typeof raw.monitored !== "boolean"
		) {
			continue;
		}
		const evidence = watchMap.get(episodeCoordinateKey(tmdbId, seasonNumber, episodeNumber));
		const file = filesById.get(episodeFileId);
		if (!evidence?.length || !file) continue;
		if (useCachedQuiSeedingGate && isQuiSeedingState(file.torrentState)) {
			warnings.push(
				`Episode S${seasonNumber}E${episodeNumber} was skipped because its exact file has an active qUI state.`,
			);
			continue;
		}
		evaluated++;
		const candidate: EpisodeCleanupCandidate = {
			instanceId: item.instanceId,
			arrSeriesId: item.arrItemId,
			arrEpisodeId,
			seasonNumber,
			episodeNumber,
			episodeFileId,
			episodeFileConsumerIds: [...(consumerIdsByFile.get(episodeFileId) ?? [])].sort(
				(left, right) => left - right,
			),
			seriesTitle: item.title,
			episodeTitle: typeof raw.title === "string" && raw.title.trim() ? raw.title : "Episode",
			monitored: raw.monitored,
			respectQuiSeeding,
			watchCount: evidence[0]!.watchCount,
			lastWatchedAt: evidence[0]!.lastWatchedAt,
			watchedByUsers: evidence[0]!.watchedByUsers,
			plexWatchEvidence: evidence,
			file: {
				arrEpisodeFileId: file.arrEpisodeFileId,
				path: file.path,
				size: file.size,
				infoHash: file.infoHash,
				torrentState: file.torrentState,
			},
		};
		for (const rule of applicableRules) {
			const parameters = safeJsonParse(rule.parameters) as { count?: unknown } | null;
			if (typeof parameters?.count !== "number" || !Number.isFinite(parameters.count)) continue;
			const watchCountThreshold = parameters.count;
			const qualifyingEvidence = evidence.filter(
				(witness) => witness.watchCount > watchCountThreshold,
			);
			if (qualifyingEvidence.length === 0) continue;
			const ruleCandidate: EpisodeCleanupCandidate = {
				...candidate,
				watchCount: qualifyingEvidence[0]!.watchCount,
				lastWatchedAt: qualifyingEvidence[0]!.lastWatchedAt,
				watchedByUsers: qualifyingEvidence[0]!.watchedByUsers,
				plexWatchEvidence: qualifyingEvidence,
			};
			const match = evaluateEpisodeWatchCountRule(ruleCandidate, rule);
			if (!match) continue;
			flagged.push({
				cacheItem: { ...item, sizeOnDisk: file.size },
				match,
				rating: extractRating(item),
				episodeTarget: toEpisodeTargetMetadata(ruleCandidate),
			});
			break;
		}
	}
	return { evaluated, flagged };
}

/** A matching parent retention rule protects every child episode candidate. */
export function seriesRetentionProtectsEpisode(
	item: CacheItemForEval,
	seriesRules: LibraryCleanupRule[],
	ctx: EvalContext,
	failedSources: Set<DataSourceDependency>,
): boolean {
	return seriesRules.some(
		(rule) =>
			rule.retentionMode &&
			passesCleanupRuleFilters(item, rule, "SONARR") &&
			(ruleUsesUnavailableData(rule, failedSources) ||
				evaluateRuleViaEngine(item, rule, "SONARR", ctx) !== null),
	);
}

/**
 * Get all data sources a rule depends on (including composite sub-conditions).
 */
function getRuleDataSources(rule: LibraryCleanupRule): Set<DataSourceDependency> {
	const sources = new Set<DataSourceDependency>();
	const dep = ruleDataSourceMap[rule.ruleType];
	if (dep) sources.add(dep);
	if (rule.conditions) {
		const conds = safeJsonParse(rule.conditions) as Array<{ ruleType?: string }> | null;
		if (Array.isArray(conds)) {
			for (const c of conds) {
				const cdep = c.ruleType ? ruleDataSourceMap[c.ruleType] : undefined;
				if (cdep) sources.add(cdep);
			}
		}
	}
	return sources;
}

function buildApprovalDedupSkipReason(
	status: string,
	memWindow: RejectionMemoryWindow,
): string | undefined {
	if (status !== "rejected") return undefined;
	if (memWindow.mode === "forever") {
		return "Previously rejected — rejection memory: forever";
	}
	if (memWindow.mode === "days") {
		return `Previously rejected — rejection memory: ${memWindow.days} day${memWindow.days === 1 ? "" : "s"}`;
	}
	return undefined;
}

async function selectApprovalCandidatesBeforeLimit(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	userId: string,
	flagged: FlaggedItem[],
	limit: number,
): Promise<{
	selected: FlaggedItem[];
	skippedDetails: CleanupRunResult["details"];
}> {
	const memoryByRuleId = new Map<string, RejectionMemoryWindow>();
	for (const rule of config.rules) {
		memoryByRuleId.set(rule.id, resolveRejectionMemoryWindow(rule, config));
	}

	const remembersForever = [...memoryByRuleId.values()].some((window) => window.mode === "forever");
	const maxRememberedDays = Math.max(
		0,
		...[...memoryByRuleId.values()]
			.filter((window): window is Extract<RejectionMemoryWindow, { mode: "days" }> => {
				return window.mode === "days";
			})
			.map((window) => window.days),
	);
	const now = new Date();
	const approvalDedupRows = await deps.prisma.libraryCleanupApproval.findMany({
		where: {
			configId: config.id,
			config: { userId },
			OR: [
				{ status: "pending" },
				...(remembersForever
					? [{ status: "rejected" }]
					: maxRememberedDays > 0
						? [
								{
									status: "rejected",
									reviewedAt: {
										gt: new Date(now.getTime() - maxRememberedDays * 24 * 60 * 60 * 1000),
									},
								},
							]
						: []),
			],
		},
		select: {
			instanceId: true,
			arrItemId: true,
			itemType: true,
			status: true,
			reviewedAt: true,
		},
	});
	const approvalDedupRowsByTarget = new Map<string, typeof approvalDedupRows>();
	for (const row of approvalDedupRows) {
		const targetKey = cleanupDeleteTargetKey(row);
		const rows = approvalDedupRowsByTarget.get(targetKey);
		if (rows) rows.push(row);
		else approvalDedupRowsByTarget.set(targetKey, [row]);
	}

	const selected: FlaggedItem[] = [];
	const skippedDetails: CleanupRunResult["details"] = [];
	for (const item of flagged) {
		if (selected.length >= limit) break;
		const memWindow = memoryByRuleId.get(item.match.ruleId) ?? { mode: "off" as const };
		const targetRows = approvalDedupRowsByTarget.get(cleanupDeleteTargetKey(item.cacheItem)) ?? [];
		const existing = targetRows.find((row) => {
			if (row.status === "pending") return true;
			if (row.status !== "rejected") return false;
			if (memWindow.mode === "forever") return true;
			if (memWindow.mode === "days" && row.reviewedAt) {
				return row.reviewedAt > new Date(now.getTime() - memWindow.days * 24 * 60 * 60 * 1000);
			}
			return false;
		});
		if (existing) {
			skippedDetails.push(
				buildDetail(item, "skipped", buildApprovalDedupSkipReason(existing.status, memWindow)),
			);
			continue;
		}
		selected.push(item);
	}
	return { selected, skippedDetails };
}

/**
 * Create approval queue entries for flagged items.
 * Stores the action from each rule match on the approval record.
 */
async function executeWithApproval(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	flagged: FlaggedItem[],
	totalEvaluated: number,
	totalFlaggedBeforeLimit: number,
	startTime: number,
	prefetchHealth?: PrefetchResults,
	warnings?: string[],
	sharedPlexBlocks: Map<string, string> = new Map(),
	safetyPlans: Map<string, SharedMediaSafetyPlan> = new Map(),
	preSkippedDetails: CleanupRunResult["details"] = [],
): Promise<CleanupRunResult> {
	const { prisma, log } = deps;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

	const details: CleanupRunResult["details"] = [...preSkippedDetails];
	let queued = 0;
	let approvalDedupSkipped = 0;
	let approvalQueueFailures = 0;

	// Precompute rejection-memory window per rule once. The window is the same
	// for every flagged item that matched the same rule, so resolving once
	// avoids O(rules × items) lookups inside the queue loop (issue #474).
	const memoryByRuleId = new Map<string, RejectionMemoryWindow>();
	for (const rule of config.rules) {
		memoryByRuleId.set(rule.id, resolveRejectionMemoryWindow(rule, config));
	}

	for (const item of flagged) {
		const targetKey = cleanupDeleteTargetKey(item.cacheItem);
		const sharedPlexBlock = sharedPlexBlocks.get(targetKey);
		if (sharedPlexBlock) {
			details.push(buildDetail(item, "skipped", sharedPlexBlock));
			log.warn(
				{ title: item.cacheItem.title, instanceId: item.cacheItem.instanceId },
				"Cleanup approval item blocked by shared-media safety check",
			);
			continue;
		}

		try {
			const memWindow = memoryByRuleId.get(item.match.ruleId) ?? { mode: "off" as const };

			// Dedup query: always skip pending approvals; additionally skip
			// rejected approvals when the rule's memory window says so (#474).
			const orClauses = buildDedupOrClauses(memWindow);

			const existing = await prisma.libraryCleanupApproval.findFirst({
				where: {
					configId: config.id,
					config: { userId: config.userId },
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					itemType: item.cacheItem.itemType,
					OR: orClauses,
				},
			});

			if (existing) {
				details.push(
					buildDetail(item, "skipped", buildApprovalDedupSkipReason(existing.status, memWindow)),
				);
				approvalDedupSkipped++;
				continue;
			}

			await prisma.libraryCleanupApproval.create({
				data: {
					configId: config.id,
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					itemType: item.cacheItem.itemType,
					title: item.cacheItem.title,
					matchedRuleId: item.match.ruleId,
					matchedRuleName: item.match.ruleName,
					reason: item.match.reason,
					action: item.match.action,
					sizeOnDisk: item.cacheItem.sizeOnDisk,
					year: item.cacheItem.year,
					rating: item.rating,
					status: "pending",
					safetySnapshot: serializeExecutableSafetyPlan(
						asExecutableSafetyPlan(safetyPlans.get(targetKey)) ??
							(() => {
								throw new Error("No executable cleanup safety plan was produced");
							})(),
					),
					expiresAt,
				},
			});

			details.push(buildDetail(item, "queued_for_approval"));
			queued++;
		} catch (error) {
			log.error(
				{ err: error, title: item.cacheItem.title },
				"Failed to create cleanup approval entry",
			);
			details.push(buildDetail(item, "skipped", `Failed to queue: ${getErrorMessage(error)}`));
			approvalQueueFailures++;
		}
	}

	const hasFailedPrefetch = warnings && warnings.length > 0;
	const result: CleanupRunResult = {
		isDryRun: false,
		status: hasFailedPrefetch || approvalQueueFailures > 0 ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: queued,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped:
			totalFlaggedBeforeLimit -
			flagged.length +
			sharedPlexBlocks.size +
			approvalDedupSkipped +
			approvalQueueFailures,
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings,
	};

	await createRunLog(prisma, config.id, result, log);
	return result;
}

/**
 * Directly execute flagged items on ARR instances.
 * Dispatches on each item's action (delete, unmonitor, delete_files).
 */
export async function executeDirectRemoval(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	userId: string,
	flagged: FlaggedItem[],
	totalEvaluated: number,
	totalFlaggedBeforeLimit: number,
	startTime: number,
	prefetchHealth?: PrefetchResults,
	warnings?: string[],
	sharedPlexBlocks: Map<string, string> = new Map(),
	assertRunLease?: () => Promise<void>,
): Promise<CleanupRunResult> {
	const { prisma, arrClientFactory, log } = deps;

	const details: CleanupRunResult["details"] = [];
	let removed = 0;
	let unmonitored = 0;
	let filesDeleted = 0;
	let consecutiveFailures = 0;
	let circuitBroken = false;
	let runtimeSafetyBlocks = 0;
	let exemptionPolicyBlocks = 0;
	let partialArrDeletes = 0;
	let instanceLookupFailures = 0;
	let invalidMutationTargets = 0;
	let directRetryFailures = 0;
	let directRetryConcurrent = 0;
	let directIntentConcurrent = 0;
	let directRetryExpired = 0;
	let directRetryRecordingFailures = 0;
	let directRetryLoadFailures = 0;
	let directRetryExecutionFailures = 0;
	let directRetryPersistenceFailures = 0;
	let directRetryReconciled = 0;
	let directRetryFairnessDeferred = 0;
	let retriedRemoved = 0;
	let retriedUnmonitored = 0;
	let retriedFilesDeleted = 0;
	let directRetryCount = 0;
	let directRetryMutationBudgetConsumed = 0;
	const sharedPlexSafetyContext = createSharedPlexSafetyContext();
	const directRetryTargetKeys = new Set<string>();
	const selectedDirectRetryTargetKeys = new Set<string>();
	const inFlightDirectRetryTargetKeys = new Set<string>();
	const configuredRunLimitIsValid =
		Number.isSafeInteger(config.maxRemovalsPerRun) &&
		config.maxRemovalsPerRun > 0 &&
		config.maxRemovalsPerRun <= 100;
	const configuredRunLimit = configuredRunLimitIsValid ? config.maxRemovalsPerRun : 0;

	let directRetries: Awaited<ReturnType<typeof prisma.libraryCleanupApproval.findMany>> = [];
	let fairnessDeferredRetries: typeof directRetries = [];
	let previousRunStartedAt: Date | undefined;
	try {
		const previousRun = await prisma.libraryCleanupLog.findFirst({
			where: {
				configId: config.id,
				isDryRun: false,
				completedAt: { not: null },
			},
			orderBy: { startedAt: "desc" },
			select: { startedAt: true },
		});
		previousRunStartedAt = previousRun?.startedAt;
	} catch (error) {
		log.warn(
			{ err: error, configId: config.id },
			"Cleanup could not load its prior run boundary for retry fairness",
		);
	}
	try {
		const nonterminalRetryTargets = await prisma.libraryCleanupApproval.findMany({
			where: {
				configId: config.id,
				config: { userId },
				status: { in: ["retry_pending", "retry_executing"] },
			},
			select: {
				instanceId: true,
				arrItemId: true,
				itemType: true,
			},
		});
		const loadedDirectRetries = await prisma.libraryCleanupApproval.findMany({
			where: {
				configId: config.id,
				config: { userId },
				status: "retry_pending",
			},
			orderBy: [{ reviewedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
			take: configuredRunLimit,
		});
		const executingDirectRetries = await prisma.libraryCleanupApproval.findMany({
			where: {
				configId: config.id,
				config: { userId },
				status: "retry_executing",
			},
		});
		for (const retry of executingDirectRetries) {
			const targetKey = cleanupDeleteTargetKey(retry);
			directRetryTargetKeys.add(targetKey);
			inFlightDirectRetryTargetKeys.add(targetKey);
		}
		for (const retry of loadedDirectRetries) {
			directRetryTargetKeys.add(cleanupDeleteTargetKey(retry));
		}
		for (const retryTarget of nonterminalRetryTargets) {
			directRetryTargetKeys.add(cleanupDeleteTargetKey(retryTarget));
		}
		const hasDistinctFreshCandidate = flagged.some(
			(item) => !directRetryTargetKeys.has(cleanupDeleteTargetKey(item.cacheItem)),
		);
		if (previousRunStartedAt && hasDistinctFreshCandidate) {
			fairnessDeferredRetries = loadedDirectRetries.filter(
				(retry) => retry.reviewedAt && retry.reviewedAt >= previousRunStartedAt,
			);
		}
		const fairnessDeferredIds = new Set(fairnessDeferredRetries.map((retry) => retry.id));
		directRetries = loadedDirectRetries.filter((retry) => !fairnessDeferredIds.has(retry.id));
		directRetryFairnessDeferred = fairnessDeferredRetries.length;
		directRetryCount = loadedDirectRetries.length;
	} catch (error) {
		directRetryLoadFailures++;
		log.error({ err: error, configId: config.id }, "Cleanup could not load durable ARR retries");
	}

	for (const retry of fairnessDeferredRetries) {
		details.push(
			buildRetryDetail(
				retry,
				"skipped",
				"Deferred for one run after its previous attempt so fresh cleanup work can make progress",
			),
		);
	}

	for (const retry of directRetries) {
		const targetKey = cleanupDeleteTargetKey(retry);
		selectedDirectRetryTargetKeys.add(targetKey);
		try {
			const retryResult = await executeQueuedCleanupItems(deps, userId, [retry.id], {
				claimStatus: "retry_pending",
				executeStatus: "retry_executing",
				retryStatus: "retry_pending",
				enforceExpiry: false,
				assertExecutionAllowed: assertRunLease,
			});
			if (retryResult.mutationBudgetConsumedIds.includes(retry.id)) {
				directRetryMutationBudgetConsumed++;
			}
			if (retryResult.unclaimedIds.includes(retry.id)) {
				directRetryConcurrent++;
				details.push(
					buildRetryDetail(
						retry,
						"skipped",
						"Deferred: another cleanup run claimed this durable record-only retry",
					),
				);
			} else if (retryResult.reconciledIds.includes(retry.id)) {
				directRetryReconciled++;
				if (retryResult.recordingFailureIds.includes(retry.id)) {
					directRetryRecordingFailures++;
				}
				details.push(
					buildRetryDetail(
						retry,
						"skipped",
						retryResult.recordingFailureIds.includes(retry.id)
							? "The ARR mutation was already reflected in live state, but durable reconciliation state could not be recorded."
							: "Reconciled a durable retry because its ARR mutation was already reflected in live state; no mutation was attributed to this run.",
					),
				);
			} else if (retryResult.removed === 1 && retryResult.failed === 0) {
				if (retry.action === "unmonitor") {
					unmonitored++;
					retriedUnmonitored++;
					details.push(
						buildRetryDetail(retry, "unmonitored", "Completed a prior durable mutation retry"),
					);
				} else if (retry.action === "delete_files") {
					filesDeleted++;
					retriedFilesDeleted++;
					details.push(
						buildRetryDetail(retry, "files_deleted", "Completed a prior durable mutation retry"),
					);
				} else {
					removed++;
					retriedRemoved++;
					details.push(
						buildRetryDetail(retry, "removed", "Completed a prior durable mutation retry"),
					);
				}
			} else if (retryResult.expiredIds.includes(retry.id)) {
				directRetryExpired++;
				details.push(
					buildRetryDetail(
						retry,
						"skipped",
						retryResult.errors[0] ??
							"Record-only cleanup retry expired because its ARR target identity changed.",
					),
				);
			} else if (retryResult.recordingFailureIds.includes(retry.id)) {
				directRetryRecordingFailures++;
				const recordingFailureReason =
					retryResult.errors[0] ??
					"Cleanup completed, but its durable state could not be recorded.";
				if (retry.action === "unmonitor") {
					unmonitored++;
					retriedUnmonitored++;
					details.push(buildRetryDetail(retry, "unmonitored", recordingFailureReason));
				} else if (retry.action === "delete_files") {
					filesDeleted++;
					retriedFilesDeleted++;
					details.push(buildRetryDetail(retry, "files_deleted", recordingFailureReason));
				} else {
					removed++;
					retriedRemoved++;
					details.push(buildRetryDetail(retry, "removed", recordingFailureReason));
				}
			} else if (retryResult.confirmedPartialFileDeletionIds.includes(retry.id)) {
				directRetryFailures++;
				filesDeleted++;
				retriedFilesDeleted++;
				details.push(
					buildRetryDetail(
						retry,
						"files_deleted",
						retryResult.errors[0] ??
							"Verified ARR files were deleted, but the remaining cleanup mutation is still pending.",
					),
				);
			} else {
				directRetryFailures++;
				details.push(
					buildRetryDetail(
						retry,
						"skipped",
						retryResult.errors[0] ?? "Record-only cleanup retry could not be completed safely.",
					),
				);
			}
		} catch (error) {
			if (error instanceof CleanupRunLeaseLostError) throw error;
			directRetryExecutionFailures++;
			details.push(
				buildRetryDetail(
					retry,
					"skipped",
					"Deferred: arr-dashboard could not inspect this retry after claiming it; automatic recovery will make it retryable again.",
				),
			);
			log.error(
				{ err: error, retryId: retry.id, instanceId: retry.instanceId },
				"Cleanup record-only retry failed after its claim and will require recovery",
			);
		}
	}

	const freshCandidates = flagged.filter((item) => {
		if (!directRetryTargetKeys.has(cleanupDeleteTargetKey(item.cacheItem))) return true;
		return false;
	});
	const inFlightDeferredItems = flagged.filter(
		(item) =>
			!(
				selectedDirectRetryTargetKeys.has(cleanupDeleteTargetKey(item.cacheItem)) ||
				!inFlightDirectRetryTargetKeys.has(cleanupDeleteTargetKey(item.cacheItem))
			),
	);
	for (const item of inFlightDeferredItems) {
		details.push(
			buildDetail(
				item,
				"skipped",
				"Deferred: a durable record-only cleanup retry for this ARR target is already executing",
			),
		);
	}
	// Only retries that reached an ARR write consume the current run budget.
	// Successful, partial, and indeterminate writes all count because ARR may
	// have changed. reviewedAt plus the prior run boundary defers a just-tried
	// retry for one later run when distinct fresh work exists.
	const freshBudget = Math.max(0, configuredRunLimit - directRetryMutationBudgetConsumed);
	const freshItems = freshCandidates.slice(0, freshBudget);
	const budgetDeferredItems = freshCandidates.length - freshItems.length;

	for (const item of freshItems) {
		if (directRetryLoadFailures > 0) {
			details.push(
				buildDetail(
					item,
					"skipped",
					"Skipped: durable record-only cleanup retries could not be loaded safely",
				),
			);
			continue;
		}
		// Circuit breaker: abort after N consecutive failures
		if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
			circuitBroken = true;
			log.error(
				{ consecutiveFailures, remainingItems: flagged.length - details.length },
				"Circuit breaker triggered: aborting cleanup after consecutive ARR API failures",
			);
			// Skip remaining items
			details.push(
				buildDetail(
					item,
					"skipped",
					`Skipped: circuit breaker triggered after ${CIRCUIT_BREAKER_THRESHOLD} consecutive failures`,
				),
			);
			continue;
		}

		let instance: ServiceInstance | null = null;
		try {
			instance = await prisma.serviceInstance.findFirst({
				where: { id: item.cacheItem.instanceId, userId },
			});
		} catch (error) {
			log.error(
				{ err: error, instanceId: item.cacheItem.instanceId },
				"Cleanup could not load ARR instance; item was skipped",
			);
		}
		if (!instance) {
			instanceLookupFailures++;
			details.push(
				buildDetail(item, "skipped", "Skipped: the ARR instance could not be loaded safely"),
			);
			continue;
		}

		let ruleAction: RuleAction;
		try {
			ruleAction = validateCleanupMutationShape(
				instance,
				item.cacheItem.itemType,
				item.match.action,
			);
		} catch (error) {
			invalidMutationTargets++;
			log.error(
				{ err: error, instanceId: instance.id, arrItemId: item.cacheItem.arrItemId },
				"Cleanup item has an invalid mutation shape; item was skipped",
			);
			details.push(
				buildDetail(item, "skipped", "Skipped: stored cleanup action or media type is invalid"),
			);
			continue;
		}

		const targetKey = cleanupDeleteTargetKey(item.cacheItem);
		let sharedPlexBlock = sharedPlexBlocks.get(targetKey);
		let safetyPlan: SharedMediaSafetyPlan | undefined;
		try {
			const freshBlocks = await findSharedPlexDeleteBlocks(
				deps,
				userId,
				[
					{
						instanceId: item.cacheItem.instanceId,
						arrItemId: item.cacheItem.arrItemId,
						itemType: item.cacheItem.itemType,
						action: ruleAction,
					},
				],
				sharedPlexSafetyContext,
			);
			await blockPlansThatDifferFromEvaluatedCache(
				deps,
				userId,
				[item],
				sharedPlexSafetyContext,
				freshBlocks,
			);
			sharedPlexBlock = freshBlocks.get(targetKey);
			safetyPlan = sharedPlexSafetyContext.plans.get(targetKey);
		} catch (error) {
			log.error(
				{ err: error, title: item.cacheItem.title, instanceId: item.cacheItem.instanceId },
				"Cleanup deletion safety preflight failed closed",
			);
			sharedPlexBlock =
				"Skipped for safety: arr-dashboard could not complete the live ARR and media-server preflight.";
		}
		if (!sharedPlexBlock && !safetyPlan) {
			sharedPlexBlock =
				"Skipped for safety: arr-dashboard did not produce an explicit ARR mutation safety plan.";
		}
		if (sharedPlexBlock) {
			runtimeSafetyBlocks++;
			details.push(buildDetail(item, "skipped", sharedPlexBlock));
			log.warn(
				{ title: item.cacheItem.title, instanceId: item.cacheItem.instanceId },
				"Cleanup deletion blocked by shared-media safety check",
			);
			continue;
		}

		let directMutationIntentId: string;
		let directMutationExecutionToken: string;
		try {
			const intent = await persistAndClaimDirectMutationIntent(
				deps,
				config,
				userId,
				item,
				safetyPlan!,
			);
			if (!intent.claimed) {
				directIntentConcurrent++;
				details.push(
					buildDetail(
						item,
						"skipped",
						"Deferred: this ARR target already has a durable mutation intent",
					),
				);
				continue;
			}
			directMutationIntentId = intent.id;
			directMutationExecutionToken = intent.executionToken;
		} catch (error) {
			directRetryPersistenceFailures++;
			log.error(
				{
					err: error,
					title: item.cacheItem.title,
					instanceId: instance.id,
					arrItemId: item.cacheItem.arrItemId,
				},
				"Cleanup could not persist and claim its mutation intent",
			);
			details.push(
				buildDetail(
					item,
					"skipped",
					"Skipped: arr-dashboard could not persist recovery state before the ARR mutation",
				),
			);
			continue;
		}

		try {
			await assertRunLease?.();
			const ownership = await prisma.libraryCleanupApproval.updateMany({
				where: {
					id: directMutationIntentId,
					config: { userId },
					status: "retry_executing",
					executionToken: directMutationExecutionToken,
				},
				data: { reviewedAt: new Date() },
			});
			if (ownership.count !== 1) {
				directIntentConcurrent++;
				details.push(
					buildDetail(
						item,
						"skipped",
						"Deferred: this ARR mutation intent changed ownership before execution",
					),
				);
				continue;
			}
			const mutationInstance = await loadCurrentMutationInstance(
				deps,
				userId,
				instance.id,
				safetyPlan!,
			);
			await assertCurrentCleanupExemptionAllowsMutation(
				deps,
				userId,
				mutationInstance,
				item.cacheItem.arrItemId,
				item.cacheItem.itemType,
			);
			const assertDestructiveMutationAuthority =
				mutationInstance.service === "RADARR"
					? createRadarrDestructiveMutationAuthority(
							deps,
							userId,
							{
								instanceId: item.cacheItem.instanceId,
								arrItemId: item.cacheItem.arrItemId,
								itemType: item.cacheItem.itemType,
								action: ruleAction,
							},
							safetyPlan!,
							assertRunLease,
						)
					: mutationInstance.service === "SONARR" && safetyPlan?.kind === "verified_sonarr"
						? createSonarrDestructiveMutationAuthority(
								deps,
								userId,
								{
									instanceId: item.cacheItem.instanceId,
									arrItemId: item.cacheItem.arrItemId,
									itemType: item.cacheItem.itemType,
									action: ruleAction,
								},
								safetyPlan,
								assertRunLease,
							)
						: assertRunLease;

			if (ruleAction === "unmonitor") {
				await unmonitorInArr(
					arrClientFactory,
					mutationInstance,
					item.cacheItem.arrItemId,
					safetyPlan!,
					assertRunLease,
				);
				try {
					await prisma.libraryCache.updateMany({
						where: {
							instanceId: item.cacheItem.instanceId,
							arrItemId: item.cacheItem.arrItemId,
							itemType: item.cacheItem.itemType,
						},
						data: { monitored: false },
					});
				} catch (cacheErr) {
					log.error(
						{ err: cacheErr, title: item.cacheItem.title, instanceId: instance.id },
						"Cleanup: ARR action succeeded but cache update failed — cache is now stale",
					);
				}
				details.push(buildDetail(item, "unmonitored"));
				unmonitored++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: unmonitored item in ARR instance",
				);
			} else if (ruleAction === "delete_files") {
				const deletedFiles = await deleteFilesFromArr(
					arrClientFactory,
					mutationInstance,
					item.cacheItem.arrItemId,
					safetyPlan!,
					assertDestructiveMutationAuthority,
				);
				await reconcileSonarrEpisodeFileCache(
					prisma,
					mutationInstance,
					item.cacheItem.arrItemId,
					log,
				);
				try {
					await prisma.libraryCache.updateMany({
						where: {
							instanceId: item.cacheItem.instanceId,
							arrItemId: item.cacheItem.arrItemId,
							itemType: item.cacheItem.itemType,
						},
						data: { hasFile: false, sizeOnDisk: 0 },
					});
				} catch (cacheErr) {
					log.error(
						{ err: cacheErr, title: item.cacheItem.title, instanceId: instance.id },
						"Cleanup: ARR action succeeded but cache update failed — cache is now stale",
					);
				}
				details.push(
					deletedFiles
						? buildDetail(item, "files_deleted")
						: buildDetail(
								item,
								"skipped",
								"Reconciled because the verified ARR file set was already empty",
							),
				);
				if (deletedFiles) filesDeleted++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					deletedFiles
						? "Cleanup: deleted files for item in ARR instance"
						: "Cleanup: reconciled an already-empty ARR file set",
				);
			} else {
				// Default: delete
				await deleteFromArr(
					arrClientFactory,
					mutationInstance,
					item.cacheItem.arrItemId,
					safetyPlan!,
					assertDestructiveMutationAuthority,
				);
				await reconcileSonarrEpisodeFileCache(
					prisma,
					mutationInstance,
					item.cacheItem.arrItemId,
					log,
				);
				try {
					await prisma.libraryCache.deleteMany({
						where: {
							instanceId: item.cacheItem.instanceId,
							arrItemId: item.cacheItem.arrItemId,
							itemType: item.cacheItem.itemType,
						},
					});
				} catch (cacheErr) {
					log.error(
						{ err: cacheErr, title: item.cacheItem.title, instanceId: instance.id },
						"Cleanup: ARR delete succeeded but cache cleanup failed — cache is now stale",
					);
				}
				details.push(buildDetail(item, "removed"));
				removed++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: removed item from ARR instance",
				);
			}
			await updateClaimedCleanupApproval(
				prisma,
				userId,
				directMutationIntentId,
				"retry_executing",
				directMutationExecutionToken,
				{
					status: "executed",
					executionToken: null,
					executedAt: new Date(),
					lastExecutionError: null,
				},
			).catch((persistError) => {
				directRetryPersistenceFailures++;
				log.error(
					{ err: persistError, intentId: directMutationIntentId },
					"Cleanup action completed but its durable mutation intent was not finalized",
				);
			});
		} catch (error) {
			if (error instanceof CleanupRunLeaseLostError) {
				await prisma.libraryCleanupApproval
					.updateMany({
						where: {
							id: directMutationIntentId,
							config: { userId },
							status: "retry_executing",
							executionToken: directMutationExecutionToken,
						},
						data: {
							status: "retry_pending",
							executionToken: null,
							lastExecutionError:
								"Cleanup execution paused because its database run lease was lost.",
						},
					})
					.catch((persistError) => {
						log.error(
							{ err: persistError, intentId: directMutationIntentId },
							"Cleanup lost its run lease and could not return its mutation intent to retry pending",
						);
					});
				throw error;
			}
			if (error instanceof CleanupExemptionAuthorityError) {
				exemptionPolicyBlocks++;
				await updateClaimedCleanupApproval(
					prisma,
					userId,
					directMutationIntentId,
					"retry_executing",
					directMutationExecutionToken,
					{
						status: "expired",
						executionToken: null,
						reviewedAt: new Date(),
						lastExecutionError: error.message,
					},
				).catch((persistError) => {
					directRetryPersistenceFailures++;
					log.error(
						{ err: persistError, intentId: directMutationIntentId },
						"Cleanup could not expire an exemption-blocked mutation intent",
					);
				});
				details.push(buildDetail(item, "skipped", error.message));
				log.warn(
					{ title: item.cacheItem.title, instanceId: instance.id },
					"Cleanup mutation blocked by current deployed exemption policy",
				);
				continue;
			}
			if (error instanceof ArrDeletePartialError) {
				partialArrDeletes++;
				const deletedAnyVerifiedFiles = error.deletedFileIds.length > 0;
				if (deletedAnyVerifiedFiles) filesDeleted++;
				const postPartialRetrySnapshot = buildPostPartialRetrySnapshot(safetyPlan, error);
				let retryPersistenceSucceeded = true;
				try {
					await updateClaimedCleanupApproval(
						prisma,
						userId,
						directMutationIntentId,
						"retry_executing",
						directMutationExecutionToken,
						{
							status: "retry_pending",
							executionToken: null,
							lastExecutionError: error.message,
							...(postPartialRetrySnapshot ? { safetySnapshot: postPartialRetrySnapshot } : {}),
						},
					);
				} catch (retryError) {
					retryPersistenceSucceeded = false;
					directRetryPersistenceFailures++;
					log.error(
						{
							err: retryError,
							title: item.cacheItem.title,
							instanceId: instance.id,
							arrItemId: item.cacheItem.arrItemId,
						},
						"Cleanup could not persist the record-only ARR retry",
					);
				}
				if (retryPersistenceSucceeded) {
					await reconcilePartialFileDeletion(
						prisma,
						instance,
						item.cacheItem.arrItemId,
						item.cacheItem.itemType,
						error,
						log,
					);
					await prisma.libraryCache
						.updateMany({
							where: {
								instanceId: item.cacheItem.instanceId,
								arrItemId: item.cacheItem.arrItemId,
								itemType: item.cacheItem.itemType,
							},
							data: {
								hasFile: error.hasRemainingFiles,
								sizeOnDisk: error.remainingSize,
							},
						})
						.catch((cacheErr) => {
							log.error(
								{ err: cacheErr, title: item.cacheItem.title, instanceId: instance.id },
								"Cleanup partial ARR delete could not update the cache",
							);
						});
				}
				details.push(
					buildDetail(item, deletedAnyVerifiedFiles ? "files_deleted" : "skipped", error.message),
				);
				log.error(
					{ err: error, title: item.cacheItem.title, instanceId: instance.id },
					deletedAnyVerifiedFiles
						? "Cleanup deleted verified ARR files but could not safely finish the item mutation"
						: "Cleanup could not verify the ARR file mutation outcome and retained the item record",
				);
				continue;
			}
			if (error instanceof ArrFileChangedDuringSafetyCheckError) {
				runtimeSafetyBlocks++;
				await updateClaimedCleanupApproval(
					prisma,
					userId,
					directMutationIntentId,
					"retry_executing",
					directMutationExecutionToken,
					{
						status: "expired",
						executionToken: null,
						lastExecutionError: error.message,
						reviewedAt: new Date(),
					},
				).catch((persistError) => {
					directRetryPersistenceFailures++;
					log.error(
						{ err: persistError, intentId: directMutationIntentId },
						"Cleanup could not expire a safety-invalid mutation intent",
					);
				});
				details.push(buildDetail(item, "skipped", error.message));
				log.warn(
					{ title: item.cacheItem.title, instanceId: instance.id },
					"Cleanup deletion blocked because the verified ARR file set changed",
				);
				continue;
			}
			consecutiveFailures++;
			await updateClaimedCleanupApproval(
				prisma,
				userId,
				directMutationIntentId,
				"retry_executing",
				directMutationExecutionToken,
				{
					status: "retry_pending",
					executionToken: null,
					lastExecutionError: `Action failed: ${getErrorMessage(error)}`,
				},
			).catch((persistError) => {
				directRetryPersistenceFailures++;
				log.error(
					{ err: persistError, intentId: directMutationIntentId },
					"Cleanup could not return a failed mutation intent to retry pending",
				);
			});
			log.error(
				{ err: error, title: item.cacheItem.title, instanceId: instance.id, consecutiveFailures },
				"Cleanup: failed to execute action on item",
			);
			details.push(buildDetail(item, "skipped", `Action failed: ${getErrorMessage(error)}`));
		}
	}

	const allWarnings = withSharedPlexWarning([...(warnings ?? [])], runtimeSafetyBlocks);
	if (!configuredRunLimitIsValid) {
		allWarnings.push(
			"Cleanup did not mutate any items because the stored per-run removal limit is invalid. Set it to a whole number from 1 through 100.",
		);
	}
	if (exemptionPolicyBlocks > 0) {
		allWarnings.push(
			`${exemptionPolicyBlocks} cleanup ${
				exemptionPolicyBlocks === 1 ? "mutation was" : "mutations were"
			} blocked because current deployed exemption policy covers ${
				exemptionPolicyBlocks === 1 ? "its" : "their"
			} ARR target.`,
		);
	}
	if (circuitBroken) {
		allWarnings.push(
			`Circuit breaker triggered after ${CIRCUIT_BREAKER_THRESHOLD} consecutive ARR API failures. Remaining items were skipped.`,
		);
	}
	if (instanceLookupFailures > 0) {
		allWarnings.push(
			`${instanceLookupFailures} items were skipped because their ARR instances could not be loaded.`,
		);
	}
	if (invalidMutationTargets > 0) {
		allWarnings.push(
			`${invalidMutationTargets} ${
				invalidMutationTargets === 1 ? "item was" : "items were"
			} skipped because the stored cleanup action or media type was invalid.`,
		);
	}
	if (partialArrDeletes > 0) {
		allWarnings.push(
			`${partialArrDeletes} ${
				partialArrDeletes === 1 ? "item had an" : "items had"
			} incomplete or unverifiable ARR file mutation. The corresponding ${
				partialArrDeletes === 1 ? "record remains" : "records remain"
			}; review the affected instance before retrying.`,
		);
	}
	if (directRetryFailures > 0) {
		allWarnings.push(
			`${directRetryFailures} durable record-only cleanup ${
				directRetryFailures === 1 ? "retry remains" : "retries remain"
			} pending because the ARR mutation could not be completed safely.`,
		);
	}
	if (directRetryConcurrent > 0) {
		allWarnings.push(
			`${directRetryConcurrent} durable record-only cleanup ${
				directRetryConcurrent === 1 ? "retry was" : "retries were"
			} deferred because another cleanup run claimed it first.`,
		);
	}
	if (directRetryFairnessDeferred > 0) {
		allWarnings.push(
			`${directRetryFairnessDeferred} durable record-only cleanup ${
				directRetryFairnessDeferred === 1 ? "retry was" : "retries were"
			} deferred for one run so distinct fresh cleanup work could make progress.`,
		);
	}
	if (directIntentConcurrent > 0) {
		allWarnings.push(
			`${directIntentConcurrent} fresh cleanup ${
				directIntentConcurrent === 1 ? "target was" : "targets were"
			} deferred because another run already owns its durable mutation intent.`,
		);
	}
	if (directRetryExpired > 0) {
		allWarnings.push(
			`${directRetryExpired} record-only cleanup ${
				directRetryExpired === 1 ? "retry expired" : "retries expired"
			} because the stored ARR target identity changed.`,
		);
	}
	if (directRetryRecordingFailures > 0) {
		allWarnings.push(
			`${directRetryRecordingFailures} completed record-only cleanup ${
				directRetryRecordingFailures === 1 ? "could not" : "cleanups could not"
			} record durable completion state and will be reconciled on a later run.`,
		);
	}
	if (directRetryLoadFailures > 0) {
		allWarnings.push(
			"Durable record-only cleanup retries could not be loaded; no retry was attempted.",
		);
	}
	if (directRetryExecutionFailures > 0) {
		allWarnings.push(
			`${directRetryExecutionFailures} durable record-only cleanup ${
				directRetryExecutionFailures === 1 ? "retry was" : "retries were"
			} deferred after a post-claim read failure; automatic recovery will return it to the retry queue.`,
		);
	}
	if (directRetryPersistenceFailures > 0) {
		allWarnings.push(
			`${directRetryPersistenceFailures} record-only cleanup ${
				directRetryPersistenceFailures === 1 ? "retry was" : "retries were"
			} not persisted. Manual ARR recovery may be required.`,
		);
	}
	if (inFlightDeferredItems.length > 0) {
		allWarnings.push(
			`${inFlightDeferredItems.length} ${
				inFlightDeferredItems.length === 1 ? "item was" : "items were"
			} deferred because a durable record-only retry for the same ARR target is already executing.`,
		);
	}
	const hasWarnings = allWarnings.length > 0;
	const directlyEvaluated = freshItems.length;
	const directRemoved = removed - retriedRemoved;
	const directUnmonitored = unmonitored - retriedUnmonitored;
	const directFilesDeleted = filesDeleted - retriedFilesDeleted;
	const unsuccessfulRetries = directRetryFailures + directRetryExpired + directRetryConcurrent;
	const accountedUnsuccessfulRetries = unsuccessfulRetries + directRetryExecutionFailures;

	const result: CleanupRunResult = {
		isDryRun: false,
		status: circuitBroken || hasWarnings ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: directlyEvaluated + directRetryCount + inFlightDeferredItems.length,
		itemsRemoved: removed,
		itemsUnmonitored: unmonitored,
		itemsFilesDeleted: filesDeleted,
		itemsSkipped:
			totalFlaggedBeforeLimit -
			flagged.length +
			budgetDeferredItems +
			inFlightDeferredItems.length +
			directRetryFairnessDeferred +
			(directlyEvaluated - directRemoved - directUnmonitored - directFilesDeleted) +
			accountedUnsuccessfulRetries +
			directRetryReconciled,
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings: allWarnings.length > 0 ? allWarnings : undefined,
	};

	await createRunLog(prisma, config.id, result, log);
	return result;
}

// ============================================================================
// ARR Action Functions
// ============================================================================

function sonarrFileSetSize(files: Array<{ size?: number | null }>): number {
	let total = 0;
	for (const file of files) {
		if (
			typeof file.size === "number" &&
			Number.isSafeInteger(file.size) &&
			file.size > 0 &&
			Number.isSafeInteger(total + file.size)
		) {
			total += file.size;
		}
	}
	return total;
}

async function inspectRadarrFileState(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	expected: VerifiedRadarrFileIdentity,
): Promise<
	| { kind: "record_absent" }
	| { kind: "file_absent" }
	| { kind: "same_file" }
	| { kind: "replacement"; size: number }
> {
	let movie: Awaited<ReturnType<typeof radarr.movie.getById>>;
	try {
		movie = await radarr.movie.getById(arrItemId);
	} catch (error) {
		if (isNotFoundError(error)) return { kind: "record_absent" };
		throw error;
	}
	const movieFileId = movie.movieFileId;
	if (typeof movieFileId !== "number" || movieFileId <= 0) {
		if (movie.hasFile === false) return { kind: "file_absent" };
		throw new Error("Radarr returned hasFile=true without a valid movie file ID");
	}
	if (movie.hasFile === false) {
		throw new Error("Radarr returned hasFile=false with a positive movie file ID");
	}
	if (movieFileId === expected.movieFileId) return { kind: "same_file" };

	let size = 0;
	try {
		const replacement = await radarr.movieFile.getById(movieFileId);
		if (
			typeof replacement.size === "number" &&
			Number.isSafeInteger(replacement.size) &&
			replacement.size > 0
		) {
			size = replacement.size;
		}
	} catch {
		// The replacement identity is enough to retain the record. Its size is
		// best-effort cache metadata and must not affect the safety decision.
	}
	return { kind: "replacement", size };
}

async function deleteVerifiedRadarrFile(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	expectedTarget: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_radarr" }>["target"],
	expected: VerifiedRadarrFileIdentity,
	assertMutationAuthority?: () => Promise<void>,
): Promise<void> {
	await assertVerifiedRadarrFileUnchanged(radarr, arrItemId, expectedTarget, expected);
	let deleteError: unknown;
	try {
		await assertMutationAuthority?.();
		await radarr.movieFile.delete(expected.movieFileId);
	} catch (error) {
		deleteError = error;
	}

	let state: Awaited<ReturnType<typeof inspectRadarrFileState>>;
	try {
		state = await inspectRadarrFileState(radarr, arrItemId, expected);
	} catch (verificationError) {
		throw new ArrDeletePartialError({
			cause: deleteError ?? verificationError,
			service: "RADARR",
			deletedFileIds: [],
			hasRemainingFiles: true,
			remainingSize: expected.size,
			message:
				"Partial cleanup: Radarr's movie-file deletion outcome could not be verified, so the movie record was retained. Review Radarr before retrying.",
		});
	}

	if (state.kind === "file_absent" || state.kind === "record_absent") return;
	if (state.kind === "same_file") {
		if (deleteError) throw deleteError;
		throw new Error("Radarr did not delete the verified movie file");
	}
	throw new ArrDeletePartialError({
		cause: deleteError ?? new RadarrFileChangedDuringSafetyCheckError(),
		service: "RADARR",
		deletedFileIds: [expected.movieFileId],
		hasRemainingFiles: true,
		remainingSize: state.size,
		message:
			"Partial cleanup: the verified Radarr movie file was deleted, but a replacement file appeared before the mutation finished. The movie record was retained.",
	});
}

async function deleteRadarrRecordWithoutFiles(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	expectedTarget: Extract<
		ExecutableSharedMediaSafetyPlan,
		{ kind: "verified_radarr_empty" }
	>["target"],
	deletedFileIds: number[],
	assertMutationAuthority?: () => Promise<void>,
): Promise<void> {
	let lastDeleteError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await assertVerifiedRadarrEmptyUnchanged(radarr, arrItemId, expectedTarget);
		} catch (error) {
			if (isNotFoundError(error)) return;
			if (error instanceof RadarrFileChangedDuringSafetyCheckError) {
				throw new ArrDeletePartialError({
					cause: error,
					service: "RADARR",
					deletedFileIds,
					hasRemainingFiles: true,
					message:
						"Partial cleanup: a Radarr replacement file appeared before the movie record could be removed. The movie record was retained.",
				});
			}
			throw new ArrDeletePartialError({
				cause: error,
				service: "RADARR",
				deletedFileIds,
				hasRemainingFiles: true,
				message:
					"Partial cleanup: arr-dashboard could not verify that the Radarr movie stayed fileless, so its record was retained.",
			});
		}

		try {
			await assertMutationAuthority?.();
			await radarr.movie.delete(arrItemId, {
				deleteFiles: false,
				addImportExclusion: false,
			});
			return;
		} catch (error) {
			if (error instanceof CleanupRunLeaseLostError) {
				if (deletedFileIds.length === 0) throw error;
				throw new ArrDeletePartialError({
					cause: error,
					service: "RADARR",
					deletedFileIds,
					hasRemainingFiles: false,
					message:
						"Partial cleanup: the verified Radarr movie file was deleted, but execution authority was lost before the movie record could be removed.",
				});
			}
			lastDeleteError = error;
			try {
				await radarr.movie.getById(arrItemId);
			} catch (readError) {
				if (isNotFoundError(readError)) return;
				throw new ArrDeletePartialError({
					cause: readError,
					service: "RADARR",
					deletedFileIds,
					hasRemainingFiles: true,
					message:
						"Partial cleanup: the Radarr movie-record deletion outcome could not be verified. Review Radarr before retrying.",
				});
			}
		}
	}

	if (deletedFileIds.length === 0) throw lastDeleteError;
	throw new ArrDeletePartialError({
		cause: lastDeleteError,
		service: "RADARR",
		deletedFileIds,
		hasRemainingFiles: false,
	});
}

async function deleteVerifiedSonarrFiles(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	expectedTarget: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }>["target"],
	expected: VerifiedSonarrFileIdentity,
	assertMutationAuthority?: () => Promise<void>,
): Promise<number[]> {
	await assertVerifiedSonarrFilesUnchanged(sonarr, arrItemId, expectedTarget, expected);
	const expectedIds = expected.episodeFiles.map((file) => file.episodeFileId);
	if (expectedIds.length === 0) return [];

	let bulkError: unknown;
	try {
		await assertMutationAuthority?.();
		await sonarr.episodeFile.bulkDelete(expectedIds);
	} catch (error) {
		bulkError = error;
	}

	let remainingFiles: Awaited<ReturnType<typeof sonarr.episodeFile.getBySeries>>;
	try {
		remainingFiles = await sonarr.episodeFile.getBySeries(arrItemId);
	} catch (verificationError) {
		throw new ArrDeletePartialError({
			cause: bulkError ?? verificationError,
			service: "SONARR",
			deletedFileIds: [],
			hasRemainingFiles: true,
			remainingSize: sonarrFileSetSize(expected.episodeFiles),
			message:
				"Partial cleanup: Sonarr's episode-file deletion outcome could not be verified, so the series record was retained. Review Sonarr before retrying.",
		});
	}

	const remainingIds = new Set(
		remainingFiles
			.map((file) => file.id)
			.filter((id): id is number => typeof id === "number" && id > 0),
	);
	const deletedFileIds = expectedIds.filter((id) => !remainingIds.has(id));
	const remainingSize = sonarrFileSetSize(remainingFiles);
	if (bulkError) {
		if (deletedFileIds.length === 0) throw bulkError;
		throw new ArrDeletePartialError({
			cause: bulkError,
			service: "SONARR",
			deletedFileIds,
			hasRemainingFiles: remainingFiles.length > 0,
			remainingSize,
			message:
				"Partial cleanup: Sonarr deleted only part of the verified episode-file set. The series record was retained; review Sonarr before retrying.",
		});
	}
	if (deletedFileIds.length !== expectedIds.length || remainingFiles.length > 0) {
		if (deletedFileIds.length === 0) {
			throw new Error("Sonarr did not delete the verified episode-file set");
		}
		throw new ArrDeletePartialError({
			cause: new SonarrFilesChangedDuringSafetyCheckError(),
			service: "SONARR",
			deletedFileIds,
			hasRemainingFiles: true,
			remainingSize,
			message:
				"Partial cleanup: the verified Sonarr episode files were deleted, but another file appeared before the mutation finished. The series record was retained.",
		});
	}
	return deletedFileIds;
}

async function deleteSonarrRecordWithoutFiles(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	expectedTarget: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }>["target"],
	expected: VerifiedSonarrFileIdentity,
	deletedFileIds: number[],
	assertMutationAuthority?: () => Promise<void>,
): Promise<void> {
	let lastDeleteError: unknown;
	const emptyExpected: VerifiedSonarrFileIdentity = {
		seriesPath: expected.seriesPath,
		episodeFiles: [],
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await assertVerifiedSonarrFilesUnchanged(sonarr, arrItemId, expectedTarget, emptyExpected);
		} catch (error) {
			if (isNotFoundError(error)) return;
			if (error instanceof SonarrFilesChangedDuringSafetyCheckError) {
				let remainingFiles: Awaited<ReturnType<typeof sonarr.episodeFile.getBySeries>> = [];
				let remainingFilesKnown = false;
				try {
					remainingFiles = await sonarr.episodeFile.getBySeries(arrItemId);
					remainingFilesKnown = true;
				} catch {
					// Retain the record and report an unknown remaining size.
				}
				throw new ArrDeletePartialError({
					cause: error,
					service: "SONARR",
					deletedFileIds,
					hasRemainingFiles: !remainingFilesKnown || remainingFiles.length > 0,
					remainingSize: sonarrFileSetSize(remainingFiles),
					message:
						"Partial cleanup: the Sonarr series changed or gained files before its record could be removed. The series record was retained.",
				});
			}
			throw new ArrDeletePartialError({
				cause: error,
				service: "SONARR",
				deletedFileIds,
				hasRemainingFiles: true,
				message:
					"Partial cleanup: arr-dashboard could not verify that the Sonarr series stayed fileless, so its record was retained.",
			});
		}

		try {
			await assertMutationAuthority?.();
			await sonarr.series.delete(arrItemId, {
				deleteFiles: false,
				addImportListExclusion: false,
			});
			return;
		} catch (error) {
			if (error instanceof CleanupRunLeaseLostError) {
				if (deletedFileIds.length === 0) throw error;
				throw new ArrDeletePartialError({
					cause: error,
					service: "SONARR",
					deletedFileIds,
					hasRemainingFiles: false,
					message:
						"Partial cleanup: the verified Sonarr episode files were deleted, but execution authority was lost before the series record could be removed.",
				});
			}
			lastDeleteError = error;
			try {
				await sonarr.series.getById(arrItemId);
			} catch (readError) {
				if (isNotFoundError(readError)) return;
				throw new ArrDeletePartialError({
					cause: readError,
					service: "SONARR",
					deletedFileIds,
					hasRemainingFiles: true,
					message:
						"Partial cleanup: the Sonarr series-record deletion outcome could not be verified. Review Sonarr before retrying.",
				});
			}
		}
	}

	if (deletedFileIds.length === 0) throw lastDeleteError;
	throw new ArrDeletePartialError({
		cause: lastDeleteError,
		service: "SONARR",
		deletedFileIds,
		hasRemainingFiles: false,
	});
}

async function reconcileSonarrEpisodeFileCache(
	prisma: CleanupExecutorDeps["prisma"],
	instance: ServiceInstance,
	arrItemId: number,
	log: CleanupExecutorDeps["log"],
): Promise<void> {
	if (instance.service !== "SONARR") return;
	await prisma.episodeFileCache
		.deleteMany({
			where: { instanceId: instance.id, arrSeriesId: arrItemId },
		})
		.catch((error) => {
			log.error(
				{ err: error, instanceId: instance.id, arrItemId },
				"Cleanup Sonarr action succeeded but episode-file cache reconciliation failed",
			);
		});
}

async function reconcilePartialFileDeletion(
	prisma: CleanupExecutorDeps["prisma"],
	instance: ServiceInstance,
	arrItemId: number,
	itemType: string,
	error: ArrDeletePartialError,
	log: CleanupExecutorDeps["log"],
): Promise<void> {
	if (error.service !== "SONARR" || error.deletedFileIds.length === 0) return;
	await prisma.episodeFileCache
		.deleteMany({
			where: {
				instanceId: instance.id,
				arrSeriesId: arrItemId,
				arrEpisodeFileId: { in: error.deletedFileIds },
			},
		})
		.catch((cacheError) => {
			log.error(
				{ err: cacheError, instanceId: instance.id, arrItemId, itemType },
				"Cleanup partial Sonarr delete could not reconcile episode-file cache rows",
			);
		});
}

function validateCleanupMutationShape(
	instance: ServiceInstance,
	itemType: string,
	action: unknown,
): RuleAction {
	const normalizedAction = action ?? "delete";
	if (
		normalizedAction !== "delete" &&
		normalizedAction !== "unmonitor" &&
		normalizedAction !== "delete_files"
	) {
		throw new Error("Unknown cleanup action");
	}

	const expectedItemType =
		instance.service === "RADARR" ? "movie" : instance.service === "SONARR" ? "series" : null;
	if (!expectedItemType || itemType !== expectedItemType) {
		throw new Error("Cleanup media type does not match the target ARR service");
	}

	return normalizedAction;
}

/**
 * Delete an item from an ARR instance via the SDK client.
 */
async function deleteFromArr(
	arrClientFactory: CleanupExecutorDeps["arrClientFactory"],
	instance: ServiceInstance,
	arrItemId: number,
	safetyPlan: SharedMediaSafetyPlan,
	assertMutationAuthority?: () => Promise<void>,
): Promise<void> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_sonarr") {
				throw new Error("Sonarr safety plan cannot authorize a Radarr mutation");
			}
			if (safetyPlan.kind === "verified_radarr") {
				await deleteVerifiedRadarrFile(
					radarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.file,
					assertMutationAuthority,
				);
				await deleteRadarrRecordWithoutFiles(
					radarr,
					arrItemId,
					safetyPlan.target,
					[safetyPlan.file.movieFileId],
					assertMutationAuthority,
				);
			} else if (safetyPlan.kind === "verified_radarr_empty") {
				await deleteRadarrRecordWithoutFiles(
					radarr,
					arrItemId,
					safetyPlan.target,
					[],
					assertMutationAuthority,
				);
			} else if (safetyPlan.kind === "not_required" || safetyPlan.kind === "verified_arr_target") {
				throw new Error("A verified Radarr file identity is required for deletion");
			} else {
				const exhaustivePlan: never = safetyPlan;
				throw new Error(`Unsupported Radarr safety plan: ${String(exhaustivePlan)}`);
			}
			break;
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_radarr" || safetyPlan.kind === "verified_radarr_empty") {
				throw new Error("Radarr safety plan cannot authorize a Sonarr mutation");
			}
			if (safetyPlan.kind === "verified_sonarr") {
				const deletedFileIds = await deleteVerifiedSonarrFiles(
					sonarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.files,
					assertMutationAuthority,
				);
				await deleteSonarrRecordWithoutFiles(
					sonarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.files,
					deletedFileIds,
					assertMutationAuthority,
				);
			} else if (safetyPlan.kind === "not_required" || safetyPlan.kind === "verified_arr_target") {
				throw new Error("A verified Sonarr file identity is required for deletion");
			} else {
				const exhaustivePlan: never = safetyPlan;
				throw new Error(`Unsupported Sonarr safety plan: ${String(exhaustivePlan)}`);
			}
			break;
		}
		default:
			throw new Error(`Unsupported service type for library cleanup: ${instance.service}`);
	}
}

/**
 * Unmonitor an item in an ARR instance without deleting it.
 * Sets monitored=false on the movie/series.
 */
async function unmonitorInArr(
	arrClientFactory: CleanupExecutorDeps["arrClientFactory"],
	instance: ServiceInstance,
	arrItemId: number,
	safetyPlan: SharedMediaSafetyPlan,
	assertMutationAuthority?: () => Promise<void>,
): Promise<void> {
	if (safetyPlan.kind !== "verified_arr_target") {
		throw new Error("A verified ARR target identity is required before unmonitoring");
	}
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			const movie = await radarr.movie.getById(arrItemId);
			assertVerifiedArrTargetUnchanged(instance, movie.tmdbId, movie.path, safetyPlan.target);
			await assertMutationAuthority?.();
			await radarr.movie.update(arrItemId, { ...movie, id: arrItemId, monitored: false });
			break;
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			const series = await sonarr.series.getById(arrItemId);
			assertVerifiedArrTargetUnchanged(instance, series.tvdbId, series.path, safetyPlan.target);
			await assertMutationAuthority?.();
			await sonarr.series.update(arrItemId, {
				...series,
				id: arrItemId,
				monitored: false,
			} as Parameters<typeof sonarr.series.update>[1]);
			break;
		}
		default:
			throw new Error(`Unsupported service type for unmonitor: ${instance.service}`);
	}
}

/**
 * Delete files for an item in an ARR instance without removing the item itself.
 * For Radarr: deletes the movie file. For Sonarr: bulk-deletes all episode files.
 */
async function deleteFilesFromArr(
	arrClientFactory: CleanupExecutorDeps["arrClientFactory"],
	instance: ServiceInstance,
	arrItemId: number,
	safetyPlan: SharedMediaSafetyPlan,
	assertMutationAuthority?: () => Promise<void>,
): Promise<boolean> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_sonarr") {
				throw new Error("Sonarr safety plan cannot authorize a Radarr mutation");
			}
			if (safetyPlan.kind === "verified_radarr") {
				await deleteVerifiedRadarrFile(
					radarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.file,
					assertMutationAuthority,
				);
				return true;
			}
			if (safetyPlan.kind === "verified_radarr_empty") {
				await assertVerifiedRadarrEmptyUnchanged(radarr, arrItemId, safetyPlan.target);
				return false;
			}
			if (safetyPlan.kind === "not_required" || safetyPlan.kind === "verified_arr_target") {
				throw new Error("A verified Radarr file identity is required for file deletion");
			}
			const exhaustivePlan: never = safetyPlan;
			throw new Error(`Unsupported Radarr safety plan: ${String(exhaustivePlan)}`);
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_radarr" || safetyPlan.kind === "verified_radarr_empty") {
				throw new Error("Radarr safety plan cannot authorize a Sonarr mutation");
			}
			if (safetyPlan.kind === "verified_sonarr") {
				await deleteVerifiedSonarrFiles(
					sonarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.files,
					assertMutationAuthority,
				);
				return safetyPlan.files.episodeFiles.length > 0;
			}
			if (safetyPlan.kind === "not_required" || safetyPlan.kind === "verified_arr_target") {
				throw new Error("A verified Sonarr file identity is required for file deletion");
			}
			const exhaustivePlan: never = safetyPlan;
			throw new Error(`Unsupported Sonarr safety plan: ${String(exhaustivePlan)}`);
		}
		default:
			throw new Error(`Unsupported service type for delete_files: ${instance.service}`);
	}
}

/**
 * Build a fully-populated EvalContext by running all relevant prefetch functions.
 * Used by the explain endpoint so it can evaluate rules with real external data
 * rather than an empty context that always returns "not matched" for external rules.
 */
export async function buildEvalContext(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{ enabled: boolean; ruleType: string; conditions: string | null }>,
): Promise<EvalContext> {
	const activeTypes = collectActiveRuleTypes(rules);

	const SEERR_RULE_TYPES = [
		"seerr_requested_by",
		"seerr_request_age",
		"seerr_request_status",
		"seerr_is_4k",
		"seerr_request_modified_age",
		"seerr_modified_by",
		"seerr_is_requested",
		"seerr_request_count",
		"seerr_requester_watched",
		"seerr_requester_not_watched",
	];
	const PLEX_RULE_TYPES_LIST = [
		"plex_last_watched",
		"plex_watch_count",
		"plex_on_deck",
		"plex_user_rating",
		"plex_watched_by",
		"plex_collection",
		"plex_label",
		"plex_added_at",
		"plex_episode_completion",
		"user_retention",
		"staleness_score",
		"recently_active",
		"seerr_requester_watched",
		"seerr_requester_not_watched",
	];

	const JELLYFIN_RULE_TYPES = [
		"jellyfin_last_watched",
		"jellyfin_watch_count",
		"jellyfin_on_deck",
		"jellyfin_user_rating",
		"jellyfin_watched_by",
		"jellyfin_added_at",
	];

	const [seerrMap, plexMap, plexEpisodeMap, jellyfinMap, jellyfinEpisodeMap] = await Promise.all([
		SEERR_RULE_TYPES.some((t) => activeTypes.has(t))
			? prefetchSeerrRequests(deps, userId)
			: undefined,
		PLEX_RULE_TYPES_LIST.some((t) => activeTypes.has(t))
			? prefetchPlexData(deps, userId)
			: undefined,
		activeTypes.has("plex_episode_completion") ? prefetchPlexEpisodeData(deps, userId) : undefined,
		JELLYFIN_RULE_TYPES.some((t) => activeTypes.has(t))
			? prefetchJellyfinData(deps, userId)
			: undefined,
		activeTypes.has("jellyfin_episode_completion")
			? prefetchJellyfinEpisodeData(deps, userId)
			: undefined,
	]);
	const tmdbListMemberships = activeTypes.has("tmdb_list_member")
		? await prefetchCleanupListMemberships(deps, userId, rules, "tmdb")
		: undefined;
	const traktListMemberships = activeTypes.has("trakt_list_member")
		? await prefetchCleanupListMemberships(deps, userId, rules, "trakt")
		: undefined;

	return {
		now: new Date(),
		seerrMap: seerrMap ?? undefined,
		plexMap: plexMap ?? undefined,
		plexEpisodeMap: plexEpisodeMap ?? undefined,
		jellyfinMap: jellyfinMap ?? undefined,
		jellyfinEpisodeMap: jellyfinEpisodeMap ?? undefined,
		tmdbListMemberships,
		traktListMemberships,
	};
}

/**
 * Create a cleanup run log entry.
 * Failures are logged but not rethrown — the run result is more important than its log.
 */
async function createRunLog(
	prisma: CleanupExecutorDeps["prisma"],
	configId: string,
	result: Omit<CleanupRunResult, "error"> & { error?: string },
	log?: CleanupExecutorDeps["log"],
): Promise<void> {
	try {
		await prisma.libraryCleanupLog.create({
			data: {
				configId,
				isDryRun: result.isDryRun,
				status: result.status,
				itemsEvaluated: result.itemsEvaluated,
				itemsFlagged: result.itemsFlagged,
				itemsRemoved: result.itemsRemoved,
				itemsUnmonitored: result.itemsUnmonitored,
				itemsFilesDeleted: result.itemsFilesDeleted,
				itemsSkipped: result.itemsSkipped,
				details: JSON.stringify(result.details),
				error: result.error,
				prefetchHealth: result.prefetchHealth ? JSON.stringify(result.prefetchHealth) : null,
				warnings: result.warnings?.length ? JSON.stringify(result.warnings) : null,
				durationMs: result.durationMs,
				startedAt: new Date(Date.now() - result.durationMs),
				completedAt: new Date(),
			},
		});
	} catch (error) {
		log?.warn(
			{ err: error, configId },
			"Failed to write cleanup run log — run result is still valid",
		);
	}
}

/**
 * Collect the list identifiers referenced by cleanup rules (top-level
 * params and composite sub-conditions) and load their cached memberships
 * as Map<identifier, Set<tmdbId>> — the shape the shared evaluator's
 * tmdb_list_member / trakt_list_member cases consume. Mirrors the
 * auto-tag executor's per-rule prefetch, generalized to a rule set.
 */
export async function prefetchCleanupListMemberships(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{ ruleType: string; parameters?: string; conditions: string | null }>,
	cacheKind: "tmdb" | "trakt",
): Promise<Map<string, Set<number>>> {
	const targetType = cacheKind === "tmdb" ? "tmdb_list_member" : "trakt_list_member";
	const identifierKey = cacheKind === "tmdb" ? "listId" : "listSlug";

	const identifiers = new Set<string>();
	const collectFromParams = (ruleType: string, params: unknown) => {
		if (ruleType !== targetType) return;
		if (params === null || typeof params !== "object") return;
		const value = (params as Record<string, unknown>)[identifierKey];
		if (typeof value === "string" && value.length > 0) identifiers.add(value);
	};
	for (const rule of rules) {
		collectFromParams(rule.ruleType, safeJsonParse(rule.parameters ?? ""));
		const conditions = safeJsonParse(rule.conditions ?? "") as Array<{
			ruleType: string;
			parameters: unknown;
		}> | null;
		if (Array.isArray(conditions)) {
			for (const cond of conditions) collectFromParams(cond?.ruleType, cond?.parameters);
		}
	}
	if (identifiers.size === 0) return new Map();

	const out = new Map<string, Set<number>>();
	if (cacheKind === "tmdb") {
		const rows = await deps.prisma.tmdbListCache.findMany({
			where: { userId, listId: { in: [...identifiers] } },
			select: { listId: true, tmdbId: true },
		});
		for (const row of rows) {
			(out.get(row.listId) ?? out.set(row.listId, new Set()).get(row.listId))!.add(row.tmdbId);
		}
	} else {
		const rows = await deps.prisma.traktListCache.findMany({
			where: { userId, listSlug: { in: [...identifiers] } },
			select: { listSlug: true, tmdbId: true },
		});
		for (const row of rows) {
			(out.get(row.listSlug) ?? out.set(row.listSlug, new Set()).get(row.listSlug))!.add(
				row.tmdbId,
			);
		}
	}
	return out;
}
