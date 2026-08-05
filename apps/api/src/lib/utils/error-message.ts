/** Extract a human-readable message from an unknown error. */
export function getErrorMessage(error: unknown, fallback = "An unexpected error occurred"): string {
	if (error instanceof Error) {
		if (error.message === "fetch failed") {
			const code = findCauseCode(error);
			if (code === "ECONNREFUSED")
				return "Connection refused by the configured host (ECONNREFUSED)";
			if (code === "ENOTFOUND") return "The configured host could not be resolved (ENOTFOUND)";
			if (code === "ETIMEDOUT" || code === "UND_ERR_CONNECT_TIMEOUT") {
				return "The connection to the configured host timed out";
			}
			if (
				code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
				code === "CERT_HAS_EXPIRED" ||
				code === "DEPTH_ZERO_SELF_SIGNED_CERT"
			) {
				return `TLS certificate validation failed (${code})`;
			}
		}
		return error.message;
	}
	if (typeof error === "string") return error;
	if (error !== null && error !== undefined) return String(error);
	return fallback;
}

function findCauseCode(error: Error): string | undefined {
	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
		if (seen.has(current)) return undefined;
		seen.add(current);
		const candidate = current as { code?: unknown; cause?: unknown };
		if (typeof candidate.code === "string") return candidate.code;
		current = candidate.cause;
	}
	return undefined;
}
