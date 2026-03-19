/**
 * Seerr Retry Wrapper
 *
 * Lightweight retry with exponential backoff for Seerr API calls.
 * Only retries retryable errors (429, 5xx, network/timeout).
 * Respects Retry-After headers on 429 responses (capped at 30s).
 */

import { SeerrApiError } from "../errors.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 10_000;
const RETRY_AFTER_CAP_MS = 30_000;

export interface SeerrRetryOptions {
	maxAttempts?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

function isRetryableError(error: unknown): error is SeerrApiError & { retryable: true } {
	return error instanceof SeerrApiError && error.retryable;
}

function isNetworkError(error: unknown): boolean {
	if (error instanceof SeerrApiError) return false; // Already classified
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	return (
		msg.includes("fetch failed") ||
		msg.includes("econnrefused") ||
		msg.includes("econnreset") ||
		msg.includes("etimedout") ||
		msg.includes("enetunreach") ||
		msg.includes("abort")
	);
}

export async function withSeerrRetry<T>(
	fn: () => Promise<T>,
	opts?: SeerrRetryOptions,
): Promise<T> {
	const maxAttempts = Math.max(1, opts?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const baseDelay = opts?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const maxDelay = opts?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

	let lastError: unknown;

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			return await fn();
		} catch (error) {
			lastError = error;

			// Don't retry on the last attempt
			if (attempt === maxAttempts) break;

			// Only retry retryable SeerrApiErrors or raw network errors
			if (isRetryableError(error)) {
				// Respect Retry-After on 429
				if (error.retryAfterMs) {
					const waitMs = Math.min(error.retryAfterMs, RETRY_AFTER_CAP_MS);
					await delay(waitMs);
				} else {
					// Exponential backoff: baseDelay * 2^(attempt-1)
					const waitMs = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
					await delay(waitMs);
				}
				continue;
			}

			if (isNetworkError(error)) {
				const waitMs = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
				await delay(waitMs);
				continue;
			}

			// Non-retryable (4xx) — throw immediately
			throw error;
		}
	}

	throw lastError;
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
