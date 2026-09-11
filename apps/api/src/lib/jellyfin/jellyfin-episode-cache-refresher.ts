/** Publishes a complete per-instance Jellyfin/Emby episode snapshot atomically. */

import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import { Prisma, type PrismaClient, type ServiceInstance } from "../prisma.js";
import { evaluateProviderCoverageReceipt } from "../provider-observation/coverage-receipt.js";
import {
	claimObservationUnit,
	createOrLoadObservationRun,
	failObservationUnit,
	hasExhaustedObservationRunRetries,
} from "../provider-observation/observation-run-repository.js";
import type { ObservationRunProgress } from "../provider-observation/observation-run-types.js";
import {
	claimProviderCacheRefreshAttempt,
	finishProviderCacheRefreshAttemptFailure,
} from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	type OwnedProviderPublicationSnapshot,
	ProviderIdentityGuardError,
	type ProviderPublicationAuthority,
	sameProviderPublicationAuthority,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { UpstreamValidationError } from "../validation/parse-upstream.js";
import {
	createOwnedJellyfinPublicationSnapshot,
	JELLYFIN_CACHE_PUBLICATION_TRANSACTION_TIMEOUT_MS,
	type JellyfinPublicationContext,
} from "./jellyfin-cache-refresher.js";
import { JellyfinClient } from "./jellyfin-client.js";
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
	fingerprintJellyfinEpisodeParentDependency,
	JELLYFIN_EPISODE_PARENT_KEY_PREFIX,
	jellyfinEpisodeParentGenerationKey,
} from "./jellyfin-episode-parent-dependency.js";
import {
	buildJellyfinEpisodeScopePlan,
	finalizeJellyfinEpisodeRun,
	invalidateJellyfinEpisodeRun,
	JELLYFIN_EPISODE_PARENT_MUTATION_AUTHORITY_MAX_AGE_MS,
	type JellyfinEpisodePageRejectionReason,
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

export { JELLYFIN_EPISODE_PARENT_MUTATION_AUTHORITY_MAX_AGE_MS };

export type JellyfinEpisodeRefreshResult = {
	upserted: number;
	errors: number;
	complete: boolean;
	progressed: boolean;
	errorMessages?: string[];
	completedAt?: Date;
	superseded?: boolean;
	/** The exact invalid plan and its attempt were settled; fresh discovery is needed. */
	replanRequired?: true;
};

export type JellyfinEpisodePublicationContext = {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
	resumeFailed?: boolean;
	now?: Date;
};

/**
 * Production composition seam for the durable page runner.  Claims, guarded
 * publication, staging, recovery compatibility, and finalization stay inside
 * the runner; this only supplies the provider-client constructor.
 */
export type JellyfinEpisodeWorkItemRunnerDependencies = {
	createClient: (input: {
		baseUrl: string;
		apiKey: string;
		log: FastifyBaseLogger;
		httpAuthHeaders?: Record<string, string>;
	}) => JellyfinClient;
};

const defaultJellyfinEpisodeWorkItemRunnerDependencies: JellyfinEpisodeWorkItemRunnerDependencies =
	{
		createClient: ({ baseUrl, apiKey, log, httpAuthHeaders }) =>
			new JellyfinClient(baseUrl, apiKey, log, undefined, httpAuthHeaders),
	};

type JellyfinEpisodeWorkProgress = ObservationRunProgress & {
	/** True only when this invocation durably advanced one claimed provider page. */
	progressed: boolean;
	publishedItemCount?: number;
	retryableDependencyFailure?: true;
	replanRequired?: true;
	superseded?: true;
};

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
	const complete = progress.state === "complete";
	return {
		upserted: progress.publishedItemCount ?? 0,
		errors:
			progress.retryableDependencyFailure ||
			progress.state === "failed" ||
			progress.state === "invalidated"
				? 1
				: 0,
		complete,
		progressed: progress.progressed,
		errorMessages: [],
		...(progress.replanRequired ? { replanRequired: true as const } : {}),
		...(progress.superseded ? { superseded: true } : {}),
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
	return async function runNextJellyfinEpisodeWorkItemCore(
		context: JellyfinEpisodePublicationContext,
	): Promise<JellyfinEpisodeWorkProgress> {
		const now = context.now ?? new Date();
		const guardOptions = {
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
		let outer: Awaited<ReturnType<typeof claimProviderCacheRefreshAttempt>>;
		try {
			outer = await claimProviderCacheRefreshAttempt(
				context.prisma,
				"jellyfin_episode",
				authority,
				guardOptions,
			);
		} catch {
			logJellyfinEpisodePrePageFailure(context.log, "current-authority-failed");
			return emptyEpisodeProgress();
		}
		if (outer.status === "superseded") return emptyEpisodeProgress();
		const attempt = outer.attempt;
		const canFinishAttempt = outer.status === "acquired";
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
			return await failAttempt("provider-unavailable");
		}
		const parent = await readAuthoritativeLibraryParent(
			context.prisma,
			current as unknown as OwnedProviderPublicationSnapshot,
			now,
			candidateV2State !== false,
		);
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
			return await failAttempt("provider-unavailable");
		}
		if (savedPlan?.kind === "invalid") {
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
			// Explicit startup/scheduled refresh may renew an exhausted retry epoch,
			// but must use the saved catalog authority rather than today's expanded key.
			if (context.resumeFailed && run.state === "failed") {
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
			// A disappearing candidate cannot turn last-good continuation authority
			// into permission to create a new plan.
			if (parent.temporaryUnavailable) return await failAttempt("provider-unavailable");
			try {
				scopes = await discoverScopes();
			} catch (error) {
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
				plan = buildJellyfinEpisodeScopePlan(scopes, {
					parentLibraryGenerationId: parent.generationId,
					parentLibraryMetadataFingerprint: parent.metadataFingerprint,
					...(parent.catalogProvenance && parent.parentDependencyFingerprint
						? { parentLibraryDependencyFingerprint: parent.parentDependencyFingerprint }
						: {}),
					...(parent.catalogProvenance ? { catalogProvenance: parent.catalogProvenance } : {}),
				});
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
		const claim = await claimObservationUnit(context.prisma, { runId: run.id, now });
		if (!claim) {
			const progress = await runProgress(context.prisma, run.id);
			if (progress.completedUnits !== progress.totalUnits) {
				if (runOwnsAttempt && progress.state === "failed") {
					await finishAttemptIfExhausted();
				}
				return { ...progress, progressed: false };
			}
			if (parent.temporaryUnavailable) {
				return { ...progress, retryableDependencyFailure: true, progressed: false };
			}
			let finalScopes: Array<{ userId: string; userName: string; libraryId: string }>;
			try {
				finalScopes = await discoverScopes();
			} catch (error) {
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
			if (!finalParent) {
				const lastGood =
					savedPlan?.kind === "valid"
						? await readAuthoritativeLibraryParent(context.prisma, snapshot, finalNow, true)
						: null;
				if (
					lastGood?.temporaryUnavailable &&
					(activeCatalog
						? catalogProvenanceIsCompatible(activeCatalog, lastGood.catalogProvenance)
						: lastGood.parentGenerationId === activeEpisodeParentGenerationId)
				) {
					return { ...progress, retryableDependencyFailure: true, progressed: false };
				}
				return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
			}
			const finalCatalogCompatible = activeCatalog
				? catalogProvenanceIsCompatible(activeCatalog, finalParent.catalogProvenance)
				: finalParent.parentGenerationId === activeEpisodeParentGenerationId;
			if (!finalCatalogCompatible) {
				return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
			}
			try {
				const finalized = await withGuardedProviderPublication(
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
						}),
					{ ...guardOptions, now: () => finalNow },
				);
				if (!finalized.published)
					return await failAttempt("coverage-incomplete", undefined, runOwnsAttempt);
				return {
					...(await runProgress(context.prisma, run.id)),
					publishedItemCount: finalized.itemCount,
					progressed: false,
				};
			} catch (error) {
				if (isIdentityUnavailable(error)) {
					return { ...progress, retryableDependencyFailure: true, progressed: false };
				}
				return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
			}
		}
		const persisted = claimScope(claim.scopePayload);
		const scope = persisted
			? scopes.find(
					(candidate) =>
						candidate.userId === persisted.userId && candidate.libraryId === persisted.libraryId,
				)
			: undefined;
		if (!scope) {
			return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
		}
		let stagingPage = false;
		try {
			const page = await withGuardedProviderPublication(
				context.prisma,
				snapshot,
				context.log,
				async () =>
					await client.getEpisodeItemsPageWithCoverage(scope.userId, scope.libraryId, claim.cursor),
				async (_tx, collectedPage) => collectedPage,
				guardOptions,
			);
			stagingPage = true;
			const progressed = await stageJellyfinEpisodePage(
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
			);
			if (!progressed) {
				const failed = await failObservationUnit(context.prisma, {
					claim,
					reasonCode: "coverage-incomplete",
					now,
					resetProgress: true,
				});
				if (failed && runOwnsAttempt) await finishAttemptIfExhausted();
				return { ...(await runProgress(context.prisma, run.id)), progressed: false };
			}
			return { ...(await runProgress(context.prisma, run.id)), progressed };
		} catch (error) {
			if (isTerminalIdentityAuthorityFailure(error)) {
				return await failAttempt("coverage-incomplete", run.id, runOwnsAttempt);
			}
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
			const failed = await failObservationUnit(context.prisma, {
				claim,
				reasonCode: "provider-unavailable",
				now,
			});
			if (failed && runOwnsAttempt) await finishAttemptIfExhausted();
			return { ...(await runProgress(context.prisma, run.id)), progressed: false };
		}
	};
}

/** Scheduler-compatible production runner composed from the default dependencies. */
export const runNextJellyfinEpisodeWorkItem = createJellyfinEpisodeWorkItemRunner();

function isTerminalIdentityAuthorityFailure(error: unknown): boolean {
	return error instanceof ProviderIdentityGuardError && error.code !== "IDENTITY_UNAVAILABLE";
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

async function readAuthoritativeLibraryParent(
	prisma: Pick<PrismaClient, "cacheRefreshStatus" | "jellyfinCache">,
	authority: Pick<
		OwnedProviderPublicationSnapshot,
		"id" | "service" | "connectionGeneration" | "identityGeneration"
	>,
	now = new Date(),
	allowCompatibleLastGoodForV2 = false,
): Promise<LibraryParent | null> {
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
	} catch {
		return null;
	}
}
