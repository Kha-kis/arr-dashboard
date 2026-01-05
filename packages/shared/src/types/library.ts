import { z } from "zod";

export const libraryServiceSchema = z.enum(["sonarr", "radarr"]);
export type LibraryService = z.infer<typeof libraryServiceSchema>;

export const libraryItemTypeSchema = z.enum(["movie", "series"]);
export type LibraryItemType = z.infer<typeof libraryItemTypeSchema>;

export const libraryItemStatisticsSchema = z.object({
  seasonCount: z.number().optional(),
  episodeCount: z.number().optional(),
  episodeFileCount: z.number().optional(),
  totalEpisodeCount: z.number().optional(),
  monitoredSeasons: z.number().optional(),
  movieFileQuality: z.string().optional(),
  runtime: z.number().optional(),
});

export type LibraryItemStatistics = z.infer<typeof libraryItemStatisticsSchema>;

export const libraryMovieFileSchema = z.object({
  id: z.number().optional(),
  relativePath: z.string().optional(),
  quality: z.string().optional(),
  size: z.number().optional(),
  resolution: z.string().optional(),
});

export type LibraryMovieFile = z.infer<typeof libraryMovieFileSchema>;

export const librarySeasonSchema = z.object({
  seasonNumber: z.number(),
  title: z.string().optional(),
  monitored: z.boolean().optional(),
  episodeCount: z.number().optional(),
  episodeFileCount: z.number().optional(),
  missingEpisodeCount: z.number().optional(),
});

export type LibrarySeason = z.infer<typeof librarySeasonSchema>;

export const libraryItemSchema = z.object({
  id: z.union([z.number(), z.string()]),
  instanceId: z.string(),
  instanceName: z.string(),
  service: libraryServiceSchema,
  type: libraryItemTypeSchema,
  title: z.string(),
  titleSlug: z.string().optional(),
  sortTitle: z.string().optional(),
  year: z.number().optional(),
  monitored: z.boolean().optional(),
  hasFile: z.boolean().optional(),
  status: z.string().optional(),
  qualityProfileId: z.number().optional(),
  qualityProfileName: z.string().optional(),
  languageProfileId: z.number().optional(),
  languageProfileName: z.string().optional(),
  rootFolderPath: z.string().optional(),
  sizeOnDisk: z.number().optional(),
  path: z.string().optional(),
  overview: z.string().optional(),
  runtime: z.number().optional(),
  added: z.string().optional(),
  updated: z.string().optional(),
  genres: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  poster: z.string().optional(),
  fanart: z.string().optional(),
  movieFile: libraryMovieFileSchema.optional(),
  seasons: z.array(librarySeasonSchema).optional(),
  remoteIds: z
    .object({
      tmdbId: z.number().optional(),
      imdbId: z.string().optional(),
      tvdbId: z.number().optional(),
    })
    .optional(),
  statistics: libraryItemStatisticsSchema.optional(),
});

export type LibraryItem = z.infer<typeof libraryItemSchema>;

export const multiInstanceLibraryResponseSchema = z.object({
  instances: z.array(
    z.object({
      instanceId: z.string(),
      instanceName: z.string(),
      service: libraryServiceSchema,
      data: z.array(libraryItemSchema),
    }),
  ),
  aggregated: z.array(libraryItemSchema),
  totalCount: z.number().nonnegative(),
});

export type MultiInstanceLibraryResponse = z.infer<
  typeof multiInstanceLibraryResponseSchema
>;

// ============================================================================
// Paginated Library Response (for cached library with server-side pagination)
// ============================================================================

export const paginationSchema = z.object({
  page: z.number().int().min(1),
  // Note: limit=0 means "fetch all" for internal filtering use cases
  // When fetching all, the response limit reflects the actual count returned
  limit: z.number().int().min(0).max(10000),
  totalItems: z.number().int().min(0),
  totalPages: z.number().int().min(0),
});

export type Pagination = z.infer<typeof paginationSchema>;

export const libraryFiltersSchema = z.object({
  search: z.string().optional(),
  service: libraryServiceSchema.optional(),
  instanceId: z.string().optional(),
  monitored: z.enum(["true", "false", "all"]).optional(),
  hasFile: z.enum(["true", "false", "all"]).optional(),
  status: z.string().optional(),
  qualityProfileId: z.number().optional(),
  yearMin: z.number().optional(),
  yearMax: z.number().optional(),
  sortBy: z.enum(["title", "sortTitle", "year", "sizeOnDisk", "added"]).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional(),
}).refine(
  (data) => {
    if (data.yearMin !== undefined && data.yearMax !== undefined) {
      return data.yearMin <= data.yearMax;
    }
    return true;
  },
  { message: "yearMin must be less than or equal to yearMax", path: ["yearMax"] }
);

export type LibraryFilters = z.infer<typeof libraryFiltersSchema>;

export const paginatedLibraryResponseSchema = z.object({
  items: z.array(libraryItemSchema),
  pagination: paginationSchema,
  appliedFilters: libraryFiltersSchema,
  syncStatus: z.object({
    isCached: z.boolean(),
    lastSync: z.string().nullable(),
    syncInProgress: z.boolean(),
    totalCachedItems: z.number(),
  }).optional(),
});

export type PaginatedLibraryResponse = z.infer<
  typeof paginatedLibraryResponseSchema
>;

export const libraryToggleMonitorRequestSchema = z.object({
  instanceId: z.string(),
  service: libraryServiceSchema,
  itemId: z.union([z.number(), z.string()]),
  monitored: z.boolean(),
  seasonNumbers: z.array(z.number()).optional(),
});

export type LibraryToggleMonitorRequest = z.infer<
  typeof libraryToggleMonitorRequestSchema
>;

export const librarySeasonSearchRequestSchema = z.object({
  instanceId: z.string(),
  service: libraryServiceSchema,
  seriesId: z.union([z.number(), z.string()]),
  seasonNumber: z.number().int().nonnegative(),
});

export type LibrarySeasonSearchRequest = z.infer<
  typeof librarySeasonSearchRequestSchema
>;

export const libraryMovieSearchRequestSchema = z.object({
  instanceId: z.string(),
  service: z.literal("radarr"),
  movieId: z.union([z.number(), z.string()]),
});

export type LibraryMovieSearchRequest = z.infer<
  typeof libraryMovieSearchRequestSchema
>;

export const librarySeriesSearchRequestSchema = z.object({
  instanceId: z.string(),
  service: z.literal("sonarr"),
  seriesId: z.union([z.number(), z.string()]),
});

export type LibrarySeriesSearchRequest = z.infer<
  typeof librarySeriesSearchRequestSchema
>;

export const libraryEpisodeSchema = z.object({
  id: z.number(),
  seriesId: z.number(),
  episodeNumber: z.number(),
  seasonNumber: z.number(),
  title: z.string().optional(),
  airDate: z.string().optional(),
  hasFile: z.boolean().optional(),
  monitored: z.boolean().optional(),
  overview: z.string().optional(),
  episodeFileId: z.number().optional(),
});

export type LibraryEpisode = z.infer<typeof libraryEpisodeSchema>;

export const libraryEpisodesRequestSchema = z.object({
  instanceId: z.string(),
  seriesId: z.union([z.number(), z.string()]),
  seasonNumber: z
    .union([z.number(), z.string()])
    .transform((val) => {
      const num = typeof val === "string" ? Number(val) : val;
      return Number.isFinite(num) ? num : undefined;
    })
    .optional(),
});

export type LibraryEpisodesRequest = z.infer<
  typeof libraryEpisodesRequestSchema
>;

export const libraryEpisodesResponseSchema = z.object({
  episodes: z.array(libraryEpisodeSchema),
});

export type LibraryEpisodesResponse = z.infer<
  typeof libraryEpisodesResponseSchema
>;

export const libraryEpisodeSearchRequestSchema = z.object({
  instanceId: z.string(),
  episodeIds: z.array(z.number()),
});

export type LibraryEpisodeSearchRequest = z.infer<
  typeof libraryEpisodeSearchRequestSchema
>;

export const libraryEpisodeMonitorRequestSchema = z.object({
  instanceId: z.string(),
  seriesId: z.union([z.number(), z.string()]),
  episodeIds: z.array(z.number()),
  monitored: z.boolean(),
});

export type LibraryEpisodeMonitorRequest = z.infer<
  typeof libraryEpisodeMonitorRequestSchema
>;
