import type { FastifyBaseLogger } from "fastify";
import type { Encryptor } from "../auth/encryption.js";
import type { PrismaClient, ServiceInstance } from "../prisma.js";
import {
	claimObservationUnit,
	createOrLoadObservationRun,
	failObservationUnit,
	hasExhaustedObservationRunRetries,
} from "../provider-observation/observation-run-repository.js";
import {
	buildObservationAuthorityKey,
	type ObservationRunProgress,
	type ObservationUnitClaim,
} from "../provider-observation/observation-run-types.js";
import {
	beginPlexCacheRefreshAttempt,
	claimProviderCacheRefreshAttempt,
	finishPlexCacheRefreshAttemptFailure,
	type PlexCacheRefreshAttempt,
	type PlexCacheRefreshType,
} from "../services/provider-cache-status.js";
import {
	createProviderPublicationAuthority,
	ProviderIdentityGuardError,
	type ProviderPublicationAuthority,
	sameProviderPublicationAuthority,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import { PlexAuthorityService } from "./plex-authority-service.js";
import {
	createOwnedPlexPublicationSnapshot,
	type PlexCacheRefreshResult,
	type PlexPublicationContext,
	refreshPlexCacheWithAttempt,
} from "./plex-cache-refresher.js";
import { PlexClient } from "./plex-client.js";
import type { PlexEpisodeRefreshResult } from "./plex-episode-cache-refresher.js";
import { collectPlexEpisodeUnit } from "./plex-episode-live-collector.js";
import { planPlexEpisodeRefresh } from "./plex-episode-refresh-plan.js";
import {
	finalizePlexEpisodeRun,
	stagePlexEpisodeUnitInTransaction,
} from "./plex-episode-refresh-repository.js";
import { plexConnectionFingerprint } from "./service-instance-fingerprint.js";

export type OwnedPlexRefreshContext = {
	prisma: PrismaClient;
	encryptor: Pick<Encryptor, "decrypt">;
	instance: ServiceInstance;
	log: FastifyBaseLogger;
	cleanupRunClaimToken?: string;
	resumeFailed?: boolean;
};

type PlexEpisodeRunProgress = ObservationRunProgress & {
	retryCategory?:
		| "identity-unavailable"
		| "parent-refresh-in-progress"
		| "parent-refresh-unavailable";
	attemptFailed?: true;
	superseded?: true;
	publishedItemCount?: number;
	completedAt?: Date;
};

/**
 * Production composition seam for the durable episode runner.  The runner
 * itself continues to own all claims, reproofs, staging, and finalization;
 * only provider construction and the narrow parent-authority reader are
 * supplied here so callers and integration tests exercise the same core.
 */
export type PlexEpisodeWorkItemRunnerDependencies = {
	createParentAuthority: (input: {
		prisma: PrismaClient;
		log: FastifyBaseLogger;
	}) => Pick<PlexAuthorityService, "readPositiveEpisodeParents">;
	createClient: (input: {
		baseUrl: string;
		apiKey: string;
		log: FastifyBaseLogger;
		httpAuthHeaders?: Record<string, string>;
	}) => PlexClient;
};

const defaultPlexEpisodeWorkItemRunnerDependencies: PlexEpisodeWorkItemRunnerDependencies = {
	createParentAuthority: ({ prisma, log }) => new PlexAuthorityService({ prisma, log }),
	createClient: ({ baseUrl, apiKey, log, httpAuthHeaders }) =>
		new PlexClient(baseUrl, apiKey, log, undefined, httpAuthHeaders),
};

const PREPARATION_FAILURE_MESSAGE = "Plex refresh preparation failed before publication";

function attemptOptions(context: OwnedPlexRefreshContext) {
	return context.cleanupRunClaimToken === undefined
		? {}
		: { cleanupRunClaimToken: context.cleanupRunClaimToken };
}

function plexPreparationFailure(): PlexCacheRefreshResult {
	return {
		upserted: 0,
		errors: 1,
		errorMessages: [PREPARATION_FAILURE_MESSAGE],
		complete: false,
	};
}

function plexPreparationSuperseded(): PlexCacheRefreshResult {
	return {
		upserted: 0,
		errors: 0,
		errorMessages: [],
		complete: false,
		superseded: true,
	};
}

/**
 * Acquire durable cache authority before any decryptable Plex preparation.
 * This is deliberately private: callers use the two cache-specific wrappers
 * below rather than selecting arbitrary refresh functions after acquiring a
 * token.
 */
async function refreshWithOwnedPlexAttempt<TResult>(
	context: OwnedPlexRefreshContext,
	cacheType: PlexCacheRefreshType,
	run: (
		publicationContext: PlexPublicationContext,
		attempt: PlexCacheRefreshAttempt,
	) => Promise<TResult>,
	failure: () => TResult,
	superseded: () => TResult,
	claimedAttempt?: PlexCacheRefreshAttempt,
): Promise<TResult> {
	let authority: ProviderPublicationAuthority;
	let attempt: PlexCacheRefreshAttempt | null;
	const options = attemptOptions(context);
	try {
		authority = createProviderPublicationAuthority(context.instance);
		attempt =
			claimedAttempt ??
			(await beginPlexCacheRefreshAttempt(context.prisma, cacheType, authority, options));
	} catch {
		context.log.error({ cacheType, category: "preparation-failed" }, PREPARATION_FAILURE_MESSAGE);
		return failure();
	}
	if (!attempt) return superseded();

	try {
		const publicationContext: PlexPublicationContext = {
			prisma: context.prisma,
			instance: createOwnedPlexPublicationSnapshot(context.encryptor, context.instance),
			log: context.log,
			...(context.cleanupRunClaimToken === undefined
				? {}
				: { cleanupRunClaimToken: context.cleanupRunClaimToken }),
		};
		return await run(publicationContext, attempt);
	} catch {
		const finished = await finishPlexCacheRefreshAttemptFailure(
			context.prisma,
			cacheType,
			PREPARATION_FAILURE_MESSAGE,
			authority,
			attempt,
			context.log,
			options,
		);
		if (finished === "superseded") return superseded();
		context.log.error({ cacheType, category: "preparation-failed" }, PREPARATION_FAILURE_MESSAGE);
		return failure();
	}
}

/** Refresh library evidence after revoking authority before credential preparation. */
export async function refreshOwnedPlexCache(
	context: OwnedPlexRefreshContext,
): Promise<PlexCacheRefreshResult> {
	return await refreshWithOwnedPlexAttempt(
		context,
		"plex",
		async (publicationContext, attempt) =>
			await refreshPlexCacheWithAttempt(publicationContext, attempt),
		plexPreparationFailure,
		plexPreparationSuperseded,
	);
}

/**
 * Continue a Plex library refresh after a durable claim has already been
 * acquired. This path intentionally skips beginPlexCacheRefreshAttempt so an
 * accepted request cannot replace its caller's attempt.
 */
export async function refreshOwnedPlexCacheWithAttempt(
	context: OwnedPlexRefreshContext,
	attempt: PlexCacheRefreshAttempt,
): Promise<PlexCacheRefreshResult> {
	return await refreshWithOwnedPlexAttempt(
		context,
		"plex",
		async (publicationContext, exactAttempt) =>
			await refreshPlexCacheWithAttempt(publicationContext, exactAttempt),
		plexPreparationFailure,
		plexPreparationSuperseded,
		attempt,
	);
}

/** Refresh episode evidence after revoking authority before credential preparation. */
export async function refreshOwnedPlexEpisodeCache(
	context: OwnedPlexRefreshContext,
): Promise<PlexEpisodeRefreshResult> {
	const progress = await runNextPlexEpisodeWorkItem(context);
	return {
		upserted: progress.publishedItemCount ?? 0,
		errors:
			progress.superseded ||
			(!progress.attemptFailed && progress.state !== "failed" && progress.state !== "invalidated")
				? 0
				: 1,
		errorMessages: [],
		eligibleShows: progress.totalWork,
		refreshedShows: progress.completedWork,
		coverageIncomplete: progress.state !== "complete",
		capacityDegraded: false,
		complete: progress.state === "complete",
		...(progress.completedAt ? { completedAt: progress.completedAt } : {}),
		...(progress.superseded ? { superseded: true } : {}),
		...(progress.retryCategory ? { retryCategory: progress.retryCategory } : {}),
	};
}

/** Continue a Plex episode refresh with the caller's exact durable claim. */
export async function refreshOwnedPlexEpisodeCacheWithAttempt(
	context: OwnedPlexRefreshContext,
	attempt: PlexCacheRefreshAttempt,
): Promise<PlexEpisodeRefreshResult> {
	const progress = await runNextPlexEpisodeWorkItem(context, attempt);
	return {
		upserted: progress.publishedItemCount ?? 0,
		errors:
			progress.superseded ||
			(!progress.attemptFailed && progress.state !== "failed" && progress.state !== "invalidated")
				? 0
				: 1,
		errorMessages: [],
		eligibleShows: progress.totalWork,
		refreshedShows: progress.completedWork,
		coverageIncomplete: progress.state !== "complete",
		capacityDegraded: false,
		complete: progress.state === "complete",
		...(progress.completedAt ? { completedAt: progress.completedAt } : {}),
		...(progress.superseded ? { superseded: true } : {}),
		...(progress.retryCategory ? { retryCategory: progress.retryCategory } : {}),
	};
}

function emptyEpisodeProgress(
	retryCategory?: PlexEpisodeRunProgress["retryCategory"],
): PlexEpisodeRunProgress {
	return {
		state: "failed",
		completedUnits: 0,
		totalUnits: 0,
		completedWork: 0,
		totalWork: 0,
		reasonCode: "no-publication",
		...(retryCategory ? { retryCategory } : {}),
	};
}

async function runProgress(prisma: PrismaClient, runId: string): Promise<PlexEpisodeRunProgress> {
	const run = await prisma.providerObservationRun.findUnique({ where: { id: runId } });
	if (!run) return emptyEpisodeProgress();
	return {
		state: run.state as ObservationRunProgress["state"],
		completedUnits: run.completedUnits,
		totalUnits: run.totalUnits,
		completedWork: run.completedWork,
		totalWork: run.totalWork,
		...(run.lastReasonCode
			? { reasonCode: run.lastReasonCode as ObservationRunProgress["reasonCode"] }
			: {}),
	};
}

function exactAttemptIsUsable(attempt: PlexCacheRefreshAttempt) {
	return (
		attempt.attemptedAt instanceof Date &&
		Number.isFinite(attempt.attemptedAt.getTime()) &&
		attempt.resultMarker.startsWith("in_progress:")
	);
}

async function currentOwnedPlexInstance(context: OwnedPlexRefreshContext) {
	return await context.prisma.serviceInstance.findFirst({
		where: {
			id: context.instance.id,
			userId: context.instance.userId,
			service: "PLEX",
			enabled: true,
		},
	});
}

/**
 * Builds the scheduler-facing durable runner from production dependencies.
 * Keeping this factory public makes composition auditable without exposing
 * raw persistence repositories or duplicating the workflow for tests.
 */
export function createPlexEpisodeWorkItemRunner(
	deps: PlexEpisodeWorkItemRunnerDependencies = defaultPlexEpisodeWorkItemRunnerDependencies,
) {
	return async function runNextPlexEpisodeWorkItemCore(
		context: OwnedPlexRefreshContext,
		preclaimedAttempt?: PlexCacheRefreshAttempt,
	): Promise<PlexEpisodeRunProgress> {
		let authority: ProviderPublicationAuthority;
		try {
			authority = createProviderPublicationAuthority(context.instance);
		} catch {
			return emptyEpisodeProgress();
		}
		let attempt: PlexCacheRefreshAttempt;
		let acquired = false;
		if (preclaimedAttempt) {
			if (!exactAttemptIsUsable(preclaimedAttempt)) return emptyEpisodeProgress();
			const status = await context.prisma.cacheRefreshStatus.findUnique({
				where: {
					instanceId_cacheType: { instanceId: context.instance.id, cacheType: "plex_episode" },
				},
			});
			if (
				!status ||
				status.lastAttemptAt?.getTime() !== preclaimedAttempt.attemptedAt.getTime() ||
				status.lastAttemptResult !== preclaimedAttempt.resultMarker ||
				status.connectionGeneration !== authority.connectionGeneration ||
				status.identityGeneration !== authority.identityGeneration
			)
				return emptyEpisodeProgress();
			attempt = preclaimedAttempt;
		} else {
			const attemptClaim = await claimProviderCacheRefreshAttempt(
				context.prisma,
				"plex_episode",
				authority,
				attemptOptions(context),
			);
			if (attemptClaim.status === "superseded")
				return { ...emptyEpisodeProgress(), superseded: true };
			attempt = attemptClaim.attempt;
			acquired = attemptClaim.status === "acquired";
		}
		const terminateAcquired = async () => {
			if (!acquired) return;
			await finishPlexCacheRefreshAttemptFailure(
				context.prisma,
				"plex_episode",
				"coverage-incomplete",
				authority,
				attempt,
				context.log,
				attemptOptions(context),
			);
		};
		const parentAuthority = deps.createParentAuthority({
			prisma: context.prisma,
			log: context.log,
		});
		const parents = await parentAuthority.readPositiveEpisodeParents({
			userId: context.instance.userId,
			instanceId: context.instance.id,
		});
		if (!parents.available || !("targets" in parents) || parents.targets.length === 0) {
			await terminateAcquired();
			return emptyEpisodeProgress(
				!parents.available
					? parents.evidence?.attemptState === "in_progress"
						? "parent-refresh-in-progress"
						: "parent-refresh-unavailable"
					: undefined,
			);
		}
		const targets = parents.targets.map((target) => ({
			instanceId: target.instanceId,
			generationId: parents.generationId,
			showTmdbId: target.tmdbId,
			sectionId: target.sectionId,
			sectionUuid: target.sectionUuid,
			mediaType: "series" as const,
			tvdbId: target.tvdbId,
			ratingKey: target.ratingKey,
		}));
		const plan = planPlexEpisodeRefresh(targets);
		if (plan.units.length === 0) {
			await terminateAcquired();
			return emptyEpisodeProgress();
		}
		const runAuthority = {
			provider: "plex_episode" as const,
			cacheType: "plex_episode" as const,
			instanceId: context.instance.id,
			parentGenerationId: parents.generationId,
			targetDigest: plan.targetDigest,
			connectionGeneration: parents.connectionGeneration,
			identityGeneration: parents.identityGeneration,
		};
		const expectedAuthorityKey = buildObservationAuthorityKey(runAuthority);
		const run = await createOrLoadObservationRun(context.prisma, {
			authority: runAuthority,
			units: plan.units.map((unit) => ({
				ordinal: unit.ordinal,
				scopeKey: unit.scopeKey,
				scopeDigest: unit.scopeDigest,
				scopePayload: JSON.stringify({ ordinal: unit.ordinal }),
				phase: "collect" as const,
				expectedTargets: unit.targets.length,
			})),
			resumeFailed: context.resumeFailed,
		});
		const runOwnsAttempt =
			run.instanceId === runAuthority.instanceId &&
			run.provider === runAuthority.provider &&
			run.cacheType === runAuthority.cacheType &&
			run.parentGenerationId === runAuthority.parentGenerationId &&
			run.targetDigest === runAuthority.targetDigest &&
			run.authorityKey === expectedAuthorityKey &&
			run.connectionGeneration === runAuthority.connectionGeneration &&
			run.identityGeneration === runAuthority.identityGeneration;
		const finishAttemptIfExhausted = async () => {
			if (!runOwnsAttempt) return;
			if (
				!(await hasExhaustedObservationRunRetries(context.prisma, {
					runId: run.id,
					authorityKey: run.authorityKey,
				}))
			)
				return;
			await finishPlexCacheRefreshAttemptFailure(
				context.prisma,
				"plex_episode",
				"provider-unavailable",
				authority,
				attempt,
				context.log,
				attemptOptions(context),
				async (tx) =>
					await hasExhaustedObservationRunRetries(tx, {
						runId: run.id,
						authorityKey: run.authorityKey,
					}),
			);
		};
		const failClaim = async (
			claim: ObservationUnitClaim,
			reasonCode: NonNullable<ObservationRunProgress["reasonCode"]>,
		) => {
			const failed = await failObservationUnit(context.prisma, {
				claim,
				reasonCode,
				now: new Date(),
			});
			if (failed) await finishAttemptIfExhausted();
			return await runProgress(context.prisma, run.id);
		};
		const finalizeIfComplete = async (
			progress: PlexEpisodeRunProgress,
		): Promise<PlexEpisodeRunProgress> => {
			if (
				progress.state !== "running" ||
				progress.completedUnits !== progress.totalUnits ||
				progress.completedWork !== progress.totalWork
			)
				return progress;
			const current = await currentOwnedPlexInstance(context);
			if (!current) return { ...progress, superseded: true };
			let currentAuthority: ProviderPublicationAuthority;
			try {
				currentAuthority = createProviderPublicationAuthority(current);
			} catch {
				return { ...progress, superseded: true };
			}
			if (!sameProviderPublicationAuthority(currentAuthority, authority)) {
				return { ...progress, superseded: true };
			}
			const completedAt = new Date();
			let finalized: Awaited<ReturnType<typeof finalizePlexEpisodeRun>>;
			try {
				const snapshot = createOwnedPlexPublicationSnapshot(context.encryptor, current);
				finalized = await withGuardedProviderPublication(
					context.prisma,
					snapshot,
					context.log,
					async () => undefined,
					async (tx) =>
						await finalizePlexEpisodeRun({
							prisma: context.prisma,
							userId: current.userId,
							instance: current,
							runId: run.id,
							plexAuthority: parentAuthority,
							attempt,
							now: completedAt,
							transaction: tx,
							...(context.cleanupRunClaimToken === undefined
								? {}
								: { cleanupRunClaimToken: context.cleanupRunClaimToken }),
						}),
					attemptOptions(context),
				);
			} catch (error) {
				if (error instanceof ProviderIdentityGuardError && error.code === "IDENTITY_UNAVAILABLE") {
					const finished = await finishPlexCacheRefreshAttemptFailure(
						context.prisma,
						"plex_episode",
						"provider-unavailable",
						authority,
						attempt,
						context.log,
						attemptOptions(context),
						async (tx) => {
							const finalizable = await tx.providerObservationRun.findFirst({
								where: {
									id: run.id,
									state: "running",
									activeSlotKey: { not: null },
									authorityKey: run.authorityKey,
									connectionGeneration: run.connectionGeneration,
									identityGeneration: run.identityGeneration,
								},
								select: { id: true },
							});
							return finalizable !== null;
						},
					);
					return finished === "recorded"
						? { ...progress, attemptFailed: true, retryCategory: "identity-unavailable" }
						: { ...progress, superseded: true };
				}
				if (error instanceof ProviderIdentityGuardError) {
					return { ...(await runProgress(context.prisma, run.id)), superseded: true };
				}
				throw error;
			}
			if (finalized.published) {
				return {
					...(await runProgress(context.prisma, run.id)),
					publishedItemCount: finalized.itemCount,
					completedAt,
				};
			}
			switch (finalized.outcome) {
				case "incomplete":
					return progress;
				case "parent-refresh-in-progress":
					return {
						...progress,
						attemptFailed: true,
						retryCategory: "parent-refresh-in-progress",
					};
				case "terminal-no-publication":
					return { ...(await runProgress(context.prisma, run.id)), attemptFailed: true };
				case "superseded":
					return { ...progress, superseded: true };
			}
		};
		const claim = await claimObservationUnit(context.prisma, { runId: run.id, now: new Date() });
		if (!claim) {
			const progress = await runProgress(context.prisma, run.id);
			if (progress.state === "failed") await finishAttemptIfExhausted();
			return await finalizeIfComplete(progress);
		}
		const reproof = await parentAuthority.readPositiveEpisodeParents({
			userId: context.instance.userId,
			instanceId: context.instance.id,
		});
		const reproofTargets =
			reproof.available && "targets" in reproof
				? reproof.targets.map((target) => ({
						instanceId: target.instanceId,
						generationId: reproof.generationId,
						showTmdbId: target.tmdbId,
						sectionId: target.sectionId,
						sectionUuid: target.sectionUuid,
						mediaType: "series" as const,
						tvdbId: target.tvdbId,
						ratingKey: target.ratingKey,
					}))
				: [];
		const reproofPlan = reproofTargets.length ? planPlexEpisodeRefresh(reproofTargets) : null;
		const ordinal = (() => {
			try {
				return JSON.parse(claim.scopePayload ?? "{}").ordinal;
			} catch {
				return -1;
			}
		})();
		const unit = reproofPlan?.units[ordinal];
		if (
			!reproofPlan ||
			!("generationId" in reproof) ||
			reproof.generationId !== parents.generationId ||
			reproofPlan.targetDigest !== plan.targetDigest ||
			run.targetDigest !== reproofPlan.targetDigest ||
			!unit ||
			unit.scopeKey !== claim.scopeKey
		) {
			return await failClaim(claim, "coverage-incomplete");
		}
		const persistedClaim = await context.prisma.providerObservationUnit.findFirst({
			where: {
				id: claim.unitId,
				runId: claim.runId,
				state: "running",
				claimToken: claim.claimToken,
				phase: "collect",
				scopeKey: claim.scopeKey,
			},
			include: { run: true },
		});
		if (
			!persistedClaim ||
			persistedClaim.ordinal !== ordinal ||
			persistedClaim.scopeKey !== unit.scopeKey ||
			persistedClaim.scopeDigest !== unit.scopeDigest ||
			persistedClaim.phase !== "collect" ||
			persistedClaim.expectedTargets !== unit.targets.length ||
			persistedClaim.run.id !== run.id ||
			persistedClaim.run.instanceId !== context.instance.id ||
			persistedClaim.run.provider !== "plex_episode" ||
			persistedClaim.run.cacheType !== "plex_episode" ||
			persistedClaim.run.state !== "running" ||
			persistedClaim.run.activeSlotKey === null ||
			persistedClaim.run.authorityKey !== claim.authorityKey ||
			persistedClaim.run.targetDigest !== run.targetDigest ||
			persistedClaim.run.parentGenerationId !== reproof.generationId ||
			persistedClaim.run.connectionGeneration !== reproof.connectionGeneration ||
			persistedClaim.run.identityGeneration !== reproof.identityGeneration
		) {
			return await failClaim(claim, "coverage-incomplete");
		}
		// The caller row is untrusted after the durable claim. Re-read immediately
		// before decryption and never perform provider I/O from stale authority.
		const current = await currentOwnedPlexInstance(context);
		if (!current) return { ...(await runProgress(context.prisma, run.id)), superseded: true };
		let currentAuthority: ProviderPublicationAuthority;
		try {
			currentAuthority = createProviderPublicationAuthority(current);
		} catch {
			return { ...(await runProgress(context.prisma, run.id)), superseded: true };
		}
		if (
			!sameProviderPublicationAuthority(currentAuthority, authority) ||
			currentAuthority.connectionGeneration !== reproof.connectionGeneration ||
			currentAuthority.identityGeneration !== reproof.identityGeneration
		)
			return { ...(await runProgress(context.prisma, run.id)), superseded: true };
		let guardedUnit: {
			collected: Awaited<ReturnType<typeof collectPlexEpisodeUnit>>;
			staged: boolean;
		};
		try {
			const snapshot = createOwnedPlexPublicationSnapshot(context.encryptor, current);
			const client = deps.createClient({
				baseUrl: snapshot.baseUrl,
				apiKey: snapshot.apiKey,
				log: context.log,
				httpAuthHeaders: snapshot.httpAuthHeaders,
			});
			guardedUnit = await withGuardedProviderPublication(
				context.prisma,
				snapshot,
				context.log,
				async () =>
					await collectPlexEpisodeUnit(client, unit, {
						instanceId: snapshot.id,
						generationId: reproof.generationId,
						connectionGeneration: reproof.connectionGeneration,
						identityGeneration: reproof.identityGeneration,
						sourceFingerprint: plexConnectionFingerprint(snapshot),
					}),
				async (tx, collected) => ({
					collected,
					staged: collected.complete
						? await stagePlexEpisodeUnitInTransaction(tx, claim, unit, collected)
						: false,
				}),
				attemptOptions(context),
			);
		} catch (error) {
			if (error instanceof ProviderIdentityGuardError && error.code !== "IDENTITY_UNAVAILABLE") {
				return { ...(await runProgress(context.prisma, run.id)), superseded: true };
			}
			return await failClaim(claim, "provider-unavailable");
		}
		if (!guardedUnit.collected.complete)
			return await failClaim(claim, guardedUnit.collected.reasonCode);
		if (!guardedUnit.staged) return await runProgress(context.prisma, run.id);
		return await finalizeIfComplete(await runProgress(context.prisma, run.id));
	};
}

/** Scheduler-compatible production runner composed from the default dependencies. */
export const runNextPlexEpisodeWorkItem = createPlexEpisodeWorkItemRunner();
