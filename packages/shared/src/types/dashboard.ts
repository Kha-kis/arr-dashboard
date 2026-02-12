import { z } from "zod";

const queueStatusMessageSchema = z.object({
  title: z.string().optional(),
  messages: z.array(z.string()).optional(),
});

const queueActionCapabilitiesSchema = z.object({
  canRetry: z.boolean().optional(),
  canManualImport: z.boolean().optional(),
  canRemove: z.boolean().optional(),
  canChangeCategory: z.boolean().optional(),
  recommendedAction: z.enum(["retry", "manualImport", "delete"]).optional(),
  manualImportReason: z.string().optional(),
  retryReason: z.string().optional(),
});

const queueSeriesSummarySchema = z.object({
  id: z.number().optional(),
  title: z.string().optional(),
});

const queueMovieSummarySchema = z.object({
  id: z.number().optional(),
  title: z.string().optional(),
});

const queueArtistSummarySchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
});

const queueAlbumSummarySchema = z.object({
  id: z.number().optional(),
  title: z.string().optional(),
});

const queueAuthorSummarySchema = z.object({
  id: z.number().optional(),
  name: z.string().optional(),
});

const queueBookSummarySchema = z.object({
  id: z.number().optional(),
  title: z.string().optional(),
});

export type QueueStatusMessage = z.infer<typeof queueStatusMessageSchema>;
export type QueueSeriesSummary = z.infer<typeof queueSeriesSummarySchema>;
export type QueueMovieSummary = z.infer<typeof queueMovieSummarySchema>;
export type QueueArtistSummary = z.infer<typeof queueArtistSummarySchema>;
export type QueueAlbumSummary = z.infer<typeof queueAlbumSummarySchema>;
export type QueueAuthorSummary = z.infer<typeof queueAuthorSummarySchema>;
export type QueueBookSummary = z.infer<typeof queueBookSummarySchema>;
export type QueueActionCapabilities = z.infer<
  typeof queueActionCapabilitiesSchema
>;

export const queueItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  queueItemId: z.union([z.string(), z.number()]).optional(),
  downloadId: z.string().optional(),
  title: z.string().optional(),
  // Sonarr fields
  seriesId: z.number().optional(),
  seriesSlug: z.string().optional(),
  episodeId: z.number().optional(),
  series: queueSeriesSummarySchema.optional(),
  // Radarr fields
  movieId: z.number().optional(),
  movieSlug: z.string().optional(),
  movie: queueMovieSummarySchema.optional(),
  // Lidarr fields
  artistId: z.number().optional(),
  albumId: z.number().optional(),
  artist: queueArtistSummarySchema.optional(),
  album: queueAlbumSummarySchema.optional(),
  // Readarr fields
  authorId: z.number().optional(),
  bookId: z.number().optional(),
  author: queueAuthorSummarySchema.optional(),
  book: queueBookSummarySchema.optional(),
  // Common fields
  size: z.number().optional(),
  sizeleft: z.number().optional(),
  status: z.string().optional(),
  protocol: z.string().optional(),
  downloadProtocol: z.string().optional(),
  indexer: z.string().optional(),
  downloadClient: z.string().optional(),
  trackedDownloadState: z.string().optional(),
  trackedDownloadStatus: z.string().optional(),
  statusMessages: z.array(queueStatusMessageSchema).optional(),
  errorMessage: z.string().optional(),
  instanceId: z.string(),
  instanceName: z.string(),
  service: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
  actions: queueActionCapabilitiesSchema.optional(),
});

export type QueueItem = z.infer<typeof queueItemSchema>;

export const multiInstanceQueueResponseSchema = z.object({
  instances: z.array(
    z.object({
      instanceId: z.string(),
      instanceName: z.string(),
      service: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
      data: z.array(queueItemSchema),
    }),
  ),
  aggregated: z.array(queueItemSchema),
  totalCount: z.number(),
});

export type MultiInstanceQueueResponse = z.infer<
  typeof multiInstanceQueueResponseSchema
>;

export const queueActionRequestSchema = z.object({
  instanceId: z.string(),
  service: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
  itemId: z.union([z.string(), z.number()]),
  action: z.enum(["retry", "delete", "manualImport"]),
  removeFromClient: z.boolean().default(true),
  blocklist: z.boolean().default(false),
  changeCategory: z.boolean().default(false),
  downloadId: z.string().optional(),
  search: z.boolean().default(false),
  searchPayload: z
    .object({
      seriesId: z.number().optional(),
      episodeIds: z.array(z.number()).optional(),
      movieId: z.number().optional(),
      artistId: z.number().optional(),
      albumId: z.number().optional(),
      authorId: z.number().optional(),
      bookId: z.number().optional(),
    })
    .optional(),
});

export type QueueActionRequest = z.infer<typeof queueActionRequestSchema>;

export const queueBulkActionRequestSchema = z.object({
  instanceId: z.string(),
  service: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
  ids: z.array(z.union([z.string(), z.number()])).min(1),
  action: z.enum(["retry", "delete", "manualImport"]),
  removeFromClient: z.boolean().default(true),
  blocklist: z.boolean().default(false),
  changeCategory: z.boolean().default(false),
  search: z.boolean().default(false),
});

export type QueueBulkActionRequest = z.infer<
  typeof queueBulkActionRequestSchema
>;

export const historyItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  downloadId: z.string().optional(),
  title: z.string().optional(),
  size: z.number().optional(),
  quality: z.unknown().optional(),
  status: z.string().optional(),
  downloadClient: z.string().optional(),
  indexer: z.string().optional(),
  protocol: z.string().optional(),
  date: z.string().optional(),
  reason: z.string().optional(),
  eventType: z.string().optional(),
  sourceTitle: z.string().optional(),
  // Sonarr fields
  seriesId: z.number().optional(),
  seriesSlug: z.string().optional(),
  episodeId: z.number().optional(),
  // Radarr fields
  movieId: z.number().optional(),
  movieSlug: z.string().optional(),
  // Lidarr fields
  artistId: z.number().optional(),
  albumId: z.number().optional(),
  trackId: z.number().optional(),
  // Readarr fields
  authorId: z.number().optional(),
  bookId: z.number().optional(),
  data: z.unknown().optional(),
  customFormats: z.array(z.object({ id: z.number(), name: z.string() })).optional(),
  customFormatScore: z.number().optional(),
  instanceId: z.string(),
  instanceName: z.string(),
  service: z.enum(["sonarr", "radarr", "prowlarr", "lidarr", "readarr"]),
});

export type HistoryItem = z.infer<typeof historyItemSchema>;

export const multiInstanceHistoryResponseSchema = z.object({
  instances: z.array(
    z.object({
      instanceId: z.string(),
      instanceName: z.string(),
      service: z.enum(["sonarr", "radarr", "prowlarr", "lidarr", "readarr"]),
      data: z.array(historyItemSchema),
      totalRecords: z.number().optional(),
    }),
  ),
  aggregated: z.array(historyItemSchema),
  totalCount: z.number(),
});

export type MultiInstanceHistoryResponse = z.infer<
  typeof multiInstanceHistoryResponseSchema
>;

export const calendarItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  title: z.string().optional(),
  service: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
  type: z.enum(["episode", "movie", "album", "book"]),
  // Sonarr fields
  seriesTitle: z.string().optional(),
  episodeTitle: z.string().optional(),
  seriesId: z.number().optional(),
  seriesSlug: z.string().optional(),
  episodeId: z.number().optional(),
  seasonNumber: z.number().optional(),
  episodeNumber: z.number().optional(),
  seriesStatus: z.string().optional(),
  // Radarr fields
  movieTitle: z.string().optional(),
  movieId: z.number().optional(),
  movieSlug: z.string().optional(),
  // Lidarr fields
  artistName: z.string().optional(),
  albumTitle: z.string().optional(),
  artistId: z.number().optional(),
  albumId: z.number().optional(),
  releaseDate: z.string().optional(),
  albumType: z.string().optional(),
  // Readarr fields
  authorName: z.string().optional(),
  bookTitle: z.string().optional(),
  authorId: z.number().optional(),
  bookId: z.number().optional(),
  // Common external IDs
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
  musicBrainzId: z.string().optional(),
  goodreadsId: z.string().optional(),
  // Common fields
  status: z.string().optional(),
  airDate: z.string().optional(),
  airDateUtc: z.string().optional(),
  runtime: z.number().optional(),
  network: z.string().optional(),
  studio: z.string().optional(),
  label: z.string().optional(), // Record label for Lidarr
  publisher: z.string().optional(), // Publisher for Readarr
  overview: z.string().optional(),
  genres: z.array(z.string()).optional(),
  monitored: z.boolean().optional(),
  hasFile: z.boolean().optional(),
  instanceId: z.string(),
  instanceName: z.string(),
});

export type CalendarItem = z.infer<typeof calendarItemSchema>;

export const multiInstanceCalendarResponseSchema = z.object({
  instances: z.array(
    z.object({
      instanceId: z.string(),
      instanceName: z.string(),
      service: z.enum(["sonarr", "radarr", "lidarr", "readarr"]),
      data: z.array(calendarItemSchema),
    }),
  ),
  aggregated: z.array(calendarItemSchema),
  totalCount: z.number(),
});

export type MultiInstanceCalendarResponse = z.infer<
  typeof multiInstanceCalendarResponseSchema
>;

export const qualityBreakdownSchema = z.record(z.string(), z.number());

export type QualityBreakdown = z.infer<typeof qualityBreakdownSchema>;

export const healthIssueSchema = z.object({
  type: z.enum(["error", "warning"]),
  message: z.string(),
  source: z.string().optional(),
  wikiUrl: z.string().optional(),
  instanceId: z.string(),
  instanceName: z.string(),
  instanceBaseUrl: z.string(),
  service: z.enum(["sonarr", "radarr", "prowlarr", "lidarr", "readarr"]),
});

export type HealthIssue = z.infer<typeof healthIssueSchema>;

export const tagBreakdownSchema = z.record(z.string(), z.number());

export type TagBreakdown = z.infer<typeof tagBreakdownSchema>;

export const sonarrStatisticsSchema = z.object({
  totalSeries: z.number(),
  monitoredSeries: z.number(),
  continuingSeries: z.number().optional(),
  endedSeries: z.number().optional(),
  totalEpisodes: z.number(),
  episodeFileCount: z.number(),
  downloadedEpisodes: z.number(),
  missingEpisodes: z.number(),
  downloadedPercentage: z.number(),
  cutoffUnmetCount: z.number().optional(),
  qualityBreakdown: qualityBreakdownSchema.optional(),
  tagBreakdown: tagBreakdownSchema.optional(),
  recentlyAdded7Days: z.number().optional(),
  recentlyAdded30Days: z.number().optional(),
  averageEpisodeSize: z.number().optional(),
  diskTotal: z.number().optional(),
  diskFree: z.number().optional(),
  diskUsed: z.number().optional(),
  diskUsagePercent: z.number().optional(),
  healthIssues: z.number().optional(),
  healthIssuesList: z.array(healthIssueSchema).optional(),
});

export type SonarrStatistics = z.infer<typeof sonarrStatisticsSchema>;

export const radarrStatisticsSchema = z.object({
  totalMovies: z.number(),
  monitoredMovies: z.number(),
  downloadedMovies: z.number(),
  missingMovies: z.number(),
  downloadedPercentage: z.number(),
  cutoffUnmetCount: z.number().optional(),
  qualityBreakdown: qualityBreakdownSchema.optional(),
  tagBreakdown: tagBreakdownSchema.optional(),
  recentlyAdded7Days: z.number().optional(),
  recentlyAdded30Days: z.number().optional(),
  totalRuntime: z.number().optional(),
  averageMovieSize: z.number().optional(),
  diskTotal: z.number().optional(),
  diskFree: z.number().optional(),
  diskUsed: z.number().optional(),
  diskUsagePercent: z.number().optional(),
  healthIssues: z.number().optional(),
  healthIssuesList: z.array(healthIssueSchema).optional(),
});

export type RadarrStatistics = z.infer<typeof radarrStatisticsSchema>;

export const prowlarrIndexerStatSchema = z.object({
  name: z.string(),
  queries: z.number(),
  grabs: z.number(),
  successRate: z.number(),
});

export type ProwlarrIndexerStat = z.infer<typeof prowlarrIndexerStatSchema>;

export const prowlarrStatisticsSchema = z.object({
  totalIndexers: z.number(),
  activeIndexers: z.number(),
  pausedIndexers: z.number(),
  totalQueries: z.number(),
  totalGrabs: z.number(),
  successfulQueries: z.number().optional(),
  failedQueries: z.number().optional(),
  successfulGrabs: z.number().optional(),
  failedGrabs: z.number().optional(),
  grabRate: z.number().optional(),
  averageResponseTime: z.number().optional(),
  healthIssues: z.number().optional(),
  healthIssuesList: z.array(healthIssueSchema).optional(),
  indexers: z.array(prowlarrIndexerStatSchema),
});

export type ProwlarrStatistics = z.infer<typeof prowlarrStatisticsSchema>;

// Lidarr Statistics (Music)
export const lidarrStatisticsSchema = z.object({
  totalArtists: z.number(),
  monitoredArtists: z.number(),
  totalAlbums: z.number(),
  monitoredAlbums: z.number(),
  totalTracks: z.number(),
  downloadedTracks: z.number(),
  missingTracks: z.number(),
  downloadedPercentage: z.number(),
  cutoffUnmetCount: z.number().optional(),
  qualityBreakdown: qualityBreakdownSchema.optional(),
  tagBreakdown: tagBreakdownSchema.optional(),
  recentlyAdded7Days: z.number().optional(),
  recentlyAdded30Days: z.number().optional(),
  averageTrackSize: z.number().optional(),
  diskTotal: z.number().optional(),
  diskFree: z.number().optional(),
  diskUsed: z.number().optional(),
  diskUsagePercent: z.number().optional(),
  healthIssues: z.number().optional(),
  healthIssuesList: z.array(healthIssueSchema).optional(),
});

export type LidarrStatistics = z.infer<typeof lidarrStatisticsSchema>;

// Readarr Statistics (Books/Audiobooks)
export const readarrStatisticsSchema = z.object({
  totalAuthors: z.number(),
  monitoredAuthors: z.number(),
  totalBooks: z.number(),
  monitoredBooks: z.number(),
  downloadedBooks: z.number(),
  missingBooks: z.number(),
  downloadedPercentage: z.number(),
  cutoffUnmetCount: z.number().optional(),
  qualityBreakdown: qualityBreakdownSchema.optional(),
  tagBreakdown: tagBreakdownSchema.optional(),
  recentlyAdded7Days: z.number().optional(),
  recentlyAdded30Days: z.number().optional(),
  averageBookSize: z.number().optional(),
  diskTotal: z.number().optional(),
  diskFree: z.number().optional(),
  diskUsed: z.number().optional(),
  diskUsagePercent: z.number().optional(),
  healthIssues: z.number().optional(),
  healthIssuesList: z.array(healthIssueSchema).optional(),
});

export type ReadarrStatistics = z.infer<typeof readarrStatisticsSchema>;

/**
 * Combined disk statistics with proper cross-service deduplication.
 * When multiple services (Sonarr + Radarr) share the same storage group,
 * this field contains the correctly deduplicated totals.
 */
export const combinedDiskStatsSchema = z.object({
  diskTotal: z.number(),
  diskFree: z.number(),
  diskUsed: z.number(),
  diskUsagePercent: z.number(),
});

export type CombinedDiskStats = z.infer<typeof combinedDiskStatsSchema>;

export const dashboardStatisticsResponseSchema = z.object({
  sonarr: z.object({
    instances: z.array(
      z.object({
        instanceId: z.string(),
        instanceName: z.string(),
        data: sonarrStatisticsSchema,
        /** When true, the fetch failed and data contains empty/fallback values */
        error: z.boolean().optional(),
      }),
    ),
    aggregate: sonarrStatisticsSchema.optional(),
  }),
  radarr: z.object({
    instances: z.array(
      z.object({
        instanceId: z.string(),
        instanceName: z.string(),
        data: radarrStatisticsSchema,
        /** When true, the fetch failed and data contains empty/fallback values */
        error: z.boolean().optional(),
      }),
    ),
    aggregate: radarrStatisticsSchema.optional(),
  }),
  prowlarr: z.object({
    instances: z.array(
      z.object({
        instanceId: z.string(),
        instanceName: z.string(),
        data: prowlarrStatisticsSchema,
        /** When true, the fetch failed and data contains empty/fallback values */
        error: z.boolean().optional(),
      }),
    ),
    aggregate: prowlarrStatisticsSchema.optional(),
  }),
  lidarr: z.object({
    instances: z.array(
      z.object({
        instanceId: z.string(),
        instanceName: z.string(),
        data: lidarrStatisticsSchema,
        /** When true, the fetch failed and data contains empty/fallback values */
        error: z.boolean().optional(),
      }),
    ),
    aggregate: lidarrStatisticsSchema.optional(),
  }),
  readarr: z.object({
    instances: z.array(
      z.object({
        instanceId: z.string(),
        instanceName: z.string(),
        data: readarrStatisticsSchema,
        /** When true, the fetch failed and data contains empty/fallback values */
        error: z.boolean().optional(),
      }),
    ),
    aggregate: readarrStatisticsSchema.optional(),
  }),
  /**
   * Combined disk statistics with proper cross-service storage group deduplication.
   * Use this for displaying total disk usage across all services.
   */
  combinedDisk: combinedDiskStatsSchema.optional(),
});

export type DashboardStatisticsResponse = z.infer<
  typeof dashboardStatisticsResponseSchema
>;
