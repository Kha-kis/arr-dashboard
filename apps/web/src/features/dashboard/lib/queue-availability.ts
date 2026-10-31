import type { MultiInstanceQueueResponse } from "@arr/shared";

type QueueReadAvailability =
	| "loading"
	| "available"
	| "partial"
	| "unknown"
	| "unavailable"
	| "last-known";

/** Read evidence only, never completeness or authority to act on queue items. */
export function resolveQueueAvailability(
	data: MultiInstanceQueueResponse | undefined,
	error: unknown,
): QueueReadAvailability {
	if (error) return data === undefined ? "unavailable" : "last-known";
	if (data === undefined) return "loading";
	if (!Array.isArray(data.instances)) return "unknown";
	const evidence = data.instances.map((instance) => instance?.success);
	if (evidence.some((success) => success !== true && success !== false)) return "unknown";
	if (evidence.every((success) => success === true)) return "available";
	return evidence.some((success) => success === true) ? "partial" : "unavailable";
}
