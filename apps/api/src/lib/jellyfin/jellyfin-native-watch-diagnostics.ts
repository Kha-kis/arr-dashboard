import { z } from "zod";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nativeWatchScopeDiagnosticsSchema = z.strictObject({
	version: z.literal(1),
	invalidCollectRows: count,
	invalidVerifyRows: count,
	conflictedCoordinates: count,
	duplicateCollectCoordinates: count,
	missingVerifyCoordinates: count,
	duplicateVerifyCoordinates: count,
	changedObservationCoordinates: count,
	verifyOnlyCoordinates: count,
	collectUnits: count,
	verifyUnits: count,
	collectStageRows: count,
	verifyStageRows: count,
	expectedCountsMatch: z.boolean(),
	excludedRows: count,
});
export type NativeWatchScopeDiagnostics = z.infer<typeof nativeWatchScopeDiagnosticsSchema>;

/** Diagnostic validity never participates in value or publication authority. */
export function parseNativeWatchScopeDiagnostics(
	json: string | null | undefined,
): NativeWatchScopeDiagnostics | null {
	if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > 2048) return null;
	try {
		const parsed = nativeWatchScopeDiagnosticsSchema.safeParse(JSON.parse(json));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

export function serializeNativeWatchScopeDiagnostics(
	value: NativeWatchScopeDiagnostics,
): string | null {
	const parsed = nativeWatchScopeDiagnosticsSchema.safeParse(value);
	return parsed.success ? JSON.stringify(parsed.data) : null;
}
