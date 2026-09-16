import { z } from "zod";

export const providerInventoryConnectionSchema = z.object({
	status: z.enum(["matched", "unmatched", "ambiguous", "unknown"]),
	reason: z.enum([
		"matched-identifiers",
		"no-arr-match",
		"missing-identifiers",
		"conflicting-identifiers",
		"multiple-arr-items",
		"arr-catalog-unavailable",
		"parent-unavailable",
	]),
	arrItems: z.array(
		z.object({
			instanceId: z.string(),
			arrItemId: z.number().int().positive(),
			itemType: z.enum(["movie", "series"]),
			title: z.string(),
		}),
	),
});
export type ProviderInventoryConnection = z.infer<typeof providerInventoryConnectionSchema>;

const nativeKeySchema = z
	.string()
	.min(1)
	.max(2048)
	.refine((value) => value.trim().length > 0 && !value.includes("\0"));

export const providerNativeInventoryRequestSchema = z
	.object({
		instanceId: nativeKeySchema,
		domain: z.enum(["library", "episode"]),
		afterNativeId: nativeKeySchema.optional(),
		expectedGenerationId: z.string().min(1).max(500).optional(),
		limit: z.coerce.number().int().min(1).max(200).default(100),
	})
	.refine(
		(value) => value.afterNativeId === undefined || value.expectedGenerationId !== undefined,
		{
			message: "Continuing inventory pages requires the original snapshot generation",
			path: ["expectedGenerationId"],
		},
	);

export const providerNativeInventoryResponseSchema = z.discriminatedUnion("status", [
	z.object({
		status: z.literal("available"),
		generationId: z.string(),
		observedAt: z.string(),
		itemCount: z.number().int().nonnegative(),
		scopeCount: z.number().int().nonnegative(),
		lastAttemptAt: z.string().nullable(),
		lastAttemptResult: z.enum(["unknown", "in_progress", "success", "failed"]),
		lastAttemptReason: z
			.enum(["provider-unavailable", "coverage-incomplete", "identity-changed"])
			.nullable(),
		freshness: z.enum(["current", "last-known"]),
		complete: z.boolean(),
		rows: z.array(
			z.object({
				nativeId: z.string(),
				mediaType: z.enum(["movie", "series", "episode"]),
				libraryIds: z.array(z.string()),
				parentNativeId: z.string().nullable(),
				seasonNumber: z.number().int().nonnegative().nullable(),
				episodeNumber: z.number().int().nonnegative().nullable(),
				title: z.string(),
				externalIds: z
					.object({
						tmdb: z.array(z.number().int().positive()).optional(),
						tvdb: z.array(z.number().int().positive()).optional(),
					})
					.optional(),
				connection: providerInventoryConnectionSchema.optional(),
			}),
		),
		nextNativeId: z.string().nullable(),
	}),
	z.object({
		status: z.literal("unavailable"),
		reason: z.enum([
			"not-owned",
			"provider-unavailable",
			"identity-changed",
			"no-publication",
			"snapshot-changed",
			"malformed-publication",
		]),
	}),
]);

export type ProviderNativeInventoryRequest = z.input<typeof providerNativeInventoryRequestSchema>;
export type ProviderNativeInventoryResponse = z.infer<typeof providerNativeInventoryResponseSchema>;
