import { describe, expect, it } from "vitest";
import {
	NotificationFailureError,
	notificationFailure,
	notificationFailureMessage,
	safeNotificationFailureMessage,
} from "../failure-diagnostics.js";

describe("notification diagnostic trust boundary", () => {
	it.each([
		undefined,
		null,
		"__proto__",
		"constructor",
		"authentication/private-secret",
		{ category: "authentication" },
	])("unknown category %j cannot become a provider message or object", (category) => {
		expect(notificationFailureMessage(category)).toBe(
			"Delivery was not confirmed. Check channel settings and provider availability.",
		);
	});

	it.each([
		"private-secret",
		"Provider authentication failed. Check channel credentials and permissions. private-secret",
		null,
		{ message: "private-secret" },
	])("untrusted stored message %j cannot bypass the safe message allowlist", (value) => {
		expect(safeNotificationFailureMessage(value)).not.toContain("private-secret");
		expect(safeNotificationFailureMessage(value)).toMatch(/not confirmed.*check/i);
	});

	it("typed configuration failures carry a safe action but no cause", () => {
		const error = new NotificationFailureError("configuration");
		expect(error.message).toMatch(/configuration.*re-save.*settings/i);
		expect(error.cause).toBeUndefined();
		expect(error.category).toBe("configuration");
	});

	it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 2_147_483_648])(
		"rejects unsafe provider delay %s without changing retry eligibility",
		(delay) => {
			const result = notificationFailure("rate-limited", true, delay);
			expect(result.retryable).toBe(true);
			expect(result.failureCategory).toBe("rate-limited");
			expect(result.retryAfterMs).toBeUndefined();
		},
	);

	it.each([0, 2500, 2_147_483_647])("preserves valid provider retry delay %s", (delay) => {
		expect(notificationFailure("rate-limited", true, delay).retryAfterMs).toBe(delay);
	});
});
