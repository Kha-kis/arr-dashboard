import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	ApiError,
	InvalidSuccessResponseError,
	NetworkError,
} from "../../../../lib/api-client/base";

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import { isSeerrActionOutcomeUnknown, notifySeerrActionError } from "../seerr-action-error";

beforeEach(() => vi.clearAllMocks());

describe("Seerr action feedback", () => {
	it("classifies unreadable or invalid acknowledged data as unknown with generic feedback", () => {
		const error = new InvalidSuccessResponseError();
		expect(isSeerrActionOutcomeUnknown(error)).toBe(true);
		notifySeerrActionError(error, "Failed to approve requests");
		expect(toast.warning).toHaveBeenCalledWith("Outcome unknown. Check Seerr before retrying.");
		expect(toast.error).not.toHaveBeenCalled();
	});
	it("warns to check the provider before retrying an unknown outcome", () => {
		notifySeerrActionError(
			new ApiError("Action outcome is unknown", 502, {
				error: "SeerrMutationOutcomeUnknownError",
			}),
			"Failed to approve request",
		);
		expect(toast.warning).toHaveBeenCalledWith("Outcome unknown. Check Seerr before retrying.");
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("preserves definite failure feedback", () => {
		notifySeerrActionError(new ApiError("Rejected", 400, {}), "Failed to approve request");
		expect(toast.error).toHaveBeenCalledWith("Failed to approve request");
		expect(toast.warning).not.toHaveBeenCalled();
	});

	it("warns when the browser loses the response to an action", () => {
		notifySeerrActionError(new NetworkError(), "Failed to approve request");
		expect(toast.warning).toHaveBeenCalledWith("Outcome unknown. Check Seerr before retrying.");
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("warns when a proxy returns a 5xx without an application marker", () => {
		notifySeerrActionError(new ApiError("Gateway failure", 502), "Failed to approve request");
		expect(toast.warning).toHaveBeenCalledWith("Outcome unknown. Check Seerr before retrying.");
		expect(toast.error).not.toHaveBeenCalled();
	});

	it("keeps an open circuit breaker as a definite pre-dispatch failure", () => {
		notifySeerrActionError(
			new ApiError("Unavailable", 503, { error: "CircuitBreakerOpenError" }),
			"Failed to approve request",
		);
		expect(toast.error).toHaveBeenCalledWith("Failed to approve request");
		expect(toast.warning).not.toHaveBeenCalled();
	});

	it("keeps an all-definite bulk rejection as a definite failure", () => {
		notifySeerrActionError(
			new ApiError("Bulk failed", 502, {
				results: [{ requestId: 1, success: false }],
				totalSuccess: 0,
				totalFailed: 1,
				totalUnknown: 0,
			}),
			"Failed to approve requests",
		);
		expect(toast.error).toHaveBeenCalledWith("Failed to approve requests");
		expect(toast.warning).not.toHaveBeenCalled();
	});
});
