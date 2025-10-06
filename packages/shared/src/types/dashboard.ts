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

export type QueueStatusMessage = z.infer<typeof queueStatusMessageSchema>;
export type QueueSeriesSummary = z.infer<typeof queueSeriesSummarySchema>;
export type QueueMovieSummary = z.infer<typeof queueMovieSummarySchema>;
export type QueueActionCapabilities = z.infer<
  typeof queueActionCapabilitiesSchema
>;

export const queueItemSchema = z.object({
  id: z.union([z.string(), z.number()]),
  queueItemId: z.union([z.string(), z.number()]).optional(),
  downloadId: z.string().optional(),
  title: z.string().optional(),
  seriesId: z.number().optional(),
  seriesSlug: z.string().optional(),
  episodeId: z.number().optional(),
  movieId: z.number().optional(),
  movieSlug: z.string().optional(),
  series: queueSeriesSummarySchema.optional(),
  movie: queueMovieSummarySchema.optional(),
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
  service: z.enum(["sonarr", "radarr"]),
  actions: queueActionCapabilitiesSchema.optional(),
});

export type QueueItem = z.infer<typeof queueItemSchema>;

export const multiInstanceQueueResponseSchema = z.object({
  instances: z.array(
    z.object({
      instanceId: z.string(),
      instanceName: z.string(),
      service: z.enum(["sonarr", "radarr"]),
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
  service: z.enum(["sonarr", "radarr"]),
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
    })
    .optional(),
});

export type QueueActionRequest = z.infer<typeof queueActionRequestSchema>;

export const queueBulkActionRequestSchema = z.object({
  instanceId: z.string(),
  service: z.enum(["sonarr", "radarr"]),
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
  seriesId: z.number().optional(),
  seriesSlug: z.string().optional(),
  episodeId: z.number().optional(),
  movieId: z.number().optional(),
  movieSlug: z.string().optional(),
  data: z.unknown().optional(),
  instanceId: z.string(),
  instanceName: z.string(),
  service: z.enum(["sonarr", "radarr", "prowlarr"]),
});

export type HistoryItem = z.infer<typeof historyItemSchema>;

export const multiInstanceHistoryResponseSchema = z.object({
  instances: z.array(
    z.object({
      instanceId: z.string(),
      instanceName: z.string(),
      service: z.enum(["sonarr", "radarr", "prowlarr"]),
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
  service: z.enum(["sonarr", "radarr"]),
  type: z.enum(["episode", "movie"]),
  seriesTitle: z.string().optional(),
  episodeTitle: z.string().optional(),
  movieTitle: z.string().optional(),
  seriesId: z.number().optional(),
  seriesSlug: z.string().optional(),
  episodeId: z.number().optional(),
  movieId: z.number().optional(),
  movieSlug: z.string().optional(),
  tmdbId: z.number().optional(),
  imdbId: z.string().optional(),
  seriesStatus: z.string().optional(),
  status: z.string().optional(),
  seasonNumber: z.number().optional(),
  episodeNumber: z.number().optional(),
  airDate: z.string().optional(),
  airDateUtc: z.string().optional(),
  runtime: z.number().optional(),
  network: z.string().optional(),
  studio: z.string().optional(),
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
      service: z.enum(["sonarr", "radarr"]),
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
  averageEpisodeSize: z.number().optional(),
  diskTotal: z.number().optional(),
  diskFree: z.number().optional(),
  diskUsed: z.number().optional(),
  diskUsagePercent: z.number().optional(),
  healthIssues: z.number().optional(),
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
  averageMovieSize: z.number().optional(),
  diskTotal: z.number().optional(),
  diskFree: z.number().optional(),
  diskUsed: z.number().optional(),
  diskUsagePercent: z.number().optional(),
  healthIssues: z.number().optional(),
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
  indexers: z.array(prowlarrIndexerStatSchema),
});

export type ProwlarrStatistics = z.infer<typeof prowlarrStatisticsSchema>;

export const dashboardStatisticsResponseSchema = z.object({
  sonarr: z.object({
    instances: z.array(
      z.object({
        instanceId: z.string(),
        instanceName: z.string(),
        data: sonarrStatisticsSchema,
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
      }),
    ),
    aggregate: prowlarrStatisticsSchema.optional(),
  }),
});

export type DashboardStatisticsResponse = z.infer<
  typeof dashboardStatisticsResponseSchema
>;
