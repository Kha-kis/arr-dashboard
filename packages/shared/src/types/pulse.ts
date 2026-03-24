import { z } from "zod";

// ---------------------------------------------------------------------------
// Pulse Item — a single attention signal from any connected service
// ---------------------------------------------------------------------------

export const pulseSeveritySchema = z.enum(["critical", "warning", "info"]);
export type PulseSeverity = z.infer<typeof pulseSeveritySchema>;

export const pulseCategorySchema = z.enum([
	"health",
	"storage",
	"quality",
	"requests",
	"operations",
]);
export type PulseCategory = z.infer<typeof pulseCategorySchema>;

export const pulseItemSchema = z.object({
	id: z.string(),
	severity: pulseSeveritySchema,
	category: pulseCategorySchema,
	title: z.string(),
	detail: z.string(),
	actionUrl: z.string().optional(),
	actionLabel: z.string().optional(),
	source: z.string(),
	timestamp: z.string(),
});
export type PulseItem = z.infer<typeof pulseItemSchema>;

// ---------------------------------------------------------------------------
// Pulse Response — the full payload returned by GET /api/pulse
// ---------------------------------------------------------------------------

export const pulseSummarySchema = z.object({
	critical: z.number(),
	warning: z.number(),
	info: z.number(),
});
export type PulseSummary = z.infer<typeof pulseSummarySchema>;

export const pulseResponseSchema = z.object({
	items: z.array(pulseItemSchema),
	summary: pulseSummarySchema,
	generatedAt: z.string(),
});
export type PulseResponse = z.infer<typeof pulseResponseSchema>;
