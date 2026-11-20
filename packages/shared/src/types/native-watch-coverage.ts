import { z } from "zod";

export const nativeWatchCoverageReasonSchema = z.enum([
	"unit-evidence-incomplete",
	"provider-count-changed",
	"staging-coverage-incomplete",
	"excluded-observations",
	"invalid-observations",
	"ambiguous-identity",
	"duplicate-observations",
	"missing-verification",
	"changed-observations",
	"verification-only-observations",
	"diagnostics-unavailable",
	"coverage-incomplete",
]);
export const providerNativeWatchCoverageSchema = z.discriminatedUnion("status", [
	z.strictObject({
		status: z.literal("available"),
		observedAt: z.string().datetime(),
		expectedScopes: z.number().int().nonnegative().max(256),
		verifiedScopes: z.number().int().nonnegative().max(256),
		incompleteScopes: z.number().int().nonnegative().max(256),
		diagnosticStatus: z.enum(["recorded", "unavailable"]),
		reasonCodes: z.array(nativeWatchCoverageReasonSchema),
		refreshPhase: z.enum(["idle", "collecting", "verifying", "finalizing", "failed", "unknown"]),
	}),
	z.strictObject({
		status: z.literal("unavailable"),
		reason: z.enum([
			"not-owned",
			"identity-changed",
			"no-publication",
			"snapshot-changed",
			"malformed-publication",
		]),
	}),
]);
export type ProviderNativeWatchCoverage = z.infer<typeof providerNativeWatchCoverageSchema>;
