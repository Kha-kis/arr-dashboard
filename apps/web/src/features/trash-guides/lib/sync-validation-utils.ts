/**
 * Sync Validation Utilities
 *
 * Types, error detection patterns, and helpers for the sync validation modal.
 */

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
