import { notificationFailureCategorySchema, notificationFailureMessage } from "@arr/shared";
import type { NotificationFailureCategory, SendResult } from "./types.js";

export { notificationFailureMessage } from "@arr/shared";

const SAFE_MESSAGES = new Set(
	notificationFailureCategorySchema.options.map(notificationFailureMessage),
);

/** Legacy/custom sender text must not enter persistence or public diagnostics. */
export function safeNotificationFailureMessage(value: unknown): string {
	return typeof value === "string" && SAFE_MESSAGES.has(value)
		? value
		: notificationFailureMessage("unknown");
}

export function notificationFailure(
	category: NotificationFailureCategory,
	retryable: boolean,
	retryAfterMs?: number,
): SendResult {
	// Node timers overflow above 2^31-1 and run invalid delays nearly immediately.
	const validDelay =
		typeof retryAfterMs === "number" &&
		Number.isFinite(retryAfterMs) &&
		retryAfterMs >= 0 &&
		retryAfterMs <= 2_147_483_647;
	return {
		success: false,
		retryable,
		failureCategory: category,
		error: notificationFailureMessage(category),
		...(validDelay ? { retryAfterMs } : {}),
	};
}

export function httpFailureCategory(status: number): NotificationFailureCategory {
	if (status === 401 || status === 403) return "authentication";
	if (status === 429) return "rate-limited";
	if (status >= 500 && status <= 599) return "provider-unavailable";
	return "rejected";
}

export function networkFailureCategory(error: unknown): NotificationFailureCategory {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")
		? "timeout"
		: "transport";
}

/** No raw message, cause, response body or destination accompanies this error. */
export class NotificationFailureError extends Error {
	constructor(readonly category: NotificationFailureCategory) {
		super(notificationFailureMessage(category));
		this.name = "NotificationFailureError";
	}
}
