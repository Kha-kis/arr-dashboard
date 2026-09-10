import type { FastifyBaseLogger } from "fastify";
import { acquireIndependentCleanupOperationGuard } from "../library-cleanup/cleanup-maintenance-gate.js";
import type {
	ProviderCacheRefreshAttempt,
	ProviderCacheRefreshClaim,
	WatchProviderCacheRefreshType,
} from "../services/provider-cache-status.js";

export type ProviderRefreshSettlement =
	| "complete"
	| "partial"
	| "unpublished"
	| "superseded"
	| "failed";

export type ProviderCacheRefreshAdmission = {
	accepted: true;
	backgroundTask: Promise<void>;
};

export class ProviderCacheRefreshSupersededError extends Error {
	readonly statusCode = 409;
	readonly code = "PUBLICATION_SUPERSEDED" as const;

	constructor() {
		super("Provider cache refresh was superseded before it was accepted.");
		this.name = "ProviderCacheRefreshSupersededError";
	}
}

export class ProviderCacheRefreshClaimError extends Error {
	readonly statusCode = 503;
	readonly code = "REFRESH_UNAVAILABLE" as const;

	constructor() {
		super("Provider cache refresh could not be accepted.");
		this.name = "ProviderCacheRefreshClaimError";
	}
}

export type StartProviderCacheRefreshOptions<TResult> = {
	cacheType: WatchProviderCacheRefreshType;
	claim: () => Promise<ProviderCacheRefreshClaim>;
	produce: (attempt: ProviderCacheRefreshAttempt) => Promise<TResult>;
	log: Pick<FastifyBaseLogger, "info" | "warn">;
};

/**
 * Claim a durable provider refresh before admitting deferred work.
 *
 * The cleanup lease is acquired synchronously, before the first asynchronous
 * claim operation. It remains held by the background task until the producer
 * settles, so database maintenance cannot race a refresh that outlives its
 * request or scheduler callback.
 */
export async function startProviderCacheRefreshInBackground<TResult>(
	options: StartProviderCacheRefreshOptions<TResult>,
): Promise<ProviderCacheRefreshAdmission> {
	const release = acquireIndependentCleanupOperationGuard();
	let claim: ProviderCacheRefreshClaim;
	try {
		claim = await options.claim();
		if (!isProviderCacheRefreshClaim(claim)) throw new Error("invalid provider cache claim");
	} catch {
		release();
		emit(
			options.log,
			"warn",
			options.cacheType,
			"failed",
			"Provider cache refresh was not accepted",
		);
		throw new ProviderCacheRefreshClaimError();
	}

	if (claim.status === "superseded") {
		release();
		emit(
			options.log,
			"warn",
			options.cacheType,
			"superseded",
			"Provider cache refresh was not accepted",
		);
		throw new ProviderCacheRefreshSupersededError();
	}

	if (claim.status === "already-running") {
		release();
		return { accepted: true, backgroundTask: Promise.resolve() };
	}

	const backgroundTask = Promise.resolve()
		.then(() => options.produce(claim.attempt))
		.then((result) => {
			emit(
				options.log,
				"info",
				options.cacheType,
				classifyProviderRefreshSettlement(result),
				"Provider cache refresh settled",
			);
		})
		.catch(() => {
			emit(options.log, "warn", options.cacheType, "failed", "Provider cache refresh settled");
		})
		.finally(release);

	return { accepted: true, backgroundTask };
}

/** Classify only evidence carried by the producer result; never infer success. */
export function classifyProviderRefreshSettlement(value: unknown): ProviderRefreshSettlement {
	if (!isRecord(value)) return "unpublished";
	if (value.superseded === true) return "superseded";
	const completedAt = value.completedAt;
	const hasCompletionTimestamp =
		completedAt instanceof Date && Number.isFinite(completedAt.getTime());
	if (value.complete === true && hasCompletionTimestamp) return "complete";
	if (value.complete === false && hasCompletionTimestamp) return "partial";
	return "unpublished";
}

function emit(
	log: Pick<FastifyBaseLogger, "info" | "warn">,
	level: "info" | "warn",
	cacheType: WatchProviderCacheRefreshType,
	settlement: ProviderRefreshSettlement,
	message: string,
): void {
	try {
		log[level]({ cacheType, settlement }, message);
	} catch {
		// Logging must never turn a handled background task into an unhandled one.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isProviderCacheRefreshClaim(value: unknown): value is ProviderCacheRefreshClaim {
	if (!isRecord(value) || typeof value.status !== "string") return false;
	if (value.status === "superseded") return true;
	if (value.status !== "acquired" && value.status !== "already-running") return false;
	if (!isRecord(value.attempt)) return false;
	return (
		value.attempt.attemptedAt instanceof Date &&
		Number.isFinite(value.attempt.attemptedAt.getTime()) &&
		isProviderCacheRefreshAttemptMarker(value.attempt.resultMarker)
	);
}

function isProviderCacheRefreshAttemptMarker(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^in_progress:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
	);
}
