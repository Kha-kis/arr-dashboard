/** Publishes a complete per-instance Jellyfin/Emby episode snapshot atomically. */

import { createHash } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import { RestoreRuntimeAdmissionError } from "../backup/restore-runtime-admission.js";
import { Prisma, type PrismaClient, type ServiceInstance } from "../prisma.js";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import type { AutomaticObservationRenewalMode } from "../provider-observation/observation-run-repository.js";
import {
	canSettleAutomaticObservationRenewalDeferred,
	claimObservationUnit,
	createOrLoadObservationRun,
	failObservationUnit,
	failOwnedObservationUnit,
	getAutomaticObservationRenewalDeadline,
	hasExhaustedObservationRunRetries,
	releaseCancelledObservationUnitClaim,
	renewExhaustedObservationRun,
} from "../provider-observation/observation-run-repository.js";
import type {
	ObservationRunProgress,
	ObservationUnitClaim,
} from "../provider-observation/observation-run-types.js";
import {
	claimProviderCacheRefreshAttempt,
	finishProviderCacheRefreshAttemptFailure,
	type ProviderCacheRefreshAttempt,
} from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	type ProviderPublicationAuthority,
	sameProviderPublicationAuthority,
	withGuardedProviderCollection,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { UpstreamValidationError } from "../validation/parse-upstream.js";
import {
	type FinalizerLoopDiagnostics,
	finalizerLoopDiagnosticsFrom,
} from "./finalizer-loop-observation.js";
import {
	createOwnedJellyfinPublicationSnapshot,
	JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
	type JellyfinPublicationContext,
} from "./jellyfin-cache-refresher.js";
import { JellyfinClient, type JellyfinEpisodeItemsPage } from "./jellyfin-client.js";
import { invalidateJellyfinEpisodeAttempt } from "./jellyfin-episode-attempt-recovery.js";
import {
	buildJellyfinEpisodeCatalogProvenance,
	decodeJellyfinEpisodeCatalogProvenance,
	JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX,
	type JellyfinEpisodeCatalogProvenance,
	jellyfinEpisodeCatalogGenerationKey,
	jellyfinEpisodeCatalogScopesFromReceipt,
} from "./jellyfin-episode-catalog-provenance.js";
import {
	type FinalizerTransportFailureDiagnostics,
	finalizerTransportDiagnosticsFrom,
	type JellyfinEpisodeFinalizationWorkerPayload,
	type JellyfinEpisodeFinalizerFailureCode,
	type JellyfinEpisodeFinalizerFailureStage,
	type NativeWatchStageFailureDiagnostics,
	runJellyfinEpisodeFinalizerWorker,
	sanitizeNativeWatchStageFailureDiagnostics,
} from "./jellyfin-episode-finalizer-worker-transport.js";
import type { JellyfinEpisodePageWorkerInput } from "./jellyfin-episode-page-worker-protocol.js";
import { runJellyfinEpisodePageWorker } from "./jellyfin-episode-page-worker-transport.js";
import {
	fingerprintJellyfinEpisodeParentDependency,
	JELLYFIN_EPISODE_PARENT_KEY_PREFIX,
	jellyfinEpisodeParentGenerationKey,
} from "./jellyfin-episode-parent-dependency.js";
import {
	buildJellyfinEpisodeScopePlan,
	finalizeJellyfinEpisodeRun,
	invalidateJellyfinEpisodeRun,
	JELLYFIN_EPISODE_NEW_RUN_PAGE_SIZE,
	JELLYFIN_EPISODE_PARENT_MUTATION_AUTHORITY_MAX_AGE_MS,
	type JellyfinEpisodeFinalizationTiming,
	type JellyfinEpisodePageRejectionReason,
	jellyfinEpisodePageSizeFromPayload,
	readCompletedJellyfinEpisodePublication,
	stageJellyfinEpisodePage,
	validateJellyfinEpisodeSavedV2Plan,
	validateJellyfinEpisodeSavedV3Plan,
} from "./jellyfin-episode-refresh-repository.js";
import {
	decodeJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryGenerationMetadata,
	fingerprintJellyfinLibraryRows,
	hasJellyfinEpisodeParentReceipt,
	type JellyfinLibraryRowFingerprintInput,
} from "./jellyfin-generation-metadata.js";
import {
	type NativeWatchPreparationTiming,
	sanitizeNativeWatchPreparationTiming,
} from "./jellyfin-native-watch-preparation-timing.js";
import { cleanupPublishedJellyfinEpisodeArtifacts } from "./jellyfin-native-watch-repository.js";

export { JELLYFIN_EPISODE_PARENT_MUTATION_AUTHORITY_MAX_AGE_MS };

export type JellyfinEpisodeRefreshResult = {
	upserted: number;
	errors: number;
	complete: boolean;
	progressed: boolean;
	errorMessages?: string[];
	completedAt?: Date;
	superseded?: boolean;
	/** The owned run was settled but complete coverage needs fresh discovery. */
	replanRequired?: true;
	/** Automatic renewal stopped; only a validated future deadline may schedule recovery. */
	renewalDeferred?: true;
	renewalDeadline?: Date;
	retryablePreRenewalFailure?: true;
	/** A valid current parent library refresh owns admission temporarily. */
	parentRefreshPending?: true;
};

export type JellyfinEpisodePublicationContext = {
	signal?: AbortSignal;
	prisma: PrismaClient;
	/** The configured database URL; supplied by production composition for SQLite worker routing. */
	databaseUrl?: string;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
	resumeFailed?: boolean;
	automaticRenewal?: AutomaticObservationRenewalMode;
	now?: Date;
};

/**
 * Production composition seam for the durable page runner.  Claims, guarded
 * publication, staging, recovery compatibility, and finalization stay inside
 * the runner; this supplies discovery and the physically joined page read.
 */
export type JellyfinEpisodeWorkItemRunnerDependencies = {
	createClient: (input: {
		signal?: AbortSignal;
		baseUrl: string;
		apiKey: string;
		log: FastifyBaseLogger;
		httpAuthHeaders?: Record<string, string>;
	}) => JellyfinClient;
	readPage: (
		input: JellyfinEpisodePageWorkerInput,
		client: JellyfinClient,
		signal?: AbortSignal,
	) => Promise<JellyfinEpisodeItemsPage>;
};

const defaultJellyfinEpisodeWorkItemRunnerDependencies: JellyfinEpisodeWorkItemRunnerDependencies =
	{
		createClient: ({ baseUrl, apiKey, log, httpAuthHeaders, signal }) =>
			new JellyfinClient(baseUrl, apiKey, log, undefined, httpAuthHeaders, undefined, signal),
		readPage: (input, _client, signal) => runJellyfinEpisodePageWorker(input, { signal }),
	};

type JellyfinEpisodeWorkProgress = ObservationRunProgress & {
	/** True only when this invocation durably advanced one claimed provider page. */
	progressed: boolean;
	publishedItemCount?: number;
	retryableDependencyFailure?: true;
	replanRequired?: true;
	superseded?: true;
	renewalDeferred?: true;
	renewalDeadline?: Date;
	retryablePreRenewalFailure?: true;
	parentRefreshPending?: true;
};

type EpisodeClaimState = {
	authority?: ProviderPublicationAuthority;
	attempt?: ProviderCacheRefreshAttempt;
	claim?: ObservationUnitClaim;
	failure?: Parameters<typeof failObservationUnit>[1];
};

type PendingEpisodeFailure = {
	authorityFingerprint: string;
	authorityKey: string;
	attempt: ProviderCacheRefreshAttempt;
	failure: Parameters<typeof failObservationUnit>[1];
};

function episodeAuthorityFingerprint(authority: ProviderPublicationAuthority): string {
	return createHash("sha256").update(JSON.stringify(authority)).digest("hex");
}

type JellyfinEpisodePageFailureCategory =
	| "episode-page-coverage"
	| "episode-page-envelope-schema"
	| "episode-page-limit"
	| "episode-stage-conflict"
	| "episode-stage-timeout"
	| "episode-stage-contention"
	| "episode-stage-unavailable"
	| "episode-row-invariant"
	| "episode-row-schema"
	| "identity-unavailable"
	| "provider-response-unavailable"
	| "provider-timeout";

export type JellyfinEpisodePrePageFailureCategory =
	| "parent-admission-failed"
	| "current-authority-failed"
	| "client-preparation-failed"
	| "scope-discovery-failed"
	| "scope-discovery-timeout"
	| "scope-inventory-incomplete"
	| "scope-response-schema"
	| "scope-plan-failed"
	| "run-admission-failed";

export function logJellyfinEpisodePrePageFailure(
	log: Pick<FastifyBaseLogger, "warn">,
	category: JellyfinEpisodePrePageFailureCategory,
): void {
	if (typeof log.warn !== "function") return;
	log.warn({ category }, "Jellyfin episode refresh pre-page dependency unavailable");
}

/** Closed operational categories; never expose upstream errors or values. */
export function classifyJellyfinEpisodeScopeFailure(
	error: unknown,
): JellyfinEpisodePrePageFailureCategory {
	if (error instanceof UpstreamValidationError) return "scope-response-schema";
	if (!(error instanceof Error)) return "scope-discovery-failed";
	if (error.name === "TimeoutError") return "scope-discovery-timeout";
	if (error.message === "Jellyfin library inventory was not returned completely")
		return "scope-inventory-incomplete";
	if (
		error.message === "Jellyfin API returned invalid JSON" ||
		error.message === "Jellyfin API returned an unexpected response type"
	)
		return "scope-response-schema";
	return "scope-discovery-failed";
}

function classifyJellyfinEpisodeStageFailure(error: unknown): JellyfinEpisodePageFailureCategory {
	if (error instanceof Prisma.PrismaClientKnownRequestError) {
		switch (error.code) {
			case "P2002":
				return "episode-stage-conflict";
			case "P2028":
				return "episode-stage-timeout";
			case "P2034":
				return "episode-stage-contention";
		}
	}
	return "episode-stage-unavailable";
}

function stageFailureDiagnostics(error: unknown) {
	if (error instanceof RestoreRuntimeAdmissionError)
		return { errorCategory: "runtime-admission", databaseCode: null, sqliteCode: null } as const;
	if (!(error instanceof Prisma.PrismaClientKnownRequestError))
		return { errorCategory: "other", databaseCode: null, sqliteCode: null } as const;
	const databaseCode = [
		"P1001",
		"P1002",
		"P1008",
		"P1017",
		"P2002",
		"P2024",
		"P2028",
		"P2034",
	].includes(error.code)
		? error.code
		: "other";
	const adapter = error.meta?.driverAdapterError;
	const cause = adapter && typeof adapter === "object" ? Reflect.get(adapter, "cause") : null;
	const originalCode =
		cause && typeof cause === "object" ? Reflect.get(cause, "originalCode") : null;
	const sqliteCode =
		originalCode === null || originalCode === undefined
			? null
			: ["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT", "SQLITE_LOCKED"].includes(originalCode)
				? originalCode
				: "other";
	return { errorCategory: "prisma-known", databaseCode, sqliteCode } as const;
}

function classifyJellyfinEpisodePageFailure(error: unknown): JellyfinEpisodePageFailureCategory {
	if (error instanceof UpstreamValidationError) {
		return error.issues.some((issue) => issue.startsWith("Items.") || issue.startsWith("Items["))
			? "episode-row-schema"
			: "episode-page-envelope-schema";
	}
	if (error instanceof ProviderIdentityGuardError && error.code === "IDENTITY_UNAVAILABLE") {
		return "identity-unavailable";
	}
	if (!(error instanceof Error)) return "provider-response-unavailable";
	if (error.name === "TimeoutError") return "provider-timeout";
	if (error.message === "Jellyfin episode page rows are inconsistent") {
		return "episode-row-invariant";
	}
	if (error.message === "Jellyfin episode page coverage is inconsistent") {
		return "episode-page-coverage";
	}
	if (error.message === "Jellyfin episode page exceeds the safe 100000-row limit") {
		return "episode-page-limit";
	}
	return "provider-response-unavailable";
}

export async function refreshJellyfinEpisodeCache(
	context: JellyfinPublicationContext,
): Promise<JellyfinEpisodeRefreshResult> {
	void context;
	// Legacy callers do not hold the encryptor required to re-read the current
	// owned connection. They cannot safely resume a durable episode run.
	return {
		upserted: 0,
		errors: 1,
		complete: false,
		progressed: false,
		errorMessages: ["provider-unavailable"],
	};
}

export async function refreshOwnedJellyfinEpisodeCache(
	context: JellyfinEpisodePublicationContext,
): Promise<JellyfinEpisodeRefreshResult> {
	const progress = await runNextJellyfinEpisodeWorkItem(context);
	const complete = progress.state === "complete" && !progress.replanRequired;
	return {
		upserted: progress.publishedItemCount ?? 0,
		errors:
			progress.retryableDependencyFailure ||
			progress.replanRequired ||
			progress.state === "failed" ||
			progress.state === "invalidated"
				? 1
				: 0,
		complete,
		progressed: progress.progressed,
		errorMessages: [],
		...(progress.replanRequired ? { replanRequired: true as const } : {}),
		...(progress.superseded ? { superseded: true } : {}),
		...(progress.renewalDeferred ? { renewalDeferred: true as const } : {}),
		...(progress.renewalDeadline ? { renewalDeadline: progress.renewalDeadline } : {}),
		...(progress.retryablePreRenewalFailure ? { retryablePreRenewalFailure: true as const } : {}),
		...(progress.parentRefreshPending ? { parentRefreshPending: true as const } : {}),
		...(complete ? { completedAt: context.now ?? new Date() } : {}),
	};
}

function emptyEpisodeProgress(): JellyfinEpisodeWorkProgress {
	return {
		state: "failed",
		completedUnits: 0,
		totalUnits: 0,
		completedWork: 0,
		totalWork: 0,
		reasonCode: "no-publication",
		progressed: false,
	};
}

function parentRefreshPendingProgress(): JellyfinEpisodeWorkProgress {
	return {
		...emptyEpisodeProgress(),
		state: "running",
		parentRefreshPending: true,
	};
}

async function runProgress(
	prisma: PrismaClient,
	runId: string,
): Promise<JellyfinEpisodeWorkProgress> {
	const run = await prisma.providerObservationRun.findUnique({ where: { id: runId } });
	if (!run) return emptyEpisodeProgress();
	return {
		state: run.state as ObservationRunProgress["state"],
		completedUnits: run.completedUnits,
		totalUnits: run.totalUnits,
		completedWork: run.completedWork,
		progressed: false,
		totalWork: run.totalWork,
		...(run.lastReasonCode
			? { reasonCode: run.lastReasonCode as ObservationRunProgress["reasonCode"] }
			: {}),
	};
}

function claimScope(payload: string | null) {
	try {
		const value: unknown = JSON.parse(payload ?? "");
		return typeof value === "object" &&
			value !== null &&
			typeof (value as { userId?: unknown }).userId === "string" &&
			typeof (value as { libraryId?: unknown }).libraryId === "string"
			? (value as { userId: string; libraryId: string })
			: null;
	} catch {
		return null;
	}
}

/** Builds the scheduler-facing durable runner from production dependencies. */
export function createJellyfinEpisodeWorkItemRunner(
	deps: JellyfinEpisodeWorkItemRunnerDependencies = defaultJellyfinEpisodeWorkItemRunnerDependencies,
) {
	// One small intent per failed instance, scoped to this client's lifetime.
	// No page/catalog payload, plaintext connection, timer or admitted operation
	// survives a call. A replacement client uses normal startup recovery instead.
	const pendingFailures = new WeakMap<PrismaClient, Map<string, PendingEpisodeFailure>>();
	function forgetPending(
		context: JellyfinEpisodePublicationContext,
		pending: PendingEpisodeFailure,
	): void {
		const failures = pendingFailures.get(context.prisma);
		if (failures?.get(context.instance.id) !== pending) return;
		failures.delete(context.instance.id);
		if (failures.size === 0) pendingFailures.delete(context.prisma);
	}
	async function recoverPendingFailure(
		context: JellyfinEpisodePublicationContext,
	): Promise<JellyfinEpisodeWorkProgress | null> {
		const pending = pendingFailures.get(context.prisma)?.get(context.instance.id);
		if (!pending) return null;
		checkEpisodeCancellation(context.signal);
		const authority = createProviderPublicationAuthority(context.instance);
		if (episodeAuthorityFingerprint(authority) !== pending.authorityFingerprint) {
			forgetPending(context, pending);
			return { ...emptyEpisodeProgress(), superseded: true };
		}
		const result = await retryJellyfinEpisodeFailureSettlement(
			context,
			async () =>
				await failOwnedObservationUnit(context.prisma, {
					failure: pending.failure,
					authority,
					authorityKey: pending.authorityKey,
					attempt: pending.attempt,
					now: context.now,
					cleanupRunClaimToken: context.cleanupRunClaimToken,
				}),
		);
		if (result.status === "unavailable")
			return { ...emptyEpisodeProgress(), state: "running", retryableDependencyFailure: true };
		forgetPending(context, pending);
		return result.status === "recorded"
			? {
					...result.progress,
					progressed: false,
					...(result.renewalDeadline ? { renewalDeadline: result.renewalDeadline } : {}),
				}
			: { ...emptyEpisodeProgress(), superseded: true };
	}
	async function runNextJellyfinEpisodeWorkItemCore(
		context: JellyfinEpisodePublicationContext,
		markAdmissionStarted: () => void,
		preRenewal: { settle: () => Promise<boolean> },
		cancellation: EpisodeClaimState,
	): Promise<JellyfinEpisodeWorkProgress> {
		checkEpisodeCancellation(context.signal);
		const workItemStartedAt = performance.now();
		async function observeWorkStage<T>(
			stage:
				| "unit-claim"
				| "guarded-read"
				| "provider-read"
				| "collection-fence"
				| "page-stage"
				| "run-progress",
			operation: () => Promise<T>,
		): Promise<T> {
			const startedAt = performance.now();
			const record = (state: "entered" | "succeeded" | "failed") => {
				try {
					context.log.info(
						{
							category: "jellyfin-episode-work-stage",
							stage,
							state,
							elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
						},
						"Jellyfin episode work stage",
					);
				} catch {
					// Diagnostics never replace an operation's result or release its claim.
				}
			};
			record("entered");
			let state: "succeeded" | "failed" = "failed";
			try {
				const value = await operation();
				state = "succeeded";
				return value;
			} finally {
				record(state);
			}
		}
		const now = context.now ?? new Date();
		const guardOptions = {
			signal: context.signal,
			cleanupRunClaimToken: context.cleanupRunClaimToken,
			now: () => now,
			timeout: JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
		};
		let authority: ProviderPublicationAuthority;
		try {
			authority = createProviderPublicationAuthority(context.instance);
		} catch {
			logJellyfinEpisodePrePageFailure(context.log, "current-authority-failed");
			return emptyEpisodeProgress();
		}
		cancellation.authority = authority;
		// A parent library refresh keeps the last published generation intact while
		// it owns the provider status marker. Check that dependency before claiming
		// an episode attempt so waiting does not create a failure or consume a retry.
		try {
			if (await hasCurrentJellyfinLibraryRefreshPending(context.prisma, context.instance, now)) {
				const currentForParentAdmission = await context.prisma.serviceInstance.findFirst({
					where: {
						id: context.instance.id,
						userId: context.instance.userId,
						service: { in: ["JELLYFIN", "EMBY"] },
						enabled: true,
					},
				});
				if (
					currentForParentAdmission &&
					sameProviderPublicationAuthority(
						createProviderPublicationAuthority(currentForParentAdmission),
						authority,
					)
				) {
					return parentRefreshPendingProgress();
				}
			}
		} catch {
			// Preserve the existing admission path when this advisory early check is
			// unavailable; it still performs the authoritative parent read below.
		}
		let outer: Awaited<ReturnType<typeof claimProviderCacheRefreshAttempt>>;
		try {
			outer = await claimProviderCacheRefreshAttempt(
				context.prisma,
				"jellyfin_episode",
				authority,
				guardOptions,
			);
		} catch (error) {
			if (isTransientEpisodeDatabaseFailure(error)) throw error;
			logJellyfinEpisodePrePageFailure(context.log, "current-authority-failed");
			return emptyEpisodeProgress();
		}
		if (outer.status === "superseded") return emptyEpisodeProgress();
		const attempt = outer.attempt;
		cancellation.attempt = attempt;
		const canFinishAttempt = outer.status === "acquired";
		preRenewal.settle = async () =>
			canFinishAttempt &&
			(await finishProviderCacheRefreshAttemptFailure(
				context.prisma,
				"jellyfin_episode",
				"collection-deferred",
				authority,
				attempt,
				context.log,
				guardOptions,
			)) === "recorded";
		const retryPreRenewal = async (): Promise<JellyfinEpisodeWorkProgress> => ({
			...emptyEpisodeProgress(),
			...((await preRenewal.settle()) && context.automaticRenewal
				? { retryablePreRenewalFailure: true as const }
				: {}),
		});
		const failAttempt = async (
			reasonCode: "coverage-incomplete" | "provider-unavailable",
			runId?: string,
			ownsBoundAttempt = false,
		) => {
			if (runId) await invalidateJellyfinEpisodeRun(context.prisma, runId, now);
			if (canFinishAttempt || ownsBoundAttempt) {
				await finishProviderCacheRefreshAttemptFailure(
					context.prisma,
					"jellyfin_episode",
					reasonCode,
					authority,
					attempt,
					context.log,
					guardOptions,
				);
			}
			return emptyEpisodeProgress();
		};
		const deferForParentRefresh = async (): Promise<JellyfinEpisodeWorkProgress> => {
			if (canFinishAttempt) {
				await finishProviderCacheRefreshAttemptFailure(
					context.prisma,
					"jellyfin_episode",
					"collection-deferred",
					authority,
					attempt,
					context.log,
					guardOptions,
				);
			}
			return parentRefreshPendingProgress();
		};
		const current = await context.prisma.serviceInstance.findFirst({
			where: {
				id: context.instance.id,
				userId: context.instance.userId,
				service: { in: ["JELLYFIN", "EMBY"] },
				enabled: true,
			},
		});
		if (
			!current ||
			!sameProviderPublicationAuthority(createProviderPublicationAuthority(current), authority)
		) {
			logJellyfinEpisodePrePageFailure(context.log, "current-authority-failed");
			return await failAttempt("coverage-incomplete");
		}
		const candidateV2State = await hasActiveJellyfinEpisodeV2Candidate(
			context.prisma,
			current.id,
			authority,
		);
		if (candidateV2State === null) {
			logJellyfinEpisodePrePageFailure(context.log, "run-admission-failed");
			return await retryPreRenewal();
		}
		const parent = await readAuthoritativeLibraryParent(
			context.prisma,
			current as unknown as OwnedProviderPublicationSnapshot,
			now,
			candidateV2State !== false,
			context.automaticRenewal !== undefined,
		);
		if (isParentRefreshPending(parent)) return await deferForParentRefresh();
		if (!parent) {
			logJellyfinEpisodePrePageFailure(context.log, "parent-admission-failed");
			return await failAttempt("coverage-incomplete");
		}
		const catalogGenerationKey =
			candidateV2State === "v2"
				? null
				: parent.catalogProvenance
					? jellyfinEpisodeCatalogGenerationKey(parent.catalogProvenance)
					: null;
		const episodeParentGenerationId = catalogGenerationKey ?? parent.parentGenerationId;
		let snapshot: OwnedProviderPublicationSnapshot;
		let client: JellyfinClient;
		try {
			snapshot = createOwnedJellyfinPublicationSnapshot(
				context.encryptor,
				current as unknown as ServiceInstance,
			);
			client = deps.createClient({
				signal: context.signal,
				baseUrl: snapshot.baseUrl,
				apiKey: snapshot.apiKey,
				log: context.log,
				httpAuthHeaders: snapshot.httpAuthHeaders,
			});
		} catch {
			logJellyfinEpisodePrePageFailure(context.log, "client-preparation-failed");
			return await failAttempt("provider-unavailable");
		}
		const activeRunBeforeDiscovery = await findActiveJellyfinEpisodeRun(
			context.prisma,
			current.id,
			episodeParentGenerationId,
			authority,
		);
		const discoverScopes = async () =>
			await withGuardedProviderPublication(
				context.prisma,
				snapshot,
				context.log,
				async () => {
					const discovered: Array<{ userId: string; userName: string; libraryId: string }> = [];
					for (const user of await client.getUsers()) {
						for (const library of await client.getLibraries(user.id)) {
							discovered.push({
								userId: user.id,
								userName: user.name,
								libraryId: library.id,
							});
						}
					}
					return discovered;
				},
				async (_tx, discovered) => discovered,
				guardOptions,
			);
		const savedPlan = await findSavedJellyfinEpisodeV2Plan(
			context.prisma,
			current.id,
			episodeParentGenerationId,
			authority,
			parent.parentGenerationId,
			parent.catalogProvenance,
		);
		if (savedPlan?.kind === "unavailable") {
			logJellyfinEpisodePrePageFailure(context.log, "run-admission-failed");
			return await retryPreRenewal();
		}
		if (savedPlan?.kind === "invalid") {
			markAdmissionStarted();
			logJellyfinEpisodePrePageFailure(context.log, "scope-plan-failed");
			const settlement = await invalidateJellyfinEpisodeAttempt({
				prisma: context.prisma,
				authority,
				attempt,
				runId: savedPlan.run.id,
				now,
				cleanupRunClaimToken: context.cleanupRunClaimToken,
			});
			return {
				...emptyEpisodeProgress(),
				...(settlement === "recorded" ? { replanRequired: true } : { superseded: true }),
			};
		}
		const activeEpisodeParentGenerationId =
			savedPlan?.kind === "valid" ? savedPlan.run.parentGenerationId : episodeParentGenerationId;
		const activeCatalog =
			savedPlan?.kind === "valid" ? savedPlan.catalogProvenance : parent.catalogProvenance;
		let scopes: Array<{ userId: string; userName: string; libraryId: string }>;
		let plan: ReturnType<typeof buildJellyfinEpisodeScopePlan>;
		let run: Awaited<ReturnType<typeof createOrLoadObservationRun>>;
		if (savedPlan?.kind === "valid") {
			plan = savedPlan.plan;
			scopes = savedPlan.scopes;
			run = savedPlan.run;
			const automaticV3Recovery =
				context.automaticRenewal === "provider-unavailable-cooldown" &&
				run.state === "failed" &&
				run.parentGenerationId?.startsWith(JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX);
			if (
				automaticV3Recovery &&
				run.nextAttemptAt === null &&
				(await hasExhaustedObservationRunRetries(context.prisma, {
					runId: run.id,
					authorityKey: run.authorityKey,
				}))
			) {
				if (!canFinishAttempt) {
					return { ...(await runProgress(context.prisma, run.id)), renewalDeferred: true };
				}
				markAdmissionStarted();
				const renewed = await renewExhaustedObservationRun(context.prisma, {
					mode: "provider-unavailable-cooldown",
					runId: run.id,
					instanceId: current.id,
					userId: current.userId,
					authorityKey: run.authorityKey,
					parentGenerationId: run.parentGenerationId!,
					targetDigest: plan.targetDigest,
					connectionGeneration: authority.connectionGeneration,
					identityGeneration: authority.identityGeneration,
					now,
				});
				if (renewed === "deferred") {
					const renewalDeadline = await getAutomaticObservationRenewalDeadline(context.prisma, {
						runId: run.id,
						instanceId: current.id,
						userId: current.userId,
						authorityKey: run.authorityKey,
						parentGenerationId: run.parentGenerationId!,
						targetDigest: plan.targetDigest,
						connectionGeneration: authority.connectionGeneration,
						identityGeneration: authority.identityGeneration,
						now,
					});
					const settlement = await finishProviderCacheRefreshAttemptFailure(
						context.prisma,
						"jellyfin_episode",
						"collection-deferred",
						authority,
						attempt,
						context.log,
						guardOptions,
						async (tx) =>
							await canSettleAutomaticObservationRenewalDeferred(tx, {
								runId: run.id,
								instanceId: current.id,
								authorityKey: run.authorityKey,
								parentGenerationId: run.parentGenerationId!,
								targetDigest: plan.targetDigest,
								connectionGeneration: authority.connectionGeneration,
								identityGeneration: authority.identityGeneration,
								now,
							}),
					);
					return {
						...(await runProgress(context.prisma, run.id)),
						progressed: false,
						renewalDeferred: true,
						...(settlement === "recorded" &&
						renewalDeadline &&
						renewalDeadline.getTime() > now.getTime()
							? { renewalDeadline }
							: {}),
					};
				}
				run = await context.prisma.providerObservationRun.findUniqueOrThrow({
					where: { id: run.id },
				});
			}
			// Automatic refresh must preserve a retryable V3 run's persisted deadline.
			// Explicit Retry may reset a failed epoch using the saved catalog authority.
			markAdmissionStarted();
			if (context.resumeFailed && run.state === "failed" && !automaticV3Recovery) {
				try {
					run = await createOrLoadObservationRun(context.prisma, {
						authority: {
							provider: "jellyfin_episode",
							cacheType: "jellyfin_episode",
							instanceId: current.id,
							parentGenerationId: run.parentGenerationId,
							targetDigest: plan.targetDigest,
							connectionGeneration: authority.connectionGeneration,
							identityGeneration: authority.identityGeneration,
						},
						units: plan.units,
						resumeFailed: true,
					});
				} catch {
					logJellyfinEpisodePrePageFailure(context.log, "run-admission-failed");
					return await failAttempt("provider-unavailable");
				}
			}
		} else {
			markAdmissionStarted();
			// A disappearing candidate cannot turn last-good continuation authority
			// into permission to create a new plan.
			if (parent.temporaryUnavailable) return await failAttempt("provider-unavailable");
			try {
				scopes = await discoverScopes();
			} catch (error) {
				if (isEpisodeCancellation(error)) throw error;
				logJellyfinEpisodePrePageFailure(context.log, classifyJellyfinEpisodeScopeFailure(error));
				if (isIdentityUnavailable(error) && activeRunBeforeDiscovery) {
					return {
						...(await runProgress(context.prisma, activeRunBeforeDiscovery.id)),
						retryableDependencyFailure: true,
						progressed: false,
					};
				}
				return await failAttempt(
					isTerminalIdentityAuthorityFailure(error)
						? "coverage-incomplete"
						: "provider-unavailable",
					isTerminalIdentityAuthorityFailure(error)
						? (activeRunBeforeDiscovery?.id ?? undefined)
						: undefined,
				);
			}
			try {
				plan = buildJellyfinEpisodeScopePlan(
					scopes,
					{
						parentLibraryGenerationId: parent.generationId,
						parentLibraryMetadataFingerprint: parent.metadataFingerprint,
						...(parent.catalogProvenance && parent.parentDependencyFingerprint
							? { parentLibraryDependencyFingerprint: parent.parentDependencyFingerprint }
							: {}),
						...(parent.catalogProvenance ? { catalogProvenance: parent.catalogProvenance } : {}),
					},
					current.service === "JELLYFIN" ? JELLYFIN_EPISODE_NEW_RUN_PAGE_SIZE : 1_000,
				);
			} catch {
				logJellyfinEpisodePrePageFailure(context.log, "scope-plan-failed");
				return await failAttempt("coverage-incomplete");
			}
			if (plan.targetCount === 0) {
				logJellyfinEpisodePrePageFailure(context.log, "scope-plan-failed");
				return await failAttempt("coverage-incomplete");
			}
			try {
				run = await createOrLoadObservationRun(context.prisma, {
					authority: {
						provider: "jellyfin_episode",
						cacheType: "jellyfin_episode",
						instanceId: current.id,
						parentGenerationId: episodeParentGenerationId,
						targetDigest: plan.targetDigest,
						connectionGeneration: authority.connectionGeneration,
						identityGeneration: authority.identityGeneration,
					},
					units: plan.units,
					resumeFailed: context.resumeFailed,
				});
			} catch {
				logJellyfinEpisodePrePageFailure(context.log, "run-admission-failed");
				return await failAttempt("coverage-incomplete");
			}
		}
		const runOwnsAttempt =
			run.instanceId === current.id &&
			run.provider === "jellyfin_episode" &&
			run.cacheType === "jellyfin_episode" &&
			run.parentGenerationId === activeEpisodeParentGenerationId &&
			run.targetDigest === plan.targetDigest &&
			run.connectionGeneration === authority.connectionGeneration &&
			run.identityGeneration === authority.identityGeneration;
		const automaticRenewalDeadline = async () => {
			if (!runOwnsAttempt) return null;
			return await getAutomaticObservationRenewalDeadline(context.prisma, {
				runId: run.id,
				instanceId: current.id,
				userId: current.userId,
				authorityKey: run.authorityKey,
				parentGenerationId: run.parentGenerationId!,
				targetDigest: plan.targetDigest,
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				now: context.now ?? new Date(),
			});
		};
		const finishAttemptIfExhausted = async () =>
			await finishProviderCacheRefreshAttemptFailure(
				context.prisma,
				"jellyfin_episode",
				"provider-unavailable",
				authority,
				attempt,
				context.log,
				guardOptions,
				async (tx) =>
					await hasExhaustedObservationRunRetries(tx, {
						runId: run.id,
						authorityKey: run.authorityKey,
					}),
			);
		const finishAttemptIfRetryDeferred = async () => {
			if (!runOwnsAttempt) return null;
			return await finishProviderCacheRefreshAttemptFailure(
				context.prisma,
				"jellyfin_episode",
				"collection-deferred",
				authority,
				attempt,
				context.log,
				guardOptions,
				async (tx) =>
					(await tx.providerObservationRun.count({
						where: {
							id: run.id,
							instanceId: current.id,
							provider: "jellyfin_episode",
							cacheType: "jellyfin_episode",
							authorityKey: run.authorityKey,
							activeSlotKey: { not: null },
							parentGenerationId: run.parentGenerationId,
							targetDigest: plan.targetDigest,
							connectionGeneration: authority.connectionGeneration,
							identityGeneration: authority.identityGeneration,
							state: "failed",
							nextAttemptAt: { gt: now },
						},
					})) === 1,
			);
		};
		const claim = await observeWorkStage(
			"unit-claim",
			async () => await claimObservationUnit(context.prisma, { runId: run.id, now }),
		);
		if (claim) cancellation.claim = claim;
		checkEpisodeCancellation(context.signal);
		if (!claim) {
			const progress = await runProgress(context.prisma, run.id);
			if (progress.completedUnits !== progress.totalUnits) {
				const deferred = progress.state === "failed" ? await finishAttemptIfRetryDeferred() : null;
				const settlement =
					runOwnsAttempt && progress.state === "failed" && deferred !== "recorded"
						? await finishAttemptIfExhausted()
						: null;
				const renewalDeadline = settlement === "recorded" ? await automaticRenewalDeadline() : null;
				return {
					...progress,
					progressed: false,
					...(renewalDeadline ? { renewalDeadline } : {}),
				};
			}
			if (parent.temporaryUnavailable) {
				return { ...progress, retryableDependencyFailure: true, progressed: false };
			}
			const admissionStartedAt = performance.now();
			const logAdmission = (outcome: string) => {
				try {
					context.log.info(
						{
							category: "jellyfin-episode-finalizer-admission-timing",
							outcome,
							durationMs: Math.max(0, Math.round(performance.now() - admissionStartedAt)),
						},
						"Jellyfin episode finalizer admission timing",
					);
				} catch {
					// Timing diagnostics cannot change retry or publication authority.
				}
			};
			let finalScopes: Array<{ userId: string; userName: string; libraryId: string }>;
			try {
				finalScopes = await discoverScopes();
			} catch (error) {
				if (isEpisodeCancellation(error)) throw error;
				logAdmission("scope-unavailable");
				logJellyfinEpisodePrePageFailure(context.log, classifyJellyfinEpisodeScopeFailure(error));
				if (isIdentityUnavailable(error)) {
					return { ...progress, retryableDependencyFailure: true, progressed: false };
				}
				if (isTerminalIdentityAuthorityFailure(error)) {
					return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
				}
				return { ...progress, retryableDependencyFailure: true, progressed: false };
			}
			// Discovery can be slow. Re-read the parent before entering a finalizer
			// that intentionally invalidates stale authority inside its transaction.
			const finalNow = context.now ?? new Date();
			const finalParent = await readAuthoritativeLibraryParent(context.prisma, snapshot, finalNow);
			if (isParentRefreshPending(finalParent)) {
				logAdmission("parent-wait");
				return await deferForParentRefresh();
			}
			if (!finalParent) {
				const lastGood =
					savedPlan?.kind === "valid"
						? await readAuthoritativeLibraryParent(context.prisma, snapshot, finalNow, true)
						: null;
				if (isParentRefreshPending(lastGood)) {
					logAdmission("parent-wait");
					return await deferForParentRefresh();
				}
				if (
					lastGood?.temporaryUnavailable &&
					(activeCatalog
						? catalogProvenanceIsCompatible(activeCatalog, lastGood.catalogProvenance)
						: lastGood.parentGenerationId === activeEpisodeParentGenerationId)
				) {
					logAdmission("parent-unavailable");
					return { ...progress, retryableDependencyFailure: true, progressed: false };
				}
				logAdmission("parent-invalid");
				return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
			}
			const finalCatalogCompatible = activeCatalog
				? catalogProvenanceIsCompatible(activeCatalog, finalParent.catalogProvenance)
				: finalParent.parentGenerationId === activeEpisodeParentGenerationId;
			if (!finalCatalogCompatible) {
				logAdmission("parent-changed");
				return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
			}
			logAdmission("admitted");
			let workerWaitMs: number | undefined;
			const workerUnavailable = async (
				reasonCode:
					| "transport-failed"
					| "transaction-expired"
					| "database-contention"
					| "unknown" = "unknown",
				phase?: "connection" | "publication",
				durationMs?: number,
				stage?: JellyfinEpisodeFinalizerFailureStage,
				code?: JellyfinEpisodeFinalizerFailureCode,
				nativeWatchDiagnostics?: NativeWatchStageFailureDiagnostics,
				loopObservation?: FinalizerLoopDiagnostics,
				transportDiagnostics?: FinalizerTransportFailureDiagnostics,
			): Promise<JellyfinEpisodeWorkProgress> => {
				try {
					context.log.warn(
						{
							category: "jellyfin-episode-finalizer-worker-unavailable",
							reasonCode,
							...finalizerTransportDiagnosticsFrom(transportDiagnostics),
							...(phase ? { phase } : {}),
							...(stage ? { stage } : {}),
							...(code ? { code } : {}),
							...sanitizeNativeWatchStageFailureDiagnostics(stage, nativeWatchDiagnostics),
							loopObservation: finalizerLoopDiagnosticsFrom({ loopObservation }),
							...(durationMs === undefined ? {} : { durationMs }),
							...(workerWaitMs === undefined ? {} : { workerWaitMs }),
						},
						"Jellyfin episode finalizer worker unavailable",
					);
				} catch {
					// Diagnostic logging cannot invalidate resumable staged evidence.
				}
				if (canFinishAttempt || runOwnsAttempt) {
					try {
						await finishProviderCacheRefreshAttemptFailure(
							context.prisma,
							"jellyfin_episode",
							"provider-unavailable",
							authority,
							attempt,
							context.log,
							guardOptions,
							async (tx) =>
								(await tx.jellyfinEpisodePreparation.count({
									where: {
										runId: run.id,
										instanceId: current.id,
										generationId: run.id,
										state: { in: ["preparing", "verified"] },
										leaseExpiresAt: { gt: new Date() },
									},
								})) === 0,
						);
					} catch {
						// A failed attempt-status write cannot discard resumable stages.
					}
				}
				return { ...progress, retryableDependencyFailure: true, progressed: false };
			};
			try {
				const timingRef: { current?: JellyfinEpisodeFinalizationTiming; rawTotalMs?: number } = {};
				let finalizationCallDurationMs: number;
				let outerOverheadMs: number | undefined;
				let cleanupMs: number;
				let cleanupFailed = false;
				let nativeWatchPreparationTiming: NativeWatchPreparationTiming | undefined;
				let finalized: { published: boolean; itemCount: number };
				if (context.databaseUrl && !/^postgres(ql)?:\/\//i.test(context.databaseUrl)) {
					if (snapshot.service !== "JELLYFIN" && snapshot.service !== "EMBY") {
						return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
					}
					let workerResult: Awaited<ReturnType<typeof runJellyfinEpisodeFinalizerWorker>>;
					const workerWaitStartedAt = performance.now();
					try {
						workerResult = await runJellyfinEpisodeFinalizerWorker(
							{
								databaseUrl: context.databaseUrl,
								userId: current.userId,
								instance: snapshot as JellyfinEpisodeFinalizationWorkerPayload["instance"],
								runId: run.id,
								scopes: finalScopes,
								attempt,
								now: finalNow,
								...(context.cleanupRunClaimToken
									? { cleanupRunClaimToken: context.cleanupRunClaimToken }
									: {}),
							},
							{ signal: context.signal },
						);
					} catch (error) {
						workerWaitMs = Math.max(0, Math.round(performance.now() - workerWaitStartedAt));
						let committedItemCount: number | null = null;
						try {
							committedItemCount = await readCompletedJellyfinEpisodePublication(context.prisma, {
								userId: current.userId,
								instanceId: current.id,
								runId: run.id,
								attempt,
							});
						} catch {
							// An unavailable read cannot authorize invalidating resumable stages.
						}
						if (committedItemCount !== null) {
							return {
								...(await runProgress(context.prisma, run.id)),
								publishedItemCount: committedItemCount,
								progressed: false,
							};
						}
						checkEpisodeCancellation(context.signal);
						return await workerUnavailable(
							"transport-failed",
							undefined,
							undefined,
							undefined,
							undefined,
							undefined,
							finalizerLoopDiagnosticsFrom(error),
							finalizerTransportDiagnosticsFrom(error),
						);
					}
					workerWaitMs = Math.max(0, Math.round(performance.now() - workerWaitStartedAt));
					if (workerResult.status === "cancelled")
						throw new ProviderIdentityGuardError(
							"PUBLICATION_CANCELLED",
							"Episode publication cancelled.",
						);
					if (workerResult.status === "identity-unavailable") {
						return { ...progress, retryableDependencyFailure: true, progressed: false };
					}
					if (workerResult.status !== "published") {
						if (workerResult.status === "not-published") {
							try {
								context.log.warn(
									{
										category: "jellyfin-episode-finalizer-not-published",
										reason: workerResult.reason ?? "unknown",
										workerWaitMs,
									},
									"Jellyfin episode finalizer did not publish",
								);
							} catch {
								// Diagnostics cannot change publication or retry authority.
							}
							if (workerResult.reason === "lease-busy" || workerResult.reason === "lease-lost")
								return { ...progress, retryableDependencyFailure: true, progressed: false };
							return await failAttempt("coverage-incomplete", undefined, runOwnsAttempt);
						}
						if (workerResult.status === "failed")
							return await workerUnavailable(
								workerResult.failureCategory,
								workerResult.failurePhase,
								workerResult.failureElapsedMs,
								workerResult.failureStage,
								workerResult.failureCode,
								workerResult,
								finalizerLoopDiagnosticsFrom(workerResult),
							);
						return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
					}
					finalized = { published: true, itemCount: workerResult.itemCount };
					try {
						nativeWatchPreparationTiming = sanitizeNativeWatchPreparationTiming(
							Object.getOwnPropertyDescriptor(workerResult, "nativeWatchPreparationTiming")?.value,
						);
					} catch {
						// Injected or malformed optional diagnostics cannot change publication.
					}
					if (workerResult.timing) timingRef.current = workerResult.timing;
					finalizationCallDurationMs = workerResult.finalizationCallMs;
					outerOverheadMs = workerResult.outerOverheadMs;
					cleanupMs = workerResult.cleanupMs;
					cleanupFailed = workerResult.cleanupFailed;
				} else {
					const finalizationStartedAt = performance.now();
					finalized = await withGuardedProviderPublication(
						context.prisma,
						snapshot,
						context.log,
						async () => undefined,
						async (tx) =>
							await finalizeJellyfinEpisodeRun({
								prisma: context.prisma,
								transaction: tx,
								userId: current.userId,
								instance: current,
								runId: run.id,
								scopes: finalScopes,
								attempt,
								now: finalNow,
								recordTiming: (timing, rawTotalMs) => {
									timingRef.current = timing;
									timingRef.rawTotalMs = rawTotalMs;
								},
							}),
						{ ...guardOptions, now: () => finalNow },
					);
					finalizationCallDurationMs = performance.now() - finalizationStartedAt;
					if (!finalized.published)
						return await failAttempt("coverage-incomplete", undefined, runOwnsAttempt);
					const cleanupStartedAt = performance.now();
					try {
						await cleanupPublishedJellyfinEpisodeArtifacts(context.prisma, current.id, run.id);
					} catch {
						cleanupFailed = true;
					}
					cleanupMs = Math.max(0, Math.round(performance.now() - cleanupStartedAt));
				}
				if (!finalized.published)
					return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
				if (cleanupFailed) {
					context.log.warn(
						{ category: "jellyfin-episode-post-publication-cleanup-failed" },
						"Jellyfin episode post-publication cleanup deferred",
					);
				}
				try {
					if (timingRef.current && typeof context.log.info === "function") {
						context.log.info(
							{
								category: "jellyfin-episode-finalization-timing",
								...timingRef.current,
								...(nativeWatchPreparationTiming ? { nativeWatchPreparationTiming } : {}),
								finalizationCallMs: Math.max(0, Math.round(finalizationCallDurationMs)),
								...(workerWaitMs === undefined ? {} : { workerWaitMs }),
								outerOverheadMs: Math.max(
									0,
									Math.round(
										outerOverheadMs ?? finalizationCallDurationMs - (timingRef.rawTotalMs ?? 0),
									),
								),
								cleanupMs,
							},
							"Jellyfin episode finalization timing",
						);
					}
				} catch {
					// Diagnostics cannot change the committed publication result.
				}
				return {
					...(await runProgress(context.prisma, run.id)),
					publishedItemCount: finalized.itemCount,
					progressed: false,
				};
			} catch (error) {
				if (isEpisodeCancellation(error)) throw error;
				if (isIdentityUnavailable(error)) {
					return { ...progress, retryableDependencyFailure: true, progressed: false };
				}
				return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
			}
		}
		const persisted = claimScope(claim.scopePayload);
		const pageSize = jellyfinEpisodePageSizeFromPayload(claim.scopePayload);
		const scope = persisted
			? scopes.find(
					(candidate) =>
						candidate.userId === persisted.userId && candidate.libraryId === persisted.libraryId,
				)
			: undefined;
		if (!scope || pageSize === null) {
			return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
		}
		let stagingPage = false;
		let settlingRejectedPage = false;
		let providerReadMs = 0;
		let guardMs = 0;
		let stageMs = 0;
		let itemCount = 0;
		let outcome: "progressed" | "rejected" | "failed" = "failed";
		let stageCompletedAt: number | null = null;
		const guardStartedAt = performance.now();
		try {
			const page = await (async () => {
				try {
					return await observeWorkStage("guarded-read", async () => {
						const collectedPage = await withGuardedProviderCollection(
							context.prisma,
							snapshot,
							context.log,
							async () => {
								const readStartedAt = performance.now();
								try {
									return await observeWorkStage(
										"provider-read",
										async () =>
											await deps.readPage(
												{
													baseUrl: snapshot.baseUrl,
													apiKey: snapshot.apiKey,
													httpAuthHeaders: snapshot.httpAuthHeaders,
													userId: scope.userId,
													libraryId: scope.libraryId,
													startIndex: claim.cursor,
													limit: pageSize,
												},
												client,
												context.signal,
											),
									);
								} finally {
									providerReadMs = performance.now() - readStartedAt;
								}
							},
							guardOptions,
						);
						// Completed collection admission grants no durable publication;
						// the separately fenced page-stage below owns persistent writes.
						return await observeWorkStage("collection-fence", async () => collectedPage);
					});
				} finally {
					guardMs = performance.now() - guardStartedAt;
				}
			})();
			itemCount = page.items.length;
			checkEpisodeCancellation(context.signal);
			stagingPage = true;
			const stageStartedAt = performance.now();
			const progressed = await (async () => {
				try {
					return await observeWorkStage(
						"page-stage",
						async () =>
							await retryJellyfinEpisodePageStaging(context, () =>
								stageJellyfinEpisodePage(
									context.prisma,
									claim,
									scope,
									page,
									now,
									(reason: JellyfinEpisodePageRejectionReason) => {
										if (typeof context.log.warn !== "function") return;
										context.log.warn(
											{ category: "episode-page-rejected", reason },
											"Jellyfin episode page unavailable",
										);
									},
								),
							),
					);
				} finally {
					stageCompletedAt = performance.now();
					stageMs = stageCompletedAt - stageStartedAt;
				}
			})();
			checkEpisodeCancellation(context.signal);
			if (!progressed) {
				outcome = "rejected";
				settlingRejectedPage = true;
				cancellation.failure = {
					claim,
					reasonCode: "coverage-incomplete",
					now,
					resetProgress: true,
				};
				const failed = await settleJellyfinEpisodeUnitFailure(context, cancellation.failure);
				cancellation.failure = undefined;
				if (failed && runOwnsAttempt) await finishAttemptIfExhausted();
				return { ...(await runProgress(context.prisma, run.id)), progressed: false };
			}
			outcome = "progressed";
			return {
				...(await observeWorkStage(
					"run-progress",
					async () => await runProgress(context.prisma, run.id),
				)),
				progressed,
			};
		} catch (error) {
			// A failed rejection settlement must not lose resetProgress or be
			// reclassified as a provider failure by this same page-level catch.
			if (settlingRejectedPage) throw error;
			if (isEpisodeCancellation(error)) throw error;
			checkEpisodeCancellation(context.signal);
			if (isTerminalIdentityAuthorityFailure(error)) {
				return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
			}
			try {
				if (typeof context.log.warn === "function") {
					context.log.warn(
						{
							category: stagingPage
								? classifyJellyfinEpisodeStageFailure(error)
								: classifyJellyfinEpisodePageFailure(error),
						},
						"Jellyfin episode page unavailable",
					);
				}
				if (stagingPage && outcome === "failed" && typeof context.log.info === "function") {
					context.log.info(
						{ category: "jellyfin-episode-stage-failure", ...stageFailureDiagnostics(error) },
						"Jellyfin episode staging failure category",
					);
				}
			} catch {
				// Diagnostics cannot prevent fenced settlement or replace its database error.
			}
			cancellation.failure = {
				claim,
				reasonCode: "provider-unavailable",
				now,
			};
			const failed = await settleJellyfinEpisodeUnitFailure(context, cancellation.failure);
			cancellation.failure = undefined;
			const deferred = failed ? await finishAttemptIfRetryDeferred() : null;
			const settlement =
				failed && runOwnsAttempt && deferred !== "recorded"
					? await finishAttemptIfExhausted()
					: null;
			const progress = await runProgress(context.prisma, run.id);
			const renewalDeadline = settlement === "recorded" ? await automaticRenewalDeadline() : null;
			return {
				...progress,
				progressed: false,
				...(renewalDeadline ? { renewalDeadline } : {}),
			};
		} finally {
			try {
				if (typeof context.log.info === "function") {
					const finishedAt = performance.now();
					const elapsed = (duration: number) => Math.max(0, Math.round(duration));
					context.log.info(
						{
							category: "jellyfin-episode-page-timing",
							phase: claim.phase === "verify" ? "verify" : "collect",
							outcome,
							itemCount,
							prePageMs: elapsed(guardStartedAt - workItemStartedAt),
							guardMs: elapsed(guardMs),
							providerReadMs: elapsed(providerReadMs),
							stageMs: elapsed(stageMs),
							postStageMs: stageCompletedAt === null ? 0 : elapsed(finishedAt - stageCompletedAt),
							totalMs: elapsed(finishedAt - workItemStartedAt),
						},
						"Jellyfin episode page timing",
					);
				}
			} catch {
				// Diagnostics must never replace a durable page result or its original failure.
			}
		}
	}
	return async (
		context: JellyfinEpisodePublicationContext,
	): Promise<JellyfinEpisodeWorkProgress> => {
		let admissionStarted = false;
		const preRenewal = { settle: async () => true };
		const cancellation: EpisodeClaimState = {};
		try {
			const recovered = await recoverPendingFailure(context);
			if (recovered) return recovered;
			return await runNextJellyfinEpisodeWorkItemCore(
				context,
				() => {
					admissionStarted = true;
				},
				preRenewal,
				cancellation,
			);
		} catch (error) {
			if (isEpisodeCancellation(error)) {
				if (cancellation.claim && cancellation.authority && cancellation.attempt)
					await releaseCancelledObservationUnitClaim(context.prisma, {
						claim: cancellation.claim,
						authority: cancellation.authority,
						attempt: cancellation.attempt,
						cleanupRunClaimToken: context.cleanupRunClaimToken,
					});
				throw error;
			}
			if (
				cancellation.failure &&
				cancellation.authority &&
				cancellation.attempt &&
				cancellation.claim
			) {
				let failures = pendingFailures.get(context.prisma);
				if (!failures) {
					failures = new Map();
					pendingFailures.set(context.prisma, failures);
				}
				failures.set(cancellation.authority.id, {
					authorityFingerprint: episodeAuthorityFingerprint(cancellation.authority),
					authorityKey: cancellation.claim.authorityKey,
					attempt: {
						...cancellation.attempt,
						attemptedAt: new Date(cancellation.attempt.attemptedAt),
					},
					failure: {
						claim: {
							runId: cancellation.claim.runId,
							unitId: cancellation.claim.unitId,
							claimToken: cancellation.claim.claimToken,
						},
						reasonCode: cancellation.failure.reasonCode,
						now: new Date(cancellation.failure.now),
						resetProgress: cancellation.failure.resetProgress,
					},
				});
			}
			if (
				context.automaticRenewal &&
				!admissionStarted &&
				isTransientEpisodeDatabaseFailure(error)
			) {
				logJellyfinEpisodePrePageFailure(context.log, "run-admission-failed");
				const settled = await preRenewal.settle().catch(() => false);
				return {
					...emptyEpisodeProgress(),
					...(settled ? { retryablePreRenewalFailure: true as const } : {}),
				};
			}
			throw error;
		}
	};
}

async function settleJellyfinEpisodeUnitFailure(
	context: Pick<JellyfinEpisodePublicationContext, "prisma" | "signal">,
	input: Parameters<typeof failObservationUnit>[1],
): Promise<boolean> {
	return await retryJellyfinEpisodeFailureSettlement(
		context,
		async () => await failObservationUnit(context.prisma, input),
	);
}

async function retryJellyfinEpisodePageStaging<T>(
	context: Pick<JellyfinEpisodePublicationContext, "signal" | "log">,
	operation: () => Promise<T>,
): Promise<T> {
	// Only a known BUSY rollback retries the identical atomic page transaction.
	// Its claim/identity fences run again; provider collection is not repeated.
	for (let attempt = 0; ; attempt++) {
		checkEpisodeCancellation(context.signal);
		try {
			return await operation();
		} catch (error) {
			const diagnostics = stageFailureDiagnostics(error);
			if (
				attempt >= 2 ||
				diagnostics.databaseCode !== "P1008" ||
				!["SQLITE_BUSY", "SQLITE_BUSY_SNAPSHOT"].includes(diagnostics.sqliteCode ?? "")
			)
				throw error;
			try {
				context.log.info(
					{ category: "jellyfin-episode-stage-retry", attempt: attempt + 1, ...diagnostics },
					"Retrying an atomic Jellyfin episode stage after database contention",
				);
			} catch {
				// Diagnostics cannot alter retry, cancellation or publication authority.
			}
		}
	}
}

async function retryJellyfinEpisodeFailureSettlement<T>(
	context: Pick<JellyfinEpisodePublicationContext, "prisma" | "signal">,
	operation: () => Promise<T>,
): Promise<T> {
	// The provider worker has joined before either caller reaches settlement.
	// Retry only the rolled-back transaction with the same claim and failure
	// semantics; never repeat provider work or release another worker's lease.
	for (let attempt = 0; ; attempt++) {
		checkEpisodeCancellation(context.signal);
		try {
			return await operation();
		} catch (error) {
			if (attempt >= 2 || !isTransientEpisodeDatabaseFailure(error)) throw error;
		}
	}
}

function isTransientEpisodeDatabaseFailure(error: unknown): boolean {
	return (
		error instanceof Prisma.PrismaClientKnownRequestError &&
		["P1001", "P1002", "P1008", "P1017", "P2024", "P2028", "P2034"].includes(error.code)
	);
}

/** Scheduler-compatible production runner composed from the default dependencies. */
export const runNextJellyfinEpisodeWorkItem = createJellyfinEpisodeWorkItemRunner();

function isTerminalIdentityAuthorityFailure(error: unknown): boolean {
	return (
		error instanceof ProviderIdentityGuardError &&
		error.code !== "IDENTITY_UNAVAILABLE" &&
		error.code !== "PUBLICATION_CANCELLED"
	);
}

function isEpisodeCancellation(error: unknown): boolean {
	return error instanceof ProviderIdentityGuardError && error.code === "PUBLICATION_CANCELLED";
}

function checkEpisodeCancellation(signal?: AbortSignal): void {
	if (signal?.aborted)
		throw new ProviderIdentityGuardError("PUBLICATION_CANCELLED", "Episode publication cancelled.");
}

function isIdentityUnavailable(error: unknown): boolean {
	return error instanceof ProviderIdentityGuardError && error.code === "IDENTITY_UNAVAILABLE";
}

async function findActiveJellyfinEpisodeRun(
	prisma: PrismaClient,
	instanceId: string,
	parentGenerationId: string,
	authority: ProviderPublicationAuthority,
): Promise<{ id: string } | null> {
	try {
		return await prisma.providerObservationRun.findFirst({
			where: {
				instanceId,
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				OR: [
					{ parentGenerationId },
					{ parentGenerationId: { startsWith: JELLYFIN_EPISODE_PARENT_KEY_PREFIX } },
					{ parentGenerationId: { startsWith: JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX } },
				],
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				state: { in: ["running", "failed"] },
				activeSlotKey: { not: null },
			},
			select: { id: true },
		});
	} catch {
		return null;
	}
}

async function hasActiveJellyfinEpisodeV2Candidate(
	prisma: PrismaClient,
	instanceId: string,
	authority: ProviderPublicationAuthority,
): Promise<"v2" | "v3" | false | null> {
	try {
		const candidate = await prisma.providerObservationRun.findFirst({
			where: {
				instanceId,
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				state: { in: ["running", "failed"] },
				activeSlotKey: { not: null },
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				OR: [
					{
						state: "running",
						parentGenerationId: { startsWith: JELLYFIN_EPISODE_PARENT_KEY_PREFIX },
					},
					{ parentGenerationId: { startsWith: JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX } },
				],
			},
			select: { id: true, parentGenerationId: true },
		});
		if (candidate?.parentGenerationId?.startsWith(JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX))
			return "v3";
		if (candidate?.parentGenerationId?.startsWith(JELLYFIN_EPISODE_PARENT_KEY_PREFIX)) return "v2";
		return false;
	} catch {
		return null;
	}
}

async function findSavedJellyfinEpisodeV2Plan(
	prisma: PrismaClient,
	instanceId: string,
	parentGenerationId: string,
	authority: ProviderPublicationAuthority,
	legacyParentGenerationId?: string,
	currentCatalog?: JellyfinEpisodeCatalogProvenance,
): Promise<
	| {
			kind: "valid";
			catalogProvenance?: JellyfinEpisodeCatalogProvenance;
			run: Awaited<ReturnType<typeof createOrLoadObservationRun>>;
			plan: ReturnType<typeof buildJellyfinEpisodeScopePlan>;
			scopes: Array<{ userId: string; userName: string; libraryId: string }>;
	  }
	| { kind: "invalid"; run: { id: string } }
	| { kind: "unavailable" }
	| null
> {
	try {
		const candidate = await prisma.providerObservationRun.findFirst({
			where: {
				instanceId,
				provider: "jellyfin_episode",
				cacheType: "jellyfin_episode",
				state: { in: ["running", "failed"] },
				activeSlotKey: { not: null },
				connectionGeneration: authority.connectionGeneration,
				identityGeneration: authority.identityGeneration,
				OR: [
					{
						state: "running",
						parentGenerationId: { startsWith: JELLYFIN_EPISODE_PARENT_KEY_PREFIX },
					},
					{ parentGenerationId: { startsWith: JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX } },
				],
			},
			include: { units: { take: 20_001, orderBy: { ordinal: "asc" } } },
		});
		if (!candidate) return null;
		if (!Array.isArray(candidate.units)) return { kind: "invalid", run: { id: candidate.id } };
		const validate = candidate.parentGenerationId?.startsWith(JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX)
			? validateJellyfinEpisodeSavedV3Plan
			: validateJellyfinEpisodeSavedV2Plan;
		const validated = validate({
			run: candidate,
			units: candidate.units,
			instanceId,
			parentGenerationId: candidate.parentGenerationId?.startsWith(
				JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX,
			)
				? candidate.parentGenerationId
				: (legacyParentGenerationId ?? parentGenerationId),
			connectionGeneration: authority.connectionGeneration,
			identityGeneration: authority.identityGeneration,
		});
		if (!validated) return { kind: "invalid", run: { id: candidate.id } };
		let catalogProvenance: JellyfinEpisodeCatalogProvenance | undefined;
		if (candidate.parentGenerationId?.startsWith(JELLYFIN_EPISODE_PARENT_V3_KEY_PREFIX)) {
			catalogProvenance =
				decodeJellyfinEpisodeCatalogProvenance(
					JSON.parse(candidate.units[0]!.scopePayload!).catalogProvenance,
				) ?? undefined;
			if (!catalogProvenance || !catalogProvenanceIsCompatible(catalogProvenance, currentCatalog)) {
				return { kind: "invalid", run: { id: candidate.id } };
			}
		}
		return {
			kind: "valid",
			run: candidate,
			...validated,
			...(catalogProvenance ? { catalogProvenance } : {}),
		};
	} catch {
		return { kind: "unavailable" };
	}
}

/** Both catalogs have passed strict decoding and current-parent integrity checks. */
function catalogProvenanceIsCompatible(
	original: JellyfinEpisodeCatalogProvenance,
	current: JellyfinEpisodeCatalogProvenance | undefined,
): boolean {
	if (!current || JSON.stringify(original.scopes) !== JSON.stringify(current.scopes)) return false;
	const bindings = new Set(current.bindings.map((binding) => JSON.stringify(binding)));
	return original.bindings.every((binding) => bindings.has(JSON.stringify(binding)));
}

type LibraryParent = {
	generationId: string;
	parentGenerationId: string;
	metadataFingerprint: string;
	parentDependencyFingerprint: string;
	catalogProvenance?: JellyfinEpisodeCatalogProvenance;
	temporaryUnavailable?: true;
};
type LibraryParentRead = LibraryParent | { parentRefreshPending: true };

function isParentRefreshPending(
	value: LibraryParentRead | null,
): value is { parentRefreshPending: true } {
	return value !== null && "parentRefreshPending" in value && value.parentRefreshPending === true;
}

const JELLYFIN_PARENT_REFRESH_MARKER =
	/^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isCurrentJellyfinLibraryRefreshStatus(
	status: {
		lastAttemptAt: Date | null;
		lastAttemptResult: string | null;
		connectionGeneration: number | null;
		identityGeneration: number | null;
	},
	authority: Pick<OwnedProviderPublicationSnapshot, "connectionGeneration" | "identityGeneration">,
	now: Date,
): boolean {
	return (
		status.lastAttemptAt instanceof Date &&
		Number.isFinite(status.lastAttemptAt.getTime()) &&
		status.lastAttemptAt.getTime() <= now.getTime() &&
		typeof status.lastAttemptResult === "string" &&
		JELLYFIN_PARENT_REFRESH_MARKER.test(status.lastAttemptResult) &&
		status.connectionGeneration === authority.connectionGeneration &&
		status.identityGeneration === authority.identityGeneration
	);
}

async function hasCurrentJellyfinLibraryRefreshPending(
	prisma: Pick<PrismaClient, "cacheRefreshStatus">,
	authority: Pick<
		OwnedProviderPublicationSnapshot,
		"id" | "connectionGeneration" | "identityGeneration"
	>,
	now: Date,
): Promise<boolean> {
	const status = await prisma.cacheRefreshStatus.findUnique({
		where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "jellyfin" } },
		select: {
			lastAttemptAt: true,
			lastAttemptResult: true,
			connectionGeneration: true,
			identityGeneration: true,
		},
	});
	return status ? isCurrentJellyfinLibraryRefreshStatus(status, authority, now) : false;
}

async function readAuthoritativeLibraryParent(
	prisma: Pick<PrismaClient, "cacheRefreshStatus" | "jellyfinCache">,
	authority: Pick<
		OwnedProviderPublicationSnapshot,
		"id" | "service" | "connectionGeneration" | "identityGeneration"
	>,
	now = new Date(),
	allowCompatibleLastGoodForV2 = false,
	throwTransientAdmissionFailure = false,
): Promise<LibraryParentRead | null> {
	try {
		const [status, rawRows] = await Promise.all([
			prisma.cacheRefreshStatus.findUnique({
				where: { instanceId_cacheType: { instanceId: authority.id, cacheType: "jellyfin" } },
				select: {
					lastResult: true,
					itemCount: true,
					generationId: true,
					generationMetadata: true,
					lastRefreshedAt: true,
					lastAttemptAt: true,
					lastAttemptResult: true,
					lastAttemptErrorMessage: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			}),
			prisma.jellyfinCache.findMany({
				where: { instanceId: authority.id },
				select: {
					id: true,
					instanceId: true,
					tmdbId: true,
					mediaType: true,
					libraryId: true,
					libraryName: true,
					title: true,
					jellyfinId: true,
					lastWatchedAt: true,
					watchCount: true,
					watchedByUsers: true,
					onDeck: true,
					userRating: true,
					collections: true,
					addedAt: true,
					thumb: true,
					connectionGeneration: true,
					identityGeneration: true,
				},
			}),
		]);
		if (!status) return null;
		if (isCurrentJellyfinLibraryRefreshStatus(status, authority, now)) {
			return { parentRefreshPending: true };
		}
		const compatibleTemporaryFailure =
			allowCompatibleLastGoodForV2 &&
			status.lastResult === "success" &&
			status.lastAttemptResult === "error" &&
			status.lastAttemptErrorMessage === "provider-unavailable" &&
			status.lastAttemptAt instanceof Date &&
			status.lastRefreshedAt instanceof Date &&
			status.lastAttemptAt > status.lastRefreshedAt &&
			status.lastAttemptAt <= now;
		if (
			status.lastResult !== "success" ||
			(status.lastAttemptResult !== "success" && !compatibleTemporaryFailure) ||
			!(status.lastRefreshedAt instanceof Date) ||
			!(status.lastAttemptAt instanceof Date) ||
			!Number.isFinite(status.lastRefreshedAt.getTime()) ||
			!Number.isFinite(status.lastAttemptAt.getTime()) ||
			(status.lastAttemptAt > status.lastRefreshedAt && !compatibleTemporaryFailure) ||
			status.lastRefreshedAt > now ||
			status.lastAttemptAt > now ||
			now.getTime() - status.lastRefreshedAt.getTime() >
				JELLYFIN_EPISODE_PARENT_MUTATION_AUTHORITY_MAX_AGE_MS ||
			typeof status.generationId !== "string" ||
			status.generationId.trim() === "" ||
			typeof status.generationMetadata !== "string" ||
			status.connectionGeneration !== authority.connectionGeneration ||
			status.identityGeneration !== authority.identityGeneration ||
			!Number.isSafeInteger(status.itemCount) ||
			status.itemCount < 0
		) {
			return null;
		}
		const decoded = decodeJellyfinLibraryGenerationMetadata(status.generationMetadata);
		const coverage = decoded.ok
			? evaluateProviderCoverageReceipt(decoded.metadata.coverageReceipt)
			: null;
		if (
			!decoded.ok ||
			!coverage?.valid ||
			!hasJellyfinEpisodeParentReceipt(decoded.metadata.coverageReceipt) ||
			coverage.provider !== (authority.service === "EMBY" ? "emby" : "jellyfin") ||
			coverage.publishedCanonicalEntities !== rawRows.length ||
			decoded.metadata.provider !== (authority.service === "EMBY" ? "emby" : "jellyfin") ||
			decoded.metadata.connectionGeneration !== authority.connectionGeneration ||
			decoded.metadata.identityGeneration !== authority.identityGeneration ||
			decoded.metadata.itemCount !== rawRows.length ||
			status.itemCount !== rawRows.length
		) {
			return null;
		}
		const rows = rawRows.map((row): JellyfinLibraryRowFingerprintInput | null => {
			const mediaType =
				row.mediaType === "movie" ? "movie" : row.mediaType === "series" ? "series" : null;
			if (
				!mediaType ||
				row.instanceId !== authority.id ||
				row.connectionGeneration !== authority.connectionGeneration ||
				row.identityGeneration !== authority.identityGeneration ||
				!Number.isSafeInteger(row.tmdbId) ||
				row.tmdbId <= 0 ||
				typeof row.libraryId !== "string" ||
				typeof row.libraryName !== "string" ||
				typeof row.title !== "string" ||
				!Number.isSafeInteger(row.watchCount) ||
				row.watchCount < 0 ||
				typeof row.watchedByUsers !== "string" ||
				typeof row.onDeck !== "boolean" ||
				(row.userRating !== null && typeof row.userRating !== "number") ||
				typeof row.collections !== "string" ||
				(row.lastWatchedAt !== null && !Number.isFinite(row.lastWatchedAt.getTime())) ||
				(row.addedAt !== null && !Number.isFinite(row.addedAt.getTime()))
			) {
				return null;
			}
			return {
				id: row.id,
				instanceId: row.instanceId,
				connectionGeneration: row.connectionGeneration,
				identityGeneration: row.identityGeneration,
				tmdbId: row.tmdbId,
				mediaType,
				libraryId: row.libraryId,
				libraryName: row.libraryName,
				title: row.title,
				jellyfinId: row.jellyfinId,
				lastWatchedAt: row.lastWatchedAt,
				watchCount: row.watchCount,
				watchedByUsers: row.watchedByUsers,
				onDeck: row.onDeck,
				userRating: row.userRating,
				collections: row.collections,
				addedAt: row.addedAt,
				thumb: row.thumb,
			};
		});
		if (rows.some((row) => row === null)) return null;
		const semanticRows = rows.filter(
			(row): row is JellyfinLibraryRowFingerprintInput => row !== null,
		);
		if (fingerprintJellyfinLibraryRows(semanticRows) !== decoded.metadata.contentFingerprint) {
			return null;
		}
		const dependencyFingerprint = fingerprintJellyfinEpisodeParentDependency(
			authority.id,
			decoded.metadata,
			semanticRows,
		);
		if (!dependencyFingerprint) return null;
		const catalogScopes = jellyfinEpisodeCatalogScopesFromReceipt(decoded.metadata.coverageReceipt);
		const catalogProvenance = catalogScopes
			? buildJellyfinEpisodeCatalogProvenance(semanticRows, catalogScopes)
			: null;
		return {
			generationId: status.generationId,
			parentGenerationId: jellyfinEpisodeParentGenerationKey(dependencyFingerprint),
			metadataFingerprint: fingerprintJellyfinLibraryGenerationMetadata(decoded.metadata),
			parentDependencyFingerprint: dependencyFingerprint,
			...(catalogProvenance ? { catalogProvenance } : {}),
			...(compatibleTemporaryFailure ? { temporaryUnavailable: true as const } : {}),
		};
	} catch (error) {
		if (throwTransientAdmissionFailure && isTransientEpisodeDatabaseFailure(error)) throw error;
		return null;
	}
}
