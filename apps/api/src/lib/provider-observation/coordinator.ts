import type { ProviderObservationReasonCode } from "@arr/shared";
import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "../prisma.js";
import {
	beginProviderCacheRefreshAttempt,
	finishProviderCacheRefreshAttemptFailure,
	finishProviderCacheRefreshAttemptSuccess,
	type ProviderCacheRefreshAttempt,
	type ProviderCacheRefreshPublication,
	type WatchProviderCacheRefreshType,
} from "../services/provider-cache-status.js";
import {
	type OwnedProviderPublicationSnapshot,
	type ProviderIdentityGuardOptions,
	type ProviderPublicationAuthority,
	withGuardedProviderPublication,
} from "../services/provider-identity-guard.js";
import {
	evaluateProviderCoverageReceipt,
	type ProviderCoverageEvaluation,
	type ProviderCoverageReceiptV1,
} from "./coverage-receipt.js";

const REASON_CODES = new Set<ProviderObservationReasonCode>([
	"no-publication",
	"identity-unverified",
	"identity-changed",
	"refresh-running",
	"refresh-failed",
	"publication-superseded",
	"receipt-invalid",
	"coverage-incomplete",
	"accepted-skips",
	"provider-limit",
	"provider-unavailable",
	"publication-stale",
	"rows-inconsistent",
	"positive-only",
	"unknown-failure",
]);

export type ProviderObservationPublication = ProviderCacheRefreshPublication & {
	receipt: ProviderCoverageReceiptV1;
};

export type ProviderObservationAttemptPublication<TResult> = {
	result: TResult;
	publication: ProviderObservationPublication;
};

export interface ProviderObservationAttemptInput<
	TPrepared extends OwnedProviderPublicationSnapshot,
	TCollected,
	TResult,
> {
	prisma: PrismaClient;
	authority: ProviderPublicationAuthority;
	cacheType: WatchProviderCacheRefreshType;
	log: FastifyBaseLogger;
	prepare: () => TPrepared | PromiseLike<TPrepared>;
	collect: (prepared: TPrepared, attempt: ProviderCacheRefreshAttempt) => Promise<TCollected>;
	publish: (
		tx: Parameters<typeof finishProviderCacheRefreshAttemptSuccess>[0],
		collected: TCollected,
		attempt: ProviderCacheRefreshAttempt,
	) => Promise<ProviderObservationAttemptPublication<TResult>>;
	failureReason: (error: unknown) => ProviderObservationReasonCode;
	options?: ProviderIdentityGuardOptions;
}

export class ProviderObservationCoordinatorError extends Error {
	constructor(public readonly code: ProviderObservationReasonCode) {
		super("Provider observation attempt did not publish.");
		this.name = "ProviderObservationCoordinatorError";
	}
}

export async function runProviderObservationAttempt<
	TPrepared extends OwnedProviderPublicationSnapshot,
	TCollected,
	TResult,
>(input: ProviderObservationAttemptInput<TPrepared, TCollected, TResult>): Promise<TResult> {
	let attempt: ProviderCacheRefreshAttempt | null;
	try {
		attempt = await beginProviderCacheRefreshAttempt(
			input.prisma,
			input.cacheType,
			input.authority,
			input.options,
		);
	} catch {
		input.log.warn(
			{ cacheType: input.cacheType, reasonCode: "unknown-failure" },
			"Provider observation attempt could not start",
		);
		throw new ProviderObservationCoordinatorError("unknown-failure");
	}
	if (!attempt) {
		throw new ProviderObservationCoordinatorError("publication-superseded");
	}
	return await runClaimedProviderObservationAttempt(input, attempt);
}

/** Execute a previously persisted claim without beginning or replacing it. */
export async function runClaimedProviderObservationAttempt<
	TPrepared extends OwnedProviderPublicationSnapshot,
	TCollected,
	TResult,
>(
	input: ProviderObservationAttemptInput<TPrepared, TCollected, TResult>,
	attempt: ProviderCacheRefreshAttempt,
): Promise<TResult> {
	try {
		const prepared = await input.prepare();
		if (!matchesClaimedAuthority(prepared, input.authority)) {
			throw new ProviderObservationCoordinatorError("publication-superseded");
		}
		return await withGuardedProviderPublication(
			input.prisma,
			prepared,
			input.log,
			async () => await input.collect(prepared, attempt),
			async (tx, collected) => {
				const published = await input.publish(tx, collected, attempt);
				if (!isPublicationResult(published)) {
					throw new ProviderObservationCoordinatorError("receipt-invalid");
				}
				const validationNow = captureValidationClock(input.options);
				const evaluation = validatePublication(
					input.cacheType,
					input.authority.service,
					attempt,
					published,
					validationNow,
				);
				if (!evaluation.valid) {
					throw new ProviderObservationCoordinatorError("receipt-invalid");
				}
				const finished = await finishProviderCacheRefreshAttemptSuccess(
					tx,
					input.cacheType,
					input.authority,
					attempt,
					published.publication,
				);
				if (finished === "superseded") {
					throw new ProviderObservationCoordinatorError("publication-superseded");
				}
				return published.result;
			},
			input.options,
		);
	} catch (error) {
		const reason = boundedFailureReason(input.failureReason, error);
		try {
			await finishProviderCacheRefreshAttemptFailure(
				input.prisma,
				input.cacheType,
				reason,
				input.authority,
				attempt,
				input.log,
				input.options,
			);
		} catch {
			// Failure recording is best effort; never expose its database error.
		}
		input.log.warn(
			{ cacheType: input.cacheType, reasonCode: reason },
			"Provider observation attempt failed",
		);
		throw new ProviderObservationCoordinatorError(
			error instanceof ProviderObservationCoordinatorError ? error.code : reason,
		);
	}
}

const PLAINTEXT_FREE_AUTHORITY_FIELDS = [
	"id",
	"userId",
	"service",
	"baseUrl",
	"enabled",
	"encryptedApiKey",
	"encryptionIv",
	"encryptedHttpAuthCredentials",
	"httpAuthEncryptionIv",
	"expectedIdentity",
	"identityStatus",
	"connectionGeneration",
	"identityGeneration",
] as const satisfies readonly (keyof ProviderPublicationAuthority)[];

function matchesClaimedAuthority(
	prepared: OwnedProviderPublicationSnapshot,
	authority: ProviderPublicationAuthority,
): boolean {
	return PLAINTEXT_FREE_AUTHORITY_FIELDS.every((field) => prepared[field] === authority[field]);
}

function validatePublication(
	cacheType: WatchProviderCacheRefreshType,
	service: ProviderPublicationAuthority["service"],
	attempt: ProviderCacheRefreshAttempt,
	published: ProviderObservationAttemptPublication<unknown>,
	validationNow: Date | null,
): ProviderCoverageEvaluation {
	const publication = published.publication;
	const evaluation = evaluateProviderCoverageReceipt(publication.receipt);
	if (!evaluation.valid) return evaluation;
	if (!validationNow || !isValidDate(validationNow)) return { ...evaluation, valid: false };
	if (!isValidDate(attempt.attemptedAt)) return { ...evaluation, valid: false };
	if (Date.parse(publication.receipt.attemptStartedAt) !== attempt.attemptedAt.getTime()) {
		return { ...evaluation, valid: false };
	}
	if (!isValidDate(publication.observedAt)) return { ...evaluation, valid: false };
	if (Date.parse(publication.receipt.observedAt) !== publication.observedAt.getTime()) {
		return { ...evaluation, valid: false };
	}
	if (
		Date.parse(publication.receipt.observedAt) > validationNow.getTime() ||
		publication.observedAt.getTime() > validationNow.getTime()
	) {
		return { ...evaluation, valid: false };
	}
	if (!isSafeNonnegativeInteger(publication.itemCount)) return { ...evaluation, valid: false };
	const expectedItemCount = evaluation.publishedCanonicalEntities ?? evaluation.canonicalEntities;
	if (publication.itemCount !== expectedItemCount) return { ...evaluation, valid: false };
	if (!isBoundedNullableString(publication.generationId, 500))
		return { ...evaluation, valid: false };
	if (!isBoundedNullableString(publication.generationMetadata, 1_000_000)) {
		return { ...evaluation, valid: false };
	}
	if (!isExpectedProvider(cacheType, service, evaluation.provider))
		return { ...evaluation, valid: false };
	return evaluation;
}

function captureValidationClock(options: ProviderIdentityGuardOptions | undefined): Date | null {
	try {
		const now = (options?.now ?? (() => new Date()))();
		return isValidDate(now) ? now : null;
	} catch {
		return null;
	}
}

function isPublicationResult(
	value: unknown,
): value is ProviderObservationAttemptPublication<unknown> {
	return isRecord(value) && isRecord(value.publication);
}

function isExpectedProvider(
	cacheType: WatchProviderCacheRefreshType,
	service: ProviderPublicationAuthority["service"],
	provider: string | undefined,
): boolean {
	if (cacheType === "plex" || cacheType === "plex_episode") return provider === cacheType;
	if (cacheType === "tautulli") return provider === "tautulli";
	if (service === "EMBY") return provider === cacheType.replace("jellyfin", "emby");
	return provider === cacheType;
}

function boundedFailureReason(
	failureReason: (error: unknown) => ProviderObservationReasonCode,
	error: unknown,
): ProviderObservationReasonCode {
	let reason: ProviderObservationReasonCode = "unknown-failure";
	try {
		const candidate = failureReason(error);
		if (REASON_CODES.has(candidate)) reason = candidate;
	} catch {
		// Keep the bounded fallback.
	}
	return error instanceof ProviderObservationCoordinatorError ? error.code : reason;
}

function isValidDate(value: Date): boolean {
	return value instanceof Date && Number.isFinite(value.getTime());
}

function isSafeNonnegativeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

function isBoundedNullableString(value: unknown, maxLength: number): value is string | null {
	return value === null || (typeof value === "string" && value.length <= maxLength);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
