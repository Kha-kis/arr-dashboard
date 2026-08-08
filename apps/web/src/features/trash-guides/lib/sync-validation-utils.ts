/**
 * Sync Validation Utilities
 *
 * Types, error detection patterns, and helpers for the sync validation modal.
 */

import { ApiError } from "../../../lib/api-client/base";

export interface ValidationTiming {
	startTime: number;
	endTime: number | null;
	duration: number | null;
}

export interface RetryProgress {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	isWaiting: boolean;
}

export const ERROR_PATTERNS = {
	MISSING_MAPPING: /no quality profile mappings found|deploy this template/i,
	UNREACHABLE_INSTANCE: /unable to connect|unreachable|connection refused|timeout/i,
	USER_MODIFICATIONS: /auto-sync is blocked|local modifications|user modifications/i,
	DELETED_PROFILES: /quality profiles no longer exist|mapped.*deleted/i,
	CORRUPTED_TEMPLATE: /corrupted|cannot be parsed|missing custom formats/i,
	CACHE_ISSUE: /cache is empty|cache.*corrupted|cache needs refreshing/i,
} as const;

export type ErrorType = keyof typeof ERROR_PATTERNS;

export interface PartialDeploymentConflict {
	created: number;
	updated: number;
	skipped: number;
	details: {
		created: string[];
		updated: string[];
		failed: string[];
	};
	qualityProfile?: {
		action: "created" | "updated";
		profileId: number;
		profileName: string;
	};
}

/** Detect error types from error messages */
export function detectErrorTypes(errors: string[]): Set<ErrorType> {
	const detected = new Set<ErrorType>();
	for (const error of errors) {
		for (const [type, pattern] of Object.entries(ERROR_PATTERNS)) {
			if (pattern.test(error)) {
				detected.add(type as ErrorType);
			}
		}
	}
	return detected;
}

/** A 409 means the reviewed upstream state changed and its token must be replaced. */
export function isSyncExecutionConflict(error: unknown): boolean {
	return error instanceof ApiError && error.status === 409;
}

/** Extract the sanitized partial mutation result attached to a deployment conflict. */
export function getPartialDeploymentConflict(
	error: unknown,
): PartialDeploymentConflict | undefined {
	if (!(error instanceof ApiError) || error.status !== 409) return undefined;
	if (!error.payload || typeof error.payload !== "object") return undefined;

	const payload = error.payload as Record<string, unknown>;
	if (!payload.details || typeof payload.details !== "object") return undefined;
	const details = payload.details as Record<string, unknown>;
	if (!details.partialDeployment || typeof details.partialDeployment !== "object") {
		return undefined;
	}
	const partial = details.partialDeployment as Record<string, unknown>;
	if (
		typeof partial.created !== "number" ||
		typeof partial.updated !== "number" ||
		typeof partial.skipped !== "number" ||
		!partial.details ||
		typeof partial.details !== "object"
	) {
		return undefined;
	}
	const mutationDetails = partial.details as Record<string, unknown>;
	const stringList = (value: unknown): string[] =>
		Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

	const qualityProfile = partial.qualityProfile;
	const parsedQualityProfile =
		qualityProfile && typeof qualityProfile === "object"
			? (qualityProfile as Record<string, unknown>)
			: undefined;
	return {
		created: partial.created,
		updated: partial.updated,
		skipped: partial.skipped,
		details: {
			created: stringList(mutationDetails.created),
			updated: stringList(mutationDetails.updated),
			failed: stringList(mutationDetails.failed),
		},
		...(parsedQualityProfile &&
			(parsedQualityProfile.action === "created" || parsedQualityProfile.action === "updated") &&
			typeof parsedQualityProfile.profileId === "number" &&
			typeof parsedQualityProfile.profileName === "string" && {
				qualityProfile: {
					action: parsedQualityProfile.action,
					profileId: parsedQualityProfile.profileId,
					profileName: parsedQualityProfile.profileName,
				},
			}),
	};
}
