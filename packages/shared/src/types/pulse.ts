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

// ---------------------------------------------------------------------------
// Pulse Action — optional side-effect the operator can invoke on a signal
// ---------------------------------------------------------------------------
//
// The union is closed to known kinds so the frontend can exhaustively switch
// on `kind` and so the backend dispatcher rejects unknown variants at the
// boundary. New kinds land by extending this union — schema drift between
// client and server surfaces as a Zod parse failure, not a silent no-op.

export const pulseActionKindSchema = z.enum(["scheduler.enable", "cache.refresh"]);
export type PulseActionKind = z.infer<typeof pulseActionKindSchema>;

// Canonical scheduler job ids — match `JOB_ID` in
// apps/api/src/lib/scheduler-registry/job-definitions.ts so collector
// emission and dispatcher lookup share one string, no translation layer.
export const schedulerJobIdSchema = z.enum(["hunting", "queue-cleaner"]);
export type SchedulerJobId = z.infer<typeof schedulerJobIdSchema>;

export const pulseCacheTypeSchema = z.enum(["plex", "tautulli"]);
export type PulseCacheType = z.infer<typeof pulseCacheTypeSchema>;

export const pulseActionSchema = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("scheduler.enable"),
		target: z.object({ jobId: schedulerJobIdSchema }),
		label: z.string().min(1),
		confirmLabel: z.string().min(1),
		destructive: z.boolean(),
	}),
	z.object({
		kind: z.literal("cache.refresh"),
		target: z.object({
			instanceId: z.string().min(1),
			cacheType: pulseCacheTypeSchema,
		}),
		label: z.string().min(1),
		confirmLabel: z.string().min(1),
		destructive: z.boolean(),
	}),
]);
export type PulseAction = z.infer<typeof pulseActionSchema>;

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
	// Optional. Present only when a collector has proved it can produce a
	// precise, safe action for this signal. Collectors that cannot populate
	// the union's `target` fields at the type level simply omit the field.
	action: pulseActionSchema.optional(),
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
