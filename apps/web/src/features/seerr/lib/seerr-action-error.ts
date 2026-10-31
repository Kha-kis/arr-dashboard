import { toast } from "sonner";
import { ApiError, InvalidSuccessResponseError, NetworkError } from "../../../lib/api-client/base";

export function isSeerrActionOutcomeUnknown(error: unknown): boolean {
	if (error instanceof NetworkError || error instanceof InvalidSuccessResponseError) return true;
	if (!(error instanceof ApiError)) return false;
	const payload = error.payload;
	if (payload && typeof payload === "object") {
		if ("error" in payload && payload.error === "SeerrMutationOutcomeUnknownError") return true;
		if ("error" in payload && payload.error === "CircuitBreakerOpenError") return false;
		if (
			error.status === 502 &&
			"results" in payload &&
			Array.isArray(payload.results) &&
			payload.results.length > 0 &&
			"totalSuccess" in payload &&
			payload.totalSuccess === 0 &&
			"totalUnknown" in payload &&
			payload.totalUnknown === 0 &&
			"totalFailed" in payload &&
			payload.totalFailed === payload.results.length &&
			payload.results.every(
				(item) =>
					item &&
					typeof item === "object" &&
					"success" in item &&
					item.success === false &&
					"requestId" in item &&
					typeof item.requestId === "number" &&
					Number.isSafeInteger(item.requestId) &&
					item.requestId > 0 &&
					(!("outcome" in item) || item.outcome !== "unknown"),
			)
		) {
			return false;
		}
	}
	return error.status >= 500 || error.status === 408 || error.status === 429;
}

export function notifySeerrActionError(error: unknown, definiteFailureMessage: string): void {
	if (isSeerrActionOutcomeUnknown(error)) {
		toast.warning("Outcome unknown. Check Seerr before retrying.");
		return;
	}
	toast.error(definiteFailureMessage);
}
