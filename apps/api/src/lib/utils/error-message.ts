/** Extract a human-readable message from an unknown error. */
export function getErrorMessage(error: unknown, fallback = "An unexpected error occurred"): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return fallback;
}
