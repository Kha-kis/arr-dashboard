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
import { buildLibraryItem } from "../library/library-item-builder.js";
import { buildMovieFile } from "../library/movie-normalizer.js";
import { plexConnectionFingerprint } from "../plex/service-instance-fingerprint.js";
import { withQuiObservationTopologyGuard } from "../qui/observation-topology-guard.js";
import type {
	LibraryCleanupApproval,
	LibraryCleanupConfig,
	LibraryCleanupRule,
	ServiceInstance,
} from "../prisma.js";
import {
	evaluateItemAgainstRulesViaEngine,
	evaluateItemMutationPolicyStateViaEngine,
	evaluateRuleViaEngine,
} from "../rules/cleanup-adapter.js";
import { SeerrClient } from "../seerr/seerr-client.js";
import { hasAuthoritativeProviderCacheGeneration } from "../services/provider-identity-guard.js";
import { getErrorMessage } from "../utils/error-message.js";
import { safeJsonParse } from "../utils/json.js";
import {
	withCleanupOperationGuard,
	withExclusiveCleanupOperationGuard,
} from "./cleanup-maintenance-gate.js";
import { deriveArrPolicyEvidence } from "./arr-policy-evidence.js";
import {
	appendCleanupAuditEvent,
	appendCleanupTerminalAuditEvent,
	createCleanupAuditEventKey,
	createCleanupTerminalAuditState,
	type AppendCleanupAuditEventInput,
	type CleanupAuditActorType,
	type CleanupAuditTrigger,
} from "./cleanup-audit.js";
import {
	prepareMediaServerRescans,
	rescanMediaType,
	triggerCoalescedMediaServerRescans,
} from "./media-server-rescan.js";
import {
	type EpisodeCleanupCandidate,
	type EpisodePlexWatchEvidence,
	evaluateEpisodeWatchCountRule,
	isSupportedEpisodeCleanupRule,
	toEpisodeTargetMetadata,
} from "./episode-scope.js";
import type { ProviderCacheType } from "./provider-cache-evidence.js";
import { applyQuiSeedingFilter, isQuiSeedingState } from "./qui-filter.js";
import {
	type DirectCleanupSelectionPlan,
	planApprovalCleanupSelection,
	planDirectCleanupSelection,
} from "./selection-planner.js";
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
	assertCurrentProviderEvidenceAuthority,
	assertVerifiedArrTargetUnchanged,
	assertVerifiedRadarrEmptyUnchanged,
	assertVerifiedRadarrFileUnchanged,
	assertVerifiedRadarrPeerOwnershipRetained,
	assertVerifiedSonarrEpisodeUnchanged,
	assertVerifiedSonarrFilesUnchanged,
	assertVerifiedSonarrPeerOwnershipRetained,
	buildCacheTargetSafetyPlan,
	buildRadarrCacheSafetyPlan,
	buildSonarrCacheSafetyPlan,
	type CleanupDeleteTarget,
	captureCurrentProviderEvidenceAuthority,
	cleanupDeleteTargetKey,
	createArrServiceFingerprint,
	createSanitizedProviderEvidence,
	createSharedPlexSafetyContext,
	type ExecutableSharedMediaSafetyPlan,
	executableSafetyPlansEqual,
	findSharedPlexDeleteBlocks,
	parseExecutableSafetyEnvelope,
	parseExecutableSafetyPlan,
	RadarrFileChangedDuringSafetyCheckError,
	radarrCachedFileIdentityMatches,
	renewCurrentProviderRetryAuthority,
	type SanitizedProviderEvidence,
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
} from "./types.js";

interface CleanupMediaServerScanPolicy {
	scanMediaServerAfterDelete: boolean;
	scanMediaServerInstanceIds: string | null;
}

type ExpectedMutationRule = {
	matchedRuleId: string;
	action: RuleAction;
	scanMediaServerAfterDelete?: boolean;
	scanMediaServerInstanceIds?: string | null;
};

function normalizeCleanupMediaServerScanPolicy(input: {
	action?: string | null;
	scanMediaServerAfterDelete?: boolean | null;
	scanMediaServerInstanceIds?: string | null;
}): CleanupMediaServerScanPolicy {
	if (input.scanMediaServerAfterDelete !== true) {
		return { scanMediaServerAfterDelete: false, scanMediaServerInstanceIds: null };
	}
	if (input.action !== "delete" && input.action !== "delete_files") {
		throw new Error("The stored media-server scan policy is incompatible with this cleanup action");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(input.scanMediaServerInstanceIds ?? "");
	} catch {
		throw new Error("The stored media-server scan target selection is invalid");
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length === 0 ||
		parsed.some((entry) => typeof entry !== "string" || entry.length === 0)
	) {
		throw new Error("The stored media-server scan target selection is invalid");
	}
	const instanceIds = parsed as string[];
	const canonical = [...new Set(instanceIds)].sort((left, right) => left.localeCompare(right));
	if (
		canonical.length !== instanceIds.length ||
		canonical.some((instanceId, index) => instanceId !== instanceIds[index])
	) {
		throw new Error("The stored media-server scan target selection is invalid");
	}
	return {
		scanMediaServerAfterDelete: true,
		scanMediaServerInstanceIds: JSON.stringify(canonical),
	};
}

function mediaServerScanPoliciesEqual(
	left: Parameters<typeof normalizeCleanupMediaServerScanPolicy>[0],
	right: Parameters<typeof normalizeCleanupMediaServerScanPolicy>[0],
): boolean {
	const normalizedLeft = normalizeCleanupMediaServerScanPolicy(left);
	const normalizedRight = normalizeCleanupMediaServerScanPolicy(right);
	return (
		normalizedLeft.scanMediaServerAfterDelete === normalizedRight.scanMediaServerAfterDelete &&
		normalizedLeft.scanMediaServerInstanceIds === normalizedRight.scanMediaServerInstanceIds
	);
}

function expectedMutationRule(
	matchedRuleId: string,
	action: RuleAction,
	input: Parameters<typeof normalizeCleanupMediaServerScanPolicy>[0],
): ExpectedMutationRule {
	return { matchedRuleId, action, ...normalizeCleanupMediaServerScanPolicy(input) };
}

async function prepareCleanupMediaServerRescans(
	deps: CleanupExecutorDeps,
	userId: string,
	approval: LibraryCleanupApproval,
): Promise<number> {
	const policy = normalizeCleanupMediaServerScanPolicy(approval);
	if (!policy.scanMediaServerAfterDelete) return 0;
	return deps.mediaServerRescan?.prepare
		? deps.mediaServerRescan.prepare(userId, approval, rescanMediaType(approval.itemType))
		: prepareMediaServerRescans(deps, userId, approval, rescanMediaType(approval.itemType));
}

async function assertCurrentMediaServerScanRuleAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	expected: ExpectedMutationRule,
): Promise<void> {
	const currentRule = await deps.prisma.libraryCleanupRule.findFirst({
		where: { id: expected.matchedRuleId, enabled: true, config: { userId } },
		select: {
			action: true,
			scanMediaServerAfterDelete: true,
			scanMediaServerInstanceIds: true,
		},
	});
	if (
		!currentRule ||
		currentRule.action !== expected.action ||
		!mediaServerScanPoliciesEqual(expected, currentRule)
	) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the selected post-delete media-server scan policy changed after this item was queued.",
		);
	}
}

async function triggerCleanupMediaServerRescansBestEffort(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalIds: string[],
): Promise<void> {
	try {
		const result = deps.mediaServerRescan?.trigger
			? await deps.mediaServerRescan.trigger(userId, approvalIds)
			: await triggerCoalescedMediaServerRescans(deps, userId, approvalIds);
		if (result.failed > 0 || result.warnings.length > 0) {
			deps.log.warn(
				{ approvalIds, failed: result.failed, warnings: result.warnings },
				"Cleanup completed, but media-server scan work remains retryable",
			);
		}
	} catch (error) {
		deps.log.warn(
			{ err: error, approvalIds },
			"Cleanup completed, but media-server scan dispatch could not be started",
		);
	}
}

// Default approval expiry: 7 days
const APPROVAL_EXPIRY_DAYS = 7;

// Batch size for LibraryCache queries
const CACHE_QUERY_BATCH_SIZE = 500;
const PROVIDER_EVIDENCE_FRESHNESS_MS = 24 * 60 * 60 * 1000;

export type SeriesMutationTransition = "unchanged" | "all_files_deleted";

export type CleanupAuditContext = {
	actorType: CleanupAuditActorType;
	actorId?: string;
	trigger: CleanupAuditTrigger;
};

const DEFAULT_SCHEDULED_AUDIT_CONTEXT: CleanupAuditContext = {
	actorType: "scheduler",
	trigger: "scheduled",
};

const DEFAULT_DIRECT_AUDIT_CONTEXT: CleanupAuditContext = {
	actorType: "system",
	trigger: "scheduled",
};

function withCleanupAuditTrigger(
	context: CleanupAuditContext,
	trigger: CleanupAuditTrigger,
): CleanupAuditContext {
	return { ...context, trigger };
}

type MutationAuthorityEvidence =
	| { liveEpisodeWatchSources: VerifiedEpisodePlexWatchSource[] }
	| { seriesTransition: SeriesMutationTransition };

type MutationAuthorityCheck = (
	evidence?: MutationAuthorityEvidence,
) => Promise<Record<string, unknown> | undefined>;

export interface MutationPolicySnapshot {
	capturedAt: Date;
	configFingerprint: string;
	rules: LibraryCleanupRule[];
	ruleFingerprint: string;
	ctx: EvalContext;
	failedSources: Set<DataSourceDependency>;
	providerTopologyFingerprint: string;
}

interface AuthorizedSeriesMutationPolicy {
	snapshot: MutationPolicySnapshot;
	rawItem: Record<string, unknown>;
	policyItem: CacheItemForEval;
}

/** A snapshot is captured for one target/write and is never reused by a later run. */
export const MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS = 2 * 60 * 1000;

function compareCanonicalPolicyValues(left: unknown, right: unknown): number {
	return JSON.stringify(left).localeCompare(JSON.stringify(right));
}

function canonicalPolicyValue(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "bigint") return `${value}n`;
	if (value instanceof Set) {
		return [...value].map(canonicalPolicyValue).sort(compareCanonicalPolicyValues);
	}
	if (value instanceof Map) {
		return [...value.entries()]
			.map(([key, entry]) => [canonicalPolicyValue(key), canonicalPolicyValue(entry)])
			.sort((left, right) => compareCanonicalPolicyValues(left[0], right[0]));
	}
	if (Array.isArray(value)) return value.map(canonicalPolicyValue);
	if (typeof value !== "object" || value === null) return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => [key, canonicalPolicyValue(entry)]),
	);
}

function mutationPolicyFingerprint(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(canonicalPolicyValue(value)))
		.digest("hex");
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
		typeof config.maxRemovalsPerRun !== "number" ||
		!Number.isSafeInteger(config.maxRemovalsPerRun) ||
		config.maxRemovalsPerRun < 1 ||
		config.maxRemovalsPerRun > 100
	) {
		return undefined;
	}
	return mutationPolicyFingerprint({
		id: config.id,
		enabled: config.enabled,
		dryRunMode: config.dryRunMode,
		requireApproval: config.requireApproval,
		maxRemovalsPerRun: config.maxRemovalsPerRun,
		respectQuiSeeding: config.respectQuiSeeding,
	});
}

function orderedMutationRules(rules: LibraryCleanupRule[]): LibraryCleanupRule[] {
	return [...rules].sort(
		(left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
	);
}

const MUTATION_POLICY_PROVIDER_SERVICES: ServiceInstance["service"][] = [
	"PLEX",
	"JELLYFIN",
	"EMBY",
	"SEERR",
];

async function loadMutationPolicyProviderInstances(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<ServiceInstance[]> {
	return await deps.prisma.serviceInstance.findMany({
		where: {
			userId,
			enabled: true,
			service: { in: MUTATION_POLICY_PROVIDER_SERVICES },
		},
		orderBy: { id: "asc" },
	});
}

function providerTopologyFingerprint(instances: ServiceInstance[]): string {
	return mutationPolicyFingerprint(
		[...instances]
			.sort((left, right) => left.id.localeCompare(right.id))
			.map((instance) => ({
				id: instance.id,
				service: instance.service,
				baseUrl: instance.baseUrl,
				enabled: instance.enabled,
				encryptedApiKey: instance.encryptedApiKey,
				encryptionIv: instance.encryptionIv,
				encryptedHttpAuthCredentials: instance.encryptedHttpAuthCredentials,
				httpAuthEncryptionIv: instance.httpAuthEncryptionIv,
				expectedIdentity: instance.expectedIdentity,
				identityStatus: instance.identityStatus,
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			})),
	);
}

function mutationPolicyUsesProviderTopology(rules: LibraryCleanupRule[]): boolean {
	const activeTypes = collectActiveRuleTypes(rules);
	return (
		rules.some((rule) => getRuleDataSources(rule).size > 0) ||
		activeTypes.has("user_retention") ||
		activeTypes.has("staleness_score") ||
		activeTypes.has("recently_active") ||
		activeTypes.has("seerr_requester_watched") ||
		activeTypes.has("seerr_requester_not_watched")
	);
}

async function createMutationPolicySnapshot(
	deps: CleanupExecutorDeps,
	userId: string,
	expectedConfigFingerprint?: string,
	cleanupRunClaimToken?: string,
): Promise<MutationPolicySnapshot> {
	const capturedAt = new Date();
	const config = await deps.prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: true },
	});
	if (!config?.enabled || config.dryRunMode) {
		throw new Error("The cleanup configuration is no longer enabled for mutation");
	}
	const configFingerprint = completeMutationConfigFingerprint(config);
	if (!configFingerprint) throw new Error("Cleanup mutation settings were incomplete");
	if (expectedConfigFingerprint && configFingerprint !== expectedConfigFingerprint) {
		throw new Error("Cleanup mutation settings changed after run authorization");
	}

	const rules = orderedMutationRules(config.rules.filter((rule) => rule.targetScope !== "episode"));
	const ruleFingerprint = mutationPolicyFingerprint(rules);
	const needsProviderTopology = mutationPolicyUsesProviderTopology(rules);
	const topologyBefore = needsProviderTopology
		? await loadMutationPolicyProviderInstances(deps, userId)
		: [];
	const ctx = await buildEvalContext(deps, userId, rules, {
		destructiveAuthority: true,
		requireAvailableEvidence: true,
		cleanupRunClaimToken,
	});
	const topologyAfter = needsProviderTopology
		? await loadMutationPolicyProviderInstances(deps, userId)
		: [];
	const beforeTopologyFingerprint = providerTopologyFingerprint(topologyBefore);
	const afterTopologyFingerprint = providerTopologyFingerprint(topologyAfter);
	if (beforeTopologyFingerprint !== afterTopologyFingerprint) {
		throw new Error("Provider topology changed while cleanup authority was being captured");
	}

	const currentConfig = await deps.prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: true },
	});
	const currentRules = currentConfig
		? orderedMutationRules(currentConfig.rules.filter((rule) => rule.targetScope !== "episode"))
		: [];
	if (
		!currentConfig?.enabled ||
		currentConfig.dryRunMode ||
		completeMutationConfigFingerprint(currentConfig) !== configFingerprint ||
		mutationPolicyFingerprint(currentRules) !== ruleFingerprint
	) {
		throw new Error("Cleanup rules or mutation settings changed while authority was captured");
	}
	if (Date.now() - capturedAt.getTime() > MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS) {
		throw new Error("Cleanup mutation authority capture exceeded its freshness window");
	}
	return {
		capturedAt,
		configFingerprint,
		rules,
		ruleFingerprint,
		ctx,
		failedSources: new Set<DataSourceDependency>(),
		providerTopologyFingerprint: afterTopologyFingerprint,
	};
}

/** Capture fresh policy evidence for one mutation boundary. */
export function createMutationPolicySnapshotGetter(
	deps: CleanupExecutorDeps,
	userId: string,
	expectedConfigFingerprint?: string,
	cleanupRunClaimToken?: string,
): () => Promise<MutationPolicySnapshot> {
	return async () =>
		await createMutationPolicySnapshot(
			deps,
			userId,
			expectedConfigFingerprint,
			cleanupRunClaimToken,
		);
}

function assertMutationPolicySnapshotFresh(snapshot: MutationPolicySnapshot): void {
	const age = Date.now() - snapshot.capturedAt.getTime();
	if (age < 0 || age > MUTATION_POLICY_SNAPSHOT_MAX_AGE_MS) {
		throw new Error("Cleanup mutation authority snapshot is stale");
	}
}

function toLiveSeriesPolicyItem(
	instance: ServiceInstance,
	arrItemId: number,
	rawItem: Record<string, unknown>,
): CacheItemForEval {
	if (instance.service !== "RADARR" && instance.service !== "SONARR") {
		throw new Error(`Unsupported cleanup service: ${instance.service}`);
	}
	const service = instance.service === "RADARR" ? "radarr" : "sonarr";
	const liveItem = buildLibraryItem(instance, service, rawItem);
	const liveItemId =
		typeof liveItem.id === "number" ? liveItem.id : Number.parseInt(String(liveItem.id), 10);
	const expectedType = instance.service === "RADARR" ? "movie" : "series";
	if (
		liveItemId !== arrItemId ||
		liveItem.type !== expectedType ||
		typeof rawItem.title !== "string" ||
		rawItem.title.trim() === "" ||
		typeof liveItem.title !== "string" ||
		liveItem.title.trim() === ""
	) {
		throw new Error(
			`Live ARR item identity did not match the cleanup target (expected ${expectedType} ${arrItemId}, received ${liveItem.type} ${liveItemId})`,
		);
	}
	const addedAt = liveItem.added ? new Date(liveItem.added) : null;
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
		sizeOnDisk: BigInt(Math.max(0, Math.trunc(liveItem.sizeOnDisk ?? 0))),
		arrAddedAt: addedAt && !Number.isNaN(addedAt.getTime()) ? addedAt : null,
		cachedAt: new Date(),
		data: JSON.stringify({
			...rawItem,
			...liveItem,
			statistics: { ...rawStatistics, ...liveItem.statistics },
			_arrDashboardSource: { serviceFingerprint: createArrServiceFingerprint(instance) },
			_arrDashboardEvidence: deriveArrPolicyEvidence(service, rawItem),
		}),
		infoHash: null,
		torrentState: null,
	};
}

async function loadLiveSeriesPolicyItem(
	deps: CleanupExecutorDeps,
	instance: ServiceInstance,
	arrItemId: number,
	rules: LibraryCleanupRule[],
): Promise<{ rawItem: Record<string, unknown>; item: CacheItemForEval }> {
	const client = deps.arrClientFactory.create(instance);
	let rawItem =
		instance.service === "RADARR"
			? ((await (client as InstanceType<typeof RadarrClient>).movie.getById(
					arrItemId,
				)) as unknown as Record<string, unknown>)
			: instance.service === "SONARR"
				? ((await (client as InstanceType<typeof SonarrClient>).series.getById(
						arrItemId,
					)) as unknown as Record<string, unknown>)
				: (() => {
						throw new Error(`Unsupported cleanup service: ${instance.service}`);
					})();
	let item = toLiveSeriesPolicyItem(instance, arrItemId, rawItem);
	if (
		collectActiveRuleTypes(rules).has("quality_profile") &&
		(!item.qualityProfileName || item.qualityProfileName.trim().length === 0)
	) {
		const qualityProfileId = item.qualityProfileId;
		if (
			typeof qualityProfileId !== "number" ||
			!Number.isSafeInteger(qualityProfileId) ||
			qualityProfileId <= 0
		) {
			throw new Error("Live ARR quality-profile identity was incomplete");
		}
		const profile =
			instance.service === "RADARR"
				? await (client as InstanceType<typeof RadarrClient>).qualityProfile.getById(
						qualityProfileId,
					)
				: await (client as InstanceType<typeof SonarrClient>).qualityProfile.getById(
						qualityProfileId,
					);
		if (typeof profile.name !== "string" || profile.name.trim().length === 0) {
			throw new Error("Live ARR quality-profile name was incomplete");
		}
		rawItem = { ...rawItem, profileName: profile.name };
		item = toLiveSeriesPolicyItem(instance, arrItemId, rawItem);
	}
	return { rawItem, item };
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

function policyStateOutsideExpectedFileDeletion(
	value: unknown,
	service: "RADARR" | "SONARR",
	context: "root" | "statistics" | "nested" = "root",
): unknown {
	if (Array.isArray(value)) {
		return value.map((entry) => policyStateOutsideExpectedFileDeletion(entry, service, "nested"));
	}
	if (typeof value !== "object" || value === null) return value;
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (
			context === "root" &&
			(service === "RADARR"
				? RADARR_FILE_TRANSITION_FIELDS.has(key)
				: SONARR_FILE_TRANSITION_FIELDS.has(key))
		) {
			continue;
		}
		if (
			context === "statistics" &&
			(service === "RADARR"
				? RADARR_STATISTICS_FILE_TRANSITION_FIELDS.has(key)
				: SONARR_STATISTICS_FILE_TRANSITION_FIELDS.has(key))
		) {
			continue;
		}
		result[key] = policyStateOutsideExpectedFileDeletion(
			entry,
			service,
			key === "statistics" ? "statistics" : "nested",
		);
	}
	return result;
}

function assertExpectedSeriesArrTransition(
	instance: ServiceInstance,
	before: Record<string, unknown>,
	after: Record<string, unknown>,
	afterItem: CacheItemForEval,
	transition: SeriesMutationTransition,
): void {
	if (instance.service !== "RADARR" && instance.service !== "SONARR") {
		throw new Error("Unsupported ARR service for cleanup policy mutation");
	}
	if (transition === "unchanged") {
		if (mutationPolicyFingerprint(before) !== mutationPolicyFingerprint(after)) {
			throw new Error("Live ARR policy state changed before the authorized mutation");
		}
		return;
	}
	if (
		mutationPolicyFingerprint(policyStateOutsideExpectedFileDeletion(before, instance.service)) !==
		mutationPolicyFingerprint(policyStateOutsideExpectedFileDeletion(after, instance.service))
	) {
		throw new Error("Live ARR policy state changed outside the expected file transition");
	}
	if (afterItem.hasFile || afterItem.sizeOnDisk !== 0n) {
		throw new Error("ARR did not expose the expected complete file-deletion transition");
	}
	const evidence = deriveArrPolicyEvidence(
		instance.service === "RADARR" ? "radarr" : "sonarr",
		after,
	);
	if (!evidence.hasFile || !evidence.sizeOnDisk) {
		throw new Error("ARR did not provide complete post-file-deletion policy evidence");
	}
	if (instance.service === "RADARR") {
		if (
			after.hasFile !== false ||
			after.sizeOnDisk !== 0 ||
			(typeof after.movieFileId === "number" && after.movieFileId > 0) ||
			(typeof after.movieFile === "object" && after.movieFile !== null)
		) {
			throw new Error("Radarr's post-file-deletion state was missing or ambiguous");
		}
		return;
	}
	const statistics =
		typeof after.statistics === "object" && after.statistics !== null
			? (after.statistics as Record<string, unknown>)
			: null;
	if (statistics?.episodeFileCount !== 0 || statistics.sizeOnDisk !== 0) {
		throw new Error("Sonarr's post-file-deletion statistics were missing or ambiguous");
	}
}

export async function assertCurrentSeriesMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	instance: ServiceInstance,
	arrItemId: number,
	expectedRule: { matchedRuleId: string; action: RuleAction },
	snapshot: MutationPolicySnapshot,
): Promise<AuthorizedSeriesMutationPolicy> {
	try {
		assertMutationPolicySnapshotFresh(snapshot);
		if (instance.userId !== userId) {
			throw new Error("The live ARR instance does not belong to the cleanup owner");
		}
		const { rawItem, item } = await loadLiveSeriesPolicyItem(
			deps,
			instance,
			arrItemId,
			snapshot.rules,
		);
		await assertSeriesMutationInstanceStillCurrent(deps, userId, instance);
		const policy = evaluateItemMutationPolicyStateViaEngine(
			item,
			snapshot.rules,
			instance.service,
			snapshot.ctx,
			snapshot.failedSources,
		);
		if (
			policy.kind !== "cleanup" ||
			policy.match.ruleId !== expectedRule.matchedRuleId ||
			policy.match.action !== expectedRule.action
		) {
			throw new Error("The exact matched cleanup policy is no longer authoritative");
		}
		return { snapshot, rawItem, policyItem: item };
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

export async function assertCurrentSeriesPostStepMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	instance: ServiceInstance,
	arrItemId: number,
	expectedRule: { matchedRuleId: string; action: RuleAction },
	authorizedPolicy: AuthorizedSeriesMutationPolicy,
	transition: SeriesMutationTransition,
	getSnapshot: () => Promise<MutationPolicySnapshot> = createMutationPolicySnapshotGetter(
		deps,
		userId,
		authorizedPolicy.snapshot.configFingerprint,
	),
): Promise<Record<string, unknown>> {
	try {
		const currentSnapshot = await getSnapshot();
		assertMutationPolicySnapshotFresh(currentSnapshot);
		if (
			currentSnapshot.configFingerprint !== authorizedPolicy.snapshot.configFingerprint ||
			currentSnapshot.ruleFingerprint !== authorizedPolicy.snapshot.ruleFingerprint ||
			currentSnapshot.providerTopologyFingerprint !==
				authorizedPolicy.snapshot.providerTopologyFingerprint
		) {
			throw new Error(
				"Cleanup rules, settings, or provider topology changed after the first write",
			);
		}
		const { rawItem, item } = await loadLiveSeriesPolicyItem(
			deps,
			instance,
			arrItemId,
			currentSnapshot.rules,
		);
		await assertSeriesMutationInstanceStillCurrent(deps, userId, instance);
		assertExpectedSeriesArrTransition(
			instance,
			authorizedPolicy.rawItem,
			rawItem,
			item,
			transition,
		);

		const cleanupPolicy = evaluateItemMutationPolicyStateViaEngine(
			authorizedPolicy.policyItem,
			currentSnapshot.rules,
			instance.service,
			currentSnapshot.ctx,
			currentSnapshot.failedSources,
		);
		if (
			cleanupPolicy.kind !== "cleanup" ||
			cleanupPolicy.match.ruleId !== expectedRule.matchedRuleId ||
			cleanupPolicy.match.action !== expectedRule.action
		) {
			throw new Error("The exact matched cleanup policy is no longer authoritative");
		}
		const retentionPolicy = evaluateItemMutationPolicyStateViaEngine(
			item,
			currentSnapshot.rules.filter((rule) => rule.retentionMode),
			instance.service,
			currentSnapshot.ctx,
			currentSnapshot.failedSources,
		);
		if (retentionPolicy.kind === "retained") {
			throw new Error("Current retention policy protects the post-step ARR state");
		}
		return rawItem;
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

async function assertSeriesMutationInstanceStillCurrent(
	deps: CleanupExecutorDeps,
	userId: string,
	expected: ServiceInstance,
): Promise<void> {
	const current = await deps.prisma.serviceInstance.findFirst({
		where: { id: expected.id, userId, enabled: true },
	});
	if (
		!current ||
		(current.service !== "RADARR" && current.service !== "SONARR") ||
		createArrServiceFingerprint(current) !== createArrServiceFingerprint(expected)
	) {
		throw new Error("The ARR instance identity changed before the authorized mutation");
	}
}

type ProviderEvidenceAuthority = {
	id: string;
	updatedAt: Date;
	enabled: boolean;
	expectedIdentity: string | null;
	identityStatus: string;
	connectionGeneration: number;
	identityGeneration: number;
};

function hasVerifiedProviderAuthority(instance: ProviderEvidenceAuthority): boolean {
	return (
		instance.enabled &&
		instance.identityStatus === "VERIFIED" &&
		typeof instance.expectedIdentity === "string" &&
		instance.expectedIdentity.length > 0
	);
}

function providerGenerationWhere(instances: ProviderEvidenceAuthority[]) {
	return {
		OR: instances.map((instance) => ({
			instanceId: instance.id,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		})),
	};
}

async function loadCompleteCacheGenerations(
	deps: CleanupExecutorDeps,
	instances: ProviderEvidenceAuthority[],
	cacheType: string,
): Promise<
	| Map<
			string,
			{
				completedAt: Date;
				itemCount: number;
				generationId: string | null;
				generationMetadata: string | null;
			}
	  >
	| undefined
> {
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
			generationId: true,
			generationMetadata: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	const byInstance = new Map(statuses.map((status) => [status.instanceId, status]));
	const nowMs = Date.now();
	const freshnessThreshold = nowMs - PROVIDER_EVIDENCE_FRESHNESS_MS;
	const generations = new Map<
		string,
		{
			completedAt: Date;
			itemCount: number;
			generationId: string | null;
			generationMetadata: string | null;
		}
	>();
	for (const instance of instances) {
		const status = byInstance.get(instance.id);
		if (
			!hasVerifiedProviderAuthority(instance) ||
			!hasAuthoritativeProviderCacheGeneration(status ?? null, instance) ||
			status?.lastResult !== "success" ||
			status.lastErrorMessage != null ||
			status.lastAttemptErrorMessage != null ||
			(status.lastAttemptResult != null && status.lastAttemptResult !== "success") ||
			status.lastRefreshedAt.getTime() > nowMs ||
			status.lastRefreshedAt.getTime() < freshnessThreshold ||
			status.lastRefreshedAt.getTime() < instance.updatedAt.getTime()
		) {
			return undefined;
		}
		generations.set(instance.id, {
			completedAt: status.lastRefreshedAt,
			itemCount: status.itemCount,
			generationId: status.generationId,
			generationMetadata: status.generationMetadata,
		});
	}
	return generations;
}

function parseEpisodeParentGenerationId(metadata: string | null): string | undefined {
	const parsed = safeJsonParse(metadata);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
	const parentGenerationId = (parsed as Record<string, unknown>).parentGenerationId;
	return typeof parentGenerationId === "string" && parentGenerationId.length > 0
		? parentGenerationId
		: undefined;
}

function parsePublishedStringArray(value: string, label: string): string[] {
	const parsed = safeJsonParse(value);
	if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
		throw new Error(`${label} evidence was not a string array`);
	}
	return parsed as string[];
}

// The route returns at most 200 preview rows; avoid live safety I/O for rows
// the caller cannot inspect.
const PREVIEW_SAFETY_INSPECTION_LIMIT = 200;
const DIRECT_RETRY_INVENTORY_LIMIT = 500;
const APPROVAL_SELECTION_PAGE_SIZE = 500;
const INVALID_CLEANUP_RUN_LIMIT_WARNING =
	"Cleanup did not select any items because the stored per-run removal limit is invalid. Set it to a whole number from 1 through 100.";

// Circuit breaker: abort after N consecutive ARR API failures
const CIRCUIT_BREAKER_THRESHOLD = 3;

const SEERR_PREFETCH_MAX_REQUESTS = 5_000;

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

async function startCleanupRunLease(
	deps: CleanupExecutorDeps,
	userId: string,
	configId: string,
): Promise<{
	runClaimToken: string;
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
		runClaimToken,
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

function cleanupAuditTarget(
	approval: Pick<
		LibraryCleanupApproval,
		"action" | "arrEpisodeId" | "arrItemId" | "id" | "instanceId" | "itemType" | "targetScope"
	>,
) {
	const itemType =
		approval.itemType === "movie" || approval.itemType === "series" ? approval.itemType : undefined;
	return {
		kind: "approval",
		id: approval.id,
		instanceId: approval.instanceId,
		...(itemType ? { itemType } : {}),
		arrItemId: approval.arrItemId,
		...(approval.arrEpisodeId === null ? {} : { arrEpisodeId: approval.arrEpisodeId }),
		targetScope: approval.targetScope === "episode" ? "episode" : "series",
	} as const;
}

function cleanupAuditSummary(
	approval: Pick<
		LibraryCleanupApproval,
		| "action"
		| "episodeNumber"
		| "episodeTitle"
		| "matchedRuleId"
		| "matchedRuleName"
		| "reason"
		| "seasonNumber"
		| "targetScope"
		| "title"
	>,
	reason = approval.reason,
) {
	const title =
		approval.targetScope === "episode" &&
		typeof approval.seasonNumber === "number" &&
		typeof approval.episodeNumber === "number"
			? `${approval.title} S${String(approval.seasonNumber).padStart(2, "0")}E${String(approval.episodeNumber).padStart(2, "0")}${approval.episodeTitle ? ` · ${approval.episodeTitle}` : ""}`
			: approval.title;
	return {
		action:
			approval.action === "unmonitor" || approval.action === "delete_files"
				? approval.action
				: "delete",
		title,
		ruleId: approval.matchedRuleId,
		ruleName: approval.matchedRuleName,
		reason,
	} as const;
}

function buildCleanupProposalAuditInput(
	userId: string,
	approval: Pick<
		LibraryCleanupApproval,
		| "action"
		| "arrEpisodeId"
		| "arrItemId"
		| "configId"
		| "episodeNumber"
		| "episodeTitle"
		| "id"
		| "instanceId"
		| "itemType"
		| "matchedRuleId"
		| "matchedRuleName"
		| "reason"
		| "seasonNumber"
		| "targetScope"
		| "title"
	>,
	auditContext: CleanupAuditContext,
): AppendCleanupAuditEventInput {
	const correlationId = `proposal:${approval.id}`;
	const eventType = "proposal_created" as const;
	return {
		userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({
			actionId: approval.id,
			correlationId,
			eventType,
		}),
		actionId: approval.id,
		correlationId,
		actorType: auditContext.actorType,
		...(auditContext.actorId ? { actorId: auditContext.actorId } : {}),
		eventType,
		trigger: auditContext.trigger,
		target: cleanupAuditTarget(approval),
		summary: cleanupAuditSummary(approval),
		outcome: "info",
		evidence: { durableState: "created" },
	};
}

async function ensureCleanupProposalAudit(
	deps: Pick<CleanupExecutorDeps, "prisma">,
	userId: string,
	approval: Parameters<typeof buildCleanupProposalAuditInput>[1],
): Promise<void> {
	const repairInput = buildCleanupProposalAuditInput(userId, approval, {
		actorType: "system",
		trigger: "recovery",
	});
	const existing = await deps.prisma.libraryCleanupAuditEvent.findUnique({
		where: {
			configId_eventKey: {
				configId: approval.configId,
				eventKey: repairInput.eventKey,
			},
		},
		select: { id: true },
	});
	if (existing) return;
	await appendCleanupAuditEvent(deps.prisma, repairInput);
}

function buildCleanupClaimAuditInput(
	userId: string,
	approval: Pick<
		LibraryCleanupApproval,
		| "action"
		| "arrEpisodeId"
		| "arrItemId"
		| "configId"
		| "episodeNumber"
		| "episodeTitle"
		| "id"
		| "instanceId"
		| "itemType"
		| "matchedRuleId"
		| "matchedRuleName"
		| "reason"
		| "seasonNumber"
		| "targetScope"
		| "title"
	>,
	correlationId: string,
	auditContext: CleanupAuditContext,
): AppendCleanupAuditEventInput {
	const eventType = "claim" as const;
	return {
		userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({
			actionId: approval.id,
			correlationId,
			eventType,
		}),
		actionId: approval.id,
		correlationId,
		actorType: auditContext.actorType,
		...(auditContext.actorId ? { actorId: auditContext.actorId } : {}),
		eventType,
		trigger: auditContext.trigger,
		target: cleanupAuditTarget(approval),
		summary: cleanupAuditSummary(approval),
		outcome: "info",
		evidence: { executionClaimed: true },
	};
}

function buildCleanupApprovalReleaseAuditInput(
	userId: string,
	configId: string,
	approvalId: string,
	correlationId: string,
	auditContext: CleanupAuditContext,
): AppendCleanupAuditEventInput {
	const eventType = "recovered" as const;
	return {
		userId,
		configId,
		eventKey: createCleanupAuditEventKey({ actionId: approvalId, correlationId, eventType }),
		actionId: approvalId,
		correlationId,
		actorType: auditContext.actorType,
		...(auditContext.actorId ? { actorId: auditContext.actorId } : {}),
		eventType,
		trigger: auditContext.trigger,
		target: { kind: "approval", id: approvalId },
		summary: {
			reason: "Execution ownership was not secured; returned to pending approval.",
		},
		outcome: "blocked",
		evidence: {
			executionOwnershipSecured: false,
			fromStatus: "approved",
			stateTransitionPersisted: true,
			toStatus: "pending",
		},
	};
}

async function appendCleanupMutationStartedAudit(
	deps: Pick<CleanupExecutorDeps, "prisma">,
	userId: string,
	approval: Parameters<typeof buildCleanupClaimAuditInput>[1],
	correlationId: string,
	auditContext: CleanupAuditContext,
): Promise<void> {
	const eventType = "mutation_started" as const;
	await appendCleanupAuditEvent(deps.prisma, {
		userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({
			actionId: approval.id,
			correlationId,
			eventType,
		}),
		actionId: approval.id,
		correlationId,
		actorType: auditContext.actorType,
		...(auditContext.actorId ? { actorId: auditContext.actorId } : {}),
		eventType,
		trigger: auditContext.trigger,
		target: cleanupAuditTarget(approval),
		summary: cleanupAuditSummary(approval),
		outcome: "info",
		evidence: { durableMutationIntent: true, finalAuthorityPending: true },
	});
}

async function appendCleanupTerminalAudit(
	deps: CleanupExecutorDeps,
	userId: string,
	approval: Parameters<typeof buildCleanupClaimAuditInput>[1],
	correlationId: string,
	outcome: "success" | "blocked" | "failed",
	auditContext: CleanupAuditContext,
	reconciledWithoutMutation = false,
	reason?: string,
): Promise<void> {
	const input = buildCleanupTerminalAuditInput(
		userId,
		approval,
		correlationId,
		outcome,
		auditContext,
		reconciledWithoutMutation,
		reason,
	);
	try {
		await appendCleanupTerminalAuditEvent(deps.prisma, input, {
			approvalId: approval.id,
			status: outcome === "success" ? "executed" : "expired",
		});
	} catch (error) {
		deps.log.warn(
			{ err: error, actionId: input.actionId, eventType: input.eventType },
			"Cleanup terminal audit append failed; its durable envelope remains repairable",
		);
	}
	if (
		outcome === "success" &&
		(approval as { scanMediaServerAfterDelete?: boolean }).scanMediaServerAfterDelete === true
	) {
		await triggerCleanupMediaServerRescansBestEffort(deps, userId, [approval.id]);
	}
}

function cleanupTerminalReason(
	outcome: "success" | "blocked" | "failed",
	reconciledWithoutMutation: boolean,
	reason?: string,
): string {
	if (reason) return reason;
	if (outcome === "success") {
		return reconciledWithoutMutation
			? "Cleanup action was already complete in ARR and was reconciled without another mutation."
			: "Cleanup action completed successfully.";
	}
	return outcome === "blocked"
		? "Current cleanup safety policy blocked this action."
		: "Cleanup action failed.";
}

function buildCleanupTerminalAuditInput(
	userId: string,
	approval: Parameters<typeof buildCleanupClaimAuditInput>[1],
	correlationId: string,
	outcome: "success" | "blocked" | "failed",
	auditContext: CleanupAuditContext,
	reconciledWithoutMutation = false,
	reason?: string,
): AppendCleanupAuditEventInput {
	const eventType = outcome === "success" ? "succeeded" : "failed";
	const terminalReason = cleanupTerminalReason(outcome, reconciledWithoutMutation, reason);
	return {
		userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({
			actionId: approval.id,
			correlationId,
			eventType,
		}),
		actionId: approval.id,
		correlationId,
		actorType: auditContext.actorType,
		...(auditContext.actorId ? { actorId: auditContext.actorId } : {}),
		eventType,
		trigger: auditContext.trigger,
		target: cleanupAuditTarget(approval),
		summary: cleanupAuditSummary(approval, terminalReason),
		outcome,
		evidence: { authoritativeTerminalStatePersisted: true, reconciledWithoutMutation },
	};
}

function buildCleanupTerminalAuditState(
	userId: string,
	approval: Parameters<typeof buildCleanupClaimAuditInput>[1],
	correlationId: string,
	outcome: "success" | "blocked" | "failed",
	auditContext: CleanupAuditContext,
	reconciledWithoutMutation = false,
	reason?: string,
) {
	return createCleanupTerminalAuditState(
		buildCleanupTerminalAuditInput(
			userId,
			approval,
			correlationId,
			outcome,
			auditContext,
			reconciledWithoutMutation,
			reason,
		),
	);
}

const CLEAR_CLEANUP_TERMINAL_AUDIT_STATE = {
	terminalAuditCorrelationId: null,
	terminalAuditEventType: null,
	terminalAuditOutcome: null,
	terminalAuditActorType: null,
	terminalAuditActorId: null,
	terminalAuditTrigger: null,
	terminalAuditReason: null,
	terminalAuditRecordedAt: null,
} as const;

function buildCleanupFailureAuditInput(
	userId: string,
	approval: Parameters<typeof buildCleanupClaimAuditInput>[1],
	correlationId: string,
	auditContext: CleanupAuditContext,
	options: {
		durableStatus: "pending" | "retry_pending";
		mutationAttempted: boolean;
		reason: string;
		outcome?: "blocked" | "failed";
	},
): AppendCleanupAuditEventInput {
	const eventType = "failed" as const;
	return {
		userId,
		configId: approval.configId,
		eventKey: createCleanupAuditEventKey({
			actionId: approval.id,
			correlationId,
			eventType,
		}),
		actionId: approval.id,
		correlationId,
		actorType: auditContext.actorType,
		...(auditContext.actorId ? { actorId: auditContext.actorId } : {}),
		eventType,
		trigger: auditContext.trigger,
		target: cleanupAuditTarget(approval),
		summary: cleanupAuditSummary(approval, options.reason),
		outcome: options.outcome ?? "failed",
		evidence: {
			durableStatus: options.durableStatus,
			mutationAttempted: options.mutationAttempted,
			retryableStatePersisted: true,
		},
	};
}

async function persistCleanupFailureTransition(
	deps: Pick<CleanupExecutorDeps, "prisma">,
	userId: string,
	approval: Parameters<typeof buildCleanupClaimAuditInput>[1],
	executeStatus: "executing" | "retry_executing",
	executionToken: string,
	data: Prisma.LibraryCleanupApprovalUpdateManyMutationInput,
	correlationId: string,
	auditContext: CleanupAuditContext,
	options: Parameters<typeof buildCleanupFailureAuditInput>[4],
): Promise<void> {
	const auditInput = buildCleanupFailureAuditInput(
		userId,
		approval,
		correlationId,
		auditContext,
		options,
	);
	await deps.prisma.$transaction(async (tx) => {
		const update = await tx.libraryCleanupApproval.updateMany({
			where: {
				id: approval.id,
				config: { userId },
				status: executeStatus,
				executionToken,
			},
			data,
		});
		if (update.count !== 1) throw new CleanupApprovalOwnershipLostError();
		await appendCleanupAuditEvent(tx, auditInput);
	});
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
	providerEvidence: SanitizedProviderEvidence,
): string | undefined {
	if (
		safetyPlan?.kind === "verified_sonarr_episode" &&
		error.deletedFileIds.length === 1 &&
		error.deletedFileIds[0] === safetyPlan.selectedFile.episodeFileId
	) {
		return serializeExecutableSafetyPlan(safetyPlan, providerEvidence, "post_partial_mutation");
	}
	if (error.hasRemainingFiles || error.deletedFileIds.length === 0) return undefined;

	if (error.service === "RADARR") {
		if (
			safetyPlan?.kind !== "verified_radarr" ||
			error.deletedFileIds.length !== 1 ||
			error.deletedFileIds[0] !== safetyPlan.file.movieFileId
		) {
			return undefined;
		}
		return serializeExecutableSafetyPlan(safetyPlan, providerEvidence, "post_partial_mutation");
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
			...safetyPlan,
			files: {
				seriesPath: safetyPlan.files.seriesPath,
				episodeFiles: [],
			},
			quiEvidence: undefined,
		},
		providerEvidence,
		"post_partial_mutation",
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
 * (issue #474). Always excludes every active operator/execution state;
 * additionally appends a `rejected`-skip clause when the memory window is non-off. Exported and
 * `now`-parameterised so unit tests can pin the cutoff math without
 * monkey-patching Date.now.
 */
export function buildDedupOrClauses(
	memWindow: RejectionMemoryWindow,
	now: Date = new Date(),
): Prisma.LibraryCleanupApprovalWhereInput[] {
	const clauses: Prisma.LibraryCleanupApprovalWhereInput[] = [
		{ status: "pending", expiresAt: { gt: now } },
		{ status: { in: ["approved", "executing"] } },
	];
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
		targetScope?: string | null;
		arrEpisodeId?: number | null;
		episodeFileId?: number | null;
		seasonNumber?: number | null;
		episodeNumber?: number | null;
		episodeTitle?: string | null;
	},
	action: DetailAction,
	reasonOverride?: string,
): CleanupRunResult["details"][number] {
	return {
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
		episodeFileId: approval.episodeFileId ?? undefined,
		seasonNumber: approval.seasonNumber ?? undefined,
		episodeNumber: approval.episodeNumber ?? undefined,
		sizeOnDisk: approval.sizeOnDisk.toString(),
		year: approval.year,
		rating: null,
	};
}

type CleanupApprovalTarget = {
	instanceId: string;
	arrItemId: number;
	itemType: string;
	targetScope?: string | null;
	arrEpisodeId?: number | null;
	episodeFileId?: number | null;
	action?: string | null;
	safetySnapshot?: string | null;
};

function retryEpisodeFileId(approval: CleanupApprovalTarget): number | undefined {
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

export function cleanupApprovalTargetKey(approval: CleanupApprovalTarget): string {
	return cleanupDeleteTargetKey({
		...approval,
		episodeFileId: retryEpisodeFileId(approval),
	});
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
		const stableNotificationIdentities = (
			notifications: typeof approvedPlan.targetDeleteNotifications,
		) =>
			notifications
				.map((notification) => ({
					plexServerUrl: notification.plexServerUrl,
					onSeriesDelete: notification.onSeriesDelete,
					onEpisodeFileDelete: notification.onEpisodeFileDelete,
				}))
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
	providerEvidence: SanitizedProviderEvidence,
	auditContext: CleanupAuditContext,
): Promise<{
	id: string;
	claimed: boolean;
	executionToken: string;
	executionAuditCorrelationId: string;
}> {
	const executablePlan = asExecutableSafetyPlan(safetyPlan);
	if (!executablePlan) {
		throw new Error("No executable cleanup safety plan was available for the mutation intent");
	}
	const mediaServerScanPolicy = normalizeCleanupMediaServerScanPolicy(item.match);
	const retryEventFingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				serializeExecutableSafetyPlan(executablePlan, providerEvidence),
				item.cacheItem.cachedAt?.toISOString() ?? null,
				item.match.action,
				mediaServerScanPolicy,
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
	const executionAuditCorrelationId = randomUUID();
	let createdIntent: LibraryCleanupApproval | null = null;

	try {
		createdIntent = await deps.prisma.$transaction(async (tx) => {
			const intent = await tx.libraryCleanupApproval.create({
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
					scanMediaServerAfterDelete: mediaServerScanPolicy.scanMediaServerAfterDelete,
					scanMediaServerInstanceIds: mediaServerScanPolicy.scanMediaServerInstanceIds,
					sizeOnDisk: item.cacheItem.sizeOnDisk,
					year: item.cacheItem.year,
					rating: item.rating,
					status: "retry_pending",
					safetySnapshot: serializeExecutableSafetyPlan(executablePlan, providerEvidence),
					lastExecutionError: null,
					expiresAt: new Date(now.getTime() + APPROVAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000),
				},
			});
			await appendCleanupAuditEvent(
				tx,
				buildCleanupProposalAuditInput(userId, intent, auditContext),
			);
			return intent;
		});
	} catch (error) {
		if ((error as { code?: string }).code !== "P2002") throw error;
	}
	const intent =
		createdIntent ??
		(await deps.prisma.libraryCleanupApproval.findFirst({
			where: { id: intentId, config: { userId } },
		}));
	if (!intent) throw new Error("Cleanup mutation intent could not be loaded after persistence");
	if (!createdIntent) {
		await ensureCleanupProposalAudit(deps, userId, intent);
	}

	const claimAuditInput = buildCleanupClaimAuditInput(
		userId,
		intent,
		executionAuditCorrelationId,
		auditContext,
	);
	const claimed = await deps.prisma.$transaction(async (tx) => {
		const claim = await tx.libraryCleanupApproval.updateMany({
			where: {
				id: intentId,
				config: { userId },
				status: "retry_pending",
			},
			data: {
				status: "retry_executing",
				reviewedAt: now,
				executionToken,
				executionAuditCorrelationId,
				reconciledWithoutMutation: false,
				...CLEAR_CLEANUP_TERMINAL_AUDIT_STATE,
			},
		});
		if (claim.count !== 1) return false;
		await appendCleanupAuditEvent(tx, claimAuditInput);
		return true;
	});
	return {
		id: intentId,
		claimed,
		executionToken,
		executionAuditCorrelationId,
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
					peerInventoryComplete: livePlan.peerInventoryComplete,
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
			peerInventoryComplete: livePlan.peerInventoryComplete,
			ownership: livePlan.ownership,
			targetDeleteNotifications: livePlan.targetDeleteNotifications,
		};
	}
	return cachePlan?.kind === "verified_sonarr"
		? {
				...cachePlan,
				quiEvidence: livePlan.quiEvidence,
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
		const targetKey = cleanupDeleteTargetKey(flaggedDeleteTarget(item));
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
			cachePlan = await buildEvaluatedCacheSafetyPlan(
				deps.prisma,
				item.cacheItem,
				livePlan,
				item.episodeTarget,
			);
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
	assertExecutionAllowed?: MutationAuthorityCheck,
	postFileOwnershipPlan?: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_radarr" }>,
): MutationAuthorityCheck {
	let fileDeleteAuthorityConsumed = false;
	const ownershipPlan = safetyPlan.kind === "verified_radarr" ? safetyPlan : postFileOwnershipPlan;

	return async (evidence) => {
		const authorizedResource = await assertExecutionAllowed?.(evidence);
		if (safetyPlan.kind === "verified_radarr_empty") {
			if (postFileOwnershipPlan && postFileOwnershipPlan.ownership.length > 0) {
				await assertVerifiedRadarrPeerOwnershipRetained(
					deps,
					userId,
					target.arrItemId,
					postFileOwnershipPlan,
				);
				return authorizedResource;
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
			return authorizedResource;
		}
		if (!ownershipPlan) return authorizedResource;
		const requiresPhysicalRevalidation =
			ownershipPlan.ownership.length > 0 || ownershipPlan.quiEvidence?.enabled === true;
		if (
			!fileDeleteAuthorityConsumed &&
			safetyPlan.kind === "verified_radarr" &&
			requiresPhysicalRevalidation
		) {
			const context = createSharedPlexSafetyContext();
			const blocks = await findSharedPlexDeleteBlocks(deps, userId, [target], context);
			const livePlan = asExecutableSafetyPlan(context.plans.get(cleanupDeleteTargetKey(target)));
			if (
				blocks.has(cleanupDeleteTargetKey(target)) ||
				!livePlan ||
				!executableSafetyPlansEqual(ownershipPlan, livePlan)
			) {
				throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
					"Skipped for safety: verified Radarr ownership changed, or qUI physical-file evidence changed at the mutation boundary. Run cleanup again before deleting the file.",
				);
			}
			fileDeleteAuthorityConsumed = true;
			return authorizedResource;
		}
		if (ownershipPlan.ownership.length === 0) return authorizedResource;
		await assertVerifiedRadarrPeerOwnershipRetained(deps, userId, target.arrItemId, ownershipPlan);
		return authorizedResource;
	};
}

function createSonarrDestructiveMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	target: CleanupDeleteTarget,
	safetyPlan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr" }>,
	assertExecutionAllowed?: MutationAuthorityCheck,
): MutationAuthorityCheck {
	let fileDeleteAuthorityConsumed = false;
	return async (evidence) => {
		const authorizedResource = await assertExecutionAllowed?.(evidence);
		if (
			fileDeleteAuthorityConsumed &&
			safetyPlan.ownership.length === 0 &&
			safetyPlan.quiEvidence?.enabled === true
		) {
			// qUI-only authority is consumed immediately before the one physical
			// file mutation. Later record-only writes must not stat the removed path.
			return authorizedResource;
		}
		if (fileDeleteAuthorityConsumed && safetyPlan.ownership.length > 0) {
			await assertVerifiedSonarrPeerOwnershipRetained(deps, userId, target.arrItemId, safetyPlan);
			return authorizedResource;
		}
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
				return authorizedResource;
			}
			await assertVerifiedSonarrPeerOwnershipRetained(deps, userId, target.arrItemId, safetyPlan);
			return authorizedResource;
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
				"Skipped for safety: verified Sonarr ownership changed, or qUI physical-file evidence changed at the mutation boundary. Run cleanup again before deleting the file.",
			);
		}
		fileDeleteAuthorityConsumed = true;
		return authorizedResource;
	};
}

function createSonarrEpisodeMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	instance: ServiceInstance,
	target: CleanupDeleteTarget,
	safetyPlan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr_episode" }>,
	expectedRule: { matchedRuleId: string; action: RuleAction },
	assertExecutionAllowed?: MutationAuthorityCheck,
	cleanupRunClaimToken?: string,
): MutationAuthorityCheck {
	let revalidationCount = 0;
	return async () => {
		await assertExecutionAllowed?.();
		await assertCurrentEpisodeMutationAuthority(
			deps,
			userId,
			instance,
			target.arrItemId,
			expectedRule,
			undefined,
			cleanupRunClaimToken,
		);
		const context = createSharedPlexSafetyContext();
		const blocks = await findSharedPlexDeleteBlocks(deps, userId, [target], context);
		const targetKey = cleanupDeleteTargetKey(target);
		const livePlan = asExecutableSafetyPlan(context.plans.get(targetKey));
		const allowMonitoredToUnmonitored =
			target.action === "delete" && revalidationCount > 0 && safetyPlan.episode.monitored === true;
		const plansMatch =
			livePlan?.kind === "verified_sonarr_episode" &&
			(executableSafetyPlansEqual(safetyPlan, livePlan) ||
				episodePlansMatchWithRefreshedWatchProof(
					safetyPlan,
					livePlan,
					allowMonitoredToUnmonitored,
				));
		if (blocks.has(targetKey) || !plansMatch) {
			throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
				"Skipped for safety: the verified Sonarr episode identity, Plex ownership, or qUI physical-file evidence changed at the mutation boundary.",
			);
		}
		if (
			target.action === "delete_files" &&
			livePlan.episode.monitored !== safetyPlan.episode.monitored
		) {
			throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
				"Skipped for safety: the Sonarr episode monitored state changed before file deletion.",
			);
		}
		if (
			target.action === "delete" &&
			revalidationCount > 0 &&
			livePlan.episode.monitored !== false
		) {
			throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
				"Skipped for safety: the Sonarr episode was re-monitored before file deletion.",
			);
		}
		revalidationCount++;
		const liveEpisodeWatchSources = context.liveEpisodeWatchSources.get(targetKey);
		if (!liveEpisodeWatchSources?.length) {
			throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
				"Skipped for safety: the live Plex episode watch counts were unavailable at the mutation boundary.",
			);
		}
		await assertCurrentEpisodeMutationAuthority(
			deps,
			userId,
			instance,
			target.arrItemId,
			expectedRule,
			{ liveEpisodeWatchSources },
			cleanupRunClaimToken,
		);
		await assertExecutionAllowed?.();
		return undefined;
	};
}

async function withQuiPhysicalMutationGuard<T>(
	userId: string,
	respectQuiSeeding: boolean,
	operation: () => Promise<T>,
): Promise<T> {
	return respectQuiSeeding ? withQuiObservationTopologyGuard(userId, operation) : operation();
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
				select: {
					instanceId: true,
					arrItemId: true,
					itemType: true,
					targetScope: true,
					arrEpisodeId: true,
					episodeFileId: true,
					action: true,
					safetySnapshot: true,
				},
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
			[...pendingRetryTargets, ...inFlightRetries].map((retry) => cleanupApprovalTargetKey(retry)),
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

interface DirectSelectionState {
	plan: DirectCleanupSelectionPlan<FlaggedItem, LibraryCleanupApproval>;
	pendingRetryCount: number | null;
	retryStateLoaded: boolean;
	warnings: string[];
}

interface ApprovalSelectionState {
	plan: DirectCleanupSelectionPlan<FlaggedItem, LibraryCleanupApproval>;
	selected: FlaggedItem[];
	skippedDetails: CleanupRunResult["details"];
	pendingRetryCount: number | null;
	inFlightRetryTargetCount: number;
	unmatchedInFlightRetryTargetCount: number;
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
				take: DIRECT_RETRY_INVENTORY_LIMIT + 1,
			}),
			deps.prisma.libraryCleanupApproval.findMany({
				where: { configId, config: { userId }, status: "retry_executing" },
				orderBy: [{ createdAt: "asc" }, { id: "asc" }],
				take: DIRECT_RETRY_INVENTORY_LIMIT + 1,
			}),
		]);
		if (pendingRetries.length + inFlightRetries.length > DIRECT_RETRY_INVENTORY_LIMIT) {
			throw new Error(
				`Durable retry inventory exceeds the safe load limit of ${DIRECT_RETRY_INVENTORY_LIMIT}`,
			);
		}
		const plan = planDirectCleanupSelection<FlaggedItem, LibraryCleanupApproval>({
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
				} pending resume from the Approval Queue or the next live direct cleanup run.`,
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
			plan: planDirectCleanupSelection<FlaggedItem, LibraryCleanupApproval>({
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

function buildDirectSelectionDetails(
	state: DirectSelectionState,
	sharedPlexBlocks: Map<string, string>,
	limit = PREVIEW_SAFETY_INSPECTION_LIMIT,
): CleanupRunResult["details"] {
	const details: CleanupRunResult["details"] = [];
	for (const { value: retry } of state.plan.selectedRetries) {
		if (details.length >= limit) break;
		const action: DetailAction =
			retry.action === "delete" || retry.action === "delete_files" || retry.action === "unmonitor"
				? retry.action
				: "skipped";
		details.push(
			buildRetryDetail(
				retry,
				action,
				"Selected for a retry attempt in the next cleanup run. The outcome depends on live ARR safety checks.",
			),
		);
	}
	for (const { value: item } of state.plan.selectedFresh) {
		if (details.length >= limit) break;
		const safetyReason = sharedPlexBlocks.get(cleanupDeleteTargetKey(flaggedDeleteTarget(item)));
		details.push(buildDetail(item, safetyReason ? "skipped" : item.match.action, safetyReason));
	}
	for (const decision of state.plan.decisions) {
		if (details.length >= limit) break;
		if (decision.disposition === "selected") continue;
		const value = decision.candidate.value;
		details.push(
			"cacheItem" in value
				? buildDetail(value, "skipped", decision.reason)
				: buildRetryDetail(value, "skipped", decision.reason),
		);
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
): Promise<CleanupRunResult> {
	return await withCleanupOperationGuard(() => executeCleanupPreviewGuarded(deps, userId));
}

async function executeCleanupPreviewGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<CleanupRunResult> {
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
			selectionCountsComplete: true,
			previewItemCount: 0,
			previewSelection: {
				selectedFresh: 0,
				selectedRetries: 0,
				deferredBudget: 0,
				deferredApproval: 0,
				deferredRetryFairness: 0,
				deferredInFlightTarget: 0,
				deferredDuplicateTarget: 0,
				inFlight: 0,
				blocked: 0,
				retryStateUnavailable: 0,
				retryState: "complete",
				total: 0,
			},
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: 0,
			details: [],
			durationMs: Date.now() - startTime,
		};
	}

	if (config.rules.length === 0) {
		const retryPreview = await loadDurableRetryPreview(deps, userId, config.id);
		return {
			isDryRun: true,
			status: retryPreview.warning ? "partial" : "completed",
			itemsEvaluated: 0,
			itemsFlagged: 0,
			pendingRetryCount: retryPreview.loaded ? retryPreview.total : null,
			selectionCountsComplete: retryPreview.loaded,
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

	const {
		flagged,
		totalEvaluated,
		prefetchHealth,
		warnings,
		providerEvidence,
		providerEvidenceWarning,
	} = await evaluateCleanupPreviewWithProviderEvidence(deps, userId, config);
	const previewWarnings = providerEvidenceWarning
		? [...warnings, providerEvidenceWarning]
		: warnings;
	if (!config.requireApproval) {
		const configuredRunLimitIsValid =
			Number.isSafeInteger(config.maxRemovalsPerRun) &&
			config.maxRemovalsPerRun > 0 &&
			config.maxRemovalsPerRun <= 100;
		const configuredRunLimit = configuredRunLimitIsValid ? config.maxRemovalsPerRun : 0;
		const directSelection = await loadDirectSelectionState(
			deps,
			userId,
			config.id,
			flagged,
			configuredRunLimit,
		);
		const selectedFresh = directSelection.plan.selectedFresh.map((candidate) => candidate.value);
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
			[
				...previewWarnings,
				...directSelection.warnings,
				...(configuredRunLimitIsValid ? [] : [INVALID_CLEANUP_RUN_LIMIT_WARNING]),
			],
			sharedPlexBlocks.size,
		);
		const details = buildDirectSelectionDetails(directSelection, sharedPlexBlocks);
		const previewSelection = {
			...directSelection.plan.counts,
			blocked: sharedPlexBlocks.size,
		};

		log.info(
			{
				totalEvaluated,
				totalRuleMatches: flagged.length,
				selectedFresh: directSelection.plan.selectedFresh.length,
				selectedRetries: directSelection.plan.selectedRetries.length,
				pendingRetryCount: directSelection.pendingRetryCount,
				sharedPlexBlocks: sharedPlexBlocks.size,
			},
			"Library cleanup preview completed",
		);

		return {
			isDryRun: true,
			status: allWarnings.length > 0 ? "partial" : "completed",
			itemsEvaluated: totalEvaluated,
			itemsFlagged: flagged.length,
			pendingRetryCount: directSelection.pendingRetryCount,
			selectionCountsComplete: directSelection.retryStateLoaded,
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

	const configuredRunLimitIsValid =
		Number.isSafeInteger(config.maxRemovalsPerRun) &&
		config.maxRemovalsPerRun > 0 &&
		config.maxRemovalsPerRun <= 100;
	const configuredRunLimit = configuredRunLimitIsValid ? config.maxRemovalsPerRun : 0;
	const approvalSelection = await loadApprovalSelectionState(
		deps,
		config,
		userId,
		flagged,
		configuredRunLimit,
	);
	const selectedFresh = approvalSelection.selected;
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
		[
			...previewWarnings,
			...approvalSelection.warnings,
			...(configuredRunLimitIsValid ? [] : [INVALID_CLEANUP_RUN_LIMIT_WARNING]),
		],
		sharedPlexBlocks.size,
	);
	const details = [
		...buildCleanupPreviewDetails(selectedFresh, sharedPlexBlocks),
		...approvalSelection.skippedDetails,
	].slice(0, PREVIEW_SAFETY_INSPECTION_LIMIT);
	const additionalInFlightTargets = Math.max(
		0,
		approvalSelection.inFlightRetryTargetCount - approvalSelection.plan.counts.inFlight,
	);
	const previewSelection = {
		...approvalSelection.plan.counts,
		inFlight: approvalSelection.plan.counts.inFlight + additionalInFlightTargets,
		blocked: sharedPlexBlocks.size,
		total: approvalSelection.plan.counts.total + additionalInFlightTargets,
	};

	const hasWarnings = allWarnings.length > 0;
	log.info(
		{
			totalEvaluated,
			totalRuleMatches: flagged.length,
			selectedFresh: approvalSelection.plan.selectedFresh.length,
			pendingRetryCount: approvalSelection.pendingRetryCount,
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
		pendingRetryCount: approvalSelection.pendingRetryCount,
		selectionCountsComplete: approvalSelection.retryStateLoaded,
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
	auditContext: CleanupAuditContext = DEFAULT_SCHEDULED_AUDIT_CONTEXT,
): Promise<CleanupRunResult> {
	return await withCleanupOperationGuard(() =>
		executeCleanupRunGuarded(deps, userId, auditContext),
	);
}

async function executeCleanupRunGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
	auditContext: CleanupAuditContext,
): Promise<CleanupRunResult> {
	const startTime = Date.now();
	const { prisma, log } = deps;

	const config = await prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
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
		const {
			flagged,
			totalEvaluated,
			prefetchHealth,
			warnings,
			providerEvidence,
			providerEvidenceWarning,
		} = await evaluateCleanupPreviewWithProviderEvidence(deps, userId, config);
		const previewWarnings = providerEvidenceWarning
			? [...warnings, providerEvidenceWarning]
			: warnings;
		const configuredRunLimitIsValid =
			Number.isSafeInteger(config.maxRemovalsPerRun) &&
			config.maxRemovalsPerRun > 0 &&
			config.maxRemovalsPerRun <= 100;
		const configuredRunLimit = configuredRunLimitIsValid ? config.maxRemovalsPerRun : 0;
		if (!config.requireApproval) {
			const directSelection = await loadDirectSelectionState(
				deps,
				userId,
				config.id,
				flagged,
				configuredRunLimit,
			);
			const selectedFresh = directSelection.plan.selectedFresh.map((candidate) => candidate.value);
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
				[
					...previewWarnings,
					...directSelection.warnings,
					...(configuredRunLimitIsValid ? [] : [INVALID_CLEANUP_RUN_LIMIT_WARNING]),
				],
				sharedPlexBlocks.size,
			);
			const selectionDeferred = directSelection.plan.decisions.filter(
				(decision) => decision.disposition !== "selected",
			).length;
			const result: CleanupRunResult = {
				isDryRun: true,
				status: allWarnings.length > 0 ? "partial" : "completed",
				itemsEvaluated: totalEvaluated,
				itemsFlagged:
					directSelection.plan.selectedFresh.length + directSelection.plan.selectedRetries.length,
				pendingRetryCount: directSelection.pendingRetryCount ?? undefined,
				itemsRemoved: 0,
				itemsUnmonitored: 0,
				itemsFilesDeleted: 0,
				itemsSkipped: selectionDeferred + sharedPlexBlocks.size,
				details: buildDirectSelectionDetails(directSelection, sharedPlexBlocks),
				durationMs: Date.now() - startTime,
				prefetchHealth,
				warnings: allWarnings,
				providerEvidence,
			};

			await createRunLog(prisma, config.id, result, log);
			return result;
		}
		const approvalSelection = await loadApprovalSelectionState(
			deps,
			config,
			userId,
			flagged,
			configuredRunLimit,
		);
		const selectedFresh = approvalSelection.selected;
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
			[
				...previewWarnings,
				...approvalSelection.warnings,
				...(configuredRunLimitIsValid ? [] : [INVALID_CLEANUP_RUN_LIMIT_WARNING]),
			],
			sharedPlexBlocks.size,
		);
		const details = [
			...buildCleanupPreviewDetails(selectedFresh, sharedPlexBlocks),
			...approvalSelection.skippedDetails,
		].slice(0, PREVIEW_SAFETY_INSPECTION_LIMIT);
		const selectionDeferred =
			approvalSelection.plan.decisions.filter((decision) => decision.disposition !== "selected")
				.length +
			Math.max(
				0,
				approvalSelection.inFlightRetryTargetCount - approvalSelection.plan.counts.inFlight,
			);

		const result: CleanupRunResult = {
			isDryRun: true,
			status: allWarnings.length > 0 ? "partial" : "completed",
			itemsEvaluated: totalEvaluated,
			itemsFlagged: approvalSelection.plan.selectedFresh.length,
			pendingRetryCount: approvalSelection.pendingRetryCount ?? undefined,
			itemsRemoved: 0,
			itemsUnmonitored: 0,
			itemsFilesDeleted: 0,
			itemsSkipped: selectionDeferred + sharedPlexBlocks.size,
			details,
			durationMs: Date.now() - startTime,
			prefetchHealth,
			warnings: allWarnings,
			providerEvidence,
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
		const providerEvidence = await captureCurrentProviderEvidenceAuthority(
			deps,
			userId,
			providerEvidenceDependenciesForRules(config.rules),
		);
		// Real execution
		if (config.requireApproval) {
			const configuredRunLimitIsValid =
				Number.isSafeInteger(config.maxRemovalsPerRun) &&
				config.maxRemovalsPerRun > 0 &&
				config.maxRemovalsPerRun <= 100;
			const configuredRunLimit = configuredRunLimitIsValid ? config.maxRemovalsPerRun : 0;
			const approvalSelection = await loadApprovalSelectionState(
				deps,
				config,
				userId,
				flagged,
				configuredRunLimit,
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
				[
					...warnings,
					...approvalSelection.warnings,
					...(configuredRunLimitIsValid ? [] : [INVALID_CLEANUP_RUN_LIMIT_WARNING]),
				],
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
				approvalSelection.skippedDetails,
				approvalSelection.unmatchedInFlightRetryTargetCount,
				auditContext,
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
			runLease.runClaimToken,
			providerEvidence,
			auditContext,
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
	auditContext: CleanupAuditContext = {
		actorType: "operator",
		actorId: userId,
		trigger: "approval",
	},
): Promise<{ removed: number; failed: number; errors: string[] }> {
	return await withCleanupOperationGuard(() =>
		executeApprovedItemsGuarded(deps, userId, approvalIds, approvalRequestToken, auditContext),
	);
}

async function executeApprovedItemsGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
	approvalIds: string[],
	approvalRequestToken?: string,
	auditContext: CleanupAuditContext = {
		actorType: "operator",
		actorId: userId,
		trigger: "approval",
	},
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
	const releaseAuditCorrelationId = approvalRequestToken ?? randomUUID();
	const releaseUnclaimedApprovals = (ids: string[]) =>
		deps.prisma.$transaction(async (tx) => {
			let released = 0;
			for (const approvalId of [...new Set(ids)]) {
				const result = await tx.libraryCleanupApproval.updateMany({
					where: {
						id: approvalId,
						config: { userId },
						status: "approved",
						...(approvalRequestToken ? { executionToken: approvalRequestToken } : {}),
					},
					data: {
						status: "pending",
						executionToken: null,
						lastExecutionError:
							"Cleanup execution did not claim this approved item; retry approval.",
					},
				});
				if (result.count !== 1) continue;
				await appendCleanupAuditEvent(
					tx,
					buildCleanupApprovalReleaseAuditInput(
						userId,
						config.id,
						approvalId,
						releaseAuditCorrelationId,
						auditContext,
					),
				);
				released++;
			}
			return { count: released };
		});

	let runLease: Awaited<ReturnType<typeof startCleanupRunLease>>;
	try {
		runLease = await startCleanupRunLease(deps, userId, config.id);
	} catch (error) {
		await releaseUnclaimedApprovals(approvalIds);
		throw error;
	}

	let approvalsToRelease = approvalIds;
	try {
		const result = await executeQueuedCleanupItems(deps, userId, approvalIds, {
			claimStatus: "approved",
			executeStatus: "executing",
			retryStatus: "pending",
			enforceExpiry: true,
			assertExecutionAllowed: runLease.assertOwnership,
			claimExecutionToken: approvalRequestToken,
			cleanupRunClaimToken: runLease.runClaimToken,
			auditContext,
		});
		approvalsToRelease = [...result.unclaimedIds, ...result.claimFailedIds];
		const unclaimedErrors = result.unclaimedIds.map(
			() => "Cleanup approval was not found, expired, no longer approved, or changed ownership.",
		);
		return {
			removed: result.removed,
			failed: result.failed + unclaimedErrors.length,
			errors: [...result.errors, ...unclaimedErrors],
		};
	} finally {
		await releaseUnclaimedApprovals(approvalsToRelease).catch((error) => {
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
	auditContext: CleanupAuditContext = {
		actorType: "operator",
		actorId: userId,
		trigger: "retry",
	},
): Promise<{ removed: number; reconciled: number; failed: number; errors: string[] }> {
	return await withCleanupOperationGuard(() =>
		executeRetryItemsGuarded(deps, userId, retryIds, auditContext),
	);
}

async function executeRetryItemsGuarded(
	deps: CleanupExecutorDeps,
	userId: string,
	retryIds: string[],
	auditContext: CleanupAuditContext,
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
			cleanupRunClaimToken: runLease.runClaimToken,
			auditContext,
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
	claimFailedIds: string[];
	mutationBudgetConsumedIds: string[];
	confirmedPartialFileDeletionIds: string[];
}

async function retryTargetRecordIsAbsent(
	deps: CleanupExecutorDeps,
	instance: ServiceInstance,
	arrItemId: number,
	safetySnapshot: unknown,
	action: RuleAction,
): Promise<"record_absent" | "episode_action_complete" | false> {
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
			await (client as InstanceType<typeof RadarrClient>).movie.getById(arrItemId);
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
				return false;
			}
			if (episodes.some((episode) => episode.episodeFileId === plan.selectedFile.episodeFileId)) {
				throw new ArrTargetChangedDuringSafetyCheckError();
			}
			const episodeFiles = await sonarr.episodeFile.getBySeries(arrItemId);
			if (episodeFiles.some((file) => file.id === plan.selectedFile.episodeFileId)) return false;
			if (action === "delete" && selected.monitored !== false) return false;
			return "episode_action_complete";
		}
	}
	return false;
}

function liveSonarrRuleTypes(rule: LibraryCleanupRule): string[] | null {
	if (!rule.operator && !rule.conditions) return [rule.ruleType];
	if (!rule.operator || !rule.conditions) return null;
	const conditions = safeJsonParse(rule.conditions) as Array<{ ruleType?: unknown }> | null;
	if (!Array.isArray(conditions) || conditions.length === 0) return null;
	const ruleTypes = conditions.map((condition) => condition.ruleType);
	return ruleTypes.every((ruleType): ruleType is string => typeof ruleType === "string")
		? ruleTypes
		: null;
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
	ctx: EvalContext,
): boolean {
	if (
		ruleType.startsWith("seerr_") &&
		ruleType !== "seerr_requester_watched" &&
		ruleType !== "seerr_requester_not_watched"
	) {
		return ctx.seerrMap !== undefined;
	}
	if (ruleType === "seerr_requester_watched" || ruleType === "seerr_requester_not_watched") {
		return ctx.seerrMap !== undefined && ctx.plexMap !== undefined;
	}
	// Episode-completion caches are intentionally bounded background indexes,
	// not complete live evidence for a destructive parent-policy decision.
	if (ruleType === "plex_episode_completion") return false;
	if (
		ruleType.startsWith("plex_") ||
		ruleType === "user_retention" ||
		ruleType === "staleness_score" ||
		ruleType === "recently_active"
	) {
		return ctx.plexMap !== undefined;
	}
	if (ruleType === "jellyfin_episode_completion") return false;
	if (ruleType.startsWith("jellyfin_")) return ctx.jellyfinMap !== undefined;
	// List memberships are background caches without a source-bound live
	// refresh at this mutation boundary, so they cannot prove a non-match.
	if (ruleType === "tmdb_list_member" || ruleType === "trakt_list_member") return false;
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
		case "imdb_rating":
			return (
				typeof rawSeries.ratings === "object" &&
				rawSeries.ratings !== null &&
				!Array.isArray(rawSeries.ratings)
			);
		case "status":
			return typeof rawSeries.status === "string" && rawSeries.status.trim().length > 0;
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
				return typeof (rawSeries.originalLanguage as Record<string, unknown>).name === "string";
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
			return (
				(typeof rawSeries.path === "string" && rawSeries.path.length > 0) ||
				(typeof rawSeries.rootFolderPath === "string" && rawSeries.rootFolderPath.length > 0)
			);
		case "tag_match":
			return hasCompleteLiveSonarrTags(rawSeries);
		default:
			return false;
	}
}

function liveSonarrRuleApplies(
	rawSeries: Record<string, unknown>,
	item: CacheItemForEval,
	rule: LibraryCleanupRule,
): boolean {
	if (!passesCleanupRuleFilters(item, { ...rule, excludeTags: null }, "SONARR")) return false;
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

function assertCompleteLiveSonarrSeriesRuleEvidence(
	rawSeries: Record<string, unknown>,
	item: CacheItemForEval,
	rules: LibraryCleanupRule[],
	ctx: EvalContext,
): void {
	if (typeof rawSeries.title !== "string" || rawSeries.title.trim().length === 0) {
		throw new Error("Live Sonarr series title was unavailable");
	}
	for (const rule of rules) {
		if (!liveSonarrRuleApplies(rawSeries, item, rule)) continue;
		const ruleTypes = liveSonarrRuleTypes(rule);
		if (
			ruleUsesUnavailableData(rule, new Set()) ||
			!ruleTypes ||
			ruleTypes.some(
				(ruleType) => !hasCompleteLiveSonarrEvidenceForRuleType(rawSeries, ruleType, ctx),
			)
		) {
			throw new Error(`Current evidence was unavailable for series rule ${rule.id}`);
		}
	}
}

async function assertCurrentEpisodeMutationAuthority(
	deps: CleanupExecutorDeps,
	userId: string,
	instance: ServiceInstance,
	arrSeriesId: number,
	expectedRule: { matchedRuleId: string; action: RuleAction },
	evidence?: { liveEpisodeWatchSources: VerifiedEpisodePlexWatchSource[] },
	cleanupRunClaimToken?: string,
): Promise<void> {
	const config = await deps.prisma.libraryCleanupConfig.findUnique({
		where: { userId },
		include: { rules: { orderBy: [{ priority: "asc" }, { id: "asc" }] } },
	});
	if (!config) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the cleanup configuration changed after this episode was queued.",
		);
	}

	const currentSeriesRules = config.rules.filter(
		(rule) => rule.enabled && rule.targetScope !== "episode",
	);
	const seriesRetentionRules = currentSeriesRules.filter((rule) => rule.retentionMode);
	const seriesCleanupRules = currentSeriesRules.filter((rule) => !rule.retentionMode);
	const currentEpisodeRule = config.rules.find((rule) => rule.id === expectedRule.matchedRuleId);
	if (
		!currentEpisodeRule ||
		!isSupportedEpisodeCleanupRule(currentEpisodeRule) ||
		currentEpisodeRule.action !== expectedRule.action
	) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the matched episode cleanup rule changed after this item was queued.",
		);
	}

	let item: CacheItemForEval;
	let rawSeries: Record<string, unknown>;
	let currentSeriesContext: EvalContext;
	try {
		currentSeriesContext = await buildEvalContext(deps, userId, currentSeriesRules, {
			destructiveAuthority: true,
			cleanupRunClaimToken,
		});
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
				...rawSeries,
				...liveSeries,
				statistics: {
					...(typeof rawSeries.statistics === "object" && rawSeries.statistics !== null
						? (rawSeries.statistics as Record<string, unknown>)
						: {}),
					...liveSeries.statistics,
				},
				_arrDashboardSource: { serviceFingerprint: createArrServiceFingerprint(instance) },
			}),
			infoHash: null,
			torrentState: null,
		};
		assertCompleteLiveSonarrSeriesRuleEvidence(
			rawSeries,
			item,
			currentSeriesRules,
			currentSeriesContext,
		);
		if (!liveSonarrRuleApplies(rawSeries, item, currentEpisodeRule)) {
			throw new Error("The matched episode cleanup rule no longer applies to the live series");
		}
		const currentSeriesMatch = seriesCleanupRules.find(
			(rule) =>
				liveSonarrRuleApplies(rawSeries, item, rule) &&
				evaluateRuleViaEngine(item, rule, "SONARR", currentSeriesContext) !== null,
		);
		if (currentSeriesMatch) {
			throw new Error(
				`Series rule ${currentSeriesMatch.id} now takes precedence over episode cleanup`,
			);
		}
		if (evidence) {
			const currentMatch = config.rules.find((rule) => {
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
				currentMatch.action !== expectedRule.action
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

	if (
		seriesRetentionProtectsEpisode(
			item,
			seriesRetentionRules,
			currentSeriesContext,
			new Set<DataSourceDependency>(),
		)
	) {
		throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
			"Skipped for safety: the parent series is protected by the current retention policy or its required evidence is unavailable.",
		);
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
		cleanupRunClaimToken?: string;
		auditContext: CleanupAuditContext;
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
		},
	});
	const currentRespectQuiSeeding = currentConfig?.respectQuiSeeding === true;
	const expectedConfigFingerprint = currentConfig
		? completeMutationConfigFingerprint(currentConfig)
		: undefined;
	const getMutationPolicySnapshot = createMutationPolicySnapshotGetter(
		deps,
		userId,
		expectedConfigFingerprint,
		options.cleanupRunClaimToken,
	);

	// Atomically transition approved → executing to prevent double-execution
	// Also enforce expiry — don't execute items past their expiration
	const now = new Date();
	const claimedApprovalIds: string[] = [];
	const claimedApprovals: LibraryCleanupApproval[] = [];
	const claimedApprovalTokens = new Map<string, string>();
	const claimedAuditCorrelationIds = new Map<string, string>();
	const mutationAttemptedApprovalIds = new Set<string>();
	const mutationBudgetConsumedIds = new Set<string>();
	const confirmedPartialFileDeletionIds = new Set<string>();
	const unclaimedIds: string[] = [];
	const claimFailedIds: string[] = [];
	const claimErrors: string[] = [];
	for (const approvalId of [...new Set(approvalIds)]) {
		try {
			const executionToken = randomUUID();
			const executionAuditCorrelationId = options.claimExecutionToken ?? randomUUID();
			const claimWhere = {
				id: approvalId,
				config: { userId },
				status: options.claimStatus,
				...(options.claimExecutionToken ? { executionToken: options.claimExecutionToken } : {}),
				...(options.enforceExpiry ? { expiresAt: { gt: now } } : {}),
			} as const;
			const [approval] = await prisma.libraryCleanupApproval.findMany({
				where: claimWhere,
				take: 1,
			});
			if (!approval) {
				unclaimedIds.push(approvalId);
				continue;
			}
			const claimAuditInput = buildCleanupClaimAuditInput(
				userId,
				approval,
				executionAuditCorrelationId,
				options.auditContext,
			);
			const claimed = await prisma.$transaction(async (tx) => {
				const claim = await tx.libraryCleanupApproval.updateMany({
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
						executionAuditCorrelationId,
						reconciledWithoutMutation: false,
						...CLEAR_CLEANUP_TERMINAL_AUDIT_STATE,
					},
				});
				if (claim.count !== 1) return false;
				await appendCleanupAuditEvent(tx, claimAuditInput);
				return true;
			});
			if (claimed) {
				claimedApprovalIds.push(approvalId);
				claimedApprovals.push(approval);
				claimedApprovalTokens.set(approvalId, executionToken);
				claimedAuditCorrelationIds.set(approvalId, executionAuditCorrelationId);
			} else unclaimedIds.push(approvalId);
		} catch (error) {
			claimErrors.push("A cleanup approval could not be claimed and was not executed.");
			claimFailedIds.push(approvalId);
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
			claimFailedIds,
			mutationBudgetConsumedIds: [],
			confirmedPartialFileDeletionIds: [],
		};
	}

	try {
		const approvals = claimedApprovals;

		let removed = 0;
		let failed = claimErrors.length;
		const errors: string[] = [...claimErrors];
		const expiredIds: string[] = [];
		const recordingFailureIds: string[] = [];
		const reconciledIds: string[] = [];
		const sharedPlexSafetyContext = createSharedPlexSafetyContext();

		for (const approval of approvals) {
			const claimedExecutionToken = claimedApprovalTokens.get(approval.id);
			const executionAuditCorrelationId = claimedAuditCorrelationIds.get(approval.id);
			if (!claimedExecutionToken || !executionAuditCorrelationId) {
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
				const executionError =
					"Cleanup item was not executed because its ARR instance could not be loaded.";
				errors.push(executionError);
				failed++;
				try {
					await persistCleanupFailureTransition(
						deps,
						userId,
						approval,
						options.executeStatus,
						claimedExecutionToken,
						{
							status: options.retryStatus,
							executionToken: null,
							lastExecutionError: executionError,
						},
						executionAuditCorrelationId,
						options.auditContext,
						{
							durableStatus: options.retryStatus,
							mutationAttempted: false,
							outcome: "blocked",
							reason: executionError,
						},
					);
				} catch (revertErr) {
					log.warn(
						{ err: revertErr, approvalId: approval.id },
						"Failed to return approval with missing instance to pending",
					);
				}
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
				try {
					await persistCleanupFailureTransition(
						deps,
						userId,
						approval,
						options.executeStatus,
						claimedExecutionToken,
						{
							status: options.retryStatus,
							executionToken: null,
							lastExecutionError: executionError,
						},
						executionAuditCorrelationId,
						options.auditContext,
						{
							durableStatus: options.retryStatus,
							mutationAttempted: false,
							outcome: "blocked",
							reason: executionError,
						},
					);
				} catch (revertErr) {
					log.warn(
						{ err: revertErr, approvalId: approval.id },
						"Failed to return invalid approval to pending",
					);
				}
				continue;
			}

			let sharedPlexBlock: string | undefined;
			let approvalIdentityChanged = false;
			const approvedEnvelope = parseExecutableSafetyEnvelope(approval.safetySnapshot);
			let approvedPlan = approvedEnvelope?.plan ?? null;
			let approvedProviderEvidence = approvedEnvelope?.providerEvidence;
			let safetyPlan: SharedMediaSafetyPlan | undefined = approvedPlan ?? undefined;
			const durableEpisodePostPartialMutation =
				approvedEnvelope?.mutationCheckpoint === "post_partial_mutation" &&
				approvedPlan?.kind === "verified_sonarr_episode" &&
				action === "delete";
			let recoveringEpisodeUnmonitorPartial =
				approval.lastExecutionError === SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE;
			let postFileOwnershipPlan:
				| Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_radarr" }>
				| undefined;
			const recoveringInterruptedMutation =
				options.claimStatus === "retry_pending" ||
				approval.lastExecutionError === INTERRUPTED_CLEANUP_RECOVERY_MESSAGE ||
				recoveringEpisodeUnmonitorPartial;
			if (
				!approvedPlan ||
				approvedPlan.target.serviceFingerprint !== createArrServiceFingerprint(instance)
			) {
				approvalIdentityChanged = true;
				sharedPlexBlock =
					"Skipped for safety: the ARR target identity changed after this cleanup item was queued. Run cleanup again and review a new approval.";
			}
			if (!sharedPlexBlock && approvedProviderEvidence) {
				try {
					if (
						recoveringInterruptedMutation &&
						approvedEnvelope?.mutationCheckpoint === "post_partial_mutation" &&
						!durableEpisodePostPartialMutation
					) {
						approvedProviderEvidence = await renewCurrentProviderRetryAuthority(
							deps,
							userId,
							approvedProviderEvidence,
							options.assertExecutionAllowed,
						);
						await updateClaimedCleanupApproval(
							prisma,
							userId,
							approval.id,
							options.executeStatus,
							claimedExecutionToken,
							{
								safetySnapshot: serializeExecutableSafetyPlan(
									approvedPlan!,
									approvedProviderEvidence,
								),
							},
						);
					} else {
						await assertCurrentProviderEvidenceAuthority(
							deps,
							userId,
							approvedProviderEvidence,
							options.assertExecutionAllowed,
						);
					}
				} catch (error) {
					approvalIdentityChanged = true;
					sharedPlexBlock =
						"Skipped for safety: the provider evidence used by this cleanup decision changed. Run cleanup again and review a new approval.";
					log.warn(
						{ err: error, approvalId: approval.id },
						"Approved cleanup item lost provider evidence authority",
					);
				}
			}
			const approvedEpisodeRefreshTime =
				approvedPlan?.kind === "verified_sonarr_episode"
					? Date.parse(approvedPlan.watchProof.refreshedAt)
					: null;
			if (
				approvedPlan?.kind === "verified_sonarr_episode" &&
				!recoveringInterruptedMutation &&
				(approvedEpisodeRefreshTime === null ||
					!Number.isFinite(approvedEpisodeRefreshTime) ||
					approvedEpisodeRefreshTime > now.getTime() ||
					approvedEpisodeRefreshTime < now.getTime() - PLEX_EPISODE_FRESHNESS_MS)
			) {
				approvalIdentityChanged = true;
				sharedPlexBlock =
					"Skipped for safety: the approved Plex episode evidence expired; run cleanup again and review a new approval.";
			}
			let retryTargetAlreadyAbsent: "record_absent" | "episode_action_complete" | false = false;
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
						files: { seriesPath: approvedPlan.files.seriesPath, episodeFiles: [] },
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
								approvedProviderEvidence!,
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
						const preflightTarget: CleanupDeleteTarget = {
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
						const targetKey = cleanupDeleteTargetKey(preflightTarget);
						const blocks = await findSharedPlexDeleteBlocks(
							deps,
							userId,
							[preflightTarget],
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
								episode: { ...livePlan.episode, monitored: approvedPlan.episode.monitored },
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
							recoveringEpisodeUnmonitorPartial = true;
						}
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
						if (!exactPlanMatch && !idempotentEpisodeUnmonitorMatch && !recoverableFileRemainder) {
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
											approvedProviderEvidence!,
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
					if (approvalIdentityChanged) {
						await updateClaimedCleanupApproval(
							prisma,
							userId,
							approval.id,
							options.executeStatus,
							claimedExecutionToken,
							{
								status: "expired",
								executionToken: null,
								reviewedAt: new Date(),
								lastExecutionError: sharedPlexBlock,
								...buildCleanupTerminalAuditState(
									userId,
									approval,
									executionAuditCorrelationId,
									"blocked",
									options.auditContext,
									false,
									sharedPlexBlock,
								),
							},
						);
						expiredIds.push(approval.id);
						await appendCleanupTerminalAudit(
							deps,
							userId,
							approval,
							executionAuditCorrelationId,
							"blocked",
							options.auditContext,
							false,
							sharedPlexBlock,
						);
					} else {
						await persistCleanupFailureTransition(
							deps,
							userId,
							approval,
							options.executeStatus,
							claimedExecutionToken,
							{
								status: options.retryStatus,
								executionToken: null,
								lastExecutionError: sharedPlexBlock,
							},
							executionAuditCorrelationId,
							options.auditContext,
							{
								durableStatus: options.retryStatus,
								mutationAttempted: false,
								outcome: "blocked",
								reason: sharedPlexBlock,
							},
						);
					}
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
			let mutationStartedAuditAttempted = false;
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
				const expectedRule = expectedMutationRule(approval.matchedRuleId, action, approval);
				await assertCurrentMediaServerScanRuleAuthority(deps, userId, expectedRule);
				await prepareCleanupMediaServerRescans(deps, userId, approval);
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
				let authorizedSeriesPolicy: AuthorizedSeriesMutationPolicy | undefined;
				const assertMutationAuthority: MutationAuthorityCheck = async (evidence) => {
					await options.assertExecutionAllowed?.();
					let authorizedResource: Record<string, unknown> | undefined;
					if (safetyPlan!.kind !== "verified_sonarr_episode") {
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
							authorizedSeriesPolicy = await assertCurrentSeriesMutationAuthority(
								deps,
								userId,
								mutationInstance,
								approval.arrItemId,
								expectedRule,
								await getMutationPolicySnapshot(),
							);
							authorizedResource = authorizedSeriesPolicy.rawItem;
						} else {
							authorizedResource = await assertCurrentSeriesPostStepMutationAuthority(
								deps,
								userId,
								mutationInstance,
								approval.arrItemId,
								expectedRule,
								authorizedSeriesPolicy,
								evidence.seriesTransition,
								getMutationPolicySnapshot,
							);
						}
					}
					mutationBudgetConsumedIds.add(approval.id);
					return authorizedResource;
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
				const assertDestructiveMutationAuthority =
					safetyPlan?.kind === "verified_sonarr_episode"
						? createSonarrEpisodeMutationAuthority(
								deps,
								userId,
								mutationInstance,
								mutationTarget,
								safetyPlan,
								expectedRule,
								assertMutationAuthority,
								options.cleanupRunClaimToken,
							)
						: mutationInstance.service === "RADARR"
							? createRadarrDestructiveMutationAuthority(
									deps,
									userId,
									mutationTarget,
									safetyPlan!,
									assertMutationAuthority,
									postFileOwnershipPlan,
								)
							: mutationInstance.service === "SONARR" && safetyPlan?.kind === "verified_sonarr"
								? createSonarrDestructiveMutationAuthority(
										deps,
										userId,
										mutationTarget,
										safetyPlan,
										assertMutationAuthority,
									)
								: assertMutationAuthority;
				const assertMutationAuthorityWithAudit: MutationAuthorityCheck = async (evidence) => {
					if (!mutationStartedAuditAttempted) {
						mutationStartedAuditAttempted = true;
						await appendCleanupMutationStartedAudit(
							deps,
							userId,
							approval,
							executionAuditCorrelationId,
							options.auditContext,
						);
					}
					return await assertDestructiveMutationAuthority(evidence);
				};

				if (retryTargetAlreadyAbsent) {
					executionCompleted = true;
					reconciledWithoutMutation = true;
					if (
						safetyPlan!.kind === "verified_sonarr_episode" &&
						retryTargetAlreadyAbsent === "episode_action_complete" &&
						action !== "unmonitor"
					) {
						await reconcileSonarrEpisodeFileCache(
							prisma,
							mutationInstance,
							approval.arrItemId,
							log,
							safetyPlan!.selectedFile.episodeFileId,
						);
					} else if (retryTargetAlreadyAbsent === "record_absent") {
						await reconcileSonarrEpisodeFileCache(
							prisma,
							mutationInstance,
							approval.arrItemId,
							log,
						);
					}
					if (retryTargetAlreadyAbsent === "record_absent")
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
						assertMutationAuthorityWithAudit,
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
								assertMutationAuthorityWithAudit,
							),
					);
					executionCompleted = true;
					// A false result is the existing live-verified already-empty branch;
					// no upstream write was issued, so this is reconciliation rather than removal.
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
								assertMutationAuthorityWithAudit,
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
						executedAt: new Date(),
						lastExecutionError: null,
						reconciledWithoutMutation,
						...buildCleanupTerminalAuditState(
							userId,
							approval,
							executionAuditCorrelationId,
							"success",
							options.auditContext,
							reconciledWithoutMutation,
						),
					},
				);
				await appendCleanupTerminalAudit(
					deps,
					userId,
					approval,
					executionAuditCorrelationId,
					"success",
					options.auditContext,
					reconciledWithoutMutation,
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
					const leaseError = "Cleanup execution paused because its database run lease was lost.";
					try {
						await persistCleanupFailureTransition(
							deps,
							userId,
							approval,
							options.executeStatus,
							claimedExecutionToken,
							{
								status: options.retryStatus,
								executionToken: null,
								lastExecutionError: leaseError,
							},
							executionAuditCorrelationId,
							options.auditContext,
							{
								durableStatus: options.retryStatus,
								mutationAttempted: mutationStartedAuditAttempted,
								reason: leaseError,
							},
						);
					} catch (revertErr) {
						log.error(
							{ err: revertErr, approvalId: approval.id },
							"Cleanup lost its run lease and could not return the item to retryable state",
						);
					}
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
								reconciledWithoutMutation,
								...buildCleanupTerminalAuditState(
									userId,
									approval,
									executionAuditCorrelationId,
									"success",
									options.auditContext,
									reconciledWithoutMutation,
								),
							},
						);
						await appendCleanupTerminalAudit(
							deps,
							userId,
							approval,
							executionAuditCorrelationId,
							"success",
							options.auditContext,
							reconciledWithoutMutation,
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
				const preserveEpisodeUnmonitorPartial =
					recoveringEpisodeUnmonitorPartial &&
					error instanceof ArrMutationAuthorityChangedDuringSafetyCheckError;
				const episodeFileDeletePartial =
					error instanceof ArrDeletePartialError &&
					(action === "delete" || action === "delete_files") &&
					safetyPlan?.kind === "verified_sonarr_episode";
				const executionError = preserveEpisodeUnmonitorPartial
					? SONARR_EPISODE_UNMONITOR_PARTIAL_MESSAGE
					: error instanceof CleanupExemptionAuthorityError ||
							error instanceof ArrFileChangedDuringSafetyCheckError ||
							error instanceof ArrDeletePartialError ||
							error instanceof SonarrEpisodeUnmonitorPartialError ||
							error instanceof SonarrEpisodeUnmonitorOutcomeUnknownError
						? error.message
						: "Cleanup item could not be executed. Review the API logs for details.";
				const mutationAuthorityChanged =
					(error instanceof ArrMutationAuthorityChangedDuringSafetyCheckError &&
						!preserveEpisodeUnmonitorPartial) ||
					(error instanceof CleanupExemptionAuthorityError &&
						options.claimStatus === "retry_pending");
				errors.push(executionError);
				failed++;
				const postPartialRetrySnapshot =
					error instanceof ArrDeletePartialError
						? buildPostPartialRetrySnapshot(safetyPlan, error, approvedProviderEvidence!)
						: undefined;
				const postEpisodeUnmonitorSnapshot =
					error instanceof SonarrEpisodeUnmonitorPartialError || preserveEpisodeUnmonitorPartial
						? serializeExecutableSafetyPlan(
								approvedPlan!,
								approvedProviderEvidence!,
								"post_partial_mutation",
							)
						: undefined;
				if (error instanceof ArrDeletePartialError && error.deletedFileIds.length > 0) {
					confirmedPartialFileDeletionIds.add(approval.id);
				}
				const nextFailureStatus =
					error instanceof SonarrEpisodeUnmonitorPartialError ||
					error instanceof SonarrEpisodeUnmonitorOutcomeUnknownError ||
					episodeFileDeletePartial ||
					preserveEpisodeUnmonitorPartial
						? ("retry_pending" as const)
						: mutationAuthorityChanged
							? ("expired" as const)
							: options.retryStatus;
				log.error(
					{ err: error, title: approval.title, instanceId: approval.instanceId },
					"Failed to execute approved cleanup item",
				);
				let retryStatePersisted = false;
				try {
					if (mutationAuthorityChanged) {
						await updateClaimedCleanupApproval(
							prisma,
							userId,
							approval.id,
							options.executeStatus,
							claimedExecutionToken,
							{
								status: "expired",
								executionToken: null,
								lastExecutionError: executionError,
								reviewedAt: new Date(),
								...buildCleanupTerminalAuditState(
									userId,
									approval,
									executionAuditCorrelationId,
									"blocked",
									options.auditContext,
									false,
									executionError,
								),
							},
						);
						expiredIds.push(approval.id);
						await appendCleanupTerminalAudit(
							deps,
							userId,
							approval,
							executionAuditCorrelationId,
							"blocked",
							options.auditContext,
							false,
							executionError,
						);
					} else {
						await persistCleanupFailureTransition(
							deps,
							userId,
							approval,
							options.executeStatus,
							claimedExecutionToken,
							{
								status: nextFailureStatus,
								executionToken: null,
								lastExecutionError: executionError,
								...(postPartialRetrySnapshot || postEpisodeUnmonitorSnapshot
									? {
											safetySnapshot: postPartialRetrySnapshot ?? postEpisodeUnmonitorSnapshot,
										}
									: {}),
							},
							executionAuditCorrelationId,
							options.auditContext,
							{
								durableStatus: nextFailureStatus === "retry_pending" ? "retry_pending" : "pending",
								mutationAttempted: mutationStartedAuditAttempted,
								reason: executionError,
							},
						);
					}
					retryStatePersisted = true;
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
			claimFailedIds,
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
 * Prefetch all requests from every enabled Seerr instance and build a lookup
 * map keyed by "movie:tmdbId" or "tv:tmdbId". A capped or failed read returns
 * undefined so mutation authority cannot treat an incomplete result as a
 * proven non-match.
 */
export async function prefetchSeerrRequests(
	deps: CleanupExecutorDeps,
	userId: string,
): Promise<SeerrRequestMap | undefined> {
	const { prisma, arrClientFactory, log } = deps;

	const seerrInstances = await prisma.serviceInstance.findMany({
		where: { userId, service: "SEERR", enabled: true },
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

	if (seerrInstances.length === 0) return undefined;

	try {
		const map: SeerrRequestMap = new Map();

		for (const seerrInstance of seerrInstances) {
			const client = new SeerrClient(arrClientFactory, seerrInstance, log);
			// Seerr accepts an arbitrary `take` value. Fetching the bounded set in
			// one request avoids offset-pagination drift while establishing a live
			// destructive non-match. The extra sentinel item detects overflow.
			const result = await client.getRequests({ take: SEERR_PREFETCH_MAX_REQUESTS + 1, skip: 0 });
			if (
				result.pageInfo.results > SEERR_PREFETCH_MAX_REQUESTS ||
				result.results.length !== result.pageInfo.results ||
				new Set(result.results.map((request) => request.id)).size !== result.results.length
			) {
				throw new Error(
					`Seerr instance ${seerrInstance.id} did not return one complete bounded request snapshot`,
				);
			}

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
				if (existing) existing.push(info);
				else map.set(key, [info]);
			}
		}

		log.info(
			{
				instances: seerrInstances.length,
				totalRequests: [...map.values()].reduce((sum, arr) => sum + arr.length, 0),
			},
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
		where: { userId, service: "PLEX", enabled: true },
		orderBy: { id: "asc" },
		select: {
			id: true,
			updatedAt: true,
			enabled: true,
			expectedIdentity: true,
			identityStatus: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});

	if (plexInstances.length === 0) return undefined;

	try {
		if (!(await loadCompleteCacheGenerations(deps, plexInstances, "plex"))) {
			throw new Error("Plex cache did not have a complete fresh generation for every instance");
		}
		const map: PlexWatchMap = new Map();
		let cursor: string | undefined;
		let totalRows = 0;
		let invalidRows = 0;

		// Cursor-paginate to bound peak heap. Project only columns the watch-map
		// builder reads — skipping ratingKey/thumb/title and the per-row instanceId.
		while (true) {
			const batch = await prisma.plexCache.findMany({
				where: providerGenerationWhere(plexInstances),
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
					const watchedByUsers = parsePublishedStringArray(row.watchedByUsers, "Plex watched-by");
					const collections = parsePublishedStringArray(row.collections, "Plex collection");
					const labels = parsePublishedStringArray(row.labels, "Plex label");

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
					invalidRows++;
					log.warn({ err: rowErr, tmdbId: row.tmdbId }, "Skipping Plex cache row with bad data");
				}
			}

			cursor = batch[batch.length - 1]!.id;
			if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
		}
		if (invalidRows > 0) {
			throw new Error("Plex cache contained malformed policy evidence");
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

interface PublishedPlexPolicyEvidence {
	plexMap: PlexWatchMap;
	plexSectionTitles: Set<string>;
	generationIds: Map<string, string>;
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
	return normalized;
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

async function loadPublishedPlexPolicyEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{ enabled: boolean; plexLibraryFilter?: string | null }>,
): Promise<PublishedPlexPolicyEvidence | undefined> {
	try {
		const instances = await deps.prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			orderBy: { id: "asc" },
			select: {
				id: true,
				updatedAt: true,
				enabled: true,
				expectedIdentity: true,
				identityStatus: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
		});
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
		const nowMs = Date.now();
		if (
			before.length !== instances.length ||
			before.some((status) => {
				const instance = instances.find((candidate) => candidate.id === status.instanceId);
				return (
					!instance ||
					!hasVerifiedProviderAuthority(instance) ||
					!hasAuthoritativeProviderCacheGeneration(status, instance) ||
					status.lastResult !== "success" ||
					status.lastErrorMessage != null ||
					status.lastAttemptErrorMessage != null ||
					(status.lastAttemptResult != null && status.lastAttemptResult !== "success") ||
					!status.generationId ||
					!status.generationMetadata ||
					status.lastRefreshedAt.getTime() > nowMs ||
					nowMs - status.lastRefreshedAt.getTime() > PROVIDER_EVIDENCE_FRESHNESS_MS ||
					status.lastRefreshedAt.getTime() < instance.updatedAt.getTime()
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
			const count = await deps.prisma.plexCache.count({
				where: {
					instanceId: status.instanceId,
					connectionGeneration: status.connectionGeneration,
					identityGeneration: status.identityGeneration,
				},
			});
			if (count !== status.itemCount) return undefined;
		}
		for (const title of collectConfiguredPlexSectionTitles(rules)) {
			if (!sectionTitles.has(title)) return undefined;
		}
		const plexMap = await prefetchPlexData(deps, userId);
		if (!plexMap) return undefined;
		const after = await readStatuses();
		if (JSON.stringify(before) !== JSON.stringify(after)) return undefined;
		return {
			plexMap,
			plexSectionTitles: sectionTitles,
			generationIds: new Map(before.map((status) => [status.instanceId, status.generationId!])),
		};
	} catch (error) {
		deps.log.warn({ err: error }, "Published Plex policy evidence was unavailable");
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
		where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
		orderBy: { id: "asc" },
		select: {
			id: true,
			updatedAt: true,
			enabled: true,
			expectedIdentity: true,
			identityStatus: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});

	if (jellyfinInstances.length === 0) return undefined;

	try {
		const before = await loadCompleteCacheGenerations(deps, jellyfinInstances, "jellyfin");
		if (!before || [...before.values()].some((generation) => !generation.generationId)) {
			throw new Error("Jellyfin cache did not have a complete fresh generation for every instance");
		}
		const generationSignature = (
			generations: NonNullable<Awaited<ReturnType<typeof loadCompleteCacheGenerations>>>,
		) =>
			JSON.stringify(
				[...generations.entries()].map(([instanceId, generation]) => [
					instanceId,
					generation.completedAt.toISOString(),
					generation.itemCount,
					generation.generationId,
				]),
			);
		const expectedRows = [...before.values()].reduce(
			(total, generation) => total + generation.itemCount,
			0,
		);
		const map: JellyfinWatchMap = new Map();
		let cursor: string | undefined;
		let totalRows = 0;
		let invalidRows = 0;

		// Cursor-paginate. Project only columns the watch-map reader uses.
		while (true) {
			const batch = await prisma.jellyfinCache.findMany({
				where: providerGenerationWhere(jellyfinInstances),
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
					const watchedByUsers = parsePublishedStringArray(
						row.watchedByUsers,
						"Jellyfin watched-by",
					);

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
					invalidRows++;
					log.warn(
						{ err: rowErr, tmdbId: row.tmdbId },
						"Skipping Jellyfin cache row with bad data",
					);
				}
			}

			cursor = batch[batch.length - 1]!.id;
			if (batch.length < CACHE_QUERY_BATCH_SIZE) break;
		}
		if (invalidRows > 0 || totalRows !== expectedRows) {
			throw new Error("Jellyfin cache rows did not match their published generation");
		}
		const after = await loadCompleteCacheGenerations(deps, jellyfinInstances, "jellyfin");
		if (!after || generationSignature(after) !== generationSignature(before)) {
			throw new Error("Jellyfin cache generation changed while evidence was being read");
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
			where: { userId, service: { in: ["JELLYFIN", "EMBY"] }, enabled: true },
			orderBy: { id: "asc" },
			select: {
				id: true,
				updatedAt: true,
				enabled: true,
				expectedIdentity: true,
				identityStatus: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
		});
		if (instances.length === 0) return undefined;
		const episodeGenerations = await loadCompleteCacheGenerations(
			deps,
			instances,
			"jellyfin_episode",
		);
		const parentGenerations = await loadCompleteCacheGenerations(deps, instances, "jellyfin");
		if (!episodeGenerations || !parentGenerations) return undefined;
		for (const instance of instances) {
			const episodeGeneration = episodeGenerations.get(instance.id);
			const parentGeneration = parentGenerations.get(instance.id);
			if (
				!episodeGeneration?.generationId ||
				!parentGeneration?.generationId ||
				parseEpisodeParentGenerationId(episodeGeneration.generationMetadata) !==
					parentGeneration.generationId
			) {
				return undefined;
			}
		}
		const currentRowsWhere = providerGenerationWhere(instances);

		const totalCounts = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: currentRowsWhere,
			_count: { id: true },
		});
		const expectedRows = [...episodeGenerations.values()].reduce(
			(total, generation) => total + generation.itemCount,
			0,
		);
		if (totalCounts.reduce((total, group) => total + group._count.id, 0) !== expectedRows) {
			return undefined;
		}

		const watchedCounts = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { AND: [currentRowsWhere, { watched: true }] },
			_count: { id: true },
		});

		const seasonTotals = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: currentRowsWhere,
			_count: { id: true },
		});

		const seasonWatched = await prisma.jellyfinEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { AND: [currentRowsWhere, { watched: true }] },
			_count: { id: true },
		});
		const finalEpisodeGenerations = await loadCompleteCacheGenerations(
			deps,
			instances,
			"jellyfin_episode",
		);
		const finalParentGenerations = await loadCompleteCacheGenerations(deps, instances, "jellyfin");
		if (
			!finalEpisodeGenerations ||
			!finalParentGenerations ||
			instances.some((instance) => {
				const beforeEpisode = episodeGenerations.get(instance.id);
				const afterEpisode = finalEpisodeGenerations.get(instance.id);
				const beforeParent = parentGenerations.get(instance.id);
				const afterParent = finalParentGenerations.get(instance.id);
				return (
					!beforeEpisode?.generationId ||
					!afterEpisode?.generationId ||
					!beforeParent?.generationId ||
					!afterParent?.generationId ||
					beforeEpisode.generationId !== afterEpisode.generationId ||
					beforeEpisode.completedAt.getTime() !== afterEpisode.completedAt.getTime() ||
					beforeEpisode.itemCount !== afterEpisode.itemCount ||
					beforeParent.generationId !== afterParent.generationId ||
					beforeParent.completedAt.getTime() !== afterParent.completedAt.getTime() ||
					parseEpisodeParentGenerationId(afterEpisode.generationMetadata) !==
						afterParent.generationId
				);
			})
		) {
			return undefined;
		}

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
	acceptedPlexGenerations: ReadonlyMap<string, string>,
): Promise<PlexEpisodeMap | undefined> {
	const { prisma, log } = deps;

	try {
		const instances = await prisma.serviceInstance.findMany({
			where: { userId, service: "PLEX", enabled: true },
			orderBy: { id: "asc" },
			select: {
				id: true,
				updatedAt: true,
				baseUrl: true,
				encryptedApiKey: true,
				encryptionIv: true,
				encryptedHttpAuthCredentials: true,
				httpAuthEncryptionIv: true,
				service: true,
				label: true,
				enabled: true,
				expectedIdentity: true,
				identityStatus: true,
				connectionGeneration: true,
				identityGeneration: true,
			},
		});
		const instanceIds = instances.map((i) => i.id);
		if (instanceIds.length === 0) return undefined;
		const episodeGenerations = await loadCompleteCacheGenerations(deps, instances, "plex_episode");
		const plexGenerations = await loadCompleteCacheGenerations(deps, instances, "plex");
		if (!episodeGenerations || !plexGenerations) return undefined;
		const eligibleShowRows = await prisma.plexCache.groupBy({
			by: ["instanceId", "tmdbId"],
			where: {
				...providerGenerationWhere(instances),
				mediaType: "series",
				ratingKey: { not: null },
				watchCount: { gt: 0 },
			},
		});
		const eligibleShowsByInstance = new Map<string, number[]>();
		for (const row of eligibleShowRows) {
			const showIds = eligibleShowsByInstance.get(row.instanceId) ?? [];
			showIds.push(row.tmdbId);
			eligibleShowsByInstance.set(row.instanceId, showIds);
		}
		const nowMs = Date.now();
		const freshnessThreshold = nowMs - PROVIDER_EVIDENCE_FRESHNESS_MS;
		const currentEpisodeSources: Prisma.PlexEpisodeCacheWhereInput[] = [];
		for (const instance of instances) {
			const episodeGeneration = episodeGenerations.get(instance.id);
			const plexGeneration = plexGenerations.get(instance.id);
			const acceptedPlexGenerationId = acceptedPlexGenerations.get(instance.id);
			if (
				!episodeGeneration?.generationId ||
				!plexGeneration?.generationId ||
				!acceptedPlexGenerationId ||
				plexGeneration.generationId !== acceptedPlexGenerationId ||
				parseEpisodeParentGenerationId(episodeGeneration.generationMetadata) !==
					acceptedPlexGenerationId
			) {
				return undefined;
			}
			const showTmdbIds = eligibleShowsByInstance.get(instance.id) ?? [];
			if (showTmdbIds.length === 0) continue;
			const sourceWhere: Prisma.PlexEpisodeCacheWhereInput = {
				instanceId: instance.id,
				showTmdbId: { in: showTmdbIds },
				connectionGeneration: instance.connectionGeneration,
				identityGeneration: instance.identityGeneration,
			};
			const validatedSourceWhere: Prisma.PlexEpisodeCacheWhereInput = {
				...sourceWhere,
				refreshedAt: {
					not: null,
					gte: new Date(Math.max(freshnessThreshold, instance.updatedAt.getTime())),
					lte: episodeGeneration.completedAt,
				},
				sourceFingerprint: plexConnectionFingerprint(instance as ServiceInstance),
			};
			const totalRows = await prisma.plexEpisodeCache.count({ where: sourceWhere });
			const validRows = await prisma.plexEpisodeCache.count({
				where: validatedSourceWhere,
			});
			if (totalRows === 0 || totalRows !== validRows) {
				return undefined;
			}
			currentEpisodeSources.push(validatedSourceWhere);
		}
		if (currentEpisodeSources.length === 0) return new Map();
		const currentEpisodeWhere: Prisma.PlexEpisodeCacheWhereInput = {
			OR: currentEpisodeSources,
		};

		// Four bounded groupBy queries: show and season totals plus their watched subsets.
		const sourceTotalCounts = await prisma.plexEpisodeCache.groupBy({
			by: ["instanceId", "showTmdbId"],
			where: currentEpisodeWhere,
			_count: { id: true },
		});
		const coveredSources = new Set(
			sourceTotalCounts.map((group) => `${group.instanceId}:${group.showTmdbId}`),
		);
		if (eligibleShowRows.some((row) => !coveredSources.has(`${row.instanceId}:${row.tmdbId}`))) {
			return undefined;
		}
		const totalByShow = new Map<number, number>();
		for (const group of sourceTotalCounts) {
			totalByShow.set(group.showTmdbId, (totalByShow.get(group.showTmdbId) ?? 0) + group._count.id);
		}
		const totalCounts = [...totalByShow].map(([showTmdbId, count]) => ({
			showTmdbId,
			_count: { id: count },
		}));

		const watchedCounts = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId"],
			where: { AND: [currentEpisodeWhere, { watched: true }] },
			_count: { id: true },
		});

		// Per-season counts for minSeason filtering
		const seasonTotals = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: currentEpisodeWhere,
			_count: { id: true },
		});

		const seasonWatched = await prisma.plexEpisodeCache.groupBy({
			by: ["showTmdbId", "seasonNumber"],
			where: { AND: [currentEpisodeWhere, { watched: true }] },
			_count: { id: true },
		});
		const finalEpisodeGenerations = await loadCompleteCacheGenerations(
			deps,
			instances,
			"plex_episode",
		);
		const finalPlexGenerations = await loadCompleteCacheGenerations(deps, instances, "plex");
		if (
			!finalEpisodeGenerations ||
			!finalPlexGenerations ||
			instances.some((instance) => {
				const beforeEpisode = episodeGenerations.get(instance.id);
				const afterEpisode = finalEpisodeGenerations.get(instance.id);
				const beforePlex = plexGenerations.get(instance.id);
				const afterPlex = finalPlexGenerations.get(instance.id);
				const acceptedPlexGenerationId = acceptedPlexGenerations.get(instance.id);
				return (
					!beforeEpisode?.generationId ||
					!afterEpisode?.generationId ||
					!beforePlex?.generationId ||
					!afterPlex?.generationId ||
					!acceptedPlexGenerationId ||
					beforeEpisode.generationId !== afterEpisode.generationId ||
					beforeEpisode.completedAt.getTime() !== afterEpisode.completedAt.getTime() ||
					beforeEpisode.itemCount !== afterEpisode.itemCount ||
					beforePlex.generationId !== acceptedPlexGenerationId ||
					afterPlex.generationId !== acceptedPlexGenerationId ||
					beforePlex.completedAt.getTime() !== afterPlex.completedAt.getTime() ||
					beforePlex.itemCount !== afterPlex.itemCount ||
					parseEpisodeParentGenerationId(afterEpisode.generationMetadata) !==
						acceptedPlexGenerationId
				);
			})
		) {
			return undefined;
		}

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
	const needsPlexSectionInventory = collectConfiguredPlexSectionTitles(rules).size > 0;
	const plexEvidence =
		hasPlexRules || needsPlexSectionInventory
			? await loadPublishedPlexPolicyEvidence(deps, config.userId, rules)
			: undefined;
	const plexMap = hasPlexRules ? plexEvidence?.plexMap : undefined;

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
	const plexEpisodeMap =
		hasEpisodeRules && plexEvidence
			? await prefetchPlexEpisodeData(deps, config.userId, plexEvidence.generationIds)
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
		plex:
			hasPlexRules || needsPlexSectionInventory
				? plexEvidence && (!hasEpisodeRules || plexEpisodeMap)
					? "ok"
					: "failed"
				: "skipped",
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
		plexSectionTitles: plexEvidence?.plexSectionTitles,
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
					respectQuiSeeding,
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
				row.refreshedAt.getTime() > now.getTime() ||
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

function providerEvidenceDependenciesForRules(rules: LibraryCleanupRule[]): ProviderCacheType[] {
	const activeTypes = collectActiveRuleTypes(rules);
	const dependencies = new Set<ProviderCacheType>();
	if (
		[...activeTypes].some(ruleTypeUsesPlexSeriesCache) ||
		collectConfiguredPlexSectionTitles(rules).size > 0
	) {
		dependencies.add("plex");
	}
	if (activeTypes.has("plex_episode_completion") || rules.some(isSupportedEpisodeCleanupRule)) {
		dependencies.add("plex");
		dependencies.add("plex_episode");
	}
	if ([...activeTypes].some(ruleTypeUsesJellyfinSeriesCache)) {
		dependencies.add("jellyfin");
	}
	if (activeTypes.has("jellyfin_episode_completion")) {
		dependencies.add("jellyfin");
		dependencies.add("jellyfin_episode");
	}
	return [...dependencies].sort();
}

async function evaluateCleanupPreviewWithProviderEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
) {
	const dependencies = providerEvidenceDependenciesForRules(config.rules);
	if (dependencies.length === 0) {
		return {
			...(await evaluateAllItems(deps, config, config.rules)),
			providerEvidence: createSanitizedProviderEvidence([], []),
			providerEvidenceWarning: undefined,
		};
	}

	let accepted = await capturePreviewProviderEvidence(deps, userId, dependencies);
	if (!accepted.providerEvidence) {
		return withUnavailablePreviewProviderEvidence(
			await evaluateAllItems(deps, config, config.rules),
			accepted.warning,
		);
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		const acceptedEvidence = accepted.providerEvidence;
		if (!acceptedEvidence) throw new Error("Provider evidence retry lost its accepted snapshot");
		const evaluation = await evaluateAllItems(deps, config, config.rules);
		const current = await capturePreviewProviderEvidence(deps, userId, dependencies);
		if (
			current.providerEvidence &&
			current.providerEvidence.fingerprint === acceptedEvidence.fingerprint
		) {
			return {
				...evaluation,
				providerEvidence: acceptedEvidence,
				providerEvidenceWarning: undefined,
			};
		}
		if (attempt === 0 && current.providerEvidence) {
			accepted = current;
			continue;
		}
		return withUnavailablePreviewProviderEvidence(evaluation, current.warning);
	}

	throw new Error("Unreachable provider evidence preview attempt");
}

async function capturePreviewProviderEvidence(
	deps: CleanupExecutorDeps,
	userId: string,
	dependencies: ProviderCacheType[],
): Promise<{ providerEvidence?: SanitizedProviderEvidence; warning?: string }> {
	try {
		return {
			providerEvidence: await captureCurrentProviderEvidenceAuthority(deps, userId, dependencies),
		};
	} catch (error) {
		deps.log.warn({ err: error }, "Library cleanup preview provider evidence was unavailable");
		return {
			warning:
				"Cleanup provider evidence was unavailable. Provider-backed decisions were not attributed to a durable cache generation.",
		};
	}
}

function withUnavailablePreviewProviderEvidence(
	evaluation: Awaited<ReturnType<typeof evaluateAllItems>>,
	warning?: string,
) {
	return {
		...evaluation,
		flagged: [],
		providerEvidence: undefined,
		providerEvidenceWarning:
			warning ??
			"Cleanup provider evidence changed while this preview was evaluated. Cleanup selection was withheld; run the preview again.",
	};
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

export async function selectApprovalCandidatesBeforeLimit(
	deps: CleanupExecutorDeps,
	config: LibraryCleanupConfig & { rules: LibraryCleanupRule[] },
	userId: string,
	flagged: FlaggedItem[],
	limit: number,
): Promise<{
	selected: FlaggedItem[];
	skippedDetails: CleanupRunResult["details"];
}> {
	const selection = await loadApprovalSelectionState(deps, config, userId, flagged, limit);
	return { selected: selection.selected, skippedDetails: selection.skippedDetails };
}

function buildApprovalSelectionDetails(
	selectionPlan: DirectCleanupSelectionPlan<FlaggedItem, LibraryCleanupApproval>,
): CleanupRunResult["details"] {
	const details: CleanupRunResult["details"] = [];
	for (const decision of selectionPlan.decisions) {
		if (details.length >= PREVIEW_SAFETY_INSPECTION_LIMIT) break;
		if (decision.disposition === "selected") continue;
		const value = decision.candidate.value;
		details.push(
			"cacheItem" in value
				? buildDetail(value, "skipped", decision.reason)
				: buildRetryDetail(value, "skipped", decision.reason),
		);
	}
	return details;
}

function unavailableApprovalSelectionState(
	flagged: FlaggedItem[],
	limit: number,
	warning: string,
): ApprovalSelectionState {
	const plan = planApprovalCleanupSelection<FlaggedItem, LibraryCleanupApproval>({
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
		inFlightRetryTargetCount: 0,
		unmatchedInFlightRetryTargetCount: 0,
		retryStateLoaded: false,
		warnings: [warning],
	};
}

async function visitApprovalSelectionPages(
	deps: CleanupExecutorDeps,
	where: Prisma.LibraryCleanupApprovalWhereInput,
	visit: (row: LibraryCleanupApproval) => void,
): Promise<void> {
	let cursorId: string | undefined;
	while (true) {
		const page = await deps.prisma.libraryCleanupApproval.findMany({
			where,
			orderBy: { id: "asc" },
			take: APPROVAL_SELECTION_PAGE_SIZE + 1,
			...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
		});
		const rows = page.slice(0, APPROVAL_SELECTION_PAGE_SIZE);
		for (const row of rows) visit(row);
		if (page.length <= APPROVAL_SELECTION_PAGE_SIZE) return;
		const nextCursorId = rows.at(-1)?.id;
		if (!nextCursorId || nextCursorId === cursorId) {
			throw new Error("Approval selection pagination did not advance");
		}
		cursorId = nextCursorId;
	}
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
	const candidateKeys = new Set(
		flagged.map((item) => cleanupDeleteTargetKey(flaggedDeleteTarget(item))),
	);
	const approvalDedupRowsByTarget = new Map<string, LibraryCleanupApproval[]>();
	const nonterminalRetryKeys = new Set<string>();
	const inFlightRetryTargetKeys = new Set<string>();
	const inFlightRetries: Array<{
		id: string;
		key: string;
		value: LibraryCleanupApproval;
		reviewedAt: Date | null;
		createdAt: Date;
	}> = [];
	let pendingRetryCount = 0;
	try {
		await Promise.all([
			visitApprovalSelectionPages(
				deps,
				{
					configId: config.id,
					config: { userId },
					status: { in: ["retry_pending", "retry_executing"] },
				},
				(retry) => {
					const targetKey = cleanupApprovalTargetKey(retry);
					if (candidateKeys.has(targetKey)) nonterminalRetryKeys.add(targetKey);
					if (retry.status === "retry_pending") pendingRetryCount++;
					if (retry.status === "retry_executing" && !inFlightRetryTargetKeys.has(targetKey)) {
						inFlightRetryTargetKeys.add(targetKey);
						if (
							inFlightRetries.length < PREVIEW_SAFETY_INSPECTION_LIMIT ||
							candidateKeys.has(targetKey)
						) {
							inFlightRetries.push({
								id: retry.id,
								key: targetKey,
								value: retry,
								reviewedAt: retry.reviewedAt,
								createdAt: retry.createdAt,
							});
						}
					}
				},
			),
			visitApprovalSelectionPages(
				deps,
				{
					configId: config.id,
					config: { userId },
					OR: [
						{ status: "pending", expiresAt: { gt: now } },
						{ status: { in: ["approved", "executing"] } },
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
				(row) => {
					const targetKey = cleanupApprovalTargetKey(row);
					if (!candidateKeys.has(targetKey)) return;
					const rows = approvalDedupRowsByTarget.get(targetKey);
					if (rows) rows.push(row);
					else approvalDedupRowsByTarget.set(targetKey, [row]);
				},
			),
		]);
	} catch (error) {
		deps.log.error(
			{ err: error, configId: config.id },
			"Cleanup could not load durable approval selection state",
		);
		return unavailableApprovalSelectionState(flagged, limit, unavailableWarning);
	}

	const approvalExclusions = new Map<string, string>();
	for (const item of flagged) {
		const memWindow = memoryByRuleId.get(item.match.ruleId) ?? { mode: "off" as const };
		const targetRows =
			approvalDedupRowsByTarget.get(cleanupDeleteTargetKey(flaggedDeleteTarget(item))) ?? [];
		const existing = targetRows.find((row) => {
			if (["pending", "approved", "executing"].includes(row.status)) return true;
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
					"Already owned by a nonterminal approval queue item",
			);
		}
	}
	const plan = planApprovalCleanupSelection<FlaggedItem, LibraryCleanupApproval>({
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
	const warnings: string[] = [];
	if (pendingRetryCount > 0) {
		warnings.push(
			`${pendingRetryCount} durable cleanup ${
				pendingRetryCount === 1 ? "retry is" : "retries are"
			} pending outside the approval-run budget.`,
		);
	}
	if (inFlightRetryTargetKeys.size > 0) {
		warnings.push(
			`${inFlightRetryTargetKeys.size} durable cleanup ${
				inFlightRetryTargetKeys.size === 1 ? "retry is" : "retries are"
			} already executing and deferred from this approval run.`,
		);
	}
	return {
		plan,
		selected: plan.selectedFresh.map((candidate) => candidate.value),
		skippedDetails: buildApprovalSelectionDetails(plan),
		pendingRetryCount,
		inFlightRetryTargetCount: inFlightRetryTargetKeys.size,
		unmatchedInFlightRetryTargetCount: [...inFlightRetryTargetKeys].filter(
			(targetKey) => !candidateKeys.has(targetKey),
		).length,
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
	providerEvidence: SanitizedProviderEvidence = createSanitizedProviderEvidence([], []),
	preSkippedDetails: CleanupRunResult["details"] = [],
	additionalSkippedCount = 0,
	auditContext: CleanupAuditContext = DEFAULT_DIRECT_AUDIT_CONTEXT,
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
			const memWindow = memoryByRuleId.get(item.match.ruleId) ?? { mode: "off" as const };
			const mediaServerScanPolicy = normalizeCleanupMediaServerScanPolicy(item.match);

			// Dedup query: always preserve active approval/execution ownership;
			// additionally skip rejected approvals when the rule's memory window says so (#474).
			const orClauses = buildDedupOrClauses(memWindow);

			const existing = await prisma.libraryCleanupApproval.findFirst({
				where: {
					configId: config.id,
					config: { userId: config.userId },
					instanceId: item.cacheItem.instanceId,
					arrItemId: item.cacheItem.arrItemId,
					itemType: item.cacheItem.itemType,
					targetScope: item.episodeTarget ? "episode" : "series",
					...(item.episodeTarget
						? item.match.action === "unmonitor"
							? {
									arrEpisodeId: item.episodeTarget.arrEpisodeId,
									action: "unmonitor",
								}
							: {
									episodeFileId: item.episodeTarget.episodeFileId,
									AND: [{ OR: [{ action: null }, { action: { not: "unmonitor" } }] }],
								}
						: {}),
					OR: orClauses,
				},
			});

			if (existing) {
				if (existing.status === "pending") {
					await ensureCleanupProposalAudit(deps, config.userId, existing);
				}
				details.push(
					buildDetail(item, "skipped", buildApprovalDedupSkipReason(existing.status, memWindow)),
				);
				approvalDedupSkipped++;
				continue;
			}

			await prisma.$transaction(async (tx) => {
				const created = await tx.libraryCleanupApproval.create({
					data: {
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
						scanMediaServerAfterDelete: mediaServerScanPolicy.scanMediaServerAfterDelete,
						scanMediaServerInstanceIds: mediaServerScanPolicy.scanMediaServerInstanceIds,
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
					},
				});
				await appendCleanupAuditEvent(
					tx,
					buildCleanupProposalAuditInput(config.userId, created, auditContext),
				);
				return created;
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
			additionalSkippedCount +
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
	cleanupRunClaimToken?: string,
	providerEvidence: SanitizedProviderEvidence = createSanitizedProviderEvidence([], []),
	auditContext: CleanupAuditContext = DEFAULT_DIRECT_AUDIT_CONTEXT,
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
	const sharedPlexSafetyContext = createSharedPlexSafetyContext();
	const getMutationPolicySnapshot = createMutationPolicySnapshotGetter(
		deps,
		userId,
		completeMutationConfigFingerprint(config),
		cleanupRunClaimToken,
	);
	const configuredRunLimitIsValid =
		Number.isSafeInteger(config.maxRemovalsPerRun) &&
		config.maxRemovalsPerRun > 0 &&
		config.maxRemovalsPerRun <= 100;
	const configuredRunLimit = configuredRunLimitIsValid ? config.maxRemovalsPerRun : 0;
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
	for (const decision of directSelection.plan.decisions) {
		if (decision.disposition === "selected") continue;
		const value = decision.candidate.value;
		details.push(
			"cacheItem" in value
				? buildDetail(value, "skipped", decision.reason)
				: buildRetryDetail(value, "skipped", decision.reason),
		);
	}

	for (const retry of directRetries) {
		try {
			const retryResult = await executeQueuedCleanupItems(deps, userId, [retry.id], {
				claimStatus: "retry_pending",
				executeStatus: "retry_executing",
				retryStatus: "retry_pending",
				enforceExpiry: false,
				assertExecutionAllowed: assertRunLease,
				cleanupRunClaimToken,
				auditContext: withCleanupAuditTrigger(auditContext, "retry"),
			});
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

	// The complete direct-run selection was fixed before retry attempts, safety
	// checks, or writes. A selected target that fails closed keeps its slot; a
	// later candidate is never pulled into the same run as backfill.
	const freshItems = directSelection.plan.selectedFresh.map((candidate) => candidate.value);
	const budgetDeferredItems = directSelection.plan.counts.deferredBudget;

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

		const targetKey = cleanupDeleteTargetKey(flaggedDeleteTarget(item));
		let sharedPlexBlock = sharedPlexBlocks.get(targetKey);
		let safetyPlan: SharedMediaSafetyPlan | undefined;
		try {
			const directTarget = { ...flaggedDeleteTarget(item), action: ruleAction };
			const freshBlocks = await findSharedPlexDeleteBlocks(
				deps,
				userId,
				[directTarget],
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
		let directMutationAuditCorrelationId: string;
		try {
			await assertCurrentProviderEvidenceAuthority(deps, userId, providerEvidence, assertRunLease);
			const intent = await persistAndClaimDirectMutationIntent(
				deps,
				config,
				userId,
				item,
				safetyPlan!,
				providerEvidence,
				auditContext,
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
			directMutationAuditCorrelationId = intent.executionAuditCorrelationId;
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
		const directAuditApproval = {
			id: directMutationIntentId,
			configId: config.id,
			instanceId: item.cacheItem.instanceId,
			arrItemId: item.cacheItem.arrItemId,
			itemType: item.cacheItem.itemType,
			targetScope: item.episodeTarget ? "episode" : "series",
			arrEpisodeId: item.episodeTarget?.arrEpisodeId ?? null,
			seasonNumber: item.episodeTarget?.seasonNumber ?? null,
			episodeNumber: item.episodeTarget?.episodeNumber ?? null,
			episodeTitle: item.episodeTarget?.episodeTitle ?? null,
			title: item.cacheItem.title,
			matchedRuleId: item.match.ruleId,
			matchedRuleName: item.match.ruleName,
			reason: item.match.reason,
			action: ruleAction,
			...normalizeCleanupMediaServerScanPolicy(item.match),
		} as const;
		let directMutationStartedAuditAttempted = false;
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
			const directExpectedRule = expectedMutationRule(item.match.ruleId, ruleAction, item.match);
			if (directExpectedRule.scanMediaServerAfterDelete) {
				await assertCurrentMediaServerScanRuleAuthority(deps, userId, directExpectedRule);
			}
			await prepareCleanupMediaServerRescans(
				deps,
				userId,
				directAuditApproval as unknown as LibraryCleanupApproval,
			);
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
			let authorizedSeriesPolicy: AuthorizedSeriesMutationPolicy | undefined;
			const assertDirectExecutionAuthority: MutationAuthorityCheck = async (evidence) => {
				await assertRunLease?.();
				if (safetyPlan!.kind === "verified_sonarr_episode") return;
				if (!evidence || !("seriesTransition" in evidence)) {
					throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
						"Skipped for safety: the expected ARR mutation transition was unavailable.",
					);
				}
				let authorizedResource: Record<string, unknown>;
				if (!authorizedSeriesPolicy) {
					if (evidence.seriesTransition !== "unchanged") {
						throw new ArrMutationAuthorityChangedDuringSafetyCheckError(
							"Skipped for safety: no original ARR policy state was captured before the file transition.",
						);
					}
					authorizedSeriesPolicy = await assertCurrentSeriesMutationAuthority(
						deps,
						userId,
						mutationInstance,
						item.cacheItem.arrItemId,
						directExpectedRule,
						await getMutationPolicySnapshot(),
					);
					authorizedResource = authorizedSeriesPolicy.rawItem;
				} else {
					authorizedResource = await assertCurrentSeriesPostStepMutationAuthority(
						deps,
						userId,
						mutationInstance,
						item.cacheItem.arrItemId,
						directExpectedRule,
						authorizedSeriesPolicy,
						evidence.seriesTransition,
						getMutationPolicySnapshot,
					);
				}
				return authorizedResource;
			};
			const mutationTarget: CleanupDeleteTarget = {
				...flaggedDeleteTarget(item),
				action: ruleAction,
			};
			const assertDestructiveMutationAuthority =
				safetyPlan?.kind === "verified_sonarr_episode"
					? createSonarrEpisodeMutationAuthority(
							deps,
							userId,
							mutationInstance,
							mutationTarget,
							safetyPlan,
							directExpectedRule,
							assertDirectExecutionAuthority,
							cleanupRunClaimToken,
						)
					: mutationInstance.service === "RADARR"
						? createRadarrDestructiveMutationAuthority(
								deps,
								userId,
								mutationTarget,
								safetyPlan!,
								assertDirectExecutionAuthority,
							)
						: mutationInstance.service === "SONARR" && safetyPlan?.kind === "verified_sonarr"
							? createSonarrDestructiveMutationAuthority(
									deps,
									userId,
									mutationTarget,
									safetyPlan,
									assertDirectExecutionAuthority,
								)
							: assertDirectExecutionAuthority;
			const assertDirectMutationAuthorityWithAudit: MutationAuthorityCheck = async (evidence) => {
				if (!directMutationStartedAuditAttempted) {
					directMutationStartedAuditAttempted = true;
					await appendCleanupMutationStartedAudit(
						deps,
						userId,
						directAuditApproval,
						directMutationAuditCorrelationId,
						auditContext,
					);
				}
				return await assertDestructiveMutationAuthority(evidence);
			};

			let directReconciledWithoutMutation = false;
			if (ruleAction === "unmonitor") {
				await unmonitorInArr(
					arrClientFactory,
					mutationInstance,
					item.cacheItem.arrItemId,
					safetyPlan!,
					assertDirectMutationAuthorityWithAudit,
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
				details.push(buildDetail(item, "unmonitored"));
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
							assertDirectMutationAuthorityWithAudit,
						),
				);
				directReconciledWithoutMutation = !deletedFiles;
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
				await withQuiPhysicalMutationGuard(userId, mutationTarget.respectQuiSeeding === true, () =>
					deleteFromArr(
						arrClientFactory,
						mutationInstance,
						item.cacheItem.arrItemId,
						safetyPlan!,
						assertDirectMutationAuthorityWithAudit,
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
				details.push(buildDetail(item, "removed"));
				removed++;
				consecutiveFailures = 0; // Reset on success
				log.info(
					{ title: item.cacheItem.title, instanceId: instance.id, rule: item.match.ruleName },
					"Cleanup: removed item from ARR instance",
				);
			}
			let terminalStatePersisted = true;
			try {
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
						reconciledWithoutMutation: directReconciledWithoutMutation,
						...buildCleanupTerminalAuditState(
							userId,
							directAuditApproval,
							directMutationAuditCorrelationId,
							"success",
							auditContext,
							directReconciledWithoutMutation,
						),
					},
				);
			} catch (persistError) {
				terminalStatePersisted = false;
				directRetryPersistenceFailures++;
				log.error(
					{ err: persistError, intentId: directMutationIntentId },
					"Cleanup action completed but its durable mutation intent was not finalized",
				);
			}
			if (terminalStatePersisted) {
				await appendCleanupTerminalAudit(
					deps,
					userId,
					directAuditApproval,
					directMutationAuditCorrelationId,
					"success",
					auditContext,
					directReconciledWithoutMutation,
				);
			}
		} catch (error) {
			if (error instanceof CleanupRunLeaseLostError) {
				const leaseError = "Cleanup execution paused because its database run lease was lost.";
				try {
					await persistCleanupFailureTransition(
						deps,
						userId,
						directAuditApproval,
						"retry_executing",
						directMutationExecutionToken,
						{
							status: "retry_pending",
							executionToken: null,
							lastExecutionError: leaseError,
						},
						directMutationAuditCorrelationId,
						auditContext,
						{
							durableStatus: "retry_pending",
							mutationAttempted: directMutationStartedAuditAttempted,
							reason: leaseError,
						},
					);
				} catch (persistError) {
					log.error(
						{ err: persistError, intentId: directMutationIntentId },
						"Cleanup lost its run lease and could not return its mutation intent to retry pending",
					);
				}
				throw error;
			}
			if (error instanceof CleanupExemptionAuthorityError) {
				exemptionPolicyBlocks++;
				try {
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
							...buildCleanupTerminalAuditState(
								userId,
								directAuditApproval,
								directMutationAuditCorrelationId,
								"blocked",
								auditContext,
								false,
								error.message,
							),
						},
					);
					await appendCleanupTerminalAudit(
						deps,
						userId,
						directAuditApproval,
						directMutationAuditCorrelationId,
						"blocked",
						auditContext,
						false,
						error.message,
					);
				} catch (persistError) {
					directRetryPersistenceFailures++;
					log.error(
						{ err: persistError, intentId: directMutationIntentId },
						"Cleanup could not expire an exemption-blocked mutation intent",
					);
				}
				details.push(buildDetail(item, "skipped", error.message));
				log.warn(
					{ title: item.cacheItem.title, instanceId: instance.id },
					"Cleanup mutation blocked by current deployed exemption policy",
				);
				continue;
			}
			if (
				error instanceof SonarrEpisodeUnmonitorPartialError ||
				error instanceof SonarrEpisodeUnmonitorOutcomeUnknownError
			) {
				partialArrDeletes++;
				const postEpisodeUnmonitorSnapshot =
					error instanceof SonarrEpisodeUnmonitorPartialError
						? serializeExecutableSafetyPlan(
								asExecutableSafetyPlan(safetyPlan)!,
								providerEvidence,
								"post_partial_mutation",
							)
						: undefined;
				try {
					await persistCleanupFailureTransition(
						deps,
						userId,
						directAuditApproval,
						"retry_executing",
						directMutationExecutionToken,
						{
							status: "retry_pending",
							executionToken: null,
							lastExecutionError: error.message,
							...(postEpisodeUnmonitorSnapshot
								? { safetySnapshot: postEpisodeUnmonitorSnapshot }
								: {}),
						},
						directMutationAuditCorrelationId,
						auditContext,
						{
							durableStatus: "retry_pending",
							mutationAttempted: directMutationStartedAuditAttempted,
							reason: error.message,
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
				details.push(buildDetail(item, "skipped", error.message));
				log.error(
					{ err: error, title: item.cacheItem.title, instanceId: instance.id },
					"Cleanup could not complete the exact Sonarr episode mutation",
				);
				if (
					error instanceof SonarrEpisodeUnmonitorPartialError &&
					error.cause instanceof CleanupRunLeaseLostError
				) {
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
					providerEvidence,
				);
				let retryPersistenceSucceeded = true;
				try {
					await persistCleanupFailureTransition(
						deps,
						userId,
						directAuditApproval,
						"retry_executing",
						directMutationExecutionToken,
						{
							status: "retry_pending",
							executionToken: null,
							lastExecutionError: error.message,
							...(postPartialRetrySnapshot ? { safetySnapshot: postPartialRetrySnapshot } : {}),
						},
						directMutationAuditCorrelationId,
						auditContext,
						{
							durableStatus: "retry_pending",
							mutationAttempted: directMutationStartedAuditAttempted,
							reason: error.message,
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
				try {
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
							...buildCleanupTerminalAuditState(
								userId,
								directAuditApproval,
								directMutationAuditCorrelationId,
								"blocked",
								auditContext,
								false,
								error.message,
							),
						},
					);
					await appendCleanupTerminalAudit(
						deps,
						userId,
						directAuditApproval,
						directMutationAuditCorrelationId,
						"blocked",
						auditContext,
						false,
						error.message,
					);
				} catch (persistError) {
					directRetryPersistenceFailures++;
					log.error(
						{ err: persistError, intentId: directMutationIntentId },
						"Cleanup could not expire a safety-invalid mutation intent",
					);
				}
				details.push(buildDetail(item, "skipped", error.message));
				log.warn(
					{ title: item.cacheItem.title, instanceId: instance.id },
					"Cleanup deletion blocked because the verified ARR file set changed",
				);
				continue;
			}
			consecutiveFailures++;
			const directExecutionError = `Action failed: ${getErrorMessage(error)}`;
			try {
				await persistCleanupFailureTransition(
					deps,
					userId,
					directAuditApproval,
					"retry_executing",
					directMutationExecutionToken,
					{
						status: "retry_pending",
						executionToken: null,
						lastExecutionError: directExecutionError,
					},
					directMutationAuditCorrelationId,
					auditContext,
					{
						durableStatus: "retry_pending",
						mutationAttempted: directMutationStartedAuditAttempted,
						reason: "Cleanup action failed and remains retryable. Review the API logs for details.",
					},
				);
			} catch (persistError) {
				directRetryPersistenceFailures++;
				log.error(
					{ err: persistError, intentId: directMutationIntentId },
					"Cleanup could not return a failed mutation intent to retry pending",
				);
			}
			log.error(
				{ err: error, title: item.cacheItem.title, instanceId: instance.id, consecutiveFailures },
				"Cleanup: failed to execute action on item",
			);
			details.push(buildDetail(item, "skipped", directExecutionError));
		}
	}

	const allWarnings = withSharedPlexWarning([...(warnings ?? [])], runtimeSafetyBlocks);
	if (!configuredRunLimitIsValid) {
		allWarnings.push(INVALID_CLEANUP_RUN_LIMIT_WARNING);
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
	const selectedOrActiveCount =
		directSelection.plan.selectedFresh.length +
		directSelection.plan.selectedRetries.length +
		directSelection.plan.counts.deferredRetryFairness +
		directSelection.plan.counts.inFlight;

	const result: CleanupRunResult = {
		isDryRun: false,
		status: circuitBroken || hasWarnings ? "partial" : "completed",
		itemsEvaluated: totalEvaluated,
		itemsFlagged: selectedOrActiveCount,
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
	assertMutationAuthority?: MutationAuthorityCheck,
): Promise<void> {
	await assertVerifiedRadarrFileUnchanged(radarr, arrItemId, expectedTarget, expected);
	await assertMutationAuthority?.({ seriesTransition: "unchanged" });
	let deleteError: unknown;
	try {
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
	assertMutationAuthority?: MutationAuthorityCheck,
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
			await assertMutationAuthority?.({
				seriesTransition: deletedFileIds.length > 0 ? "all_files_deleted" : "unchanged",
			});
		} catch (error) {
			if (deletedFileIds.length === 0) throw error;
			throw new ArrDeletePartialError({
				cause: error,
				service: "RADARR",
				deletedFileIds,
				hasRemainingFiles: false,
				message:
					"Partial cleanup: the verified Radarr movie file was deleted, but execution authority was lost or changed before the movie record could be removed.",
			});
		}

		try {
			await radarr.movie.delete(arrItemId, {
				deleteFiles: false,
				addImportExclusion: false,
			});
			return;
		} catch (error) {
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
): Promise<number[]> {
	await assertVerifiedSonarrFilesUnchanged(sonarr, arrItemId, expectedTarget, expected);
	const expectedIds = expected.episodeFiles.map((file) => file.episodeFileId);
	if (expectedIds.length === 0) return [];

	await assertMutationAuthority?.({ seriesTransition: "unchanged" });
	let bulkError: unknown;
	try {
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

async function deleteVerifiedSonarrEpisodeFile(
	sonarr: InstanceType<typeof SonarrClient>,
	arrItemId: number,
	plan: Extract<ExecutableSharedMediaSafetyPlan, { kind: "verified_sonarr_episode" }>,
	assertMutationAuthority?: MutationAuthorityCheck,
	monitoredMode: "exact" | "require_unmonitored" = "exact",
): Promise<void> {
	await assertVerifiedSonarrEpisodeUnchanged(sonarr, arrItemId, plan, {
		monitoredMode,
	});
	await assertMutationAuthority?.();
	let bulkError: unknown;
	try {
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
		throw new ArrDeletePartialError({
			cause: new SonarrFilesChangedDuringSafetyCheckError(),
			service: "SONARR",
			deletedFileIds: [plan.selectedFile.episodeFileId],
			hasRemainingFiles: remaining.length > 0,
			remainingSize: sonarrFileSetSize(remaining),
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
			await assertMutationAuthority?.({
				seriesTransition: deletedFileIds.length > 0 ? "all_files_deleted" : "unchanged",
			});
		} catch (error) {
			if (deletedFileIds.length === 0) throw error;
			throw new ArrDeletePartialError({
				cause: error,
				service: "SONARR",
				deletedFileIds,
				hasRemainingFiles: false,
				message:
					"Partial cleanup: the verified Sonarr episode files were deleted, but execution authority was lost or changed before the series record could be removed.",
			});
		}

		try {
			await sonarr.series.delete(arrItemId, {
				deleteFiles: false,
				addImportListExclusion: false,
			});
			return;
		} catch (error) {
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
				where: { instanceId: instance.id, arrItemId, itemType: "series" },
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
			if (safetyPlan.kind === "verified_sonarr_episode") {
				await assertVerifiedSonarrEpisodeUnchanged(sonarr, arrItemId, safetyPlan, {
					monitoredMode: "allow_unmonitored",
				});
				await assertMutationAuthority?.();
				if (safetyPlan.episode.monitored) {
					try {
						await sonarr.episode.setMonitored([safetyPlan.episode.arrEpisodeId], false);
					} catch (error) {
						const unmonitored = await sonarrEpisodeRemainsUnmonitored(
							sonarr,
							arrItemId,
							safetyPlan,
						);
						if (unmonitored === false) throw error;
						if (unmonitored === null) {
							throw new SonarrEpisodeUnmonitorOutcomeUnknownError(error);
						}
					}
				}
				try {
					await deleteVerifiedSonarrEpisodeFile(
						sonarr,
						arrItemId,
						safetyPlan,
						assertMutationAuthority,
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
	assertMutationAuthority?: MutationAuthorityCheck,
): Promise<void> {
	if (safetyPlan.kind !== "verified_arr_target" && safetyPlan.kind !== "verified_sonarr_episode") {
		throw new Error("A verified ARR target identity is required before unmonitoring");
	}
	const client = arrClientFactory.create(instance);

	switch (instance.service) {
		case "RADARR": {
			const radarr = client as InstanceType<typeof RadarrClient>;
			const movie = await radarr.movie.getById(arrItemId);
			assertVerifiedArrTargetUnchanged(instance, movie.tmdbId, movie.path, safetyPlan.target);
			const authorizedResource = await assertMutationAuthority?.({
				seriesTransition: "unchanged",
			});
			if (!authorizedResource) {
				throw new Error("Final Radarr mutation authority did not return the authorized resource");
			}
			const authorizedMovie = authorizedResource as Awaited<
				ReturnType<typeof radarr.movie.getById>
			>;
			assertVerifiedArrTargetUnchanged(
				instance,
				authorizedMovie.tmdbId,
				authorizedMovie.path,
				safetyPlan.target,
			);
			await radarr.movie.update(arrItemId, {
				...authorizedMovie,
				id: arrItemId,
				monitored: false,
			});
			break;
		}
		case "SONARR": {
			const sonarr = client as InstanceType<typeof SonarrClient>;
			if (safetyPlan.kind === "verified_sonarr_episode") {
				await assertVerifiedSonarrEpisodeUnchanged(sonarr, arrItemId, safetyPlan, {
					monitoredMode: "allow_unmonitored",
				});
				await assertMutationAuthority?.();
				if (safetyPlan.episode.monitored) {
					try {
						await sonarr.episode.setMonitored([safetyPlan.episode.arrEpisodeId], false);
					} catch (error) {
						const unmonitored = await sonarrEpisodeRemainsUnmonitored(
							sonarr,
							arrItemId,
							safetyPlan,
						);
						if (unmonitored === false) throw error;
						if (unmonitored === null) {
							throw new SonarrEpisodeUnmonitorOutcomeUnknownError(error);
						}
					}
				}
				break;
			}
			const series = await sonarr.series.getById(arrItemId);
			assertVerifiedArrTargetUnchanged(instance, series.tvdbId, series.path, safetyPlan.target);
			const authorizedResource = await assertMutationAuthority?.({
				seriesTransition: "unchanged",
			});
			if (!authorizedResource) {
				throw new Error("Final Sonarr mutation authority did not return the authorized resource");
			}
			const authorizedSeries = authorizedResource as Awaited<
				ReturnType<typeof sonarr.series.getById>
			>;
			assertVerifiedArrTargetUnchanged(
				instance,
				authorizedSeries.tvdbId,
				authorizedSeries.path,
				safetyPlan.target,
			);
			await sonarr.series.update(arrItemId, {
				...authorizedSeries,
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
	assertMutationAuthority?: MutationAuthorityCheck,
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

function ruleTypeUsesPlexSeriesCache(ruleType: string): boolean {
	return (
		(ruleType.startsWith("plex_") && ruleType !== "plex_episode_completion") ||
		ruleType === "user_retention" ||
		ruleType === "staleness_score" ||
		ruleType === "recently_active" ||
		ruleType === "seerr_requester_watched" ||
		ruleType === "seerr_requester_not_watched"
	);
}

function ruleTypeUsesJellyfinSeriesCache(ruleType: string): boolean {
	return ruleType.startsWith("jellyfin_") && ruleType !== "jellyfin_episode_completion";
}

async function refreshCurrentExternalRuleCaches(
	deps: CleanupExecutorDeps,
	userId: string,
	activeTypes: Set<string>,
	cleanupRunClaimToken?: string,
): Promise<void> {
	const sources: Array<{
		source: "plex" | "jellyfin";
		services: Array<ServiceInstance["service"]>;
		needed: boolean;
	}> = [
		{
			source: "plex",
			services: ["PLEX"],
			needed: [...activeTypes].some(ruleTypeUsesPlexSeriesCache),
		},
		{
			source: "jellyfin",
			services: ["JELLYFIN", "EMBY"],
			needed: [...activeTypes].some(ruleTypeUsesJellyfinSeriesCache),
		},
	];

	for (const { source, services, needed } of sources) {
		if (!needed) continue;
		const instances = await deps.prisma.serviceInstance.findMany({
			where: { userId, service: { in: services }, enabled: true },
		});
		if (instances.length === 0) {
			throw new Error(`No enabled ${source} instance is available for current rule evidence`);
		}

		for (const instance of instances) {
			if (!deps.externalRuleCacheRefresher) {
				throw new Error(`No ${source} evidence refresher is available`);
			}
			await deps.externalRuleCacheRefresher(source, instance, { cleanupRunClaimToken });
		}
	}
}

/**
 * Build a fully-populated EvalContext by running all relevant prefetch functions.
 * Used by the explain endpoint so it can evaluate rules with real external data
 * rather than an empty context that always returns "not matched" for external rules.
 * Destructive episode authority refreshes cache-backed parent-series evidence
 * from every enabled source before reading it.
 */
export async function buildEvalContext(
	deps: CleanupExecutorDeps,
	userId: string,
	rules: Array<{
		enabled: boolean;
		ruleType: string;
		conditions: string | null;
		plexLibraryFilter?: string | null;
	}>,
	options: {
		destructiveAuthority?: boolean;
		requireAvailableEvidence?: boolean;
		cleanupRunClaimToken?: string;
	} = {},
): Promise<EvalContext> {
	const activeTypes = collectActiveRuleTypes(rules);
	if (options.destructiveAuthority) {
		await refreshCurrentExternalRuleCaches(deps, userId, activeTypes, options.cleanupRunClaimToken);
	}

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

	const needsPlex = PLEX_RULE_TYPES_LIST.some((type) => activeTypes.has(type));
	const needsPlexSectionInventory = collectConfiguredPlexSectionTitles(rules).size > 0;
	const plexEvidence =
		needsPlex || needsPlexSectionInventory
			? await loadPublishedPlexPolicyEvidence(deps, userId, rules)
			: undefined;
	const needsSeerr = SEERR_RULE_TYPES.some((type) => activeTypes.has(type));
	const needsPlexEpisodes = activeTypes.has("plex_episode_completion");
	const needsJellyfin = JELLYFIN_RULE_TYPES.some((type) => activeTypes.has(type));
	const needsJellyfinEpisodes = activeTypes.has("jellyfin_episode_completion");
	const [seerrMap, prefetchedPlexEpisodeMap, jellyfinMap, jellyfinEpisodeMap] = await Promise.all([
		needsSeerr ? prefetchSeerrRequests(deps, userId) : undefined,
		needsPlexEpisodes && plexEvidence
			? prefetchPlexEpisodeData(deps, userId, plexEvidence.generationIds)
			: undefined,
		needsJellyfin ? prefetchJellyfinData(deps, userId) : undefined,
		needsJellyfinEpisodes ? prefetchJellyfinEpisodeData(deps, userId) : undefined,
	]);
	const tmdbListMemberships = activeTypes.has("tmdb_list_member")
		? await prefetchCleanupListMemberships(deps, userId, rules, "tmdb")
		: undefined;
	const traktListMemberships = activeTypes.has("trakt_list_member")
		? await prefetchCleanupListMemberships(deps, userId, rules, "trakt")
		: undefined;

	if (options.requireAvailableEvidence) {
		const unavailable: string[] = [];
		if (needsSeerr && !seerrMap) unavailable.push("Seerr");
		if ((needsPlex || needsPlexSectionInventory) && !plexEvidence) unavailable.push("Plex");
		if (needsPlexEpisodes && !prefetchedPlexEpisodeMap) unavailable.push("Plex episode");
		if (needsJellyfin && !jellyfinMap) unavailable.push("Jellyfin/Emby");
		if (needsJellyfinEpisodes && !jellyfinEpisodeMap) unavailable.push("Jellyfin/Emby episode");
		if (unavailable.length > 0) {
			throw new Error(`Required evaluation evidence is unavailable: ${unavailable.join(", ")}`);
		}
	}

	return {
		now: new Date(),
		seerrMap: seerrMap ?? undefined,
		plexMap: plexEvidence?.plexMap,
		plexSectionTitles: plexEvidence?.plexSectionTitles,
		plexEpisodeMap: plexEvidence ? (prefetchedPlexEpisodeMap ?? undefined) : undefined,
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
	// Dry runs are previews: recording one would mutate the database even
	// though no cleanup action is allowed to do so.
	if (result.isDryRun) return;
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
