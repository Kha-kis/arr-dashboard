/** Extract a human-readable message from an unknown error. */
export function getErrorMessage(error: unknown, fallback = "An unexpected error occurred"): string {
	if (error instanceof Error) {
		if (error.message === "fetch failed") {
			const cause = error.cause as { code?: unknown } | undefined;
			if (cause?.code === "ECONNREFUSED")
				return "Connection refused by the configured host (ECONNREFUSED)";
			if (cause?.code === "ENOTFOUND")
				return "The configured host could not be resolved (ENOTFOUND)";
			if (cause?.code === "ETIMEDOUT" || cause?.code === "UND_ERR_CONNECT_TIMEOUT")
				return "The connection to the configured host timed out";
			if (
				cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
				cause?.code === "SELF_SIGNED_CERT_IN_CHAIN" ||
				cause?.code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
			)
				return "The configured host's TLS certificate could not be verified";
			if (cause?.code === "CERT_HAS_EXPIRED")
				return "The configured host's TLS certificate has expired";
		}
		return error.message;
	}
	if (typeof error === "string") return error;
	if (error !== null && error !== undefined) return String(error);
	return fallback;
}
