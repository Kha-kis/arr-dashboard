import { randomUUID } from "node:crypto";
import {
	type ProviderObservationStatus,
	type ProviderObservationUiProjection,
	type ProviderObservationWorkState,
	projectProviderObservationUi as projectSharedProviderObservationUi,
} from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { Prisma, PrismaClient } from "../prisma.js";
import {
	inspectRecoverableObservationRunForCacheAttempt,
	releaseInheritedObservationUnitClaim,
} from "../provider-observation/observation-run-repository.js";
import {
	hasAuthoritativeProviderCacheGeneration,
	type ProviderIdentityGuardOptions,
	type ProviderPublicationAuthority,
	withCurrentProviderPublicationAuthority,
} from "./provider-identity-guard.js";

export type WatchProviderCacheRefreshType =
	| "plex"
	| "plex_episode"
	| "jellyfin"
	| "jellyfin_episode"
	| "tautulli";
export type PlexCacheRefreshType = Extract<WatchProviderCacheRefreshType, "plex" | "plex_episode">;

export type ProviderCacheRefreshAttempt = {
	attemptedAt: Date;
	resultMarker: string;
};
export type PlexCacheRefreshAttempt = ProviderCacheRefreshAttempt;
export type ProviderCacheAttemptFailurePrecondition = (
	tx: Prisma.TransactionClient,
) => Promise<boolean>;

export type ProviderCacheRefreshClaim =
	| { status: "acquired"; attempt: ProviderCacheRefreshAttempt }
	| { status: "already-running"; attempt: ProviderCacheRefreshAttempt }
	| { status: "superseded" };

const providerClaimLocks = new Map<string, Promise<void>>();

/**
 * The cache and Pulse boundaries share the same safe presentation projection.
 * Keep this adapter here so server callers do not recreate reason-code rules.
 */
export function projectProviderObservationUi(
	status: ProviderObservationStatus,
	work?: { state: ProviderObservationWorkState; progress?: unknown } & Record<string, unknown>,
): ProviderObservationUiProjection {
	return projectSharedProviderObservationUi(status, work);
}

export type ProviderCacheRefreshPublication = {
	observedAt: Date;
	itemCount: number;
	generationId: string | null;
	generationMetadata: string | null;
};

export type ProviderCacheStatusGenerationRelation =
	| "current"
	| "obsolete"
	| "future-or-inconsistent";

const TAUTULLI_STATUS_REASON_CODES = new Set([
	"refresh_in_progress",
	"refresh_failed",
	"credential_unavailable",
	"provider_identity_changed",
	"publication_superseded",
	"publication-superseded",
	"no_supported_libraries",
	"provider_response_invalid",
	"legacy_error_redacted",
	"cache_generation_stale",
	"cache_rows_stale",
	"cache_stale",
	"tautulli_mapping_required",
	"provider_completion_unverifiable",
	"receipt-invalid",
	"coverage-incomplete",
	"accepted-skips",
	"provider-limit",
	"provider-unavailable",
	"rows-inconsistent",
	"positive-only",
	"unknown_failure",
	"unknown-failure",
]);

function boundedProviderStatusMessage(
	cacheType: WatchProviderCacheRefreshType,
	message: string,
): string {
	if (cacheType !== "tautulli") return message.slice(0, 500);
	return TAUTULLI_STATUS_REASON_CODES.has(message) ? message : "legacy_error_redacted";
}

type ProviderCacheStatusGeneration = {
	connectionGeneration: number | null;
	identityGeneration: number | null;
};

/**
 * Classify persisted cache provenance relative to the exact verified service
 * authority. Unknown, unsafe, future, and crossed state fail closed.
 */
export function classifyProviderCacheStatusGeneration(
	status: unknown,
	authority: unknown,
): ProviderCacheStatusGenerationRelation {
	if (!isGenerationAuthority(authority) || !isStatusGeneration(status)) {
		return "future-or-inconsistent";
	}
	if (
		(status.connectionGeneration !== null &&
			status.connectionGeneration > authority.connectionGeneration) ||
		(status.identityGeneration !== null && status.identityGeneration > authority.identityGeneration)
	) {
		return "future-or-inconsistent";
	}
	if (
		status.connectionGeneration === authority.connectionGeneration &&
		status.identityGeneration === authority.identityGeneration
	) {
		return "current";
	}
	return "obsolete";
}

/**
 * Revoke prior Plex mutation authority before any upstream read. The opaque
 * marker doubles as a durable cross-process claim without requiring a schema
 * change; only the attempt that still owns this exact marker may finish.
 */
export async function beginPlexCacheRefreshAttempt(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: PlexCacheRefreshType,
	instance: ProviderPublicationAuthority,
	options: ProviderIdentityGuardOptions = {},
): Promise<PlexCacheRefreshAttempt | null> {
	return await beginProviderCacheRefreshAttempt(prisma, cacheType, instance, options);
}

export async function beginProviderCacheRefreshAttempt(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: WatchProviderCacheRefreshType,
	instance: ProviderPublicationAuthority,
	options: ProviderIdentityGuardOptions = {},
): Promise<ProviderCacheRefreshAttempt | null> {
	const claim = await claimProviderCacheRefreshAttempt(prisma, cacheType, instance, options);
	return claim.status === "acquired" ? claim.attempt : null;
}

/**
 * Durably claim one provider refresh for the exact verified service authority.
 * A valid current in-progress marker is an existing owner, never a replaceable
 * lease; terminal rows are claimed with a compare-and-set over the entire
 * observed status row.
 */
export async function claimProviderCacheRefreshAttempt(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: WatchProviderCacheRefreshType,
	instance: ProviderPublicationAuthority,
	options: ProviderIdentityGuardOptions = {},
): Promise<ProviderCacheRefreshClaim> {
	if (!supportsCacheType(instance.service, cacheType)) {
		throw new Error("Provider cache type does not match publication service");
	}
	let attemptedAt: Date;
	try {
		attemptedAt = (options.now ?? (() => new Date()))();
	} catch {
		return { status: "superseded" };
	}
	if (!isValidDate(attemptedAt)) return { status: "superseded" };
	const resultMarker = `in_progress:${randomUUID()}`;
	const initialFailureMessage =
		cacheType === "tautulli"
			? "refresh_in_progress"
			: "provider cache refresh has not published a generation";
	const executeClaim = () =>
		withCurrentProviderPublicationAuthority(
			prisma,
			instance,
			async (tx) => {
				const status = await tx.cacheRefreshStatus.findUnique({
					where: { instanceId_cacheType: { instanceId: instance.id, cacheType } },
					select: {
						id: true,
						instanceId: true,
						cacheType: true,
						lastRefreshedAt: true,
						lastResult: true,
						lastErrorMessage: true,
						itemCount: true,
						generationId: true,
						generationMetadata: true,
						connectionGeneration: true,
						identityGeneration: true,
						lastAttemptAt: true,
						lastAttemptResult: true,
						lastAttemptErrorMessage: true,
					},
				});
				if (status) {
					const relation = classifyProviderCacheStatusGeneration(status, instance);
					if (relation === "future-or-inconsistent") return { status: "superseded" } as const;
					if (
						isValidDate(status.lastAttemptAt) &&
						status.lastAttemptAt.getTime() > attemptedAt.getTime()
					) {
						return { status: "superseded" } as const;
					}
					if (relation === "current" && isInProgressAttempt(status, attemptedAt)) {
						return {
							status: "already-running",
							attempt: {
								attemptedAt: status.lastAttemptAt,
								resultMarker: status.lastAttemptResult,
							},
						} as const;
					}
					if (relation === "obsolete") {
						const takeover = await tx.cacheRefreshStatus.updateMany({
							where: statusClaimWhere(status, instance.id, cacheType),
							data: {
								lastRefreshedAt: attemptedAt,
								lastResult: "error",
								lastErrorMessage: initialFailureMessage,
								itemCount: 0,
								generationId: null,
								generationMetadata: null,
								lastAttemptAt: attemptedAt,
								lastAttemptResult: resultMarker,
								lastAttemptErrorMessage: null,
								connectionGeneration: instance.connectionGeneration,
								identityGeneration: instance.identityGeneration,
							},
						});
						return takeover.count === 1
							? ({ status: "acquired", attempt: { attemptedAt, resultMarker } } as const)
							: ({ status: "superseded" } as const);
					}
					const takeover = await tx.cacheRefreshStatus.updateMany({
						where: statusClaimWhere(status, instance.id, cacheType),
						data: {
							lastAttemptAt: attemptedAt,
							lastAttemptResult: resultMarker,
							lastAttemptErrorMessage: null,
						},
					});
					return takeover.count === 1
						? ({ status: "acquired", attempt: { attemptedAt, resultMarker } } as const)
						: ({ status: "superseded" } as const);
				}
				await tx.cacheRefreshStatus.create({
					data: {
						instanceId: instance.id,
						cacheType,
						lastRefreshedAt: attemptedAt,
						lastResult: "error",
						lastErrorMessage: initialFailureMessage,
						itemCount: 0,
						lastAttemptAt: attemptedAt,
						lastAttemptResult: resultMarker,
						lastAttemptErrorMessage: null,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					},
				});
				return { status: "acquired", attempt: { attemptedAt, resultMarker } } as const;
			},
			options,
		);
	return await withProviderClaimLock(`${instance.id}:${cacheType}`, async () => {
		let result: Awaited<ReturnType<typeof executeClaim>>;
		for (let retry = 0; ; retry += 1) {
			try {
				result = await executeClaim();
				break;
			} catch (error) {
				if (!isRetryableClaimConflict(error) || retry >= 2) throw error;
				await new Promise<void>((resolve) =>
					setTimeout(resolve, 100 * (retry + 1) + Math.floor(Math.random() * 250)),
				);
			}
		}
		return result.matched && result.value ? result.value : { status: "superseded" };
	});
}

async function withProviderClaimLock<T>(key: string, action: () => Promise<T>): Promise<T> {
	const previous = providerClaimLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	providerClaimLocks.set(key, queued);
	await previous;
	try {
		return await action();
	} finally {
		release();
		if (providerClaimLocks.get(key) === queued) providerClaimLocks.delete(key);
	}
}

function isRetryableClaimConflict(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if (
		"code" in error &&
		typeof error.code === "string" &&
		["P2002", "P2028", "P2034"].includes(error.code)
	) {
		return true;
	}
	const message = error.message.toLowerCase();
	return (
		message.includes("p2002") ||
		message.includes("p2028") ||
		message.includes("p2034") ||
		message.includes("database is locked") ||
		message.includes("transaction already closed") ||
		message.includes("operation has timed out") ||
		message.includes("sockettimeout")
	);
}

function isInProgressAttempt(
	status: { lastAttemptAt: Date | null; lastAttemptResult: string | null },
	now: Date,
): status is { lastAttemptAt: Date; lastAttemptResult: string } {
	return (
		status.lastAttemptAt instanceof Date &&
		isValidDate(status.lastAttemptAt) &&
		status.lastAttemptAt.getTime() <= now.getTime() &&
		isValidAttemptMarker(status.lastAttemptResult)
	);
}

function statusClaimWhere(
	status: {
		id: string;
		lastRefreshedAt?: Date;
		lastResult?: string;
		lastErrorMessage?: string | null;
		itemCount?: number;
		generationId?: string | null;
		generationMetadata?: string | null;
		connectionGeneration?: number | null;
		identityGeneration?: number | null;
		lastAttemptAt?: Date | null;
		lastAttemptResult?: string | null;
		lastAttemptErrorMessage?: string | null;
	},
	instanceId: string,
	cacheType: string,
) {
	return {
		id: status.id,
		instanceId,
		cacheType,
		...(status.lastRefreshedAt === undefined ? {} : { lastRefreshedAt: status.lastRefreshedAt }),
		...(status.lastResult === undefined ? {} : { lastResult: status.lastResult }),
		...(status.lastErrorMessage === undefined ? {} : { lastErrorMessage: status.lastErrorMessage }),
		...(status.itemCount === undefined ? {} : { itemCount: status.itemCount }),
		...(status.generationId === undefined ? {} : { generationId: status.generationId }),
		...(status.generationMetadata === undefined
			? {}
			: { generationMetadata: status.generationMetadata }),
		...(status.connectionGeneration === undefined
			? {}
			: { connectionGeneration: status.connectionGeneration }),
		...(status.identityGeneration === undefined
			? {}
			: { identityGeneration: status.identityGeneration }),
		...(status.lastAttemptAt === undefined ? {} : { lastAttemptAt: status.lastAttemptAt }),
		...(status.lastAttemptResult === undefined
			? {}
			: { lastAttemptResult: status.lastAttemptResult }),
		...(status.lastAttemptErrorMessage === undefined
			? {}
			: { lastAttemptErrorMessage: status.lastAttemptErrorMessage }),
	};
}

/**
 * Reconcile claims inherited from a previous API process. This is deliberately
 * startup-only: it does not infer freshness at read time and never replays an
 * upstream request. The CAS changes only the attempt diagnostics, preserving
 * the last published generation and its rows.
 */
export async function reconcileInterruptedProviderCacheRefreshAttempts(
	prisma: Pick<PrismaClient, "$transaction">,
	options: Pick<ProviderIdentityGuardOptions, "now"> = {},
): Promise<number> {
	return await prisma.$transaction(async (tx) => {
		const recoveryAt = (options.now ?? (() => new Date()))();
		if (!isValidDate(recoveryAt)) throw new Error("Invalid provider cache recovery time");
		const statuses = await tx.cacheRefreshStatus.findMany({
			where: { lastAttemptResult: { startsWith: "in_progress:" } },
			select: {
				id: true,
				instanceId: true,
				cacheType: true,
				lastRefreshedAt: true,
				lastResult: true,
				lastErrorMessage: true,
				itemCount: true,
				generationId: true,
				generationMetadata: true,
				lastAttemptAt: true,
				lastAttemptResult: true,
				lastAttemptErrorMessage: true,
				connectionGeneration: true,
				identityGeneration: true,
				instance: { select: { service: true } },
			},
		});
		let recovered = 0;
		for (const status of statuses) {
			const attemptAt = status.lastAttemptAt;
			const marker = status.lastAttemptResult;
			if (!supportsCacheType(status.instance.service, status.cacheType)) {
				continue;
			}
			const observationCacheType = asObservationCacheType(status.cacheType);
			const recoverableRun =
				observationCacheType !== null &&
				isSafeGeneration(status.connectionGeneration) &&
				isSafeGeneration(status.identityGeneration) &&
				(await inspectRecoverableObservationRunForCacheAttempt(tx, {
					instanceId: status.instanceId,
					cacheType: observationCacheType,
					connectionGeneration: status.connectionGeneration,
					identityGeneration: status.identityGeneration,
				}));
			const reusableAttempt =
				isValidDate(attemptAt) &&
				attemptAt.getTime() <= recoveryAt.getTime() &&
				isValidAttemptMarker(marker);
			if (recoverableRun && reusableAttempt && !recoverableRun.hasInheritedClaim) continue;
			if (recoverableRun) {
				if (recoverableRun.hasInheritedClaim && !reusableAttempt) {
					throw new Error("Provider cache recovery marker is not reusable");
				}
				const updated = await tx.cacheRefreshStatus.updateMany({
					where: statusClaimWhere(status, status.instanceId, status.cacheType),
					data: {
						lastAttemptAt: recoveryAt,
						lastAttemptResult: `in_progress:${randomUUID()}`,
						lastAttemptErrorMessage: null,
					},
				});
				if (updated.count !== 1) {
					throw new Error("Provider cache recovery marker CAS lost");
				}
				for (const claim of recoverableRun.inheritedClaims) {
					if (
						!(await releaseInheritedObservationUnitClaim(tx, {
							runId: recoverableRun.runId,
							unitId: claim.unitId,
							claimToken: claim.claimToken,
							instanceId: status.instanceId,
							cacheType: observationCacheType!,
							authorityKey: recoverableRun.authorityKey,
							connectionGeneration: recoverableRun.connectionGeneration,
							identityGeneration: recoverableRun.identityGeneration,
						}))
					) {
						throw new Error("Provider observation claim CAS lost");
					}
				}
				recovered += updated.count;
				continue;
			}
			const reason = status.cacheType === "tautulli" ? "unknown_failure" : "unknown-failure";
			const updated = await tx.cacheRefreshStatus.updateMany({
				where: statusClaimWhere(status, status.instanceId, status.cacheType),
				data: { lastAttemptResult: "error", lastAttemptErrorMessage: reason },
			});
			recovered += updated.count;
		}
		const activeRuns = await tx.providerObservationRun.findMany({
			where: {
				cacheType: { in: ["plex_episode", "jellyfin_episode"] },
				activeSlotKey: { not: null },
				state: { in: ["running", "failed"] },
			},
			select: {
				id: true,
				instanceId: true,
				cacheType: true,
				units: { where: { state: "running" }, select: { id: true } },
			},
		});
		if (activeRuns.some((run) => run.units.length > 0)) {
			throw new Error("Provider cache recovery found an unmatched inherited claim");
		}
		return recovered;
	});
}

function asObservationCacheType(cacheType: string): "plex_episode" | "jellyfin_episode" | null {
	return cacheType === "plex_episode" || cacheType === "jellyfin_episode" ? cacheType : null;
}

function isGenerationAuthority(value: unknown): value is {
	connectionGeneration: number;
	identityGeneration: number;
} {
	return (
		isRecord(value) &&
		isSafeGeneration(value.connectionGeneration) &&
		isSafeGeneration(value.identityGeneration)
	);
}

function isStatusGeneration(value: unknown): value is ProviderCacheStatusGeneration {
	return (
		isRecord(value) &&
		isNullableSafeGeneration(value.connectionGeneration) &&
		isNullableSafeGeneration(value.identityGeneration)
	);
}

function isNullableSafeGeneration(value: unknown): value is number | null {
	return value === null || isSafeGeneration(value);
}

function isSafeGeneration(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Finish only the exact still-current in-progress Plex attempt. */
export async function finishPlexCacheRefreshAttemptFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: PlexCacheRefreshType,
	message: string,
	instance: ProviderPublicationAuthority,
	attempt: PlexCacheRefreshAttempt,
	log: Pick<FastifyBaseLogger, "warn">,
	options: ProviderIdentityGuardOptions = {},
	precondition?: ProviderCacheAttemptFailurePrecondition,
): Promise<"recorded" | "superseded" | "failed"> {
	return await finishProviderCacheRefreshAttemptFailure(
		prisma,
		cacheType,
		message,
		instance,
		attempt,
		log,
		options,
		precondition,
	);
}

export async function finishProviderCacheRefreshAttemptFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: WatchProviderCacheRefreshType,
	message: string,
	instance: ProviderPublicationAuthority,
	attempt: ProviderCacheRefreshAttempt,
	log: Pick<FastifyBaseLogger, "warn">,
	options: ProviderIdentityGuardOptions = {},
	precondition?: ProviderCacheAttemptFailurePrecondition,
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		if (!supportsCacheType(instance.service, cacheType)) {
			throw new Error("Provider cache type does not match publication service");
		}
		const result = await withCurrentProviderPublicationAuthority(
			prisma,
			instance,
			async (tx) => {
				if (precondition && !(await precondition(tx))) return false;
				const updated = await tx.cacheRefreshStatus.updateMany({
					where: {
						instanceId: instance.id,
						cacheType,
						lastAttemptAt: attempt.attemptedAt,
						lastAttemptResult: attempt.resultMarker,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					},
					data: {
						lastAttemptResult: "error",
						lastAttemptErrorMessage: boundedProviderStatusMessage(cacheType, message),
					},
				});
				return updated.count === 1;
			},
			options,
		);
		return result.matched && result.value ? "recorded" : "superseded";
	} catch (error) {
		void error;
		log.warn(
			{ cacheType, reasonCode: "attempt_status_write_failed" },
			"Failed to finish provider cache refresh attempt",
		);
		return "failed";
	}
}

/** Finish the exact in-progress attempt atomically with its provider rows. */
export async function finishProviderCacheRefreshAttemptSuccess(
	tx: Prisma.TransactionClient,
	cacheType: WatchProviderCacheRefreshType,
	instance: Pick<
		ProviderPublicationAuthority,
		"id" | "service" | "connectionGeneration" | "identityGeneration"
	>,
	attempt: ProviderCacheRefreshAttempt,
	publication: ProviderCacheRefreshPublication,
): Promise<"recorded" | "superseded"> {
	if (!supportsCacheType(instance.service, cacheType)) {
		throw new Error("Provider cache type does not match publication service");
	}
	if (!isValidDate(publication.observedAt)) {
		throw new Error("Provider cache publication timestamp is invalid");
	}
	if (!isSafePrismaInt(publication.itemCount)) {
		throw new Error("Provider cache publication item count is invalid");
	}
	if (!isBoundedNullableString(publication.generationId, 500)) {
		throw new Error("Provider cache publication generation id is invalid");
	}
	if (!isBoundedNullableString(publication.generationMetadata, 1_000_000)) {
		throw new Error("Provider cache publication generation metadata is invalid");
	}
	if (!isValidDate(attempt.attemptedAt) || !isValidAttemptMarker(attempt.resultMarker)) {
		throw new Error("Provider cache refresh attempt is invalid");
	}

	const updated = await tx.cacheRefreshStatus.updateMany({
		where: {
			instanceId: instance.id,
			cacheType,
			lastAttemptAt: attempt.attemptedAt,
			lastAttemptResult: attempt.resultMarker,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
		data: {
			lastRefreshedAt: publication.observedAt,
			lastResult: "success",
			lastErrorMessage: null,
			itemCount: publication.itemCount,
			generationId: publication.generationId,
			generationMetadata: publication.generationMetadata,
			lastAttemptAt: publication.observedAt,
			lastAttemptResult: "success",
			lastAttemptErrorMessage: null,
			connectionGeneration: instance.connectionGeneration,
			identityGeneration: instance.identityGeneration,
		},
	});
	return updated.count === 1 ? "recorded" : "superseded";
}

function isValidAttemptMarker(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	);
}

/** Record Plex failure diagnostics only for the exact full publication authority. */
export async function recordPlexCacheRefreshFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: PlexCacheRefreshType,
	message: string,
	instance: ProviderPublicationAuthority,
	log: Pick<FastifyBaseLogger, "warn">,
): Promise<"recorded" | "superseded" | "failed"> {
	return await recordWatchProviderCacheRefreshFailure(prisma, cacheType, message, instance, log);
}

/** Record failure diagnostics only for an exact, service-compatible publication authority. */
export async function recordWatchProviderCacheRefreshFailure(
	prisma: Pick<PrismaClient, "$transaction">,
	cacheType: WatchProviderCacheRefreshType,
	message: string,
	instance: ProviderPublicationAuthority,
	log: Pick<FastifyBaseLogger, "warn">,
	options: ProviderIdentityGuardOptions = {},
): Promise<"recorded" | "superseded" | "failed"> {
	try {
		if (!supportsCacheType(instance.service, cacheType)) {
			throw new Error("Provider cache type does not match publication service");
		}
		const attemptedAt = new Date();
		const result = await withCurrentProviderPublicationAuthority(
			prisma,
			instance,
			async (tx) => {
				const status = await tx.cacheRefreshStatus.findUnique({
					where: { instanceId_cacheType: { instanceId: instance.id, cacheType } },
					select: { connectionGeneration: true, identityGeneration: true },
				});
				if (status && !hasAuthoritativeProviderCacheGeneration(status, instance)) return false;

				const safeMessage = boundedProviderStatusMessage(cacheType, message);
				await tx.cacheRefreshStatus.upsert({
					where: { instanceId_cacheType: { instanceId: instance.id, cacheType } },
					create: {
						instanceId: instance.id,
						cacheType,
						lastRefreshedAt: attemptedAt,
						lastResult: "error",
						lastErrorMessage: safeMessage,
						itemCount: 0,
						lastAttemptAt: attemptedAt,
						lastAttemptResult: "error",
						lastAttemptErrorMessage: safeMessage,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					},
					update: {
						lastAttemptAt: attemptedAt,
						lastAttemptResult: "error",
						lastAttemptErrorMessage: safeMessage,
						connectionGeneration: instance.connectionGeneration,
						identityGeneration: instance.identityGeneration,
					},
				});
				return true;
			},
			options,
		);
		return result.matched && result.value ? "recorded" : "superseded";
	} catch {
		log.warn(
			{ cacheType, reasonCode: "failure_status_write_failed" },
			"Failed to record provider cache failure status",
		);
		return "failed";
	}
}

function supportsCacheType(service: string, cacheType: string): boolean {
	switch (service) {
		case "PLEX":
			return cacheType === "plex" || cacheType === "plex_episode";
		case "JELLYFIN":
		case "EMBY":
			return cacheType === "jellyfin" || cacheType === "jellyfin_episode";
		case "TAUTULLI":
			return cacheType === "tautulli";
		default:
			return false;
	}
}

function isValidDate(value: unknown): value is Date {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function isSafePrismaInt(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
}

function isBoundedNullableString(value: string | null, maxLength: number): boolean {
	return value === null || (typeof value === "string" && value.length <= maxLength);
}
