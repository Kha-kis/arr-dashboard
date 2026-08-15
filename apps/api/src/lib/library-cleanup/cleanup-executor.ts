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
import type { CleanupRuleExpression, DataSourceDependency } from "@arr/shared";
import type { RadarrClient, SonarrClient } from "arr-sdk";
import type { Prisma } from "../../generated/prisma/client.js";
import { isNotFoundError } from "../arr/client-factory.js";
import {
	collectJellyfinCacheLiveEvidence,
	createOwnedJellyfinPublicationSnapshot,
	type JellyfinCacheSnapshotRow,
	refreshJellyfinCache,
} from "../jellyfin/jellyfin-cache-refresher.js";
import { runJellyfinCacheRefreshSingleFlight } from "../jellyfin/jellyfin-cache-singleflight.js";
import { createJellyfinClient } from "../jellyfin/jellyfin-client.js";
import { refreshJellyfinEpisodeCache } from "../jellyfin/jellyfin-episode-cache-refresher.js";
import { buildLibraryItem } from "../library/library-item-builder.js";
import {
	collectPlexCacheLiveEvidence,
	createOwnedPlexPublicationSnapshot,
	type PlexCacheSnapshotRow,
	type PlexInventoryTarget,
	refreshPlexCache,
} from "../plex/plex-cache-refresher.js";
import {
	createPlexClient,
	type PlexClient,
	PlexMovieNotFoundError,
	PlexSeriesNotFoundError,
} from "../plex/plex-client.js";
import { refreshPlexEpisodeCache } from "../plex/plex-episode-cache-refresher.js";
import { plexConnectionFingerprint } from "../plex/service-instance-fingerprint.js";
import type {
	LibraryCleanupApproval,
	LibraryCleanupConfig,
	LibraryCleanupRule,
	ServiceInstance,
} from "../prisma.js";
import { withQuiObservationTopologyGuard } from "../qui/observation-topology-guard.js";
import { SeerrClient } from "../seerr/seerr-client.js";
import {
	providerIdentityAuthorityFingerprint,
	providerInstanceAuthorityFingerprint,
} from "../services/service-identity.js";
import {
	collectTautulliCacheLiveEvidence,
	createOwnedTautulliPublicationSnapshot,
	refreshTautulliCache,
	type TautulliCacheSnapshotRow,
} from "../tautulli/tautulli-cache-refresher.js";
import { createTautulliClient } from "../tautulli/tautulli-client.js";
import { createTmdbV3Client } from "../tmdb/list-client.js";
import { createTraktClient } from "../trakt/list-client.js";
import { getErrorMessage } from "../utils/error-message.js";
import { safeJsonParse } from "../utils/json.js";
import { arrPolicyEvidenceFromRaw } from "./arr-policy-evidence.js";
import {
	approvalRecordToAuditSnapshot,
	cleanupAuditEnabled,
	recordApprovalExecutionClaimed,
	recordApprovalExecutionOutcome,
	recordApprovalMutationBoundary,
	recordConfiguredRunAudit,
	runCleanupAuditBestEffort,
} from "./cleanup-audit.js";
import {
	withCleanupOperationGuard,
	withExclusiveCleanupOperationGuard,
} from "./cleanup-maintenance-gate.js";
import {
	acquireCleanupRunLease,
	CLEANUP_RUN_LEASE_MS,
	CleanupRunAlreadyInProgressError,
	CleanupRunLeaseLostError,
	releaseCleanupRunLease,
	renewCleanupRunLease,
	startCleanupRunLease,
} from "./cleanup-run-lease.js";
import {
	type EpisodeCleanupCandidate,
	type EpisodePlexWatchEvidence,
	evaluateEpisodeWatchCountRule,
	isSupportedEpisodeCleanupRule,
	toEpisodeTargetMetadata,
} from "./episode-scope.js";
import {
	prepareMediaServerRescans,
	rescanMediaType,
	retryPendingMediaServerRescans,
	triggerCoalescedMediaServerRescans,
} from "./media-server-rescan.js";
import {
	loadExactProviderCacheRows,
	PROVIDER_CACHE_ROW_SELECTS,
	type ProviderCacheType,
} from "./provider-cache-evidence.js";
import { applyQuiSeedingFilter, isQuiSeedingState } from "./qui-filter.js";
import {
	type ConditionEvidenceAvailability,
	evaluateItemAgainstRules,
	evaluateItemPolicyState,
	evaluateRuleState,
	extractRating,
	normalizeStoredCleanupRuleExpression,
	passesCleanupRuleFilters,
	ruleUsesUnavailableData,
} from "./rule-evaluators.js";
import { type CleanupSelectionPlan, planCleanupSelection } from "./selection-planner.js";
import {
	ArrCrossInstanceOwnershipChangedDuringSafetyCheckError,
	ArrFileChangedDuringSafetyCheckError,
	ArrMutationAuthorityChangedDuringSafetyCheckError,
	ArrTargetChangedDuringSafetyCheckError,
	assertCurrentProviderEvidenceAuthority,
	assertVerifiedArrTargetUnchanged,
	assertVerifiedRadarrEmptyUnchanged,
	assertVerifiedRadarrFileUnchanged,
	assertVerifiedRadarrPeerOwnershipRetained,
	assertVerifiedSonarrEpisodeUnchanged,
	assertVerifiedSonarrFilesUnchanged,
	assertVerifiedSonarrPeerInventoryUnchanged,
	assertVerifiedSonarrPeerOwnershipRetained,
	buildCacheTargetSafetyPlan,
	buildRadarrCacheSafetyPlan,
	buildSonarrCacheSafetyPlan,
	type CleanupDeleteTarget,
	cleanupDeleteTargetKey,
	createArrServiceFingerprint,
	createSanitizedProviderEvidence,
	createSharedPlexSafetyContext,
	type ExecutableSharedMediaSafetyPlan,
	executableSafetyPlansEqual,
	findSharedPlexDeleteBlocks,
	ProviderExecutionAuthorityChangedError,
	parseExecutableSafetyEnvelope,
	parseExecutableSafetyPlan,
	RadarrFileChangedDuringSafetyCheckError,
	type SanitizedProviderEvidence,
	type SanitizedProviderEvidenceSource,
	type SharedMediaSafetyPlan,
	SonarrFilesChangedDuringSafetyCheckError,
	serializeExecutableSafetyPlan,
	type VerifiedEpisodePlexWatchSource,
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
	TautulliWatchMap,
} from "./types.js";
import { type ListMembershipKey, listMembershipKey } from "./types.js";

export {
	acquireCleanupRunLease,
	CLEANUP_RUN_LEASE_MS,
	CleanupRunAlreadyInProgressError,
	CleanupRunLeaseLostError,
	releaseCleanupRunLease,
	renewCleanupRunLease,
};

// Default approval expiry: 7 days
const APPROVAL_EXPIRY_DAYS = 7;

// Batch size for LibraryCache queries
const CACHE_QUERY_BATCH_SIZE = 500;
const PROVIDER_EVIDENCE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

type CleanupRunResultWithProviderEvidence = CleanupRunResult & {
	providerEvidence?: SanitizedProviderEvidence;
};

interface ProviderCacheGeneration {
	completedAt: Date;
	itemCount: number;
	connectionGeneration: number;
	identityGeneration: number;
	statusFingerprint: string;
}

interface ProviderCacheRowAuthority {
	rowCount: number;
	rowFingerprint: string;
}

interface ProviderCacheSnapshot<T> {
	value: T;
	evidence: SanitizedProviderEvidence;
	authority: {
		cacheType: ProviderCacheType;
		instances: ServiceInstance[];
		generations: Map<string, ProviderCacheGeneration>;
		rows: Map<string, ProviderCacheRowAuthority>;
	};
}

export function mergeSanitizedProviderEvidence(
	...evidenceSets: Array<SanitizedProviderEvidence | undefined>
): SanitizedProviderEvidence {
	const available = evidenceSets.filter(
		(evidence): evidence is SanitizedProviderEvidence => evidence !== undefined,
	);
	return createSanitizedProviderEvidence(
		available.flatMap((evidence) => evidence.dependencies),
		available.flatMap((evidence) =>
			evidence.sources.map(({ fingerprint: _fingerprint, ...source }) => source),
		),
	);
}

function isVerifiedProviderCacheSource(
	instance: Pick<
		ServiceInstance,
		| "enabled"
		| "expectedIdentity"
		| "identityKind"
		| "identityStatus"
		| "identityVerifiedAt"
		| "connectionGeneration"
		| "identityGeneration"
	>,
): boolean {
	return (
		instance.enabled &&
		instance.identityStatus === "VERIFIED" &&
		typeof instance.expectedIdentity === "string" &&
		instance.expectedIdentity.trim() !== "" &&
		instance.identityKind !== null &&
		instance.identityVerifiedAt !== null &&
		Number.isSafeInteger(instance.connectionGeneration) &&
		instance.connectionGeneration >= 0 &&
		Number.isSafeInteger(instance.identityGeneration) &&
		instance.identityGeneration > 0
	);
}

async function loadCompleteCacheGenerations(
	deps: CleanupExecutorDeps,
	instances: Array<
		Pick<
			ServiceInstance,
			| "id"
			| "enabled"
			| "updatedAt"
			| "expectedIdentity"
			| "identityKind"
			| "identityStatus"
			| "identityVerifiedAt"
			| "connectionGeneration"
			| "identityGeneration"
		>
	>,
	cacheType: ProviderCacheType,
	now: Date = new Date(),
): Promise<Map<string, ProviderCacheGeneration> | undefined> {
	if (instances.length === 0) return undefined;
	const statuses = await deps.prisma.cacheRefreshStatus.findMany({
		where: { instanceId: { in: instances.map((instance) => instance.id) }, cacheType },
		select: {
			instanceId: true,
			lastRefreshedAt: true,
			lastResult: true,
			lastErrorMessage: true,
			lastAttemptResult: true,
			lastAttemptErrorMessage: true,
			itemCount: true,
			connectionGeneration: true,
			identityGeneration: true,
			generationId: true,
			generationMetadata: true,
		},
	});
	const byInstance = new Map(statuses.map((status) => [status.instanceId, status]));
	const freshnessThreshold = now.getTime() - PROVIDER_EVIDENCE_FRESHNESS_MS;
	const generations = new Map<string, ProviderCacheGeneration>();
	for (const instance of instances) {
		const status = byInstance.get(instance.id);
		if (
			!isVerifiedProviderCacheSource(instance) ||
			instance.identityVerifiedAt === null ||
			status?.lastResult !== "success" ||
			status.lastErrorMessage != null ||
			status.lastAttemptErrorMessage != null ||
			(status.lastAttemptResult != null && status.lastAttemptResult !== "success") ||
			status.lastRefreshedAt.getTime() < freshnessThreshold ||
			status.lastRefreshedAt.getTime() < instance.updatedAt.getTime() ||
			status.lastRefreshedAt.getTime() < instance.identityVerifiedAt.getTime() ||
			status.connectionGeneration === null ||
			status.identityGeneration === null ||
			status.connectionGeneration !== instance.connectionGeneration ||
			status.identityGeneration !== instance.identityGeneration
		) {
			return undefined;
		}
		generations.set(instance.id, {
			completedAt: status.lastRefreshedAt,
			itemCount: status.itemCount,
			connectionGeneration: status.connectionGeneration,
			identityGeneration: status.identityGeneration,
			statusFingerprint: evidenceFingerprint({
				instance: {
					id: instance.id,
					expectedIdentity: instance.expectedIdentity,
					identityKind: instance.identityKind,
					identityVerifiedAt: instance.identityVerifiedAt,
					connectionGeneration: instance.connectionGeneration,
					identityGeneration: instance.identityGeneration,
					updatedAt: instance.updatedAt,
				},
				status,
			}),
		});
	}
	return generations;
}

async function revalidateProviderCacheAuthority(
	deps: CleanupExecutorDeps,
	authority: ProviderCacheSnapshot<unknown>["authority"],
	revalidateTopology = true,
	now = new Date(),
): Promise<boolean> {
	let currentInstances = authority.instances;
	if (revalidateTopology) {
		currentInstances = await loadProviderInstances(deps, authority.instances[0]!.userId, [
			...new Set(authority.instances.map((instance) => instance.service)),
		]);
		if (
			providerTopologyFingerprint(currentInstances) !==
			providerTopologyFingerprint(authority.instances)
		) {
			return false;
		}
	}
	const current = await loadCompleteCacheGenerations(
		deps,
		currentInstances,
		authority.cacheType,
		now,
	);
	if (!current || current.size !== authority.generations.size) return false;
	return [...authority.generations].every(
		([instanceId, generation]) =>
			current.get(instanceId)?.statusFingerprint === generation.statusFingerprint,
	);
}

function createProviderCacheSnapshot<T>(
	value: T,
	cacheType: ProviderCacheType,
	instances: ServiceInstance[],
	generations: Map<string, ProviderCacheGeneration>,
	rowsByInstance: Map<string, unknown[]>,
): ProviderCacheSnapshot<T> {
	const rowAuthorities = new Map(
		instances.map((instance) => {
			const rows = [...(rowsByInstance.get(instance.id) ?? [])].sort((left, right) =>
				String((left as { id?: unknown }).id ?? "").localeCompare(
					String((right as { id?: unknown }).id ?? ""),
				),
			);
			return [
				instance.id,
				{ rowCount: rows.length, rowFingerprint: evidenceFingerprint(rows) },
			] as const;
		}),
	);
	return {
		value,
		evidence: createSanitizedProviderEvidence(
			[cacheType],
			instances.map((instance) => {
				const generation = generations.get(instance.id)!;
				return {
					service: instance.service as SanitizedProviderEvidenceSource["service"],
					instanceFingerprint: providerInstanceAuthorityFingerprint(instance.id),
					identityKind: instance.identityKind!,
					identityFingerprint: providerIdentityAuthorityFingerprint(instance),
					connectionGeneration: generation.connectionGeneration,
					identityGeneration: generation.identityGeneration,
					cacheType,
					completedAt: generation.completedAt.toISOString(),
					itemCount: generation.itemCount,
					verifiedAt: instance.identityVerifiedAt!.toISOString(),
					statusFingerprint: generation.statusFingerprint,
					rowFingerprint: rowAuthorities.get(instance.id)!.rowFingerprint,
				};
			}),
		),
		authority: { cacheType, instances, generations, rows: rowAuthorities },
	};
}

async function revalidateExactProviderCacheAuthority(
	deps: CleanupExecutorDeps,
	tx: Prisma.TransactionClient,
	authority: ProviderCacheSnapshot<unknown>["authority"],
	now: Date,
): Promise<boolean> {
	const transactionDeps = {
		...deps,
		prisma: tx as unknown as CleanupExecutorDeps["prisma"],
	};
	const currentInstances = await loadProviderInstances(
		transactionDeps,
		authority.instances[0]!.userId,
		[...new Set(authority.instances.map((instance) => instance.service))],
	);
	if (
		providerTopologyFingerprint(currentInstances) !==
		providerTopologyFingerprint(authority.instances)
	) {
		return false;
	}
	const currentGenerations = await loadCompleteCacheGenerations(
		transactionDeps,
		currentInstances,
		authority.cacheType,
		now,
	);
	if (!currentGenerations || currentGenerations.size !== authority.generations.size) return false;
	if (
		![...authority.generations].every(
			([instanceId, generation]) =>
				currentGenerations.get(instanceId)?.statusFingerprint === generation.statusFingerprint,
		)
	) {
		return false;
	}
	const instanceIds = authority.instances.map((instance) => instance.id);
	const currentRows = await loadExactProviderCacheRows(tx, authority.cacheType, instanceIds);
	if (!currentRows) return false;
	return instanceIds.every((instanceId) => {
		const expected = authority.rows.get(instanceId);
		const rows = currentRows.get(instanceId) ?? [];
		return (
			expected !== undefined &&
			expected.rowCount === rows.length &&
			expected.rowFingerprint === evidenceFingerprint(rows)
		);
	});
}

class ProviderCacheAuthorityChangedError extends Error {
	constructor() {
		super("Provider cache authority changed after cleanup selection");
		this.name = "ProviderCacheAuthorityChangedError";
	}
}

function isProviderExecutionAuthorityFailure(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
		if (current instanceof ProviderExecutionAuthorityChangedError) return true;
		current = current.cause;
	}
	return false;
}

async function createApprovalWithProviderCacheAuthority(
	deps: CleanupExecutorDeps,
	authorities: Array<ProviderCacheSnapshot<unknown>["authority"]>,
	data: Prisma.LibraryCleanupApprovalUncheckedCreateInput,
): Promise<LibraryCleanupApproval> {
	if (authorities.length === 0) {
		return await deps.prisma.libraryCleanupApproval.create({ data });
	}
	const postgresql = /^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL ?? "");
	return await deps.prisma.$transaction(
		async (tx) => {
			const instanceIds = [
				...new Set(
					authorities.flatMap((authority) => authority.instances.map((instance) => instance.id)),
				),
			].sort();
			if (postgresql) {
				for (const instanceId of instanceIds) {
					await tx.$queryRawUnsafe(
						'SELECT "id" FROM "ServiceInstance" WHERE "id" = $1 FOR UPDATE',
						instanceId,
					);
				}
			}
			const now = new Date();
			for (const authority of authorities) {
				if (!(await revalidateExactProviderCacheAuthority(deps, tx, authority, now))) {
					throw new ProviderCacheAuthorityChangedError();
				}
			}
			return await tx.libraryCleanupApproval.create({ data });
		},
		postgresql ? undefined : { isolationLevel: "Serializable" },
	);
}

// The route returns at most 200 preview rows; avoid live safety I/O for rows
// the caller cannot inspect.
export const CLEANUP_DETAIL_LIMIT = 200;

// Circuit breaker: abort after N consecutive ARR API failures
const CIRCUIT_BREAKER_THRESHOLD = 3;

export const INTERRUPTED_CLEANUP_RECOVERY_MESSAGE =
	"Recovered after an interrupted cleanup. Review and approve again to reconcile the verified ARR state.";

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

async function withCleanupMutationLease<T>(
	deps: Pick<CleanupExecutorDeps, "prisma" | "log">,
	userId: string,
	mutate: () => Promise<T>,
	conflictError: () => Error,
	options: {
		configId?: string;
		leaseRowMayBeDeleted?: boolean;
		exclusiveOperation?: boolean;
	} = {},
): Promise<T> {
	const runWithOperationGuard = options.exclusiveOperation
		? withExclusiveCleanupOperationGuard
		: withCleanupOperationGuard;
	return await runWithOperationGuard(async () => {
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

/** Serialize destructive ARR service deletion against every cleanup/TRaSH mutation. */
export async function withExclusiveCleanupTopologyMutationLease<T>(
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
		{ ...options, exclusiveOperation: true },
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

const SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE =
	"Partial cleanup: Sonarr accepted the episode unmonitor, but its file was not deleted. The upstream change was recorded and the mutation will remain retryable.";

class SonarrEpisodeUnmonitorPartialError extends Error {
	constructor(cause: unknown) {
		super(SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE, { cause });
	}
}

class SonarrEpisodeUnmonitorOutcomeUnknownError extends Error {
	constructor(cause: unknown) {
		super(
			"Sonarr may have accepted the episode unmonitor, but arr-dashboard could not confirm the result. The mutation will remain retryable and no file deletion was attempted.",
			{ cause },
		);
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
	action: RuleAction,
	providerEvidence: SanitizedProviderEvidence = createSanitizedProviderEvidence([], []),
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
		return serializeExecutableSafetyPlan(
			{
				kind: "verified_radarr_empty",
				target: safetyPlan.target,
			},
			providerEvidence,
		);
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
	return serializeExecutableSafetyPlan(
		{
			kind: "verified_sonarr",
			target: safetyPlan.target,
			files: {
				seriesPath: safetyPlan.files.seriesPath,
				episodeFiles: [],
			},
			peers: safetyPlan.peers,
			ownership: action === "delete" ? safetyPlan.ownership : [],
			targetDeleteNotifications: safetyPlan.targetDeleteNotifications,
		},
		providerEvidence,
	);
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

function quiEvidenceMatchesRemainingFiles(
	approvedPlan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }>,
	livePlan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }>,
): boolean {
	const approvedEvidence = approvedPlan.quiEvidence ?? { enabled: false, instances: [] };
	const liveEvidence = livePlan.quiEvidence ?? { enabled: false, instances: [] };
	if (approvedEvidence.enabled !== liveEvidence.enabled) return false;
	if (!liveEvidence.enabled) return true;

	const liveInstancesById = new Map(
		liveEvidence.instances.map((instance) => [instance.instanceId, instance]),
	);
	if (
		approvedEvidence.instances.length !== liveEvidence.instances.length ||
		approvedEvidence.instances.some(
			(instance) =>
				liveInstancesById.get(instance.instanceId)?.serviceFingerprint !==
				instance.serviceFingerprint,
		)
	) {
		return false;
	}

	const liveHashes = new Set(
		liveEvidence.instances.flatMap((instance) => instance.files.flatMap((file) => file.hashes)),
	);
	const projectedApprovedEvidence = {
		enabled: true as const,
		instances: approvedEvidence.instances.map((approvedInstance) => {
			const liveInstance = liveInstancesById.get(approvedInstance.instanceId)!;
			const livePathKeys = new Set(liveInstance.files.map((file) => JSON.stringify(file.fullPath)));
			return {
				...approvedInstance,
				files: approvedInstance.files.filter((file) =>
					livePathKeys.has(JSON.stringify(file.fullPath)),
				),
				torrents: approvedInstance.torrents.filter((torrent) => liveHashes.has(torrent.hash)),
			};
		}),
	};
	return JSON.stringify(projectedApprovedEvidence) === JSON.stringify(liveEvidence);
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
	return (
		livePlan.files.episodeFiles.every(
			(file) => approvedFiles.get(file.episodeFileId) === JSON.stringify(file),
		) && quiEvidenceMatchesRemainingFiles(approvedPlan, livePlan)
	);
}

function hasVerifiedSonarrOwnershipProof(
	action: string,
	plan: ExecutableSharedMediaSafetyPlan | null,
): plan is Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }> {
	return (
		action === "delete" &&
		plan?.kind === "verified_sonarr" &&
		plan.peers.length > 0 &&
		plan.ownership.length > 0
	);
}

function isVerifiedSonarrRecordOnlyRetry(
	action: string,
	plan: ExecutableSharedMediaSafetyPlan | null,
): plan is Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }> {
	return hasVerifiedSonarrOwnershipProof(action, plan) && plan.files.episodeFiles.length === 0;
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
	identity?: {
		actionId?: string;
		approvalId?: string;
		auditCorrelationId?: string;
		auditPrepared?: boolean;
		mutationAttempted?: boolean;
		durableStateRecordingFailed?: boolean;
	},
): CleanupRunResult["details"][number] {
	return {
		...identity,
		instanceId: item.cacheItem.instanceId,
		arrItemId: item.cacheItem.arrItemId,
		// Keep the legacy title field series-scoped for API compatibility.
		// Episode identity is carried in the structured fields below.
		title: item.cacheItem.title,
		seriesTitle: item.episodeTarget?.seriesTitle,
		episodeTitle: item.episodeTarget?.episodeTitle,
		ruleId: item.match.ruleId,
		rule: item.match.ruleName,
		reason: reasonOverride ?? item.match.reason,
		action,
		intendedAction: item.match.action,
		itemType: item.cacheItem.itemType,
		targetScope: item.episodeTarget ? "episode" : "series",
		arrEpisodeId: item.episodeTarget?.arrEpisodeId,
		seasonNumber: item.episodeTarget?.seasonNumber,
		episodeNumber: item.episodeTarget?.episodeNumber,
		episodeFileId: item.episodeTarget?.episodeFileId,
		sizeOnDisk: item.cacheItem.sizeOnDisk.toString(),
		year: item.cacheItem.year,
		rating: item.rating,
	};
}

function retryEpisodeFileId(approval: LibraryCleanupApproval): number | undefined {
	if (
		typeof approval.episodeFileId === "number" &&
		Number.isSafeInteger(approval.episodeFileId) &&
		approval.episodeFileId > 0
	) {
		return approval.episodeFileId;
	}
	const plan = parseExecutableSafetyPlan(approval.safetySnapshot);
	return plan?.kind === "verified_sonarr_episode" ? plan.selectedFile.episodeFileId : undefined;
}

export function cleanupApprovalTargetKey(approval: LibraryCleanupApproval): string {
	return cleanupDeleteTargetKey({
		...approval,
		episodeFileId: retryEpisodeFileId(approval),
	});
}

function buildRetryDetail(
	approval: LibraryCleanupApproval,
	action: DetailAction,
	reasonOverride?: string,
): CleanupRunResult["details"][number] {
	return {
		actionId: approval.id,
		approvalId: approval.id,
		auditOutcomeOwnedByExecution: true,
		instanceId: approval.instanceId,
		arrItemId: approval.arrItemId,
		title: approval.title,
		seriesTitle: approval.targetScope === "episode" ? approval.title : undefined,
		episodeTitle: approval.episodeTitle ?? undefined,
		ruleId: approval.matchedRuleId,
		rule: approval.matchedRuleName,
		reason: reasonOverride ?? approval.reason,
		action,
		itemType: approval.itemType,
		targetScope: approval.targetScope === "episode" ? "episode" : "series",
		arrEpisodeId: approval.arrEpisodeId ?? undefined,
		seasonNumber: approval.seasonNumber ?? undefined,
		episodeNumber: approval.episodeNumber ?? undefined,
		episodeFileId: retryEpisodeFileId(approval),
		sizeOnDisk: approval.sizeOnDisk.toString(),
		year: approval.year,
		rating: null,
	};
}

function toDeleteTargets(items: FlaggedItem[]): CleanupDeleteTarget[] {
	return items.map((item) => ({
		instanceId: item.cacheItem.instanceId,
		arrItemId: item.cacheItem.arrItemId,
		itemType: item.cacheItem.itemType,
		action: item.match.action,
		targetScope: item.episodeTarget ? "episode" : "series",
		arrEpisodeId: item.episodeTarget?.arrEpisodeId,
		seasonNumber: item.episodeTarget?.seasonNumber,
		episodeNumber: item.episodeTarget?.episodeNumber,
		episodeFileId: item.episodeTarget?.episodeFileId,
		episodeFileConsumerIds: item.episodeTarget?.episodeFileConsumerIds,
		plexWatchEvidence: item.episodeTarget?.plexWatchEvidence,
		respectQuiSeeding: item.respectQuiSeeding ?? item.episodeTarget?.respectQuiSeeding,
		episodeFileInfoHash: item.episodeTarget?.fileInfoHash,
		episodeFileTorrentState: item.episodeTarget?.fileTorrentState,
	}));
}

function flaggedDeleteTarget(item: FlaggedItem): CleanupDeleteTarget {
	return toDeleteTargets([item])[0]!;
}

function episodePlanTargetFields(
	plan: ExecutableSharedMediaSafetyPlan | null | undefined,
	currentRespectQuiSeeding = false,
): Partial<CleanupDeleteTarget> {
	if (!plan) return { respectQuiSeeding: currentRespectQuiSeeding };
	const respectQuiSeeding =
		currentRespectQuiSeeding ||
		(plan.kind !== "verified_arr_target" &&
			plan.kind !== "verified_radarr_empty" &&
			plan.quiEvidence?.enabled === true);
	if (plan.kind !== "verified_sonarr_episode") return { respectQuiSeeding };
	return {
		episodeFileId: plan.episode.episodeFileId,
		episodeFileConsumerIds: plan.episode.episodeFileConsumerIds,
		plexWatchEvidence: [
			{
				plexInstanceId: plan.watchProof.plexInstanceId,
				sourceFingerprint: plan.watchProof.sourceFingerprint,
				ratingKey: plan.watchProof.ratingKey,
				watchCount: plan.watchProof.watchCount,
				refreshedAt: plan.watchProof.refreshedAt,
			},
		],
		respectQuiSeeding: respectQuiSeeding || plan.quiIdentity.enabled,
		episodeFileInfoHash: plan.quiIdentity.infoHash,
		episodeFileTorrentState: plan.quiIdentity.torrentState,
	};
}

function episodePlansMatchWithRefreshedWatchProof(
	approvedPlan: ExecutableSharedMediaSafetyPlan | null | undefined,
	livePlan: ExecutableSharedMediaSafetyPlan | null | undefined,
	allowMonitoredToUnmonitored: boolean,
	allowChangedPathMappingWitness = false,
	allowNewQuiProtectionWitness = false,
): boolean {
	if (
		approvedPlan?.kind !== "verified_sonarr_episode" ||
		livePlan?.kind !== "verified_sonarr_episode"
	) {
		return false;
	}
	const {
		watchCount: approvedWatchCount,
		refreshedAt: approvedRefreshedAt,
		...approvedProofIdentity
	} = approvedPlan.watchProof;
	const {
		watchCount: liveWatchCount,
		refreshedAt: liveRefreshedAt,
		...liveProofIdentity
	} = livePlan.watchProof;
	const approvedComparableProofIdentity = allowChangedPathMappingWitness
		? {
				plexInstanceId: approvedProofIdentity.plexInstanceId,
				sourceFingerprint: approvedProofIdentity.sourceFingerprint,
				plexServerUrl: approvedProofIdentity.plexServerUrl,
				ratingKey: approvedProofIdentity.ratingKey,
				size: approvedProofIdentity.size,
			}
		: approvedProofIdentity;
	const liveComparableProofIdentity = allowChangedPathMappingWitness
		? {
				plexInstanceId: liveProofIdentity.plexInstanceId,
				sourceFingerprint: liveProofIdentity.sourceFingerprint,
				plexServerUrl: liveProofIdentity.plexServerUrl,
				ratingKey: liveProofIdentity.ratingKey,
				size: liveProofIdentity.size,
			}
		: liveProofIdentity;
	const approvedRefreshTime = Date.parse(approvedRefreshedAt);
	const liveRefreshTime = Date.parse(liveRefreshedAt);
	if (
		JSON.stringify(approvedComparableProofIdentity) !==
			JSON.stringify(liveComparableProofIdentity) ||
		liveWatchCount < approvedWatchCount ||
		!Number.isFinite(approvedRefreshTime) ||
		!Number.isFinite(liveRefreshTime) ||
		liveRefreshTime < approvedRefreshTime
	) {
		return false;
	}
	if (
		allowMonitoredToUnmonitored &&
		!(approvedPlan.episode.monitored === true && livePlan.episode.monitored === false)
	) {
		return false;
	}
	if (
		allowNewQuiProtectionWitness &&
		!(
			approvedPlan.quiIdentity.enabled === false &&
			livePlan.quiIdentity.enabled === true &&
			approvedPlan.quiIdentity.infoHash === livePlan.quiIdentity.infoHash &&
			approvedPlan.quiIdentity.torrentState === livePlan.quiIdentity.torrentState
		)
	) {
		return false;
	}
	if (allowChangedPathMappingWitness) {
		const stableNotificationIdentity = (
			notification: (typeof approvedPlan.targetDeleteNotifications)[number],
		) => ({
			plexServerUrl: notification.plexServerUrl,
			onSeriesDelete: notification.onSeriesDelete,
			onEpisodeFileDelete: notification.onEpisodeFileDelete,
		});
		const stableNotificationIdentities = (
			notifications: typeof approvedPlan.targetDeleteNotifications,
		) =>
			notifications
				.map(stableNotificationIdentity)
				.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
		if (
			JSON.stringify(stableNotificationIdentities(approvedPlan.targetDeleteNotifications)) !==
			JSON.stringify(stableNotificationIdentities(livePlan.targetDeleteNotifications))
		) {
			return false;
		}
	}
	return executableSafetyPlansEqual(approvedPlan, {
		...livePlan,
		episode: allowMonitoredToUnmonitored
			? { ...livePlan.episode, monitored: approvedPlan.episode.monitored }
			: livePlan.episode,
		watchProof: approvedPlan.watchProof,
		quiIdentity: allowNewQuiProtectionWitness ? approvedPlan.quiIdentity : livePlan.quiIdentity,
		targetDeleteNotifications: allowChangedPathMappingWitness
			? approvedPlan.targetDeleteNotifications
			: livePlan.targetDeleteNotifications,
	});
}

function asExecutableSafetyPlan(
	plan: SharedMediaSafetyPlan | undefined,
): ExecutableSharedMediaSafetyPlan | null {
	if (
		plan?.kind === "verified_arr_target" ||
		plan?.kind === "verified_radarr" ||
		plan?.kind === "verified_radarr_empty" ||
		plan?.kind === "verified_sonarr" ||
		plan?.kind === "verified_sonarr_episode"
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
	if (executablePlan.kind === "verified_radarr") {
		const peerInstances = instances.filter(
			(candidate) => candidate.id !== instance.id && candidate.service === "RADARR",
		);
		const peerIds = new Set(executablePlan.peers.map((peer) => peer.instanceId));
		if (
			peerInstances.length !== peerIds.size ||
			peerInstances.some((peerInstance) => !peerIds.has(peerInstance.id))
		) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
		}
		for (const peer of executablePlan.peers) {
			const peerInstance = peerInstances.find((candidate) => candidate.id === peer.instanceId);
			if (!peerInstance || createArrServiceFingerprint(peerInstance) !== peer.serviceFingerprint) {
				throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
			}
			const peerClient = deps.arrClientFactory.create(peerInstance) as InstanceType<
				typeof RadarrClient
			>;
			const peerMovies = (await peerClient.movie.getAll({ tmdbId: peer.externalId })).filter(
				(movie) => movie.tmdbId === peer.externalId,
			);
			if (peer.arrItemId === null) {
				if (peerMovies.length !== 0) {
					throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
				}
				continue;
			}
			if (
				peerMovies.length !== 1 ||
				peerMovies[0]?.id !== peer.arrItemId ||
				peer.mediaPath === null
			) {
				throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("RADARR");
			}
			const peerTarget = {
				serviceFingerprint: peer.serviceFingerprint,
				externalId: peer.externalId,
				mediaPath: peer.mediaPath,
			};
			if (peer.file) {
				await assertVerifiedRadarrFileUnchanged(peerClient, peer.arrItemId, peerTarget, peer.file);
			} else {
				await assertVerifiedRadarrEmptyUnchanged(peerClient, peer.arrItemId, peerTarget);
			}
		}
	} else if (
		(executablePlan.kind === "verified_sonarr" ||
			executablePlan.kind === "verified_sonarr_episode") &&
		(executablePlan.kind === "verified_sonarr_episode" ||
			executablePlan.files.episodeFiles.length > 0 ||
			executablePlan.peers.length > 0)
	) {
		const peerInstances = instances.filter(
			(candidate) => candidate.id !== instance.id && candidate.service === "SONARR",
		);
		const peerIds = new Set(executablePlan.peers.map((peer) => peer.instanceId));
		if (
			peerInstances.length !== peerIds.size ||
			peerInstances.some((peerInstance) => !peerIds.has(peerInstance.id))
		) {
			throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
		}
		for (const peer of executablePlan.peers) {
			const peerInstance = peerInstances.find((candidate) => candidate.id === peer.instanceId);
			if (!peerInstance || createArrServiceFingerprint(peerInstance) !== peer.serviceFingerprint) {
				throw new ArrCrossInstanceOwnershipChangedDuringSafetyCheckError("SONARR");
			}
			const peerClient = deps.arrClientFactory.create(peerInstance) as InstanceType<
				typeof SonarrClient
			>;
			const peerSeriesCatalog = await peerClient.series.getAll();
			await assertVerifiedSonarrPeerInventoryUnchanged(
				peerClient,
				peer,
				executablePlan.ownership,
				peerSeriesCatalog,
			);
		}
	}
	return instance;
}

function withSharedPlexOwnershipRevalidation(
	deps: CleanupExecutorDeps,
	userId: string,
	target: CleanupDeleteTarget,
	safetyPlan: SharedMediaSafetyPlan,
	assertMutationAuthority?: MutationAuthorityCheck,
): MutationAuthorityCheck {
	let ownershipRevalidationCount = 0;
	let episodeRevalidationCount = 0;
	return async (evidence) => {
		await assertMutationAuthority?.(evidence);
		if (safetyPlan.kind === "verified_sonarr_episode") {
			const context = createSharedPlexSafetyContext();
			const blocks = await findSharedPlexDeleteBlocks(deps, userId, [target], context);
			const targetKey = cleanupDeleteTargetKey(target);
			const livePlan = asExecutableSafetyPlan(context.plans.get(targetKey));
			const comparableLivePlan =
				livePlan?.kind === "verified_sonarr_episode"
					? {
							...livePlan,
							episode: {
								...livePlan.episode,
								// `delete` deliberately unmonitors immediately before deleting
								// the file; that idempotent transition does not weaken identity.
								monitored:
									target.action === "delete"
										? safetyPlan.episode.monitored
										: livePlan.episode.monitored,
							},
						}
					: livePlan;
			if (
				blocks.has(targetKey) ||
				!comparableLivePlan ||
				!executableSafetyPlansEqual(safetyPlan, comparableLivePlan)
			) {
				throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
					"Skipped for safety: the verified Sonarr episode identity, Plex ownership, or qUI physical-file evidence changed at the mutation boundary.",
				);
			}
			if (
				target.action === "delete" &&
				episodeRevalidationCount === 0 &&
				livePlan?.kind === "verified_sonarr_episode" &&
				livePlan.episode.monitored !== safetyPlan.episode.monitored &&
				!(safetyPlan.episode.monitored === true && livePlan.episode.monitored === false)
			) {
				throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
					"Skipped for safety: the Sonarr episode monitored state changed before deletion.",
				);
			}
			if (
				target.action === "delete_files" &&
				livePlan?.kind === "verified_sonarr_episode" &&
				livePlan.episode.monitored !== safetyPlan.episode.monitored
			) {
				throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
					"Skipped for safety: the Sonarr episode monitored state changed before file deletion.",
				);
			}
			if (
				target.action === "delete" &&
				episodeRevalidationCount > 0 &&
				livePlan?.kind === "verified_sonarr_episode" &&
				livePlan.episode.monitored !== false
			) {
				throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
					"Skipped for safety: the Sonarr episode was re-monitored before file deletion.",
				);
			}
			episodeRevalidationCount++;
			const liveEpisodeWatchSources = context.liveEpisodeWatchSources.get(targetKey);
			if (!liveEpisodeWatchSources?.length) {
				throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
					"Skipped for safety: the live Plex episode watch counts were unavailable at the mutation boundary.",
				);
			}
			await assertMutationAuthority?.({ liveEpisodeWatchSources });
			return;
		}
		if (
			(safetyPlan.kind !== "verified_radarr" && safetyPlan.kind !== "verified_sonarr") ||
			(safetyPlan.peers.length === 0 && target.respectQuiSeeding !== true)
		) {
			return;
		}
		if (ownershipRevalidationCount === 0) {
			if (
				isVerifiedSonarrRecordOnlyRetry(target.action ?? "delete", safetyPlan) &&
				safetyPlan.files.episodeFiles.length === 0
			) {
				await assertVerifiedSonarrPeerOwnershipRetained(deps, userId, target.arrItemId, safetyPlan);
			} else {
				const context = createSharedPlexSafetyContext();
				const blocks = await findSharedPlexDeleteBlocks(deps, userId, [target], context);
				const targetKey = cleanupDeleteTargetKey(target);
				const livePlan = asExecutableSafetyPlan(context.plans.get(targetKey));
				if (
					blocks.has(targetKey) ||
					!livePlan ||
					!executableSafetyPlansEqual(safetyPlan, livePlan)
				) {
					const service = safetyPlan.kind === "verified_radarr" ? "Radarr" : "Sonarr";
					throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
						`Skipped for safety: the verified ${service} ownership changed at the mutation boundary, or its qUI physical-file evidence changed. Run cleanup again before deleting the file.`,
					);
				}
			}
		} else if (safetyPlan.peers.length === 0) {
			// qUI-only authority is consumed immediately before the one
			// physical-file mutation. Later record-only writes do not need to
			// stat a path that was deliberately removed.
			await assertMutationAuthority?.(evidence);
			return;
		} else if (safetyPlan.kind === "verified_radarr") {
			await assertVerifiedRadarrPeerOwnershipRetained(deps, userId, target.arrItemId, safetyPlan);
		} else {
			await assertVerifiedSonarrPeerOwnershipRetained(deps, userId, target.arrItemId, safetyPlan);
		}
		ownershipRevalidationCount++;
		await assertMutationAuthority?.(evidence);
	};
}

async function withQuiPhysicalMutationGuard<T>(
	userId: string,
	respectQuiSeeding: boolean,
	operation: () => Promise<T>,
): Promise<T> {
	return respectQuiSeeding ? withQuiObservationTopologyGuard(userId, operation) : operation();
}

async function persistAndClaimDirectMutationIntent(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig,
	userId: string,
	item: FlaggedItem,
	safetyPlan: SharedMediaSafetyPlan,
	providerEvidence: SanitizedProviderEvidence = createSanitizedProviderEvidence([], []),
): Promise<{
	id: string;
	claimed: boolean;
	executionToken: string;
	safetySnapshot: string | null;
}> {
	const executablePlan = asExecutableSafetyPlan(safetyPlan);
	if (!executablePlan) {
		throw new Error("No executable cleanup safety plan was available for the mutation intent");
	}
	const safetySnapshot = serializeExecutableSafetyPlan(executablePlan, providerEvidence);
	const retryEventFingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				safetySnapshot,
				item.cacheItem.cachedAt?.toISOString() ?? null,
				item.match.action,
				item.match.scanMediaServerAfterDelete,
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

	let created = false;
	try {
		await deps.prisma.libraryCleanupApproval.create({
			data: {
				id: intentId,
				configId: config.id,
				instanceId: item.cacheItem.instanceId,
				arrItemId: item.cacheItem.arrItemId,
				itemType: item.cacheItem.itemType,
				targetScope: item.episodeTarget ? "episode" : "series",
				arrEpisodeId: item.episodeTarget?.arrEpisodeId,
				episodeFileId: item.episodeTarget?.episodeFileId,
				seasonNumber: item.episodeTarget?.seasonNumber,
				episodeNumber: item.episodeTarget?.episodeNumber,
				title: item.cacheItem.title,
				episodeTitle: item.episodeTarget?.episodeTitle,
				matchedRuleId: item.match.ruleId,
				matchedRuleName: item.match.ruleName,
				reason: item.match.reason,
				action: item.match.action,
				scanMediaServerAfterDelete: item.match.scanMediaServerAfterDelete,
				sizeOnDisk: item.cacheItem.sizeOnDisk,
				year: item.cacheItem.year,
				rating: item.rating,
				status: "retry_pending",
				safetySnapshot,
				lastExecutionError: null,
				expiresAt: new Date(now.getTime() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
			},
		});
		created = true;
	} catch (error) {
		if ((error as { code?: string }).code !== "P2002") throw error;
	}

	const claim = await deps.prisma.libraryCleanupApproval.updateMany({
		where: {
			id: intentId,
			config: { userId },
			status: "retry_pending",
		},
		data: {
			status: "retry_executing",
			reviewedAt: now,
			executionToken,
			executionAuditCorrelationId: executionToken,
			terminalAuditRecordedAt: null,
		},
	});
	const claimedIntent =
		claim.count === 1 && !created
			? await deps.prisma.libraryCleanupApproval.findFirst({
					where: {
						id: intentId,
						config: { userId },
						status: "retry_executing",
						executionToken,
					},
					select: { safetySnapshot: true },
				})
			: null;
	if (claim.count === 1 && !created && !claimedIntent) {
		throw new Error("Claimed cleanup mutation intent could not be reloaded");
	}
	return {
		id: intentId,
		claimed: claim.count === 1,
		executionToken,
		safetySnapshot: created ? safetySnapshot : (claimedIntent?.safetySnapshot ?? null),
	};
}

async function buildEvaluatedCacheSafetyPlan(
	prisma: CleanupExecutorDeps["prisma"],
	item: CacheItemForEval,
	livePlan: ExecutableSharedMediaSafetyPlan,
	episodeTarget?: FlaggedItem["episodeTarget"],
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
		const cachePlan = buildRadarrCacheSafetyPlan(data, item.hasFile, livePlan.target);
		return cachePlan?.kind === "verified_radarr" && livePlan.kind === "verified_radarr"
			? {
					...cachePlan,
					quiEvidence: livePlan.quiEvidence,
					peers: livePlan.peers,
					ownership: livePlan.ownership,
					targetDeleteNotifications: livePlan.targetDeleteNotifications,
				}
			: cachePlan;
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
	if (livePlan.kind === "verified_sonarr_episode") {
		if (
			!episodeTarget ||
			episodeTarget.arrEpisodeId !== livePlan.episode.arrEpisodeId ||
			episodeTarget.seasonNumber !== livePlan.episode.seasonNumber ||
			episodeTarget.episodeNumber !== livePlan.episode.episodeNumber ||
			episodeTarget.episodeFileId !== livePlan.episode.episodeFileId ||
			JSON.stringify(episodeTarget.episodeFileConsumerIds) !==
				JSON.stringify(livePlan.episode.episodeFileConsumerIds) ||
			cachePlan?.kind !== "verified_sonarr"
		) {
			return null;
		}
		const selectedFile = cachePlan.files.episodeFiles.find(
			(file) => file.episodeFileId === livePlan.selectedFile.episodeFileId,
		);
		if (!selectedFile) return null;
		return {
			kind: "verified_sonarr_episode",
			target: cachePlan.target,
			episode: livePlan.episode,
			selectedFile,
			retainedTargetFiles: cachePlan.files.episodeFiles.filter(
				(file) => file.episodeFileId !== selectedFile.episodeFileId,
			),
			watchProof: livePlan.watchProof,
			quiIdentity: livePlan.quiIdentity,
			quiEvidence: livePlan.quiEvidence,
			peers: livePlan.peers,
			ownership: livePlan.ownership,
			targetDeleteNotifications: livePlan.targetDeleteNotifications,
		};
	}
	return cachePlan?.kind === "verified_sonarr"
		? {
				...cachePlan,
				quiEvidence: livePlan.quiEvidence,
				peers: livePlan.peers,
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
		const targetKey = cleanupDeleteTargetKey(flaggedDeleteTarget(item));
		if (blocks.has(targetKey)) continue;
		const livePlan = asExecutableSafetyPlan(context.plans.get(targetKey));
		if (!livePlan) continue;
		let cachePlan: ExecutableSharedMediaSafetyPlan | null = null;
		try {
			const serviceUpdatedAt = instanceUpdatedAt.get(item.cacheItem.instanceId);
			if (
				!item.cacheItem.cachedAt ||
				!serviceUpdatedAt ||
				item.cacheItem.cachedAt < serviceUpdatedAt
			) {
				throw new Error("Cached ARR item predates the current service configuration");
			}
			cachePlan = await buildEvaluatedCacheSafetyPlan(
				deps.prisma,
				item.cacheItem,
				livePlan,
				item.episodeTarget,
			);
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
		if (cachePlan && executableSafetyPlansEqual(cachePlan, livePlan)) continue;

		const reason =
			"Skipped for safety: the live ARR file identity differs from the cached item evaluated by this cleanup rule. Sync the library and run cleanup again.";
		blocks.set(targetKey, reason);
		context.plans.set(targetKey, { kind: "blocked", reason });
	}
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
		const safetyReason = sharedPlexBlocks.get(cleanupDeleteTargetKey(flaggedDeleteTarget(item)));
		return buildDetail(item, safetyReason ? "skipped" : item.match.action, safetyReason);
	});
}

// ============================================================================
// Preview (Dry Run)
// ============================================================================

interface DirectSelectionState {
	plan: CleanupSelectionPlan<FlaggedItem, LibraryCleanupApproval>;
	pendingRetryCount: number | null;
	retryStateLoaded: boolean;
	warnings: string[];
}

interface ApprovalSelectionState {
	plan: CleanupSelectionPlan<FlaggedItem, LibraryCleanupApproval>;
	selected: FlaggedItem[];
	skippedDetails: CleanupRunResult["details"];
	pendingRetryCount: number | null;
	retryStateLoaded: boolean;
	warnings: string[];
}

async function loadDirectSelectionState(
	deps: CleanupExecutorDeps,
	userId: string,
	configId: string,
	flagged: FlaggedItem[],
	limit: number,
): Promise<DirectSelectionState> {
	const warnings: string[] = [];
	let previousRunStartedAt: Date | undefined;
	try {
		const previousRun = await deps.prisma.libraryCleanupLog.findFirst({
			where: { configId, isDryRun: false, completedAt: { not: null } },
			orderBy: { startedAt: "desc" },
			select: { startedAt: true },
		});
		previousRunStartedAt = previousRun?.startedAt;
	} catch (error) {
		deps.log.warn(
			{ err: error, configId },
			"Cleanup could not load its prior run boundary for retry fairness",
		);
		warnings.push(
			"Retry fairness history could not be loaded; existing retries retain their normal deterministic order.",
		);
	}

	try {
		const [pendingRetries, inFlightRetries] = await Promise.all([
			deps.prisma.libraryCleanupApproval.findMany({
				where: { configId, config: { userId }, status: "retry_pending" },
				orderBy: [
					{ reviewedAt: { sort: "asc", nulls: "first" } },
					{ createdAt: "asc" },
					{ id: "asc" },
				],
			}),
			deps.prisma.libraryCleanupApproval.findMany({
				where: { configId, config: { userId }, status: "retry_executing" },
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
			}),
		]);
		const plan = planCleanupSelection<FlaggedItem, LibraryCleanupApproval>({
			mode: "direct",
			limit,
			fresh: flagged.map((item) => ({
				key: cleanupDeleteTargetKey(flaggedDeleteTarget(item)),
				value: item,
			})),
			pendingRetries: pendingRetries.map((retry) => ({
				id: retry.id,
				key: cleanupApprovalTargetKey(retry),
				value: retry,
				reviewedAt: retry.reviewedAt,
				createdAt: retry.createdAt,
			})),
			inFlightRetries: inFlightRetries.map((retry) => ({
				id: retry.id,
				key: cleanupApprovalTargetKey(retry),
				value: retry,
				reviewedAt: retry.reviewedAt,
				createdAt: retry.createdAt,
			})),
			previousRunStartedAt,
			retryStateLoaded: true,
		});
		if (pendingRetries.length > 0) {
			warnings.push(
				`${pendingRetries.length} durable cleanup ${
					pendingRetries.length === 1 ? "retry is" : "retries are"
				} pending. Preview shows retry attempts, not predicted mutation outcomes.`,
			);
		}
		if (inFlightRetries.length > 0) {
			warnings.push(
				`${inFlightRetries.length} durable cleanup ${
					inFlightRetries.length === 1 ? "retry is" : "retries are"
				} already executing and deferred from this run.`,
			);
		}
		return {
			plan,
			pendingRetryCount: pendingRetries.length,
			retryStateLoaded: true,
			warnings,
		};
	} catch (error) {
		deps.log.error({ err: error, configId }, "Cleanup could not load durable ARR retries");
		warnings.push(
			"Durable cleanup retry state could not be loaded. Fresh cleanup work is deferred for safety.",
		);
		return {
			plan: planCleanupSelection<FlaggedItem, LibraryCleanupApproval>({
				mode: "direct",
				limit,
				fresh: flagged.map((item) => ({
					key: cleanupDeleteTargetKey(flaggedDeleteTarget(item)),
					value: item,
				})),
				pendingRetries: [],
				inFlightRetries: [],
				previousRunStartedAt,
				retryStateLoaded: false,
			}),
			pendingRetryCount: null,
			retryStateLoaded: false,
			warnings,
		};
	}
}

function asPreviewDisposition(
	disposition: CleanupSelectionPlan<
		FlaggedItem,
		LibraryCleanupApproval
	>["decisions"][number]["disposition"],
): "selected" | "deferred" | "in_flight" {
	if (disposition === "selected") return "selected";
	if (disposition === "in_flight") return "in_flight";
	return "deferred";
}

function asRetryRuleAction(action: string | null): RuleAction | undefined {
	if (action === null) return "delete";
	return action === "delete" || action === "delete_files" || action === "unmonitor"
		? action
		: undefined;
}

function buildDirectSelectionPreviewDetails(
	state: DirectSelectionState,
	sharedPlexBlocks: Map<string, string>,
	limit = CLEANUP_DETAIL_LIMIT,
): CleanupRunResult["details"] {
	const details: CleanupRunResult["details"] = [];
	for (const { value: retry } of state.plan.selectedRetries) {
		if (details.length >= limit) break;
		const plannedAction = asRetryRuleAction(retry.action);
		details.push({
			...buildRetryDetail(
				retry,
				plannedAction ?? "skipped",
				"Selected for a retry attempt in the next cleanup run. The mutation outcome depends on live ARR authority and is not predicted.",
			),
			previewDisposition: "selected",
			plannedAction,
			isRetryAttempt: true,
		});
	}
	for (const { value: item } of state.plan.selectedFresh) {
		if (details.length >= limit) break;
		const safetyReason = sharedPlexBlocks.get(cleanupDeleteTargetKey(flaggedDeleteTarget(item)));
		details.push({
			...buildDetail(item, safetyReason ? "skipped" : item.match.action, safetyReason),
			previewDisposition: safetyReason ? "blocked" : "selected",
			plannedAction: item.match.action,
		});
	}
	for (const decision of state.plan.decisions) {
		if (details.length >= limit) break;
		if (decision.disposition === "selected") continue;
		const value = decision.candidate.value;
		if ("cacheItem" in value) {
			details.push({
				...buildDetail(value, "skipped", decision.reason),
				previewDisposition: asPreviewDisposition(decision.disposition),
				plannedAction: value.match.action,
			});
		} else {
			details.push({
				...buildRetryDetail(value, "skipped", decision.reason),
				previewDisposition: asPreviewDisposition(decision.disposition),
				plannedAction: asRetryRuleAction(value.action),
				isRetryAttempt: true,
			});
		}
	}
	return details;
}

/**
 * Run a preview evaluation without making any changes.
 * Returns all items that would be flagged by the current rule set.
 */
export async function executeCleanupPreview(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupRunResultWithProviderEvidence> {
	const startTime = Date.now();
	const { prisma, log } = deps;

	const config = await prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
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

	if (!config.enabled || config.rules.length === 0) {
		const inactiveWarning = !config.enabled
			? "Library cleanup is disabled, so the next run will not select any targets."
			: undefined;
		return {
			isDryRun: true,
			status: inactiveWarning ? "partial" : "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			pendingRetryCount: 0,
			previewItemCount: 0,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: Date.now() - startTime,
			warnings: inactiveWarning ? [inactiveWarning] : undefined,
		};
	}

	const { flagged, totalEvaluated, prefetchHealth, warnings, providerEvidence } =
		await evaluateAllItems(deps, config, config.rules);
	const configuredRunLimit =
		Number.isSafeInteger(config.maxRemovalsPerRun) &&
		config.maxRemovalsPerRun > 0 &&
		config.maxRemovalsPerRun <= 100
			? config.maxRemovalsPerRun
			: 0;
	let selectedFresh: FlaggedItem[];
	let details: CleanupRunResult["details"];
	let pendingRetryCount: number | null = 0;
	let previewSelection: NonNullable<CleanupRunResult["previewSelection"]>;
	let selectionWarnings: string[] = [];
	let directSelection: DirectSelectionState | undefined;

	if (config.requireApproval) {
		const approvalSelection = await loadApprovalSelectionState(
			deps,
			config,
			userId,
			flagged,
			configuredRunLimit,
		);
		selectedFresh = approvalSelection.selected;
		details = approvalSelection.skippedDetails;
		pendingRetryCount = approvalSelection.pendingRetryCount;
		selectionWarnings = approvalSelection.warnings;
		previewSelection = {
			...approvalSelection.plan.counts,
			blocked: 0,
		};
	} else {
		directSelection = await loadDirectSelectionState(
			deps,
			userId,
			config.id,
			flagged,
			configuredRunLimit,
		);
		selectedFresh = directSelection.plan.selectedFresh.map((candidate) => candidate.value);
		pendingRetryCount = directSelection.pendingRetryCount;
		selectionWarnings = directSelection.warnings;
		details = buildDirectSelectionPreviewDetails(directSelection, new Map());
		previewSelection = {
			...directSelection.plan.counts,
			blocked: 0,
		};
	}

	const safetyContext = createSharedPlexSafetyContext();
	const sharedPlexBlocks = await findSharedPlexDeleteBlocks(
		deps,
		userId,
		toDeleteTargets(selectedFresh),
		safetyContext,
	);
	await blockPlansThatDifferFromEvaluatedCache(
		deps,
		userId,
		selectedFresh,
		safetyContext,
		sharedPlexBlocks,
	);
	const allWarnings = withSharedPlexWarning(
		[...warnings, ...selectionWarnings],
		sharedPlexBlocks.size,
	);
	previewSelection.blocked = sharedPlexBlocks.size;
	details = directSelection
		? buildDirectSelectionPreviewDetails(directSelection, sharedPlexBlocks)
		: [
				...selectedFresh.map((item) => {
					const safetyReason = sharedPlexBlocks.get(
						cleanupDeleteTargetKey(flaggedDeleteTarget(item)),
					);
					return {
						...buildDetail(item, safetyReason ? "skipped" : item.match.action, safetyReason),
						previewDisposition: safetyReason ? ("blocked" as const) : ("selected" as const),
						plannedAction: item.match.action,
					};
				}),
				...details,
			].slice(0, CLEANUP_DETAIL_LIMIT);

	const hasWarnings = allWarnings.length > 0;
	log.info(
		{
			totalEvaluated,
			totalRuleMatches: flagged.length,
			selectedFresh: previewSelection.selectedFresh,
			selectedRetries: previewSelection.selectedRetries,
			pendingRetryCount,
			sharedPlexBlocks: sharedPlexBlocks.size,
			hasWarnings,
		},
		"Library cleanup preview completed",
	);

	return {
		isDryRun: true,
		status: hasWarnings ? ("partial" as const) : ("completed" as const),
		itemsEvaluated: totalEvaluated,
		itemsFlagged: flagged.length,
		pendingRetryCount,
		selectionCountsComplete: previewSelection.retryState === "complete",
		previewItemCount: previewSelection.total,
		previewSelection,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped:
			previewSelection.deferredBudget +
			previewSelection.deferredApproval +
			previewSelection.deferredRetryFairness +
			previewSelection.deferredInFlightTarget +
			previewSelection.deferredDuplicateTarget +
			previewSelection.inFlight +
			previewSelection.retryStateUnavailable +
			previewSelection.blocked,
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings: allWarnings,
		providerEvidence,
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

async function executeConfiguredCleanupDryRun(
	deps: CleanupExecutorDeps,
	userId: string,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	startTime: number,
): Promise<CleanupRunResultWithProviderEvidence> {
	const { flagged, totalEvaluated, prefetchHealth, warnings, providerEvidence } =
		await evaluateAllItems(deps, config, config.rules);
	const configuredRunLimit =
		Number.isSafeInteger(config.maxRemovalsPerRun) &&
		config.maxRemovalsPerRun > 0 &&
		config.maxRemovalsPerRun <= 100
			? config.maxRemovalsPerRun
			: 0;
	let selectedFresh: FlaggedItem[];
	let selectionDetails: CleanupRunResult["details"];
	let selectionCounts: NonNullable<CleanupRunResult["previewSelection"]>;
	let pendingRetryCount: number | null = 0;
	let selectionWarnings: string[] = [];
	let directSelection: DirectSelectionState | undefined;
	if (config.requireApproval) {
		const approvalSelection = await loadApprovalSelectionState(
			deps,
			config,
			userId,
			flagged,
			configuredRunLimit,
		);
		selectedFresh = approvalSelection.selected;
		selectionDetails = approvalSelection.skippedDetails;
		selectionCounts = { ...approvalSelection.plan.counts, blocked: 0 };
		pendingRetryCount = approvalSelection.pendingRetryCount;
		selectionWarnings = approvalSelection.warnings;
	} else {
		directSelection = await loadDirectSelectionState(
			deps,
			userId,
			config.id,
			flagged,
			configuredRunLimit,
		);
		selectedFresh = directSelection.plan.selectedFresh.map((candidate) => candidate.value);
		selectionDetails = [];
		selectionCounts = { ...directSelection.plan.counts, blocked: 0 };
		pendingRetryCount = directSelection.pendingRetryCount;
		selectionWarnings = directSelection.warnings;
	}
	const safetyContext = createSharedPlexSafetyContext();
	const sharedPlexBlocks = await findSharedPlexDeleteBlocks(
		deps,
		userId,
		toDeleteTargets(selectedFresh),
		safetyContext,
	);
	await blockPlansThatDifferFromEvaluatedCache(
		deps,
		userId,
		selectedFresh,
		safetyContext,
		sharedPlexBlocks,
	);
	const allWarnings = withSharedPlexWarning(
		[...warnings, ...selectionWarnings],
		sharedPlexBlocks.size,
	);
	selectionCounts.blocked = sharedPlexBlocks.size;
	const details = directSelection
		? buildDirectSelectionPreviewDetails(directSelection, sharedPlexBlocks)
		: [
				...selectedFresh.map((item) => {
					const safetyReason = sharedPlexBlocks.get(
						cleanupDeleteTargetKey(flaggedDeleteTarget(item)),
					);
					return {
						...buildDetail(item, safetyReason ? "skipped" : item.match.action, safetyReason),
						previewDisposition: safetyReason ? ("blocked" as const) : ("selected" as const),
						plannedAction: item.match.action,
					};
				}),
				...selectionDetails,
			];

	const result: CleanupRunResultWithProviderEvidence = {
		isDryRun: true,
		status: allWarnings.length > 0 ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: flagged.length,
		pendingRetryCount,
		selectionCountsComplete: selectionCounts.retryState === "complete",
		previewItemCount: selectionCounts.total,
		previewSelection: selectionCounts,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped:
			selectionCounts.deferredBudget +
			selectionCounts.deferredApproval +
			selectionCounts.deferredRetryFairness +
			selectionCounts.deferredInFlightTarget +
			selectionCounts.deferredDuplicateTarget +
			selectionCounts.inFlight +
			selectionCounts.retryStateUnavailable +
			selectionCounts.blocked,
		details,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings: allWarnings,
		providerEvidence,
	};

	return result;
}

async function executeCleanupRunGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupRunResult> {
	const startTime = Date.now();
	const { prisma } = deps;

	const preLeaseConfig = await prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
	});

	if (!preLeaseConfig?.enabled) {
		return {
			isDryRun: preLeaseConfig?.dryRunMode ?? true,
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
	if (preLeaseConfig.dryRunMode) {
		return await executeConfiguredCleanupDryRun(deps, userId, preLeaseConfig, startTime);
	}
	const runLease = await startCleanupRunLease(deps, userId, preLeaseConfig.id);
	try {
		// Mutation authority begins only after exclusive run ownership. Re-read
		// every policy-bearing field under the lease rather than trusting the
		// identity lookup that preceded acquisition.
		const config = await prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
		});
		if (!config || config.id !== preLeaseConfig.id || !config.enabled) {
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
			return await executeConfiguredCleanupDryRun(deps, userId, config, startTime);
		}
		let priorRescanWarnings: string[] = [];
		if (!deps.skipPendingMediaServerRescanRetry) {
			try {
				const retryResult = await retryPendingMediaServerRescans(
					deps,
					userId,
					runLease.assertOwnership,
				);
				priorRescanWarnings = retryResult.warnings;
			} catch (error) {
				priorRescanWarnings = [
					"Pending media-server scan follow-up could not be checked and remains independently retryable.",
				];
				deps.log.warn({ err: error }, "Pending cleanup media-server scans could not be retried");
			}
		}
		if (config.rules.length === 0) {
			return {
				isDryRun: false,
				status: priorRescanWarnings.length > 0 ? "partial" : "completed",
				itemsEvaluated: 0,
				itemsFlagged: 0,
				itemsRemoved: 0,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				itemsSkipped: 0,
				details: [],
				durationMs: Date.now() - startTime,
				warnings: priorRescanWarnings.length > 0 ? priorRescanWarnings : undefined,
			};
		}

		const {
			flagged,
			totalEvaluated,
			prefetchHealth,
			warnings,
			providerEvidence,
			providerAuthorities,
		} = await evaluateAllItems(deps, config, config.rules);
		// Real execution
		if (config.requireApproval) {
			const approvalSelection = await loadApprovalSelectionState(
				deps,
				config,
				userId,
				flagged,
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
			const allWarnings = withSharedPlexWarning(
				[...priorRescanWarnings, ...warnings, ...approvalSelection.warnings],
				sharedPlexBlocks.size,
			);
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
				providerEvidence,
				providerAuthorities,
				approvalSelection.skippedDetails,
				approvalSelection,
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
			[...priorRescanWarnings, ...warnings],
			new Map(),
			runLease.assertOwnership,
			providerEvidence,
			providerAuthorities,
			runLease.claimToken,
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
): Promise<{ removed: number; failed: number; errors: string[]; warnings?: string[] }> {
	return await withCleanupOperationGuard(() =>
		executeApprovedItemsGuarded(deps, userId, approvalIds, approvalRequestToken),
	);
}

async function executeApprovedItemsGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalIds: string[],
	approvalRequestToken?: string,
): Promise<{ removed: number; failed: number; errors: string[]; warnings?: string[] }> {
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
			auditCorrelationId: approvalRequestToken,
			cleanupRunClaimToken: runLease.claimToken,
		});
		const unclaimedErrors = result.unclaimedIds.map(
			() => "Cleanup approval was not found, expired, no longer approved, or changed ownership.",
		);
		return {
			removed: result.removed,
			failed: result.failed + unclaimedErrors.length,
			errors: [...result.errors, ...unclaimedErrors],
			...(result.warnings?.length ? { warnings: result.warnings } : {}),
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
): Promise<{
	removed: number;
	reconciled: number;
	failed: number;
	errors: string[];
	warnings?: string[];
}> {
	return await withCleanupOperationGuard(() => executeRetryItemsGuarded(deps, userId, retryIds));
}

async function executeRetryItemsGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
	retryIds: string[],
): Promise<{
	removed: number;
	reconciled: number;
	failed: number;
	errors: string[];
	warnings?: string[];
}> {
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
			cleanupRunClaimToken: runLease.claimToken,
		});
		const unclaimedErrors = result.unclaimedIds.map(
			() => "Cleanup retry was not found, was no longer pending, or changed ownership.",
		);
		return {
			removed: result.removed,
			reconciled: result.reconciledIds.length,
			failed: result.failed + unclaimedErrors.length,
			errors: [...result.errors, ...unclaimedErrors],
			...(result.warnings?.length ? { warnings: result.warnings } : {}),
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
	executionCorrelationIds: Record<string, string>;
	auditPreparedIds: string[];
	mutationAttemptedIds: string[];
	warnings?: string[];
	rescanApprovalIds: string[];
	providerAuthorityFailed: boolean;
}

async function retryTargetRecordIsAbsent(
	deps: CleanupExecutorDeps,
	instance: ServiceInstance,
	arrItemId: number,
	safetySnapshot: unknown,
	action: RuleAction,
): Promise<"record_absent" | "episode_action_complete" | "series_action_complete" | false> {
	const plan = parseExecutableSafetyPlan(safetySnapshot);
	if (!plan || plan.target.serviceFingerprint !== createArrServiceFingerprint(instance)) {
		return false;
	}
	const client = deps.arrClientFactory.create(instance);
	if (
		instance.service === "RADARR" &&
		(plan.kind === "verified_arr_target" ||
			plan.kind === "verified_radarr" ||
			plan.kind === "verified_radarr_empty")
	) {
		try {
			const movie = await (client as InstanceType<typeof RadarrClient>).movie.getById(arrItemId);
			if (action === "unmonitor") {
				if (plan.kind !== "verified_arr_target") return false;
				assertVerifiedArrTargetUnchanged(instance, movie.tmdbId, movie.path, plan.target);
				return movie.monitored === false ? "series_action_complete" : false;
			}
		} catch (error) {
			if (isNotFoundError(error)) return "record_absent";
			throw error;
		}
		return false;
	}
	if (
		instance.service === "SONARR" &&
		(plan.kind === "verified_arr_target" ||
			plan.kind === "verified_sonarr" ||
			plan.kind === "verified_sonarr_episode")
	) {
		const sonarr = client as InstanceType<typeof SonarrClient>;
		let series: Awaited<ReturnType<typeof sonarr.series.getById>>;
		try {
			series = await sonarr.series.getById(arrItemId);
		} catch (error) {
			if (isNotFoundError(error)) return "record_absent";
			throw error;
		}
		if (plan.kind === "verified_sonarr_episode") {
			assertVerifiedArrTargetUnchanged(instance, series.tvdbId, series.path, plan.target);
			const episodes = (await sonarr.episode.getAll({
				seriesId: arrItemId,
				includeEpisodeFile: true,
			})) as unknown as Array<Record<string, unknown>>;
			const selected = episodes.find((episode) => episode.id === plan.episode.arrEpisodeId);
			if (
				!selected ||
				selected.seasonNumber !== plan.episode.seasonNumber ||
				selected.episodeNumber !== plan.episode.episodeNumber
			) {
				throw new ArrTargetChangedDuringSafetyCheckError();
			}
			if (action === "unmonitor") {
				return selected.monitored === false ? "episode_action_complete" : false;
			}
			if (typeof selected.episodeFileId === "number" && selected.episodeFileId > 0) {
				// The old file still exists or a replacement appeared. Neither
				// can be reconciled as an already-completed retry.
				return false;
			}
			if (episodes.some((episode) => episode.episodeFileId === plan.selectedFile.episodeFileId)) {
				throw new ArrTargetChangedDuringSafetyCheckError();
			}
			const episodeFiles = await sonarr.episodeFile.getBySeries(arrItemId);
			if (episodeFiles.some((file) => file.id === plan.selectedFile.episodeFileId)) {
				return false;
			}
			if (action === "delete" && selected.monitored !== false) {
				return false;
			}
			return "episode_action_complete";
		}
		if (action === "unmonitor") {
			if (plan.kind !== "verified_arr_target") return false;
			assertVerifiedArrTargetUnchanged(instance, series.tvdbId, series.path, plan.target);
			return series.monitored === false ? "series_action_complete" : false;
		}
		return false;
	}
	return false;
}

/**
 * Re-check the current parent-series retention policy immediately before an
 * episode mutation. Pending approvals are durable intent, not durable
 * authorization: a series that became protected after preview must fail closed.
 */
export function liveSonarrRetentionRuleTypes(rule: LibraryCleanupRule): string[] | null {
	const expression = normalizeStoredCleanupRuleExpression(rule);
	if (!expression) return null;
	const ruleTypes: string[] = [];
	const stack: CleanupRuleExpression[] = [expression.root];
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (node.type === "condition") ruleTypes.push(node.ruleType);
		else if (node.type === "group") stack.push(...node.children);
		else stack.push(node.child);
	}
	return ruleTypes;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function hasCompleteLiveSonarrTags(rawSeries: Record<string, unknown>): boolean {
	return (
		Array.isArray(rawSeries.tags) &&
		rawSeries.tags.every(
			(tag) =>
				(typeof tag === "number" && Number.isFinite(tag)) ||
				(typeof tag === "string" && tag.trim().length > 0),
		)
	);
}

function hasCompleteLiveSonarrEvidenceForRuleType(
	rawSeries: Record<string, unknown>,
	ruleType: string,
	parameters: Record<string, unknown>,
): boolean {
	const statistics =
		typeof rawSeries.statistics === "object" && rawSeries.statistics !== null
			? (rawSeries.statistics as Record<string, unknown>)
			: null;

	switch (ruleType) {
		case "age":
			return (
				typeof rawSeries.added === "string" && !Number.isNaN(new Date(rawSeries.added).getTime())
			);
		case "size":
			return isFiniteNumber(statistics?.sizeOnDisk);
		case "rating":
			return arrPolicyEvidenceFromRaw(rawSeries, "sonarr").rating;
		case "imdb_rating":
			return false;
		case "status":
			return typeof rawSeries.status === "string" && rawSeries.status.trim().length > 0;
		case "monitored":
		case "unmonitored":
			return typeof rawSeries.monitored === "boolean";
		case "genre":
			return (
				Array.isArray(rawSeries.genres) &&
				rawSeries.genres.every((genre) => typeof genre === "string")
			);
		case "year_range":
			return isFiniteNumber(rawSeries.year);
		case "no_file":
			return (
				isFiniteNumber(statistics?.episodeFileCount) || isFiniteNumber(rawSeries.episodeFileCount)
			);
		case "quality_profile": {
			const profile =
				typeof rawSeries.qualityProfile === "object" && rawSeries.qualityProfile !== null
					? (rawSeries.qualityProfile as Record<string, unknown>)
					: null;
			return (
				(typeof profile?.name === "string" && profile.name.length > 0) ||
				(typeof rawSeries.profileName === "string" && rawSeries.profileName.length > 0)
			);
		}
		case "language":
			if (typeof rawSeries.originalLanguage === "string") {
				return rawSeries.originalLanguage.trim().length > 0;
			}
			if (
				typeof rawSeries.originalLanguage === "object" &&
				rawSeries.originalLanguage !== null &&
				!Array.isArray(rawSeries.originalLanguage)
			) {
				const name = (rawSeries.originalLanguage as Record<string, unknown>).name;
				return typeof name === "string" && name.trim().length > 0;
			}
			return (
				Array.isArray(rawSeries.languages) &&
				rawSeries.languages.every(
					(language) =>
						(typeof language === "string" && language.trim().length > 0) ||
						(typeof language === "object" &&
							language !== null &&
							!Array.isArray(language) &&
							typeof (language as Record<string, unknown>).name === "string"),
				)
			);
		case "runtime":
			return isFiniteNumber(rawSeries.runtime) || isFiniteNumber(statistics?.runtime);
		case "file_path":
			if ((parameters.field ?? "path") === "rootFolderPath") {
				return typeof rawSeries.rootFolderPath === "string" && rawSeries.rootFolderPath.length > 0;
			}
			return typeof rawSeries.path === "string" && rawSeries.path.length > 0;
		case "tag_match":
			return hasCompleteLiveSonarrTags(rawSeries);
		default:
			// Provider-backed, list-backed, file-metadata, and unknown rules
			// cannot be proven from a live Sonarr series response alone.
			return false;
	}
}

function liveSonarrConditionEvidence(
	rawSeries: Record<string, unknown>,
): ConditionEvidenceAvailability {
	return (ruleType, parameters) =>
		hasCompleteLiveSonarrEvidenceForRuleType(rawSeries, ruleType, parameters);
}

/**
 * Episode proposals must remain executable under an unchanged policy. The
 * mutation boundary trusts only fresh Sonarr series evidence, so discovery
 * applies that same evidence boundary and allows an episode only when every
 * applicable series rule is provably FALSE. Kleene-determined expressions such
 * as FALSE AND UNKNOWN remain verifiable; UNKNOWN-affecting outcomes block.
 */
export function episodeSeriesPolicyMutationVerifiability(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	now: Date = new Date(),
): { verifiable: boolean; blockingRuleIds: string[] } {
	const parsed = safeJsonParse(item.data);
	const evidenceAvailability =
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? liveSonarrConditionEvidence(parsed as Record<string, unknown>)
			: () => false;
	const blockingRuleIds = rules
		.filter(
			(rule) =>
				rule.enabled &&
				rule.targetScope !== "episode" &&
				passesCleanupRuleFilters(item, rule, "SONARR"),
		)
		.filter(
			(rule) =>
				evaluateRuleState(item, rule, "SONARR", { now }, undefined, evidenceAvailability).state !==
				"false",
		)
		.map((rule) => rule.id);
	return {
		verifiable: blockingRuleIds.length === 0,
		blockingRuleIds,
	};
}

function liveSonarrRuleApplies(
	rawSeries: Record<string, unknown>,
	item: CacheItemForEval,
	rule: LibraryCleanupRule,
): boolean {
	// Service, instance, and title filters do not depend on live tag evidence.
	// Apply them first so an unrelated rule cannot block this target merely
	// because Sonarr omitted its optional tags field.
	if (!passesCleanupRuleFilters(item, { ...rule, excludeTags: null }, "SONARR")) {
		return false;
	}

	const excludedTags = safeJsonParse(rule.excludeTags) as unknown;
	if (
		Array.isArray(excludedTags) &&
		excludedTags.length > 0 &&
		!hasCompleteLiveSonarrTags(rawSeries)
	) {
		throw new Error(`Live Sonarr tags were unavailable for cleanup rule ${rule.id}`);
	}

	return passesCleanupRuleFilters(item, rule, "SONARR");
}

function toLiveSeriesPolicyItem(
	instance: ServiceInstance,
	arrItemId: number,
	rawItem: Record<string, unknown>,
): CacheItemForEval {
	const service =
		instance.service === "RADARR" ? "radarr" : instance.service === "SONARR" ? "sonarr" : null;
	if (!service) throw new Error(`Unsupported live cleanup policy service: ${instance.service}`);

	const liveItem = buildLibraryItem(instance, service, rawItem);
	const liveItemId =
		typeof liveItem.id === "number" ? liveItem.id : Number.parseInt(String(liveItem.id), 10);
	const expectedType = service === "radarr" ? "movie" : "series";
	if (
		!Number.isSafeInteger(liveItemId) ||
		liveItemId !== arrItemId ||
		liveItem.type !== expectedType ||
		typeof liveItem.title !== "string" ||
		liveItem.title.trim().length === 0
	) {
		throw new Error("Live ARR item identity did not match the cleanup target");
	}
	const addedAt = liveItem.added ? new Date(liveItem.added) : null;
	const sizeOnDisk =
		typeof liveItem.sizeOnDisk === "number" &&
		Number.isSafeInteger(liveItem.sizeOnDisk) &&
		liveItem.sizeOnDisk > 0
			? BigInt(liveItem.sizeOnDisk)
			: 0n;
	const rawStatistics =
		typeof rawItem.statistics === "object" && rawItem.statistics !== null
			? (rawItem.statistics as Record<string, unknown>)
			: {};

	return {
		id: `live:${instance.id}:${expectedType}:${arrItemId}`,
		instanceId: instance.id,
		arrItemId,
		itemType: expectedType,
		title: liveItem.title,
		year: liveItem.year ?? null,
		monitored: liveItem.monitored ?? true,
		hasFile: liveItem.hasFile ?? false,
		status: liveItem.status ?? null,
		qualityProfileId: liveItem.qualityProfileId ?? null,
		qualityProfileName:
			liveItem.qualityProfileName ??
			(typeof rawItem.profileName === "string" ? rawItem.profileName : null),
		sizeOnDisk,
		arrAddedAt: addedAt && !Number.isNaN(addedAt.getTime()) ? addedAt : null,
		cachedAt: new Date(),
		data: JSON.stringify({
			...rawItem,
			...liveItem,
			statistics: {
				...rawStatistics,
				...liveItem.statistics,
			},
			_arrDashboardSource: {
				serviceFingerprint: createArrServiceFingerprint(instance),
			},
			_arrDashboardEvidence: arrPolicyEvidenceFromRaw(rawItem, service),
		}),
		infoHash: null,
		torrentState: null,
	};
}

type SeriesMutationTransition = "unchanged" | "all_files_deleted";

type MutationAuthorityEvidence =
	| { liveEpisodeWatchSources: VerifiedEpisodePlexWatchSource[] }
	| { seriesTransition: SeriesMutationTransition };

type MutationAuthorityCheck = (evidence?: MutationAuthorityEvidence) => Promise<void>;

interface AuthorizedSeriesMutationPolicy {
	snapshot: MutationPolicySnapshot;
	rawItem: Record<string, unknown>;
	policyItem: CacheItemForEval;
}

const RADARR_FILE_TRANSITION_FIELDS = new Set([
	"hasFile",
	"movieFile",
	"movieFileId",
	"sizeOnDisk",
]);
const RADARR_STATISTICS_FILE_TRANSITION_FIELDS = new Set([
	"movieFileCount",
	"releaseGroups",
	"sizeOnDisk",
]);
const SONARR_FILE_TRANSITION_FIELDS = new Set([
	"episodeFile",
	"episodeFileCount",
	"hasFile",
	"sizeOnDisk",
]);
const SONARR_STATISTICS_FILE_TRANSITION_FIELDS = new Set([
	"episodeCount",
	"episodeFileCount",
	"percentOfEpisodes",
	"releaseGroups",
	"sizeOnDisk",
]);

/**
 * Remove only ARR fields that a complete file deletion is expected to change.
 * Everything else in the authoritative response remains part of the mutation
 * boundary, including tags, ratings, status, paths, profiles, language, and
 * provider-correlation identifiers.
 */
function policyBearingArrStateOutsideFileTransition(
	value: unknown,
	service: "RADARR" | "SONARR",
	context: "root" | "statistics" | "nested" = "root",
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) =>
			policyBearingArrStateOutsideFileTransition(entry, service, "nested"),
		);
	}
	if (typeof value !== "object" || value === null) return value;

	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (context === "root") {
			if (service === "RADARR" && RADARR_FILE_TRANSITION_FIELDS.has(key)) continue;
			if (service === "SONARR" && SONARR_FILE_TRANSITION_FIELDS.has(key)) continue;
		}
		if (
			service === "RADARR" &&
			context === "statistics" &&
			RADARR_STATISTICS_FILE_TRANSITION_FIELDS.has(key)
		) {
			continue;
		}
		if (
			service === "SONARR" &&
			context === "statistics" &&
			SONARR_STATISTICS_FILE_TRANSITION_FIELDS.has(key)
		) {
			continue;
		}
		result[key] = policyBearingArrStateOutsideFileTransition(
			entry,
			service,
			key === "statistics" ? "statistics" : "nested",
		);
	}
	return result;
}

function assertExpectedSeriesArrTransition(
	instance: ServiceInstance,
	authorizedRawItem: Record<string, unknown>,
	currentRawItem: Record<string, unknown>,
	currentPolicyItem: CacheItemForEval,
	transition: SeriesMutationTransition,
): void {
	const service = instance.service;
	if (service !== "RADARR" && service !== "SONARR") {
		throw new Error(`Unsupported cleanup service: ${service}`);
	}

	if (transition === "unchanged") {
		if (evidenceFingerprint(currentRawItem) !== evidenceFingerprint(authorizedRawItem)) {
			throw new Error("Live ARR policy state changed outside an authorized mutation transition");
		}
		return;
	}

	const authorizedStableState = policyBearingArrStateOutsideFileTransition(
		authorizedRawItem,
		service,
	);
	const currentStableState = policyBearingArrStateOutsideFileTransition(currentRawItem, service);
	if (evidenceFingerprint(currentStableState) !== evidenceFingerprint(authorizedStableState)) {
		throw new Error("Live ARR policy state changed outside the expected file-deletion fields");
	}

	const evidence = arrPolicyEvidenceFromRaw(currentRawItem, service.toLowerCase());
	if (!evidence.hasFile || !evidence.sizeOnDisk) {
		throw new Error("ARR did not provide complete post-file-deletion policy evidence");
	}
	if (currentPolicyItem.hasFile || currentPolicyItem.sizeOnDisk !== 0n) {
		throw new Error("ARR did not expose the expected fileless post-deletion state");
	}
	if (service === "RADARR") {
		if (
			currentRawItem.hasFile !== false ||
			currentRawItem.sizeOnDisk !== 0 ||
			(typeof currentRawItem.movieFileId === "number" && currentRawItem.movieFileId > 0) ||
			(typeof currentRawItem.movieFile === "object" && currentRawItem.movieFile !== null)
		) {
			throw new Error("Radarr's post-file-deletion state was missing or ambiguous");
		}
		return;
	}

	const statistics =
		typeof currentRawItem.statistics === "object" && currentRawItem.statistics !== null
			? (currentRawItem.statistics as Record<string, unknown>)
			: null;
	if (statistics?.episodeFileCount !== 0 || statistics.sizeOnDisk !== 0) {
		throw new Error("Sonarr's post-file-deletion statistics were missing or ambiguous");
	}
}

/**
 * A series/movie may require multiple ARR writes. Its live item is evaluated
 * before the first write, but that first write can legitimately change fields
 * used by the rule. Before each later write, re-check the immutable policy
 * snapshot without treating our own prior mutation as an external policy
 * change.
 */
interface ExpectedCleanupRule {
	matchedRuleId: string;
	action: RuleAction;
	scanMediaServerAfterDelete: boolean;
}

export async function assertCurrentSeriesPolicySnapshotUnchanged(
	deps: CleanupExecutorDeps,
	userId: string,
	expectedRule: ExpectedCleanupRule,
	snapshot: MutationPolicySnapshot,
): Promise<void> {
	try {
		const config = await deps.prisma.libraryCleanupConfig.findUnique({
			where: { userId },
			include: { rules: true },
		});
		if (!config?.enabled) {
			throw new Error("The cleanup configuration is no longer enabled");
		}
		if (
			snapshot.configFingerprint &&
			completeMutationConfigFingerprint(config) !== snapshot.configFingerprint
		) {
			throw new Error("Cleanup mutation settings changed after the policy snapshot was captured");
		}
		const currentRules = config.rules
			.filter((rule) => rule.targetScope !== "episode")
			.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
		if (evidenceFingerprint(currentRules) !== snapshot.ruleFingerprint) {
			throw new Error("Cleanup rules changed after the mutation policy snapshot was captured");
		}
		const expectedCurrentRule = currentRules.find((rule) => rule.id === expectedRule.matchedRuleId);
		if (
			!expectedCurrentRule?.enabled ||
			expectedCurrentRule.retentionMode ||
			expectedCurrentRule.action !== expectedRule.action ||
			(expectedCurrentRule.scanMediaServerAfterDelete === true) !==
				expectedRule.scanMediaServerAfterDelete
		) {
			throw new Error("The matched cleanup rule or action changed after this item was queued");
		}
	} catch (error) {
		deps.log.warn(
			{ err: error, ruleId: expectedRule.matchedRuleId },
			"Cleanup policy changed during a series/movie mutation",
		);
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the current cleanup rules, action, precedence, or retention policy changed during execution.",
		);
	}
}

type PlexTargetLookupClient = Pick<
	PlexClient,
	"getMovieMediaPartsByTmdbId" | "getSeriesEpisodeMediaPartsByTvdbId"
>;

type PlexTargetRatingKeysByInstance = Map<string, Map<string, Set<string>>>;

function plexTargetIdentityKey(
	mediaType: PlexInventoryTarget["mediaType"],
	idType: "tmdb" | "tvdb",
	externalId: number,
): string {
	return `${mediaType}:${idType}:${externalId}`;
}

function plexInventoryTargetKeys(target: PlexInventoryTarget): string[] {
	const keys = [plexTargetIdentityKey(target.mediaType, "tmdb", target.tmdbId)];
	if (target.mediaType === "series" && target.tvdbId) {
		keys.push(plexTargetIdentityKey("series", "tvdb", target.tvdbId));
	}
	return keys;
}

async function readCurrentPlexTargetRatingKeys(
	client: PlexTargetLookupClient,
	service: "RADARR" | "SONARR",
	externalId: number,
): Promise<string[]> {
	try {
		const items =
			service === "RADARR"
				? await client.getMovieMediaPartsByTmdbId(externalId)
				: await client.getSeriesEpisodeMediaPartsByTvdbId(externalId);
		const ratingKeys = new Set<string>();
		for (const item of items) {
			if (typeof item.ratingKey !== "string" || item.ratingKey.trim() === "") {
				throw new Error("Plex returned a target without a usable rating key");
			}
			ratingKeys.add(item.ratingKey);
		}
		return [...ratingKeys].sort();
	} catch (error) {
		if (error instanceof PlexMovieNotFoundError || error instanceof PlexSeriesNotFoundError) {
			return [];
		}
		throw error;
	}
}

async function assertCurrentPlexTargetCoveredByPolicySnapshot(
	deps: CleanupExecutorDeps,
	userId: string,
	service: "RADARR" | "SONARR",
	externalId: number,
	targetKey: string,
	ratingKeysByInstance: PlexTargetRatingKeysByInstance,
	expectedTopologyFingerprint: string,
): Promise<void> {
	const initial = await loadProviderInstances(deps, userId, ["PLEX"]);
	if (
		initial.length === 0 ||
		providerTopologyFingerprint(initial) !== expectedTopologyFingerprint ||
		ratingKeysByInstance.size !== initial.length ||
		initial.some((instance) => !ratingKeysByInstance.has(instance.id))
	) {
		throw new Error("Plex topology no longer matched the policy snapshot");
	}

	for (const instance of initial) {
		const client =
			deps.plexClientFactory?.(instance) ??
			deps.plexCacheClientFactory?.(instance) ??
			(deps.encryptor ? createPlexClient(deps.encryptor, instance, deps.log) : null);
		if (!client) throw new Error("Plex credentials were unavailable");

		const first = await readCurrentPlexTargetRatingKeys(client, service, externalId);
		const second = await readCurrentPlexTargetRatingKeys(client, service, externalId);
		if (evidenceFingerprint(first) !== evidenceFingerprint(second)) {
			throw new Error("Plex target identity changed between verification passes");
		}

		const expectedRatingKeys = [
			...(ratingKeysByInstance.get(instance.id)?.get(targetKey) ?? new Set<string>()),
		].sort();
		if (evidenceFingerprint(second) !== evidenceFingerprint(expectedRatingKeys)) {
			throw new Error("Plex target identity changed after the policy snapshot was captured");
		}
	}

	const after = await loadProviderInstances(deps, userId, ["PLEX"]);
	if (providerTopologyFingerprint(after) !== expectedTopologyFingerprint) {
		throw new Error("Plex topology changed during final target verification");
	}
}

function assertRefreshedPlexTargetMatchesPolicySnapshot(
	expected: PlexTargetRatingKeysByInstance,
	current: PlexTargetRatingKeysByInstance,
	targetKey: string,
): void {
	if (
		expected.size !== current.size ||
		[...expected.keys()].some((instanceId) => !current.has(instanceId))
	) {
		throw new Error("Refreshed Plex target coverage did not match the policy snapshot");
	}
	for (const [instanceId, expectedTargets] of expected) {
		const expectedRatingKeys = [...(expectedTargets.get(targetKey) ?? new Set<string>())].sort();
		const currentRatingKeys = [
			...(current.get(instanceId)?.get(targetKey) ?? new Set<string>()),
		].sort();
		if (evidenceFingerprint(currentRatingKeys) !== evidenceFingerprint(expectedRatingKeys)) {
			throw new Error("Plex target identity changed during final policy revalidation");
		}
	}
}

function plexRulesCapableOfAffectingExpectedSeriesPolicy(
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	service: "RADARR" | "SONARR",
	expectedRuleId: string,
): LibraryCleanupRule[] {
	const expectedRule = rules.find((rule) => rule.id === expectedRuleId);
	if (!expectedRule || expectedRule.retentionMode) {
		throw new Error("The expected cleanup winner was absent from the policy snapshot");
	}
	const plexDependency = new Set<DataSourceDependency>(["plex"]);
	return rules.filter((rule) => {
		const canAffectExpectedWinner =
			rule.retentionMode ||
			rule.priority < expectedRule.priority ||
			(rule.priority === expectedRule.priority && rule.id.localeCompare(expectedRule.id) <= 0);
		return (
			canAffectExpectedWinner &&
			passesCleanupRuleFilters(item, rule, service) &&
			ruleUsesUnavailableData(rule, plexDependency)
		);
	});
}

/**
 * Re-establish series/movie cleanup authorization at the mutation boundary.
 * The queued/preview match is durable intent only: current live ARR state,
 * current rules, current precedence, and refreshable provider evidence decide
 * whether the exact same rule/action remains authoritative.
 */
export async function assertCurrentSeriesMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	instance: ServiceInstance,
	arrItemId: number,
	expectedRule: ExpectedCleanupRule,
	snapshot?: MutationPolicySnapshot,
	cleanupRunClaimToken?: string,
): Promise<AuthorizedSeriesMutationPolicy> {
	try {
		const policySnapshot =
			snapshot ??
			(await createMutationPolicySnapshot(deps, userId, undefined, cleanupRunClaimToken));
		await assertCurrentSeriesPolicySnapshotUnchanged(deps, userId, expectedRule, policySnapshot);

		const arrClient = deps.arrClientFactory.create(instance);
		const rawItem =
			instance.service === "RADARR"
				? ((await (arrClient as InstanceType<typeof RadarrClient>).movie.getById(
						arrItemId,
					)) as unknown as Record<string, unknown>)
				: instance.service === "SONARR"
					? ((await (arrClient as InstanceType<typeof SonarrClient>).series.getById(
							arrItemId,
						)) as unknown as Record<string, unknown>)
					: (() => {
							throw new Error(`Unsupported cleanup service: ${instance.service}`);
						})();
		let authoritativeRawItem = rawItem;
		let authoritativeLiveItem = toLiveSeriesPolicyItem(instance, arrItemId, rawItem);
		const plexPolicyRules = plexRulesCapableOfAffectingExpectedSeriesPolicy(
			authoritativeLiveItem,
			policySnapshot.rules,
			instance.service,
			expectedRule.matchedRuleId,
		);
		let currentPolicyCtx = policySnapshot.ctx;
		let currentFailedSources = policySnapshot.failedSources;
		if (plexPolicyRules.length > 0) {
			if (
				!policySnapshot.plexTargetRatingKeysByInstance ||
				!policySnapshot.plexTopologyFingerprint
			) {
				throw new Error("The policy snapshot lacked complete Plex target coverage");
			}
			const lookupExternalId = instance.service === "RADARR" ? rawItem.tmdbId : rawItem.tvdbId;
			const policyTmdbId = rawItem.tmdbId;
			const hasPolicyTmdbId =
				typeof policyTmdbId === "number" && Number.isSafeInteger(policyTmdbId) && policyTmdbId > 0;
			if (
				typeof lookupExternalId !== "number" ||
				!Number.isSafeInteger(lookupExternalId) ||
				lookupExternalId <= 0
			) {
				throw new Error("Live ARR state lacked the IDs required for Plex verification");
			}
			const targetKey =
				instance.service === "RADARR"
					? plexTargetIdentityKey("movie", "tmdb", lookupExternalId)
					: hasPolicyTmdbId
						? plexTargetIdentityKey("series", "tmdb", policyTmdbId)
						: plexTargetIdentityKey("series", "tvdb", lookupExternalId);
			await assertCurrentPlexTargetCoveredByPolicySnapshot(
				deps,
				userId,
				instance.service,
				lookupExternalId,
				targetKey,
				policySnapshot.plexTargetRatingKeysByInstance,
				policySnapshot.plexTopologyFingerprint,
			);

			const activeTypes = collectActiveRuleTypes(plexPolicyRules);
			const currentPlexEvidence = await refreshPlexMutationEvidence(
				deps,
				userId,
				activeTypes.has("plex_episode_completion"),
				plexPolicyRules,
				cleanupRunClaimToken,
			);
			if (
				!currentPlexEvidence ||
				!policySnapshot.plexTopologyFingerprint ||
				currentPlexEvidence.topologyFingerprint !== policySnapshot.plexTopologyFingerprint
			) {
				throw new Error("Current Plex policy evidence did not match the authorized topology");
			}
			assertRefreshedPlexTargetMatchesPolicySnapshot(
				policySnapshot.plexTargetRatingKeysByInstance,
				currentPlexEvidence.ratingKeysByInstance,
				targetKey,
			);
			currentPolicyCtx = {
				...policySnapshot.ctx,
				now: new Date(),
				plexMap: currentPlexEvidence.plexMap,
				plexSectionTitles: currentPlexEvidence.plexSectionTitles,
				plexEpisodeMap: currentPlexEvidence.plexEpisodeMap,
			};
			currentFailedSources = new Set(policySnapshot.failedSources);
			currentFailedSources.delete("plex");

			authoritativeRawItem =
				instance.service === "RADARR"
					? ((await (arrClient as InstanceType<typeof RadarrClient>).movie.getById(
							arrItemId,
						)) as unknown as Record<string, unknown>)
					: ((await (arrClient as InstanceType<typeof SonarrClient>).series.getById(
							arrItemId,
						)) as unknown as Record<string, unknown>);
			authoritativeLiveItem = toLiveSeriesPolicyItem(instance, arrItemId, authoritativeRawItem);
			const currentLookupExternalId =
				instance.service === "RADARR" ? authoritativeRawItem.tmdbId : authoritativeRawItem.tvdbId;
			const currentPolicyTmdbId = authoritativeRawItem.tmdbId;
			const currentHasPolicyTmdbId =
				typeof currentPolicyTmdbId === "number" &&
				Number.isSafeInteger(currentPolicyTmdbId) &&
				currentPolicyTmdbId > 0;
			if (
				typeof currentLookupExternalId !== "number" ||
				!Number.isSafeInteger(currentLookupExternalId) ||
				currentLookupExternalId <= 0
			) {
				throw new Error("Refreshed ARR state lacked the IDs required for Plex verification");
			}
			const currentTargetKey =
				instance.service === "RADARR"
					? plexTargetIdentityKey("movie", "tmdb", currentLookupExternalId)
					: currentHasPolicyTmdbId
						? plexTargetIdentityKey("series", "tmdb", currentPolicyTmdbId)
						: plexTargetIdentityKey("series", "tvdb", currentLookupExternalId);
			if (currentLookupExternalId !== lookupExternalId || currentTargetKey !== targetKey) {
				throw new Error("ARR target identity changed during Plex policy revalidation");
			}
			const refreshedPlexPolicyRules = plexRulesCapableOfAffectingExpectedSeriesPolicy(
				authoritativeLiveItem,
				policySnapshot.rules,
				instance.service,
				expectedRule.matchedRuleId,
			);
			const refreshedRuleIds = new Set(refreshedPlexPolicyRules.map((rule) => rule.id));
			if (refreshedRuleIds.size > plexPolicyRules.length) {
				throw new Error("A new Plex-dependent policy became applicable during revalidation");
			}
			for (const ruleId of refreshedRuleIds) {
				if (!plexPolicyRules.some((rule) => rule.id === ruleId)) {
					throw new Error("A new Plex-dependent policy became applicable during revalidation");
				}
			}
		}
		const policy = evaluateItemPolicyState(
			authoritativeLiveItem,
			policySnapshot.rules,
			instance.service,
			currentPolicyCtx,
			currentFailedSources,
		);
		if (
			policy.kind !== "cleanup" ||
			policy.match.ruleId !== expectedRule.matchedRuleId ||
			policy.match.action !== expectedRule.action ||
			(policy.match.scanMediaServerAfterDelete === true) !== expectedRule.scanMediaServerAfterDelete
		) {
			throw new Error("The exact matched cleanup policy is no longer authoritative");
		}
		await assertCurrentSeriesPolicySnapshotUnchanged(deps, userId, expectedRule, policySnapshot);
		return {
			snapshot: policySnapshot,
			rawItem: authoritativeRawItem,
			policyItem: authoritativeLiveItem,
		};
	} catch (error) {
		deps.log.warn(
			{ err: error, instanceId: instance.id, arrItemId, ruleId: expectedRule.matchedRuleId },
			"Cleanup could not revalidate current series/movie policy authority",
		);
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: live ARR state, current cleanup precedence, retention policy, or required provider evidence could not re-authorize this item.",
		);
	}
}

async function assertCurrentSeriesPostStepMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	instance: ServiceInstance,
	arrItemId: number,
	expectedRule: ExpectedCleanupRule,
	authorizedPolicy: AuthorizedSeriesMutationPolicy,
	transition: SeriesMutationTransition,
	cleanupRunClaimToken?: string,
): Promise<void> {
	try {
		await assertCurrentSeriesPolicySnapshotUnchanged(
			deps,
			userId,
			expectedRule,
			authorizedPolicy.snapshot,
		);
		const currentSnapshot = await createMutationPolicySnapshot(
			deps,
			userId,
			authorizedPolicy.snapshot.configFingerprint,
			cleanupRunClaimToken,
		);
		if (
			currentSnapshot.ruleFingerprint !== authorizedPolicy.snapshot.ruleFingerprint ||
			currentSnapshot.providerTopologyFingerprint !==
				authorizedPolicy.snapshot.providerTopologyFingerprint
		) {
			throw new Error("Cleanup policy or provider topology changed after the first write");
		}
		const arrClient = deps.arrClientFactory.create(instance);
		const rawItem =
			instance.service === "RADARR"
				? ((await (arrClient as InstanceType<typeof RadarrClient>).movie.getById(
						arrItemId,
					)) as unknown as Record<string, unknown>)
				: instance.service === "SONARR"
					? ((await (arrClient as InstanceType<typeof SonarrClient>).series.getById(
							arrItemId,
						)) as unknown as Record<string, unknown>)
					: (() => {
							throw new Error(`Unsupported cleanup service: ${instance.service}`);
						})();
		const liveItem = toLiveSeriesPolicyItem(instance, arrItemId, rawItem);
		assertExpectedSeriesArrTransition(
			instance,
			authorizedPolicy.rawItem,
			rawItem,
			liveItem,
			transition,
		);

		// Cleanup precedence is evaluated with the originally authorized ARR
		// file values. The explicit transition check above proves every other
		// policy-bearing ARR field is still identical, while current rules and
		// freshly loaded provider evidence can still revoke the winning policy.
		const cleanupPolicy = evaluateItemPolicyState(
			authorizedPolicy.policyItem,
			currentSnapshot.rules.filter((rule) => !rule.retentionMode),
			instance.service,
			currentSnapshot.ctx,
			currentSnapshot.failedSources,
		);
		if (
			cleanupPolicy.kind !== "cleanup" ||
			cleanupPolicy.match.ruleId !== expectedRule.matchedRuleId ||
			cleanupPolicy.match.action !== expectedRule.action ||
			(cleanupPolicy.match.scanMediaServerAfterDelete === true) !==
				expectedRule.scanMediaServerAfterDelete
		) {
			throw new Error("The exact matched cleanup policy is no longer authoritative");
		}
		const retentionPolicy = evaluateItemPolicyState(
			liveItem,
			currentSnapshot.rules.filter((rule) => rule.retentionMode),
			instance.service,
			currentSnapshot.ctx,
			currentSnapshot.failedSources,
		);
		if (retentionPolicy.kind === "retained") {
			throw new Error("The current retention policy protects the post-step ARR state");
		}
	} catch (error) {
		deps.log.warn(
			{ err: error, instanceId: instance.id, arrItemId, ruleId: expectedRule.matchedRuleId },
			"Cleanup could not revalidate post-step series/movie authority",
		);
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the verified post-step ARR state, current retention policy, provider authority, topology, or cleanup configuration could not authorize the next write.",
		);
	}
}

async function assertCurrentEpisodeMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	instance: ServiceInstance,
	arrSeriesId: number,
	expectedRule: ExpectedCleanupRule,
	evidence?: { liveEpisodeWatchSources: VerifiedEpisodePlexWatchSource[] },
	expectedConfigFingerprint?: string,
): Promise<void> {
	const config = await deps.prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
	});
	if (!config || config.enabled === false || config.dryRunMode === true) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the cleanup configuration was disabled or changed after this episode was queued.",
		);
	}
	if (
		expectedConfigFingerprint &&
		completeMutationConfigFingerprint(config) !== expectedConfigFingerprint
	) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: cleanup mutation settings changed after execution began.",
		);
	}

	const orderedCurrentRules = [...config.rules].sort(
		(left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
	);
	const currentSeriesRules = orderedCurrentRules.filter(
		(rule) => rule.enabled && rule.targetScope !== "episode",
	);
	const seriesRetentionRules = currentSeriesRules.filter((rule) => rule.retentionMode);
	const seriesCleanupRules = currentSeriesRules.filter((rule) => !rule.retentionMode);
	const currentEpisodeRule = orderedCurrentRules.find(
		(rule) => rule.id === expectedRule.matchedRuleId,
	);
	if (
		!currentEpisodeRule ||
		!isSupportedEpisodeCleanupRule(currentEpisodeRule) ||
		currentEpisodeRule.action !== expectedRule.action ||
		(currentEpisodeRule.scanMediaServerAfterDelete === true) !==
			expectedRule.scanMediaServerAfterDelete
	) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the matched episode cleanup rule changed after this item was queued.",
		);
	}

	let item: CacheItemForEval;
	let rawSeries: Record<string, unknown>;
	let liveRetentionProtected = false;
	try {
		const sonarr = deps.arrClientFactory.create(instance) as InstanceType<typeof SonarrClient>;
		rawSeries = (await sonarr.series.getById(arrSeriesId)) as unknown as Record<string, unknown>;
		const liveSeries = buildLibraryItem(instance, "sonarr", rawSeries);
		const liveSeriesId =
			typeof liveSeries.id === "number" ? liveSeries.id : Number.parseInt(liveSeries.id, 10);
		if (liveSeries.type !== "series" || liveSeriesId !== arrSeriesId) {
			throw new Error("Live Sonarr series identity did not match the cleanup target");
		}
		const addedAt = liveSeries.added ? new Date(liveSeries.added) : null;
		item = {
			id: `live:${instance.id}:series:${arrSeriesId}`,
			instanceId: instance.id,
			arrItemId: arrSeriesId,
			itemType: "series",
			title: liveSeries.title,
			year: liveSeries.year ?? null,
			monitored: liveSeries.monitored ?? true,
			hasFile: liveSeries.hasFile ?? false,
			status: liveSeries.status ?? null,
			qualityProfileId: liveSeries.qualityProfileId ?? null,
			qualityProfileName:
				liveSeries.qualityProfileName ??
				(typeof rawSeries.profileName === "string" ? rawSeries.profileName : null),
			sizeOnDisk: BigInt(Math.max(0, Math.trunc(liveSeries.sizeOnDisk ?? 0))),
			arrAddedAt: addedAt && !Number.isNaN(addedAt.getTime()) ? addedAt : null,
			cachedAt: new Date(),
			data: JSON.stringify({
				// The shared normalizer intentionally projects common library
				// fields and omits some rule evidence (for example ratings).
				// Preserve the validated live response for retention evaluation,
				// while normalized fields remain authoritative where they overlap.
				...rawSeries,
				...liveSeries,
				statistics: {
					...(typeof rawSeries.statistics === "object" && rawSeries.statistics !== null
						? (rawSeries.statistics as Record<string, unknown>)
						: {}),
					...liveSeries.statistics,
					runtime:
						liveSeries.statistics?.runtime ??
						(typeof rawSeries.statistics === "object" && rawSeries.statistics !== null
							? (rawSeries.statistics as Record<string, unknown>).runtime
							: undefined),
				},
				_arrDashboardSource: {
					serviceFingerprint: createArrServiceFingerprint(instance),
				},
				_arrDashboardEvidence: arrPolicyEvidenceFromRaw(rawSeries, "sonarr"),
			}),
			infoHash: null,
			torrentState: null,
		};
		if (typeof rawSeries.title !== "string" || rawSeries.title.trim().length === 0) {
			throw new Error("Live Sonarr series title was unavailable");
		}
		if (!liveSonarrRuleApplies(rawSeries, item, currentEpisodeRule)) {
			throw new Error("The matched episode cleanup rule no longer applies to the live series");
		}
		const liveContext: EvalContext = { now: new Date() };
		const evidenceAvailability = liveSonarrConditionEvidence(rawSeries);
		const currentSeriesMatch = seriesCleanupRules.find(
			(rule) =>
				liveSonarrRuleApplies(rawSeries, item, rule) &&
				evaluateRuleState(item, rule, "SONARR", liveContext, undefined, evidenceAvailability)
					.state !== "false",
		);
		if (currentSeriesMatch) {
			throw new Error(
				`Series rule ${currentSeriesMatch.id} now takes precedence over episode cleanup`,
			);
		}
		liveRetentionProtected = seriesRetentionRules.some(
			(rule) =>
				liveSonarrRuleApplies(rawSeries, item, rule) &&
				evaluateRuleState(item, rule, "SONARR", liveContext, undefined, evidenceAvailability)
					.state !== "false",
		);
		if (evidence) {
			const currentMatch = orderedCurrentRules.find((rule) => {
				if (!isSupportedEpisodeCleanupRule(rule) || !liveSonarrRuleApplies(rawSeries, item, rule)) {
					return false;
				}
				return evidence.liveEpisodeWatchSources.some(({ liveWatchCount }) =>
					Boolean(evaluateEpisodeWatchCountRule({ watchCount: liveWatchCount }, rule)),
				);
			});
			if (
				!currentMatch ||
				currentMatch.id !== expectedRule.matchedRuleId ||
				currentMatch.action !== expectedRule.action ||
				(currentMatch.scanMediaServerAfterDelete === true) !==
					expectedRule.scanMediaServerAfterDelete
			) {
				throw new Error(
					"The matched episode cleanup rule is no longer the current live policy match",
				);
			}
		}
	} catch (error) {
		deps.log.warn(
			{ err: error, instanceId: instance.id, arrSeriesId },
			"Cleanup could not load live Sonarr series state for retention revalidation",
		);
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: live Sonarr series state could not be revalidated against the current episode cleanup and retention rules.",
		);
	}

	// The mutation boundary deliberately does not trust provider or list caches.
	// Their leaves evaluate UNKNOWN, while live Sonarr leaves retain full
	// three-valued semantics. Retention therefore protects unless its complete
	// expression is freshly proven false.
	if (liveRetentionProtected) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the parent series is protected by the current retention policy or its required evidence is unavailable.",
		);
	}
}

function queuedCleanupAuditTrigger(
	deps: CleanupExecutorDeps,
	claimStatus: "approved" | "retry_pending",
): "scheduled" | "manual" | "approval" | "retry" | "recovery" {
	if (
		deps.auditTrigger === "scheduled" ||
		deps.auditTrigger === "manual" ||
		deps.auditTrigger === "approval" ||
		deps.auditTrigger === "retry" ||
		deps.auditTrigger === "recovery"
	) {
		return deps.auditTrigger;
	}
	return claimStatus === "retry_pending" ? "retry" : "approval";
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
		getMutationPolicySnapshot?: () => Promise<MutationPolicySnapshot>;
		auditCorrelationId?: string;
		deferMediaServerRescans?: boolean;
		cleanupRunClaimToken?: string;
	},
): Promise<QueuedCleanupExecutionResult> {
	const result = await executeQueuedCleanupItemsCore(deps, userId, approvalIds, options);
	const auditEnabled = cleanupAuditEnabled(deps.prisma);
	const outcomeAuditPersisted = await runCleanupAuditBestEffort(
		async () => {
			if (!auditEnabled) return;
			const ids = Object.keys(result.executionCorrelationIds);
			if (ids.length === 0) return;
			const approvals = await deps.prisma.libraryCleanupApproval.findMany({
				where: { id: { in: ids }, config: { userId } },
			});
			const trigger = queuedCleanupAuditTrigger(deps, options.claimStatus);
			for (const approval of approvals) {
				const correlationId = result.executionCorrelationIds[approval.id];
				if (!correlationId) continue;
				const auditApproval = approvalRecordToAuditSnapshot(approval);
				if (result.expiredIds.includes(approval.id)) auditApproval.status = "expired";
				const terminalEventType = await recordApprovalExecutionOutcome(
					deps.prisma,
					{
						approval: auditApproval,
						correlationId,
						trigger,
						actorId: deps.auditActorId,
						auditPrepared: result.auditPreparedIds.includes(approval.id),
						mutationAttempted:
							result.mutationAttemptedIds.includes(approval.id) &&
							!result.reconciledIds.includes(approval.id),
						durableStateRecordingFailed:
							result.recordingFailureIds.includes(approval.id) && approval.status !== "executed",
					},
					deps.log,
				);
				if (
					terminalEventType === "terminal_succeeded" ||
					terminalEventType === "reconciled_without_mutation"
				) {
					const marked = await deps.prisma.libraryCleanupApproval.updateMany({
						where: {
							id: approval.id,
							config: { userId },
							status: "executed",
							terminalAuditRecordedAt: null,
						},
						data: { terminalAuditRecordedAt: new Date() },
					});
					if (marked.count !== 1) {
						const current = await deps.prisma.libraryCleanupApproval.findFirst({
							where: { id: approval.id, config: { userId }, status: "executed" },
							select: { terminalAuditRecordedAt: true },
						});
						if (!current?.terminalAuditRecordedAt) {
							throw new Error("Cleanup terminal audit marker could not be recorded");
						}
					}
				}
			}
		},
		deps.log,
		"queued cleanup outcome",
	);
	if (!options.deferMediaServerRescans && result.rescanApprovalIds.length > 0) {
		const rescanWarnings = [...(result.warnings ?? [])];
		if (auditEnabled && !outcomeAuditPersisted) {
			rescanWarnings.push(
				"The ARR deletion completed, but its media-server scan was deferred until the terminal cleanup audit can be recorded.",
			);
		} else {
			try {
				const scanResult = await triggerCoalescedMediaServerRescans(
					deps,
					userId,
					result.rescanApprovalIds,
					options.assertExecutionAllowed,
				);
				rescanWarnings.push(...scanResult.warnings);
			} catch (error) {
				rescanWarnings.push(
					"The ARR deletion completed, but media-server scan follow-up could not be checked. It remains independently retryable.",
				);
				deps.log.warn({ err: error }, "Cleanup media-server scan batch could not be checked");
			}
		}
		result.warnings = [...new Set(rescanWarnings)];
	}
	return result;
}

async function executeQueuedCleanupItemsCore(
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
		getMutationPolicySnapshot?: () => Promise<MutationPolicySnapshot>;
		auditCorrelationId?: string;
		deferMediaServerRescans?: boolean;
		cleanupRunClaimToken?: string;
	},
): Promise<QueuedCleanupExecutionResult> {
	const { prisma, arrClientFactory, log } = deps;
	const currentConfig = await prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		select: {
			id: true,
			enabled: true,
			dryRunMode: true,
			requireApproval: true,
			maxRemovalsPerRun: true,
			respectQuiSeeding: true,
			rules: true,
		},
	});
	if (!currentConfig) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: cleanup configuration was unavailable before execution.",
		);
	}
	if (
		currentConfig.maxRemovalsPerRun !== undefined &&
		(!Number.isSafeInteger(currentConfig.maxRemovalsPerRun) ||
			currentConfig.maxRemovalsPerRun < 1 ||
			currentConfig.maxRemovalsPerRun > 100)
	) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the current cleanup mutation limit is invalid.",
		);
	}
	const currentRunLimit = currentConfig.maxRemovalsPerRun ?? 100;
	const currentRespectQuiSeeding = currentConfig?.respectQuiSeeding === true;
	const expectedConfigFingerprint = completeMutationConfigFingerprint(currentConfig);
	const auditTrigger = queuedCleanupAuditTrigger(deps, options.claimStatus);

	// Atomically transition approved → executing to prevent double-execution
	// Also enforce expiry — don't execute items past their expiration
	const now = new Date();
	const claimedApprovalIds: string[] = [];
	const claimedApprovalTokens = new Map<string, string>();
	const auditCorrelationIds = new Map<string, string>();
	const auditPreparedApprovalIds = new Set<string>();
	const mutationAttemptedApprovalIds = new Set<string>();
	const mutationBudgetConsumedIds = new Set<string>();
	const confirmedPartialFileDeletionIds = new Set<string>();
	const getMutationPolicySnapshot =
		options.getMutationPolicySnapshot ??
		createMutationPolicySnapshotGetter(
			deps,
			userId,
			expectedConfigFingerprint,
			options.cleanupRunClaimToken,
		);
	const orderedApprovalIds = [...new Set(approvalIds)].sort((left, right) =>
		left.localeCompare(right),
	);
	const claimableApprovalIds = orderedApprovalIds.slice(0, currentRunLimit);
	// Items beyond the current post-lease budget are never claimed, so their
	// durable pending state is preserved deterministically for a later run.
	const unclaimedIds: string[] = orderedApprovalIds.slice(currentRunLimit);
	const claimErrors: string[] = [];
	for (const approvalId of claimableApprovalIds) {
		try {
			const executionToken = randomUUID();
			const auditCorrelationId = options.auditCorrelationId ?? executionToken;
			const claim = await prisma.libraryCleanupApproval.updateMany({
				where: {
					id: approvalId,
					config: { userId },
					status: options.claimStatus,
					...(options.claimExecutionToken ? { executionToken: options.claimExecutionToken } : {}),
					...(options.enforceExpiry ? { expiresAt: { gt: now } } : {}),
				},
				data: {
					status: options.executeStatus,
					reviewedAt: now,
					executionToken,
					executionAuditCorrelationId: auditCorrelationId,
					terminalAuditRecordedAt: null,
				},
			});
			if (claim.count === 1) {
				claimedApprovalIds.push(approvalId);
				claimedApprovalTokens.set(approvalId, executionToken);
				auditCorrelationIds.set(approvalId, auditCorrelationId);
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
			executionCorrelationIds: {},
			auditPreparedIds: [],
			mutationAttemptedIds: [],
			rescanApprovalIds: [],
			providerAuthorityFailed: false,
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
		const claimOrder = new Map(claimableApprovalIds.map((id, index) => [id, index]));
		approvals.sort(
			(left, right) => (claimOrder.get(left.id) ?? 0) - (claimOrder.get(right.id) ?? 0),
		);

		let removed = 0;
		let failed = claimErrors.length;
		const errors: string[] = [...claimErrors];
		const rescanApprovalIds = new Set<string>();
		const expiredIds: string[] = [];
		const recordingFailureIds: string[] = [];
		const reconciledIds: string[] = [];
		const sharedPlexSafetyContext = createSharedPlexSafetyContext();
		let providerAuthorityFailed = false;

		for (const approval of approvals) {
			const claimedExecutionToken = claimedApprovalTokens.get(approval.id);
			if (!claimedExecutionToken) {
				unclaimedIds.push(approval.id);
				continue;
			}
			if (providerAuthorityFailed) {
				failed++;
				errors.push(
					"Cleanup item was deferred because provider authority changed for an earlier target.",
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
						lastExecutionError:
							"Provider authority changed for an earlier cleanup target; this target was not inspected or mutated.",
					},
				);
				continue;
			}
			const auditCorrelationId = auditCorrelationIds.get(approval.id);
			if (auditCorrelationId) {
				await runCleanupAuditBestEffort(
					() =>
						recordApprovalExecutionClaimed(
							prisma,
							{
								approval: approvalRecordToAuditSnapshot(approval),
								correlationId: auditCorrelationId,
								trigger: auditTrigger,
								actorId: deps.auditActorId,
							},
							log,
						),
					log,
					"cleanup execution claim",
				);
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
			const approvedEnvelope = parseExecutableSafetyEnvelope(approval.safetySnapshot);
			let approvedPlan = approvedEnvelope?.plan ?? null;
			const approvedProviderEvidence = approvedEnvelope?.providerEvidence;
			const approvedRule = currentConfig.rules.find(
				(rule) =>
					rule.id === approval.matchedRuleId &&
					(approval.targetScope === "episode"
						? rule.targetScope === "episode"
						: rule.targetScope !== "episode"),
			);
			const recordedSelectionRequiresProviderEvidence =
				approvedRule !== undefined &&
				ruleUsesUnavailableData(
					approvedRule,
					new Set<DataSourceDependency>(["plex", "jellyfin", "tautulli"]),
				);
			let safetyPlan: SharedMediaSafetyPlan | undefined = approvedPlan ?? undefined;
			let recoveringEpisodeUnmonitorPartial =
				approval.lastExecutionError === SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE;
			const recoveringInterruptedMutation =
				options.claimStatus === "retry_pending" ||
				approval.lastExecutionError === INTERRUPTED_CLEANUP_RECOVERY_MESSAGE ||
				recoveringEpisodeUnmonitorPartial;
			if (
				!approvedPlan ||
				(recordedSelectionRequiresProviderEvidence &&
					approvedProviderEvidence?.dependencies.length === 0) ||
				approvedPlan.target.serviceFingerprint !== createArrServiceFingerprint(instance)
			) {
				if (recordedSelectionRequiresProviderEvidence) {
					providerAuthorityFailed = true;
				}
				approvalIdentityChanged = true;
				sharedPlexBlock =
					"Skipped for safety: the ARR target identity changed after this cleanup item was queued. Run cleanup again and review a new approval.";
			}
			if (!sharedPlexBlock && approvedProviderEvidence) {
				try {
					await assertCurrentProviderEvidenceAuthority(
						deps,
						userId,
						approvedProviderEvidence,
						options.assertExecutionAllowed,
					);
				} catch (error) {
					if (error instanceof CleanupRunLeaseLostError) throw error;
					providerAuthorityFailed = true;
					approvalIdentityChanged = true;
					sharedPlexBlock =
						"Skipped for safety: provider execution authority changed after this cleanup item was queued. Run cleanup again and review a new approval.";
				}
			}
			if (
				approvedPlan?.kind === "verified_sonarr_episode" &&
				!recoveringInterruptedMutation &&
				Date.parse(approvedPlan.watchProof.refreshedAt) < now.getTime() - PLEX_EPISODE_FRESHNESS_MS
			) {
				approvalIdentityChanged = true;
				sharedPlexBlock =
					"Skipped for safety: the approved Plex episode evidence expired; run cleanup again and review a new approval.";
			}
			let retryTargetAlreadyAbsent:
				| "record_absent"
				| "episode_action_complete"
				| "series_action_complete"
				| false = false;
			if (!sharedPlexBlock && recoveringInterruptedMutation) {
				try {
					retryTargetAlreadyAbsent = await retryTargetRecordIsAbsent(
						deps,
						instance,
						approval.arrItemId,
						approval.safetySnapshot,
						action,
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
						files: {
							seriesPath: approvedPlan.files.seriesPath,
							episodeFiles: [],
						},
					};
					await updateClaimedCleanupApproval(
						prisma,
						userId,
						approval.id,
						options.executeStatus,
						claimedExecutionToken,
						{
							safetySnapshot: serializeExecutableSafetyPlan(
								reconciledPlan,
								approvedProviderEvidence,
							),
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
			const sonarrRecordOnlyRetryPlan = isVerifiedSonarrRecordOnlyRetry(action, approvedPlan)
				? approvedPlan
				: null;
			if (!sharedPlexBlock && !retryTargetAlreadyAbsent) {
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
						const retryTarget = {
							instanceId: approval.instanceId,
							arrItemId: approval.arrItemId,
							itemType: approval.itemType,
							action,
							targetScope: approval.targetScope,
							arrEpisodeId: approval.arrEpisodeId,
							seasonNumber: approval.seasonNumber,
							episodeNumber: approval.episodeNumber,
							...episodePlanTargetFields(approvedPlan, currentRespectQuiSeeding),
						};
						const targetKey = cleanupDeleteTargetKey(retryTarget);
						const blocks = await findSharedPlexDeleteBlocks(
							deps,
							userId,
							[retryTarget],
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
							approvedPlan &&
							livePlan &&
							(executableSafetyPlansEqual(approvedPlan, livePlan) ||
								episodePlansMatchWithRefreshedWatchProof(approvedPlan, livePlan, false));
						const idempotentEpisodeUnmonitorMatch =
							recoveringInterruptedMutation &&
							(action === "delete" || action === "unmonitor") &&
							approvedPlan?.kind === "verified_sonarr_episode" &&
							livePlan?.kind === "verified_sonarr_episode" &&
							approvedPlan.episode.monitored === true &&
							livePlan.episode.monitored === false &&
							(executableSafetyPlansEqual(approvedPlan, {
								...livePlan,
								episode: {
									...livePlan.episode,
									monitored: approvedPlan.episode.monitored,
								},
							}) ||
								episodePlansMatchWithRefreshedWatchProof(
									approvedPlan,
									livePlan,
									true,
									true,
									approvedPlan.quiIdentity.enabled === false &&
										livePlan.quiIdentity.enabled === true,
								));
						if (idempotentEpisodeUnmonitorMatch) {
							// The live Sonarr snapshot is the durable recovery marker. A lease
							// or transient error may have replaced lastExecutionError after the
							// unmonitor succeeded, but the exact approved identity plus the sole
							// monitored -> unmonitored transition proves which stage completed.
							recoveringEpisodeUnmonitorPartial = true;
						}
						const recoverableFileRemainder =
							recoveringInterruptedMutation &&
							(action === "delete" || action === "delete_files") &&
							approvedPlan &&
							livePlan &&
							isVerifiedFileRemainder(approvedPlan, livePlan);
						if (!exactPlanMatch && !idempotentEpisodeUnmonitorMatch && !recoverableFileRemainder) {
							approvalIdentityChanged = true;
							sharedPlexBlock =
								"Skipped for safety: the ARR target or file identity changed after this cleanup item was queued. Run cleanup again and review a new approval.";
						} else if (recoverableFileRemainder && !exactPlanMatch) {
							try {
								await updateClaimedCleanupApproval(
									prisma,
									userId,
									approval.id,
									options.executeStatus,
									claimedExecutionToken,
									{
										safetySnapshot: serializeExecutableSafetyPlan(
											livePlan,
											approvedProviderEvidence,
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
				const mutationInstance = await loadCurrentMutationInstance(
					deps,
					userId,
					approval.instanceId,
					safetyPlan!,
				);
				let authorizedSeriesPolicy: AuthorizedSeriesMutationPolicy | undefined;
				const assertExecutionAuthority: MutationAuthorityCheck = async (evidence) => {
					await options.assertExecutionAllowed?.();
					await assertCurrentProviderEvidenceAuthority(
						deps,
						userId,
						approvedProviderEvidence!,
						options.assertExecutionAllowed,
					);
					if (safetyPlan!.kind === "verified_sonarr_episode") {
						await assertCurrentEpisodeMutationAuthority(
							deps,
							userId,
							mutationInstance,
							approval.arrItemId,
							{
								matchedRuleId: approval.matchedRuleId,
								action,
								scanMediaServerAfterDelete: approval.scanMediaServerAfterDelete === true,
							},
							evidence && "liveEpisodeWatchSources" in evidence ? evidence : undefined,
							expectedConfigFingerprint,
						);
					} else {
						if (!evidence || !("seriesTransition" in evidence)) {
							throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
								"Skipped for safety: the expected ARR mutation transition was unavailable.",
							);
						}
						if (!authorizedSeriesPolicy) {
							if (evidence.seriesTransition !== "unchanged") {
								throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
									"Skipped for safety: no original ARR policy state was captured before the file transition.",
								);
							}
							const snapshot = await getMutationPolicySnapshot();
							authorizedSeriesPolicy = await assertCurrentSeriesMutationAuthority(
								deps,
								userId,
								mutationInstance,
								approval.arrItemId,
								{
									matchedRuleId: approval.matchedRuleId,
									action,
									scanMediaServerAfterDelete: approval.scanMediaServerAfterDelete === true,
								},
								snapshot,
								options.cleanupRunClaimToken,
							);
						} else {
							await assertCurrentSeriesPostStepMutationAuthority(
								deps,
								userId,
								mutationInstance,
								approval.arrItemId,
								{
									matchedRuleId: approval.matchedRuleId,
									action,
									scanMediaServerAfterDelete: approval.scanMediaServerAfterDelete === true,
								},
								authorizedSeriesPolicy,
								evidence.seriesTransition,
								options.cleanupRunClaimToken,
							);
						}
					}
					mutationBudgetConsumedIds.add(approval.id);
				};
				const mutationTarget: CleanupDeleteTarget = {
					instanceId: approval.instanceId,
					arrItemId: approval.arrItemId,
					itemType: approval.itemType,
					action,
					targetScope: approval.targetScope,
					arrEpisodeId: approval.arrEpisodeId,
					seasonNumber: approval.seasonNumber,
					episodeNumber: approval.episodeNumber,
					...episodePlanTargetFields(
						safetyPlan as ExecutableSharedMediaSafetyPlan,
						currentRespectQuiSeeding,
					),
				};
				const assertMutationAuthority = withSharedPlexOwnershipRevalidation(
					deps,
					userId,
					mutationTarget,
					safetyPlan!,
					assertExecutionAuthority,
				);
				let mutationAttempt = 0;
				const mutationAuditBoundary: MutationAuditBoundary = {
					prepare: async (step) => {
						mutationAttempt++;
						const correlationId = auditCorrelationIds.get(approval.id);
						if (correlationId && cleanupAuditEnabled(prisma)) {
							const auditPrepared = await runCleanupAuditBestEffort(
								() =>
									recordApprovalMutationBoundary(
										prisma,
										{
											approval: approvalRecordToAuditSnapshot(approval),
											correlationId,
											trigger: auditTrigger,
											actorId: deps.auditActorId,
											attempt: mutationAttempt,
											step,
										},
										log,
									),
								log,
								"cleanup mutation boundary preparation",
							);
							if (auditPrepared) auditPreparedApprovalIds.add(approval.id);
						}
					},
					attempted: () => {
						mutationAttemptedApprovalIds.add(approval.id);
					},
				};
				if (
					!retryTargetAlreadyAbsent &&
					approval.scanMediaServerAfterDelete &&
					(action === "delete" || action === "delete_files")
				) {
					await prepareMediaServerRescans(
						deps,
						userId,
						approval,
						rescanMediaType(approval.itemType),
					);
				}

				if (retryTargetAlreadyAbsent) {
					executionCompleted = true;
					reconciledWithoutMutation = true;
					if (retryTargetAlreadyAbsent === "series_action_complete") {
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
									"Completed unmonitor retry but its cache update failed",
								);
							});
					} else {
						if (
							retryTargetAlreadyAbsent === "record_absent" ||
							action !== "unmonitor" ||
							safetyPlan!.kind !== "verified_sonarr_episode"
						) {
							await reconcileSonarrEpisodeFileCache(
								prisma,
								mutationInstance,
								approval.arrItemId,
								log,
								retryTargetAlreadyAbsent !== "record_absent" &&
									safetyPlan!.kind === "verified_sonarr_episode"
									? safetyPlan!.selectedFile.episodeFileId
									: undefined,
							);
						}
						if (
							retryTargetAlreadyAbsent === "record_absent" ||
							safetyPlan!.kind !== "verified_sonarr_episode"
						)
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
					}
				} else if (action === "unmonitor") {
					await unmonitorInArr(
						arrClientFactory,
						mutationInstance,
						approval.arrItemId,
						safetyPlan!,
						assertMutationAuthority,
						mutationAuditBoundary,
					);
					executionCompleted = true;
					if (safetyPlan!.kind !== "verified_sonarr_episode")
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
					const deletedFiles = await withQuiPhysicalMutationGuard(
						userId,
						mutationTarget.respectQuiSeeding === true,
						() =>
							deleteFilesFromArr(
								arrClientFactory,
								mutationInstance,
								approval.arrItemId,
								safetyPlan!,
								assertMutationAuthority,
								mutationAuditBoundary,
							),
					);
					executionCompleted = true;
					reconciledWithoutMutation = !deletedFiles;
					await reconcileSonarrEpisodeFileCache(
						prisma,
						mutationInstance,
						approval.arrItemId,
						log,
						safetyPlan!.kind === "verified_sonarr_episode"
							? safetyPlan!.selectedFile.episodeFileId
							: undefined,
					);
					if (safetyPlan!.kind !== "verified_sonarr_episode")
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
					await withQuiPhysicalMutationGuard(
						userId,
						mutationTarget.respectQuiSeeding === true,
						() =>
							deleteFromArr(
								arrClientFactory,
								mutationInstance,
								approval.arrItemId,
								safetyPlan!,
								assertMutationAuthority,
								mutationAuditBoundary,
							),
					);
					executionCompleted = true;
					await reconcileSonarrEpisodeFileCache(
						prisma,
						mutationInstance,
						approval.arrItemId,
						log,
						safetyPlan!.kind === "verified_sonarr_episode"
							? safetyPlan!.selectedFile.episodeFileId
							: undefined,
					);
					if (safetyPlan!.kind !== "verified_sonarr_episode")
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
						reconciledWithoutMutation,
						executedAt: new Date(),
						lastExecutionError: null,
					},
				);
				if (
					approval.scanMediaServerAfterDelete &&
					(action === "delete" || action === "delete_files")
				) {
					rescanApprovalIds.add(approval.id);
				}

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
								reconciledWithoutMutation,
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
				if (isProviderExecutionAuthorityFailure(error)) {
					providerAuthorityFailed = true;
				}
				const preserveEpisodeUnmonitorPartial =
					recoveringEpisodeUnmonitorPartial &&
					error instanceof ArrMutationAuthorityChangedDuringSafetyCheckError;
				const episodeFileDeletePartial =
					error instanceof ArrDeletePartialError &&
					(action === "delete" || action === "delete_files") &&
					safetyPlan?.kind === "verified_sonarr_episode";
				const executionError = preserveEpisodeUnmonitorPartial
					? SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE
					: error instanceof ArrFileChangedDuringSafetyCheckError ||
							error instanceof ArrDeletePartialError ||
							error instanceof SonarrEpisodeUnmonitorPartialError ||
							error instanceof SonarrEpisodeUnmonitorOutcomeUnknownError
						? error.message
						: "Cleanup item could not be executed. Review the API logs for details.";
				const mutationAuthorityChanged =
					(error instanceof ArrMutationAuthorityChangedDuringSafetyCheckError ||
						isProviderExecutionAuthorityFailure(error)) &&
					!preserveEpisodeUnmonitorPartial &&
					!(error instanceof ArrDeletePartialError);
				errors.push(executionError);
				failed++;
				const postPartialRetrySnapshot =
					error instanceof ArrDeletePartialError
						? buildPostPartialRetrySnapshot(safetyPlan, error, action, approvedProviderEvidence)
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
							status:
								error instanceof SonarrEpisodeUnmonitorPartialError ||
								error instanceof SonarrEpisodeUnmonitorOutcomeUnknownError ||
								episodeFileDeletePartial ||
								preserveEpisodeUnmonitorPartial
									? "retry_pending"
									: mutationAuthorityChanged
										? "expired"
										: options.retryStatus,
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
				if (
					error instanceof SonarrEpisodeUnmonitorPartialError &&
					error.cause instanceof CleanupRunLeaseLostError
				) {
					throw error.cause;
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
			executionCorrelationIds: Object.fromEntries(auditCorrelationIds),
			auditPreparedIds: [...auditPreparedApprovalIds],
			mutationAttemptedIds: [...mutationAttemptedApprovalIds],
			rescanApprovalIds: [...rescanApprovalIds],
			providerAuthorityFailed,
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
 * Used to decide which external data to prefetch (Seerr, Tautulli, Plex).
 */
function collectActiveRuleTypes(
	rules: Array<{
		enabled: boolean;
		ruleType: string;
		parameters?: string;
		operator?: string | null;
		conditions: string | null;
	}>,
): Set<string> {
	const types = new Set<string>();
	for (const r of rules) {
		if (!r.enabled) continue;
		const expression = normalizeStoredCleanupRuleExpression({
			ruleType: r.ruleType,
			parameters: r.parameters ?? "{}",
			operator: r.operator ?? null,
			conditions: r.conditions,
		});
		if (!expression) {
			types.add(r.ruleType);
			const legacyConditions = safeJsonParse(r.conditions) as Array<{ ruleType?: unknown }> | null;
			if (Array.isArray(legacyConditions)) {
				for (const condition of legacyConditions) {
					if (typeof condition.ruleType === "string") types.add(condition.ruleType);
				}
			}
			continue;
		}
		const stack: CleanupRuleExpression[] = [expression.root];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node.type === "condition") types.add(node.ruleType);
			else if (node.type === "group") stack.push(...node.children);
			else stack.push(node.child);
		}
	}
	return types;
}

/**
 * Prefetch all Seerr requests and build a lookup map keyed by "movie:tmdbId" or "tv:tmdbId".
 * Returns undefined if no Seerr instance is configured (Seerr rules silently skip).
 */
export const SEERR_PREFETCH_PAGE_SIZE = 50;
export const SEERR_PREFETCH_MAX_PAGES = 100;

/**
 * Fetch a bounded, provably complete Seerr request inventory.
 *
 * Offset pagination can only authorize negative predicates when every
 * advertised row was observed exactly once. Any cap, page drift, duplicate,
 * or partial page fails closed and the caller marks Seerr evidence unavailable.
 */
interface CompleteSeerrRequestInventory {
	map: SeerrRequestMap;
	fingerprint: string;
}

function fingerprintSeerrRequestMap(map: SeerrRequestMap): string {
	return JSON.stringify(
		[...map.entries()]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, requests]) => [
				key,
				[...requests]
					.sort((left, right) => left.requestId - right.requestId)
					.map((request) => [
						request.requestId,
						request.status,
						request.requestedBy,
						request.requestedByUserId,
						request.createdAt,
						request.updatedAt,
						request.modifiedBy,
						request.is4k,
					]),
			]),
	);
}

async function fetchSeerrRequestInventoryPass(
	client: Pick<SeerrClient, "getRequests">,
): Promise<CompleteSeerrRequestInventory> {
	const map: SeerrRequestMap = new Map();
	const seenRequestIds = new Set<number>();
	let expectedPages: number | null = null;
	let expectedResults: number | null = null;
	let fetchedResults = 0;

	for (let pageIndex = 0; pageIndex < SEERR_PREFETCH_MAX_PAGES; pageIndex++) {
		const result = await client.getRequests({
			take: SEERR_PREFETCH_PAGE_SIZE,
			skip: pageIndex * SEERR_PREFETCH_PAGE_SIZE,
		});
		const { pageInfo } = result;
		const currentPage = pageIndex + 1;

		if (
			!Number.isSafeInteger(pageInfo.pages) ||
			pageInfo.pages < 0 ||
			!Number.isSafeInteger(pageInfo.results) ||
			pageInfo.results < 0 ||
			!Number.isSafeInteger(pageInfo.page) ||
			pageInfo.page !== currentPage ||
			result.results.length > SEERR_PREFETCH_PAGE_SIZE
		) {
			throw new Error("Seerr request pagination metadata was invalid");
		}
		if (pageInfo.pages > SEERR_PREFETCH_MAX_PAGES) {
			throw new Error(
				`Seerr request inventory exceeds the safe ${SEERR_PREFETCH_MAX_PAGES * SEERR_PREFETCH_PAGE_SIZE}-request prefetch limit`,
			);
		}

		expectedPages ??= pageInfo.pages;
		expectedResults ??= pageInfo.results;
		if (pageInfo.pages !== expectedPages || pageInfo.results !== expectedResults) {
			throw new Error("Seerr request inventory changed during pagination");
		}

		for (const req of result.results) {
			if (seenRequestIds.has(req.id)) {
				throw new Error("Seerr request pagination returned a duplicate request");
			}
			seenRequestIds.add(req.id);
			fetchedResults++;

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
			if (existing) existing.push(info);
			else map.set(key, [info]);
		}

		const finalPage = expectedPages === 0 || currentPage >= expectedPages;
		if (finalPage) {
			if (fetchedResults !== expectedResults) {
				throw new Error(
					`Seerr request inventory was incomplete: fetched ${fetchedResults} of ${expectedResults}`,
				);
			}
			return { map, fingerprint: fingerprintSeerrRequestMap(map) };
		}
		if (result.results.length === 0) {
			throw new Error("Seerr request pagination ended before the advertised final page");
		}
	}

	throw new Error("Seerr request inventory exceeded the safe pagination limit");
}

export async function fetchCompleteSeerrRequestMap(
	client: Pick<SeerrClient, "getRequests">,
): Promise<SeerrRequestMap> {
	const first = await fetchSeerrRequestInventoryPass(client);
	const second = await fetchSeerrRequestInventoryPass(client);
	if (first.fingerprint !== second.fingerprint) {
		throw new Error("Seerr request inventory changed between verification passes");
	}
	return second.map;
}

export async function prefetchSeerrRequests(
	deps: CleanupExecutorDeps,
	userId: string,
	clientFactory: (instance: ServiceInstance) => Pick<SeerrClient, "getRequests"> = (instance) =>
		deps.seerrClientFactory?.(instance) ??
		new SeerrClient(deps.arrClientFactory, instance, deps.log),
): Promise<SeerrRequestMap | undefined> {
	const { prisma, log } = deps;

	// Every enabled Seerr instance participates in the global rule evidence.
	// A request ID is scoped to its instance, so equal IDs from different
	// instances are retained as distinct requests. Instances and media keys are
	// merged in a stable order to keep request-count evaluation deterministic.
	const seerrInstances = await prisma.serviceInstance.findMany({
		where: { userId, service: "SEERR", enabled: true },
		orderBy: { id: "asc" },
		select: {
			id: true,
			baseUrl: true,
			encryptedApiKey: true,
			encryptionIv: true,
			encryptedHttpAuthCredentials: true,
			httpAuthEncryptionIv: true,
			service: true,
			label: true,
			enabled: true,
			updatedAt: true,
		},
	});

	if (seerrInstances.length === 0) return undefined;

	try {
		const merged: SeerrRequestMap = new Map();
		const orderedInstances = [...seerrInstances].sort((left, right) =>
			left.id.localeCompare(right.id),
		);
		for (const seerrInstance of orderedInstances) {
			const client = clientFactory(seerrInstance as ServiceInstance);
			const instanceMap = await fetchCompleteSeerrRequestMap(client);
			for (const [key, requests] of [...instanceMap.entries()].sort(([left], [right]) =>
				left.localeCompare(right),
			)) {
				const orderedRequests = [...requests].sort(
					(left, right) => left.requestId - right.requestId,
				);
				const existing = merged.get(key);
				if (existing) existing.push(...orderedRequests);
				else merged.set(key, orderedRequests);
			}
		}
		const currentInstances = await prisma.serviceInstance.findMany({
			where: { userId, service: "SEERR", enabled: true },
			orderBy: { id: "asc" },
			select: {
				id: true,
				baseUrl: true,
				encryptedApiKey: true,
				encryptionIv: true,
				encryptedHttpAuthCredentials: true,
				httpAuthEncryptionIv: true,
				service: true,
				label: true,
				enabled: true,
				updatedAt: true,
			},
		});
		if (
			providerTopologyFingerprint(currentInstances as ServiceInstance[]) !==
			providerTopologyFingerprint(seerrInstances as ServiceInstance[])
		) {
			throw new Error("Seerr topology changed during policy evidence refresh");
		}

		log.info(
			{
				instanceCount: seerrInstances.length,
				totalRequests: [...merged.values()].reduce((sum, arr) => sum + arr.length, 0),
			},
			"Seerr request prefetch complete for cleanup",
		);
		return merged;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Seerr requests for cleanup — Seerr rules will be skipped",
		);
		return undefined;
	}
}

function snapshotUsers(value: string): string[] {
	const parsed = safeJsonParse(value);
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error("Provider snapshot contained invalid watched-user data");
	}
	return parsed;
}

function tautulliSnapshotToWatchMap(rows: TautulliCacheSnapshotRow[]): TautulliWatchMap {
	const map: TautulliWatchMap = new Map();
	for (const row of rows) {
		const key = `${row.mediaType}:${row.tmdbId}`;
		const watchedByUsers = snapshotUsers(row.watchedByUsers);
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
				if (!existing.watchedByUsers.includes(user)) existing.watchedByUsers.push(user);
			}
		} else {
			map.set(key, {
				lastWatchedAt: row.lastWatchedAt,
				watchCount: row.watchCount,
				watchedByUsers: [...watchedByUsers],
			});
		}
	}
	return map;
}

function plexSnapshotToWatchMap(rows: PlexCacheSnapshotRow[]): PlexWatchMap {
	const map: PlexWatchMap = new Map();
	for (const row of rows) {
		const key = `${row.mediaType}:${row.tmdbId}`;
		const watchedByUsers = snapshotUsers(row.watchedByUsers);
		const collections = snapshotUsers(row.collections);
		const labels = snapshotUsers(row.labels);
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
			if (
				row.lastWatchedAt &&
				(!existing.lastWatchedAt || row.lastWatchedAt > existing.lastWatchedAt)
			) {
				existing.lastWatchedAt = row.lastWatchedAt;
			}
			existing.watchCount += row.watchCount;
			for (const user of watchedByUsers) {
				if (!existing.watchedByUsers.includes(user)) existing.watchedByUsers.push(user);
			}
			existing.onDeck = existing.onDeck || row.onDeck;
			if (row.userRating != null) {
				existing.userRating =
					existing.userRating != null
						? Math.max(existing.userRating, row.userRating)
						: row.userRating;
			}
			for (const collection of collections) {
				if (!existing.collections.includes(collection)) existing.collections.push(collection);
			}
			for (const label of labels) {
				if (!existing.labels.includes(label)) existing.labels.push(label);
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
				collections: [...collections],
				labels: [...labels],
				addedAt: row.addedAt,
				sections: [sectionInfo],
			});
		}
	}
	return map;
}

function jellyfinSnapshotToWatchMap(rows: JellyfinCacheSnapshotRow[]): JellyfinWatchMap {
	const map: JellyfinWatchMap = new Map();
	for (const row of rows) {
		const key = `${row.mediaType}:${row.tmdbId}`;
		const watchedByUsers = snapshotUsers(row.watchedByUsers);
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
				if (!existing.watchedByUsers.includes(user)) existing.watchedByUsers.push(user);
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
	}
	return map;
}

/**
 * Prefetch Tautulli watch data from the TautulliCache table and build a lookup map.
 * Returns undefined if no Tautulli instance is configured.
 */
async function loadTautulliDataSnapshot(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<ProviderCacheSnapshot<TautulliWatchMap> | undefined> {
	const { prisma, log } = deps;

	const tautulliInstances = await loadProviderInstances(deps, userId, ["TAUTULLI"]);

	// A Tautulli cache is an aggregate over a single PMS watch-history source.
	// Combining multiple enabled sources would turn an ambiguous provider choice
	// into a synthetic watch count, so it cannot authorize cleanup.
	if (tautulliInstances.length !== 1) return undefined;

	try {
		const generations = await loadCompleteCacheGenerations(deps, tautulliInstances, "tautulli");
		if (!generations) {
			throw new Error("Tautulli cache did not have a complete fresh generation for every instance");
		}
		const map: TautulliWatchMap = new Map();
		const rowCounts = new Map<string, number>();
		const rowsByInstance = new Map<string, unknown[]>();
		let cursor: string | undefined;
		let totalRows = 0;

		// Cursor-paginate to bound peak heap.
		while (true) {
			const batch = await prisma.tautulliCache.findMany({
				where: { instanceId: { in: tautulliInstances.map((instance) => instance.id) } },
				select: PROVIDER_CACHE_ROW_SELECTS.tautulli,
				take: CACHE_QUERY_BATCH_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: { id: "asc" },
			});

			if (batch.length === 0) break;
			totalRows += batch.length;

			for (const row of batch) {
				try {
					const generation = generations.get(row.instanceId);
					if (
						!generation ||
						row.connectionGeneration !== generation.connectionGeneration ||
						row.identityGeneration !== generation.identityGeneration
					) {
						throw new Error("Tautulli cache row provenance was unavailable");
					}
					rowCounts.set(row.instanceId, (rowCounts.get(row.instanceId) ?? 0) + 1);
					const sourceRows = rowsByInstance.get(row.instanceId) ?? [];
					sourceRows.push(row);
					rowsByInstance.set(row.instanceId, sourceRows);
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
							if (!existing.watchedByUsers.includes(user)) existing.watchedByUsers.push(user);
						}
					} else {
						map.set(key, {
							lastWatchedAt: row.lastWatchedAt,
							watchCount: row.watchCount,
							watchedByUsers,
						});
					}
				} catch (rowErr) {
					log.warn(
						{ err: rowErr, tmdbId: row.tmdbId },
						"Skipping Tautulli cache row with bad data",
					);
				}
			}

			cursor = batch[batch.length - 1]!.id;
			if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
		}
		if (
			(rowCounts.get(tautulliInstances[0]!.id) ?? 0) !==
			generations.get(tautulliInstances[0]!.id)!.itemCount
		) {
			throw new Error("Tautulli cache row count did not match its published generation");
		}

		const snapshot = createProviderCacheSnapshot(
			map,
			"tautulli",
			tautulliInstances,
			generations,
			rowsByInstance,
		);
		if (!(await revalidateProviderCacheAuthority(deps, snapshot.authority, false))) {
			throw new Error("Tautulli cache generation changed while rows were read");
		}
		log.info(
			{ totalRows, totalEntries: map.size },
			"Tautulli watch data prefetch complete for cleanup",
		);
		return snapshot;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Tautulli data for cleanup — Tautulli rules will be skipped",
		);
		return undefined;
	}
}

async function prefetchTautulliData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<TautulliWatchMap | undefined> {
	return (await loadTautulliDataSnapshot(deps, userId))?.value;
}

/**
 * Prefetch Plex watch data from the PlexCache table and build a lookup map.
 * Now section-aware: each row carries sectionId/sectionTitle, and PlexWatchInfo
 * contains both pre-computed cross-section aggregates and a per-section breakdown.
 * Also includes collections and labels from the PlexCache table.
 * Returns undefined if no Plex instance is configured.
 */
async function loadPlexDataSnapshot(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<ProviderCacheSnapshot<PlexWatchMap> | undefined> {
	const { prisma, log } = deps;

	const plexInstances = await loadProviderInstances(deps, userId, ["PLEX"]);

	if (plexInstances.length === 0) return undefined;

	try {
		const generations = await loadCompleteCacheGenerations(deps, plexInstances, "plex");
		if (!generations) {
			throw new Error("Plex cache did not have a complete fresh generation for every instance");
		}
		const map: PlexWatchMap = new Map();
		const instanceIds = plexInstances.map((i) => i.id);
		const rowCounts = new Map<string, number>();
		const rowsByInstance = new Map<string, unknown[]>();
		let cursor: string | undefined;
		let totalRows = 0;

		// Cursor-paginate to bound peak heap. Project only columns the watch-map
		// builder reads — skipping ratingKey/thumb/title and the per-row instanceId.
		while (true) {
			const batch = await prisma.plexCache.findMany({
				where: { instanceId: { in: instanceIds } },
				select: PROVIDER_CACHE_ROW_SELECTS.plex,
				take: CACHE_QUERY_BATCH_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: { id: "asc" },
			});

			if (batch.length === 0) break;
			totalRows += batch.length;

			for (const row of batch) {
				try {
					const generation = generations.get(row.instanceId);
					if (
						!generation ||
						row.connectionGeneration !== generation.connectionGeneration ||
						row.identityGeneration !== generation.identityGeneration
					) {
						throw new Error("Plex cache row provenance was unavailable");
					}
					rowCounts.set(row.instanceId, (rowCounts.get(row.instanceId) ?? 0) + 1);
					const sourceRows = rowsByInstance.get(row.instanceId) ?? [];
					sourceRows.push(row);
					rowsByInstance.set(row.instanceId, sourceRows);
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
		if (
			plexInstances.some(
				(instance) => (rowCounts.get(instance.id) ?? 0) !== generations.get(instance.id)!.itemCount,
			)
		) {
			throw new Error("Plex cache row count did not match its published generation");
		}

		const snapshot = createProviderCacheSnapshot(
			map,
			"plex",
			plexInstances,
			generations,
			rowsByInstance,
		);
		if (!(await revalidateProviderCacheAuthority(deps, snapshot.authority, false))) {
			throw new Error("Plex cache generation changed while rows were read");
		}
		log.info(
			{ totalRows, totalEntries: map.size },
			"Plex watch data prefetch complete for cleanup",
		);
		return snapshot;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Plex data for cleanup — Plex rules will be skipped",
		);
		return undefined;
	}
}

export async function prefetchPlexData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexWatchMap | undefined> {
	return (await loadPlexDataSnapshot(deps, userId))?.value;
}

/**
 * Prefetch Jellyfin watch data from JellyfinCache.
 * Mirrors prefetchPlexData but simpler — no sections/labels.
 */
async function loadJellyfinDataSnapshot(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<ProviderCacheSnapshot<JellyfinWatchMap> | undefined> {
	const { prisma, log } = deps;

	const jellyfinInstances = await loadProviderInstances(deps, userId, ["JELLYFIN", "EMBY"]);

	if (jellyfinInstances.length === 0) return undefined;

	try {
		const generations = await loadCompleteCacheGenerations(deps, jellyfinInstances, "jellyfin");
		if (!generations) {
			throw new Error("Jellyfin cache did not have a complete fresh generation for every instance");
		}
		const map: JellyfinWatchMap = new Map();
		const instanceIds = jellyfinInstances.map((i) => i.id);
		const rowCounts = new Map<string, number>();
		const rowsByInstance = new Map<string, unknown[]>();
		let cursor: string | undefined;
		let totalRows = 0;

		// Cursor-paginate. Project only columns the watch-map reader uses.
		while (true) {
			const batch = await prisma.jellyfinCache.findMany({
				where: { instanceId: { in: instanceIds } },
				select: PROVIDER_CACHE_ROW_SELECTS.jellyfin,
				take: CACHE_QUERY_BATCH_SIZE,
				...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
				orderBy: { id: "asc" },
			});

			if (batch.length === 0) break;
			totalRows += batch.length;

			for (const row of batch) {
				try {
					const generation = generations.get(row.instanceId);
					if (
						!generation ||
						row.connectionGeneration !== generation.connectionGeneration ||
						row.identityGeneration !== generation.identityGeneration
					) {
						throw new Error("Jellyfin cache row provenance was unavailable");
					}
					rowCounts.set(row.instanceId, (rowCounts.get(row.instanceId) ?? 0) + 1);
					const sourceRows = rowsByInstance.get(row.instanceId) ?? [];
					sourceRows.push(row);
					rowsByInstance.set(row.instanceId, sourceRows);
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
		if (
			jellyfinInstances.some(
				(instance) => (rowCounts.get(instance.id) ?? 0) !== generations.get(instance.id)!.itemCount,
			)
		) {
			throw new Error("Jellyfin cache row count did not match its published generation");
		}

		const snapshot = createProviderCacheSnapshot(
			map,
			"jellyfin",
			jellyfinInstances,
			generations,
			rowsByInstance,
		);
		if (!(await revalidateProviderCacheAuthority(deps, snapshot.authority, false))) {
			throw new Error("Jellyfin cache generation changed while rows were read");
		}
		log.info(
			{ totalRows, totalEntries: map.size },
			"Jellyfin watch data prefetch complete for cleanup",
		);
		return snapshot;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Jellyfin data for cleanup — Jellyfin rules will be skipped",
		);
		return undefined;
	}
}

async function prefetchJellyfinData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<JellyfinWatchMap | undefined> {
	return (await loadJellyfinDataSnapshot(deps, userId))?.value;
}

/**
 * Prefetch Jellyfin episode completion data.
 * Mirrors Plex pattern using JellyfinEpisodeCache with GROUP BY.
 */
async function loadJellyfinEpisodeDataSnapshot(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<ProviderCacheSnapshot<PlexEpisodeMap> | undefined> {
	const { prisma, log } = deps;

	try {
		const instances = await loadProviderInstances(deps, userId, ["JELLYFIN", "EMBY"]);
		const instanceIds = instances.map((i) => i.id);
		if (instanceIds.length === 0) return undefined;
		const generations = await loadCompleteCacheGenerations(deps, instances, "jellyfin_episode");
		if (!generations) return undefined;
		const generationRows = await prisma.jellyfinEpisodeCache.findMany({
			where: { instanceId: { in: instanceIds } },
			select: PROVIDER_CACHE_ROW_SELECTS.jellyfin_episode,
			orderBy: { id: "asc" },
		});
		const countByInstance = new Map<string, number>();
		const rowsByInstance = new Map<string, unknown[]>();
		for (const row of generationRows) {
			const generation = generations.get(row.instanceId);
			if (
				!generation ||
				row.connectionGeneration !== generation.connectionGeneration ||
				row.identityGeneration !== generation.identityGeneration
			) {
				return undefined;
			}
			countByInstance.set(row.instanceId, (countByInstance.get(row.instanceId) ?? 0) + 1);
			const sourceRows = rowsByInstance.get(row.instanceId) ?? [];
			sourceRows.push(row);
			rowsByInstance.set(row.instanceId, sourceRows);
		}
		if (
			instances.some(
				(instance) =>
					(countByInstance.get(instance.id) ?? 0) !== generations.get(instance.id)!.itemCount,
			)
		) {
			return undefined;
		}

		const map: PlexEpisodeMap = new Map();
		for (const row of generationRows) {
			const show = map.get(row.showTmdbId) ?? { total: 0, watched: 0, seasons: new Map() };
			show.total++;
			if (row.watched) show.watched++;
			const season = show.seasons.get(row.seasonNumber) ?? { total: 0, watched: 0 };
			season.total++;
			if (row.watched) season.watched++;
			show.seasons.set(row.seasonNumber, season);
			map.set(row.showTmdbId, show);
		}

		const snapshot = createProviderCacheSnapshot(
			map,
			"jellyfin_episode",
			instances,
			generations,
			rowsByInstance,
		);
		if (!(await revalidateProviderCacheAuthority(deps, snapshot.authority, false)))
			return undefined;
		log.info({ totalShows: map.size }, "Jellyfin episode data prefetch complete for cleanup");
		return snapshot;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Jellyfin episode data for cleanup — episode completion rules will be skipped",
		);
		return undefined;
	}
}

async function prefetchJellyfinEpisodeData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexEpisodeMap | undefined> {
	return (await loadJellyfinEpisodeDataSnapshot(deps, userId))?.value;
}

/**
 * Prefetch Plex episode completion data for series.
 * Uses SQL GROUP BY on PlexEpisodeCache to avoid loading all episodes into memory.
 * Returns a Map of showTmdbId → { total, watched }.
 */
async function loadPlexEpisodeDataSnapshot(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<ProviderCacheSnapshot<PlexEpisodeMap> | undefined> {
	const { prisma, log } = deps;

	try {
		const instances = await loadProviderInstances(deps, userId, ["PLEX"]);
		const instanceIds = instances.map((i) => i.id);
		if (instanceIds.length === 0) return undefined;
		const generations = await loadCompleteCacheGenerations(deps, instances, "plex_episode");
		if (!generations) return undefined;
		const generationRows = await prisma.plexEpisodeCache.findMany({
			where: { instanceId: { in: instanceIds } },
			select: PROVIDER_CACHE_ROW_SELECTS.plex_episode,
			orderBy: { id: "asc" },
		});
		const rowCounts = new Map<string, number>();
		const rowsByInstance = new Map<string, unknown[]>();
		for (const row of generationRows) {
			const generation = generations.get(row.instanceId);
			const instance = instances.find((candidate) => candidate.id === row.instanceId);
			if (
				!generation ||
				!instance ||
				row.connectionGeneration !== generation.connectionGeneration ||
				row.identityGeneration !== generation.identityGeneration ||
				row.refreshedAt?.getTime() !== generation.completedAt.getTime() ||
				row.sourceFingerprint !== plexConnectionFingerprint(instance as ServiceInstance)
			) {
				return undefined;
			}
			rowCounts.set(row.instanceId, (rowCounts.get(row.instanceId) ?? 0) + 1);
			const sourceRows = rowsByInstance.get(row.instanceId) ?? [];
			sourceRows.push(row);
			rowsByInstance.set(row.instanceId, sourceRows);
		}
		if (
			instances.some(
				(instance) => (rowCounts.get(instance.id) ?? 0) !== generations.get(instance.id)!.itemCount,
			)
		) {
			return undefined;
		}

		const map: PlexEpisodeMap = new Map();
		for (const row of generationRows) {
			const show = map.get(row.showTmdbId) ?? { total: 0, watched: 0, seasons: new Map() };
			show.total++;
			if (row.watched) show.watched++;
			const season = show.seasons.get(row.seasonNumber) ?? { total: 0, watched: 0 };
			season.total++;
			if (row.watched) season.watched++;
			show.seasons.set(row.seasonNumber, season);
			map.set(row.showTmdbId, show);
		}

		const snapshot = createProviderCacheSnapshot(
			map,
			"plex_episode",
			instances,
			generations,
			rowsByInstance,
		);
		if (!(await revalidateProviderCacheAuthority(deps, snapshot.authority, false)))
			return undefined;
		log.info({ totalShows: map.size }, "Plex episode data prefetch complete for cleanup");
		return snapshot;
	} catch (error) {
		log.warn(
			{ err: error },
			"Failed to prefetch Plex episode data for cleanup — episode completion rules will be skipped",
		);
		return undefined;
	}
}

async function prefetchPlexEpisodeData(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<PlexEpisodeMap | undefined> {
	return (await loadPlexEpisodeDataSnapshot(deps, userId))?.value;
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
	providerEvidence: SanitizedProviderEvidence;
	providerAuthorities: Array<ProviderCacheSnapshot<unknown>["authority"]>;
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
	const orderedRules = [...rules].sort(
		(left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
	);
	const persistedEpisodeRules = orderedRules.filter((rule) => rule.targetScope === "episode");
	const seriesRules = orderedRules.filter((rule) => rule.targetScope !== "episode");
	const episodeRules = orderedRules.filter(isSupportedEpisodeCleanupRule);
	const unsupportedEpisodeRules = persistedEpisodeRules.filter(
		(rule) => rule.enabled && !isSupportedEpisodeCleanupRule(rule),
	);
	if (unsupportedEpisodeRules.length > 0) {
		warnings.push(
			`${unsupportedEpisodeRules.length} enabled episode-scoped cleanup ${unsupportedEpisodeRules.length === 1 ? "rule was" : "rules were"} skipped because ${unsupportedEpisodeRules.length === 1 ? "its" : "their"} persisted shape is unsupported.`,
		);
	}

	// Series-level prefetches do not satisfy episode-scoped rules. Those rules
	// use their own fresh, per-episode evidence below.
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

	// Prefetch Tautulli watch data if any Tautulli rule types are active
	const TAUTULLI_RULE_TYPES = [
		"tautulli_last_watched",
		"tautulli_watch_count",
		"tautulli_watched_by",
		"user_retention", // Can use tautulli as source
	];
	const hasTautulliRules = TAUTULLI_RULE_TYPES.some((t) => activeTypes.has(t));
	const tautulliSnapshot = hasTautulliRules
		? await loadTautulliDataSnapshot(deps, config.userId)
		: undefined;
	const tautulliMap = tautulliSnapshot?.value;

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
	const needsPlexSectionInventory = collectConfiguredPlexSectionTitles(seriesRules).size > 0;
	let plexSnapshot =
		hasPlexRules || needsPlexSectionInventory
			? await loadPlexDataSnapshot(deps, config.userId)
			: undefined;
	let publishedPlexEvidence = needsPlexSectionInventory
		? await loadPublishedPlexPolicyEvidence(deps, config.userId, seriesRules)
		: undefined;
	if (
		plexSnapshot &&
		publishedPlexEvidence &&
		!(await revalidateProviderCacheAuthority(deps, plexSnapshot.authority, false))
	) {
		plexSnapshot = undefined;
		publishedPlexEvidence = undefined;
	}
	const plexMap = plexSnapshot?.value;
	const plexSectionTitles =
		publishedPlexEvidence?.plexSectionTitles ??
		new Set(
			[...(plexMap?.values() ?? [])].flatMap((entry) =>
				entry.sections.map((section) => section.sectionTitle),
			),
		);

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
	const jellyfinSnapshot = hasJellyfinRules
		? await loadJellyfinDataSnapshot(deps, config.userId)
		: undefined;
	const jellyfinMap = jellyfinSnapshot?.value;

	// Prefetch Plex episode data if episode completion rule is active
	const hasEpisodeCompletionRules = activeTypes.has("plex_episode_completion");
	const needsPlexEpisodeEvidence = hasEpisodeCompletionRules || episodeRules.length > 0;
	const plexEpisodeSnapshot = needsPlexEpisodeEvidence
		? await loadPlexEpisodeDataSnapshot(deps, config.userId)
		: undefined;
	const plexEpisodeMap = plexEpisodeSnapshot?.value;

	const hasJellyfinEpisodeRules = activeTypes.has("jellyfin_episode_completion");
	const jellyfinEpisodeSnapshot = hasJellyfinEpisodeRules
		? await loadJellyfinEpisodeDataSnapshot(deps, config.userId)
		: undefined;
	const jellyfinEpisodeMap = jellyfinEpisodeSnapshot?.value;
	const needsTmdb = activeTypes.has("tmdb_list_member");
	const needsTrakt = activeTypes.has("trakt_list_member");
	const listEvidence =
		needsTmdb || needsTrakt
			? await refreshListMutationEvidence(deps, config.userId, seriesRules)
			: {};

	// Build prefetch health status
	const prefetchHealth: PrefetchResults = {
		seerr: hasSeerrRules ? (seerrMap ? "ok" : "failed") : "skipped",
		tautulli: hasTautulliRules ? (tautulliMap ? "ok" : "failed") : "skipped",
		plex:
			hasPlexRules || needsPlexEpisodeEvidence || needsPlexSectionInventory
				? (!hasPlexRules || plexSnapshot) &&
					(!needsPlexEpisodeEvidence || plexEpisodeSnapshot) &&
					(!needsPlexSectionInventory || publishedPlexEvidence)
					? "ok"
					: "failed"
				: "skipped",
		jellyfin:
			hasJellyfinRules || hasJellyfinEpisodeRules
				? (!hasJellyfinRules || jellyfinMap) && (!hasJellyfinEpisodeRules || jellyfinEpisodeMap)
					? "ok"
					: "failed"
				: "skipped",
		tmdb: needsTmdb ? (listEvidence.tmdbListMemberships ? "ok" : "failed") : "skipped",
		trakt: needsTrakt ? (listEvidence.traktListMemberships ? "ok" : "failed") : "skipped",
	};

	const contributingSnapshots = [
		tautulliSnapshot,
		plexSnapshot,
		plexEpisodeSnapshot,
		jellyfinSnapshot,
		jellyfinEpisodeSnapshot,
	].filter((snapshot) => snapshot !== undefined) as ProviderCacheSnapshot<unknown>[];
	const providerEvidence = createSanitizedProviderEvidence(
		contributingSnapshots.flatMap((snapshot) => snapshot.evidence.dependencies),
		contributingSnapshots.flatMap((snapshot) =>
			snapshot.evidence.sources.map(({ fingerprint: _fingerprint, ...source }) => source),
		),
	);

	// Check for failed prefetches that have dependent rules — generate warnings
	const failedSources = new Set<DataSourceDependency>();
	if (prefetchHealth.seerr === "failed") failedSources.add("seerr");
	if (prefetchHealth.tautulli === "failed") failedSources.add("tautulli");
	if (prefetchHealth.plex === "failed") failedSources.add("plex");
	if (prefetchHealth.jellyfin === "failed") failedSources.add("jellyfin");
	if (prefetchHealth.tmdb === "failed") failedSources.add("tmdb");
	if (prefetchHealth.trakt === "failed") failedSources.add("trakt");

	if (failedSources.size > 0) {
		const unavailableRuleWarning = buildUnavailableRuleWarning(seriesRules, failedSources);
		if (unavailableRuleWarning) warnings.push(unavailableRuleWarning);
		log.warn(
			{ prefetchHealth, warnings },
			"Cleanup run has failed prefetches with dependent rules",
		);
	}
	// Build evaluation context
	const ctx: EvalContext = {
		now,
		seerrMap,
		tautulliMap,
		plexMap,
		plexSectionTitles,
		plexEpisodeMap,
		jellyfinMap,
		jellyfinEpisodeMap,
		tmdbListMemberships: listEvidence.tmdbListMemberships,
		traktListMemberships: listEvidence.traktListMemberships,
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

			const match =
				useCachedQuiSeedingGate && isQuiSeedingState(item.torrentState)
					? null
					: evaluateItemAgainstRules(item, seriesRules, instanceService, ctx, failedSources);
			if (match) {
				flagged.push({
					cacheItem: item,
					match,
					rating: extractRating(item),
					respectQuiSeeding,
				});
			}
			if (
				instanceService === "SONARR" &&
				item.itemType === "series" &&
				!match &&
				episodeRules.length > 0
			) {
				const episodeMatches = await evaluateSeriesEpisodes(
					deps,
					item,
					instances.find((instance) => instance.id === item.instanceId),
					episodeRules,
					seriesRules,
					ctx,
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

	return {
		flagged,
		totalEvaluated,
		prefetchHealth,
		warnings,
		providerEvidence: providerEvidence,
		providerAuthorities: contributingSnapshots.map((snapshot) => snapshot.authority),
	};
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

export async function prefetchFreshPlexEpisodeWatchData(
	deps: CleanupExecutorDeps,
	instances: ServiceInstance[],
	now: Date,
	warnings: string[],
	options: {
		includeUnwatched?: boolean;
		evidenceSink?: (evidence: SanitizedProviderEvidence) => void;
		coordinate?: {
			showTmdbId: number;
			seasonNumber: number;
			episodeNumber: number;
		};
	} = {},
): Promise<Map<string, EpisodePlexWatchEvidence[]>> {
	const plexInstanceIds = instances
		.filter((instance) => instance.service === "PLEX" && instance.enabled)
		.map((instance) => instance.id);
	const plexUpdatedAtById = new Map(
		instances
			.filter((instance) => instance.service === "PLEX" && instance.enabled)
			.map((instance) => [instance.id, instance.updatedAt.getTime()]),
	);
	const plexFingerprintById = new Map(
		instances
			.filter((instance) => instance.service === "PLEX" && instance.enabled)
			.map((instance) => [instance.id, plexConnectionFingerprint(instance)]),
	);
	if (plexInstanceIds.length === 0) {
		warnings.push(
			"No enabled Plex instance was available; episode-scoped cleanup targets were skipped.",
		);
		return new Map();
	}

	try {
		const plexInstances = instances.filter(
			(instance) => instance.service === "PLEX" && instance.enabled,
		);
		const generations = await loadCompleteCacheGenerations(
			deps,
			plexInstances,
			"plex_episode",
			now,
		);
		if (!generations) {
			warnings.push(
				"Plex episode evidence had no complete fresh published generation for every enabled instance; episode-scoped cleanup targets were skipped.",
			);
			return new Map();
		}
		const generationCounts = await deps.prisma.plexEpisodeCache.groupBy({
			by: ["instanceId"],
			where: { instanceId: { in: plexInstanceIds } },
			_count: { id: true },
		});
		const countByInstance = new Map(generationCounts.map((row) => [row.instanceId, row._count.id]));
		if (
			plexInstances.some(
				(instance) =>
					(countByInstance.get(instance.id) ?? 0) !== generations.get(instance.id)!.itemCount,
			)
		) {
			warnings.push(
				"Plex episode evidence did not match its published generation; episode-scoped cleanup targets were skipped.",
			);
			return new Map();
		}
		const rows = await deps.prisma.plexEpisodeCache.findMany({
			where: {
				instanceId: { in: plexInstanceIds },
				...(options.includeUnwatched ? {} : { watchCount: { gt: 0 } }),
				...(options.coordinate ?? {}),
			},
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
				connectionGeneration: true,
				identityGeneration: true,
			},
		});
		const result = new Map<string, EpisodePlexWatchEvidence[]>();
		const rowsByInstance = new Map<string, unknown[]>(
			plexInstances.map((instance) => [instance.id, []]),
		);
		let staleEvidenceCount = 0;
		let incompleteEvidenceCount = 0;
		const freshnessThreshold = now.getTime() - PLEX_EPISODE_FRESHNESS_MS;
		for (const row of rows) {
			rowsByInstance.get(row.instanceId)?.push(row);
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
			const generation = generations.get(row.instanceId);
			if (
				sourceUpdatedAt === undefined ||
				!Number.isFinite(sourceUpdatedAt) ||
				!sourceFingerprint ||
				!generation ||
				row.connectionGeneration !== generation.connectionGeneration ||
				row.identityGeneration !== generation.identityGeneration ||
				row.sourceFingerprint !== sourceFingerprint ||
				row.refreshedAt.getTime() !== generation.completedAt.getTime() ||
				row.refreshedAt.getTime() < freshnessThreshold ||
				row.refreshedAt.getTime() < sourceUpdatedAt
			) {
				staleEvidenceCount++;
				continue;
			}
			const key = episodeCoordinateKey(row.showTmdbId, row.seasonNumber, row.episodeNumber);
			const parsedUsers = safeJsonParse(row.watchedByUsers);
			const users = Array.isArray(parsedUsers)
				? parsedUsers.filter((user): user is string => typeof user === "string")
				: [];
			const evidence: EpisodePlexWatchEvidence = {
				plexInstanceId: row.instanceId,
				sourceFingerprint,
				ratingKey: row.ratingKey,
				watchCount: row.watchCount,
				lastWatchedAt: row.lastWatchedAt,
				watchedByUsers: users,
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
		const snapshot = createProviderCacheSnapshot(
			result,
			"plex_episode",
			plexInstances,
			generations,
			rowsByInstance,
		);
		if (!(await revalidateProviderCacheAuthority(deps, snapshot.authority, false, now))) {
			warnings.push(
				"Plex episode evidence changed while it was read; episode-scoped cleanup targets were skipped.",
			);
			return new Map();
		}
		options.evidenceSink?.(snapshot.evidence);
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
	seriesRules: LibraryCleanupRule[],
	ctx: EvalContext,
	watchMap: Map<string, EpisodePlexWatchEvidence[]>,
	watchedSeriesTmdbIds: Set<number>,
	respectQuiSeeding: boolean,
	useCachedQuiSeedingGate: boolean,
	warnings: string[],
): Promise<{ evaluated: number; flagged: FlaggedItem[] }> {
	if (!instance) return { evaluated: 0, flagged: [] };
	const tmdbId = extractSeriesTmdbId(item.data);
	if (tmdbId === null) return { evaluated: 0, flagged: [] };
	if (!watchedSeriesTmdbIds.has(tmdbId)) return { evaluated: 0, flagged: [] };

	const applicableRules = episodeRules.filter((rule) =>
		passesCleanupRuleFilters(item, rule, "SONARR"),
	);
	if (applicableRules.length === 0) return { evaluated: 0, flagged: [] };

	const policyVerifiability = episodeSeriesPolicyMutationVerifiability(item, seriesRules, ctx.now);
	if (!policyVerifiability.verifiable) {
		const blockingRules = policyVerifiability.blockingRuleIds.map((ruleId) => {
			const rule = seriesRules.find((candidate) => candidate.id === ruleId);
			return rule ? `"${rule.name}" (${rule.id})` : ruleId;
		});
		warnings.push(
			`Episodes for "${item.title}" were skipped because ${blockingRules.length === 1 ? "series rule" : "series rules"} ${blockingRules.join(", ")} depend on evidence that cannot be revalidated at mutation time.`,
		);
		return { evaluated: 0, flagged: [] };
	}

	let rawEpisodes: Array<Record<string, unknown>>;
	try {
		const sonarr = deps.arrClientFactory.create(instance) as InstanceType<typeof SonarrClient>;
		rawEpisodes = sortSonarrEpisodesByIdentity(
			(await sonarr.episode.getAll({
				seriesId: item.arrItemId,
				includeEpisodeFile: true,
			})) as Array<Record<string, unknown>>,
		);
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
		select: {
			arrEpisodeFileId: true,
			path: true,
			size: true,
			infoHash: true,
			torrentState: true,
		},
	});
	const filesById = new Map(fileRows.map((file) => [file.arrEpisodeFileId, file]));
	const consumerIdsByFile = new Map<number, number[]>();
	for (const raw of rawEpisodes) {
		const episodeId = raw.id;
		const episodeFileId = raw.episodeFileId;
		if (
			typeof episodeId === "number" &&
			Number.isSafeInteger(episodeId) &&
			episodeId > 0 &&
			typeof episodeFileId === "number" &&
			Number.isSafeInteger(episodeFileId) &&
			episodeFileId > 0
		) {
			const consumers = consumerIdsByFile.get(episodeFileId) ?? [];
			consumers.push(episodeId);
			consumerIdsByFile.set(episodeFileId, consumers);
		}
	}

	const flagged: FlaggedItem[] = [];
	let evaluated = 0;
	for (const raw of rawEpisodes) {
		const arrEpisodeId = raw.id;
		const seasonNumber = raw.seasonNumber;
		const episodeNumber = raw.episodeNumber;
		const episodeFileId = raw.episodeFileId;
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
		const watchEvidence = watchMap.get(episodeCoordinateKey(tmdbId, seasonNumber, episodeNumber));
		const file = filesById.get(episodeFileId);
		if (!watchEvidence?.length || !file) continue;
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
			watchCount: watchEvidence[0]!.watchCount,
			lastWatchedAt: watchEvidence[0]!.lastWatchedAt,
			watchedByUsers: watchEvidence[0]!.watchedByUsers,
			plexWatchEvidence: watchEvidence,
			file: {
				arrEpisodeFileId: file.arrEpisodeFileId,
				path: file.path,
				size: file.size,
				infoHash: file.infoHash,
				torrentState: file.torrentState,
			},
		};
		for (const rule of applicableRules) {
			const parameters = safeJsonParse(rule.parameters) as {
				operator?: unknown;
				count?: unknown;
			} | null;
			if (
				parameters?.operator !== "greater_than" ||
				typeof parameters.count !== "number" ||
				!Number.isFinite(parameters.count)
			) {
				continue;
			}
			const watchCountThreshold = parameters.count;
			// The safety proof may only try Plex sources whose own watch count
			// satisfied this rule. Carrying a lower-count source here would let a
			// physical-path match on that server authorize a rule that only passed
			// because a different server had enough watches.
			const qualifyingWatchEvidence = watchEvidence.filter(
				(evidence) => evidence.watchCount > watchCountThreshold,
			);
			if (qualifyingWatchEvidence.length === 0) continue;
			const ruleCandidate: EpisodeCleanupCandidate = {
				...candidate,
				watchCount: qualifyingWatchEvidence[0]!.watchCount,
				lastWatchedAt: qualifyingWatchEvidence[0]!.lastWatchedAt,
				watchedByUsers: qualifyingWatchEvidence[0]!.watchedByUsers,
				plexWatchEvidence: qualifyingWatchEvidence,
			};
			const match = evaluateEpisodeWatchCountRule(ruleCandidate, rule);
			if (!match) continue;
			flagged.push({
				cacheItem: { ...item, sizeOnDisk: file.size },
				match,
				rating: extractRating(item),
				respectQuiSeeding,
				episodeTarget: toEpisodeTargetMetadata(ruleCandidate),
			});
			break;
		}
	}
	return { evaluated, flagged };
}

function sortableEpisodeIdentityValue(value: unknown): number {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : Number.MAX_SAFE_INTEGER;
}

/** Keep episode selection stable when Sonarr returns the same inventory in a different order. */
export function sortSonarrEpisodesByIdentity(
	episodes: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
	return [...episodes].sort(
		(left, right) =>
			sortableEpisodeIdentityValue(left.seasonNumber) -
				sortableEpisodeIdentityValue(right.seasonNumber) ||
			sortableEpisodeIdentityValue(left.episodeNumber) -
				sortableEpisodeIdentityValue(right.episodeNumber) ||
			sortableEpisodeIdentityValue(left.id) - sortableEpisodeIdentityValue(right.id) ||
			sortableEpisodeIdentityValue(left.episodeFileId) -
				sortableEpisodeIdentityValue(right.episodeFileId),
	);
}

/**
 * A series-level retention rule protects every episode. If any required
 * external source is unavailable, protection cannot be disproved and episode
 * cleanup fails closed before a candidate is built.
 */
export function seriesRetentionProtectsEpisode(
	item: CacheItemForEval,
	seriesRules: LibraryCleanupRule[],
	ctx: EvalContext,
	failedSources: Set<DataSourceDependency>,
	evidenceAvailability?: ConditionEvidenceAvailability,
): boolean {
	const retentionRules = seriesRules.filter(
		(rule) => rule.enabled && rule.retentionMode && passesCleanupRuleFilters(item, rule, "SONARR"),
	);
	return retentionRules.some(
		(rule) =>
			evaluateRuleState(item, rule, "SONARR", ctx, failedSources, evidenceAvailability).state !==
			"false",
	);
}

export function buildUnavailableRuleWarning(
	rules: LibraryCleanupRule[],
	failedSources: Set<DataSourceDependency>,
): string | null {
	const affectedRules = rules.filter(
		(rule) =>
			rule.enabled &&
			rule.targetScope !== "episode" &&
			ruleUsesUnavailableData(rule, failedSources),
	);
	if (affectedRules.length === 0) return null;
	const retentionRuleCount = affectedRules.filter((rule) => rule.retentionMode).length;
	const cleanupRuleCount = affectedRules.length - retentionRuleCount;
	const sources = [...failedSources].sort().join(", ");
	const effects: string[] = [];
	if (retentionRuleCount > 0) {
		effects.push(
			`${retentionRuleCount} retention ${retentionRuleCount === 1 ? "rule may default" : "rules may default"} to protection`,
		);
	}
	if (cleanupRuleCount > 0) {
		effects.push(
			`${cleanupRuleCount} cleanup ${cleanupRuleCount === 1 ? "rule may be" : "rules may be"} skipped`,
		);
	}
	return `${sources} data unavailable; ${effects.join(" and ")} for safety.`;
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

function buildApprovalSelectionDetails(
	selectionPlan: CleanupSelectionPlan<FlaggedItem, LibraryCleanupApproval>,
): CleanupRunResult["details"] {
	const skippedDetails: CleanupRunResult["details"] = [];
	const deferredDetailLimit = Math.max(
		0,
		CLEANUP_DETAIL_LIMIT - selectionPlan.selectedFresh.length,
	);
	for (const decision of selectionPlan.decisions) {
		if (skippedDetails.length >= deferredDetailLimit) break;
		if (decision.disposition === "selected") continue;
		const value = decision.candidate.value;
		if ("cacheItem" in value) {
			skippedDetails.push({
				...buildDetail(value, "skipped", decision.reason),
				previewDisposition: asPreviewDisposition(decision.disposition),
				plannedAction: value.match.action,
			});
		} else {
			skippedDetails.push({
				...buildRetryDetail(value, "skipped", decision.reason),
				previewDisposition: asPreviewDisposition(decision.disposition),
				plannedAction: asRetryRuleAction(value.action),
				isRetryAttempt: true,
			});
		}
	}
	return skippedDetails;
}

function unavailableApprovalSelectionState(
	flagged: FlaggedItem[],
	limit: number,
	warning: string,
): ApprovalSelectionState {
	const plan = planCleanupSelection<FlaggedItem, LibraryCleanupApproval>({
		mode: "approval",
		limit,
		fresh: flagged.map((item) => ({
			key: cleanupDeleteTargetKey(flaggedDeleteTarget(item)),
			value: item,
		})),
		approvalExclusions: new Map(),
		nonterminalRetryKeys: new Set(),
		inFlightRetries: [],
		retryStateLoaded: false,
	});
	return {
		plan,
		selected: [],
		skippedDetails: buildApprovalSelectionDetails(plan),
		pendingRetryCount: null,
		retryStateLoaded: false,
		warnings: [warning],
	};
}

async function loadApprovalSelectionState(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	userId: string,
	flagged: FlaggedItem[],
	limit: number,
): Promise<ApprovalSelectionState> {
	const unavailableWarning =
		"Durable cleanup retry or approval state could not be loaded. Fresh cleanup targets were deferred for safety.";
	let nonterminalRetries: LibraryCleanupApproval[];
	try {
		nonterminalRetries = await deps.prisma.libraryCleanupApproval.findMany({
			where: {
				configId: config.id,
				config: { userId },
				status: { in: ["retry_pending", "retry_executing"] },
			},
			orderBy: [
				{ reviewedAt: { sort: "asc", nulls: "first" } },
				{ createdAt: "asc" },
				{ id: "asc" },
			],
		});
	} catch (error) {
		deps.log.error(
			{ err: error, configId: config.id },
			"Cleanup could not load durable approval retry ownership",
		);
		return unavailableApprovalSelectionState(flagged, limit, unavailableWarning);
	}

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
	let approvalDedupRows: LibraryCleanupApproval[];
	try {
		approvalDedupRows = await deps.prisma.libraryCleanupApproval.findMany({
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
		});
	} catch (error) {
		deps.log.error(
			{ err: error, configId: config.id },
			"Cleanup could not load approval deduplication state",
		);
		return unavailableApprovalSelectionState(flagged, limit, unavailableWarning);
	}
	try {
		for (const retry of nonterminalRetries) cleanupApprovalTargetKey(retry);
		for (const row of approvalDedupRows) cleanupApprovalTargetKey(row);
	} catch (error) {
		deps.log.error(
			{ err: error, configId: config.id },
			"Cleanup approval state contained an episode target without exact file ownership",
		);
		return unavailableApprovalSelectionState(flagged, limit, unavailableWarning);
	}
	const approvalDedupRowsByTarget = new Map<string, typeof approvalDedupRows>();
	for (const row of approvalDedupRows) {
		const targetKey = cleanupApprovalTargetKey(row);
		const rows = approvalDedupRowsByTarget.get(targetKey);
		if (rows) rows.push(row);
		else approvalDedupRowsByTarget.set(targetKey, [row]);
	}

	const approvalExclusions = new Map<string, string>();
	for (const item of flagged) {
		const memWindow = memoryByRuleId.get(item.match.ruleId) ?? { mode: "off" as const };
		const targetRows =
			approvalDedupRowsByTarget.get(cleanupDeleteTargetKey(flaggedDeleteTarget(item))) ?? [];
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
			approvalExclusions.set(
				cleanupDeleteTargetKey(flaggedDeleteTarget(item)),
				buildApprovalDedupSkipReason(existing.status, memWindow) ??
					"Already pending in the approval queue",
			);
		}
	}
	const nonterminalRetryKeys = new Set(
		nonterminalRetries.map((retry) => cleanupApprovalTargetKey(retry)),
	);
	const inFlightRetries = nonterminalRetries
		.filter((retry) => retry.status === "retry_executing")
		.map((retry) => ({
			id: retry.id,
			key: cleanupApprovalTargetKey(retry),
			value: retry,
			reviewedAt: retry.reviewedAt,
			createdAt: retry.createdAt,
		}));
	const selectionPlan = planCleanupSelection<FlaggedItem, LibraryCleanupApproval>({
		mode: "approval",
		limit,
		fresh: flagged.map((item) => ({
			key: cleanupDeleteTargetKey(flaggedDeleteTarget(item)),
			value: item,
		})),
		approvalExclusions,
		nonterminalRetryKeys,
		inFlightRetries,
		retryStateLoaded: true,
	});
	const pendingRetryCount = nonterminalRetries.filter(
		(retry) => retry.status === "retry_pending",
	).length;
	const warnings: string[] = [];
	if (pendingRetryCount > 0) {
		warnings.push(
			`${pendingRetryCount} durable cleanup ${
				pendingRetryCount === 1 ? "retry is" : "retries are"
			} pending outside the approval-run budget.`,
		);
	}
	if (inFlightRetries.length > 0) {
		warnings.push(
			`${inFlightRetries.length} durable cleanup ${
				inFlightRetries.length === 1 ? "retry is" : "retries are"
			} already executing and deferred from this approval run.`,
		);
	}
	return {
		plan: selectionPlan,
		selected: selectionPlan.selectedFresh.map((candidate) => candidate.value),
		skippedDetails: buildApprovalSelectionDetails(selectionPlan),
		pendingRetryCount,
		retryStateLoaded: true,
		warnings,
	};
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
	providerEvidence?: SanitizedProviderEvidence,
	providerAuthorities: Array<ProviderCacheSnapshot<unknown>["authority"]> = [],
	preSkippedDetails: CleanupRunResult["details"] = [],
	selectionState?: ApprovalSelectionState,
): Promise<CleanupRunResult> {
	const { log } = deps;
	const now = new Date();
	const expiresAt = new Date(now.getTime() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

	const details: CleanupRunResult["details"] = [];
	const deferredDetails = preSkippedDetails.slice(0, CLEANUP_DETAIL_LIMIT);
	const resultWarnings = [...(warnings ?? [])];
	let approvalQueueFailures = 0;

	// Approval and retry ownership was loaded once, before any queue write, by
	// loadApprovalSelectionState. The operation guard prevents another cleanup
	// run from creating pending rows, and the planner elected one fresh owner
	// per target. Keeping reads before writes means a storage read failure can
	// defer the whole run instead of being discovered after an earlier item was
	// already queued.
	for (let itemIndex = 0; itemIndex < flagged.length; itemIndex++) {
		const item = flagged[itemIndex]!;
		const targetKey = cleanupDeleteTargetKey(flaggedDeleteTarget(item));
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
			const approval = await createApprovalWithProviderCacheAuthority(deps, providerAuthorities, {
				configId: config.id,
				instanceId: item.cacheItem.instanceId,
				arrItemId: item.cacheItem.arrItemId,
				itemType: item.cacheItem.itemType,
				targetScope: item.episodeTarget ? "episode" : "series",
				arrEpisodeId: item.episodeTarget?.arrEpisodeId,
				episodeFileId: item.episodeTarget?.episodeFileId,
				seasonNumber: item.episodeTarget?.seasonNumber,
				episodeNumber: item.episodeTarget?.episodeNumber,
				title: item.cacheItem.title,
				episodeTitle: item.episodeTarget?.episodeTitle,
				matchedRuleId: item.match.ruleId,
				matchedRuleName: item.match.ruleName,
				reason: item.match.reason,
				action: item.match.action,
				scanMediaServerAfterDelete: item.match.scanMediaServerAfterDelete,
				sizeOnDisk: item.cacheItem.sizeOnDisk,
				year: item.cacheItem.year,
				rating: item.rating,
				status: "pending",
				safetySnapshot: serializeExecutableSafetyPlan(
					asExecutableSafetyPlan(safetyPlans.get(targetKey)) ??
						(() => {
							throw new Error("No executable cleanup safety plan was produced");
						})(),
					providerEvidence,
				),
				expiresAt,
			});

			details.push(
				buildDetail(item, "queued_for_approval", undefined, {
					actionId: approval.id,
					approvalId: approval.id,
				}),
			);
		} catch (error) {
			if (error instanceof ProviderCacheAuthorityChangedError) {
				const reason =
					"Provider cache authority changed after cleanup selection; this and later approvals were not queued.";
				const remaining = flagged.slice(itemIndex);
				details.push(...remaining.map((candidate) => buildDetail(candidate, "skipped", reason)));
				approvalQueueFailures += remaining.length;
				resultWarnings.push(reason);
				log.warn({ remainingApprovals: remaining.length }, reason);
				break;
			}
			log.error(
				{ err: error, title: item.cacheItem.title },
				"Failed to create cleanup approval entry",
			);
			details.push(buildDetail(item, "skipped", `Failed to queue: ${getErrorMessage(error)}`));
			approvalQueueFailures++;
		}
	}

	const hasFailedPrefetch = resultWarnings.length > 0;
	const result: CleanupRunResult = {
		isDryRun: false,
		status: hasFailedPrefetch || approvalQueueFailures > 0 ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: totalFlaggedBeforeLimit,
		pendingRetryCount: selectionState?.pendingRetryCount,
		previewItemCount: selectionState?.plan.counts.total,
		previewSelection: selectionState
			? {
					...selectionState.plan.counts,
					blocked: sharedPlexBlocks.size,
				}
			: undefined,
		itemsRemoved: 0,
		itemsUnmonitored: 0,
		itemsFilesDeleted: 0,
		itemsSkipped:
			totalFlaggedBeforeLimit - flagged.length + sharedPlexBlocks.size + approvalQueueFailures,
		details: [...details, ...deferredDetails].slice(0, CLEANUP_DETAIL_LIMIT),
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings: resultWarnings.length > 0 ? resultWarnings : undefined,
	};

	await createRunLog(deps, config.id, result);
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
	providerEvidence: SanitizedProviderEvidence = createSanitizedProviderEvidence([], []),
	providerAuthorities: Array<ProviderCacheSnapshot<unknown>["authority"]> = [],
	cleanupRunClaimToken?: string,
): Promise<CleanupRunResult> {
	const { prisma, arrClientFactory, log } = deps;

	const details: CleanupRunResult["details"] = [];
	let removed = 0;
	let unmonitored = 0;
	let filesDeleted = 0;
	let consecutiveFailures = 0;
	let circuitBroken = false;
	let runtimeSafetyBlocks = 0;
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
	const mediaServerRescanWarnings: string[] = [];
	const mediaServerRescanApprovalIds = new Set<string>();
	let providerAuthorityFailed = false;
	const sharedPlexSafetyContext = createSharedPlexSafetyContext();
	const configuredRunLimit =
		Number.isSafeInteger(config.maxRemovalsPerRun) &&
		config.maxRemovalsPerRun > 0 &&
		config.maxRemovalsPerRun <= 100
			? config.maxRemovalsPerRun
			: 0;
	const getMutationPolicySnapshot = createMutationPolicySnapshotGetter(
		deps,
		userId,
		completeMutationConfigFingerprint(config),
		cleanupRunClaimToken,
	);
	const directSelection = await loadDirectSelectionState(
		deps,
		userId,
		config.id,
		flagged,
		configuredRunLimit,
	);
	const directRetries = directSelection.plan.selectedRetries.map((retry) => retry.value);
	directRetryLoadFailures = directSelection.retryStateLoaded ? 0 : 1;
	directRetryFairnessDeferred = directSelection.plan.counts.deferredRetryFairness;
	const selectedDetailCapacity =
		directSelection.plan.selectedRetries.length + directSelection.plan.selectedFresh.length;
	const deferredDetailLimit = Math.max(0, CLEANUP_DETAIL_LIMIT - selectedDetailCapacity);
	for (const decision of directSelection.plan.decisions) {
		if (details.length >= deferredDetailLimit) break;
		if (decision.disposition === "selected") continue;
		const value = decision.candidate.value;
		if ("cacheItem" in value) details.push(buildDetail(value, "skipped", decision.reason));
		else details.push(buildRetryDetail(value, "skipped", decision.reason));
	}
	const deferredSelectionDetailCount = details.length;

	for (const retry of directRetries) {
		if (providerAuthorityFailed) {
			directRetryFailures++;
			details.push(
				buildRetryDetail(
					retry,
					"skipped",
					"Deferred because provider authority changed for an earlier cleanup target",
				),
			);
			continue;
		}
		try {
			const retryResult = await executeQueuedCleanupItems(deps, userId, [retry.id], {
				claimStatus: "retry_pending",
				executeStatus: "retry_executing",
				retryStatus: "retry_pending",
				enforceExpiry: false,
				assertExecutionAllowed: assertRunLease,
				getMutationPolicySnapshot,
				deferMediaServerRescans: true,
				cleanupRunClaimToken,
			});
			mediaServerRescanWarnings.push(...(retryResult.warnings ?? []));
			for (const approvalId of retryResult.rescanApprovalIds) {
				mediaServerRescanApprovalIds.add(approvalId);
			}
			if (retryResult.providerAuthorityFailed) providerAuthorityFailed = true;
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

	// Selection is fixed before retry attempts, policy checks, provider/list
	// checks, safety inspection, or writes. Failed or blocked selected targets
	// consume their slots and never pull later candidates into this run.
	const freshItems = directSelection.plan.selectedFresh.map((candidate) => candidate.value);
	const budgetDeferredItems = directSelection.plan.counts.deferredBudget;

	for (const item of freshItems) {
		if (providerAuthorityFailed) {
			details.push(
				buildDetail(
					item,
					"skipped",
					"Skipped because provider authority changed for an earlier cleanup target",
				),
			);
			continue;
		}
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

		const targetKey = cleanupDeleteTargetKey(flaggedDeleteTarget(item));
		let sharedPlexBlock = sharedPlexBlocks.get(targetKey);
		let safetyPlan: SharedMediaSafetyPlan | undefined;
		try {
			const freshBlocks = await findSharedPlexDeleteBlocks(
				deps,
				userId,
				[flaggedDeleteTarget(item)],
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
		let directProviderEvidence = providerEvidence;
		try {
			if (
				!(
					await Promise.all(
						providerAuthorities.map((authority) =>
							revalidateProviderCacheAuthority(deps, authority),
						),
					)
				).every(Boolean)
			) {
				throw new Error("Provider cache authority changed after cleanup selection");
			}
			const intent = await persistAndClaimDirectMutationIntent(
				deps,
				config,
				userId,
				item,
				safetyPlan!,
				providerEvidence,
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
			const durableEnvelope = parseExecutableSafetyEnvelope(intent.safetySnapshot);
			const directRule = config.rules.find(
				(rule) =>
					rule.id === item.match.ruleId &&
					(item.episodeTarget ? rule.targetScope === "episode" : rule.targetScope !== "episode"),
			);
			const directSelectionRequiresProviderEvidence =
				directRule !== undefined &&
				ruleUsesUnavailableData(
					directRule,
					new Set<DataSourceDependency>(["plex", "jellyfin", "tautulli"]),
				);
			if (
				!durableEnvelope ||
				(directSelectionRequiresProviderEvidence &&
					durableEnvelope.providerEvidence.dependencies.length === 0)
			) {
				throw new ProviderExecutionAuthorityChangedError();
			}
			directProviderEvidence = durableEnvelope.providerEvidence;
		} catch (error) {
			if (isProviderExecutionAuthorityFailure(error)) {
				providerAuthorityFailed = true;
			}
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
		const directIdentity: {
			actionId: string;
			approvalId: string;
			auditCorrelationId: string;
			auditPrepared: boolean;
			mutationAttempted: boolean;
			durableStateRecordingFailed: boolean;
		} = {
			actionId: directMutationIntentId,
			approvalId: directMutationIntentId,
			auditCorrelationId: directMutationExecutionToken,
			auditPrepared: false,
			mutationAttempted: false,
			durableStateRecordingFailed: false,
		};
		const directAuditApproval = {
			id: directMutationIntentId,
			configId: config.id,
			instanceId: item.cacheItem.instanceId,
			arrItemId: item.cacheItem.arrItemId,
			itemType: item.cacheItem.itemType,
			targetScope: item.episodeTarget ? ("episode" as const) : ("series" as const),
			arrEpisodeId: item.episodeTarget?.arrEpisodeId,
			title: item.cacheItem.title,
			ruleId: item.match.ruleId,
			ruleName: item.match.ruleName,
			action: ruleAction,
			reason: item.match.reason,
			status: "retry_executing",
		};
		const directAuditTrigger = deps.auditTrigger === "manual" ? "manual" : "scheduled";
		await runCleanupAuditBestEffort(
			() =>
				recordApprovalExecutionClaimed(
					prisma,
					{
						approval: directAuditApproval,
						correlationId: directMutationExecutionToken,
						trigger: directAuditTrigger,
						actorId: deps.auditActorId,
						includeCandidate: true,
					},
					log,
				),
			log,
			"direct cleanup execution claim",
		);

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
						directIdentity,
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
			let authorizedSeriesPolicy: AuthorizedSeriesMutationPolicy | undefined;
			const assertDirectExecutionAuthority: MutationAuthorityCheck = async (evidence) => {
				await assertRunLease?.();
				await assertCurrentProviderEvidenceAuthority(
					deps,
					userId,
					directProviderEvidence,
					assertRunLease,
				);
				if (safetyPlan!.kind === "verified_sonarr_episode") {
					await assertCurrentEpisodeMutationAuthority(
						deps,
						userId,
						mutationInstance,
						item.cacheItem.arrItemId,
						{
							matchedRuleId: item.match.ruleId,
							action: ruleAction,
							scanMediaServerAfterDelete: item.match.scanMediaServerAfterDelete === true,
						},
						evidence && "liveEpisodeWatchSources" in evidence ? evidence : undefined,
						completeMutationConfigFingerprint(config),
					);
				} else {
					if (!evidence || !("seriesTransition" in evidence)) {
						throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
							"Skipped for safety: the expected ARR mutation transition was unavailable.",
						);
					}
					if (!authorizedSeriesPolicy) {
						if (evidence.seriesTransition !== "unchanged") {
							throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
								"Skipped for safety: no original ARR policy state was captured before the file transition.",
							);
						}
						const snapshot = await getMutationPolicySnapshot();
						authorizedSeriesPolicy = await assertCurrentSeriesMutationAuthority(
							deps,
							userId,
							mutationInstance,
							item.cacheItem.arrItemId,
							{
								matchedRuleId: item.match.ruleId,
								action: ruleAction,
								scanMediaServerAfterDelete: item.match.scanMediaServerAfterDelete === true,
							},
							snapshot,
							cleanupRunClaimToken,
						);
					} else {
						await assertCurrentSeriesPostStepMutationAuthority(
							deps,
							userId,
							mutationInstance,
							item.cacheItem.arrItemId,
							{
								matchedRuleId: item.match.ruleId,
								action: ruleAction,
								scanMediaServerAfterDelete: item.match.scanMediaServerAfterDelete === true,
							},
							authorizedSeriesPolicy,
							evidence.seriesTransition,
							cleanupRunClaimToken,
						);
					}
				}
			};
			const mutationTarget = flaggedDeleteTarget(item);
			const assertMutationAuthority = withSharedPlexOwnershipRevalidation(
				deps,
				userId,
				mutationTarget,
				safetyPlan!,
				assertDirectExecutionAuthority,
			);
			let mutationAttempt = 0;
			const mutationAuditBoundary: MutationAuditBoundary = {
				prepare: async (step) => {
					mutationAttempt++;
					if (!cleanupAuditEnabled(prisma)) return;
					const auditPrepared = await runCleanupAuditBestEffort(
						() =>
							recordApprovalMutationBoundary(
								prisma,
								{
									approval: directAuditApproval,
									correlationId: directMutationExecutionToken,
									trigger: directAuditTrigger,
									actorId: deps.auditActorId,
									attempt: mutationAttempt,
									step,
								},
								log,
							),
						log,
						"direct cleanup mutation boundary preparation",
					);
					if (auditPrepared) directIdentity.auditPrepared = true;
				},
				attempted: () => {
					directIdentity.mutationAttempted = true;
				},
			};
			let directRescanApproval: LibraryCleanupApproval | null = null;
			if (
				item.match.scanMediaServerAfterDelete &&
				(ruleAction === "delete" || ruleAction === "delete_files")
			) {
				directRescanApproval = await prisma.libraryCleanupApproval.findFirst({
					where: {
						id: directMutationIntentId,
						config: { userId },
						status: "retry_executing",
						executionToken: directMutationExecutionToken,
					},
				});
				if (!directRescanApproval) {
					throw new Error("Cleanup could not load durable media-server scan intent state");
				}
				await prepareMediaServerRescans(
					deps,
					userId,
					directRescanApproval,
					rescanMediaType(item.cacheItem.itemType),
				);
			}

			if (ruleAction === "unmonitor") {
				await unmonitorInArr(
					arrClientFactory,
					mutationInstance,
					item.cacheItem.arrItemId,
					safetyPlan!,
					assertMutationAuthority,
					mutationAuditBoundary,
				);
				if (safetyPlan!.kind !== "verified_sonarr_episode")
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
				details.push(buildDetail(item, "unmonitored", undefined, directIdentity));
				unmonitored++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: unmonitored item in ARR instance",
				);
			} else if (ruleAction === "delete_files") {
				const deletedFiles = await withQuiPhysicalMutationGuard(
					userId,
					mutationTarget.respectQuiSeeding === true,
					() =>
						deleteFilesFromArr(
							arrClientFactory,
							mutationInstance,
							item.cacheItem.arrItemId,
							safetyPlan!,
							assertMutationAuthority,
							mutationAuditBoundary,
						),
				);
				await reconcileSonarrEpisodeFileCache(
					prisma,
					mutationInstance,
					item.cacheItem.arrItemId,
					log,
					safetyPlan!.kind === "verified_sonarr_episode"
						? safetyPlan!.selectedFile.episodeFileId
						: undefined,
				);
				if (safetyPlan!.kind !== "verified_sonarr_episode")
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
						? buildDetail(item, "files_deleted", undefined, directIdentity)
						: buildDetail(
								item,
								"skipped",
								"Reconciled because the verified ARR file set was already empty",
								directIdentity,
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
				await withQuiPhysicalMutationGuard(userId, mutationTarget.respectQuiSeeding === true, () =>
					deleteFromArr(
						arrClientFactory,
						mutationInstance,
						item.cacheItem.arrItemId,
						safetyPlan!,
						assertMutationAuthority,
						mutationAuditBoundary,
					),
				);
				await reconcileSonarrEpisodeFileCache(
					prisma,
					mutationInstance,
					item.cacheItem.arrItemId,
					log,
					safetyPlan!.kind === "verified_sonarr_episode"
						? safetyPlan!.selectedFile.episodeFileId
						: undefined,
				);
				if (safetyPlan!.kind !== "verified_sonarr_episode")
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
				details.push(buildDetail(item, "removed", undefined, directIdentity));
				removed++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: removed item from ARR instance",
				);
			}
			let directStateRecorded = true;
			await updateClaimedCleanupApproval(
				prisma,
				userId,
				directMutationIntentId,
				"retry_executing",
				directMutationExecutionToken,
				{
					status: "executed",
					executionToken: null,
					reconciledWithoutMutation: !directIdentity.mutationAttempted,
					executedAt: new Date(),
					lastExecutionError: null,
				},
			).catch((persistError) => {
				directStateRecorded = false;
				directIdentity.durableStateRecordingFailed = true;
				const recordedDetail = details.find((detail) => detail.actionId === directMutationIntentId);
				if (recordedDetail) {
					recordedDetail.durableStateRecordingFailed = true;
					recordedDetail.reason =
						"The upstream action completed, but its durable mutation intent status could not be confirmed.";
				}
				directRetryPersistenceFailures++;
				log.error(
					{ err: persistError, intentId: directMutationIntentId },
					"Cleanup action completed but its durable mutation intent was not finalized",
				);
			});
			if (directStateRecorded && directRescanApproval) {
				let scanCanStart = true;
				if (cleanupAuditEnabled(prisma)) {
					const outcomeAuditPersisted = await runCleanupAuditBestEffort(
						() =>
							recordApprovalExecutionOutcome(
								prisma,
								{
									approval: approvalRecordToAuditSnapshot({
										...directRescanApproval,
										status: "executed",
										executionToken: null,
										lastExecutionError: null,
									}),
									correlationId: directMutationExecutionToken,
									trigger: directAuditTrigger,
									actorId: deps.auditActorId,
									auditPrepared: directIdentity.auditPrepared,
									mutationAttempted: directIdentity.mutationAttempted,
									durableStateRecordingFailed: false,
								},
								log,
							),
						log,
						"direct cleanup outcome before media-server scan",
					);
					scanCanStart = outcomeAuditPersisted;
					if (outcomeAuditPersisted) {
						const marker = await prisma.libraryCleanupApproval
							.updateMany({
								where: {
									id: directMutationIntentId,
									config: { userId },
									status: "executed",
									terminalAuditRecordedAt: null,
								},
								data: { terminalAuditRecordedAt: new Date() },
							})
							.catch(() => ({ count: 0 }));
						if (marker.count !== 1) {
							const current = await prisma.libraryCleanupApproval.findFirst({
								where: {
									id: directMutationIntentId,
									config: { userId },
									status: "executed",
								},
								select: { terminalAuditRecordedAt: true },
							});
							scanCanStart = current?.terminalAuditRecordedAt != null;
						}
						const recordedDetail = details.find(
							(detail) => detail.actionId === directMutationIntentId,
						);
						if (recordedDetail) recordedDetail.auditOutcomeOwnedByExecution = true;
					}
				}
				if (scanCanStart) {
					mediaServerRescanApprovalIds.add(directMutationIntentId);
				} else {
					mediaServerRescanWarnings.push(
						"The ARR deletion completed, but its media-server scan was deferred until the terminal cleanup audit can be recorded.",
					);
				}
			}
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
			if (isProviderExecutionAuthorityFailure(error)) {
				providerAuthorityFailed = true;
			}
			if (error instanceof SonarrEpisodeUnmonitorPartialError) {
				partialArrDeletes++;
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
						},
					);
				} catch (retryError) {
					directRetryPersistenceFailures++;
					log.error(
						{
							err: retryError,
							title: item.cacheItem.title,
							instanceId: instance.id,
							arrItemId: item.cacheItem.arrItemId,
						},
						"Cleanup could not persist the partial episode unmonitor",
					);
				}
				details.push(buildDetail(item, "skipped", error.message, directIdentity));
				log.error(
					{ err: error, title: item.cacheItem.title, instanceId: instance.id },
					"Cleanup unmonitored the Sonarr episode but did not delete its file",
				);
				if (error.cause instanceof CleanupRunLeaseLostError) {
					throw error.cause;
				}
				continue;
			}
			if (error instanceof ArrDeletePartialError) {
				partialArrDeletes++;
				const deletedAnyVerifiedFiles = error.deletedFileIds.length > 0;
				if (deletedAnyVerifiedFiles) filesDeleted++;
				const postPartialRetrySnapshot = buildPostPartialRetrySnapshot(
					safetyPlan,
					error,
					item.match.action,
					directProviderEvidence,
				);
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
					buildDetail(
						item,
						deletedAnyVerifiedFiles ? "files_deleted" : "skipped",
						error.message,
						directIdentity,
					),
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
				details.push(buildDetail(item, "skipped", error.message, directIdentity));
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
			details.push(
				buildDetail(item, "skipped", `Action failed: ${getErrorMessage(error)}`, directIdentity),
			);
		}
	}

	if (mediaServerRescanApprovalIds.size > 0) {
		try {
			const scanResult = await triggerCoalescedMediaServerRescans(
				deps,
				userId,
				[...mediaServerRescanApprovalIds],
				assertRunLease,
			);
			mediaServerRescanWarnings.push(...scanResult.warnings);
		} catch (error) {
			mediaServerRescanWarnings.push(
				"The ARR deletion completed, but media-server scan follow-up could not be checked. It remains independently retryable.",
			);
			log.warn({ err: error }, "Cleanup media-server scan batch could not be checked");
		}
	}

	const allWarnings = withSharedPlexWarning(
		[...(warnings ?? []), ...new Set(mediaServerRescanWarnings)],
		runtimeSafetyBlocks,
	);
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
			"Durable record-only cleanup retries could not be loaded; no retry was attempted and fresh cleanup targets were deferred for safety.",
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
	if (directSelection.plan.counts.inFlight > 0) {
		allWarnings.push(
			`${directSelection.plan.counts.inFlight} ${
				directSelection.plan.counts.inFlight === 1 ? "item was" : "items were"
			} already executing in another cleanup run.`,
		);
	}
	if (directSelection.plan.counts.deferredInFlightTarget > 0) {
		allWarnings.push(
			`${directSelection.plan.counts.deferredInFlightTarget} pending cleanup ${
				directSelection.plan.counts.deferredInFlightTarget === 1 ? "retry was" : "retries were"
			} deferred because an in-flight retry already owns the same target.`,
		);
	}
	if (directSelection.plan.counts.deferredDuplicateTarget > 0) {
		allWarnings.push(
			`${directSelection.plan.counts.deferredDuplicateTarget} duplicate cleanup ${
				directSelection.plan.counts.deferredDuplicateTarget === 1
					? "candidate was"
					: "candidates were"
			} deferred because another candidate owns the same target.`,
		);
	}
	const hasWarnings = allWarnings.length > 0;
	const directlyEvaluated = freshItems.length;
	const directRemoved = removed - retriedRemoved;
	const directUnmonitored = unmonitored - retriedUnmonitored;
	const directFilesDeleted = filesDeleted - retriedFilesDeleted;
	const unsuccessfulRetries = directRetryFailures + directRetryExpired + directRetryConcurrent;
	const accountedUnsuccessfulRetries = unsuccessfulRetries + directRetryExecutionFailures;
	const boundedDetails = [
		...details.slice(deferredSelectionDetailCount),
		...details.slice(0, deferredSelectionDetailCount),
	].slice(0, CLEANUP_DETAIL_LIMIT);

	const result: CleanupRunResult = {
		isDryRun: false,
		status: circuitBroken || hasWarnings ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: totalFlaggedBeforeLimit,
		itemsRemoved: removed,
		itemsUnmonitored: unmonitored,
		itemsFilesDeleted: filesDeleted,
		itemsSkipped:
			totalFlaggedBeforeLimit -
			flagged.length +
			budgetDeferredItems +
			directSelection.plan.counts.inFlight +
			directSelection.plan.counts.deferredInFlightTarget +
			directSelection.plan.counts.deferredDuplicateTarget +
			directSelection.plan.counts.retryStateUnavailable +
			directRetryFairnessDeferred +
			(directlyEvaluated - directRemoved - directUnmonitored - directFilesDeleted) +
			accountedUnsuccessfulRetries +
			directRetryReconciled,
		details: boundedDetails,
		durationMs: Date.now() - startTime,
		prefetchHealth,
		warnings: allWarnings.length > 0 ? allWarnings : undefined,
	};

	await createRunLog(deps, config.id, result);
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

interface MutationAuditBoundary {
	/** Persist best-effort evidence before any final mutable authority reads. */
	prepare(step: string): Promise<void>;
	/** Mark the exact point immediately before the upstream mutation call. */
	attempted(step: string): void;
}

async function deleteVerifiedRadarrFile(
	radarr: InstanceType<typeof RadarrClient>,
	arrItemId: number,
	expectedTarget: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_radarr" }>["target"],
	expected: VerifiedRadarrFileIdentity,
	assertMutationAuthority?: MutationAuthorityCheck,
	mutationAudit?: MutationAuditBoundary,
): Promise<void> {
	const step = "radarr_movie_file_delete";
	await mutationAudit?.prepare(step);
	await assertVerifiedRadarrFileUnchanged(radarr, arrItemId, expectedTarget, expected);
	let deleteError: unknown;
	try {
		await assertMutationAuthority?.({ seriesTransition: "unchanged" });
		mutationAudit?.attempted(step);
		await radarr.movieFile.delete(expected.movieFileId);
	} catch (error) {
		if (isProviderExecutionAuthorityFailure(error)) throw error;
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
	assertMutationAuthority?: MutationAuthorityCheck,
	mutationAudit?: MutationAuditBoundary,
): Promise<void> {
	let lastDeleteError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		const step = "radarr_movie_record_delete";
		await mutationAudit?.prepare(step);
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
			await assertMutationAuthority?.({
				seriesTransition: deletedFileIds.length > 0 ? "all_files_deleted" : "unchanged",
			});
			mutationAudit?.attempted(step);
			await radarr.movie.delete(arrItemId, {
				deleteFiles: false,
				addImportExclusion: false,
			});
			return;
		} catch (error) {
			if (isProviderExecutionAuthorityFailure(error)) {
				if (deletedFileIds.length === 0) throw error;
				throw new ArrDeletePartialError({
					cause: error,
					service: "RADARR",
					deletedFileIds,
					hasRemainingFiles: false,
					message:
						"Partial cleanup: the verified Radarr movie file was deleted, but provider authority changed before the movie record could be removed.",
				});
			}
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
	assertMutationAuthority?: MutationAuthorityCheck,
	mutationAudit?: MutationAuditBoundary,
): Promise<number[]> {
	const expectedIds = expected.episodeFiles.map((file) => file.episodeFileId);
	if (expectedIds.length === 0) return [];
	const step = "sonarr_episode_files_bulk_delete";
	await mutationAudit?.prepare(step);
	await assertVerifiedSonarrFilesUnchanged(sonarr, arrItemId, expectedTarget, expected);

	let bulkError: unknown;
	try {
		await assertMutationAuthority?.({ seriesTransition: "unchanged" });
		mutationAudit?.attempted(step);
		await sonarr.episodeFile.bulkDelete(expectedIds);
	} catch (error) {
		if (isProviderExecutionAuthorityFailure(error)) throw error;
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

async function deleteVerifiedSonarrEpisodeFile(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	plan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr_episode" }>,
	assertMutationAuthority?: MutationAuthorityCheck,
	mutationAudit?: MutationAuditBoundary,
	monitoredMode: "exact" | "require_unmonitored" = "exact",
): Promise<void> {
	const step = "sonarr_episode_file_delete";
	await mutationAudit?.prepare(step);
	await assertVerifiedSonarrEpisodeUnchanged(sonarr, arrItemId, plan, {
		monitoredMode,
	});
	await assertMutationAuthority?.();
	let bulkError: unknown;
	try {
		mutationAudit?.attempted(step);
		await sonarr.episodeFile.bulkDelete([plan.selectedFile.episodeFileId]);
	} catch (error) {
		bulkError = error;
	}

	let remaining: Awaited<ReturnType<typeof sonarr.episodeFile.getBySeries>>;
	try {
		remaining = await sonarr.episodeFile.getBySeries(arrItemId);
	} catch (verificationError) {
		throw new ArrDeletePartialError({
			cause: bulkError ?? verificationError,
			service: "SONARR",
			deletedFileIds: [],
			hasRemainingFiles: true,
			remainingSize: sonarrFileSetSize([plan.selectedFile, ...plan.retainedTargetFiles]),
			message:
				monitoredMode === "require_unmonitored"
					? "Partial cleanup: Sonarr's selected episode-file deletion outcome could not be verified. The episode remains unmonitored and the mutation will be retried safely."
					: "Partial cleanup: Sonarr's selected episode-file deletion outcome could not be verified. The selected file may already be deleted, and the mutation will be retried safely.",
		});
	}
	const selectedFileRemains = remaining.some((file) => file.id === plan.selectedFile.episodeFileId);
	if (selectedFileRemains) {
		if (bulkError) throw bulkError;
		throw new Error("Sonarr did not delete the verified episode file");
	}
	const expectedRetainedIds = new Set(plan.retainedTargetFiles.map((file) => file.episodeFileId));
	const currentRetainedIds = new Set(
		remaining.map((file) => file.id).filter((id): id is number => typeof id === "number"),
	);
	if (
		expectedRetainedIds.size !== currentRetainedIds.size ||
		[...expectedRetainedIds].some((id) => !currentRetainedIds.has(id))
	) {
		const remainingSize = sonarrFileSetSize(remaining);
		throw new ArrDeletePartialError({
			cause: new SonarrFilesChangedDuringSafetyCheckError(),
			service: "SONARR",
			deletedFileIds: [plan.selectedFile.episodeFileId],
			hasRemainingFiles: remaining.length > 0,
			remainingSize,
			message:
				"Partial cleanup: the selected Sonarr episode file was deleted, but the retained series inventory changed.",
		});
	}
	if (bulkError) {
		throw new ArrDeletePartialError({
			cause: bulkError,
			service: "SONARR",
			deletedFileIds: [plan.selectedFile.episodeFileId],
			hasRemainingFiles: remaining.length > 0,
			remainingSize: sonarrFileSetSize(remaining),
			message:
				"Partial cleanup: Sonarr deleted the selected episode file, but its response was lost. The confirmed deletion was recorded and will be reconciled safely.",
		});
	}
}

async function deleteSonarrRecordWithoutFiles(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	expectedTarget: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }>["target"],
	expected: VerifiedSonarrFileIdentity,
	deletedFileIds: number[],
	assertMutationAuthority?: MutationAuthorityCheck,
	mutationAudit?: MutationAuditBoundary,
): Promise<void> {
	let lastDeleteError: unknown;
	const emptyExpected: VerifiedSonarrFileIdentity = {
		seriesPath: expected.seriesPath,
		episodeFiles: [],
	};

	for (let attempt = 0; attempt < 2; attempt++) {
		const step = "sonarr_series_record_delete";
		await mutationAudit?.prepare(step);
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
			await assertMutationAuthority?.({
				seriesTransition: deletedFileIds.length > 0 ? "all_files_deleted" : "unchanged",
			});
			mutationAudit?.attempted(step);
			await sonarr.series.delete(arrItemId, {
				deleteFiles: false,
				addImportListExclusion: false,
			});
			return;
		} catch (error) {
			if (isProviderExecutionAuthorityFailure(error)) {
				if (deletedFileIds.length === 0) throw error;
				throw new ArrDeletePartialError({
					cause: error,
					service: "SONARR",
					deletedFileIds,
					hasRemainingFiles: false,
					message:
						"Partial cleanup: the verified Sonarr episode files were deleted, but provider authority changed before the series record could be removed.",
				});
			}
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
	episodeFileId?: number,
): Promise<void> {
	if (instance.service !== "SONARR") return;
	await prisma.episodeFileCache
		.deleteMany({
			where: {
				instanceId: instance.id,
				arrSeriesId: arrItemId,
				...(episodeFileId ? { arrEpisodeFileId: episodeFileId } : {}),
			},
		})
		.catch((error) => {
			log.error(
				{ err: error, instanceId: instance.id, arrItemId },
				"Cleanup Sonarr action succeeded but episode-file cache reconciliation failed",
			);
		});
	if (episodeFileId) {
		const remaining = await prisma.episodeFileCache.findMany({
			where: { instanceId: instance.id, arrSeriesId: arrItemId },
			select: { size: true },
		});
		const sizeOnDisk = remaining.reduce((sum, file) => sum + file.size, 0n);
		await prisma.libraryCache
			.updateMany({
				where: {
					instanceId: instance.id,
					arrItemId,
					itemType: "series",
				},
				data: { hasFile: remaining.length > 0, sizeOnDisk },
			})
			.catch((error) => {
				log.error(
					{ err: error, instanceId: instance.id, arrItemId },
					"Cleanup episode action succeeded but parent series cache reconciliation failed",
				);
			});
	}
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

async function sonarrEpisodeRemainsUnmonitored(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	plan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr_episode" }>,
): Promise<boolean | null> {
	try {
		const episodes = (await sonarr.episode.getAll({
			seriesId: arrItemId,
			includeEpisodeFile: true,
		})) as unknown as Array<Record<string, unknown>>;
		const episode = episodes.find((candidate) => candidate.id === plan.episode.arrEpisodeId);
		if (
			!episode ||
			episode.seasonNumber !== plan.episode.seasonNumber ||
			episode.episodeNumber !== plan.episode.episodeNumber
		) {
			return false;
		}
		if (typeof episode.monitored !== "boolean") return null;
		return episode.monitored === false;
	} catch {
		return null;
	}
}

/**
 * Delete an item from an ARR instance via the SDK client.
 */
async function deleteFromArr(
	arrClientFactory: CleanupExecutorDeps["arrClientFactory"],
	instance: ServiceInstance,
	arrItemId: number,
	safetyPlan: SharedMediaSafetyPlan,
	assertMutationAuthority?: MutationAuthorityCheck,
	mutationAudit?: MutationAuditBoundary,
): Promise<void> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_sonarr" || safetyPlan.kind === "verified_sonarr_episode") {
				throw new Error("Sonarr safety plan cannot authorize a Radarr mutation");
			}
			if (safetyPlan.kind === "verified_radarr") {
				await deleteVerifiedRadarrFile(
					radarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.file,
					assertMutationAuthority,
					mutationAudit,
				);
				await deleteRadarrRecordWithoutFiles(
					radarr,
					arrItemId,
					safetyPlan.target,
					[safetyPlan.file.movieFileId],
					assertMutationAuthority,
					mutationAudit,
				);
			} else if (safetyPlan.kind === "verified_radarr_empty") {
				await deleteRadarrRecordWithoutFiles(
					radarr,
					arrItemId,
					safetyPlan.target,
					[],
					assertMutationAuthority,
					mutationAudit,
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
			if (safetyPlan.kind === "verified_sonarr_episode") {
				const step = "sonarr_episode_unmonitor";
				await mutationAudit?.prepare(step);
				await assertVerifiedSonarrEpisodeUnchanged(sonarr, arrItemId, safetyPlan, {
					monitoredMode: "allow_unmonitored",
				});
				await assertMutationAuthority?.();
				mutationAudit?.attempted(step);
				try {
					await sonarr.episode.setMonitored([safetyPlan.episode.arrEpisodeId], false);
				} catch (error) {
					const unmonitored = await sonarrEpisodeRemainsUnmonitored(sonarr, arrItemId, safetyPlan);
					if (unmonitored === false) throw error;
					if (unmonitored === null) {
						throw new SonarrEpisodeUnmonitorOutcomeUnknownError(error);
					}
				}
				try {
					await deleteVerifiedSonarrEpisodeFile(
						sonarr,
						arrItemId,
						safetyPlan,
						assertMutationAuthority,
						mutationAudit,
						"require_unmonitored",
					);
				} catch (error) {
					if (error instanceof ArrDeletePartialError) throw error;
					if ((await sonarrEpisodeRemainsUnmonitored(sonarr, arrItemId, safetyPlan)) === false) {
						throw error;
					}
					throw new SonarrEpisodeUnmonitorPartialError(error);
				}
			} else if (safetyPlan.kind === "verified_sonarr") {
				const deletedFileIds = await deleteVerifiedSonarrFiles(
					sonarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.files,
					assertMutationAuthority,
					mutationAudit,
				);
				await deleteSonarrRecordWithoutFiles(
					sonarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.files,
					deletedFileIds,
					assertMutationAuthority,
					mutationAudit,
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
	assertMutationAuthority?: MutationAuthorityCheck,
	mutationAudit?: MutationAuditBoundary,
): Promise<void> {
	if (safetyPlan.kind !== "verified_arr_target" && safetyPlan.kind !== "verified_sonarr_episode") {
		throw new Error("A verified ARR target identity is required before unmonitoring");
	}
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			const step = "radarr_movie_unmonitor";
			await mutationAudit?.prepare(step);
			const movie = await radarr.movie.getById(arrItemId);
			assertVerifiedArrTargetUnchanged(instance, movie.tmdbId, movie.path, safetyPlan.target);
			await assertMutationAuthority?.({ seriesTransition: "unchanged" });
			mutationAudit?.attempted(step);
			try {
				await radarr.movie.update(arrItemId, { ...movie, id: arrItemId, monitored: false });
			} catch (error) {
				let current: Awaited<ReturnType<typeof radarr.movie.getById>>;
				try {
					current = await radarr.movie.getById(arrItemId);
				} catch {
					throw error;
				}
				assertVerifiedArrTargetUnchanged(instance, current.tmdbId, current.path, safetyPlan.target);
				if (current.monitored !== false) throw error;
			}
			break;
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			if (safetyPlan.kind === "verified_sonarr_episode") {
				const step = "sonarr_episode_unmonitor";
				await mutationAudit?.prepare(step);
				await assertVerifiedSonarrEpisodeUnchanged(sonarr, arrItemId, safetyPlan, {
					monitoredMode: "allow_unmonitored",
				});
				await assertMutationAuthority?.();
				mutationAudit?.attempted(step);
				try {
					await sonarr.episode.setMonitored([safetyPlan.episode.arrEpisodeId], false);
				} catch (error) {
					const unmonitored = await sonarrEpisodeRemainsUnmonitored(sonarr, arrItemId, safetyPlan);
					if (unmonitored === false) throw error;
					if (unmonitored === null) {
						throw new SonarrEpisodeUnmonitorOutcomeUnknownError(error);
					}
				}
				break;
			}
			const step = "sonarr_series_unmonitor";
			await mutationAudit?.prepare(step);
			const series = await sonarr.series.getById(arrItemId);
			assertVerifiedArrTargetUnchanged(instance, series.tvdbId, series.path, safetyPlan.target);
			await assertMutationAuthority?.({ seriesTransition: "unchanged" });
			mutationAudit?.attempted(step);
			try {
				await sonarr.series.update(arrItemId, {
					...series,
					id: arrItemId,
					monitored: false,
				} as Parameters<typeof sonarr.series.update>[1]);
			} catch (error) {
				let current: Awaited<ReturnType<typeof sonarr.series.getById>>;
				try {
					current = await sonarr.series.getById(arrItemId);
				} catch {
					throw error;
				}
				assertVerifiedArrTargetUnchanged(instance, current.tvdbId, current.path, safetyPlan.target);
				if (current.monitored !== false) throw error;
			}
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
	assertMutationAuthority?: MutationAuthorityCheck,
	mutationAudit?: MutationAuditBoundary,
): Promise<boolean> {
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			if (safetyPlan.kind === "blocked") throw new Error(safetyPlan.reason);
			if (safetyPlan.kind === "verified_sonarr" || safetyPlan.kind === "verified_sonarr_episode") {
				throw new Error("Sonarr safety plan cannot authorize a Radarr mutation");
			}
			if (safetyPlan.kind === "verified_radarr") {
				await deleteVerifiedRadarrFile(
					radarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.file,
					assertMutationAuthority,
					mutationAudit,
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
			if (safetyPlan.kind === "verified_sonarr_episode") {
				await deleteVerifiedSonarrEpisodeFile(
					sonarr,
					arrItemId,
					safetyPlan,
					assertMutationAuthority,
					mutationAudit,
				);
				return true;
			}
			if (safetyPlan.kind === "verified_sonarr") {
				await deleteVerifiedSonarrFiles(
					sonarr,
					arrItemId,
					safetyPlan.target,
					safetyPlan.files,
					assertMutationAuthority,
					mutationAudit,
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
function evidenceFingerprint(value: unknown): string {
	const canonicalize = (input: unknown): unknown => {
		if (input instanceof Date) return input.toISOString();
		if (input instanceof Map) {
			return [...input.entries()]
				.map(([key, entry]) => [String(key), canonicalize(entry)])
				.sort(([left], [right]) => String(left).localeCompare(String(right)));
		}
		if (input instanceof Set) {
			return [...input]
				.map(canonicalize)
				.sort((left, right) => String(left).localeCompare(String(right)));
		}
		if (Array.isArray(input)) return input.map(canonicalize);
		if (typeof input === "object" && input !== null) {
			return Object.fromEntries(
				Object.entries(input as Record<string, unknown>)
					.sort(([left], [right]) => left.localeCompare(right))
					.map(([key, entry]) => [key, canonicalize(entry)]),
			);
		}
		return input;
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(value)))
		.digest("hex");
}

function mutationConfigFingerprint(config: {
	id: string;
	enabled: boolean;
	dryRunMode: boolean;
	requireApproval: boolean;
	maxRemovalsPerRun: number;
	respectQuiSeeding: boolean;
}): string {
	return evidenceFingerprint({
		id: config.id,
		enabled: config.enabled,
		dryRunMode: config.dryRunMode,
		requireApproval: config.requireApproval,
		maxRemovalsPerRun: config.maxRemovalsPerRun,
		respectQuiSeeding: config.respectQuiSeeding,
	});
}

function completeMutationConfigFingerprint(config: {
	id?: unknown;
	enabled?: unknown;
	dryRunMode?: unknown;
	requireApproval?: unknown;
	maxRemovalsPerRun?: unknown;
	respectQuiSeeding?: unknown;
}): string | undefined {
	if (
		typeof config.id !== "string" ||
		typeof config.enabled !== "boolean" ||
		typeof config.dryRunMode !== "boolean" ||
		typeof config.requireApproval !== "boolean" ||
		typeof config.respectQuiSeeding !== "boolean" ||
		!Number.isSafeInteger(config.maxRemovalsPerRun)
	) {
		return undefined;
	}
	return mutationConfigFingerprint(config as Parameters<typeof mutationConfigFingerprint>[0]);
}

function providerTopologyFingerprint(instances: ServiceInstance[]): string {
	return evidenceFingerprint(
		instances.map((instance) => ({
			id: instance.id,
			service: instance.service,
			baseUrl: instance.baseUrl,
			enabled: instance.enabled,
			connectionGeneration: instance.connectionGeneration,
			encryptedApiKey: instance.encryptedApiKey,
			encryptionIv: instance.encryptionIv,
			encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
			httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
			updatedAt: instance.updatedAt,
		})),
	);
}

async function loadProviderInstances(
	deps: CleanupExecutorDeps,
	userId: string,
	services: ServiceInstance["service"][],
): Promise<ServiceInstance[]> {
	return await deps.prisma.serviceInstance.findMany({
		where: { userId, service: { in: services }, enabled: true },
		orderBy: { id: "asc" },
	});
}

interface PlexPolicyEvidence {
	plexMap: PlexWatchMap;
	plexSectionTitles: Set<string>;
	completedAt: Date;
	generationFingerprint: string;
}

interface PublishedPlexPolicyEvidence extends PlexPolicyEvidence {
	generationIdsByInstance: Map<string, string>;
}

function parsePublishedPlexSections(metadata: string | null): Array<{
	key: string;
	title: string;
	type: "movie" | "show";
}> | null {
	const parsed = safeJsonParse(metadata);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
	const sections = (parsed as Record<string, unknown>).sections;
	if (!Array.isArray(sections)) return null;
	const normalized: Array<{ key: string; title: string; type: "movie" | "show" }> = [];
	for (const section of sections) {
		if (typeof section !== "object" || section === null || Array.isArray(section)) return null;
		const row = section as Record<string, unknown>;
		if (
			typeof row.key !== "string" ||
			row.key.length === 0 ||
			typeof row.title !== "string" ||
			row.title.length === 0 ||
			(row.type !== "movie" && row.type !== "show")
		) {
			return null;
		}
		normalized.push({ key: row.key, title: row.title, type: row.type });
	}
	return normalized.sort(
		(left, right) =>
			left.key.localeCompare(right.key) ||
			left.title.localeCompare(right.title) ||
			left.type.localeCompare(right.type),
	);
}

/**
 * Load watch rows and section selectors from one published Plex generation.
 * Status is read before and after the rows so a concurrent atomic refresh can
 * never splice a new section inventory onto an older watch map.
 */
async function loadPublishedPlexPolicyEvidenceUnsafe(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{ enabled: boolean; plexLibraryFilter?: string | null }>,
): Promise<PublishedPlexPolicyEvidence | undefined> {
	const instances = await loadProviderInstances(deps, userId, ["PLEX"]);
	if (instances.length === 0) return undefined;
	const instanceIds = instances.map((instance) => instance.id);
	const readStatuses = async () =>
		await deps.prisma.cacheRefreshStatus.findMany({
			where: { instanceId: { in: instanceIds }, cacheType: "plex" },
			orderBy: { instanceId: "asc" },
			select: {
				instanceId: true,
				lastRefreshedAt: true,
				lastResult: true,
				itemCount: true,
				generationId: true,
				generationMetadata: true,
				lastErrorMessage: true,
				lastAttemptResult: true,
				lastAttemptErrorMessage: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
		});
	const before = await readStatuses();
	if (
		before.length !== instances.length ||
		before.some((status) => {
			const instance = instances.find((candidate) => candidate.id === status.instanceId);
			return (
				!instance ||
				!isVerifiedProviderCacheSource(instance) ||
				status.lastResult !== "success" ||
				status.lastErrorMessage != null ||
				status.lastAttemptErrorMessage != null ||
				(status.lastAttemptResult != null && status.lastAttemptResult !== "success") ||
				!status.generationId ||
				!status.generationMetadata ||
				Date.now() - status.lastRefreshedAt.getTime() > PROVIDER_EVIDENCE_FRESHNESS_MS ||
				status.lastRefreshedAt.getTime() < instance.updatedAt.getTime() ||
				status.lastRefreshedAt.getTime() < instance.identityVerifiedAt!.getTime() ||
				status.connectionGeneration === null ||
				status.identityGeneration === null ||
				status.connectionGeneration !== instance.connectionGeneration ||
				status.identityGeneration !== instance.identityGeneration
			);
		})
	) {
		return undefined;
	}

	const sectionTitles = new Set<string>();
	for (const status of before) {
		const sections = parsePublishedPlexSections(status.generationMetadata);
		if (!sections || sections.length === 0) return undefined;
		for (const section of sections) sectionTitles.add(section.title);
		const count = await deps.prisma.plexCache.count({ where: { instanceId: status.instanceId } });
		if (count !== status.itemCount) return undefined;
	}
	const configuredTitles = collectConfiguredPlexSectionTitles(rules);
	for (const title of configuredTitles) {
		if (!sectionTitles.has(title)) return undefined;
	}

	const plexMap = await prefetchPlexData(deps, userId);
	if (!plexMap) return undefined;
	const after = await readStatuses();
	if (evidenceFingerprint(before) !== evidenceFingerprint(after)) return undefined;
	return {
		plexMap,
		plexSectionTitles: sectionTitles,
		completedAt: new Date(Math.min(...before.map((status) => status.lastRefreshedAt.getTime()))),
		generationFingerprint: evidenceFingerprint(before),
		generationIdsByInstance: new Map(
			before.map((status) => [status.instanceId, status.generationId!]),
		),
	};
}

async function loadPublishedPlexPolicyEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{ enabled: boolean; plexLibraryFilter?: string | null }>,
): Promise<PublishedPlexPolicyEvidence | undefined> {
	try {
		return await loadPublishedPlexPolicyEvidenceUnsafe(deps, userId, rules);
	} catch (error) {
		deps.log.warn({ err: error }, "Published Plex policy evidence was unavailable");
		return undefined;
	}
}

function sortProviderRows<T extends { instanceId: string; mediaType: string; tmdbId: number }>(
	rows: T[],
): T[] {
	const detailKey = (row: T): string => {
		if ("sectionId" in row && typeof row.sectionId === "string") return row.sectionId;
		if ("libraryId" in row && typeof row.libraryId === "string") return row.libraryId;
		return "";
	};
	return [...rows].sort(
		(left, right) =>
			left.instanceId.localeCompare(right.instanceId) ||
			left.mediaType.localeCompare(right.mediaType) ||
			left.tmdbId - right.tmdbId ||
			detailKey(left).localeCompare(detailKey(right)) ||
			evidenceFingerprint(left).localeCompare(evidenceFingerprint(right)),
	);
}

async function _collectLivePlexPolicyEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{ enabled: boolean; plexLibraryFilter?: string | null }>,
): Promise<PlexPolicyEvidence | undefined> {
	try {
		const initial = await loadProviderInstances(deps, userId, ["PLEX"]);
		if (initial.length === 0) return undefined;
		const topology = providerTopologyFingerprint(initial);
		let accepted:
			| {
					plexMap: PlexWatchMap;
					plexSectionTitles: Set<string>;
					fingerprint: string;
					completedAt: Date;
			  }
			| undefined;
		for (let pass = 0; pass < 2; pass++) {
			const rows: PlexCacheSnapshotRow[] = [];
			const sections = new Set<string>();
			const completions: Date[] = [];
			for (const instance of initial) {
				const client =
					deps.plexCacheClientFactory?.(instance) ??
					(deps.encryptor ? createPlexClient(deps.encryptor, instance, deps.log) : null);
				if (!client) throw new Error("Plex credentials were unavailable");
				const collected = await collectPlexCacheLiveEvidence(client, instance.id, deps.log);
				if (
					collected.errors > 0 ||
					collected.complete !== true ||
					!collected.completedAt ||
					!collected.snapshot
				) {
					throw new Error("Plex live evidence collection was incomplete");
				}
				rows.push(...collected.snapshot.rows);
				for (const section of collected.snapshot.sections) sections.add(section.title);
				completions.push(collected.completedAt);
			}
			const after = await loadProviderInstances(deps, userId, ["PLEX"]);
			if (providerTopologyFingerprint(after) !== topology) {
				throw new Error("Plex topology changed during live evidence collection");
			}
			for (const title of collectConfiguredPlexSectionTitles(rules)) {
				if (!sections.has(title)) throw new Error(`Plex library ${title} was unavailable`);
			}
			const sortedRows = sortProviderRows(rows);
			const fingerprint = evidenceFingerprint([topology, sortedRows, sections]);
			if (accepted && accepted.fingerprint !== fingerprint) {
				throw new Error("Plex evidence changed between verification passes");
			}
			accepted = {
				plexMap: plexSnapshotToWatchMap(sortedRows),
				plexSectionTitles: sections,
				fingerprint,
				completedAt: new Date(Math.min(...completions.map((date) => date.getTime()))),
			};
		}
		return accepted
			? {
					plexMap: accepted.plexMap,
					plexSectionTitles: accepted.plexSectionTitles,
					completedAt: accepted.completedAt,
					generationFingerprint: accepted.fingerprint,
				}
			: undefined;
	} catch (error) {
		deps.log.warn({ err: error }, "Live read-only Plex policy evidence failed closed");
		return undefined;
	}
}

async function _collectLiveTautulliPolicyEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<TautulliWatchMap | undefined> {
	try {
		const initial = await loadProviderInstances(deps, userId, ["TAUTULLI"]);
		if (initial.length === 0) return undefined;
		const topology = providerTopologyFingerprint(initial);
		let accepted: { map: TautulliWatchMap; fingerprint: string } | undefined;
		for (let pass = 0; pass < 2; pass++) {
			const rows: TautulliCacheSnapshotRow[] = [];
			for (const instance of initial) {
				const client =
					deps.tautulliCacheClientFactory?.(instance) ??
					(deps.encryptor ? createTautulliClient(deps.encryptor, instance, deps.log) : null);
				if (!client) throw new Error("Tautulli credentials were unavailable");
				const collected = await collectTautulliCacheLiveEvidence(client, instance.id, deps.log);
				if (collected.errors > 0 || collected.complete !== true || !collected.snapshot) {
					throw new Error("Tautulli live evidence collection was incomplete");
				}
				rows.push(...collected.snapshot.rows);
			}
			const after = await loadProviderInstances(deps, userId, ["TAUTULLI"]);
			if (providerTopologyFingerprint(after) !== topology) {
				throw new Error("Tautulli topology changed during live evidence collection");
			}
			const sortedRows = sortProviderRows(rows);
			const fingerprint = evidenceFingerprint([topology, sortedRows]);
			if (accepted && accepted.fingerprint !== fingerprint) {
				throw new Error("Tautulli evidence changed between verification passes");
			}
			accepted = { map: tautulliSnapshotToWatchMap(sortedRows), fingerprint };
		}
		return accepted?.map;
	} catch (error) {
		deps.log.warn({ err: error }, "Live read-only Tautulli policy evidence failed closed");
		return undefined;
	}
}

async function _collectLiveJellyfinPolicyEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<JellyfinWatchMap | undefined> {
	try {
		const initial = await loadProviderInstances(deps, userId, ["JELLYFIN", "EMBY"]);
		if (initial.length === 0) return undefined;
		const topology = providerTopologyFingerprint(initial);
		let accepted: { map: JellyfinWatchMap; fingerprint: string } | undefined;
		for (let pass = 0; pass < 2; pass++) {
			const rows: JellyfinCacheSnapshotRow[] = [];
			const coverage: Array<{
				instanceId: string;
				users: Array<{ id: string; name: string }>;
				libraries: Array<{
					userId: string;
					libraryId: string;
					libraryName: string;
					collectionType: string;
				}>;
			}> = [];
			for (const instance of initial) {
				const client =
					deps.jellyfinCacheClientFactory?.(instance) ??
					(deps.encryptor ? createJellyfinClient(deps.encryptor, instance, deps.log) : null);
				if (!client) throw new Error("Jellyfin credentials were unavailable");
				const collected = await collectJellyfinCacheLiveEvidence(client, instance.id, deps.log);
				if (
					collected.errors > 0 ||
					collected.complete !== true ||
					!collected.snapshot ||
					!Array.isArray(collected.snapshot.users) ||
					!Array.isArray(collected.snapshot.libraries)
				) {
					throw new Error("Jellyfin live evidence collection was incomplete");
				}
				rows.push(...collected.snapshot.rows);
				coverage.push({
					instanceId: instance.id,
					users: collected.snapshot.users,
					libraries: collected.snapshot.libraries,
				});
			}
			const after = await loadProviderInstances(deps, userId, ["JELLYFIN", "EMBY"]);
			if (providerTopologyFingerprint(after) !== topology) {
				throw new Error("Jellyfin topology changed during live evidence collection");
			}
			const sortedRows = sortProviderRows(rows);
			const fingerprint = evidenceFingerprint([topology, sortedRows, coverage]);
			if (accepted && accepted.fingerprint !== fingerprint) {
				throw new Error("Jellyfin evidence changed between verification passes");
			}
			accepted = { map: jellyfinSnapshotToWatchMap(sortedRows), fingerprint };
		}
		return accepted?.map;
	} catch (error) {
		deps.log.warn({ err: error }, "Live read-only Jellyfin policy evidence failed closed");
		return undefined;
	}
}

async function refreshPlexMutationEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	includeEpisodes: boolean,
	rules: Array<{ enabled: boolean; plexLibraryFilter?: string | null }>,
	cleanupRunClaimToken?: string,
): Promise<
	| {
			plexMap: PlexWatchMap;
			plexSectionTitles: Set<string>;
			ratingKeysByInstance: PlexTargetRatingKeysByInstance;
			plexEpisodeMap?: PlexEpisodeMap;
			completedAt: Date;
			topologyFingerprint: string;
	  }
	| undefined
> {
	try {
		const initial = await loadProviderInstances(deps, userId, ["PLEX"]);
		if (initial.length === 0) return undefined;
		const topology = providerTopologyFingerprint(initial);
		let accepted:
			| {
					plexMap: PlexWatchMap;
					plexSectionTitles: Set<string>;
					ratingKeysByInstance: PlexTargetRatingKeysByInstance;
					plexEpisodeMap?: PlexEpisodeMap;
					fingerprint: string;
					completedAt: Date;
			  }
			| undefined;
		for (let pass = 0; pass < 2; pass++) {
			const passCompletions: Date[] = [];
			const generationIdsByInstance = new Map<string, string>();
			const ratingKeysByInstance: PlexTargetRatingKeysByInstance = new Map(
				initial.map((instance) => [instance.id, new Map<string, Set<string>>()]),
			);
			for (const instance of initial) {
				if (!deps.encryptor) throw new Error("Plex credentials were unavailable");
				const publicationInstance = createOwnedPlexPublicationSnapshot(deps.encryptor, instance);
				const refreshed = await refreshPlexCache({
					prisma: deps.prisma,
					instance: publicationInstance,
					log: deps.log,
					cleanupRunClaimToken,
				});
				if (refreshed.errors > 0 || refreshed.complete !== true) {
					throw new Error("Plex cache refresh was incomplete");
				}
				if (!refreshed.completedAt || !refreshed.generationId || !refreshed.inventoryTargets) {
					throw new Error("Plex refresh lacked complete inventory identity evidence");
				}
				passCompletions.push(refreshed.completedAt);
				generationIdsByInstance.set(instance.id, refreshed.generationId);
				const instanceTargets = ratingKeysByInstance.get(instance.id)!;
				for (const target of refreshed.inventoryTargets) {
					for (const targetKey of plexInventoryTargetKeys(target)) {
						let ratingKeys = instanceTargets.get(targetKey);
						if (!ratingKeys) {
							ratingKeys = new Set<string>();
							instanceTargets.set(targetKey, ratingKeys);
						}
						ratingKeys.add(target.ratingKey);
					}
				}
				if (includeEpisodes) {
					const episodes = await refreshPlexEpisodeCache({
						prisma: deps.prisma,
						instance: publicationInstance,
						log: deps.log,
						cleanupRunClaimToken,
					});
					if (episodes.errors > 0 || episodes.complete !== true) {
						throw new Error("Plex episode evidence refresh was incomplete");
					}
					if (!episodes.completedAt) {
						throw new Error("Plex episode refresh lacked a completion timestamp");
					}
					passCompletions.push(episodes.completedAt);
				}
			}
			const after = await loadProviderInstances(deps, userId, ["PLEX"]);
			if (providerTopologyFingerprint(after) !== topology) {
				throw new Error("Plex topology changed during policy revalidation");
			}
			const publishedPlex = await loadPublishedPlexPolicyEvidence(deps, userId, rules);
			const plexEpisodeMap = includeEpisodes
				? await prefetchPlexEpisodeData(deps, userId)
				: undefined;
			if (!publishedPlex || (includeEpisodes && !plexEpisodeMap)) {
				throw new Error("Plex refreshed evidence could not be loaded");
			}
			if (
				evidenceFingerprint(publishedPlex.generationIdsByInstance) !==
				evidenceFingerprint(generationIdsByInstance)
			) {
				throw new Error("Plex inventory identity did not match the published generation");
			}
			const fingerprint = evidenceFingerprint([
				publishedPlex.plexMap,
				publishedPlex.plexSectionTitles,
				ratingKeysByInstance,
				plexEpisodeMap,
			]);
			if (accepted && accepted.fingerprint !== fingerprint) {
				throw new Error("Plex evidence changed between verification passes");
			}
			accepted = {
				plexMap: publishedPlex.plexMap,
				plexSectionTitles: publishedPlex.plexSectionTitles,
				ratingKeysByInstance,
				plexEpisodeMap,
				fingerprint,
				completedAt: new Date(Math.min(...passCompletions.map((date) => date.getTime()))),
			};
		}
		return accepted
			? {
					plexMap: accepted.plexMap,
					plexSectionTitles: accepted.plexSectionTitles,
					ratingKeysByInstance: accepted.ratingKeysByInstance,
					plexEpisodeMap: accepted.plexEpisodeMap,
					completedAt: accepted.completedAt,
					topologyFingerprint: topology,
				}
			: undefined;
	} catch (error) {
		deps.log.warn({ err: error }, "Live Plex policy evidence refresh failed closed");
		return undefined;
	}
}

async function refreshTautulliMutationEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	cleanupRunClaimToken?: string,
): Promise<{ map: TautulliWatchMap; completedAt: Date } | undefined> {
	try {
		const initial = await loadProviderInstances(deps, userId, ["TAUTULLI"]);
		if (initial.length === 0) return undefined;
		const topology = providerTopologyFingerprint(initial);
		let accepted: { map: TautulliWatchMap; fingerprint: string; completedAt: Date } | undefined;
		for (let pass = 0; pass < 2; pass++) {
			for (const instance of initial) {
				if (!deps.encryptor) throw new Error("Tautulli credentials were unavailable");
				const publicationInstance = createOwnedTautulliPublicationSnapshot(
					deps.encryptor,
					instance,
				);
				const refreshed = await refreshTautulliCache({
					prisma: deps.prisma,
					instance: publicationInstance,
					log: deps.log,
					cleanupRunClaimToken,
				});
				if (refreshed.errors > 0 || refreshed.complete !== true) {
					throw new Error("Tautulli cache refresh was incomplete");
				}
				if (!refreshed.completedAt) {
					throw new Error("Tautulli refresh lacked a completion timestamp");
				}
			}
			const after = await loadProviderInstances(deps, userId, ["TAUTULLI"]);
			if (providerTopologyFingerprint(after) !== topology) {
				throw new Error("Tautulli topology changed during policy revalidation");
			}
			const map = await prefetchTautulliData(deps, userId);
			if (!map) throw new Error("Tautulli refreshed evidence could not be loaded");
			const fingerprint = evidenceFingerprint(map);
			if (accepted && accepted.fingerprint !== fingerprint) {
				throw new Error("Tautulli evidence changed between verification passes");
			}
			const statuses = await loadCompleteCacheGenerations(deps, after, "tautulli");
			if (!statuses) throw new Error("Tautulli completion timestamps were unavailable");
			accepted = {
				map,
				fingerprint,
				completedAt: new Date(
					Math.min(...[...statuses.values()].map((status) => status.completedAt.getTime())),
				),
			};
		}
		return accepted ? { map: accepted.map, completedAt: accepted.completedAt } : undefined;
	} catch (error) {
		deps.log.warn({ err: error }, "Live Tautulli policy evidence refresh failed closed");
		return undefined;
	}
}

async function refreshJellyfinMutationEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	includeEpisodes: boolean,
	cleanupRunClaimToken?: string,
): Promise<
	| { jellyfinMap: JellyfinWatchMap; jellyfinEpisodeMap?: PlexEpisodeMap; completedAt: Date }
	| undefined
> {
	try {
		const initial = await loadProviderInstances(deps, userId, ["JELLYFIN", "EMBY"]);
		if (initial.length === 0) return undefined;
		const topology = providerTopologyFingerprint(initial);
		let accepted:
			| {
					jellyfinMap: JellyfinWatchMap;
					jellyfinEpisodeMap?: PlexEpisodeMap;
					fingerprint: string;
					completedAt: Date;
			  }
			| undefined;
		for (let pass = 0; pass < 2; pass++) {
			for (const instance of initial) {
				if (!deps.encryptor) throw new Error("Jellyfin credentials were unavailable");
				const publicationInstance = createOwnedJellyfinPublicationSnapshot(
					deps.encryptor,
					instance,
				);
				const refreshed = await runJellyfinCacheRefreshSingleFlight(
					publicationInstance,
					() =>
						refreshJellyfinCache({
							prisma: deps.prisma,
							instance: publicationInstance,
							log: deps.log,
							cleanupRunClaimToken,
						}),
					{ prisma: deps.prisma, log: deps.log },
					{ cleanupRunClaimToken },
				);
				if (refreshed.errors > 0 || refreshed.complete !== true) {
					throw new Error("Jellyfin cache refresh was incomplete");
				}
				if (includeEpisodes) {
					const episodes = await refreshJellyfinEpisodeCache({
						prisma: deps.prisma,
						instance: publicationInstance,
						log: deps.log,
						cleanupRunClaimToken,
					});
					if (episodes.errors > 0 || episodes.complete !== true) {
						throw new Error("Jellyfin episode refresh was incomplete");
					}
				}
			}
			const after = await loadProviderInstances(deps, userId, ["JELLYFIN", "EMBY"]);
			if (providerTopologyFingerprint(after) !== topology) {
				throw new Error("Jellyfin topology changed during policy revalidation");
			}
			const jellyfinMap = await prefetchJellyfinData(deps, userId);
			const jellyfinEpisodeMap = includeEpisodes
				? await prefetchJellyfinEpisodeData(deps, userId)
				: undefined;
			if (!jellyfinMap || (includeEpisodes && !jellyfinEpisodeMap)) {
				throw new Error("Jellyfin refreshed evidence could not be loaded");
			}
			const fingerprint = evidenceFingerprint([jellyfinMap, jellyfinEpisodeMap]);
			if (accepted && accepted.fingerprint !== fingerprint) {
				throw new Error("Jellyfin evidence changed between verification passes");
			}
			const statuses = await loadCompleteCacheGenerations(deps, after, "jellyfin");
			if (!statuses) throw new Error("Jellyfin completion timestamps were unavailable");
			accepted = {
				jellyfinMap,
				jellyfinEpisodeMap,
				fingerprint,
				completedAt: new Date(
					Math.min(...[...statuses.values()].map((status) => status.completedAt.getTime())),
				),
			};
		}
		return accepted
			? {
					jellyfinMap: accepted.jellyfinMap,
					jellyfinEpisodeMap: accepted.jellyfinEpisodeMap,
					completedAt: accepted.completedAt,
				}
			: undefined;
	} catch (error) {
		deps.log.warn({ err: error }, "Live Jellyfin policy evidence refresh failed closed");
		return undefined;
	}
}

function collectCleanupListTargets(
	rules: Array<{
		enabled: boolean;
		ruleType: string;
		parameters?: string;
		operator?: string | null;
		conditions: string | null;
	}>,
	ruleType: "tmdb_list_member" | "trakt_list_member",
	parameterName: "listId" | "listSlug",
): Set<string> {
	const targets = new Set<string>();
	for (const rule of rules) {
		if (!rule.enabled) continue;
		const expression = normalizeStoredCleanupRuleExpression({
			ruleType: rule.ruleType,
			parameters: rule.parameters ?? "{}",
			operator: rule.operator ?? null,
			conditions: rule.conditions,
		});
		if (!expression) continue;
		const stack: CleanupRuleExpression[] = [expression.root];
		while (stack.length > 0) {
			const node = stack.pop()!;
			if (node.type === "condition") {
				if (node.ruleType === ruleType) {
					const value = node.parameters[parameterName];
					if (typeof value === "string" && value.length > 0) targets.add(value);
				}
			} else if (node.type === "group") stack.push(...node.children);
			else stack.push(node.child);
		}
	}
	return targets;
}

function collectConfiguredPlexSectionTitles(
	rules: Array<{ enabled: boolean; plexLibraryFilter?: string | null }>,
): Set<string> {
	const titles = new Set<string>();
	for (const rule of rules) {
		if (!rule.enabled || !rule.plexLibraryFilter) continue;
		const configured = safeJsonParse(rule.plexLibraryFilter);
		if (!Array.isArray(configured)) continue;
		for (const value of configured) {
			if (typeof value === "string" && value.length > 0) titles.add(value);
		}
	}
	return titles;
}

async function refreshListMutationEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{
		enabled: boolean;
		ruleType: string;
		parameters?: string;
		operator?: string | null;
		conditions: string | null;
		plexLibraryFilter?: string | null;
	}>,
): Promise<{
	tmdbListMemberships?: Map<string, Set<ListMembershipKey>>;
	traktListMemberships?: Map<string, Set<ListMembershipKey>>;
	tmdbCompletedAt?: Date;
	traktCompletedAt?: Date;
}> {
	const tmdbTargets = collectCleanupListTargets(rules, "tmdb_list_member", "listId");
	const traktTargets = collectCleanupListTargets(rules, "trakt_list_member", "listSlug");
	if (tmdbTargets.size === 0 && traktTargets.size === 0) return {};
	const user = await deps.prisma.user.findUnique({
		where: { id: userId },
		select: {
			encryptedTmdbApiKey: true,
			tmdbEncryptionIv: true,
			encryptedTraktAccessToken: true,
			traktTokenIv: true,
		},
	});
	const result: {
		tmdbListMemberships?: Map<string, Set<ListMembershipKey>>;
		traktListMemberships?: Map<string, Set<ListMembershipKey>>;
		tmdbCompletedAt?: Date;
		traktCompletedAt?: Date;
	} = {};

	if (tmdbTargets.size > 0) {
		try {
			if (!deps.encryptor || !user?.encryptedTmdbApiKey || !user.tmdbEncryptionIv) {
				throw new Error("TMDb list credentials were unavailable");
			}
			const apiKey = deps.encryptor.decrypt({
				value: user.encryptedTmdbApiKey,
				iv: user.tmdbEncryptionIv,
			});
			const client = deps.tmdbListClientFactory?.(apiKey) ?? createTmdbV3Client(apiKey, deps.log);
			const maps = new Map<string, Set<ListMembershipKey>>();
			for (const listId of [...tmdbTargets].sort()) {
				const first = await client.getListItems(listId);
				const second = await client.getListItems(listId);
				if (evidenceFingerprint(first) !== evidenceFingerprint(second)) {
					throw new Error(`TMDb list ${listId} changed between verification passes`);
				}
				maps.set(
					listId,
					new Set(second.map((item) => listMembershipKey(item.mediaType, item.tmdbId))),
				);
			}
			result.tmdbListMemberships = maps;
			result.tmdbCompletedAt = new Date();
		} catch (error) {
			deps.log.warn({ err: error }, "Live TMDb list policy evidence refresh failed closed");
		}
	}

	if (traktTargets.size > 0) {
		try {
			const clientId = deps.traktClientId ?? process.env.TRAKT_CLIENT_ID ?? null;
			if (!deps.encryptor || !clientId || !user?.encryptedTraktAccessToken || !user.traktTokenIv) {
				throw new Error("Trakt list credentials were unavailable");
			}
			const accessToken = deps.encryptor.decrypt({
				value: user.encryptedTraktAccessToken,
				iv: user.traktTokenIv,
			});
			const client =
				deps.traktListClientFactory?.(accessToken, clientId) ??
				createTraktClient(accessToken, clientId, deps.log);
			const maps = new Map<string, Set<ListMembershipKey>>();
			for (const listSlug of [...traktTargets].sort()) {
				const first = await client.getListItems(listSlug);
				const second = await client.getListItems(listSlug);
				if (evidenceFingerprint(first) !== evidenceFingerprint(second)) {
					throw new Error(`Trakt list ${listSlug} changed between verification passes`);
				}
				maps.set(
					listSlug,
					new Set(second.map((item) => listMembershipKey(item.mediaType, item.tmdbId))),
				);
			}
			result.traktListMemberships = maps;
			result.traktCompletedAt = new Date();
		} catch (error) {
			deps.log.warn({ err: error }, "Live Trakt list policy evidence refresh failed closed");
		}
	}
	return result;
}

async function buildMutationEvalContext(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: LibraryCleanupRule[],
	cleanupRunClaimToken?: string,
): Promise<{
	ctx: EvalContext;
	failedSources: Set<DataSourceDependency>;
	sourceCompletedAt: Map<Exclude<DataSourceDependency, null>, Date>;
	plexTargetRatingKeysByInstance?: PlexTargetRatingKeysByInstance;
	plexTopologyFingerprint?: string;
}> {
	const activeTypes = collectActiveRuleTypes(rules);
	const needsSeerr = [
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
	].some((type) => activeTypes.has(type));
	const needsTautulli = [
		"tautulli_last_watched",
		"tautulli_watch_count",
		"tautulli_watched_by",
		"user_retention",
	].some((type) => activeTypes.has(type));
	const needsPlex = [
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
	].some((type) => activeTypes.has(type));
	const needsJellyfin = [
		"jellyfin_last_watched",
		"jellyfin_watch_count",
		"jellyfin_on_deck",
		"jellyfin_user_rating",
		"jellyfin_watched_by",
		"jellyfin_added_at",
		"jellyfin_episode_completion",
	].some((type) => activeTypes.has(type));
	const needsTmdb = activeTypes.has("tmdb_list_member");
	const needsTrakt = activeTypes.has("trakt_list_member");
	const needsPlexSectionInventory = collectConfiguredPlexSectionTitles(rules).size > 0;

	const [seerrMap, tautulliMap, plexEvidence, jellyfinEvidence, listEvidence] = await Promise.all([
		needsSeerr ? prefetchSeerrRequests(deps, userId) : undefined,
		needsTautulli ? refreshTautulliMutationEvidence(deps, userId, cleanupRunClaimToken) : undefined,
		needsPlex || needsPlexSectionInventory
			? refreshPlexMutationEvidence(
					deps,
					userId,
					activeTypes.has("plex_episode_completion"),
					rules,
					cleanupRunClaimToken,
				)
			: undefined,
		needsJellyfin
			? refreshJellyfinMutationEvidence(
					deps,
					userId,
					activeTypes.has("jellyfin_episode_completion"),
					cleanupRunClaimToken,
				)
			: undefined,
		refreshListMutationEvidence(deps, userId, rules),
	]);

	const failedSources = new Set<DataSourceDependency>();
	if (needsSeerr && !seerrMap) failedSources.add("seerr");
	if (needsTautulli && !tautulliMap) failedSources.add("tautulli");
	if ((needsPlex || needsPlexSectionInventory) && !plexEvidence) {
		failedSources.add("plex");
	}
	if (needsJellyfin && !jellyfinEvidence) failedSources.add("jellyfin");
	if (needsTmdb && !listEvidence.tmdbListMemberships) failedSources.add("tmdb");
	if (needsTrakt && !listEvidence.traktListMemberships) failedSources.add("trakt");
	const sourceCompletedAt = new Map<Exclude<DataSourceDependency, null>, Date>();
	if (needsSeerr && seerrMap) sourceCompletedAt.set("seerr", new Date());
	if (tautulliMap) sourceCompletedAt.set("tautulli", tautulliMap.completedAt);
	if (plexEvidence) sourceCompletedAt.set("plex", plexEvidence.completedAt);
	if (jellyfinEvidence) sourceCompletedAt.set("jellyfin", jellyfinEvidence.completedAt);
	if (listEvidence.tmdbCompletedAt) sourceCompletedAt.set("tmdb", listEvidence.tmdbCompletedAt);
	if (listEvidence.traktCompletedAt) sourceCompletedAt.set("trakt", listEvidence.traktCompletedAt);
	return {
		ctx: {
			now: new Date(),
			seerrMap,
			tautulliMap: tautulliMap?.map,
			plexMap: plexEvidence?.plexMap,
			plexSectionTitles: plexEvidence?.plexSectionTitles,
			plexEpisodeMap: plexEvidence?.plexEpisodeMap,
			jellyfinMap: jellyfinEvidence?.jellyfinMap,
			jellyfinEpisodeMap: jellyfinEvidence?.jellyfinEpisodeMap,
			tmdbListMemberships: listEvidence.tmdbListMemberships,
			traktListMemberships: listEvidence.traktListMemberships,
		},
		failedSources,
		sourceCompletedAt,
		plexTargetRatingKeysByInstance: plexEvidence?.ratingKeysByInstance,
		plexTopologyFingerprint: plexEvidence?.topologyFingerprint,
	};
}

export interface MutationPolicySnapshot {
	correlationId: string;
	capturedAt: Date;
	rules: LibraryCleanupRule[];
	ruleFingerprint: string;
	configFingerprint: string;
	ctx: EvalContext;
	failedSources: Set<DataSourceDependency>;
	sourceCompletedAt: Map<Exclude<DataSourceDependency, null>, Date>;
	oldestSourceCompletedAt: Date | null;
	plexTargetRatingKeysByInstance?: PlexTargetRatingKeysByInstance;
	plexTopologyFingerprint?: string;
	providerTopologyFingerprint: string;
}

/**
 * A freshly captured snapshot must still remain within this bounded authority
 * window. Snapshots are never reused across targets or irreversible writes.
 */
export const MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 1000;

export function createMutationPolicySnapshotGetter(
	deps: CleanupExecutorDeps,
	userId: string,
	expectedConfigFingerprint?: string,
	cleanupRunClaimToken?: string,
): () => Promise<MutationPolicySnapshot> {
	// Deliberately do not reuse mutable provider authority across targets or
	// irreversible writes. Every call performs a fresh bounded publication and
	// captures a new immutable policy snapshot.
	return async () =>
		await createMutationPolicySnapshot(
			deps,
			userId,
			expectedConfigFingerprint,
			cleanupRunClaimToken,
		);
}

async function createMutationPolicySnapshot(
	deps: CleanupExecutorDeps,
	userId: string,
	expectedConfigFingerprint?: string,
	cleanupRunClaimToken?: string,
): Promise<MutationPolicySnapshot> {
	const config = await deps.prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: true },
	});
	if (!config?.enabled) throw new Error("The cleanup configuration is no longer enabled");
	if (config.dryRunMode) throw new Error("The cleanup configuration is now in dry-run mode");
	const configFingerprint = completeMutationConfigFingerprint(config) ?? "";
	if (expectedConfigFingerprint && expectedConfigFingerprint !== configFingerprint) {
		throw new Error("Cleanup mutation settings changed after run authorization");
	}
	const rules = config.rules
		.filter((rule) => rule.targetScope !== "episode")
		.sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
	const {
		ctx,
		failedSources,
		sourceCompletedAt,
		plexTargetRatingKeysByInstance,
		plexTopologyFingerprint,
	} = await buildMutationEvalContext(deps, userId, rules, cleanupRunClaimToken);
	const oldestSourceCompletedAt =
		sourceCompletedAt.size > 0
			? new Date(Math.min(...[...sourceCompletedAt.values()].map((date) => date.getTime())))
			: null;
	if (
		oldestSourceCompletedAt &&
		Date.now() - oldestSourceCompletedAt.getTime() > MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS
	) {
		throw new Error("Provider authority was too old to authorize cleanup mutation");
	}
	const providerInstances = await loadProviderInstances(deps, userId, [
		"PLEX",
		"TAUTULLI",
		"JELLYFIN",
		"EMBY",
		"SEERR",
	]);
	const snapshot = {
		correlationId: randomUUID(),
		capturedAt: new Date(),
		rules,
		ruleFingerprint: evidenceFingerprint(rules),
		configFingerprint,
		ctx,
		failedSources,
		sourceCompletedAt,
		oldestSourceCompletedAt,
		plexTargetRatingKeysByInstance,
		plexTopologyFingerprint,
		providerTopologyFingerprint: providerTopologyFingerprint(providerInstances),
	};
	deps.log.info(
		{
			correlationId: snapshot.correlationId,
			capturedAt: snapshot.capturedAt,
			ruleCount: rules.length,
			failedSources: [...failedSources],
		},
		"Captured authoritative cleanup mutation policy snapshot",
	);
	return snapshot;
}

export async function buildEvalContextWithHealth(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{
		enabled: boolean;
		ruleType: string;
		parameters?: string;
		operator?: string | null;
		conditions: string | null;
		plexLibraryFilter?: string | null;
	}>,
	options: { providerEvidence?: "published" | "live" } = {},
): Promise<{
	ctx: EvalContext;
	failedSources: Set<DataSourceDependency>;
	providerEvidence?: SanitizedProviderEvidence;
}> {
	// The legacy option remains callable for route compatibility, but cleanup
	// authorization never substitutes an uncached live read for a published,
	// identity-bound provider generation.
	void options;
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
	const TAUTULLI_RULE_TYPES = [
		"tautulli_last_watched",
		"tautulli_watch_count",
		"tautulli_watched_by",
		"user_retention",
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

	const needsSeerr = SEERR_RULE_TYPES.some((type) => activeTypes.has(type));
	const needsTautulli = TAUTULLI_RULE_TYPES.some((type) => activeTypes.has(type));
	const needsPlex = PLEX_RULE_TYPES_LIST.some((type) => activeTypes.has(type));
	const needsPlexEpisodes = activeTypes.has("plex_episode_completion");
	const needsJellyfin = JELLYFIN_RULE_TYPES.some((type) => activeTypes.has(type));
	const needsJellyfinEpisodes = activeTypes.has("jellyfin_episode_completion");
	const needsTmdb = activeTypes.has("tmdb_list_member");
	const needsTrakt = activeTypes.has("trakt_list_member");
	const needsPlexSectionInventory = collectConfiguredPlexSectionTitles(rules).size > 0;
	const [
		seerrMap,
		tautulliSnapshot,
		plexSnapshot,
		plexEvidence,
		plexEpisodeSnapshot,
		jellyfinSnapshot,
		jellyfinEpisodeSnapshot,
		listEvidence,
	] = await Promise.all([
		needsSeerr ? prefetchSeerrRequests(deps, userId) : undefined,
		needsTautulli ? loadTautulliDataSnapshot(deps, userId) : undefined,
		needsPlex || needsPlexSectionInventory ? loadPlexDataSnapshot(deps, userId) : undefined,
		needsPlexSectionInventory ? loadPublishedPlexPolicyEvidence(deps, userId, rules) : undefined,
		needsPlexEpisodes ? loadPlexEpisodeDataSnapshot(deps, userId) : undefined,
		needsJellyfin ? loadJellyfinDataSnapshot(deps, userId) : undefined,
		needsJellyfinEpisodes ? loadJellyfinEpisodeDataSnapshot(deps, userId) : undefined,
		refreshListMutationEvidence(deps, userId, rules),
	]);
	const plexAuthorityConsistent =
		!plexSnapshot ||
		!plexEvidence ||
		(await revalidateProviderCacheAuthority(deps, plexSnapshot.authority, false));
	const effectivePlexSnapshot = plexAuthorityConsistent ? plexSnapshot : undefined;
	const effectivePlexEvidence = plexAuthorityConsistent ? plexEvidence : undefined;
	const tautulliMap = tautulliSnapshot?.value;
	const plexEpisodeMap = plexEpisodeSnapshot?.value;
	const jellyfinMap = jellyfinSnapshot?.value;
	const jellyfinEpisodeMap = jellyfinEpisodeSnapshot?.value;

	const failedSources = new Set<DataSourceDependency>();
	if (needsSeerr && !seerrMap) failedSources.add("seerr");
	if (needsTautulli && !tautulliMap) failedSources.add("tautulli");
	if (needsPlex && !effectivePlexSnapshot) failedSources.add("plex");
	if (needsPlexEpisodes && !plexEpisodeMap) failedSources.add("plex");
	if (needsPlexSectionInventory && !effectivePlexEvidence) failedSources.add("plex");
	if (needsJellyfin && !jellyfinMap) failedSources.add("jellyfin");
	if (needsJellyfinEpisodes && !jellyfinEpisodeMap) failedSources.add("jellyfin");
	if (needsTmdb && !listEvidence.tmdbListMemberships) failedSources.add("tmdb");
	if (needsTrakt && !listEvidence.traktListMemberships) failedSources.add("trakt");

	const ctx: EvalContext = {
		now: new Date(),
		seerrMap: seerrMap ?? undefined,
		tautulliMap: tautulliMap ?? undefined,
		plexMap: effectivePlexSnapshot?.value,
		plexSectionTitles: effectivePlexEvidence?.plexSectionTitles,
		plexEpisodeMap: plexEpisodeMap ?? undefined,
		jellyfinMap: jellyfinMap ?? undefined,
		jellyfinEpisodeMap: jellyfinEpisodeMap ?? undefined,
		tmdbListMemberships: listEvidence.tmdbListMemberships,
		traktListMemberships: listEvidence.traktListMemberships,
	};
	const contributingSnapshots = [
		tautulliSnapshot,
		effectivePlexSnapshot,
		plexEpisodeSnapshot,
		jellyfinSnapshot,
		jellyfinEpisodeSnapshot,
	].filter((snapshot) => snapshot !== undefined) as ProviderCacheSnapshot<unknown>[];
	const providerEvidence = createSanitizedProviderEvidence(
		contributingSnapshots.flatMap((snapshot) => snapshot.evidence.dependencies),
		contributingSnapshots.flatMap((snapshot) =>
			snapshot.evidence.sources.map(({ fingerprint: _fingerprint, ...source }) => source),
		),
	);
	return { ctx, failedSources, providerEvidence };
}

export async function buildEvalContext(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{ enabled: boolean; ruleType: string; conditions: string | null }>,
): Promise<EvalContext> {
	return (await buildEvalContextWithHealth(deps, userId, rules)).ctx;
}

/**
 * Create a cleanup run log entry.
 * Failures are logged but not rethrown — the run result is more important than its log.
 */
async function createRunLog(
	deps: CleanupExecutorDeps,
	configId: string,
	result: Omit<CleanupRunResult, "error"> & { error?: string },
): Promise<void> {
	const runLogId = randomUUID();
	try {
		await deps.prisma.libraryCleanupLog.create({
			data: {
				id: runLogId,
				configId,
				isDryRun: result.isDryRun,
				status: result.status,
				itemsEvaluated: result.itemsEvaluated,
				itemsFlagged: result.itemsFlagged,
				itemsRemoved: result.itemsRemoved,
				itemsUnmonitored: result.itemsUnmonitored,
				itemsFilesDeleted: result.itemsFilesDeleted,
				itemsSkipped: result.itemsSkipped,
				details: JSON.stringify(result.details.slice(0, CLEANUP_DETAIL_LIMIT)),
				error: result.error,
				prefetchHealth: result.prefetchHealth ? JSON.stringify(result.prefetchHealth) : null,
				warnings: result.warnings?.length ? JSON.stringify(result.warnings) : null,
				durationMs: result.durationMs,
				startedAt: new Date(Date.now() - result.durationMs),
				completedAt: new Date(),
			},
		});
	} catch (error) {
		deps.log.warn(
			{ err: error, configId },
			"Failed to write cleanup run log — run result is still valid",
		);
	}
	await runCleanupAuditBestEffort(
		() =>
			recordConfiguredRunAudit(
				deps.prisma,
				{
					configId,
					runLogId,
					result,
					trigger: deps.auditTrigger === "manual" ? "manual" : "scheduled",
					actorId: deps.auditActorId,
				},
				deps.log,
			),
		deps.log,
		"configured cleanup outcome",
	);
}
