/**
 * Jellyfin API Response Schemas
 *
 * Zod schemas for validating Jellyfin API responses.
 * Uses the same parseUpstreamOrThrow pattern as plex-schemas.ts.
 */

import { z } from "zod";

// ============================================================================
// Server Info
// ============================================================================

export const jellyfinPublicInfoSchema = z.object({
	ServerName: z.string(),
	Version: z.string(),
	Id: z.string(),
	OperatingSystem: z.string().optional(),
	StartupWizardCompleted: z.boolean().optional(),
	LocalAddress: z.string().optional(),
});

export const jellyfinServerInfoSchema = jellyfinPublicInfoSchema.extend({
	OperatingSystemDisplayName: z.string().optional(),
	HasPendingRestart: z.boolean().optional(),
	CanSelfRestart: z.boolean().optional(),
});

// ============================================================================
// Users
// ============================================================================

export const jellyfinUserSchema = z.object({
	Id: z.string(),
	Name: z.string(),
	HasPassword: z.boolean().optional(),
	LastLoginDate: z.string().nullable().optional(),
	LastActivityDate: z.string().nullable().optional(),
});

export const jellyfinUsersResponseSchema = z.array(jellyfinUserSchema);

// ============================================================================
// Libraries (Views)
// ============================================================================

export const jellyfinLibrarySchema = z.object({
	Id: z.string(),
	Name: z.string(),
	CollectionType: z.string().optional(), // "movies" | "tvshows" | "music" | "books"
	Type: z.string(), // "CollectionFolder" | "UserView"
});

export const jellyfinLibrariesResponseSchema = z.object({
	Items: z.array(jellyfinLibrarySchema),
	TotalRecordCount: z.number(),
});

// ============================================================================
// Items (BaseItemDto)
// ============================================================================

const jellyfinUserDataSchema = z.object({
	PlayedPercentage: z.number().optional(),
	PlayCount: z.number().optional(),
	IsFavorite: z.boolean().optional(),
	Played: z.boolean().optional(),
	LastPlayedDate: z.string().nullable().optional(),
	PlaybackPositionTicks: z.number().optional(),
});

export const jellyfinItemSchema = z.object({
	Id: z.string(),
	Name: z.string(),
	Type: z.string(), // "Movie" | "Series" | "Episode" | "Season" | "BoxSet" | ...
	SeriesName: z.string().optional(),
	SeriesId: z.string().optional(),
	IndexNumber: z.number().optional(), // Episode number
	ParentIndexNumber: z.number().optional(), // Season number
	ProductionYear: z.number().optional(),
	DateCreated: z.string().optional(),
	PremiereDate: z.string().optional(),
	RunTimeTicks: z.number().optional(),
	ProviderIds: z.record(z.string(), z.string()).optional(), // { Tmdb: "680", Imdb: "tt0137523" }
	UserData: jellyfinUserDataSchema.optional(),
	ImageTags: z.record(z.string(), z.string()).optional(), // { Primary: "tag123" }
	CollectionType: z.string().optional(),
});

export const jellyfinItemsResponseSchema = z.object({
	Items: z.array(jellyfinItemSchema),
	TotalRecordCount: z.number(),
});

// ============================================================================
// Sessions
// ============================================================================

const jellyfinPlayStateSchema = z.object({
	PositionTicks: z.number().optional(),
	CanSeek: z.boolean().optional(),
	IsPaused: z.boolean().optional(),
	PlayMethod: z.string().optional(), // "DirectPlay" | "DirectStream" | "Transcode"
});

const jellyfinTranscodingInfoSchema = z.object({
	IsVideoDirect: z.boolean().optional(),
	IsAudioDirect: z.boolean().optional(),
	Bitrate: z.number().optional(),
	Width: z.number().optional(),
	Height: z.number().optional(),
	AudioCodec: z.string().optional(),
	VideoCodec: z.string().optional(),
	Container: z.string().optional(),
	CompletionPercentage: z.number().optional(),
});

export const jellyfinSessionSchema = z.object({
	Id: z.string(),
	UserId: z.string().optional(),
	UserName: z.string().optional(),
	Client: z.string().optional(),
	DeviceName: z.string().optional(),
	DeviceId: z.string().optional(),
	RemoteEndPoint: z.string().optional(),
	IsActive: z.boolean().optional(),
	LastActivityDate: z.string().optional(),
	PlayState: jellyfinPlayStateSchema.optional(),
	NowPlayingItem: jellyfinItemSchema.optional(),
	TranscodingInfo: jellyfinTranscodingInfoSchema.optional(),
});

export const jellyfinSessionsResponseSchema = z.array(jellyfinSessionSchema);

// ============================================================================
// Episodes (for a series)
// ============================================================================

export const jellyfinEpisodesResponseSchema = z.object({
	Items: z.array(jellyfinItemSchema),
	TotalRecordCount: z.number(),
});

/**
 * Evidence-only BaseItemDto projection for the durable episode collector.
 *
 * Jellyfin legitimately serializes many unrelated BaseItemDto properties as
 * null. Those display fields must not reject watch evidence that does not use
 * them, so this schema validates only the fields consumed by publication.
 * Nullable authority fields remain nullable here and are rejected explicitly
 * by the client when they cannot prove an episode coordinate or Played state.
 */
const jellyfinEpisodePageItemSchema = z.looseObject({
	Id: z.string(),
	Name: z
		.string()
		.nullable()
		.optional()
		.transform((value) => value ?? ""),
	Type: z.string(),
	SeriesId: z.string().nullable().optional(),
	IndexNumber: z.number().nullable().optional(),
	ParentIndexNumber: z.number().nullable().optional(),
	UserData: z
		.looseObject({
			Played: z.boolean().nullable().optional(),
			PlayCount: z.number().nullable().optional(),
			LastPlayedDate: z.string().nullable().optional(),
		})
		.nullable()
		.optional(),
});

/** Strict single-page envelope used only by the durable episode collector. */
export const jellyfinEpisodeItemsPageSchema = z.object({
	Items: z.array(jellyfinEpisodePageItemSchema),
	StartIndex: z.number(),
	TotalRecordCount: z.number(),
});

// ============================================================================
// Item detail (for label-sync read-modify-write tag updates)
//
// Passthrough schema — we round-trip the entire item back to POST /Items/{id},
// so we only validate the fields we read or merge (Tags) and let Jellyfin
// preserve everything else verbatim.
// ============================================================================

export const jellyfinItemDetailSchema = z
	.object({
		Id: z.string(),
		Name: z.string().optional(),
		Tags: z.array(z.string()).optional(),
	})
	.passthrough();

// ============================================================================
// Mutation adapter responses
// ============================================================================

/**
 * These schemas are intentionally separate from the display/source schemas.
 * The mutation adapter must retain a complete replacement DTO, while only
 * exposing a small, immutable identity snapshot to its caller.
 */
const MUTATION_STRING_MAX = 256;
const mutationBoundedStringSchema = z
	.string()
	.min(1)
	.max(MUTATION_STRING_MAX)
	.refine((value) => value.trim().length > 0);

const mutationProviderIdsSchema = z.record(
	z.string().max(MUTATION_STRING_MAX),
	mutationBoundedStringSchema,
);
const mutationTagsSchema = z
	.array(mutationBoundedStringSchema)
	.max(10_000)
	.refine((tags) => new Set(tags).size === tags.length);

export const jellyfinMutationServerInfoSchema = z.object({
	Id: mutationBoundedStringSchema,
});

export const jellyfinMutationItemSchema = z
	.object({
		Id: mutationBoundedStringSchema,
		Type: z.enum(["Movie", "Series"]),
		ProviderIds: mutationProviderIdsSchema,
		Tags: mutationTagsSchema,
	})
	.passthrough();

export const jellyfinMutationAncestorsSchema = z
	.array(
		z
			.object({
				Id: mutationBoundedStringSchema,
			})
			.passthrough(),
	)
	.max(10_000);
