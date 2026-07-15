import { z } from "zod";

export const setupStarterIdSchema = z.enum([
	"notification-throttle",
	"auto-tag-recent",
	"label-sync-recent",
]);
export type SetupStarterId = z.infer<typeof setupStarterIdSchema>;

export const setupStarterKindSchema = z.enum(["notifications", "auto-tag", "label-sync"]);
export type SetupStarterKind = z.infer<typeof setupStarterKindSchema>;

export const setupStarterServiceSchema = z.object({
	id: z.string(),
	service: z.enum(["sonarr", "radarr", "plex", "jellyfin", "emby"]),
	label: z.string(),
});
export type SetupStarterService = z.infer<typeof setupStarterServiceSchema>;

export const setupStarterDefinitionSchema = z.object({
	id: setupStarterIdSchema,
	kind: setupStarterKindSchema,
	title: z.string(),
	description: z.string(),
	effect: z.string(),
	available: z.boolean(),
	unavailableReason: z.string().nullable(),
	existing: z.boolean(),
	source: setupStarterServiceSchema.nullable(),
	destination: setupStarterServiceSchema.nullable(),
});
export type SetupStarterDefinition = z.infer<typeof setupStarterDefinitionSchema>;

export const setupStarterPreviewResponseSchema = z.object({
	starters: z.array(setupStarterDefinitionSchema),
});
export type SetupStarterPreviewResponse = z.infer<typeof setupStarterPreviewResponseSchema>;

export const applySetupStartersRequestSchema = z.object({
	starterIds: z
		.array(setupStarterIdSchema)
		.min(1)
		.max(3)
		.refine((ids) => new Set(ids).size === ids.length, "Starter IDs must be unique"),
});
export type ApplySetupStartersRequest = z.infer<typeof applySetupStartersRequestSchema>;

export const applySetupStartersResponseSchema = z.object({
	created: z.array(setupStarterIdSchema),
	existing: z.array(setupStarterIdSchema),
});
export type ApplySetupStartersResponse = z.infer<typeof applySetupStartersResponseSchema>;
