import { z } from "zod";

export const analyticsProviderSchema = z.enum(["tracearr", "tautulli"]);
export type AnalyticsProvider = z.infer<typeof analyticsProviderSchema>;

export const analyticsProviderSourceSchema = z.enum(["explicit", "migration-default"]);
export type AnalyticsProviderSource = z.infer<typeof analyticsProviderSourceSchema>;

export const analyticsProviderStatusSchema = z.enum(["configured", "disabled", "unconfigured"]);
export type AnalyticsProviderStatus = z.infer<typeof analyticsProviderStatusSchema>;

export const analyticsProviderFamilyStateSchema = z
	.object({
		configuredCount: z.number().int().nonnegative(),
		enabledCount: z.number().int().nonnegative(),
	})
	.strict();
export type AnalyticsProviderFamilyState = z.infer<typeof analyticsProviderFamilyStateSchema>;

export const analyticsProviderSelectionSchema = z
	.object({
		selected: analyticsProviderSchema,
		source: analyticsProviderSourceSchema,
		families: z
			.object({
				tracearr: analyticsProviderFamilyStateSchema,
				tautulli: analyticsProviderFamilyStateSchema,
			})
			.strict(),
		status: analyticsProviderStatusSchema,
	})
	.strict();
export type AnalyticsProviderSelection = z.infer<typeof analyticsProviderSelectionSchema>;
